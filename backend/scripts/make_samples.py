"""Bake the built-in sample scenes the frontend loads without a backend.

Run from backend/:  MOCK_MODE=1 .venv/bin/python -m scripts.make_samples
Input:  four photos from testing/photos (see SAMPLES).
Output: frontend/public/samples/<name>/
  photo.jpg    the photo as POST /relight/scene would return it
  depth.png    grayscale, white = near
  normals.png  RGB, each axis mapped -1..1 -> 0..255
  thumb.jpg    small preview for the sample row on the first page
  scene.json   {"width", "height", "relief"}

Each photo goes through the same steps as POST /relight/scene with detail on
(same resize limit, same models, same PNG encodings), so a sample looks exactly
like the same photo uploaded to a running backend. Only local models are used.
"""

import io
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from app.ideas import relight as R
from app.images import resize_max_side, to_rgb
from app.routers.relight import MAX_SIDE

ROOT = Path(__file__).resolve().parents[2]
PHOTOS = ROOT / "testing" / "photos"
OUT = ROOT / "frontend" / "public" / "samples"

# Sample name (the folder the frontend asks for) -> source photo.
SAMPLES = {
    "portrait": "01-portrait-astronaut.jpg",
    "coffee": "02-object-coffee.jpg",
    "cat": "03-animal-cat.jpg",
    "rocket": "04-dark-rocket.jpg",
}

# Same quality as images.encode_image, which the endpoint uses for the photo.
PHOTO_QUALITY = 92
# The sample row shows thumbnails about 150 px wide; 320 keeps them sharp on a
# high-density screen for roughly 15 KB each.
THUMB_WIDTH = 320
THUMB_QUALITY = 80
# The repository and a static deployment carry these files, so a sample that
# grows past this is reported instead of slipping in unnoticed.
MAX_SAMPLE_BYTES = 600 * 1024


def _png(img: Image.Image) -> bytes:
    # optimize only makes zlib try harder: the pixels are the endpoint's, bit for bit.
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _jpeg(img: Image.Image, quality: int) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def bake(name: str, source: Path) -> int:
    """Write one sample folder; returns its total size in bytes."""
    img = Image.open(source)
    img.load()
    img = resize_max_side(to_rgb(ImageOps.exif_transpose(img)), MAX_SIDE)

    height = R.estimate_height(img)
    normals = R.estimate_normals(img)
    geom = R.build_geometry(height, normals=normals)
    # The two encodings below are copied from routers/relight.py scene().
    depth_png = Image.fromarray((geom.z / geom.relief * 255.0 + 0.5).astype(np.uint8))
    normals_png = Image.fromarray(((geom.normals * 0.5 + 0.5) * 255.0 + 0.5).astype(np.uint8))

    thumb = img.resize((THUMB_WIDTH, max(1, round(THUMB_WIDTH * img.height / img.width))), Image.LANCZOS)
    files = {
        "photo.jpg": _jpeg(img, PHOTO_QUALITY),
        "depth.png": _png(depth_png),
        "normals.png": _png(normals_png),
        "thumb.jpg": _jpeg(thumb, THUMB_QUALITY),
        "scene.json": (json.dumps({"width": img.width, "height": img.height, "relief": geom.relief}) + "\n").encode(),
    }
    folder = OUT / name
    folder.mkdir(parents=True, exist_ok=True)
    for filename, data in files.items():
        (folder / filename).write_bytes(data)
    total = sum(len(data) for data in files.values())
    sizes = ", ".join(f"{filename} {len(data) / 1024:.0f} KB" for filename, data in files.items())
    print(f"{name}: {img.width} x {img.height}, {total / 1024:.0f} KB ({sizes})")
    return total


def main() -> None:
    too_big = []
    for name, filename in SAMPLES.items():
        if bake(name, PHOTOS / filename) > MAX_SAMPLE_BYTES:
            too_big.append(name)
    print(f"wrote {len(SAMPLES)} samples to {OUT.relative_to(ROOT)}")
    if too_big:
        raise SystemExit(f"over {MAX_SAMPLE_BYTES // 1024} KB: {', '.join(too_big)}")


if __name__ == "__main__":
    main()
