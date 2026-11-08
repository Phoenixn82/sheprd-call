"""Restart safety without pipecat, models or network: bot.InUse's live in-use answer, a real uvicorn stop with an open
stream (fast with bot.STOP_GRACE, hung without it), and ship's voice-host check/restart script against stub
systemctl/curl/journalctl. Run: uv run --no-project --with fastapi --with uvicorn --with httpx python -m unittest test_restart"""

import ast
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import types
import unittest
import urllib.request

HERE = Path(__file__).parent
SOURCE = (HERE / "bot.py").read_text()


# InUse and its two settings, as source: loaded here and in the stop test's server process
CODE = ast.unparse([n for n in ast.parse(SOURCE).body if isinstance(n, ast.ClassDef) and n.name == "InUse"
                    or isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") in ("STOP_GRACE", "IDLE_SECS")])


def load_in_use():
    namespace = {"json": json, "os": os, "time": time}
    exec(CODE, namespace)
    return types.SimpleNamespace(**namespace)


bot = load_in_use()


class InUseStateTest(unittest.TestCase):
    def setUp(self):
        bot.InUse.calls, bot.InUse.open, bot.InUse.ended, bot.InUse.page = 0, 0, None, None

    def test_fresh_service_is_idle(self):
        self.assertTrue(bot.InUse.state()["idle"])

    def test_a_call_an_open_request_or_recent_use_is_in_use(self):
        now = 10_000.0
        for field, value in (("calls", 1), ("open", 1), ("ended", now - 179), ("page", now - 5)):
            self.setUp()
            setattr(bot.InUse, field, value)
            self.assertFalse(bot.InUse.state(now)["idle"], field)
        self.setUp()
        bot.InUse.ended = bot.InUse.page = now - bot.IDLE_SECS
        self.assertEqual(bot.IDLE_SECS, 180)
        self.assertTrue(bot.InUse.state(now)["idle"])

    def test_bot_counts_calls_and_wires_the_middleware_and_stop_grace(self):
        body = SOURCE.split("async def bot(", 1)[1].split("\ndef ", 1)[0]
        self.assertRegex(body, r"InUse\.calls \+= 1\b.*\n\s+try:")
        self.assertRegex(body, r"finally:\s+InUse\.calls -= 1\s+InUse\.ended = time\.time\(\)")
        self.assertRegex(SOURCE, r"app\.add_middleware\(InUse\)\s+app\.add_middleware\(Guard\)")  # Guard outermost
        self.assertIn("uvicorn.run = partial(uvicorn.run, timeout_graceful_shutdown=STOP_GRACE)", SOURCE)
        self.assertLessEqual(bot.STOP_GRACE, 5)
        for name in ("deploy/shepherd-voice.service", "voice-call.service"):  # the public unit, and his own when present
            if name == "deploy/shepherd-voice.service" or (HERE / name).exists():
                unit = (HERE / name).read_text()
                self.assertEqual(re.findall(r"^TimeoutStopSec=(\d+)$", unit, re.M), ["15"], name)


SERVER = """
import asyncio, json, sys, time
from functools import partial
import uvicorn
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
ns = {"json": json, "os": __import__("os"), "time": time}
exec(sys.argv[1], ns)
InUse = ns["InUse"]
app = FastAPI()
async def forever():
    while True:
        yield b"."
        await asyncio.sleep(0.2)
@app.get("/api/events")
async def events():
    return StreamingResponse(forever())
app.add_middleware(InUse)
run = partial(uvicorn.run, timeout_graceful_shutdown=ns["STOP_GRACE"]) if sys.argv[3] == "grace" else uvicorn.run
run(app, host="127.0.0.1", port=int(sys.argv[2]), log_level="warning")
"""


class StopTest(unittest.TestCase):
    """systemd sends SIGTERM; the page's event stream is open (as when he has Sheprd up)."""

    def stop_seconds(self, mode, wait):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        proc = subprocess.Popen([sys.executable, "-c", SERVER, CODE, str(port), mode])
        self.addCleanup(proc.kill)
        url = f"http://127.0.0.1:{port}"
        for _ in range(100):
            try:
                urllib.request.urlopen(url + "/api/in-use", timeout=1).read()
                break
            except OSError:
                time.sleep(0.1)
        stream = urllib.request.urlopen(url + "/api/events", timeout=5)
        stream.read(1)
        state = json.loads(urllib.request.urlopen(url + "/api/in-use", timeout=2).read())
        self.assertEqual((state["open"], state["idle"]), (1, False), state)  # the open page holds a restart off
        start = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=wait)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            return None
        finally:
            stream.close()
        return time.monotonic() - start

    def test_stop_with_an_open_stream_finishes_within_seconds(self):
        took = self.stop_seconds("grace", 10)
        self.assertIsNotNone(took, "still running 10 s after SIGTERM")
        self.assertLess(took, bot.STOP_GRACE + 3)

    def test_without_the_grace_the_stop_hangs(self):  # the 2026-11-07 root cause, so the test above means something
        self.assertIsNone(self.stop_seconds("plain", bot.STOP_GRACE + 4))


@unittest.skipUnless((HERE / "ship").exists(), "ship is the private deploy helper")
class ShipRemoteTest(unittest.TestCase):
    """ship's voice-host script (its heredoc), with stub systemctl/curl/journalctl on PATH."""

    def run_remote(self, mode, *, active=True, answer='{"idle": true}', journal=""):
        script = re.search(r"<<'EOF'\n(.*?)\nEOF\n", (HERE / "ship").read_text(), re.S).group(1)
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(subprocess.run, ["rm", "-rf", str(tmp)])
        log = tmp / "calls.log"
        stubs = {
            "systemctl": f'echo "systemctl $*" >> {log}; [ "$3" = is-active ] && exit {0 if active else 3}; exit 0',
            "curl": f'echo "curl $*" >> {log}; ' + (f"echo '{answer}'" if answer else "exit 7"),
            "journalctl": f"printf '%s' '{journal}'",
        }
        for name, body in stubs.items():
            (tmp / name).write_text("#!/bin/bash\n" + body + "\n")
            (tmp / name).chmod(0o755)
        env = {**os.environ, "PATH": f"{tmp}:{os.environ['PATH']}", "HOME": str(tmp)}
        done = subprocess.run(["bash", "-s", mode, "192.0.2.1"], input=script, env=env, capture_output=True,
                              text=True, timeout=30)
        calls = log.read_text() if log.exists() else ""
        return done.returncode, done.stdout, calls

    def test_check_says_idle_or_refuses(self):
        self.assertEqual(self.run_remote("check")[0], 0)
        self.assertEqual(self.run_remote("check", answer='{"idle": false, "calls": 1}')[0], 3)
        self.assertEqual(self.run_remote("check", answer="")[0], 3)  # running but silent: fail closed
        self.assertEqual(self.run_remote("check", answer="not json")[0], 3)
        self.assertEqual(self.run_remote("check", active=False)[0], 0)  # down: nothing to interrupt

    def test_restart_only_when_idle_and_fails_on_a_killed_stop(self):
        rc, out, calls = self.run_remote("restart", answer='{"idle": false, "calls": 1}')
        self.assertEqual(rc, 3)
        self.assertNotIn("restart voice-call", calls)
        rc, out, calls = self.run_remote("restart")
        self.assertEqual(rc, 0, out)
        self.assertIn("restart voice-call", calls)
        self.assertRegex(out, r"restart took \d+\.\d s")
        rc, out, _ = self.run_remote("restart", journal="voice-call.service: Killing process 1 (python) with signal SIGKILL.")
        self.assertEqual(rc, 1, out)


if __name__ == "__main__":
    unittest.main()
