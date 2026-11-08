"""On the voice host: ../.venv/bin/python -m unittest test_stt -v."""

import subprocess
import unittest
from unittest.mock import patch

import bot


class STTTest(unittest.TestCase):
    def setUp(self):
        bot.stt_config.cache_clear()
        self.addCleanup(bot.stt_config.cache_clear)

    def test_cuda_probe_is_cached(self):
        with patch.object(bot, "STT_DEVICE", "cuda"), patch.object(bot, "STT_COMPUTE", "float16"), \
                patch.object(bot.subprocess, "run") as probe:
            self.assertEqual(bot.stt_config(), ("cuda", "float16"))
            self.assertEqual(bot.stt_config(), ("cuda", "float16"))
            self.assertEqual(probe.call_count, 1)

    def test_native_abort_and_timeout_fall_back(self):
        for error in (subprocess.CalledProcessError(-6, "probe", stderr="missing cuDNN"),
                      subprocess.TimeoutExpired("probe", 60)):
            with self.subTest(error=error), patch.object(bot, "STT_DEVICE", "cuda"), \
                    patch.object(bot.subprocess, "run", side_effect=error):
                bot.stt_config.cache_clear()
                self.assertEqual(bot.stt_config(), ("cpu", "int8"))

    def test_cpu_skips_cuda_probe(self):
        with patch.object(bot, "STT_DEVICE", "cpu"), patch.object(bot, "STT_COMPUTE", "int8"), \
                patch.object(bot.subprocess, "run") as probe:
            self.assertEqual(bot.stt_config(), ("cpu", "int8"))
            probe.assert_not_called()

    def test_model_init_failure_retries_cpu(self):
        with patch.object(bot, "stt_config", return_value=("cuda", "float16")), \
                patch.object(bot, "CallSTT") as service:
            service.side_effect = [RuntimeError("CUDA out of memory"), "cpu service"]
            self.assertEqual(bot.create_stt(), "cpu service")
            self.assertEqual(service.call_args.kwargs["device"], "cpu")
            self.assertEqual(service.call_args.kwargs["compute_type"], "int8")
            # a turn waits for its last segment's words (1.0 s default split two-segment turns, 2026-11-07)
            self.assertEqual([c.kwargs["ttfs_p99_latency"] for c in service.call_args_list], [bot.STT_P99] * 2)
            self.assertGreater(bot.STT_P99, bot.vad_params().stop_secs + 2.3)

    def test_cpu_failure_is_not_hidden(self):
        with patch.object(bot, "stt_config", return_value=("cpu", "int8")), \
                patch.object(bot, "CallSTT", side_effect=RuntimeError("bad model")):
            with self.assertRaisesRegex(RuntimeError, "bad model"):
                bot.create_stt()

    def test_calls_share_one_model(self):
        with patch.dict(bot.MODELS, clear=True), patch("faster_whisper.WhisperModel", side_effect=lambda *a, **k: object()) as load:
            first = bot.whisper("m", "cuda", "int8")
            self.assertIs(bot.whisper("m", "cuda", "int8"), first)
            self.assertIsNot(bot.whisper("m", "cpu", "int8"), first)
            self.assertEqual(load.call_count, 2)

    def test_gpu_failure_retries_turn_on_cpu_and_keeps_audio(self):
        import asyncio
        import tempfile
        from pathlib import Path

        calls = []

        class Model:
            def __init__(self, device):
                self.device = device

            def transcribe(self, audio, **kw):
                calls.append((self.device, kw["condition_on_previous_text"]))
                if self.device == "cuda":
                    raise RuntimeError("CUDA failed with error out of memory")
                seg = type("S", (), {"text": " open the build bot " + "the build bot " * 5, "no_speech_prob": 0.1})
                return [seg], None

        stt = bot.CallSTT.__new__(bot.CallSTT)  # no model load
        stt._device, stt._compute_type, stt._model = "cuda", "float16", Model("cuda")
        stt._settings = bot.WhisperSTTService.Settings(model="m", initial_prompt="p", no_speech_prob=0.4, language="en")
        stt._user_id = ""
        stt.start_processing_metrics = stt.stop_processing_metrics = lambda: asyncio.sleep(0)
        alarms = []

        async def alarm(text, spoken):
            alarms.append((text, spoken))
        stt.alarm = alarm
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(bot.CallSTT, "sample_rate", 16000), \
                patch.dict(bot.MODELS, clear=True), \
                patch("faster_whisper.WhisperModel", side_effect=lambda *a, **k: Model("cpu")) as cpu_model:
            stt.record = Path(tmp) / "call"

            async def run():
                return [f async for f in stt.run_stt(b"\0\0" * 1600)]
            frames = asyncio.run(run())
            self.assertEqual([f.text for f in frames], ["open the build bot"])  # the runaway repeat collapsed
            self.assertEqual(calls, [("cuda", False), ("cpu", False)])
            self.assertEqual(cpu_model.call_args.kwargs, {"device": "cpu", "compute_type": "int8"})
            asyncio.run(run())  # the next turn tries the GPU again (2026-11-07: it stayed on a starved CPU all call)
            self.assertEqual(calls[2:], [("cuda", False), ("cpu", False)])
            self.assertEqual(cpu_model.call_count, 1)  # one CPU copy, loaded once
            alarms.pop()
            self.assertEqual(len(alarms), 1)
            self.assertFalse(alarms[0][1])  # words got through: nothing spoken
            self.assertEqual((stt.record / "000.live").read_text(), "open the build bot")
            self.assertTrue((stt.record / "000.wav").exists())


if __name__ == "__main__":
    unittest.main()
