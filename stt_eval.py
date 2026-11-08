"""Word accuracy of call STT models (on the voice host). Build a clip set, then score one model per run.

  python stt_eval.py build DIR                  Kokoro clips of SET (several voices, half with noise), 16 kHz
  python stt_eval.py run DIR MODEL [HINT]       MODEL: a faster-whisper name, parakeet:<onnx-asr id> or qwen:<hf id>
                                                HINT: none | prompt | hotwords (faster-whisper only)
  python stt_eval.py self-check

DIR holds NNN.wav + NNN.txt (reference). Saved call turns (calls/<id>/NNN.wav) gain a reference by writing NNN.txt
next to them by hand, so real calls join the set. Prints WER, vocab hits, hint words that appear where the reference
has none (hallucination), and median ms per clip. faster-whisper runs pin device via VOICE_STT_DEVICE_INDEX.
"""

import json
import os
import re
import statistics
import sys
import time
import wave
from pathlib import Path

import numpy as np

# Whisper decoding for the call and the recheck (2026-11-05: two desk turns ended in "this kind of this kind of..."
# x9 and "and, and, and"). No conditioning on its own previous text, so one bad window cannot seed a loop in the
# next; Silero cuts silence out and splits a long turn at its pauses (< 30 s chunks), where runaway loops start.
# faster-whisper's compression-ratio / log-prob / no-speech fallback ladder stays at its defaults.
DECODE = {"language": "en", "condition_on_previous_text": False, "vad_filter": True,
          "vad_parameters": {"min_silence_duration_ms": 500, "speech_pad_ms": 300}}


def unloop(text):
    """Collapse runaway repeats to one copy: the same 2-8 words three or more times in a row, or one word four or
    more times ("no no no" stays). Exact repeats only (case and punctuation ignored); nothing else changes."""
    words = text.split()
    key = [re.sub(r"[^a-z0-9']", "", w.lower()) for w in words]
    out, i = [], 0
    while i < len(words):
        for n in range(1, 9):  # shortest period first: 10 copies of "this kind of" collapse to one
            k = 1
            while key[i:i + n] == key[i + k * n:i + (k + 1) * n] and all(key[i:i + n]):
                k += 1
            if k >= (4 if n == 1 else 3):
                out += words[i + (k - 1) * n:i + k * n]  # the last copy keeps the sentence's own punctuation
                i += k * n
                break
        else:
            out.append(words[i])
            i += 1
    return " ".join(out)

# The words the desk must get right, the live hint (bot.py imports PROMPT) and the eval set: (what Kokoro says, the
# reference). Spoken forms spell the caller's pronunciation; references spell the word they mean. This generic sample
# stands in until VOICE_STT_VOCAB names a JSON file {"vocab": [...], "prompt": str, "set": [[spoken, ref], ...]}
# (each key optional) with your own names: project, people and machine names are what speech recognition gets wrong.
# SET keeps this shape: 0-16 hint-word lines, 17-22 long natural sentences (build's long turns), then short replies.
VOCAB = ["Herdr", "Shepherd", "Claude", "Codex", "Pipecat", "Kokoro", "Whisper", "Silero", "Tailscale", "GitHub",
         "pytest", "Postgres", "Redis", "nginx", "systemd", "Kubernetes"]
SET = [
    ("What's going out onto herder right now?", "What's going out onto Herdr right now?"),
    ("Have the shepherd tab pull before it deploys.", "Have the Shepherd tab pull before it deploys."),
    ("Let Codex build it and have Claude review the diff.", "Let Codex build it and have Claude review the diff."),
    ("Is the pipe cat bot still running?", "Is the Pipecat bot still running?"),
    ("Switch the voice to ko-ko-ro and make it a bit faster.", "Switch the voice to Kokoro and make it a bit faster."),
    ("Run the whisper model on the GPU this time.", "Run the Whisper model on the GPU this time."),
    ("Does silly-ro still cut off the end of my sentences?", "Does Silero still cut off the end of my sentences?"),
    ("Check that tail scale is up on the server.", "Check that Tailscale is up on the server."),
    ("Open a pull request on git hub for the fix.", "Open a pull request on GitHub for the fix."),
    ("Run pie test on the parser before you push.", "Run pytest on the parser before you push."),
    ("Back up the post-gres database tonight.", "Back up the Postgres database tonight."),
    ("Flush the reddis cache and try again.", "Flush the Redis cache and try again."),
    ("The engine X config needs a new route.", "The nginx config needs a new route."),
    ("Restart the system D unit after the deploy.", "Restart the systemd unit after the deploy."),
    ("Scale the cooper-netties pods down to one.", "Scale the Kubernetes pods down to one."),
    ("Ask Claude which tab is blocked.", "Ask Claude which tab is blocked."),
    ("Tell Codex the tests are green now.", "Tell Codex the tests are green now."),
    ("Hey, let's keep going on everything that we need to do today. What else is there that you need me to look at?",
     "Hey, let's keep going on everything that we need to do today. What else is there that you need me to look at?"),
    ("I think the login page broke after the last change, so check the logs before you touch anything else.",
     "I think the login page broke after the last change, so check the logs before you touch anything else."),
    ("It can add punctuation, but I don't want it to change my words or summarize what I'm saying.",
     "It can add punctuation, but I don't want it to change my words or summarize what I'm saying."),
    ("When the build finishes, tell me how long it took and whether any of the tests were flaky.",
     "When the build finishes, tell me how long it took and whether any of the tests were flaky."),
    ("Write the release notes in plain words and keep them short, nobody reads the long ones.",
     "Write the release notes in plain words and keep them short, nobody reads the long ones."),
    ("Let's leave the refactor for tomorrow and just fix the bug that people are hitting right now.",
     "Let's leave the refactor for tomorrow and just fix the bug that people are hitting right now."),
    ("Yeah.", "Yeah."),
    ("No, the other one.", "No, the other one."),
    ("Okay, go ahead.", "Okay, go ahead."),
    ("Wait, stop. Say that last part again.", "Wait, stop. Say that last part again."),
    ("Schedule the backup for two in the morning and ping me if it fails.",
     "Schedule the backup for two in the morning and ping me if it fails."),
    ("The weather's nice, I'm going to sit outside for a while.",
     "The weather's nice, I'm going to sit outside for a while."),
]
VOCAB_FILE = Path(os.environ.get("VOICE_STT_VOCAB", "~/.config/shepherd/stt-vocab.json")).expanduser()
try:
    OWN = json.loads(VOCAB_FILE.read_text())
