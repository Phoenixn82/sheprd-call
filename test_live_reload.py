"""UI file watcher and data-channel checks without pipecat, network or service operations."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

import live_ui
import shown
from test_call_screen import bot


class SnapshotTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "world" / "games").mkdir(parents=True)
        for name, content in (("call.html", "<html>screen</html>"), ("world/world.js", "// world"),
                              ("world/style.css", "body {}"), ("world/games/run.js", "// game"),
                              ("bot.py", "# voice"), ("world/private.json", "private"),
                              ("world/preview.cjs", "private"), ("world/games/private.css", "private")):
            (self.root / name).write_text(content)

    async def test_allowlist_content_hash_and_voice_changes_are_not_updates(self):
        first = live_ui.snapshot(self.root)
        self.assertEqual(set(first["assets"]), {"world.js", "style.css", "games/run.js"})
        (self.root / "bot.py").write_text("# changed voice")
        self.assertEqual(live_ui.snapshot(self.root), first)
        for file in ("call.html", "world/world.js", "world/style.css", "world/games/run.js"):
            before = live_ui.snapshot(self.root)["revision"]
            path = self.root / file
            path.write_text(path.read_text() + " changed")
            self.assertNotEqual(live_ui.snapshot(self.root)["revision"], before, file)

    async def test_symlinks_and_unreadable_updates_are_refused(self):
        (self.root / "world" / "secret.js").symlink_to(self.root / "bot.py")
        with self.assertRaises(OSError):
            live_ui.snapshot(self.root)

    async def test_changes_settle_before_push_and_recover_after_partial_copy(self):
        scans = 0
        revision = live_ui.snapshot(self.root)["revision"]
        async def tick(_):
            nonlocal scans
            scans += 1
            if scans == 1:
                (self.root / "world/world.js").write_text("// intermediate copy")
            elif scans == 2:
                (self.root / "world/world.js").write_text("// complete copy")
            elif scans == 4:
                raise asyncio.CancelledError
        messages = []
        with patch.object(live_ui.asyncio, "sleep", side_effect=tick):
            with self.assertRaises(asyncio.CancelledError):
                async for message in live_ui.changes(self.root):
                    messages.append(message)
        self.assertEqual(messages, [{"type": "ui-update", "revision": revision},
                                    {"type": "ui-update", "revision": live_ui.snapshot(self.root)["revision"]}])
        sequence = [OSError("copy in progress"), {"revision": revision}, {"revision": "f" * 64}, {"revision": "f" * 64}]
        async def stop(_):
            if not sequence:
                raise asyncio.CancelledError
        def scan(_):
            item = sequence.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        messages = []
        with patch.object(live_ui, "snapshot", side_effect=scan), patch.object(live_ui.asyncio, "sleep", side_effect=stop), \
                patch.object(live_ui.logging, "exception"):
            with self.assertRaises(asyncio.CancelledError):
                async for message in live_ui.changes(self.root):
                    messages.append(message)
        self.assertEqual([m["revision"] for m in messages], [revision, "f" * 64])

    async def test_bot_pushes_updates_using_existing_transport(self):
        async def notices():
            yield {"type": "ui-update", "revision": "a" * 64}
        session = bot.ClaudeSession(None)
        session.push_frame = AsyncMock()
        with patch.object(live_ui, "changes", notices):
            await session._ui_updates()
        frame = session.push_frame.await_args.args[0]
        self.assertIsInstance(frame, bot.OutputTransportMessageUrgentFrame)
        self.assertEqual(frame.message, {"type": "ui-update", "revision": "a" * 64})

    async def test_watcher_starts_once_with_the_call_and_is_cancelled_on_cleanup(self):
        session = bot.ClaudeSession(Mock())
        tasks = {}
        def create(coro):
            tasks[coro.cr_code.co_name] = object()
            coro.close()  # no real stream, voice or model tasks in this check
            return tasks[coro.cr_code.co_name]
        session.create_task = Mock(side_effect=create)
        frame = bot.LLMContextFrame(context=Mock(get_messages=lambda: []))
        for _ in range(2):
            await session.process_frame(frame, bot.FrameDirection.DOWNSTREAM)
        self.assertEqual(session.create_task.call_count, 4)
        self.assertIs(session._ui, tasks["_ui_updates"])
        session.cancel_task = AsyncMock()
        with patch.object(bot.FrameProcessor, "cleanup", AsyncMock(), create=True):
            await session.cleanup()
        self.assertIn(session._ui, [call.args[0] for call in session.cancel_task.await_args_list])

    async def test_snapshot_routes_use_same_origin_guard_and_no_store_and_fail_closed(self):
        class Reply:
            def __init__(self, content=None, status_code=200, headers=None, **_):
                self.body = json.dumps(content).encode()
                self.headers, self.status_code = headers or {}, status_code
        class HTTPError(Exception):
            def __init__(self, status_code, detail=None):
                self.status_code = status_code
        responses = types.ModuleType("fastapi.responses")
        responses.FileResponse = responses.JSONResponse = responses.Response = responses.StreamingResponse = Reply
        fastapi = types.ModuleType("fastapi")
        fastapi.HTTPException, fastapi.Request = HTTPError, object
        handlers = {}
        class App:
            router = types.SimpleNamespace(lifespan_context=None)
            def get(self, path, **_):
                def register(fn):
                    handlers[path] = fn
                    return fn
                return register
            post = get
        with patch.dict(sys.modules, {"fastapi": fastapi, "fastapi.responses": responses, "aiohttp": types.ModuleType("aiohttp")}):
            shown.add_routes(App(), "http://unused.invalid")
        expected = live_ui.snapshot(self.root)
        with patch.object(live_ui, "snapshot", return_value=expected):
            response = await handlers["/api/ui"]()
            version = await handlers["/api/ui-version"]()
        ui = json.loads(response.body)
        self.assertEqual(ui, expected)
        self.assertEqual(json.loads(version.body), {"type": "ui-update", "revision": ui["revision"]})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(version.headers["Cache-Control"], "no-store")
        for path in ("/api/ui", "/api/ui-version"):
            self.assertTrue(shown.refuse("GET", path, {"host": "voice-host"}, "https"))
            self.assertFalse(shown.refuse("GET", path, {"host": "voice-host", "x-sheprd": "1"}, "https"))
            self.assertTrue(shown.refuse("GET", path, {"host": "voice-host", "x-sheprd": "1", "sec-fetch-site": "cross-site"}, "https"))
            with patch.object(live_ui, "snapshot", side_effect=OSError("partial copy")):
                with self.assertRaises(HTTPError) as caught:
                    await handlers[path]()
                self.assertEqual(caught.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
