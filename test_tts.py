"""On the voice host: ../.venv/bin/python -m pytest -q test_tts.py. Real Kokoro through pipecat's test pipeline: a line the
call speaks (pronounce() applied) produces audio, and a synthesis slower than pipecat's 3 s context timeout (a busy
host, 2026-11-07) still plays with no "completed with no audio" error, which the stock service raises."""

import asyncio
import unittest

from pipecat.frames.frames import ErrorFrame, TTSAudioRawFrame, TTSSpeakFrame, TTSStoppedFrame
from pipecat.services.kokoro.tts import KokoroTTSService
from pipecat.tests.utils import SleepFrame, run_test

import bot

LINE = "Sheprd here. Hey, it's your desk. What's up?"
SLOW = 4.0  # seconds before the first audio: past the stock 3 s timeout


def slow(cls):
    class Slow(cls):
        async def run_tts(self, text, context_id):
            await asyncio.sleep(SLOW)
            async for frame in super().run_tts(text, context_id):
                yield frame
    return Slow


def make(cls):
    return cls(settings=KokoroTTSService.Settings(voice="af_heart", speed=bot.SPEED))


async def speak(tts, wait):
    down, up = await run_test(tts, frames_to_send=[TTSSpeakFrame(bot.pronounce(LINE)), SleepFrame(sleep=wait)])
    audio = b"".join(f.audio for f in down if isinstance(f, TTSAudioRawFrame))
    rate = next((f.sample_rate for f in down if isinstance(f, TTSAudioRawFrame)), 1)
    errors = [str(f.error) for f in [*down, *up] if isinstance(f, ErrorFrame)]
    stops = [i for i, f in enumerate(down) if isinstance(f, TTSStoppedFrame)]
    first_audio = next((i for i, f in enumerate(down) if isinstance(f, TTSAudioRawFrame)), None)
    return len(audio) / (2 * rate), errors, stops, first_audio


class CallVoiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_real_line_produces_audio(self):
        self.assertEqual(bot.pronounce(LINE), "Shepherd here. Hey, it's your desk. What's up?")
        seconds, errors, stops, _ = await speak(bot.create_tts(), 10)
        self.assertIsInstance(bot.create_tts(), bot.CallTTS)
        self.assertGreater(seconds, 1.0)
        self.assertEqual(errors, [])
        self.assertEqual(len(stops), 1)

    async def test_slow_first_audio_still_plays_without_an_error(self):
        seconds, errors, stops, first_audio = await speak(make(slow(bot.CallTTS)), SLOW + 10)
        self.assertGreater(seconds, 1.0)
        self.assertEqual(errors, [])
        self.assertEqual(len(stops), 1)
        self.assertGreater(stops[0], first_audio)  # the stop frame comes after the audio, not before it

    async def test_the_stock_service_calls_the_same_slow_line_silent(self):  # the root cause; guards the override
        _, errors, stops, first_audio = await speak(make(slow(KokoroTTSService)), SLOW + 10)
        self.assertTrue(any("completed with no audio" in e for e in errors), errors)
        self.assertLess(stops[0], first_audio)


if __name__ == "__main__":
    unittest.main()
