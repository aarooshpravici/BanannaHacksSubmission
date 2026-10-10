"""Relight proof: run the pipeline on sample photos and save contact sheets.

Run from backend/:  .venv/bin/python -m scripts.proof_relight
Output: proofs/relight/<name>.jpg, one sheet per photo:
  row 1: original | depth | normals from depth | normals from Marigold
  row 2: relit with depth-derived normals (the original plan): left, right, top, low warm
  row 3: relit with Marigold normals: the same four lights
"""

import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from skimage import data

from app.ideas import relight as R

OUT = Path(__file__).resolve().parents[2] / "proofs" / "relight"

LIGHTS = {
    "left": R.Light(-0.4, 0.25, height=0.25, intensity=1.5, ambient=0.12),
    "right": R.Light(1.4, 0.25, height=0.25, intensity=1.5, ambient=0.12),
    "top": R.Light(0.5, -0.5, height=0.25, intensity=1.5, ambient=0.12),
    "low left, warm": R.Light(-0.3, 0.9, height=0.15, intensity=1.7, ambient=0.1, color=(1.0, 0.84, 0.64)),
}


def _label(img: Image.Image, text: str) -> Image.Image:
    img = img.convert("RGB").copy()
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, 8 + 7 * len(text), 18), fill=(0, 0, 0))
    d.text((4, 3), text, fill=(255, 255, 255))
    return img


def _gray(a: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))


def sheet(name: str, img: Image.Image) -> None:
    t0 = time.perf_counter()
    height = R.estimate_height(img)
    t1 = time.perf_counter()
    marigold = R.estimate_normals(img)
    t2 = time.perf_counter()
    plain, detailed = R.build_geometry(height), R.build_geometry(height, normals=marigold)
    t3 = time.perf_counter()
    rows = [
        [
            _label(img, "original"),
            _label(_gray(height), "depth (white = near)"),
            _label(R.normals_preview(plain), "normals from depth"),
            _label(R.normals_preview(detailed), "normals from Marigold"),
        ]
    ]
    for tag, geom in (("depth normals", plain), ("Marigold normals", detailed)):
        rows.append([_label(R.relight(img, geom, light), f"{tag}, light {label}") for label, light in LIGHTS.items()])
    per_light = (time.perf_counter() - t3) / (2 * len(LIGHTS))
    print(
        f"{name}: {img.size}  depth {t1 - t0:.2f}s  Marigold normals {t2 - t1:.2f}s  "
        f"relight {per_light * 1000:.0f} ms per light"
    )
    w, h = img.size
    out = Image.new("RGB", (w * 4, h * len(rows)))
    for r, row in enumerate(rows):
        for c, tile in enumerate(row):
            out.paste(tile, (c * w, r * h))
    OUT.mkdir(parents=True, exist_ok=True)
    out.save(OUT / f"{name}.jpg", quality=88)


if __name__ == "__main__":
    R.estimate_normals(Image.new("RGB", (64, 64)))  # load the model so timings exclude it
    for name, arr in [("portrait", data.astronaut()), ("object", data.coffee()), ("cat", data.chelsea())]:
        sheet(name, Image.fromarray(arr))
