"""Render the pictures that explain the project, from the Portrait sample.

Run from backend/:  MOCK_MODE=1 PYTHONPATH=. .venv/bin/python ../docs/make_explainer_images.py
Input:  frontend/public/samples/portrait/ (photo.jpg, depth.png, normals.png)
Output: frontend/public/how-it-works/*.jpg  the stills in the app's "How it works" panel
        docs/relight-sweep.gif              the animation at the top of README.md

Everything is shaded by the Python reference (app.ideas.relight) from the
sample's static maps, the same maps the browser shades. No model is loaded and
no service is called. Run it again after the shading maths or the sample changes.
"""

import io
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from app.ideas import relight as R

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "frontend" / "public" / "samples" / "portrait"
STILLS = ROOT / "frontend" / "public" / "how-it-works"
GIF = ROOT / "docs" / "relight-sweep.gif"

# The light a fresh scene starts with: START in frontend/app/relight/page.tsx.
START = {"x": 0.12, "y": 0.35, "height": 0.12, "intensity": 1.8, "ambient": 0.06}
# The Sweep button's path, copied from the same file (SWEEP_CENTRE, SWEEP_RADIUS, SWEEP_BLEND, SWEEP_MS).
SWEEP_CENTRE = (0.5, 0.5)
SWEEP_RADIUS = 0.5
SWEEP_BLEND = 0.15
SWEEP_MS = 6000

# The panel shows two stills side by side in a column at most 640 px wide, so
# 384 px is sharp on a high-density phone and keeps each file small.
STILL_SIDE = 384
STILL_QUALITY = 82
# A still over this is saved again at lower quality: the panel loads six of them.
MAX_STILL_BYTES = 60 * 1024

# 36 frames is one every 10 degrees: smooth enough to read as motion. More
# frames or more colours make the GIF pass MAX_GIF_BYTES; fewer colours band the
# soft shadows. No dithering, because its noise changes every frame and doubles the file.
GIF_FRAMES = 36
GIF_WIDTH = 480
GIF_COLOURS = 128
MAX_GIF_BYTES = 3 * 1024 * 1024
# Radius of the dot drawn where the light is, in GIF pixels. The page draws a sun there; the reference draws nothing.
LIGHT_DOT = 7


def load_scene() -> tuple[Image.Image, R.Geometry]:
    """The sample as the browser decodes it (see scene() in app/routers/relight.py for the encodings)."""
    photo = Image.open(SAMPLE / "photo.jpg").convert("RGB")
    relief = 0.3  # scene.json; the same for every sample
    depth = np.asarray(Image.open(SAMPLE / "depth.png").convert("L"), np.float32) / 255.0
    normals = np.asarray(Image.open(SAMPLE / "normals.png").convert("RGB"), np.float32) / 255.0 * 2.0 - 1.0
    normals /= np.maximum(np.linalg.norm(normals, axis=2, keepdims=True), 1e-6)
    # Not build_geometry: the depth map was already blurred when the sample was baked.
    return photo, R.Geometry(z=(depth * relief).astype(np.float32), normals=normals.astype(np.float32), relief=relief)


def save_still(img: Image.Image, name: str) -> None:
    img = img.convert("RGB").resize((STILL_SIDE, STILL_SIDE), Image.LANCZOS)
    quality = STILL_QUALITY
    while True:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True)
        if buf.tell() <= MAX_STILL_BYTES or quality <= 40:
            break
        quality -= 6
    (STILLS / name).write_bytes(buf.getvalue())
    print(f"{name}: {buf.tell() / 1024:.0f} KB")


def grey(light_amount: np.ndarray) -> Image.Image:
    """A map of linear light, 0..1, as a picture (on the sRGB curve, like the photo)."""
    return Image.fromarray((R._linear_to_srgb(np.clip(light_amount, 0.0, 1.0)) * 255.0 + 0.5).astype(np.uint8))


def sweep_position(t: float) -> tuple[float, float]:
    """Where the light is at t in 0..1 of a sweep: startSweep() in page.tsx."""
    start_angle = math.atan2(START["y"] - SWEEP_CENTRE[1], START["x"] - SWEEP_CENTRE[0])
    angle = start_angle + t * 2 * math.pi
    blend = min(max(min(t, 1 - t) / SWEEP_BLEND, 0.0), 1.0)
    on_orbit = blend * blend * (3 - 2 * blend)
    x = START["x"] + (SWEEP_CENTRE[0] + SWEEP_RADIUS * math.cos(angle) - START["x"]) * on_orbit
    y = START["y"] + (SWEEP_CENTRE[1] + SWEEP_RADIUS * math.sin(angle) - START["y"]) * on_orbit
    return x, y


def main() -> None:
    photo, geom = load_scene()
    STILLS.mkdir(parents=True, exist_ok=True)

    left = R.Light(**START)
    right = R.Light(**{**START, "x": 1.0 - START["x"]})
    save_still(Image.open(SAMPLE / "depth.png"), "depth.jpg")
    save_still(Image.open(SAMPLE / "normals.png"), "normals.jpg")
    # Diffuse shading runs up to MAX_FALLOFF next to the light; scaled so a facing surface at the scene's centre is mid-bright.
    save_still(grey(R.diffuse(geom, left) / R.MAX_FALLOFF * 2.0), "diffuse.jpg")
    save_still(grey(R.shadows(geom, left)), "shadows.jpg")
    save_still(R.relight(photo, geom, left), "relit-left.jpg")
    save_still(R.relight(photo, geom, right), "relit-right.jpg")

    frames = []
    for i in range(GIF_FRAMES):
        x, y = sweep_position(i / GIF_FRAMES)
        frame = R.relight(photo, geom, R.Light(**{**START, "x": x, "y": y}))
        frame = frame.resize((GIF_WIDTH, round(GIF_WIDTH * frame.height / frame.width)), Image.LANCZOS)
        # Held inside the frame, as the page holds its sun.
        cx = min(max(x * frame.width, LIGHT_DOT + 2), frame.width - LIGHT_DOT - 2)
        cy = min(max(y * frame.height, LIGHT_DOT + 2), frame.height - LIGHT_DOT - 2)
        ImageDraw.Draw(frame).ellipse([cx - LIGHT_DOT, cy - LIGHT_DOT, cx + LIGHT_DOT, cy + LIGHT_DOT], fill=(251, 209, 61), outline=(0, 0, 0), width=2)
        frames.append(frame)

    # One palette taken from every frame together, so colours do not flicker from frame to frame.
    w, h = frames[0].size
    sheet = Image.new("RGB", (w * 6, h * math.ceil(GIF_FRAMES / 6)))
    for i, frame in enumerate(frames):
        sheet.paste(frame, ((i % 6) * w, (i // 6) * h))
    palette = sheet.quantize(colors=GIF_COLOURS, method=Image.MEDIANCUT)
    indexed = [frame.quantize(palette=palette, dither=Image.NONE) for frame in frames]
    indexed[0].save(GIF, save_all=True, append_images=indexed[1:], duration=round(SWEEP_MS / GIF_FRAMES), loop=0, optimize=True)
    size = GIF.stat().st_size
    print(f"{GIF.relative_to(ROOT)}: {GIF_FRAMES} frames, {size / 1024 / 1024:.2f} MB")
    if size > MAX_GIF_BYTES:
        raise SystemExit(f"over {MAX_GIF_BYTES // 1024 // 1024} MB: use fewer frames or colours")


if __name__ == "__main__":
    main()
