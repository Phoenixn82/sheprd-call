"""UI snapshots and call-channel change notices; no voice code or service restarts."""

import asyncio
import hashlib
import json
import logging
from pathlib import Path
import re

HERE = Path(__file__).parent
ASSET = re.compile(r"[a-z]+\.(js|css)")


def snapshot(root=HERE):
    def read(path):
        if path.is_symlink() or not path.is_file():
            raise OSError(f"UI file is unavailable: {path.name}")
        return path.read_text()

    assets = {}
    for folder, prefix in ((root / "world", ""), (root / "world" / "games", "games/")):
        if folder.is_symlink():
            raise OSError("UI asset directory is a symlink")
        for path in sorted(folder.iterdir()):
            if ASSET.fullmatch(path.name) and (not prefix or path.suffix == ".js"):
                assets[prefix + path.name] = read(path)
    payload = {"html": read(root / "call.html"), "assets": assets}
    revision = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    return {"revision": revision, **payload}


async def changes(root=HERE, interval=1):
    """Initial revision, then one notice after two matching scans settle a file copy."""
    sent = pending = None
    while True:
        try:
            revision = (await asyncio.to_thread(snapshot, root))["revision"]
            if sent is None or revision == pending and revision != sent:
                sent = revision
                yield {"type": "ui-update", "revision": revision}
            pending = revision
        except (OSError, UnicodeError):
            pending = None
            logging.exception("Could not read the call UI; keeping the current screen")
        await asyncio.sleep(interval)
