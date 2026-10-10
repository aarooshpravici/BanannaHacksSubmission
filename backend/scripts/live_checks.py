"""Live check: make one real call to the hosted image service and save what comes back.

Everything else in this repo is tested with stand-ins. This script is the real
use of the keys in .env, so run it before trusting the Enhance button.

Run from backend/:
    .venv/bin/python -m scripts.live_checks

It uses whichever image service is active: Gemini if it has a key, otherwise
fal (see IMAGE_PROVIDER in .env).
    enhance  1 realistic re-render of the relit portrait preview   (1 image call)
The result is cached, so re-running a check that already worked costs nothing.
Gemini image calls are capped by GEMINI_IMAGE_CALL_LIMIT (see .cache/spend.json).
The output image goes to proofs/live/relight_enhance.jpg.
"""

import os
import sys
import time
import traceback
from pathlib import Path

os.environ["MOCK_MODE"] = "0"  # before app.config is imported

from PIL import Image, ImageDraw  # noqa: E402

from app.config import get_settings  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "proofs" / "live"


def _sheet(tiles: list[tuple[str, Image.Image]], path: Path, height: int = 420) -> None:
    scaled = []
    for label, img in tiles:
        img = img.convert("RGB")
        img = img.resize((round(img.width * height / img.height), height), Image.LANCZOS)
        d = ImageDraw.Draw(img)
        d.rectangle((0, 0, 10 + 7 * len(label), 18), fill=(0, 0, 0))
        d.text((4, 3), label, fill=(255, 255, 255))
        scaled.append(img)
    sheet = Image.new("RGB", (sum(t.width for t in scaled), height), (30, 30, 30))
    x = 0
    for t in scaled:
        sheet.paste(t, (x, 0))
        x += t.width
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, quality=90)
    print(f"   saved {path}")


def check_enhance() -> None:
    from skimage import data

    from app.ideas import relight as R
    from app.providers import generation

    img = Image.fromarray(data.astronaut())
    geom = R.build_geometry(R.estimate_height(img), normals=R.estimate_normals(img))
    preview = R.relight(img, geom, R.Light(-0.4, 0.25, height=0.25, intensity=1.5, ambient=0.12))
    enhanced = generation.relight_enhance(preview, "portrait photo, dramatic light from the left, realistic", light_from="Left")
    _sheet([("original", img), ("our preview, light left", preview), ("after Enhance", enhanced)], OUT / "relight_enhance.jpg")
    print("   LOOK AT: is the light still coming from the left, and is it still the same person?")


if __name__ == "__main__":
    from app.providers.generation import provider

    key = provider()
    if not get_settings().configured()[key]:
        print(f"[skip] enhance: no {key} key in .env")
        sys.exit(0)
    print("[run ] enhance ...")
    start = time.time()
    try:
        check_enhance()
        print(f"[ ok ] enhance ({time.time() - start:.0f}s)")
    except Exception:  # a smoke-test runner: report whatever went wrong
        print(f"[FAIL] enhance:\n{traceback.format_exc(limit=3)}")
        sys.exit(1)
