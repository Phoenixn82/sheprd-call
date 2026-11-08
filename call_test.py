"""End-to-end check of a call, no phone needed: a scripted caller dials the bot over the same HTTPS front the phone uses,
listens to the greeting, asks one spoken question (made with Kokoro, a male voice so it is not the bot's), records
everything the bot says and prints Whisper's transcript of it with timings. Exit 1 when the bot never answers.

Run on the voice host: ../.venv/bin/python call_test.py [URL] [QUESTION]   (URL default: VOICE_CALL_URL, else the
bot on this machine)
"""

import asyncio
import fractions
import json
import contextlib
import os
from pathlib import Path
import sys
import tempfile
import time
import wave

import numpy as np
import requests
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
from av import AudioFrame

URL = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VOICE_CALL_URL", "http://127.0.0.1:7862")


def page_headers(url):
    """What the call page's own POST carries: the voice host's Guard (shown.py) refuses anything else."""
    return {"X-Sheprd": "1", "Origin": "/".join(url.split("/")[:3])}
QUESTION = sys.argv[2] if len(sys.argv) > 2 else "What's the oldest card that needs me, and what happens if I ignore it?"
RATE, FRAME = 48000, 960  # 20 ms frames


def speak(text: str) -> np.ndarray:
    """The bot's Kokoro files render the caller's question, resampled to 48 kHz int16."""
    from kokoro_onnx import Kokoro
    from pipecat.services.kokoro.tts import KOKORO_CACHE_DIR, _ensure_model_files

    model, voices = KOKORO_CACHE_DIR / "kokoro-v1.0.onnx", KOKORO_CACHE_DIR / "voices-v1.0.bin"
    _ensure_model_files(model, voices)
    samples, sr = Kokoro(str(model), str(voices)).create(text, voice="am_michael", lang="en-us")
    idx = np.arange(0, len(samples), sr / RATE)
    up = np.interp(idx, np.arange(len(samples)), samples)
    return (np.clip(up, -1, 1) * 32767).astype(np.int16)


class Mic(MediaStreamTrack):
    """Silence, then the question once the greeting is over, then silence."""

    kind = "audio"

    def __init__(self, pcm: np.ndarray):
        super().__init__()
        self.pcm, self.pos, self.t0, self.n, self.start_at = pcm, 0, None, 0, None
        self.intervals = []

    def say(self, pcm):
        assert self.pos >= len(self.pcm) or self.start_at is None
        self.pcm, self.pos, self.start_at = pcm, 0, time.time()
        self.intervals.append([self.start_at, self.start_at + len(pcm) / RATE])

    async def recv(self):
        if self.t0 is None:
            self.t0 = time.time()
        await asyncio.sleep(max(0, self.t0 + self.n * FRAME / RATE - time.time()))
        chunk = np.zeros(FRAME, np.int16)
        if self.start_at is not None and time.time() >= self.start_at and self.pos < len(self.pcm):
            part = self.pcm[self.pos:self.pos + FRAME]
            chunk[:len(part)] = part
            self.pos += FRAME
        f = AudioFrame.from_ndarray(chunk.reshape(1, -1), format="s16", layout="mono")
        f.sample_rate, f.pts, f.time_base = RATE, self.n * FRAME, fractions.Fraction(1, RATE)
        self.n += 1
        return f