except FileNotFoundError:
    OWN = {}
except (OSError, ValueError) as error:  # a broken file must not take the call down: say so and use the sample
    print(f"stt_eval: {VOCAB_FILE} unreadable ({error}); using the generic sample", file=sys.stderr)
    OWN = {}
VOCAB = OWN.get("vocab", VOCAB)
SET = [tuple(pair) for pair in OWN.get("set", SET)]
PROMPT = OWN.get("prompt") or "The caller talks to the desk about " + ", ".join(VOCAB) + "."
VOICES = ["am_michael", "am_adam", "am_eric", "am_puck", "bm_george", "am_liam"]


def norm(text):
    return re.sub(r"[^a-z0-9' ]+", " ", text.lower().replace("-", " ")).split()


def wer(ref, hyp):
    r, h = norm(ref), norm(hyp)
    d = list(range(len(h) + 1))
    for i, rw in enumerate(r, 1):
        prev, d[0] = d[0], i
        for j, hw in enumerate(h, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (rw != hw))
    return d[len(h)], len(r)


def has(term, text):
    return "".join(norm(term)) in "".join(norm(text))


def score(rows, terms=None):
    terms = VOCAB if terms is None else terms
    errors = sum(wer(r, h)[0] for r, h, _ in rows)
    words = sum(wer(r, h)[1] for r, h, _ in rows)
    vocab = [(t, has(t, h)) for r, h, _ in rows for t in terms if has(t, r)]
    # ponytail: substring check, so "cat" inside "Pipecat" counts; fine for this set, word-boundary if it misleads
    ghosts = [(t, h) for r, h, _ in rows for t in terms if has(t, h) and not has(t, r)]
    return {"wer": round(100 * errors / max(words, 1), 2), "vocab_hit": f"{sum(ok for _, ok in vocab)}/{len(vocab)}",
            "vocab_missed": sorted({t for t, ok in vocab if not ok}), "ghosts": ghosts,
            "median_ms": round(statistics.median(ms for *_, ms in rows), 1),
            "p90_ms": round(sorted(ms for *_, ms in rows)[int(0.9 * len(rows))], 1)}


def read_wav(path):
    with wave.open(str(path)) as w:
        assert w.getframerate() == 16000 and w.getsampwidth() == 2 and w.getnchannels() == 1, path
        return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768


def write_wav(path, audio):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(16000)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())


