"""Sheprd replay/image boundary and call-show checks; never contacts a live desk or SSH host."""

import asyncio
from contextlib import asynccontextmanager
import http.server
import io
import json
import os
from pathlib import Path
import runpy
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from unittest.mock import Mock, patch

from fastapi import FastAPI
import httpx
import bridge
import shown
from test_call_screen import bot

PNG = b"\x89PNG\r\n\x1a\n" + b"fixture"
JPEG = b"\xff\xd8\xff" + b"fixture"
WEBP = b"RIFF\x00\x00\x00\x00WEBP" + b"fixture"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"fixture"
MP3_BARE = b"\xff\xfb\x90\x00" + b"fixture"  # no tag: a frame sync
OGG = b"OggS\x00\x02" + b"fixture"
WAV = b"RIFF\x00\x00\x00\x00WAVE" + b"fixture"


def line(text, **values):
    return json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}, **values})


class ReplayTest(unittest.IsolatedAsyncioTestCase):
    async def test_replay_and_data_channel_have_same_ids_and_never_speak_image_or_link(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "session.jsonl"
            text = line("Here. [show]https://example.test/login[/show] [show]image:screen.png[/show] Done.")
            path.write_text(text + "\n")
            latest = shown.TranscriptShows().read(path)
            session = bot.ClaudeSession(Mock())
            from unittest.mock import AsyncMock
            session.push_frame = AsyncMock()
            await session._desk_event(shown.text_events(text)[0])
            self.assertEqual(session.push_frame.await_args.args[0].message, latest)
            self.assertEqual(latest["text"], "image:screen.png")
            self.assertEqual([session._speech.get_nowait(), session._speech.get_nowait()], ["Here.", "Done."])
            self.assertTrue(session._speech.empty())

    async def test_keeps_latest_across_speech_ignores_sidechains_and_replays_partial_lines_once(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "session.jsonl"
            path.write_text(line("[show]first[/show]") + "\n")
            reader = shown.TranscriptShows()
            first = reader.read(path)
            with path.open("a") as stream:
                stream.write(line("Next spoken turn.") + "\n" + line("[show]private[/show]", isSidechain=True) + "\n")
            self.assertEqual(reader.read(path), first)
            second = line("[show]second[/show]", uuid="new")
            with path.open("a") as stream:
                stream.write(second[:25])
            self.assertEqual(reader.read(path), first)
            with path.open("a") as stream:
                stream.write(second[25:] + "\n")
            self.assertEqual(reader.read(path)["text"], "second")
            self.assertEqual(reader.read(path)["id"], shown.card_id(shown.text_events(second)[0]["show_id"], 0))
            with path.open("a") as stream:
                stream.write(line("[show]second[/show]", uuid="newer") + "\n")
            self.assertNotEqual(reader.read(path)["id"], shown.card_id(shown.text_events(second)[0]["show_id"], 0))

    async def test_bridge_get_shown_never_starts_a_desk_and_is_voice_host_only(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); sid = "12345678-1234-1234-1234-123456789012"
            state = root / "state.json"; state.write_text(json.dumps({"id": sid}))
            (root / f"{sid}.jsonl").write_text(line("[show]waiting[/show]") + "\n")
            with patch.object(bridge, "STATE", state), patch.object(bridge, "TRANSCRIPTS", root), \
                    patch.object(bridge, "SHOWS", shown.TranscriptShows()), patch.object(bridge, "ensure_desk") as desk, \
                    patch.object(bridge, "ALLOWED", {"192.0.2.10"}):
                for caller, expected in (("192.0.2.10", 200), ("127.0.0.1", 404)):
                    handler = object.__new__(bridge.Desk)
                    handler.client_address = (caller, 1); handler.path = "/shown"; handler.wfile = io.BytesIO()
                    handler.headers = {"X-Sheprd": "1"}
                    handler.send_response = Mock(); handler.send_error = Mock()
                    handler.send_header = Mock(); handler.end_headers = Mock()
                    handler.do_GET()
                    if expected == 200:
                        self.assertEqual(json.loads(handler.wfile.getvalue())["text"], "waiting")
                        handler.send_response.assert_called_once_with(200)
                    else:
                        handler.send_error.assert_called_once_with(404)
                desk.assert_not_called()


class ImageRouteTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "shown"; self.root.mkdir()
        patcher = patch.object(shown, "ROOT", self.root); patcher.start(); self.addCleanup(patcher.stop)
        self.app = FastAPI(); shown.add_routes(self.app, "http://desk.invalid")
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    async def test_allowed_image_and_audio_types_and_same_origin_no_cache(self):
        for name, body, mime in (("one.png", PNG, "image/png"), ("two.jpg", JPEG, "image/jpeg"),
                                 ("three.jpeg", JPEG, "image/jpeg"), ("four.WEBP", WEBP, "image/webp"),
                                 ("five.mp3", MP3, "audio/mpeg"), ("bare.mp3", MP3_BARE, "audio/mpeg"),
                                 ("six.ogg", OGG, "audio/ogg"), ("seven.wav", WAV, "audio/wav")):
            (self.root / name).write_bytes(body)
            response = await self.client.get("/api/shown/" + name)
            self.assertEqual(response.status_code, 200); self.assertEqual(response.content, body)
            self.assertEqual(response.headers["content-type"], mime)
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertEqual(response.headers["x-content-type-options"], "nosniff")

    async def test_rejects_traversal_encoded_separators_absolute_paths_and_symlinks(self):
        outside = self.root.parent / "private.png"; outside.write_bytes(PNG)
        (self.root / "linked.png").symlink_to(outside)
        for name in ("%2e%2e/private.png", "..%2fprivate.png", "%2fprivate.png", "sub/private.png",
                     "..%5cprivate.png", "%252e%252e%252fprivate.png", "linked.png", "bad%00.png"):
            response = await self.client.get("/api/shown/" + name)
            self.assertEqual(response.status_code, 404, name)

    async def test_rejects_unsupported_mislabeled_missing_and_expired_files(self):
        for name, body in (("bad.svg", b"<svg/>"), ("bad.gif", b"GIF89a"), ("fake.png", b"<html>"),
                           ("wrong.jpg", PNG), ("old.png", PNG), ("bad.flac", b"fLaC"), ("wrong.mp3", PNG),
                           ("fake.wav", WEBP), ("fake.webp", WAV), ("old.mp3", MP3)):
            path = self.root / name; path.write_bytes(body)
            if name.startswith("old."):
                os.utime(path, (time.time() - 86401,) * 2)
            self.assertEqual((await self.client.get("/api/shown/" + name)).status_code, 404, name)
        self.assertEqual((await self.client.get("/api/shown/missing.png")).status_code, 404)

    async def test_prune_only_expired_images_and_lifespan_preserves_existing_setup(self):
        for name in ("old.png", "new.jpg", "notes.txt"):
            path = self.root / name; path.write_bytes(PNG)
            if name != "new.jpg":
                os.utime(path, (time.time() - 86401,) * 2)
        calls = []
        @asynccontextmanager
        async def original(app):
            calls.append("start")
            yield {"existing": True}
            calls.append("stop")
        app = FastAPI(lifespan=original); shown.add_routes(app, "http://desk.invalid")
        async with app.router.lifespan_context(app) as state:
            await asyncio.sleep(0)
            self.assertEqual(state, {"existing": True})
            self.assertFalse((self.root / "old.png").exists())
            self.assertTrue((self.root / "new.jpg").exists()); self.assertTrue((self.root / "notes.txt").exists())
        self.assertEqual(calls, ["start", "stop"])

    async def test_latest_proxy_returns_card_null_or_clear_failure(self):
        for body in (None, {"type": "show", "text": "pending", "id": "id"}):
            with patch.object(shown.urllib.request, "urlopen") as request:
                request.return_value.__enter__.return_value = io.BytesIO(json.dumps(body).encode())
                response = await self.client.get("/api/show")
                self.assertEqual(response.status_code, 200); self.assertEqual(response.json(), body)
                self.assertEqual(response.headers["cache-control"], "no-store")
                sent = request.call_args.args[0]  # a Request carrying shown.CLIENT, which the bridge requires
                self.assertEqual((sent.full_url, sent.get_header("X-sheprd"), request.call_args.kwargs), (
                    "http://desk.invalid/shown", "1", {"timeout": 5}))
        with patch.object(shown.urllib.request, "urlopen", side_effect=OSError("offline")):
            response = await self.client.get("/api/show")
            self.assertEqual(response.status_code, 503)
            self.assertIn("cannot check", response.json()["detail"])


class Upstream(http.server.BaseHTTPRequestHandler):
    """A stub bridge on a free 127.0.0.1 port: `routes[path]` is (status, body); a list body is NDJSON lines."""

    def handle_one(self):
        url = urllib.parse.urlsplit(self.path)
        body = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
        self.server.seen.append((self.command, self.path, body))
        status, payload = self.server.routes.get(url.path, (404, None))
        if self.headers.get("X-Sheprd") != "1":  # the real bridge's rule: every proxy call must carry shown.CLIENT
            status, payload = 403, None
        self.send_response(status)
        if isinstance(payload, list):
            self.send_header("Content-Type", "application/x-ndjson"); self.end_headers()
            for item in payload:
                self.wfile.write((item if isinstance(item, str) else json.dumps(item)).encode() + b"\n")
                self.wfile.flush()
            return
        data = b"" if payload is None else json.dumps(payload).encode()
        self.send_header("Content-Length", str(len(data))); self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = handle_one

    def log_message(self, *args):
        pass


def serve(handler, **attrs):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.seen = []
    for key, value in attrs.items():
        setattr(server, key, value)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def asked(path):
    """A request path as the bridge reads it (urlsplit + parse_qs)."""
    url = urllib.parse.urlsplit(path)
    return url.path, urllib.parse.parse_qs(url.query, keep_blank_values=True)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


HERD = [{"id": "w4:pCF", "name": "api", "title": "fix the api", "status": "working", "talk": True}]


class ProxyTest(unittest.IsolatedAsyncioTestCase):
    """The voice host's same-origin proxies to the bridge; the bridge here is a stub on a free port (no live desk)."""

    async def client_for(self, url, page=True):
        """The call page's requests: same origin (a browser sends Origin on every POST); page=False sends none."""
        app = FastAPI(); shown.add_routes(app, url)
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test",
                                   headers={"Origin": "http://test"} if page else {})
        self.addAsyncCleanup(client.aclose)
        return client

    async def asyncSetUp(self):
        self.server, self.url = serve(Upstream, routes={})
        self.addCleanup(self.server.server_close); self.addCleanup(self.server.shutdown)
        self.client = await self.client_for(self.url)

    async def test_api_herd_proxies(self):
        self.server.routes["/herd"] = (200, {"herd": HERD})
        response = await self.client.get("/api/herd")
        self.assertEqual(response.status_code, 200); self.assertEqual(response.json(), {"herd": HERD})
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(self.server.seen, [("GET", "/herd", b"")])

    async def test_api_herd_upstream_down(self):
        client = await self.client_for(f"http://127.0.0.1:{free_port()}")
        for method, path, body in (("GET", "/api/herd", None), ("GET", "/api/recap?id=w4:p1", None),
                                   ("POST", "/api/turn", {"text": "hi", "typed": True}),
                                   ("POST", "/api/target", {"id": None}), ("GET", "/api/events", None)):
            response = await client.request(method, path, json=body)
            self.assertEqual(response.status_code, 502, path)
            self.assertEqual(response.json(), {"error": "desk unreachable"})

    async def test_upstream_refusals_pass_through(self):
        for status in (400, 404, 409, 503):
            self.server.routes["/target"] = (status, None)
            response = await self.client.post("/api/target", json={"id": "w4:pCF"})
            self.assertEqual(response.status_code, status); self.assertIn("error", response.json())

    async def test_api_turn_validates(self):
        bad = [{"text": ""}, {"text": "   \n "}, {"text": "x" * 4001}, {"text": 5}, {"typed": True}, [], "hi",
               {"text": "hi", "typed": "yes"}, {"text": "hi", "to": "../x"}, {"text": "hi", "to": "w4:p1;x"},
               {"text": "hi", "to": "desk"}, {"text": "hi", "to": 4}]
        for body in bad:
            response = await self.client.post("/api/turn", json=body)
            self.assertEqual(response.status_code, 400, body)
        for raw in (b"{not json", b"\xff\xfe"):
            response = await self.client.post("/api/turn", content=raw, headers={"Content-Type": "application/json"})
            self.assertEqual(response.status_code, 400, raw)
        big = json.dumps({"text": "x", "pad": "y" * (32 * 1024)}).encode()
        response = await self.client.post("/api/turn", content=big, headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.server.seen, [], "a refused turn reached the bridge")

    async def test_forged_posts_are_refused_before_the_bridge(self):
        """Request forgery: another site's page, a request with no Origin, or a body that is not JSON never reaches the
        bridge on /api/turn or /api/target."""
        self.server.routes.update({"/turn": (202, None), "/target": (204, None)})
        bare = await self.client_for(self.url, page=False)
        routes = (("/api/turn", {"text": "rm -rf ~", "typed": True}), ("/api/target", {"id": None}))
        for path, body in routes:
            for origin in ("https://evil.example", "null", "http://test.evil.example", "https://test", "http://test:81",
                           "http://other"):
                response = await bare.post(path, json=body, headers={"Origin": origin})
                self.assertEqual(response.status_code, 403, (path, origin))
            self.assertEqual((await bare.post(path, json=body)).status_code, 403, path)  # no Origin on a POST
            for kind in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x",
                         "text/plain;charset=UTF-8", "application/jsonx"):
                response = await self.client.post(path, content=json.dumps(body), headers={"Content-Type": kind})
                self.assertEqual(response.status_code, 415, (path, kind))
            response = await self.client.post(path, content=json.dumps(body))  # no type at all
            self.assertEqual(response.status_code, 415, path)
        self.assertEqual(self.server.seen, [], "a forged request reached the bridge")
        # behind tailscale serve: Host kept, HTTPS named in X-Forwarded-Proto, the page's https origin passes
        proxied = {"Host": "box.example.ts.net:8443", "X-Forwarded-Proto": "https",
                   "Origin": "https://box.example.ts.net:8443"}
        self.assertEqual((await bare.post("/api/target", json={"id": None}, headers=proxied)).status_code, 204)
        self.assertEqual((await bare.post("/api/target", json={"id": None}, headers={**proxied, "X-Forwarded-Proto": "http"})
                          ).status_code, 403)
        # X-Forwarded-Host is never trusted: only Host names this server
        self.assertEqual((await bare.post("/api/target", json={"id": None}, headers={
            **proxied, "Host": "127.0.0.1:7862", "X-Forwarded-Host": "box.example.ts.net:8443"})).status_code, 403)
        self.assertEqual((await bare.post("/api/target", json={"id": None}, headers={
            "Host": "192.0.2.1:7862", "Origin": "http://192.0.2.9:7862", "X-Forwarded-Host": "192.0.2.9:7862",
            "X-Forwarded-Proto": "http"})).status_code, 403)  # an attacker IP origin naming itself
        # the page's own request: same origin, JSON, a charset parameter allowed
        response = await self.client.post("/api/turn", content=json.dumps({"text": "hi", "typed": True}),
                                          headers={"Content-Type": "application/json; charset=utf-8"})
        self.assertEqual(response.status_code, 202)

    def test_cross_site_rules(self):
        same = {"origin": "http://test", "host": "test"}
        self.assertFalse(shown.cross_site(same, "http", need_origin=True))
        self.assertTrue(shown.cross_site({"host": "test"}, "http", need_origin=True))
        self.assertFalse(shown.cross_site({"host": "test"}, "http", need_origin=False))  # uploads: absent is allowed
        self.assertTrue(shown.cross_site({**same, "origin": "http://evil.example"}, "http", need_origin=False))
        self.assertTrue(shown.cross_site({**same, "origin": "HTTP://TEST.evil"}, "http", need_origin=False))
        self.assertFalse(shown.cross_site({**same, "origin": "HTTP://TEST"}, "http", need_origin=True))
        self.assertTrue(shown.cross_site({"origin": "http://test"}, "http", need_origin=True))  # no Host: never same
        # DNS rebinding: a page on a name the attacker owns, resolved to this host, is same-origin to the browser
        rebound = {"origin": "http://evil.example:7862", "host": "evil.example:7862"}
        self.assertTrue(shown.cross_site(rebound, "http", need_origin=True))
        self.assertTrue(shown.cross_site({**rebound, "x-forwarded-host": "box.tail1.ts.net"}, "http", need_origin=True))
        for host in ("box.tail1.ts.net:8797", "192.0.2.1:7862", "localhost:7862", "[::1]:7862", "127.0.0.1"):
            self.assertFalse(shown.cross_site({"origin": "https://" + host, "host": host}, "https", need_origin=True), host)
        with patch.dict(os.environ, {"VOICE_PAGE_HOSTS": "call.example.org"}):
            self.assertFalse(shown.cross_site({"origin": "https://call.example.org", "host": "call.example.org"},
                                              "https", need_origin=True))

    async def test_guard(self):
        """Guard over a whole app: only the page loads bare; everything else needs X-Sheprd, a page Host, a same-origin
        fetch and (unless GET) this host's Origin. Covers the runner's own routes and OPTIONS preflights."""
        app = FastAPI()
        for path in ("/call", "/sheprd/{name}", "/api/shown/{name}", "/api/events", "/status"):
            app.get(path)(lambda: {"ok": True})
        app.post("/api/offer")(lambda: {"ok": True})
        app.add_middleware(shown.Guard)
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(client.aclose)
        page = {"X-Sheprd": "1"}
        status = lambda r: r.status_code
        for path in ("/call?plain", "/sheprd/px.js", "/api/shown/x.png"):  # the page itself, no proof needed
            self.assertEqual(status(await client.get(path)), 200, path)
            self.assertEqual(status(await client.get(path, headers={"Host": "evil.example:7862"})), 403, path)  # rebound
        # the page starts a call on load: only his own navigation (none/same-origin) gets that page; any other, or a
        # browser without Fetch Metadata, is sent to ?plain. ?view now opens the real call and needs the same guard.
        for site in ("none", "same-origin"):
            for path in ("/call", "/call?auto", "/call?plain", "/call?view"):
                self.assertEqual(status(await client.get(path, headers={"Sec-Fetch-Site": site})), 200, (site, path))
        for site in ("cross-site", "same-site", "", "bogus", None):  # None: a browser without Fetch Metadata
            for path in ("/call", "/call?auto", "/call?auto=1", "/call?demo", "/call?view", "/call?view&auto"):
                reply = await client.get(path, headers={"Sec-Fetch-Site": site} if site is not None else {})
                self.assertEqual((status(reply), reply.headers.get("location")), (303, "/call?plain"), (site, path))
            for path in ("/call?plain", "/call?view&plain"):
                self.assertEqual(status(await client.get(path, headers={"Sec-Fetch-Site": site} if site is not None else {})), 200, (site, path))
        for host in ("", "[::1", "evil.example"):
            self.assertFalse(shown.page_host(host), host)
        for path in ("/api/events", "/api/events?follow=desk", "/status"):
            self.assertEqual(status(await client.get(path, headers=page)), 200, path)
            for forged in ({}, {"X-Sheprd": "0"}, {**page, "Sec-Fetch-Site": "cross-site"},
                           {**page, "Sec-Fetch-Site": "same-site"}, {**page, "Sec-Fetch-Site": "none"},
                           {**page, "Host": "evil.example:7862"},  # DNS rebinding: same-origin to the browser
                           {**page, "Origin": "http://evil.example"}):
                self.assertEqual(status(await client.get(path, headers=forged)), 403, (path, forged))
        offer = {**page, "Origin": "http://test"}
        self.assertEqual(status(await client.post("/api/offer", json={}, headers=offer)), 200)
        for forged in ({"Origin": "http://test"}, page,  # a simple cross-site POST can't add X-Sheprd; Origin is required
                       {**offer, "Origin": "http://evil.example"}, {**offer, "Host": "evil.example", "Origin": "http://evil.example"},
                       {**offer, "Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(status(await client.post("/api/offer", content="{}", headers=forged)), 403, forged)
        # no CORS answer, so a browser never sends another site's X-Sheprd or X-Forwarded-Host
        preflight = await client.options("/api/offer", headers={"Origin": "http://evil.example",
                                                                 "Access-Control-Request-Method": "POST",
                                                                 "Access-Control-Request-Headers": "x-sheprd"})
        self.assertEqual(status(preflight), 403); self.assertNotIn("access-control-allow-origin", preflight.headers)
        # a repeated checked header is refused (no first-vs-last ambiguity downstream)
        for name in ("Origin", "X-Sheprd"):
            raw = httpx.Headers(list(offer.items()) + [(name, offer[name])])
            self.assertEqual(status(await client.post("/api/offer", json={}, headers=raw)), 403, name)
        # a websocket is closed before it opens
        sent = []
        async def send(message): sent.append(message)
        await shown.Guard(None)({"type": "websocket", "path": "/ws", "headers": []}, None, send)
        self.assertEqual(sent, [{"type": "websocket.close", "code": 1008}])

    async def test_bots_real_turn_reaches_the_real_bridge(self):
        """bot.py's own /turn (aiohttp json=, no browser headers) passes the bridge's forgery checks."""
        import aiohttp
        with tempfile.TemporaryDirectory() as temp, patch.object(bridge, "ALLOWED", {"127.0.0.1"}), \
                patch.object(bridge, "LOG", Path(temp) / "turns.log"), \
                patch.object(bridge, "ensure_desk", return_value={"agent_status": "idle"}), \
                patch.object(bridge, "herdr", return_value="") as herdr:
            server, url = serve(bridge.Desk)
            self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
            session = bot.ClaudeSession(Mock())
            with patch.dict(bot.ClaudeSession._turn.__globals__, {"aiohttp": aiohttp, "DESK_URL": url}):
                await session._turn("hello desk")
            herdr.assert_called_once_with("agent", "prompt", bridge.NAME, bridge.PHONE + "hello desk", timeout=20)
            self.assertTrue(session._speech.empty())  # no "couldn't reach the desk"

    async def test_api_turn_typed(self):
        self.server.routes["/turn"] = (202, None)
        response = await self.client.post("/api/turn", json={"text": "hi", "typed": True})
        self.assertEqual(response.status_code, 202)
        self.assertEqual([(m, p, json.loads(b)) for m, p, b in self.server.seen],
                         [("POST", "/turn", {"text": "hi", "typed": True})])
        await self.client.post("/api/turn", json={"text": " to a sheep ", "typed": True, "to": "w4:pCF"})
        self.assertEqual(json.loads(self.server.seen[-1][2]), {"text": "to a sheep", "typed": True, "to": "w4:pCF"})

    async def test_api_turn_passes_the_open_sheep_and_drops_a_bad_context(self):
        self.server.routes["/turn"] = (202, None)
        for context, sent in (({"sheep": "w4:pCF"}, {"sheep": "w4:pCF"}), ({"sheep": None}, {"sheep": None}),
                              ({"sheep": "../x"}, None), ({"sheep": "w4:p1;x"}, None), ({"sheep": 4}, None),
                              ("w4:pCF", None), ([], None), ({}, None)):
            response = await self.client.post("/api/turn", json={"text": "this one?", "typed": True, "context": context})
            self.assertEqual(response.status_code, 202, context)  # a bad context is dropped, never a 400
            want = {"text": "this one?", "typed": True, **({"context": sent} if sent else {})}
            self.assertEqual(json.loads(self.server.seen[-1][2]), want, context)

    async def test_4000_char_non_ascii_turn_passes_the_proxy_and_the_real_bridge(self):
        text = "🐑é" * 2000  # 4000 characters, 12 KB of UTF-8 (48 KB if escaped as \\u pairs)
        with tempfile.TemporaryDirectory() as temp, patch.object(bridge, "ALLOWED", {"127.0.0.1"}), \
                patch.object(bridge, "LOG", Path(temp) / "turns.log"), \
                patch.object(bridge, "ensure_desk", return_value={"agent_status": "idle"}), \
                patch.object(bridge, "herdr", return_value="") as herdr:
            server, url = serve(bridge.Desk)
            self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
            client = await self.client_for(url)
            response = await client.post("/api/turn", json={"text": text, "typed": True})
            self.assertEqual(response.status_code, 202)
            herdr.assert_called_once_with("agent", "prompt", bridge.NAME, bridge.TYPED + text, timeout=20)
            response = await client.post("/api/turn", json={"text": text + "x", "typed": True})
            self.assertEqual(response.status_code, 400)
            self.assertEqual(herdr.call_count, 1)

    async def test_api_target_validates_and_proxies(self):
        self.server.routes["/target"] = (204, None)
        for body in ({}, {"id": "desk"}, {"id": "../x"}, {"id": 3}, [], {"id": "w4:p1\n"}):
            self.assertEqual((await self.client.post("/api/target", json=body)).status_code, 400, body)
        self.assertEqual(self.server.seen, [])
        for pane in ("w4:pCF", None):
            response = await self.client.post("/api/target", json={"id": pane})
            self.assertEqual(response.status_code, 204)
            self.assertEqual(json.loads(self.server.seen[-1][2]), {"id": pane})

    async def test_api_recap_rejects_bad_id(self):
        for query in ("id=../x", "id=", "", "id=w4:p1;x", "id=desk"):
            self.assertEqual((await self.client.get("/api/recap?" + query)).status_code, 400, query)
        self.assertEqual(self.server.seen, [])
        self.server.routes["/recap"] = (200, {"about": "fixing"})
        response = await self.client.get("/api/recap?id=w4:pCF&summary=1")
        self.assertEqual(response.json(), {"about": "fixing"})
        await self.client.get("/api/recap?id=w4:pCF")
        self.assertEqual([asked(p) for _, p, _ in self.server.seen],
                         [("/recap", {"id": ["w4:pCF"], "summary": ["1"]}), ("/recap", {"id": ["w4:pCF"]})])

    async def test_api_events_display_split(self):
        speaker = {"id": "w4:pCF", "name": "api"}
        self.server.routes["/events"] = (200, [
            {"ready": True}, {"herd": HERD}, {"herd_say": "api is done."}, {"prompt": True}, {"beat": True},
            {"text": "Hi.[show]card[/show]", "text_end": True, "show_id": "abc"}, {"busy": True},
            {"handoff": {"url": "https://x.example.ts.net/h/a"}}, {"speaker": speaker}, "not json",
            {"text": "**Bold** move. [sh", "text_end": False}, {"text": "ow]two[/show]", "text_end": True},
            {"text": "[show]solo[/show]"},
        ])
        response = await self.client.get("/api/events")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/x-ndjson")
        self.assertEqual([json.loads(x) for x in response.text.splitlines()], [
            {"ready": True}, {"herd": HERD}, {"say": "Hi."}, {"show": "card", "id": shown.card_id("abc", 0)},
            {"busy": True}, {"speaker": speaker}, {"say": "Bold move."}, {"show": "two", "id": shown.card_id("two", 0)},
            {"show": "solo", "id": shown.card_id("solo", 0)},
        ])
        # a display stream, never the call's own
        self.assertEqual(asked(self.server.seen[-1][1]), ("/events", {"follow": ["desk"]}))
        await self.client.get("/api/events?follow=w4:pCF")
        self.assertEqual(asked(self.server.seen[-1][1]), ("/events", {"follow": ["w4:pCF"]}))
        count = len(self.server.seen)
        for follow in ("", "x;y", "../x", "w4:p"):
            self.assertEqual((await self.client.get("/api/events?follow=" + follow)).status_code, 400, follow)
        self.assertEqual(len(self.server.seen), count)
        self.server.routes["/events"] = (404, None)
        self.assertEqual((await self.client.get("/api/events?follow=w4:p9")).status_code, 404)

    async def test_api_events_closes_the_bridge_stream_when_the_page_closes(self):
        import uvicorn

        class Forever(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.end_headers()
                try:
                    self.wfile.write(b'{"ready": true}\n'); self.wfile.flush()
                    while True:  # beats are dropped for the page, so only the bridge side sees this loop
                        time.sleep(0.05); self.wfile.write(b'{"beat": true}\n'); self.wfile.flush()
                except OSError:
                    self.server.gone.set()

            def log_message(self, *args):
                pass

        bridge, url = serve(Forever, gone=threading.Event())
        self.addCleanup(bridge.server_close); self.addCleanup(bridge.shutdown)
        app = FastAPI(); shown.add_routes(app, url)
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=free_port(), log_level="error",
                                               lifespan="off"))
        running = asyncio.create_task(server.serve())
        self.addAsyncCleanup(lambda: asyncio.wait_for(running, 5))
        self.addCleanup(setattr, server, "should_exit", True)
        while not server.started:
            await asyncio.sleep(0.01)
        async with httpx.AsyncClient() as page:
            async with page.stream("GET", f"http://127.0.0.1:{server.config.port}/api/events") as response:
                lines = response.aiter_lines()
                self.assertEqual(json.loads(await asyncio.wait_for(anext(lines), 5)), {"ready": True})
        self.assertTrue(await asyncio.to_thread(bridge.gone.wait, 5), "the bridge stream outlived the page")


class CallShowTest(unittest.TestCase):
    def setUp(self):
        self.helper = runpy.run_path(str(Path(__file__).with_name("call-show")))

    def env(self, **values):
        """call-show's knobs exactly as given; everything else unset, and a home with no shepherd.env."""
        keep = {k: os.environ.pop(k) for k in ("VOICE_SHOW_SSH", "VOICE_SHOWN_DIR", "VOICE_STATE") if k in os.environ}
        self.addCleanup(os.environ.update, keep)
        home = tempfile.TemporaryDirectory(); self.addCleanup(home.cleanup)
        self.home = Path(home.name)
        return patch.dict(os.environ, {"HOME": home.name, **values})

    def test_bare_run_reads_shepherd_env_and_the_environment_wins(self):
        # the desk's Herdr pane runs call-show with none of the bridge unit's environment (Nov 6: the image stayed on the desk machine, 404)
        with tempfile.TemporaryDirectory() as temp, self.env():
            path = Path(temp) / "shot.png"; path.write_bytes(PNG)
            config = self.home / ".config/shepherd"; config.mkdir(parents=True)
            (config / "shepherd.env").write_text("# his box\nVOICE_SHOW_SSH=voice-host\nVOICE_SHOWN_DIR='/srv/shown'\n")
            with patch.object(subprocess, "run") as run:
                self.helper["show_file"](path)
            command = run.call_args.args[0]
            self.assertIn("voice-host", command); self.assertEqual(shlex.split(command[-1])[4], "/srv/shown")
            with patch.dict(os.environ, {"VOICE_SHOW_SSH": "", "VOICE_SHOWN_DIR": str(Path(temp) / "here")}), \
                    patch.object(subprocess, "run") as run:
                self.helper["show_file"](path)
            self.assertEqual(run.call_args.args[0][:2], ["python3", "-c"])  # an explicit empty host means this machine

    def test_upload_marker_remote_atomic_copy_pruning_and_filename_is_never_shell_code(self):
        with tempfile.TemporaryDirectory() as temp, self.env(VOICE_SHOW_SSH="voice-host"):
            root = Path(temp); path = root / "screen $(touch unexpected).PNG"; path.write_bytes(PNG)
            with patch.object(subprocess, "run") as run:
                marker = self.helper["show_file"](path)
            self.assertRegex(marker, r"^\[show\]image:[0-9a-f]{32}\.png\[/show\]$")
            command = run.call_args.args[0]
            self.assertEqual(command[:2], ["ssh", "-o"]); self.assertIn("voice-host", command)
            self.assertNotIn(path.name, command[-1]); self.assertTrue(run.call_args.kwargs["check"])
            words = shlex.split(command[-1]); self.assertEqual(words[:2], ["python3", "-c"])
            self.assertEqual(words[4], "~/.local/state/shepherd/shown")  # expanded on the voice host
            folder = root / ".local/state/shepherd/shown"; folder.mkdir(parents=True)
            old = folder / "old.jpg"; old.write_bytes(JPEG); os.utime(old, (time.time() - 86401,) * 2)
            clip = folder / "old.mp3"; clip.write_bytes(MP3); os.utime(clip, (time.time() - 86401,) * 2)
            keep = folder / "notes.txt"; keep.write_text("keep"); os.utime(keep, (time.time() - 86401,) * 2)
            with patch.dict(os.environ, {"HOME": str(root)}), patch.object(sys, "argv", ["-c", *words[3:]]), \
                    patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(PNG))):
                exec(compile(words[2], "remote-call-show", "exec"), {})
            self.assertEqual((folder / words[3]).read_bytes(), PNG)
            self.assertEqual((folder / words[3]).stat().st_mode & 0o777, 0o600)
            self.assertFalse(old.exists()); self.assertFalse(clip.exists()); self.assertTrue(keep.exists()); self.assertEqual(list(folder.glob(".*.part")), [])

    def test_without_ssh_host_copies_on_this_machine(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); path = root / "shot.png"; path.write_bytes(PNG); folder = root / "shown"
            with self.env(VOICE_SHOWN_DIR=str(folder)), patch.object(subprocess, "run", wraps=subprocess.run) as run:
                marker = self.helper["show_file"](path)
            self.assertEqual(run.call_args.args[0][:2], ["python3", "-c"])  # no ssh
            name = marker.removeprefix("[show]image:").removesuffix("[/show]")
            self.assertEqual((folder / name).read_bytes(), PNG)
            self.assertEqual((folder / name).stat().st_mode & 0o777, 0o600)

    def test_types_fail_closed_and_ssh_failure_never_prints_success(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "file"
            for body in (b"<svg/>", b"GIF89a", b"<html>"):
                path.write_bytes(body)
                with patch.object(subprocess, "run") as run, self.assertRaises(ValueError):
                    self.helper["show_file"](path)
                run.assert_not_called()
            for body, extension, kind in ((PNG, "png", "image"), (JPEG, "jpg", "image"), (WEBP, "webp", "image"),
                                          (MP3, "mp3", "audio"), (MP3_BARE, "mp3", "audio"), (OGG, "ogg", "audio"), (WAV, "wav", "audio")):
                path.write_bytes(body)
                with patch.object(subprocess, "run"):
                    self.assertRegex(self.helper["show_file"](path), r"^\[show\]" + kind + r":[0-9a-f]{32}\." + extension + r"\[/show\]$")
            with patch.object(subprocess, "run", side_effect=subprocess.CalledProcessError(1, "ssh")), \
                    self.assertRaises(subprocess.CalledProcessError):
                self.helper["show_file"](path)


if __name__ == "__main__":
    unittest.main()