async def main() -> int:
    mic = Mic(speak(QUESTION))
    pc = RTCPeerConnection()
    pc.addTrack(mic)
    heard, spans = [], []  # bot audio (48k mono int16); (start, end) seconds of each burst of bot speech
    t0 = time.time()
    busy = []  # (seconds, busy) from the bot's events channel: the Call screen's thinking dots
    pc.createDataChannel("events").on("message", lambda m: '"busy"' in m and busy.append((round(time.time() - t0, 1), m)))

    @pc.on("track")
    def on_track(track):
        async def pull():
            while True:
                try:
                    f = await track.recv()
                except Exception:
                    return
                mono = f.to_ndarray().reshape(-1, len(f.layout.channels)).mean(axis=1).astype(np.int16)
                if f.sample_rate != RATE:  # keep the recording at one rate
                    mono = np.interp(np.arange(0, len(mono), f.sample_rate / RATE), np.arange(len(mono)), mono).astype(np.int16)
                heard.append(mono)
                now = time.time() - t0
                if np.abs(mono).max() > 500:
                    if spans and now - spans[-1][1] < 0.8:
                        spans[-1][1] = now
                    else:
                        spans.append([now, now])

        asyncio.ensure_future(pull())

    await pc.setLocalDescription(await pc.createOffer())
    r = requests.post(URL + "/api/offer", json={"sdp": pc.localDescription.sdp, "type": "offer"}, timeout=180,
                      headers=page_headers(URL))
    r.raise_for_status()
    ans = r.json()
    await pc.setRemoteDescription(RTCSessionDescription(sdp=ans["sdp"], type=ans["type"]))

    # Wait for the greeting to finish (1.5 s of quiet after speech), then ask.
    deadline = time.time() + 60
    while time.time() < deadline and not (spans and time.time() - t0 - spans[-1][1] > 1.5):
        await asyncio.sleep(0.2)
    greet_end = spans[-1][1] if spans else None
    asked = time.time() - t0
    mic.start_at = time.time()
    q_len = len(mic.pcm) / RATE
    await asyncio.sleep(q_len + 25)
    await pc.close()

    pcm = np.concatenate(heard) if heard else np.zeros(1, np.int16)
    with wave.open("/tmp/voice-call-test.wav", "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(RATE), w.writeframes(pcm.tobytes())
    replies = [s for s in spans if s[0] > asked + q_len]
    from faster_whisper import WhisperModel

    segs, _ = WhisperModel("small.en", device="cpu", compute_type="int8").transcribe("/tmp/voice-call-test.wav")
    print("greeting ended at", greet_end and round(greet_end, 1), "s; asked at", round(asked, 1), "s, question", round(q_len, 1), "s")
    print("reply starts", [round(s[0] - asked - q_len, 1) for s in replies], "s after the question ended")
    print("transcript:", " ".join(s.text.strip() for s in segs))
    print("busy events:", busy)
    return 0 if greet_end and replies else 1


async def turn_taking():
    """Isolated real WebRTC/VAD/Whisper/Smart Turn/Kokoro check; no desk or live service touched."""
    from aiohttp import web, ClientSession

    # Render off the event loop, before starting the bot or any test clocks.
    clips = [await asyncio.to_thread(speak, text) for text in (
        "Please stop talking now, I am still explaining the question to you.",
        "Please remember the color blue,",
        "the number seven, which belongs with the other details I am still explaining,",
        "the word apple,",
        "and finally the color green, all together as one thought.",
    )]
    events, turns = asyncio.Queue(), []

    async def turn(request):
        text = (await request.json())["text"]
        turns.append((time.time(), text))
        return web.Response(status=202)

    async def stream(request):
        response = web.StreamResponse(headers={"Content-Type": "application/x-ndjson"})
        await response.prepare(request)
        try:
            while True:
                event = await events.get()
                await response.write((json.dumps(event) + "\n").encode())
        except (ConnectionError, asyncio.CancelledError):
            return response

    app = web.Application()
    app.router.add_post("/turn", turn)
    app.router.add_get("/events", stream)
    desk = web.AppRunner(app, shutdown_timeout=0.1)
    await desk.setup()
    await web.TCPSite(desk, "127.0.0.1", 17865).start()
    log = open("/tmp/voice-turn-taking-bot.log", "w")
    env = dict(os.environ, VOICE_SESSION_URL="http://127.0.0.1:17865",
               VOICE_CALLS_DIR=tempfile.mkdtemp(prefix="voice-test-calls-"))  # never the live recordings
    proc = await asyncio.create_subprocess_exec(
        "nice", "-n", "10", sys.executable, str(Path(__file__).with_name("bot.py")),
        "-t", "webrtc", "--host", "127.0.0.1", "--port", "17864",
        env=env, stdout=log, stderr=log,
    )
    pc, mic = RTCPeerConnection(), Mic(np.zeros(0, np.int16))
    pc.addTrack(mic)
    audio, starts, receiver = [], [], []
    t0 = time.time()

    @pc.on("track")
    def track_received(track):
        async def pull():
            last = 0
            while True:
                try:
                    frame = await track.recv()
                except Exception:
                    return
                pcm = frame.to_ndarray().astype(np.float32)
                now = time.time()
                if np.max(np.abs(pcm)) > 500:
                    # A 120 ms gap marks a fresh audio start, including pauses inside sentences.
                    if now - last > 0.12:
                        starts.append(now)
                    audio.append(now)
                    last = now
        receiver.append(asyncio.create_task(pull()))

    async def until(predicate, timeout=45):
        deadline = time.time() + timeout
        while not predicate():
            assert time.time() < deadline, "timed out waiting for scripted call state"
            await asyncio.sleep(0.02)

    async def say(clip):
        mic.say(clip)
        await asyncio.sleep(len(clip) / RATE + 0.05)

    try:
        async with ClientSession() as http:
            for _ in range(180):
                assert proc.returncode is None, "isolated bot exited; see /tmp/voice-turn-taking-bot.log"
                try:
                    async with http.get("http://127.0.0.1:17864/call") as response:
                        if response.status == 200:
                            break
                except OSError:
                    pass
                await asyncio.sleep(0.5)
            else:
                raise AssertionError("isolated bot did not start")
            await pc.setLocalDescription(await pc.createOffer())
            async with http.post("http://127.0.0.1:17864/api/offer", json={
                "sdp": pc.localDescription.sdp, "type": "offer"
            }, headers=page_headers("http://127.0.0.1:17864")) as response:
                response.raise_for_status()
                answer = await response.json()
            await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))
        await until(lambda: audio)
        # Barge into the greeting while it is audibly playing.
        await say(clips[0])
        first_start, first_end = mic.intervals[0]
        stop_delay = max([t - first_start for t in audio if first_start <= t <= first_end] or [0])
        # The bot's VAD start (0.25 s since the near-field gate) plus 0.6 s for detection and network.
        barge = float(os.environ.get("VOICE_VAD_START_SECS", "0.25")) + 0.6
        assert stop_delay < barge, f"barge-in took {stop_delay:.3f}s"
        await until(lambda: any("stop talking" in text.lower() for _, text in turns))
        assert [text for _, text in turns if "Hey, it's your desk. What's up?" in text and "[note:" in text
                and "stop talking" in text.lower()], "interrupted sentence did not ride on the caller's next turn"

        # No response yet: two new utterances while the desk is thinking. A delayed
        # answer and an unrelated background result arrive DURING the second utterance.
        await say(clips[1])
        await asyncio.sleep(0.6)  # mid-sentence pauses must not become desk turns
        mic.say(clips[2])
        await asyncio.sleep(0.5)
        events.put_nowait({"text": "I have the delayed answer ready. The background job has also finished."})
        await asyncio.sleep(len(clips[2]) / RATE - 0.45)
        # Resume during the end-of-turn/quiet window; no queued answer may escape.
        await asyncio.sleep(1.2)
        await say(clips[3])
        await asyncio.sleep(0.9)
        await say(clips[4])
        final_end = mic.intervals[-1][1]
        # Like the real desk: text written before it reads his turn is dropped unspoken (the delayed answer above);
        # once it shows reading the paragraph ({"prompt": true}), its reply is spoken.
        await until(lambda: any("green" in text.lower() for _, text in turns))
        events.put_nowait({"prompt": True})
        events.put_nowait({"text": "Blue, seven, apple and green."})
        await until(lambda: any(t > final_end for t in audio))
        await asyncio.sleep(6)
        # Allow detector + network latency only at the intentional barge-in onset.
        # The greeting may resume after its own comma pause inside the barge-in budget (Piper BMO pauses
        # 0.24 s after "Hey,"); stop_delay above bounds that window, the leak check below everything after it.
        violations = [round(t - t0, 3) for t in starts for begin, end in mic.intervals
                      if begin <= t <= end and not first_start < t <= first_start + barge]
        assert not violations, f"bot audio started during caller speech: {violations}"
        assert not [t for t in audio if first_start + barge < t < final_end], "audio leaked while caller held the floor"
        spoken = [text.lower().split("] ", 1)[-1] for _, text in turns]
        assert len(spoken) == 2, f"expected barge-in turn plus ONE paused paragraph: {spoken}"
        assert all(word in spoken[1].replace("7", "seven") for word in ("blue", "seven", "apple", "green")), spoken
        joined = " ".join(spoken).replace("7", "seven")
        assert all(word in joined for word in ("blue", "seven", "apple")), f"missing caller words: {spoken}"
        assert joined.index("blue") < joined.index("seven") < joined.index("apple"), f"turns reordered: {spoken}"
        assert joined.count("blue") == 1 and joined.count("seven") == 1, f"turns duplicated: {spoken}"
        print(json.dumps({"result": "PASS", "mode": "isolated WebRTC",
                          "barge_in_stop_seconds": round(stop_delay, 3),
                          "audio_starts_during_caller_speech": violations,
                          "first_reply_after_final_speech_seconds": round(min(t for t in audio if t > final_end) - final_end, 3),
                          "pause_seconds": [0.6, 1.2, 0.9], "paused_paragraph_desk_turns": len(spoken) - 1,
                          "caller_turns": spoken, "cutoff_notes": sum("[note:" in text for _, text in turns)}, indent=2))
        return 0
    finally:
        await pc.close()
        for task in receiver:
            task.cancel()
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=10)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        log.close()
        await desk.cleanup()


