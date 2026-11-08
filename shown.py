"""Display-only protocol, transcript replay, image routes and the page's bridge proxies (no voice/model imports)."""

import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import logging
import ipaddress
import os
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

ROOT = Path(os.environ.get("VOICE_SHOWN_DIR") or Path(os.environ.get("VOICE_STATE", "~/.local/state/shepherd")) / "shown").expanduser()  # call-show's target
# Card kinds a shown file can be: the marker is [show]<kind>:<name>[/show]; the page renders each kind its own way
# (call.html CARDS). A new kind is one entry here, a sniff in file_type and a renderer there.
KINDS = {
    "image": {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"},
    "audio": {"mp3": "audio/mpeg", "ogg": "audio/ogg", "wav": "audio/wav"},
}
TYPES = {ext: mime for kinds in KINDS.values() for ext, mime in kinds.items()}
KIND_OF = {ext: kind for kind, kinds in KINDS.items() for ext in kinds}
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.(png|jpe?g|webp|mp3|ogg|wav)", re.I)
MAX_AGE = 24 * 60 * 60
PANE = re.compile(r"w[0-9A-Za-z]+:p[0-9A-Za-z]+")  # a Herdr pane id (fullmatch), the bridge's own pattern
MAX_BODY = 32 * 1024  # the bridge's POST limit, checked here from Content-Length before the body is read
MAX_TEXT = 4000  # characters in one typed turn, after strip (the bridge's cap)
# Per-route bridge timeouts (plan R9); a timed-out turn is not retried: the page says "not sent, try again".
SECONDS = {"herd": 10, "target": 15, "turn": 25, "recap": 75}
PAGE_EVENTS = ("ready", "busy", "herd", "speaker")  # passed through to an off-call page as they are
NO_STORE = {"Cache-Control": "no-store"}


class DisplayText:
    """Keep display-only text out of TTS, including tags split across stream chunks."""

    def __init__(self):
        self.pending = ""
        self.depth = 0
        self.card = ""

    def feed(self, text, *, final=False):
        self.pending += text
        spoken, cards = [], []
        tags = ("[show]", "[/show]")
        while self.pending:
            lower = self.pending.lower()
            tag = next((tag for tag in tags if lower.startswith(tag)), None)
            if tag:
                self.pending = self.pending[len(tag):]
                if tag == "[show]":
                    self.depth += 1
                    spoken.append(" ")
                elif self.depth:
                    self.depth -= 1
                    if not self.depth:
                        if self.card.strip():
                            cards.append(self.card.strip())
                        self.card = ""
                continue
            if any(tag.startswith(lower) for tag in tags):
                break  # an incomplete tag waits; final drops it rather than speaking it
            if self.depth:
                self.card += self.pending[0]
            else:
                spoken.append(self.pending[0])
            self.pending = self.pending[1:]
        if final:
            if self.depth and self.card.strip():
                cards.append(self.card.strip())
            self.pending, self.depth, self.card = "", 0, ""
        return "".join(spoken), cards


def speakable(text):
    """Desk text read aloud (the call) or shown as a talk bubble (off-call): markdown marks dropped, not spoken."""
    return re.sub(r"[*_#`>|]+", "", text).strip()


def card_id(source, index):
    return hashlib.sha256(f"{source}:{index}".encode()).hexdigest()[:24]


def text_events(line):
    """Stable block ids let polling and the call's data channel agree on dismissals."""
    try:
        event = json.loads(line)
    except ValueError:
        return []
    if event.get("type") != "assistant" or event.get("isSidechain"):
        return []
    source = hashlib.sha256(line.encode()).hexdigest()
    return [{"text": b["text"], "text_end": True, "show_id": card_id(source, i)}
            for i, b in enumerate(event.get("message", {}).get("content", []))
            if b.get("type") == "text" and b.get("text", "").strip()]


class TranscriptShows:
    """Read new complete lines only; never starts a desk or a call."""

    def __init__(self):
        self.path, self.offset, self.latest = None, 0, None

    def read(self, path):
        if path != self.path or (path.exists() and path.stat().st_size < self.offset):
            self.path, self.offset = path, 0
        if not path.exists():
            return self.latest
        with path.open("rb") as stream:
            stream.seek(self.offset)
            while line := stream.readline():
                if not line.endswith(b"\n"):
                    break
                self.offset = stream.tell()
                for event in text_events(line.decode("utf-8", "replace").rstrip("\n")):
                    _, cards = DisplayText().feed(event["text"], final=True)
                    for i, text in enumerate(cards):
                        self.latest = {"type": "show", "id": card_id(event["show_id"], i), "text": text}
        return self.latest


def file_type(header):
    """The extension a file's first 12 bytes say it is (png, jpg, webp, mp3, ogg, wav), else None."""
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if header.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "webp"
    if header.startswith(b"RIFF") and header[8:12] == b"WAVE":
        return "wav"
    if header.startswith(b"OggS"):
        return "ogg"
    if header.startswith(b"ID3") or (len(header) >= 2 and header[0] == 0xFF and header[1] & 0xE6 == 0xE2):  # an ID3 tag, or a frame sync
        return "mp3"
    return None



def cross_site(headers, scheme, need_origin):
    """True when a POST is not from this host's own page: an Origin header that is not the request's own
    scheme://Host, or (need_origin) none at all. A proxy in front (tailscale serve) keeps Host and names its scheme in
    X-Forwarded-Proto. X-Forwarded-Host is never trusted: a client can send its own (a stale CORS preflight grant once
    let a page do so), and Host is what the browser connected to."""
    origin = headers.get("origin")
    if origin is None:
        return need_origin
    scheme = (headers.get("x-forwarded-proto") or scheme).split(",")[0].strip().lower()
    host = headers.get("host", "").strip().lower()
    if not host or origin.lower() != f"{scheme}://{host}":
        return True
    return not page_host(host)


CLIENT = {"X-Sheprd": "1"}  # on every bridge call and every page request the voice host answers (Guard)
PAGE = re.compile(r"/call|/sheprd/(?:games/)?[^/]+|/api/shown/[^/]+")  # games/<id>.js load by <script>: no X-Sheprd  # what loads without it: the page, its assets, card images
CHECKED = ("host", "origin", "x-sheprd", "sec-fetch-site", "x-forwarded-host", "x-forwarded-proto")


def refuse(method, path, headers, scheme):
    """True unless this is the page loading (PAGE) or the page's own request: X-Sheprd: 1 (a page on another site cannot
    add a custom header without a CORS preflight, and the voice app answers none), a Host a DNS-rebinding page cannot
    own (page_host), not marked cross-site by the browser, and an Origin of this host (required unless GET or HEAD)."""
    if not page_host(headers.get("host", "")):  # before the exemptions: a rebound page can't read even a card image
        return True
    if method in ("GET", "HEAD") and PAGE.fullmatch(path):
        return False
    return (headers.get("x-sheprd") != "1" or headers.get("sec-fetch-site", "same-origin") != "same-origin"
            or cross_site(headers, scheme, need_origin=method not in ("GET", "HEAD")))


class Guard:
    """ASGI middleware over the whole voice app, the runner's own routes too (/api/offer, /start, /sessions/...): a
    refused request is 403, a repeated checked header is refused, and a websocket is closed (the call is WebRTC)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 1008})
        if scope["type"] == "http":
            pairs = [(k.decode("latin-1").lower(), v.decode("latin-1")) for k, v in scope["headers"]]
            headers = dict(pairs)
            names = [k for k, _ in pairs if k in CHECKED]
            query = urllib.parse.parse_qs(scope["query_string"].decode("latin-1"), keep_blank_values=True)
            if scope["path"] == "/call" and "plain" not in query \
                    and headers.get("sec-fetch-site") not in ("none", "same-origin"):
                # the page starts a call on load (2026-11-06: "I should be talking to you instantly"): only his own
                # navigation (typed, a bookmark, the phone app, this page) gets that, including ?view's call redirect;
                # another site's link, or a browser
                # too old to say, gets ?plain, the same page waiting for a tap on the Shepherd
                await send({"type": "http.response.start", "status": 303, "headers": [
                    (b"location", b"/call?plain"), (b"cache-control", b"no-store")]})
                return await send({"type": "http.response.body", "body": b""})
            if len(names) != len(set(names)) or refuse(scope["method"], scope["path"], headers, scope["scheme"]):
                await send({"type": "http.response.start", "status": 403, "headers": [
                    (b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
                return await send({"type": "http.response.body", "body": b'{"error": "not from the call page"}'})
        await self.app(scope, receive, send)


def page_host(host):
    """A name a DNS-rebinding page cannot own: an IP literal, a one-label name (localhost, a LAN name), a *.ts.net
    name, or one listed in VOICE_PAGE_HOSTS (comma list, for a custom domain in front of the call page)."""
    try:
        name = (urllib.parse.urlsplit("//" + host).hostname or "").rstrip(".")
    except ValueError:  # "[::1" and other malformed authorities
        return False
    if not name:
        return False
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        pass
    extra = {h.strip().lower() for h in os.environ.get("VOICE_PAGE_HOSTS", "").split(",") if h.strip()}
    return "." not in name or name.endswith(".ts.net") or name in extra


def prune():
    ROOT.mkdir(parents=True, exist_ok=True)
    for path in ROOT.iterdir():
        if NAME.fullmatch(path.name) and not path.is_symlink() and path.is_file():
            if time.time() - path.stat().st_mtime >= MAX_AGE:
                path.unlink(missing_ok=True)


def add_routes(app, desk_url):
    # Same app and tailnet boundary as /call; no public file server or arbitrary paths.
    import aiohttp
    from fastapi import HTTPException, Request
    from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

    async def cleanup_loop():
        while True:
            try:
                await asyncio.to_thread(prune)
            except OSError:
                logging.exception("Could not prune Sheprd's shown images; retrying in ten minutes")
            await asyncio.sleep(600)

    previous = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        async with previous(app) as state:
            prune()
            cleaner = asyncio.create_task(cleanup_loop())
            try:
                yield state
            finally:
                cleaner.cancel()
                try:
                    await cleaner
                except asyncio.CancelledError:
                    pass

    app.router.lifespan_context = lifespan

    @app.get("/api/ui", include_in_schema=False)
    async def ui_snapshot():
        from live_ui import snapshot
        try:
            return JSONResponse(await asyncio.to_thread(snapshot), headers=NO_STORE)
        except (OSError, UnicodeError):
            raise HTTPException(503, "The new screen is not ready yet.")

    @app.get("/api/ui-version", include_in_schema=False)
    async def ui_version():
        response = await ui_snapshot()
        if response.status_code != 200:
            return response
        return JSONResponse({"type": "ui-update", "revision": json.loads(response.body)["revision"]}, headers=NO_STORE)

    @app.get("/api/show", include_in_schema=False)
    async def latest():
        def fetch():
            with urllib.request.urlopen(urllib.request.Request(desk_url + "/shown", headers=CLIENT), timeout=5) as response:
                return json.load(response)
        try:
            result = await asyncio.to_thread(fetch)
        except (OSError, ValueError):
            raise HTTPException(503, "Sheprd cannot check for new cards. Retrying.")
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.get("/api/shown/{name:path}", include_in_schema=False)
    async def shown_file(name: str):
        match = NAME.fullmatch(name)
        path = ROOT / name
        if (not match or path.is_symlink() or path.resolve().parent != ROOT.resolve()
                or not path.is_file() or time.time() - path.stat().st_mtime >= MAX_AGE):
            raise HTTPException(404)
        with path.open("rb") as stream:
            kind = file_type(stream.read(12))
        extension = match[1].lower().replace("jpeg", "jpg")
        if kind != extension:  # the bytes must be what the name says
            raise HTTPException(404)
        return FileResponse(path, media_type=TYPES[match[1].lower()], headers={
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        })

    def refused(status, error=None):
        return JSONResponse({"error": error or ("desk unreachable" if status == 502 else f"desk answered {status}")},
                            status, headers=NO_STORE)

    async def desk(method, path, route, body=None):
        """One bridge call as the page's answer: the bridge's status and JSON, 502 when it is down or too slow."""
        # UTF-8, not \u escapes: 4000 astral characters are 16 KB here and would be 48 KB escaped (over MAX_BODY)
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=SECONDS[route])) as http:
                async with http.request(method, desk_url + path, data=data,
                                        headers={**CLIENT, **({"Content-Type": "application/json"} if data else {})}) as r:
                    status, payload = r.status, await r.read()
        except (aiohttp.ClientError, asyncio.TimeoutError):
            return refused(502)
        if status >= 400:
            return refused(status)
        try:
            return JSONResponse(json.loads(payload), status, headers=NO_STORE) if payload else Response(
                status_code=status, headers=NO_STORE)
        except ValueError:
            return refused(502)

    async def json_object(request):
        """The page's JSON object, or the refusal: 403 unless it comes from this host's page (cross_site), 415 for a
        body that is not application/json (one a page could send cross-site without a preflight), 413 from
        Content-Length alone, before any read; 400 otherwise."""
        if cross_site(request.headers, request.url.scheme, need_origin=True):
            return None, refused(403, "not from the call page")
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            return None, refused(415, "send JSON")
        try:
            length = int(request.headers["content-length"])
        except (KeyError, ValueError):
            return None, refused(400, "bad request")
        if length > MAX_BODY:
            return None, refused(413, "too long")
        try:
            body = json.loads(await request.body())
        except ValueError:  # UnicodeDecodeError included
            body = None
        return (body, None) if isinstance(body, dict) else (None, refused(400, "bad request"))

    def pane_or_none(value):
        return value is None or isinstance(value, str) and bool(PANE.fullmatch(value))

    @app.get("/api/herd", include_in_schema=False)
    async def herd():
        return await desk("GET", "/herd", "herd")

    @app.get("/api/recap", include_in_schema=False)
    async def recap(id: str = "", summary: str = ""):
        if not PANE.fullmatch(id):
            return refused(400, "bad request")
        query = {"id": id, **({"summary": "1"} if summary == "1" else {})}
        return await desk("GET", "/recap?" + urllib.parse.urlencode(query), "recap")

    @app.post("/api/turn", include_in_schema=False)
    async def turn(request: Request):
        """A typed turn from the page: to the desk, or `to` one sheep; "context": {"sheep": pane | null} is the tab he
        has open (passed on when valid, else dropped: never a refusal)."""
        body, refusal = await json_object(request)
        if refusal:
            return refusal
        text, typed, to, context = body.get("text"), body.get("typed", False), body.get("to"), body.get("context")
        if (not isinstance(text, str) or not 1 <= len(text.strip()) <= MAX_TEXT or not isinstance(typed, bool)
                or not pane_or_none(to)):
            return refused(400, "bad request")
        sheep = context.get("sheep", "") if isinstance(context, dict) else ""  # "" is never a valid sheep
        return await desk("POST", "/turn", "turn", {"text": text.strip(), "typed": typed, **({"to": to} if to else {}),
                                                    **({"context": {"sheep": sheep}} if pane_or_none(sheep) else {})})

    @app.post("/api/target", include_in_schema=False)
    async def target(request: Request):
        body, refusal = await json_object(request)
        if refusal:
            return refusal
        pane = body.get("id", "")
        if not pane_or_none(pane):
            return refused(400, "bad request")
        return await desk("POST", "/target", "target", {"id": pane})

    @app.get("/api/events", include_in_schema=False)
    async def events(follow: str = "desk"):
        """An off-call page's live view of one tab: the bridge's display stream (never the call's own, which counts
        as a call and carries handoffs and herd news), text split into {"say"} and {"show", "id"} like the call."""
        if follow != "desk" and not PANE.fullmatch(follow):
            return refused(400, "bad request")
        # no total timeout; 60 s without a line is a dead bridge (it beats every 15 s)
        http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_read=60))
        try:
            upstream = await http.get(desk_url + "/events?" + urllib.parse.urlencode({"follow": follow}), headers=CLIENT)
        except (aiohttp.ClientError, asyncio.TimeoutError):
            await http.close()
            return refused(502)
        if upstream.status != 200:
            upstream.release()
            await http.close()
            return refused(upstream.status)

        async def lines():
            display = DisplayText()
            try:
                async for raw in upstream.content:
                    try:
                        event = json.loads(raw)
                    except ValueError:
                        continue
                    if not isinstance(event, dict):
                        continue
                    out = [{key: event[key]} for key in PAGE_EVENTS if key in event]
                    if "text" in event:  # never handoff, herd_say, prompt or beat
                        spoken, cards = display.feed(event["text"] or "", final=event.get("text_end", True))
                        if re.search(r"\w", said := speakable(spoken)):
                            out.append({"say": said})
                        out += [{"show": card, "id": card_id(event.get("show_id", card), i)}
                                for i, card in enumerate(cards)]
                    for item in out:
                        yield json.dumps(item) + "\n"
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
                pass  # the bridge dropped, went quiet past 60 s or sent an oversized line: the page reconnects
            finally:
                upstream.close()
                await http.close()

        return StreamingResponse(lines(), media_type="application/x-ndjson", headers=NO_STORE)
