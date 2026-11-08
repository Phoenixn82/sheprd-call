"""The call stays up while Sheprd is on his screen (2026-11-07, "You kicked me off of the app"): pipecat's idle timeout
ends a call only while the page is hidden (a real PipelineWorker and WorkerRunner, idle timeout shortened), and a live
screen update applies in a real browser instead of failing and retrying forever (test_live_swap.cjs, Chromium).
Run: python3 -m unittest test_call_alive -v   (the idle test needs pipecat: without it, conftest.py runs it on the voice host)"""

import asyncio
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent

try:
    import pipecat  # noqa: F401
except ImportError:
    pipecat = None


@unittest.skipIf(pipecat is None, "no pipecat here: RemoteIdleTest runs this on the voice host")
class IdleTest(unittest.TestCase):
    IDLE = 0.3

    def call(self, hidden):
        """Runs a call's worker with nobody speaking for 6 idle periods; True if it ended itself."""
        import bot
        from pipecat.frames.frames import Frame
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.processors.frame_processor import FrameProcessor
        from pipecat.workers.runner import WorkerRunner

        class Pass(FrameProcessor):
            async def process_frame(self, frame: Frame, direction):
                await super().process_frame(frame, direction)
                await self.push_frame(frame, direction)

        async def run():
            page = bot.PageSeen()
            if hidden:
                page.report({"type": "page-audio", "reason": "hidden"})
            runner = WorkerRunner(handle_sigint=False)
            await runner.add_workers(bot.call_worker(Pipeline([Pass()]), self.IDLE, page, lambda: runner.cancel(reason="t")))
            task = asyncio.create_task(runner.run())
            done, _ = await asyncio.wait([task], timeout=self.IDLE * 6)
            if not done:
                await runner.cancel(reason="test over")
                await asyncio.wait_for(task, 10)
            return bool(done)

        return asyncio.run(run())

    def test_open_page_keeps_a_quiet_call_up(self):
        self.assertFalse(self.call(hidden=False))

    def test_hidden_page_ends_a_quiet_call(self):
        self.assertTrue(self.call(hidden=True))

    def test_page_reports(self):
        import bot
        page = bot.PageSeen()
        self.assertFalse(page.hidden)
        for message, hidden in (({"reason": "hidden"}, True), ({"reason": "back in the app", "visible": True}, False),
                                ({"reason": "playout stalled: before", "visible": False}, True), ({"reason": "x"}, True),
                                ({"reason": "back in the app +5s", "visible": True}, False)):
            page.report(message)
            self.assertEqual(page.hidden, hidden, message)


@unittest.skipIf(pipecat is not None, "pipecat is here: IdleTest runs in this process")
class RemoteIdleTest(unittest.TestCase):
    def test_on_voice_host(self):  # conftest.py's transport: pytest without pipecat runs the same tests in the voice host's venv
        p = subprocess.run(["python3", "-m", "pytest", "-p", "no:cacheprovider", "-q", "test_call_alive.py::IdleTest"],
                           capture_output=True, text=True, timeout=900, cwd=HERE)
        print(p.stdout[-600:])
        self.assertEqual(p.returncode, 0, p.stdout[-3000:] + p.stderr[-2000:])
        self.assertIn("3 passed", p.stdout)


class LiveSwapTest(unittest.TestCase):
    def test_screen_update_applies_in_a_real_browser(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = subprocess.run(["node", str(HERE / "test_live_swap.cjs")], capture_output=True, text=True, timeout=120, cwd=tmp)
        print(p.stdout[-800:])
        self.assertEqual(p.returncode, 0, p.stdout[-2000:] + p.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()
