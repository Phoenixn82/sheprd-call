"""After a call (on the voice host): re-transcribe the caller's saved turns with the most accurate model and tell the
desk what the live model missed or misheard, their words verbatim (2026-11-05: "ensure that what I said was correct").

  python recheck.py CALL_DIR      bot.py starts this, niced, when a call ends; also prunes calls past KEEP_DAYS
  python recheck.py self-check

CALL_DIR holds NNN.wav (one per live STT segment) and NNN.live (what the live model heard). The corrected turns go to
the bridge's POST /recheck: one desk message marked as a corrected transcript, plus a notice line (VOICE_NOTIFY on the
bridge) when something meaningful was missed. Also written to CALL_DIR/recheck.txt. No LLM touches the words.
"""

import datetime
import difflib
import json
import os
import shutil
import sys
import time
import urllib.request
from pathlib import Path

from stt_eval import VOCAB, has, norm, read_wav, transcriber

MODEL = os.environ.get("VOICE_RECHECK_MODEL", "large-v3")
HINT = os.environ.get("VOICE_RECHECK_HINT", "prompt")
DESK_URL = os.environ.get("VOICE_SESSION_URL", "http://127.0.0.1:7863")
KEEP_DAYS = 14  # 2026-11-05: call audio is kept two weeks


def changes(live, best):
    """(live words, best words) for each span that differs, case and punctuation ignored."""
    a, b = norm(live), norm(best)
    ops = difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()
    return [(" ".join(a[i1:i2]), " ".join(b[j1:j2])) for op, i1, i2, j1, j2 in ops if op != "equal"]


def report(when, turns):
    """turns: [(n, live, best)] -> (desk message or "", notice line or "")."""
    lines, missed = [], 0
    for n, live, best in turns:
        diff = changes(live, best)
        if not best.strip() or not diff:  # offline heard nothing: never claim he said nothing
            continue
        lines.append(f'turn {n + 1}: "{best.strip()}"\n  (live heard: "{live.strip()}")')
        missed += sum(len(b.split()) for _, b in diff) + sum(any(has(t, x) for t in VOCAB) for pair in diff
                                                             for x in pair) * 3
    if not lines:
        return "", ""
    message = (f"[call recheck] Corrected transcript of the {when} call: a slower, more accurate pass ({MODEL}) over "
               f"his saved audio found words the live transcript missed or misheard. His words verbatim, only the "
               f"turns that differed; read them as what he actually said:\n" + "\n".join(lines))
    notice = (f"Call {when}: the live transcript missed or misheard words in {len(lines)} turn"
             f"{'s' * (len(lines) > 1)}; the corrected transcript went to the desk.") if missed >= 3 else ""
    return message, notice


def prune(root):
    cutoff = time.time() - KEEP_DAYS * 86400
    for d in root.iterdir():
        if d.is_dir() and d.stat().st_mtime < cutoff:
            shutil.rmtree(d, ignore_errors=True)


def load():
    try:
        return transcriber(MODEL, HINT)
    except (RuntimeError, ValueError) as error:  # GPU busy or out of memory: slower is fine here
        print(f"GPU load failed ({error}); CPU int8", flush=True)
        os.environ.update(VOICE_STT_DEVICE="cpu", VOICE_STT_COMPUTE="int8")
        return transcriber(MODEL, HINT)


def main(call_dir):
    turns = sorted(call_dir.glob("*.wav"))
    if turns:
        go = load()
        rows = [(int(w.stem), w.with_suffix(".live").read_text() if w.with_suffix(".live").exists() else "",
                 go(read_wav(w)).strip()) for w in turns]
        when = f"{datetime.datetime.strptime(call_dir.name, '%Y-%m-%d_%H%M%S'):%-I:%M %p}"
        message, notice = report(when, rows)
        (call_dir / "recheck.txt").write_text(message or "no differences\n")
        if message:
            req = urllib.request.Request(DESK_URL + "/recheck", json.dumps({"text": message, "notice": notice}).encode(),
                                         {"Content-Type": "application/json", "X-Sheprd": "1"})  # shown.CLIENT
            with urllib.request.urlopen(req, timeout=30) as r:
                print(f"desk: {r.status}", flush=True)
    prune(call_dir.parent)


def self_check():
    assert changes("Open the her door tab.", "Open the Herdr tab.") == [("her door", "herdr")]
    assert changes("Okay, go ahead.", "okay go ahead") == []
    msg, notice = report("6:21 PM", [(0, "Open the her door tab.", "Open the Herdr tab."),
                                    (1, "Yeah.", "Yeah."), (2, "noise", "")])
    assert 'turn 1: "Open the Herdr tab."' in msg and "turn 2" not in msg and "turn 3" not in msg, msg
    assert notice.startswith("Call 6:21 PM:") and "1 turn;" in notice, notice
    assert report("x", [(0, "Check the logs", "check the log")])[1] == ""  # one small word: desk only, no notice
    print("ok")


if __name__ == "__main__":
    self_check() if sys.argv[1] == "self-check" else main(Path(sys.argv[1]))
