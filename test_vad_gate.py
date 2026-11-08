"""On the voice host: ../.venv/bin/python -m unittest test_vad_gate -v. Real Silero VAD with bot.vad_params(): a Kokoro voice
at close-talk level must start a turn; the same voice at two-feet level, and quiet room noise, must not."""

import asyncio
import unittest

import numpy as np
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADState

import bot
from call_test import speak

RATE = 16000
CLOSE_DBFS, FAR_DBFS = -26, -42  # phone a hand's width from his mouth vs. a voice two feet off, no auto gain


def at(pcm, dbfs):
    x = pcm.astype(np.float32) / 32768
    x *= 10 ** (dbfs / 20) / np.sqrt(np.mean(x[np.abs(x) > 0.01] ** 2))  # level of the voiced part
    silence = np.zeros(RATE // 2, np.float32)
    return (np.clip(np.concatenate([silence, x, silence]), -1, 1) * 32767).astype(np.int16).tobytes()


async def starts_speech(audio):
    vad = SileroVADAnalyzer(params=bot.vad_params())
    vad.set_sample_rate(RATE)
    step = vad.num_frames_required() * 2
    for i in range(0, len(audio) - step, step):
        if await vad.analyze_audio(audio[i:i + step]) == VADState.SPEAKING:
            return True
    return False


class GateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.voice = speak("Hey BMO, what is on my list today?")[::3]  # 48 kHz to 16 kHz

    def test_close_voice_counts(self):
        self.assertTrue(asyncio.run(starts_speech(at(self.voice, CLOSE_DBFS))))

    def test_voice_two_feet_off_does_not(self):
        self.assertFalse(asyncio.run(starts_speech(at(self.voice, FAR_DBFS))))

    def test_room_noise_does_not(self):
        noise = np.random.default_rng(1).normal(0, 1, RATE * 2).astype(np.float32) * 32767
        self.assertFalse(asyncio.run(starts_speech(at(noise.astype(np.int16), -45))))


if __name__ == "__main__":
    unittest.main()
