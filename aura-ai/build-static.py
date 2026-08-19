"""Assemble the web app for a plain web host (no Python server, no Android shell).

Copies web/ then overlays web-static/, which adds the two things static hosting needs and
the other two modes generate for themselves: a config.js pointing at direct mode, and a
screen to type the API key into. The key still never lands in a built file — it goes to the
phone's localStorage — so the output is safe to upload anywhere.

    python aura-ai/build-static.py

Writes aura-ai/dist-web/, ready to drop on the host.
"""

import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
STATIC = ROOT / "web-static"
DIST = ROOT / "dist-web"

# Added to index.html, in load order. config.js is already referenced by index.html — it just
# doesn't exist as a file until this build puts one there.
INJECT_CSS = "setup.css"
INJECT_JS = "setup.js"


def main() -> int:
    for src in (WEB, STATIC):
        if not src.is_dir():
            print(f"error: {src} is missing", file=sys.stderr)
            return 1

    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(WEB, DIST)

    for item in STATIC.iterdir():
        shutil.copy2(item, DIST / item.name)

    index = DIST / "index.html"
    html = index.read_text(encoding="utf-8")

    if INJECT_CSS not in html:
        html = html.replace(
            '<link rel="stylesheet" href="style.css" />',
            '<link rel="stylesheet" href="style.css" />\n  '
            f'<link rel="stylesheet" href="{INJECT_CSS}" />',
            1,
        )

    # After config.js so the stored key is already on window.AuraConfig when it runs.
    if INJECT_JS not in html:
        html = html.replace(
            '<script src="config.js"></script>',
            '<script src="config.js"></script>\n  '
            f'<script src="{INJECT_JS}"></script>',
            1,
        )

    index.write_text(html, encoding="utf-8")

    # A missing tag means index.html changed shape and the injection silently did nothing,
    # which would ship a build with no way to enter a key.
    for needle in (INJECT_CSS, INJECT_JS):
        if not re.search(rf'"{re.escape(needle)}"', html):
            print(f"error: couldn't inject {needle} into index.html", file=sys.stderr)
            return 1

    files = sum(1 for p in DIST.rglob("*") if p.is_file())
    size = sum(p.stat().st_size for p in DIST.rglob("*") if p.is_file())
    print(f"built {DIST}  ({files} files, {size / 1_048_576:.1f} MB)")
    print("upload the contents to the host, then open it on the phone and paste the key.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
