"""Local-only media regression: python -m unittest test_media -v (FastAPI + httpx)."""
import ast
import asyncio
import datetime
import io
import json
import math
import os
import re
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI
import httpx
import media
import bridge


def bot_functions(*names, **namespace):
    """Exercise actual route/model glue without importing CUDA or the Pipecat voice pipeline."""
    tree = ast.parse(Path(__file__).with_name("bot.py").read_text())
    nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in names]
    if len(nodes) != len(names):
        raise AssertionError("Missing bot media integration")
    namespace.update(__file__=str(Path(__file__).with_name("bot.py")), Path=Path, re=re, json=json, os=os,
                     time=time, IDLE_SECS=180)  # bot.py's module imports and InUse's constant
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "bot.py", "exec"), namespace)
    return namespace


def bundle(entries=None, kind="video"):
    meta = {"id": "123456789-abcdef012345", "kind": kind, "duration": 130 if kind == "video" else 0,
            "frame_interval": 130 / 90 if kind == "video" else 0,
            "original": "/home/caller/.local/state/shepherd/uploads/2026-11-02/123456789-abcdef012345.mp4"}
    entries = entries if entries is not None else [("meta.json", json.dumps(meta).encode(), tarfile.REGTYPE),
              ("transcript.txt", b"[0.00-1.00] hi", tarfile.REGTYPE), ("frames/001.jpg", b"jpeg", tarfile.REGTYPE)]
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as tar:
        for name, data, kind in entries:
            item = tarfile.TarInfo(name); item.size = len(data); item.type = kind
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                item.linkname = "/tmp/outside"
            tar.addfile(item, io.BytesIO(data))
    return out.getvalue()


VOICE_HOST = "192.0.2.10"  # the one allowed caller (VOICE_ALLOWED), set per test


def post_bridge(body, caller=VOICE_HOST, length=None, headers=None):
    """media.py's own POST /media: a tar bundle, no browser headers (headers= adds or replaces some)."""
    handler = object.__new__(bridge.Desk)
    handler.client_address = (caller, 1234)
    handler.path = "/media"
    handler.headers = {"Content-Length": str(len(body) if length is None else length), "Content-Type": "application/x-tar",
                       "X-Sheprd": "1", **(headers or {})}
    handler.rfile = io.BytesIO(body)
    handler.send_response = Mock(); handler.send_error = Mock(); handler.end_headers = Mock()
    handler.do_POST()
    return handler


class VoiceHostTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patch = patch.object(media, "ROOT", self.root / "uploads"); self.patch.start(); self.addCleanup(self.patch.stop)
        self.deliver = patch.object(media, "deliver"); self.worker = self.deliver.start(); self.addCleanup(self.deliver.stop)
        self.app = FastAPI()
        ns = bot_functions("_with_call_page", "InUse", media_transcript=Mock(), DESK_URL="http://not-contacted")
        ns["_with_call_page"](lambda app: None)(self.app)
        # the call page's own requests (Guard refuses anything else): X-Sheprd, and the Origin a browser sends on a POST
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test",
                                        headers={"X-Sheprd": "1", "Origin": "http://test"})
        self.addAsyncCleanup(self.client.aclose)
        self.photo = self.root / "sample.jpg"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=size=32x24",
                        "-frames:v", "1", str(self.photo)], check=True)

    async def test_rejects_non_media(self):
        for content_type in ("text/plain", "image/jpeg", "video/mp4"):
            response = await self.client.post("/api/media", content=b"not media", headers={"Content-Type": content_type})
            self.assertEqual(response.status_code, 415)
        self.assertEqual(list(media.ROOT.rglob("*.*")), [])
        self.worker.assert_not_called()

    async def test_another_sites_upload_is_refused(self):
        body = self.photo.read_bytes()
        for origin in ("https://evil.example", "null", "http://test.evil.example", "https://test"):
            response = await self.client.post("/api/media", content=body,
                                              headers={"Content-Type": "image/jpeg", "Origin": origin})
            self.assertEqual(response.status_code, 403, origin)
        self.assertEqual(list(media.ROOT.rglob("*.*")), [])
        self.worker.assert_not_called()
        response = await self.client.post("/api/media", content=body,  # the page's own upload
                                          headers={"Content-Type": "image/jpeg", "Origin": "http://test"})
        self.assertEqual(response.status_code, 202)
        self.worker.assert_called_once()

    async def test_stores_server_named_file_and_returns_202(self):
        body = self.photo.read_bytes()
        response = await self.client.post("/api/media?name=../../bad.jpg", content=body,
                                          headers={"Content-Type": "image/jpeg"})
        self.assertEqual(response.status_code, 202)
        media_id = response.json()["id"]
        stored = media.ROOT / datetime.date.today().isoformat() / (media_id + ".jpg")
        self.assertEqual(stored.read_bytes(), body)
        self.assertRegex(media_id, r"^\d+-[0-9a-f]{12}$")
        self.worker.assert_called_once()
        self.assertEqual((await self.client.get("/api/media/" + media_id)).json()["state"], "processing")

    async def test_caps_stream_and_removes_partial(self):
        with patch.object(media, "MAX_UPLOAD", 5):
            async def stream():
                yield b"123"; yield b"456"
            response = await self.client.post("/api/media", content=stream(), headers={"Content-Type": "video/mp4"})
            self.assertEqual(response.status_code, 413)
            self.assertEqual(list(media.ROOT.rglob("*.*")), [])

    async def test_disconnect_removes_partial(self):
        async def stream():
            yield b"123"
            raise ConnectionError("gone")
        with self.assertRaises(ConnectionError):
            await self.client.post("/api/media", content=stream(), headers={"Content-Type": "video/mp4"})
        self.assertEqual(list(media.ROOT.rglob("*.*")), [])

    async def test_status_reports_delivery_failure(self):
        media_id = "123456789-abcdef012345"
        folder = media.ROOT / "2026-11-02" / media_id
        folder.mkdir(parents=True); (folder / "status.json").write_text('{"state":"error","detail":"offline"}')
        self.assertEqual((await self.client.get("/api/media/" + media_id)).json()["detail"], "offline")
        self.assertEqual((await self.client.get("/api/media/bad-id")).status_code, 404)


