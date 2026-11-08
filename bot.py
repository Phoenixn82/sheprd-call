"""Sheprd's voice: a Pipecat bot the caller talks to from the call page on their phone.

The voice host does the voice (Whisper on CUDA, Silero VAD and Kokoro on CPU); the brain is the day's desk behind the
bridge (bridge.py): a live Claude Code session in a Herdr tab. Every completed turn the caller says is typed
into it, and whatever it writes while the call is on is spoken (2026-11-02: "talk to a session" on the desk machine).

Run: python bot.py -t webrtc --host 127.0.0.1 --port 7862   (deploy/shepherd-voice.service does this)
Page: https://<host>/call behind `tailscale serve` (the mic needs HTTPS; ?auto starts the call)
"""

import asyncio
import datetime
import json
import os
import re
import subprocess
import sys
import time
import threading
import wave
from functools import cache, partial
from pathlib import Path

# The call's Whisper keeps the VRAM it peaks at (CTranslate2's caching allocator, warmed at startup by warm_stt), so a
# loaded Ollama model counts it as used and cannot take it. 2026-11-07: a 35B load left GPU 1 1.4 GiB free, turns
# OOM'd onto a CPU starved by tuning jobs (15-16 s a turn). 1080 Ti, 47 s turn: holds 2.5 GiB, peaks 2.7 (default
# allocator: holds 1.2, peaks 1.4, and gives the 0.3 GiB working memory back between turns). Set before ctranslate2 loads.
os.environ.setdefault("CT2_CUDA_ALLOCATOR", "cub_caching")
os.environ.setdefault("CT2_CUDA_CACHING_ALLOCATOR_CONFIG", "4,3,12,3221225472")  # keep up to 3 GiB cached

import aiohttp
import numpy as np
from shown import CLIENT, PANE, DisplayText, card_id, speakable
from stt_eval import DECODE, PROMPT, unloop
from loguru import logger

from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    BotStartedSpeakingFrame, BotStoppedSpeakingFrame, InputAudioRawFrame, InterruptionFrame, LLMContextFrame, LLMRunFrame, StartFrame,
    OutputTransportMessageUrgentFrame, TranscriptionFrame, TTSAudioRawFrame, TTSSpeakFrame, TTSStartedFrame,
    UserStartedSpeakingFrame, UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.user_start import VADUserTurnStartStrategy, TranscriptionUserTurnStartStrategy
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.kokoro.tts import KokoroTTSService
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.utils.time import time_now_iso8601
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.workers.runner import WorkerRunner

# The call voice is Kokoro af_heart (2026-11-03: a Piper voice tried before was hard to understand). "piper:<id>"
# loads <id>.onnx from VOICE_PIPER_DIR (e.g. VOICE_TTS=piper:en_US-lessac-medium).
VOICE = os.environ.get("VOICE_TTS", "af_heart")
PIPER_DIR = Path(os.environ.get("VOICE_PIPER_DIR", "~/.local/share/shepherd/voices")).expanduser()
SPEED = float(os.environ.get("VOICE_TTS_SPEED", "1.3"))  # 2026-11-02: "you talk really slow"; 2026-11-05: 1.5 "way too fast", "find a middle ground"
# 2026-11-05 stt_eval.py on the voice host (66 clips incl. two 60-90 s turns, GPU 1 int8): large-v3-turbo with his vocabulary
# as the prompt 3.4% WER, 390 ms median; distil-small.en (before) 25.8% with its loops; small.en dropped the first
# 90 words of a long turn (13.6%); parakeet-tdt v2/v3 6.5-6.9%. A prompt breaks distil models. stt_eval_results.md.
WHISPER = os.environ.get("VOICE_WHISPER", "large-v3-turbo")
STT_HINT = os.environ.get("VOICE_STT_HINT", PROMPT) or None  # VOICE_STT_HINT= (empty) turns it off
# each call's saved turns, for recheck.py (kept KEEP_DAYS there)
CALLS = Path(os.environ.get("VOICE_CALLS_DIR") or Path(os.environ.get("VOICE_STATE", "~/.local/state/shepherd")) / "calls").expanduser()
STT_DEVICE = os.environ.get("VOICE_STT_DEVICE", "cuda")
STT_COMPUTE = os.environ.get("VOICE_STT_COMPUTE", "int8")  # int8 runs on any CUDA card; older ones lack fast float16
DESK_URL = os.environ.get("VOICE_SESSION_URL", "http://127.0.0.1:7863")  # the bridge (bridge.py)

QUIET_GRACE = float(os.environ.get("VOICE_QUIET_GRACE", "0.6"))
TURN_SILENCE = float(os.environ.get("VOICE_TURN_SILENCE", "1.2"))
TURN_STOP_TIMEOUT = 12.0  # pipecat's 5 s split a turn whose words took longer; a GPU-OOM turn on CPU takes ~6-10 s
# Seconds from the end of his speech to the last segment's words: VAD's 0.8 s stop, then Whisper (0.7 s a turn on GPU 1
# under a 35B Ollama load and a 6-core hog, 2.3 s for a 47 s turn). pipecat's 1.0 s default ended a two-segment turn
# before the second segment's words came back, so they opened a turn of their own (2026-11-07 19:25). The last
# segment's words are finalized and end the turn at once, so this wait only covers a transcript that never comes.
STT_P99 = 4.0
NOTE_TTL = 60  # a cut-in note rides on his next turn within this many seconds, else it is dropped
QUESTION_HOLD = float(os.environ.get("VOICE_QUESTION_HOLD", "3.0"))  # quiet after a spoken question before more speech
MUTE_MAX = 300  # ponytail: stale-text drop ends after this even if the desk never shows reading his turn
# Near-field gate (2026-11-04: hear him up close, not background sounds or someone a couple of feet away).
# Speech counts only above this smoothed loudness (0..1 maps -110..-10 LUFS: 0.72 is -38 LUFS; close talk without
# auto gain sits near -26, a voice two feet off near -42) for at least 0.25 s. The one calibration knob: lower it if
# Sheprd misses him, raise it if it still hears the room. test_vad_gate.py checks the split.
NEAR_FIELD = float(os.environ.get("VOICE_VAD_MIN_VOLUME", "0.72"))