async def check_floor():
    """Fast regression: an incomplete turn and a renewed start both keep late audio gated."""
    import bot
    from unittest.mock import AsyncMock
    from pipecat.frames.frames import (
        TTSAudioRawFrame, UserStartedSpeakingFrame, UserStoppedSpeakingFrame,
        VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
    )
    from pipecat.processors.frame_processor import FrameDirection

    floor = bot.Floor()
    gate = bot.SpeechGate(floor)
    gate.push_frame = AsyncMock()
    original = bot.QUIET_GRACE
    bot.QUIET_GRACE = 0.08
    pending = None
    try:
        floor.update(UserStartedSpeakingFrame())
        floor.update(VADUserStartedSpeakingFrame())
        pending = asyncio.create_task(gate.process_frame(
            TTSAudioRawFrame(audio=b"\0\0" * 160, sample_rate=16000, num_channels=1),
            FrameDirection.DOWNSTREAM))
        floor.update(VADUserStoppedSpeakingFrame())
        await asyncio.sleep(0.12)
        assert not pending.done(), "audio escaped during semantically incomplete turn"
        floor.update(UserStoppedSpeakingFrame())
        await asyncio.sleep(0.04)
        floor.update(VADUserStartedSpeakingFrame())
        await asyncio.sleep(0.08)
        assert not pending.done(), "renewed speech did not cancel grace"
        floor.update(VADUserStoppedSpeakingFrame())
        await asyncio.sleep(0.04)
        assert not pending.done(), "audio escaped before renewed grace elapsed"
        await asyncio.wait_for(pending, timeout=0.2)
        gate.push_frame.assert_awaited_once()
        print("PASS: incomplete turn holds audio; resumed speech resets grace; audio releases after quiet")
        await check_turn_buffer()
        await check_barge_in()
        await check_downstream_link()
        await check_synth_ahead()
        return 0
    finally:
        bot.QUIET_GRACE = original
        if pending:
            pending.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pending