class ProcessingTest(unittest.TestCase):
    def test_whole_video_sampling(self):
        for duration in (10, 7200):
            with self.subTest(duration=duration):
                interval = media.frame_interval(duration)
                count = math.ceil(duration / interval)
                self.assertLessEqual(count, 90); self.assertLessEqual(1 / interval, 1)
                self.assertGreaterEqual(count * interval, duration)
        for duration in (0, -1, math.inf, math.nan):
            with self.assertRaises(ValueError):
                media.frame_interval(duration)

    def test_photo_and_silent_video_with_real_ffmpeg(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            photo = root / "photo.jpg"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=size=2400x1200",
                            "-frames:v", "1", str(photo)], check=True)
            transcribe = Mock()
            result = media.prepare(photo, "photo", media.probe(photo), transcribe)
            stream = media.probe(result / "frames/001.jpg")["streams"][0]
            self.assertEqual((stream["width"], stream["height"]), (2048, 1024))
            video = root / "video.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=32x24:rate=2",
                            "-t", "10", "-pix_fmt", "yuv420p", str(video)], check=True)
            result = media.prepare(video, "video", media.probe(video), transcribe)
            self.assertEqual(len(list((result / "frames").glob("*.jpg"))), 10)
            self.assertEqual((result / "transcript.txt").read_text(), "No audio track.\n")
            self.assertEqual(json.loads((result / "meta.json").read_text())["duration"], 10)
            transcribe.assert_not_called()

    def test_timestamped_transcription_reuses_loaded_model_without_vad(self):
        segment = Mock(start=0.25, end=2.5, text=" quiet speech ")
        model = Mock(); model.transcribe.return_value = ([segment], None)
        create = Mock(return_value=Mock(_model=model))  # create_stt hands back the process's one warm model
        ns = bot_functions("media_transcript", create_stt=create, STT_HINT="Herdr, Sheprd.")
        self.assertEqual(ns["media_transcript"](Path("clip.wav")), "[0.25–2.50] quiet speech\n")
        model.transcribe.assert_called_once_with("clip.wav", language="en", vad_filter=False,
                                                 initial_prompt="Herdr, Sheprd.")  # the call's word hint

    def test_audio_track_transcribed_and_wav_removed(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "video.mp4"; path.touch()
            def ffmpeg(path, *args):
                output = Path(args[-1].replace("%03d", "001")); output.touch()
            with patch.object(media, "run_ffmpeg", side_effect=ffmpeg):
                transcribe = Mock(return_value="[0.00–1.00] hello\n")
                result = media.prepare(path, "video", {"format": {"duration": "10"},
                    "streams": [{"codec_type": "video"}, {"codec_type": "audio"}]}, transcribe)
            self.assertEqual((result / "transcript.txt").read_text(), "[0.00–1.00] hello\n")
            self.assertFalse((result / "audio.wav").exists())
            transcribe.assert_called_once()


    def test_delivers_tar_with_content_length_and_records_success(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "123456789-abcdef012345.mp4"; path.touch()
            prepared = path.parent / path.stem
            (prepared / "frames").mkdir(parents=True)
            (prepared / "frames/001.jpg").write_bytes(b"jpeg")
            (prepared / "meta.json").write_text("{}")
            (prepared / "transcript.txt").write_text("No audio track.")
            def accept(request, timeout):
                self.assertEqual(request.full_url, "http://desk.invalid/media")
                self.assertEqual(int(request.get_header("Content-length")), path.with_suffix(".tar").stat().st_size)
                with tarfile.open(fileobj=request.data, mode="r:") as tar:
                    self.assertEqual(tar.getnames(), ["frames/001.jpg", "meta.json", "transcript.txt"])
                response = Mock(); response.__enter__ = Mock(return_value=Mock(status=202)); response.__exit__ = Mock()
                return response
            with patch.object(media, "prepare", return_value=prepared), \
                    patch.object(media.urllib.request, "urlopen", side_effect=accept) as deliver:
                media._deliver(path, "video", {}, Mock(), "http://desk.invalid")
            deliver.assert_called_once()
            self.assertEqual(json.loads((prepared / "status.json").read_text()), {"state": "sent"})
            self.assertFalse(path.with_suffix(".tar").exists())

    def test_delivery_error_is_visible_and_archive_removed(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "123456789-abcdef012345.mp4"; path.touch()
            with patch.object(media, "prepare", side_effect=ValueError("bad codec")):
                media._deliver(path, "video", {}, Mock(), "http://not-contacted")
            self.assertEqual(json.loads((path.parent / path.stem / "status.json").read_text()),
                             {"state": "error", "detail": "bad codec"})
            self.assertFalse(path.with_suffix(".tar").exists())


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "inbox"
        p = patch.object(bridge, "MEDIA_ROOT", self.root); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, "ALLOWED", {VOICE_HOST}); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, "ensure_desk", return_value={"agent_status": "working"}); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, "herdr", return_value={}); self.herdr = p.start(); self.addCleanup(p.stop)

    def test_rejects_unlisted_caller(self):
        request = post_bridge(bundle(), caller="127.0.0.1")
        request.send_error.assert_called_once_with(404); self.herdr.assert_not_called()
        self.assertFalse(self.root.exists())

    def test_rejects_browser_requests_and_other_types(self):
        for headers, status in (({"Origin": "https://evil.example"}, 403), ({"Sec-Fetch-Site": "same-site"}, 403),
                                ({"X-Sheprd": ""}, 403), ({"X-Sheprd": "0"}, 403),
                                ({"Sec-Fetch-Mode": "no-cors"}, 403), ({"Content-Type": "text/plain"}, 415),
                                ({"Content-Type": "multipart/form-data; boundary=x"}, 415),
                                ({"Content-Type": "application/json"}, 415)):
            with self.subTest(headers=headers):
                request = post_bridge(bundle(), headers=headers)
                request.send_error.assert_called_once_with(status)
        self.herdr.assert_not_called()
        self.assertFalse(self.root.exists())

    def test_rejects_unsafe_tar_entries(self):
        for name, kind in (("../bad", tarfile.REGTYPE), ("/tmp/bad", tarfile.REGTYPE),
                           ("frames/001.jpg", tarfile.SYMTYPE), ("frames/001.jpg", tarfile.LNKTYPE)):
            with self.subTest(name=name, kind=kind):
                request = post_bridge(bundle([(name, b"", kind)]))
                self.assertEqual(request.send_error.call_args.args[0], 400)
                self.assertEqual(list(self.root.iterdir()), [])
        self.herdr.assert_not_called()

    def test_extracts_and_prompts_exactly_once(self):
        request = post_bridge(bundle())
        request.send_response.assert_called_once_with(202)
        self.herdr.assert_called_once()
        prompt = self.herdr.call_args.args[3]
        folder = self.root / "123456789-abcdef012345"
        self.assertTrue((folder / "frames/001.jpg").exists())
        self.assertTrue((folder / "transcript.txt").exists())
        self.assertIn(str(folder / "frames"), prompt); self.assertIn("2m10s", prompt)
        self.assertIn("1.44 s", prompt); self.assertTrue(prompt.startswith("[phone] The caller just shared"))
        self.assertIn("The original is on the voice host at /home/caller/", prompt)

    def test_photo_names_one_image(self):
        request = post_bridge(bundle(kind="photo"))
        request.send_response.assert_called_once_with(202)
        self.assertIn(str(self.root / "123456789-abcdef012345/frames/001.jpg"), self.herdr.call_args.args[3])

    def test_duplicate_cannot_prompt_twice(self):
        post_bridge(bundle()); request = post_bridge(bundle())
        request.send_error.assert_called_once_with(409, "Media already received")
        self.herdr.assert_called_once()

    def test_caps_and_truncation(self):
        request = post_bridge(bundle(), length=media.MAX_BUNDLE + 1)
        self.assertEqual(request.send_error.call_args.args[0], 400)
        request = post_bridge(bundle()[:600], length=1000)
        self.assertEqual(request.send_error.call_args.args[0], 400)
        self.herdr.assert_not_called()


if __name__ == "__main__":
    unittest.main()