START_SECS = float(os.environ.get("VOICE_VAD_START_SECS", "0.25"))
# A stop waits this long for open requests (the page's /api/events stream never ends, a call's offer request runs the
# whole call), then cancels them: 2026-11-07 uvicorn waited on them until systemd's SIGKILL 90 s later.
STOP_GRACE = 3
IDLE_SECS = 180  # a restart waits for three minutes with no call and no page request (the page polls every 3 s)


class InUse:
    """Whether Sheprd is in use, live, for the restart helper (`ship`): calls running now, when the last one ended,
    and when the page last asked for anything. ASGI middleware inside Guard, so only the page's own requests count;
    it answers GET /api/in-use itself (2026-11-07: a deploy restarted the service while he had the page open)."""

    calls = 0
    open = 0  # page requests in flight (the events stream stays open while the page is)
    ended = page = None  # time.time() of the last call end / page request

    def __init__(self, app):
        self.app = app

    @classmethod
    def state(cls, now=None):
        now = time.time() if now is None else now
        since = {k: None if t is None else round(now - t, 1) for k, t in (("since_end", cls.ended), ("since_page", cls.page))}
        idle = cls.calls == 0 and cls.open == 0 and all(s is None or s >= IDLE_SECS for s in since.values())
        return {"idle": idle, "calls": cls.calls, "open": cls.open, **since, "pid": os.getpid()}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if scope["path"] == "/api/in-use":
            await send({"type": "http.response.start", "status": 200, "headers": [
                (b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
            return await send({"type": "http.response.body", "body": json.dumps(InUse.state()).encode()})
        InUse.page, InUse.open = time.time(), InUse.open + 1
        try:
            await self.app(scope, receive, send)
        finally:
            InUse.page, InUse.open = time.time(), InUse.open - 1


def vad_params():
    return VADParams(
        start_secs=START_SECS,
        stop_secs=float(os.environ.get("VOICE_VAD_STOP_SECS", "0.8")),
        confidence=float(os.environ.get("VOICE_VAD_CONFIDENCE", "0.7")),
        min_volume=NEAR_FIELD,
    )


@cache
def stt_config():
    """Probe once at startup: missing CUDA libraries can abort native code, beyond try/except."""
    if STT_DEVICE != "cpu":
        try:
            subprocess.run([
                sys.executable, "-c",
                "import sys, numpy as np; from faster_whisper import WhisperModel; "
                "m = WhisperModel(sys.argv[1], device=sys.argv[2], compute_type=sys.argv[3]); "
                "list(m.transcribe(np.zeros(16000, dtype=np.float32), language='en')[0])",
                WHISPER, STT_DEVICE, STT_COMPUTE,
            ], check=True, capture_output=True, text=True, timeout=60)
        except (subprocess.SubprocessError, OSError) as error:
            logger.warning("Whisper CUDA startup failed: {}; {}; falling back to cpu/int8",
                           error, getattr(error, "stderr", ""))
            return "cpu", "int8"
    logger.info("Whisper STT: {}/{}", STT_DEVICE, STT_COMPUTE)
    return STT_DEVICE, STT_COMPUTE


MODELS = {}  # (model, device, compute) -> WhisperModel: one copy per process for every call and media upload
MODELS_LOCK = threading.Lock()


def whisper(name, device, compute):
    """The process's one Whisper per device. Each call used to load its own (8 s at call start, and finished calls'
    copies stayed in VRAM: 4 GiB on GPU 1 on 2026-11-07)."""
    with MODELS_LOCK:
        if (name, device, compute) not in MODELS:
            from faster_whisper import WhisperModel
            MODELS[name, device, compute] = WhisperModel(name, device=device, compute_type=compute)
        return MODELS[name, device, compute]


def warm_stt():
    """Load the call's Whisper and run one 30 s window so the caching allocator holds its peak before any call."""
    noise = np.random.default_rng(0).normal(0, 0.05, 16000 * 30).astype(np.float32)
    try:
        list(create_stt()._model.transcribe(noise, language="en", vad_filter=False)[0])
    except Exception as error:  # a call still loads (or falls back) on its own; never block the service start
        return logger.warning("Whisper warm-up failed: {}", error)
    logger.info("Whisper STT warm")


class CallSTT(WhisperSTTService):
    """The call's Whisper, words verbatim (punctuation only). A GPU failure (2026-11-05 19:03 and 2026-11-07 18:02: a
    loaded Ollama model left the card no memory) retries that turn on CPU int8 instead of dropping his words; the next
    turn tries the GPU again (it used to stay on CPU for the rest of the call, 15-16 s a turn with tuning jobs running).
    Any failure logs `STT ALARM` (for a journal probe). With `record` set, each turn's audio and the words heard live
    are kept as record/NNN.wav + NNN.live for recheck.py, even when transcription failed."""

    record = None
    alarm = None  # async (text, spoken) -> None, set by run_bot

    def _load(self):
        self._model = whisper(self._settings.model, self._device, self._compute_type)
        if unsupported := self._unsupported_language():
            raise ValueError(unsupported)

    def _words(self, pcm, model=None):
        """pipecat's transcription with the call's decode (stt_eval.DECODE) and runaway repeats collapsed."""
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        segments, _ = (model or self._model).transcribe(audio, initial_prompt=self._settings.initial_prompt, **DECODE)
        return unloop(" ".join(s.text.strip() for s in segments if s.no_speech_prob < self._settings.no_speech_prob))

    async def run_stt(self, audio):
        await self.start_processing_metrics()
        text, failure = "", None
        try:
            try:
                text = await asyncio.to_thread(self._words, audio)
            except Exception as error:
                if self._device == "cpu":
                    raise
                failure = f"GPU transcription failed ({error}); that turn ran on CPU int8, the next tries the GPU again"
                cpu = await asyncio.to_thread(whisper, self._settings.model, "cpu", "int8")
                text = await asyncio.to_thread(self._words, audio, cpu)
        except Exception as error:
            failure = f"transcription failed on CPU too ({error}); that turn never reached the desk"
            raise
        finally:
            await self.stop_processing_metrics()
            if failure and self.alarm:
                await self.alarm(failure, spoken=not text)
            if self.record:
                save_turn(self.record, audio, self.sample_rate, text)
        if text:
            logger.debug(f"Transcription: [{text}]")
            yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), self._settings.language)


def save_turn(folder, pcm, rate, heard):
    folder.mkdir(parents=True, exist_ok=True)
    n = len(list(folder.glob("*.wav")))
    with wave.open(str(folder / f"{n:03d}.wav"), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(rate)
        w.writeframes(pcm)
    (folder / f"{n:03d}.live").write_text(heard.strip())


def create_stt():
    device, compute = stt_config()
    settings = WhisperSTTService.Settings(model=WHISPER, initial_prompt=STT_HINT)
    try:
        return CallSTT(device=device, compute_type=compute, settings=settings, ttfs_p99_latency=STT_P99)
    except (RuntimeError, ValueError) as error:
        if device == "cpu":
            raise
        logger.warning("Whisper CUDA init failed: {}; falling back to cpu/int8", error)
        return CallSTT(device="cpu", compute_type="int8", settings=settings, ttfs_p99_latency=STT_P99)


def media_transcript(path):
    """Use the call's faster-whisper model, including outside calls; do not load a media-only copy."""
    model = create_stt()._model
    segments, _ = model.transcribe(str(path), language="en", vad_filter=False, initial_prompt=STT_HINT)
    return "".join(f"[{segment.start:.2f}–{segment.end:.2f}] {segment.text.strip()}\n" for segment in segments)


def said(message):
    """The words of one context message (plain string or content parts)."""
    content = message.get("content") or ""
    if isinstance(content, str):
        return content.strip()
    return " ".join(p.get("text", "") for p in content if isinstance(p, dict)).strip()


class CallSignals(FrameProcessor):
    """Watch input before STT consumes audio; silence still counts as received audio."""

    def __init__(self):
        super().__init__()
        self.last_audio = None
        self._health = None

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, StartFrame) and not self._health:
                self._health = self.create_task(self._watch())
            elif isinstance(frame, InputAudioRawFrame) and frame.audio:
                self.last_audio = time.monotonic()
        await self.push_frame(frame, direction)

    async def _watch(self):
        while True:
            await asyncio.sleep(2)
            await self.push_frame(OutputTransportMessageUrgentFrame({
                "type": "audio-health", "receiving": self.last_audio is not None
                and time.monotonic() - self.last_audio < 5,
            }))

    async def cleanup(self):
        await super().cleanup()
        if self._health:
            await self.cancel_task(self._health)


class Floor:
    """Shared physical speech + semantic turn state; every new start resets the grace."""

    def __init__(self):
        self.speaking = False
        self.turn_open = False
        self.pending_turn = False
        self.quiet_since = time.monotonic()
        self.said = []  # audio seconds of each sentence synthesized and not yet played out, oldest first (SpeechGate)
        self.changed = asyncio.Event()

    def update(self, frame):
        if isinstance(frame, VADUserStartedSpeakingFrame):
            self.speaking = True
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self.speaking = False
            self.quiet_since = time.monotonic()
        elif isinstance(frame, UserStartedSpeakingFrame):
            self.turn_open = True
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self.turn_open = False
            self.quiet_since = time.monotonic()
        else:
            return
        self.changed.set()

    async def wait(self, grace=None, *, include_pending=True, since=0.0):
        """Until he is quiet for `grace` seconds, counted from his last stop or `since`, whichever is later."""
        grace = QUIET_GRACE if grace is None else grace
        while True:
            self.changed.clear()
            delay = grace - (time.monotonic() - max(self.quiet_since, since))
            held = self.speaking or self.turn_open or (include_pending and self.pending_turn)
            if not held and delay <= 0:
                return
            try:
                await asyncio.wait_for(self.changed.wait(), timeout=None if
                                       held else max(delay, 0.001))
            except asyncio.TimeoutError:
                pass


class SpeechGate(FrameProcessor):
    """Last check after synthesis: late audio cannot start during a new user turn."""

    def __init__(self, floor):
        super().__init__()
        self.floor = floor

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, (TTSStartedFrame, TTSAudioRawFrame)):
            await self.floor.wait()
            if isinstance(frame, TTSStartedFrame):
                self.floor.said.append(0.0)
            elif frame.audio and self.floor.said:
                self.floor.said[-1] += len(frame.audio) / (2 * frame.sample_rate * frame.num_channels)
        await self.push_frame(frame, direction)


def pronounce(text):
    """What the voice says for what the screen shows: the app's name is spelled Sheprd but spoken like the word
    (2026-11-07: the voice read the odd spelling). Only the TTS text; "say" messages keep the spelling."""
    return re.sub(r"\bsheprd\b", "Shepherd", text, flags=re.IGNORECASE)


class Notice(str):
    """A herd notice ("api is done."): Sheprd's own words about a sheep, not desk text. It waits on the floor like desk
    speech (never over him) and, unlike it, is spoken after his turn instead of dropped (plan R13)."""


class ClaudeSession(FrameProcessor):
    """Sits where an LLM service would. Each user turn is typed into the desk (a Claude Code session in a
    Herdr tab) and answered at once, so he can keep talking; everything the desk writes during the call comes back
    on one /events stream and is spoken, background results included.

    He has the floor (2026-11-04: "I will say my piece on something and then you'll read the entirety of
    what you said prior"): from the moment he starts talking, nothing the desk wrote before is spoken. Unspoken
    sentences are held; once his words go to the desk they are dropped, and so is everything the desk writes until
    its transcript shows it read them. His turn carries a note of exactly what he heard. A start that brings no words
    (a cough past the gate) gives the held sentences back."""

    def __init__(self, floor):
        super().__init__()
        self.floor = floor
        self._events = None
        self._ui = None
        self._speaker = None
        self._sender = None
        self._flusher = None
        self._settler = None
        self._pending = []
        self._speech = asyncio.Queue()
        self._turns = asyncio.Queue()
        self._played = asyncio.Event()
        self._current = None  # the sentence pushed to TTS and not yet played out
        self._ahead = None  # the sentence pushed after it, synthesized while _current plays
        # Not `_next`: that is pipecat's downstream link; a sentence parked there sent nothing to TTS (2026-11-05).
        self._upcoming = None  # the sentence _speak took off the queue and is waiting to push
        self._started = None  # when the current sentence's audio began
        self._heard = None  # the last sentence he heard to the end
        self._asked = 0.0  # when a spoken question ended: the next sentence waits for QUESTION_HOLD of quiet
        self._held = None  # unspoken sentences while he has the floor, else None
        self._taken = None  # (when he started talking, sentence cut, words of it heard) for the note
        self._muted = None  # when his turn went to the desk; desk text is dropped until the desk shows reading it
        self._busy = False  # the desk is working: it may write more before it reads his turn
        self._words = 0  # completed transcripts; a floor take with none after it was not speech
        self._display = DisplayText()
        self._talker = None  # who the call talks to: {"id", "name"} of a sheep, or None (the desk)
        self._stale_stop = False  # a talker switch cut audio that was playing: its stop frame is still on the way
        self._context = None  # the sheep (pane id) he has open on the phone, or None; sent with every /turn
        self._revealed = False  # he tapped the speaking box: this reply's sentences go to the page as they are queued

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        self.floor.update(frame)
        if isinstance(frame, (UserStartedSpeakingFrame, UserStoppedSpeakingFrame)):
            await self.push_frame(OutputTransportMessageUrgentFrame({
                "type": "user-turn", "speaking": isinstance(frame, UserStartedSpeakingFrame),
            }))
        if isinstance(frame, (VADUserStartedSpeakingFrame, UserStartedSpeakingFrame, InterruptionFrame)):
            self._take()
        if isinstance(frame, InterruptionFrame) and self._current:
            # Audio already delivered to the peer cannot be recalled: the note says how far he got. The interruption
            # flushes the sentence synthesized ahead too, so it goes back with the held ones.
            self._taken = (self._taken[0], self._current, self._heard_words(self._current, self._taken[0]))
            if self._ahead:
                self._held.insert(0, self._ahead)
            self._current = self._ahead = None
            self.floor.said.clear()
            self._played.set()
            # the page keeps the words he heard; the rest of the reply follows as "unspoken" once his turn drops it
            await self.push_frame(OutputTransportMessageUrgentFrame({"type": "say-stop", "heard": self._taken[2]}))
        elif isinstance(frame, BotStartedSpeakingFrame):
            if self._current and self._started is None:  # the talk bubble starts with the voice, not when queued
                await self.push_frame(OutputTransportMessageUrgentFrame({
                    "type": "say", "text": str(self._current), "speaker": None if isinstance(self._current, Notice)
                    else self._talker and self._talker.get("name"),
                }))
            self._started = time.monotonic()
            self._stale_stop = False  # new audio started: no stop of the cut audio is still on the way
        elif isinstance(frame, BotStoppedSpeakingFrame) and self._stale_stop:
            self._stale_stop = False  # the end of the audio _switch cut, not of the sentence pushed since
        elif isinstance(frame, BotStoppedSpeakingFrame):
            if self._current:
                self._heard = self._current
                if self._current.endswith("?"):
                    self._asked = time.monotonic()
                await self.push_frame(OutputTransportMessageUrgentFrame({"type": "said"}))  # the voice finished it
            if self.floor.said:
                self.floor.said.pop(0)
            self._current, self._ahead, self._started = self._ahead, None, None
            if not (self._current or self._upcoming) and self._speech.empty():
                self._revealed = False  # the reply is read out: the next one types along with the voice again
            self._played.set()
        if not isinstance(frame, LLMContextFrame):
            return await self.push_frame(frame, direction)
        messages = frame.context.get_messages()
        if not messages or messages[-1].get("role") != "user":  # the call just connected
            if not self._events:
                self._events = self.create_task(self._listen())
                self._ui = self.create_task(self._ui_updates())
                self._speaker = self.create_task(self._speak())
                self._sender = self.create_task(self._send_turns())
            self._speech.put_nowait("Hey, it's your desk. What's up?")
            return
        if text := said(messages[-1]):
            self._words += 1
            self._pending.append(text)
            self.floor.pending_turn = True
            # Allow late STT fragments and a renewed VAD start to cancel delivery.
            self.floor.quiet_since = time.monotonic()
            self.floor.changed.set()
            if not self._flusher or self._flusher.done():
                self._flusher = self.create_task(self._flush_turn())

    def _heard_words(self, sentence, at):
        """The words of `sentence` he heard before he started talking, estimated from its audio length."""
        if self._started is None or self._started > at:
            return ""
        words = sentence.split()
        share = (at - self._started) / max(self.floor.said[0] if self.floor.said else 0.0, 0.1)
        return " ".join(words[:int(len(words) * min(share, 1.0))])

    def _take(self):
        """He started talking: hold every sentence not yet spoken."""
        if self._held is not None:
            return
        self._revealed = False
        self._held = [self._upcoming] if self._upcoming else []
        self._upcoming = None
        while not self._speech.empty():
            self._held.append(self._speech.get_nowait())
        self._taken = (time.monotonic() - START_SECS, None, "")
        if self._settler is None or self._settler.done():
            self._settler = self.create_task(self._settle())

    async def _settle(self):
        # No transcript once he is quiet again: not speech, so the held sentences are spoken after all.
        words = self._words
        while self._held is not None:
            await self.floor.wait(TURN_SILENCE + 1.0)
            if self._held is not None and self._words == words:
                rest = ([self._taken[1]] if self._taken[1] else []) + self._held
                while not self._speech.empty():
                    rest.append(self._speech.get_nowait())
                self._held, self._taken = None, None
                for sentence in rest:
                    self._speech.put_nowait(sentence)
            words = self._words

    def _note(self):
        """What he heard of the desk's words, for the desk: when something was cut or held, or the desk is still
        working and may write more before it reads this turn (dropped unspoken)."""
        if not self._taken or time.monotonic() - self._taken[0] > NOTE_TTL:
            self._taken = None
        cut, words = self._taken[1:] if self._taken else (None, "")
        if not (cut or self._held or self._busy):
            return ""
        heard = f'the last thing he heard in full was "{self._heard}"' if self._heard else "he has heard nothing yet"
        if cut and words:
            heard = f'he cut in: {heard}, then "{words}…" of "{cut}"'
        elif cut:
            heard = f'he cut in: {heard}; "{cut}" was cut before he heard any of it'
        return f"[note: {heard}; nothing else you wrote, or write before reading this, was spoken] "

    def _unspoken(self):
        """The desk's words his turn drops unspoken: the rest of the sentence he cut, then the held desk sentences
        (2026-11-07: "paste the rest of what you were saying while I'm cutting you off ... There's no missing context")."""
        cut, words = self._taken[1:] if self._taken else (None, "")
        rest = [" ".join(cut.split()[len(words.split()):])] if cut else []
        return " ".join(s for s in rest + [s for s in self._held or [] if not isinstance(s, Notice)] if s)

    async def _flush_turn(self):
        await self.floor.wait(TURN_SILENCE, include_pending=False)
        if unspoken := self._unspoken():  # the page shows it in the cut reply's box, marked not spoken
            await self.push_frame(OutputTransportMessageUrgentFrame({"type": "unspoken", "text": unspoken}))
        text = self._note() + " ".join(" ".join(self._pending).split())
        notices = [s for s in self._held or [] if isinstance(s, Notice)]  # held desk sentences are dropped
        self._held, self._taken, self._asked = None, None, 0.0
        self._muted = time.monotonic()
        self._turns.put_nowait(text)
        # the page's thread shows what the call heard him say (the note is the desk's, not his words)
        await self.push_frame(OutputTransportMessageUrgentFrame({"type": "heard", "text": " ".join(" ".join(self._pending).split())}))
        for notice in notices:
            self._speech.put_nowait(notice)
        self._pending.clear()
        self.floor.pending_turn = False
        self.floor.changed.set()

    async def _send_turns(self):
        # One HTTP request in flight: quick turns cannot arrive at the bridge out of order.
        while True:
            await self._turn(await self._turns.get())

    async def _speak(self):
        """One sentence per TTS request, the next pushed while the one before plays so Kokoro has it ready: back to
        back with no synthesis gap (2026-11-05: "a really long cut between the next sentence"). Never past
        a question: what follows it waits for QUESTION_HOLD of quiet after it was heard."""
        while True:
            self._upcoming = await self._speech.get()
            while self._ahead or (self._current or "").endswith("?"):
                self._played.clear()
                try:
                    await asyncio.wait_for(self._played.wait(), timeout=90)
                except asyncio.TimeoutError:
                    # Clear stuck synthesis/output before allowing another sentence through.
                    await self.broadcast_interruption()
                    logger.warning("Speech playback timed out")
                    self._current = self._ahead = None
                    self.floor.said.clear()
                    await self.push_frame(OutputTransportMessageUrgentFrame({"type": "say-stop"}))
            await self.floor.wait(QUESTION_HOLD if self._asked else None, since=self._asked)
            if not self._upcoming:  # he took the floor meanwhile: _take holds it
                continue
            if self._current:
                self._ahead = self._upcoming
            else:
                self._current, self._started = self._upcoming, None
            sentence, self._upcoming, self._asked = self._upcoming, None, 0.0
            await self.push_frame(TTSSpeakFrame(pronounce(sentence), append_to_context=False))

    async def reveal(self):
        """The page's {"type": "reveal"}: he tapped the speaking box (2026-11-07: "show the full thing that you're
        saying instead of ... line by line"). The page gets this reply's sentences it has not been sent yet, and later
        desk sentences of the reply as they are queued; each still gets its "say" when the voice reaches it, and the
        page shows it once. Speech is untouched. Nothing while he has the floor (those sentences are held)."""
        if self._held is not None:
            return
        queued = []
        while not self._speech.empty():  # a look at the queue, put back in order with no await between: _speak sees no change
            queued.append(self._speech.get_nowait())
        for sentence in queued:
            self._speech.put_nowait(sentence)
        self._revealed = True
        await self._reveal([self._current if self._started is None else None, self._ahead, self._upcoming, *queued])

    async def _reveal(self, sentences):
        if sentences := [str(s) for s in sentences if s and not isinstance(s, Notice)]:  # notices are Sheprd's own lines
            await self.push_frame(OutputTransportMessageUrgentFrame({"type": "reveal", "sentences": sentences}))

    def set_context(self, message):
        """The page's {"type": "context", "sheep": pane | null} (a sheep panel opened or closed): True when taken;
        anything else is dropped and the open sheep stays."""
        sheep = message.get("sheep", "") if isinstance(message, dict) and message.get("type") == "context" else ""
        if sheep is not None and not (isinstance(sheep, str) and PANE.fullmatch(sheep)):
            return False
        self._context = sheep
        return True

    async def _turn(self, text):
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=90)) as http:
                async with http.post(DESK_URL + "/turn", json={"text": text, "context": {"sheep": self._context}},
                                     headers=CLIENT) as r:
                    if r.status == 202:
                        return
                    logger.warning(f"desk: /turn answered {r.status}")
        except (aiohttp.ClientError, asyncio.TimeoutError) as error:
            logger.warning(f"desk: {error!r}")
        self._muted = None  # the desk never got it: nothing to wait for
        self._speech.put_nowait("I couldn't reach the desk just now.")

    async def _ui_updates(self):
        from live_ui import changes
        async for message in changes():
            await self.push_frame(OutputTransportMessageUrgentFrame(message))

    async def _listen(self):
        """The desk's /events for the whole call; reconnects after a drop."""
        while True:
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_read=60)) as http:
                    async with http.get(DESK_URL + "/events", headers=CLIENT) as r:
                        r.raise_for_status()
                        async for line in r.content:
                            event = json.loads(line)
                            await self._desk_event(event)
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as error:
                logger.warning(f"desk events: {error!r}")
            await self._desk_event({"text": "", "text_end": True})
            await asyncio.sleep(3)

    async def _switch(self, talker):
        """The call now talks to `talker` (a sheep's {"id", "name"}, or None for the desk), atomically: nothing the old
        talker wrote is spoken after this or under the new name (plan R12); pending herd notices are kept, in order.
        The state is reset before the first await, so _speak cannot take an old sentence meanwhile; sentences queued
        after this belong to the new talker."""
        if (talker and talker.get("id")) == (self._talker and self._talker.get("id")):
            self._talker = talker
            return
        playing = self._current or self._ahead
        self._stale_stop = self._stale_stop or bool(playing and self._started is not None)
        pending = [self._ahead, self._upcoming, *(self._held or [])]
        while not self._speech.empty():
            pending.append(self._speech.get_nowait())
        self._current = self._ahead = self._upcoming = self._held = self._taken = self._muted = self._started = None
        self._revealed = False
        self.floor.said.clear()
        self._played.set()
        self._talker = talker
        for notice in pending:  # herd notices are not talker speech: queued again, and _speak's floor wait holds them
            if isinstance(notice, Notice):
                self._speech.put_nowait(notice)
        if playing:
            await self.broadcast_interruption()
            await self.push_frame(OutputTransportMessageUrgentFrame({"type": "say-stop"}))
        await self.push_frame(OutputTransportMessageUrgentFrame({
            "type": "speaker", "name": talker and talker.get("name"), "id": talker and talker.get("id"),
        }))

    async def _desk_event(self, event):
        if event.get("ready") and self._talker:  # a fresh stream (a reconnect): a seated sheep is named next, if any
            await self._switch(None)
        if "herd" in event:
            await self.push_frame(OutputTransportMessageUrgentFrame({"type": "herd", "herd": event["herd"]}))
        if "speaker" in event:
            await self._switch(event["speaker"] if isinstance(event["speaker"], dict) else None)
        if isinstance(event.get("herd_say"), str) and re.search(r"\w", event["herd_say"]):
            # not desk text: _muted never drops it, and like desk text it waits on the floor (never over him)
            notice = Notice(event["herd_say"].strip())
            if self._held is not None:
                self._held.append(notice)
            else:
                self._speech.put_nowait(notice)
        if "busy" in event:
            await self.push_frame(OutputTransportMessageUrgentFrame({"type": "busy", "busy": event["busy"]}))
        if "busy" in event:
            self._busy = event["busy"]
        if "handoff" in event:  # a login or CAPTCHA waiting on him: Sheprd's face frames it (null closes it)
            await self.push_frame(OutputTransportMessageUrgentFrame({"type": "handoff", **(event["handoff"] or {})}))
        if event.get("prompt"):  # the desk read a message from him: what it writes next answers it
            self._muted = None
        if "text" not in event:
            return
        text, cards = self._display.feed(event["text"] or "", final=event.get("text_end", True))
        for i, card in enumerate(cards):
            await self.push_frame(OutputTransportMessageUrgentFrame({
                "type": "show", "text": card, "id": card_id(event.get("show_id", card), i),
            }))
        if self._muted and time.monotonic() - self._muted > MUTE_MAX:
            self._muted = None
        dropped, queued = [], []
        for sentence in re.split(r"(?<=[.!?])\s+", speakable(text)):
            if not re.search(r"\w", sentence):  # "..." alone: no audio, so no stop frame to end it
                continue
            if self._muted:  # ponytail: dropped unnoted if an idle desk starts a turn of its own here (a result)
                dropped.append(sentence)
            elif self._held is not None:
                self._held.append(sentence)
            else:
                self._speech.put_nowait(sentence)
                queued.append(sentence)
        if self._revealed:
            await self._reveal(queued)
        if dropped:  # the rest of the reply he cut: never spoken, still on the page to read back
            await self.push_frame(OutputTransportMessageUrgentFrame({"type": "unspoken", "text": " ".join(dropped)}))

    async def cleanup(self):
        await super().cleanup()
        for task in (self._events, self._ui, self._speaker, self._sender, self._flusher, self._settler):
            if task:
                await self.cancel_task(task)


