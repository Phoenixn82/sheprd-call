"""Phone uploads and background preparation; imported without loading the voice pipeline."""

import asyncio
import datetime
import json
import math
import mimetypes
import os
import re
from pathlib import Path
import subprocess
import tarfile
import threading
import time
import uuid
import urllib.request

from fastapi import BackgroundTasks, HTTPException, Request
from fastapi.responses import JSONResponse

from shown import CLIENT, cross_site

ROOT = Path(os.environ.get("VOICE_UPLOADS_DIR") or Path(os.environ.get("VOICE_STATE", "~/.local/state/shepherd")) / "uploads").expanduser()  # phone uploads, by day
MAX_UPLOAD = 4 * 1024**3
MAX_BUNDLE = 512 * 1024**2
WORK = threading.Lock()  # bound GPU, ffmpeg and bundle memory to one upload at a time


def frame_interval(duration):
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Video has no valid duration")
    return max(1.0, duration / 90)


def probe(path):
    result = subprocess.run(["nice", "-n", "10", "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format",
                             "-of", "json", str(path)], capture_output=True, text=True, check=True, timeout=60)
    return json.loads(result.stdout)


def run_ffmpeg(path, *args):
    subprocess.run(["nice", "-n", "10", "ffmpeg", "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe", "-i", str(path),
                    *args], check=True, timeout=6 * 3600)


def prepare(path, kind, info, transcribe):
    bundle = path.parent / path.stem
    frames = bundle / "frames"
    frames.mkdir(parents=True, exist_ok=True)
    streams = info.get("streams", [])
    duration = float(info.get("format", {}).get("duration", 0)) if kind == "video" else 0
    interval = frame_interval(duration) if kind == "video" else 0
    scale = "scale=w='min(iw,{size})':h='min(ih,{size})':force_original_aspect_ratio=decrease"
    if kind == "video":
        run_ffmpeg(path, "-map", "0:v:0", "-vf", f"fps=1/{interval}:round=up," + scale.format(size=1024),
                   "-frames:v", "90", "-q:v", "3", str(frames / "%03d.jpg"))
    else:
        run_ffmpeg(path, "-vf", scale.format(size=2048), "-frames:v", "1", "-q:v", "2", str(frames / "001.jpg"))
    if not list(frames.glob("*.jpg")):
        raise ValueError("No readable frames")
    transcript = "No audio track.\n" if kind == "video" else "Photo; no audio.\n"
    if kind == "video" and any(s.get("codec_type") == "audio" for s in streams):
        audio = bundle / "audio.wav"
        try:
            run_ffmpeg(path, "-vn", "-ac", "1", "-ar", "16000", str(audio))
            transcript = transcribe(audio) or "Audio track present; no speech recognized.\n"
        finally:
            audio.unlink(missing_ok=True)
    (bundle / "transcript.txt").write_text(transcript)
    (bundle / "meta.json").write_text(json.dumps({"id": path.stem, "kind": kind, "duration": duration,
                                                 "original": str(path), "frame_interval": interval}))
    return bundle


def deliver(path, kind, info, transcribe, desk_url):
    def work():
        os.nice(10)  # Linux niceness applies to this short-lived worker thread, not the call loop.
        _deliver(path, kind, info, transcribe, desk_url)
    worker = threading.Thread(target=work, name="call-media")
    worker.start()
    worker.join()


def save_status(bundle, value):
    pending = bundle / "status.tmp"
    pending.write_text(json.dumps(value))
    pending.replace(bundle / "status.json")


def _deliver(path, kind, info, transcribe, desk_url):
    # BackgroundTasks runs this synchronous function off the call's event loop.
    with WORK:
        try:
            bundle = prepare(path, kind, info, transcribe)
            archive = path.with_suffix(".tar")
            with tarfile.open(archive, "w") as tar:
                for item in sorted(bundle.rglob("*")):
                    if item.is_file():
                        tar.add(item, arcname=str(item.relative_to(bundle)), recursive=False)
            if archive.stat().st_size > MAX_BUNDLE:
                raise ValueError("Prepared bundle exceeds 512 MiB")
            with archive.open("rb") as body:
                request = urllib.request.Request(desk_url + "/media", data=body, method="POST", headers={
                    **CLIENT, "Content-Type": "application/x-tar", "Content-Length": str(archive.stat().st_size)})
                with urllib.request.urlopen(request, timeout=180) as response:
                    if response.status != 202:
                        raise ValueError(f"Desk answered {response.status}")
            save_status(bundle, {"state": "sent"})
        except Exception as error:
            bundle = path.parent / path.stem
            bundle.mkdir(exist_ok=True)
            save_status(bundle, {"state": "error", "detail": str(error)})
        finally:
            path.with_suffix(".tar").unlink(missing_ok=True)


def add_routes(app, transcribe, desk_url):
    @app.post("/api/media")
    async def upload(request: Request, background: BackgroundTasks):
        if cross_site(request.headers, request.url.scheme, need_origin=False):  # another site's page: refused
            raise HTTPException(403, "Not from the call page")
        media_type = request.headers.get("content-type", "").split(";")[0].lower()
        if not media_type.startswith(("image/", "video/")):
            raise HTTPException(415, "Choose a photo or video")
        try:
            length = int(request.headers.get("content-length", "0"))
        except ValueError:
            raise HTTPException(400, "Invalid upload length")
        if length < 0 or length > MAX_UPLOAD:
            raise HTTPException(413, "Photo or video exceeds 4 GB")
        kind = media_type.split("/")[0]
        kind = "photo" if kind == "image" else "video"
        extension = mimetypes.guess_extension(media_type) or (".img" if kind == "photo" else ".video")
        folder = ROOT / datetime.date.today().isoformat()
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{time.time_ns()}-{uuid.uuid4().hex[:12]}{extension}"
        try:
            size = 0
            with path.open("xb") as target:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise HTTPException(413, "Photo or video exceeds 4 GB")
                    target.write(chunk)
            if not size:
                raise HTTPException(415, "The photo or video is empty")
            try:
                info = await asyncio.to_thread(probe, path)
                if not any(s.get("codec_type") == "video" and s.get("width", 0) > 0 and s.get("height", 0) > 0
                           for s in info.get("streams", [])):
                    raise ValueError("No image or video stream")
                if kind == "video":
                    frame_interval(float(info.get("format", {}).get("duration", 0)))
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                raise HTTPException(415, "Cannot read this photo or video") from error
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        background.add_task(deliver, path, kind, info, transcribe, desk_url)
        return JSONResponse({"id": path.stem}, status_code=202)

    @app.get("/api/media/{media_id}")
    async def status(media_id: str):
        # Generated ids only; never let a caller turn this into a path lookup.
        if not re.fullmatch(r"\d+-[0-9a-f]{12}", media_id):
            raise HTTPException(404)
        for folder in ROOT.glob("????-??-??"):
            status_file = folder / media_id / "status.json"
            if status_file.exists():
                return json.loads(status_file.read_text())
            if any(p.is_file() for p in folder.glob(media_id + ".*")):
                return {"state": "processing"}
        raise HTTPException(404)