async def check_turn_buffer():
    """Completed fragments rejoined during grace become exactly one desk request."""
    import bot
    from unittest.mock import AsyncMock
    from pipecat.frames.frames import (
        InterruptionFrame, LLMContextFrame, UserStartedSpeakingFrame, UserStoppedSpeakingFrame,
        VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
    )
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.frame_processor import FrameDirection

    floor = bot.Floor()
    session = bot.ClaudeSession(floor)
    session.create_task = asyncio.create_task
    session.push_frame = AsyncMock()
    session._turn = AsyncMock()
    sender = asyncio.create_task(session._send_turns())
    original = bot.TURN_SILENCE
    bot.TURN_SILENCE = 0.08

    async def frame(value):
        await session.process_frame(value, FrameDirection.DOWNSTREAM)

    async def fragment(text):
        await frame(VADUserStoppedSpeakingFrame())
        await frame(UserStoppedSpeakingFrame())
        await frame(LLMContextFrame(LLMContext([{"role": "user", "content": text}])))

    try:
        await fragment("The first half")
        await asyncio.sleep(0.04)
        session._turn.assert_not_awaited()
        await frame(VADUserStartedSpeakingFrame())
        await frame(UserStartedSpeakingFrame())
        await asyncio.sleep(0.1)
        session._turn.assert_not_awaited()
        await fragment("  and   the second half. ")
        await asyncio.sleep(0.04)
        session._turn.assert_not_awaited()
        await asyncio.sleep(0.06)
        session._turn.assert_awaited_once_with("The first half and the second half.")
        await fragment("A separate full turn while the desk is busy.")
        await asyncio.sleep(0.1)
        assert session._turn.await_count == 2
        assert session._turn.await_args.args == ("A separate full turn while the desk is busy.",)
        assert not floor.pending_turn
        print("PASS: resumed speech merges completed fragments; one request per full turn, including while desk is busy")
        session._current = "The sentence he cut off."
        await frame(InterruptionFrame())
        await asyncio.sleep(0.1)
        assert session._turn.await_count == 2, "a cut-off became a desk turn of its own"
        await fragment("Next words.")
        await asyncio.sleep(0.1)
        assert session._turn.await_args.args[0].startswith("[note: he cut in")
        assert '"The sentence he cut off." was cut before he heard any of it' in session._turn.await_args.args[0]
        assert session._turn.await_args.args[0].endswith("was spoken] Next words.")
        await fragment("Later words.")
        await asyncio.sleep(0.1)
        assert session._turn.await_args.args == ("Later words.",)
        print("PASS: a cut-off sentence rides on his next turn once, never as its own desk turn")
    finally:
        bot.TURN_SILENCE = original
        for task in (sender, session._flusher, session._settler):
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task


