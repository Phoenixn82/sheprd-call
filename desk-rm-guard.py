#!/usr/bin/env python3
"""Desk PreToolUse hook (Bash). Claude Code's built-in "Dangerous rm ... statically-unresolvable target" check asks
Yes/No even in bypass mode and cannot be allowed by rules or hooks (tested 2026-11-07). On the desk nobody is at the
screen, so that prompt froze every voice turn ("I couldn't reach the desk"). This denies those commands up front with
the rewrite that passes the check (absolute-path glob or find -delete), so the agent retries instead of blocking.
Self-check: python3 desk-rm-guard.py --check"""
import json
import re
import sys

RM = re.compile(r"(?:^|[;&|(\s])(rm|rmdir)\s+((?:[^;&|\n])*)")
CD = re.compile(r"(?:^|[;&|(\s])(cd|pushd)\s")


def risky(cmd):
    """True when a removal's glob target is relative and a cd/pushd or $(...) makes it unresolvable."""
    for m in RM.finditer(cmd):
        before = cmd[:m.start()]
        for arg in m.group(2).split():
            if arg.startswith("-") or not re.search(r"[*?\[]", arg):
                continue
            if "$(" in arg or "`" in arg:
                return True
            if not arg.lstrip("\"'").startswith(("/", "~", "$")) and CD.search(before):
                return True
    return False


REASON = ("Blocked before Claude Code's unresolvable-rm prompt (that prompt freezes the voice desk). Same deletion, "
          "absolute target: rm -f \"$DIR\"/* or find \"$DIR\" -mindepth 1 -delete (no cd before a relative glob, no "
          "$(...) in the target). Rerun it that way.")


def main():
    cmd = (json.load(sys.stdin).get("tool_input") or {}).get("command", "")
    if risky(cmd):
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                 "permissionDecisionReason": REASON}}))


def check():
    bad = ['S=/tmp/x; mkdir -p $S/dl && cd $S/dl && rm -f * && ls', "cd /tmp/a; rm -rf build/*", "rm -f $(pwd)/*",
           "pushd d && rm *.mp4"]
    ok = ['rm -f "$S"/dl/*', "find \"$S/dl\" -mindepth 1 -delete", "cd /tmp/a && rm -f one.txt", "rm -rf /tmp/a/*",
          "ls *.py", "git rm -r --cached x", "echo cd && rm ~/x/*"]
    assert all(risky(c) for c in bad), [c for c in bad if not risky(c)]
    assert not any(risky(c) for c in ok), [c for c in ok if risky(c)]
    print("desk-rm-guard ok")


if __name__ == "__main__":
    check() if sys.argv[1:] == ["--check"] else main()