def build(out):
    from kokoro_onnx import Kokoro
    from pipecat.services.kokoro.tts import KOKORO_CACHE_DIR, _ensure_model_files

    model, voices = KOKORO_CACHE_DIR / "kokoro-v1.0.onnx", KOKORO_CACHE_DIR / "voices-v1.0.bin"
    _ensure_model_files(model, voices)
    tts, rng, n = Kokoro(str(model), str(voices)), np.random.default_rng(7), 0
    out.mkdir(parents=True, exist_ok=True)
    for i, (spoken, ref) in enumerate(SET):
        for variant in range(2):
            voice = VOICES[(2 * i + variant) % len(VOICES)]
            samples, sr = tts.create(spoken, voice=voice, lang="en-gb" if voice[0] == "b" else "en-us",
                                     speed=1.0 + 0.15 * variant)
            audio = np.interp(np.arange(0, len(samples), sr / 16000), np.arange(len(samples)), samples)
            audio = np.concatenate([np.zeros(4000), audio, np.zeros(8000)])  # VAD-like lead and tail
            if variant:  # room noise at ~15 dB SNR
                audio = audio + rng.normal(0, np.sqrt(np.mean(audio ** 2) / 10 ** 1.5), len(audio))
            write_wav(out / f"{n:03d}.wav", audio)
            (out / f"{n:03d}.txt").write_text(ref)
            n += 1
    for k, voice in enumerate(["am_michael", "am_adam"]):  # long turns, his pace: sentences with short pauses
        parts = []
        for spoken, _ in SET[17:23] + SET[:6] * (k + 1):
            samples, sr = tts.create(spoken, voice=voice, lang="en-us", speed=1.1)
            parts += [np.interp(np.arange(0, len(samples), sr / 16000), np.arange(len(samples)), samples),
                      np.zeros(int(16000 * rng.uniform(0.3, 0.7)))]
        write_wav(out / f"{n:03d}.wav", np.concatenate(parts + [np.zeros(16000 * 2)]))  # 2 s trailing silence
        (out / f"{n:03d}.txt").write_text(" ".join(ref for _, ref in SET[17:23] + SET[:6] * (k + 1)))
        n += 1
    for k in range(4):  # no speech at all: hint words must not appear
        write_wav(out / f"{n:03d}.wav", rng.normal(0, 0.01 * (k + 1), 16000 * 2))
        (out / f"{n:03d}.txt").write_text("")
        n += 1
    print(f"{n} clips in {out}")


def transcriber(model_name, hint):
    if model_name.startswith("parakeet:"):
        import onnx_asr

        # A real directory: onnxruntime refuses external weights behind the Hugging Face cache's symlinks.
        m = onnx_asr.load_model(model_name[9:], Path.home() / "stt-eval/models" / model_name[9:],
                                providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
        return lambda a: m.recognize(a, sample_rate=16000)
    if model_name.startswith("qwen:"):
        import torch
        from qwen_asr import Qwen3ASRModel

        m = Qwen3ASRModel.from_pretrained(model_name[5:], dtype=torch.float16, device_map="cuda:0")
        ctx = PROMPT if hint != "none" else ""
        return lambda a: m.transcribe(audio=(a, 16000), language="English", context=ctx)[0].text
    from faster_whisper import WhisperModel

    m = WhisperModel(model_name, device=os.environ.get("VOICE_STT_DEVICE", "cuda"),
                     device_index=int(os.environ.get("VOICE_STT_DEVICE_INDEX", "0")),
                     compute_type=os.environ.get("VOICE_STT_COMPUTE", "float16"))
    kw = {"prompt": {"initial_prompt": PROMPT}, "hotwords": {"hotwords": PROMPT}}.get(hint, {})

    decode = {"language": "en"} if os.environ.get("VOICE_EVAL_OLD_DECODE") else DECODE  # pre-11-05 baseline

    def run(a):  # the call's decode: beam 5, no_speech_prob 0.4 filter, runaway repeats collapsed
        segments, _ = m.transcribe(a, **decode, **kw)
        text = " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.4)
        return text if os.environ.get("VOICE_EVAL_OLD_DECODE") else unloop(text)
    return run


def run(clips, model_name, hint="none"):
    go = transcriber(model_name, hint)
    files = sorted(p for p in clips.glob("*.wav") if p.with_suffix(".txt").exists())
    go(read_wav(files[0]))  # warm-up, excluded
    rows = []
    for f in files:
        audio = read_wav(f)
        start = time.perf_counter()
        hyp = go(audio).strip()
        rows.append((f.with_suffix(".txt").read_text(), hyp, (time.perf_counter() - start) * 1000))
    result = {"model": model_name, "hint": hint, **score(rows),
              "misses": [(r, h) for r, h, _ in rows if wer(r, h)[0]]}
    print(json.dumps(result, indent=1))


def self_check():
    loop = "I was thinking about this kind of " + "this kind of " * 9 + "this kind."
    assert unloop(loop) == "I was thinking about this kind of this kind.", unloop(loop)
    assert unloop("worked on, and, and, and, and, and the rest") == "worked on, and the rest"
    assert unloop("No no no, the other one.") == "No no no, the other one."
    assert unloop("I said that. I said that.") == "I said that. I said that."
    assert wer("Open the Herdr tab.", "open the herdr tab") == (0, 4)
    assert wer("Open the Herdr tab.", "open the her door tab") == (2, 4)
    assert has("Pipecat", "is the pipe cat bot running") and not has("Kokoro", "cocoa row")
    s = score([("Scale Kubernetes.", "Scale Cooper Netties.", 10), ("", "Codex.", 30)], ["Kubernetes", "Codex"])
    assert s["vocab_hit"] == "0/1" and s["ghosts"] == [("Codex", "Codex.")] and s["median_ms"] == 20, s
    print("ok")


if __name__ == "__main__":
    cmd, *rest = sys.argv[1:]
    {"build": lambda d: build(Path(d)), "run": lambda d, *a: run(Path(d), *a), "self-check": self_check}[cmd](*rest)