async def check_barge_in():
    """He talks over the desk: nothing it wrote before is spoken after, and his turn says how far he heard."""
    import time
    import bot
    from unittest.mock import AsyncMock
    from pipecat.frames.frames import (
        InterruptionFrame, LLMContextFrame, UserStoppedSpeakingFrame, VADUserStartedSpeakingFrame,
        VADUserStoppedSpeakingFrame,
    )
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.frame_processor import FrameDirection

    floor = bot.Floor()
    session = bot.ClaudeSession(floor)
    session.create_task = asyncio.create_task
    session.push_frame = AsyncMock()
    session._turn = AsyncMock()
    sender = asyncio.create_task(session._send_turns())
    original = bot.TURN_SILENCE
    bot.TURN_SILENCE = 0.05

    async def frame(value):
        await session.process_frame(value, FrameDirection.DOWNSTREAM)

    def queued():
        out = []
        while not session._speech.empty():
            out.append(session._speech.get_nowait())
        return out

    try:
        session._heard = "Your new drive is in."
        session._current = "Should I wipe the old drive now?"  # 7 words, half of its 2 s heard
        session._started = time.monotonic() - 1.0 - bot.START_SECS
        floor.said = [2.0]
        for sentence in ("I'm also handing off the X feed.", "It needs a login."):
            session._speech.put_nowait(sentence)
        await frame(VADUserStartedSpeakingFrame())
        await frame(InterruptionFrame())
        assert queued() == [], "queued speech survived his barge-in"
        await session._desk_event({"text": "A late block from the same turn."})
        assert queued() == [], "a block written while he talks was queued"
        await frame(VADUserStoppedSpeakingFrame())
        await frame(UserStoppedSpeakingFrame())
        await frame(LLMContextFrame(LLMContext([{"role": "user", "content": "Yes, wipe it."}])))
        await asyncio.sleep(0.15)
        sent = session._turn.await_args.args[0]
        assert ('the last thing he heard in full was "Your new drive is in.", '
                'then "Should I wipe…" of "Should I wipe the old drive now?"') in sent, sent
        assert sent.endswith("was spoken] Yes, wipe it."), sent
        await session._desk_event({"text": "Still the old turn."})
        assert queued() == [], "text the desk wrote before reading his turn was queued"
        await session._desk_event({"prompt": True})
        await session._desk_event({"text": "Wiping it now."})
        assert queued() == ["Wiping it now."]
        print("PASS: barge-in drops held and stale speech; his turn names the last words he heard")

        session._speech.put_nowait("Next card.")
        await frame(VADUserStartedSpeakingFrame())
        assert queued() == []
        await frame(VADUserStoppedSpeakingFrame())
        await asyncio.sleep(bot.TURN_SILENCE + 1.2)
        assert queued() == ["Next card."], "a start with no words lost the held sentence"
        print("PASS: a start that brings no words gives the held speech back")

        start = time.monotonic()
        await floor.wait(0.1, since=start)
        assert time.monotonic() - start >= 0.1
        print("PASS: a spoken question holds the next sentence for quiet after it")
    finally:
        bot.TURN_SILENCE = original
        for task in (sender, session._flusher, session._settler):
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task