FIRST_AUDIO_SECS = 20.0


class CallTTS(KokoroTTSService):
    """Kokoro synthesizes a sentence before its first audio: 3-5 s on a busy voice host (2026-11-07), past pipecat's
    3 s audio-context idle timeout, which then closed each such sentence as "completed with no audio" (an error frame,
    a stop frame before the late audio played, and three in a row mark the TTS unusable, which ends the call). A
    context waits FIRST_AUDIO_SECS for its first audio; after that the stock idle timeout ends the sentence.
    ponytail: overrides two private TTSService hooks (pinned pipecat 1.15.0); test_tts.py fails if they change."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._voiced = set()  # contexts whose first audio arrived

    async def _next_audio_context_item(self, context_id):
        if context_id in self._voiced:
            return await super()._next_audio_context_item(context_id)
        try:
            return await self._audio_context_manager.get(context_id, timeout=FIRST_AUDIO_SECS)
        except TimeoutError:
            return None

    async def _push_audio_context_item(self, context_id, item, playback):
        if isinstance(item, TTSAudioRawFrame):
            self._voiced.add(context_id)
        await super()._push_audio_context_item(context_id, item, playback)


def create_tts():
    """Piper for "piper:<id>" voices (any Piper .onnx voice), Kokoro otherwise; a Piper load failure falls back to
    Kokoro af_heart."""
    if VOICE.startswith("piper:"):
        try:
            from pipecat.services.piper.tts import PiperTTSService

            tts = PiperTTSService(settings=PiperTTSService.Settings(voice=VOICE[6:]), download_dir=PIPER_DIR)
            tts._voice.config.length_scale /= SPEED  # Piper has no speed setting; shorter phonemes talk faster
            logger.info("TTS: Piper {} at {}x", VOICE[6:], SPEED)
            return tts
        except Exception as error:
            logger.warning("Piper voice {} failed: {!r}; falling back to Kokoro af_heart", VOICE, error)
    voice = "af_heart" if VOICE.startswith("piper:") else VOICE
    logger.info("TTS: Kokoro {} at {}x", voice, SPEED)
    return CallTTS(settings=KokoroTTSService.Settings(voice=voice, speed=SPEED))


class PageSeen:
    """Whether the call page is on his screen, from its page-audio reports: "hidden" when he leaves the app or the
    screen goes off, "back in the app" (visible: true) when he returns. A call starts from the open page: seen."""

    hidden = False

    def report(self, message):
        if message.get("reason") == "hidden" or message.get("visible") is False:
            self.hidden = True
        elif message.get("visible") is True:
            self.hidden = False


def call_worker(pipeline, idle_secs, page, end):
    """The call's pipeline worker. pipecat's idle timeout (idle_secs with nobody speaking, 5 min) ends the call only while
    the page is hidden, for the battery and the open mic; while Sheprd is open on his screen the call stays up however
    quiet it is (desk decision 2026-11-07, "You kicked me off of the app": the stock timeout ended calls he was
    looking at, 13:09 that day). `end` is called (awaited) to end it."""
    worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True), idle_timeout_secs=idle_secs,
                            cancel_on_idle_timeout=False, processor_unusable_policy=ProcessorUnusablePolicy.END)

    @worker.event_handler("on_idle_timeout")
    async def on_idle_timeout(worker):
        if page.hidden:
            logger.info("call idle with the page hidden: ending it")
            await end()
        else:
            logger.info("call idle with the page open: it stays up")
    return worker


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments):
    stt = create_stt()  # the process's warm Whisper (whisper()), shared with media uploads
    floor = Floor()
    llm = ClaudeSession(floor)
    tts = create_tts()
    stt.record = CALLS / f"{datetime.datetime.now():%Y-%m-%d_%H%M%S}"

    async def alarm(text, spoken):
        """Logs "STT ALARM" (a journal probe can count those lines); aloud if words were lost."""
        logger.error("STT ALARM: {}", text)
        if spoken:
            llm._speech.put_nowait("Sorry, transcription failed just now, so the desk didn't get that. Say it again.")
    stt.alarm = alarm

    # The desk session keeps the conversation; the local context only frames each turn.
    context = LLMContext()
    user_agg, assistant_agg = LLMContextAggregatorPair(
        context, user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=vad_params()),
            user_turn_strategies=UserTurnStrategies(
                start=[VADUserTurnStartStrategy(enable_interruptions=True),
                       TranscriptionUserTurnStartStrategy(enable_interruptions=True)],
                stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=LocalSmartTurnAnalyzerV3(
                    params=SmartTurnParams(stop_secs=float(os.environ.get("VOICE_TURN_STOP_SECS", "3.0")))
                ))],
            ),
            # pipecat ends a turn 5 s after he stops if no words came back yet; the late words then opened a turn of
            # their own, so a slow transcript reached the desk in pieces (2026-11-07). A turn now waits that long.
            user_turn_stop_timeout=TURN_STOP_TIMEOUT,
        ))
    pipeline = Pipeline([transport.input(), CallSignals(), stt, user_agg, llm, tts,
                         SpeechGate(floor), transport.output(), assistant_agg])
    page = PageSeen()
    worker = call_worker(pipeline, runner_args.pipeline_idle_timeout_secs, page,
                         lambda: runner.cancel(reason="idle with the page hidden"))
    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
    await runner.add_workers(worker)

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("call started")
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_app_message")
    async def on_app_message(transport, message, sender):
        # The call page reports its speaker and mic state when it comes back from another app or its output stalls.
        if isinstance(message, dict) and message.get("type") == "page-audio":
            logger.info(f"page audio: {json.dumps(message)[:500]}")
            page.report(message)
        elif isinstance(message, dict) and message.get("type") == "context":  # the sheep he has open, for the desk
            llm.set_context(message)
        elif isinstance(message, dict) and message.get("type") == "reveal":  # he tapped the speaking box: the whole reply
            await llm.reveal()

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("call ended")
        if stt.record.exists():  # a slower, more accurate pass on CPU: a redial keeps the GPU to itself
            subprocess.Popen(["nice", "-n", "15", sys.executable, str(Path(__file__).with_name("recheck.py")),
                              str(stt.record)], env={**os.environ, "VOICE_STT_DEVICE": "cpu",
                                                     "VOICE_STT_COMPUTE": "int8"},
                             stdout=(stt.record / "recheck.log").open("w"), stderr=subprocess.STDOUT,
                             start_new_session=True)
        await runner.cancel()

    await runner.run()


async def bot(runner_args: RunnerArguments):
    InUse.calls += 1  # from the accepted offer, before the peer connects, until the pipeline is done
    try:
        transport = await create_transport(
            runner_args, {"webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True)}
        )
        await run_bot(transport, runner_args)
    finally:
        InUse.calls -= 1
        InUse.ended = time.time()


def _with_call_page(setup):
    """The runner's frontend routes plus GET /call, the one-button page the phone opens (call.html next to this file), and
    GET /sheprd/{name}: the page's world files (world/*.js that exist, never cached), the game modules
    (/sheprd/games/<id>.js from world/games/) and the vendored Phaser (immutable by version). An allowlist, not a
    static mount: anything else under /sheprd is 404."""
    from fastapi.responses import FileResponse, Response

    page = Path(__file__).with_name("call.html")
    world, vendor = page.with_name("world"), page.with_name("vendor")
    phaser = "phaser-4.2.1.min.js"
    world_file = re.compile(r"[a-z]+\.js")  # px font tiles sprites portraits world games; index.html and preview.cjs stay dev-only
    games = world / "games"

    def routes(app):
        setup(app)
        from fastapi.middleware.cors import CORSMiddleware
        from shown import Guard
        # the page is same-origin: no CORS, so no other site can read an answer or send a custom header, and Guard
        # (outermost) refuses every request but the page's own
        app.user_middleware = [m for m in app.user_middleware if m.cls is not CORSMiddleware]
        app.add_middleware(InUse)
        app.add_middleware(Guard)  # added last: outermost
        from media import add_routes
        add_routes(app, media_transcript, DESK_URL)
        from shown import add_routes as add_show_routes
        add_show_routes(app, DESK_URL)

        @app.get("/call", include_in_schema=False)
        async def call_page():
            from live_ui import snapshot
            ui = snapshot(page.parent)
            html = ui["html"].replace("</head>", '<meta name="sheprd-ui" content="' + ui["revision"] + '"></head>', 1)
            return Response(html, media_type="text/html", headers={"Cache-Control": "no-store"})

        def inside(folder, file):  # a real file of that folder: no symlink, and it resolves under the folder
            return file.is_file() and not file.is_symlink() and file.resolve().parent == folder.resolve()

        @app.get("/sheprd/{name}", include_in_schema=False)
        async def sheprd_asset(name: str):
            if name == phaser and inside(vendor, vendor / phaser):
                return FileResponse(vendor / phaser, headers={"Cache-Control": "public, max-age=31536000, immutable"})
            if re.fullmatch(r"[a-z]+\.(js|css)", name) and inside(world, world / name):
                return FileResponse(world / name, headers={"Cache-Control": "no-cache"})
            return Response(status_code=404)

        @app.get("/sheprd/games/{name}", include_in_schema=False)
        async def sheprd_game(name: str):  # one drop-in game module (world/games.js's registry names them)
            if world_file.fullmatch(name) and inside(games, games / name):
                return FileResponse(games / name, headers={"Cache-Control": "no-cache"})
            return Response(status_code=404)
    return routes


if __name__ == "__main__":
    warm_stt()
    import pipecat.runner.run as run
    import uvicorn

    uvicorn.run = partial(uvicorn.run, timeout_graceful_shutdown=STOP_GRACE)  # the runner calls uvicorn.run(app, ...)

    # ponytail: wraps a private runner hook (pinned pipecat 1.15.0); if an upgrade renames it, serve call.html with
    # its own small FastAPI app instead.
    run._setup_frontend_routes = _with_call_page(run._setup_frontend_routes)
    run.main()