async def check_downstream_link():
    """Real push_frame: the greeting reaches the next processor (TTS), before and after he takes the floor.
    2026-11-05: ClaudeSession kept a sentence in `_next`, pipecat's downstream link, so nothing reached Kokoro."""
    import bot
    from unittest.mock import AsyncMock, MagicMock
    from pipecat.frames.frames import TTSSpeakFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame
    from pipecat.processors.frame_processor import FrameDirection

    floor = bot.Floor()
    session = bot.ClaudeSession(floor)
    session.create_task = asyncio.create_task
    tts = MagicMock()
    tts.queue_frame = AsyncMock()
    session.link(tts)
    speaker = asyncio.create_task(session._speak())

    def spoken():
        return [c.args[0].text for c in tts.queue_frame.await_args_list if isinstance(c.args[0], TTSSpeakFrame)]

    async def until(predicate):
        for _ in range(100):
            if predicate():
                return
            await asyncio.sleep(0.02)

    try:
        session._speech.put_nowait("Hey, it's your desk. What's up?")
        await until(spoken)
        assert spoken() == ["Hey, it's your desk. What's up?"], f"greeting never reached TTS: {spoken()}"
        session._played.set()
        await session.process_frame(VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await session.process_frame(VADUserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        assert session._next is tts, "taking the floor cut the link to TTS"
        print("PASS: spoken sentences reach the TTS processor; the downstream link survives his barge-in")
    finally:
        for task in (speaker, session._settler):
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task


async def check_synth_ahead():
    """The next sentence goes to TTS while the one before plays (no synthesis gap), never past a question, and a
    barge-in gives the synthesized-ahead sentence back with the held ones."""
    import bot
    from unittest.mock import AsyncMock, MagicMock
    from pipecat.frames.frames import (
        BotStartedSpeakingFrame, BotStoppedSpeakingFrame, InterruptionFrame, TTSSpeakFrame,
        VADUserStartedSpeakingFrame,
    )
    from pipecat.processors.frame_processor import FrameDirection

    floor = bot.Floor()
    floor.quiet_since -= 10
    session = bot.ClaudeSession(floor)
    session.create_task = asyncio.create_task
    session.push_frame = AsyncMock()
    speaker = asyncio.create_task(session._speak())
    original = bot.QUESTION_HOLD
    bot.QUESTION_HOLD = 0.1

    def spoken():
        return [c.args[0].text for c in session.push_frame.await_args_list if isinstance(c.args[0], TTSSpeakFrame)]

    async def frame(value):
        await session.process_frame(value, FrameDirection.DOWNSTREAM)

    try:
        await session._desk_event({"text": "One. Two. Is three a question? Four. ..."})
        await asyncio.sleep(0.05)
        assert spoken() == ["One.", "Two."], f"second sentence not synthesized ahead: {spoken()}"
        await frame(BotStartedSpeakingFrame())
        await frame(BotStoppedSpeakingFrame())
        await asyncio.sleep(0.05)
        assert session._heard == "One." and session._current == "Two."
        assert spoken() == ["One.", "Two.", "Is three a question?"], spoken()
        await frame(BotStoppedSpeakingFrame())
        await asyncio.sleep(0.05)
        assert spoken()[-1] == "Is three a question?", f"pushed past a question: {spoken()}"
        await frame(BotStoppedSpeakingFrame())
        await asyncio.sleep(0.05)
        assert spoken()[-1] == "Is three a question?", "no QUESTION_HOLD after the question"
        await asyncio.sleep(0.15)
        assert spoken()[-1] == "Four.", f"speech after the question never resumed: {spoken()}"
        assert session._speech.empty(), "a sentence with no words was queued"
        print("PASS: the next sentence is synthesized while one plays; a question still holds what follows")

        await frame(BotStoppedSpeakingFrame())
        session._speech.put_nowait("Five.")
        session._speech.put_nowait("Six.")
        await asyncio.sleep(0.05)
        assert spoken()[-2:] == ["Five.", "Six."]
        await frame(BotStartedSpeakingFrame())
        await frame(VADUserStartedSpeakingFrame())
        await frame(InterruptionFrame())
        assert session._taken[1] == "Five." and session._held == ["Six."], (session._taken, session._held)
        assert not floor.said and session._current is None and session._ahead is None
        print("PASS: a barge-in cuts the playing sentence and holds the one synthesized ahead")
    finally:
        bot.QUESTION_HOLD = original
        for task in (speaker, session._settler):
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task


def test_checks():
    """pytest entry for the fast regressions (`--check`); the live WebRTC modes stay manual."""
    assert asyncio.run(check_floor()) == 0


if __name__ == "__main__":
    sys.exit(asyncio.run(check_floor() if "--check" in sys.argv else
                         turn_taking() if "--turn-taking" in sys.argv else main()))
