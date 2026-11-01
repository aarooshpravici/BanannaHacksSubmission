"""Bake the fixtures the frontend's agreement test checks its CPU port against.

Run from backend/:  MOCK_MODE=1 .venv/bin/python -m scripts.relight_fixtures
Input:  the four built-in samples in frontend/public/samples/<name>/.
Output: frontend/tests/fixtures/relight/
  cases.json             the lights, and which scene is rendered under which
  <scene>/photo.png      the inputs, exactly as both sides read them
  <scene>/depth.png      grey, with an alpha channel where the sample has open sky
  <scene>/normals.png
  <scene>/<case>.png     what relight.relight() makes of them

frontend/tests/agreement.test.ts renders the same scenes under the same lights
with lib/relightMath.ts and fails if any channel of any pixel is more than 2
levels (of 255) away from these pictures. So after an intentional change to the
maths, change relight.py and relightMath.ts (and the shader in relightGL.ts) to
match, run this script, check `cd frontend && npm test` passes, and commit the
new fixtures with the change. If the test fails without the fixtures having
been remade, the two versions have drifted apart.

The samples are made smaller so the fixtures stay small (about 2 MB in all):
  "<sample>"        128 pixels wide, with the real photo, under all ten lights.
                    At this size the shadow map is the picture's own size.
  "<sample>-large"  320 pixels wide, under three lights, with a smooth colour
                    ramp in place of the photo (a ramp compresses to almost
                    nothing and still runs every brightness through the
                    colour curves). At this size the shadow map is 256 wide, so
                    the shrinking and stretching of the shadow map are checked.
Both sides read the inputs from the PNGs written here, depth / 255, open sky
(255 - alpha) / 255, and normals mapped 0..255 -> -1..1 and made unit length,
as the browser reads a scene's PNGs (sceneArrays in lib/relightMath.ts). Only local files are read: no model runs.
"""

import json
import shutil
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from app.ideas import relight as R

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "frontend" / "public" / "samples"
OUT = ROOT / "frontend" / "tests" / "fixtures" / "relight"

NAMES = ("portrait", "coffee", "cat", "rocket")
SMALL_WIDTH = 128
LARGE_WIDTH = 320

# The page's own lights, from frontend/app/relight/page.tsx and lib/types.ts.
START = dict(x=0.12, y=0.35, height=0.12, intensity=1.4, ambient=0.2)
DEFAULT = dict(x=0.2, y=0.2, height=0.25, intensity=1.5, ambient=0.12)
DEFAULT_FILL = dict(x=0.8, y=0.2, height=0.35, intensity=0.6)
WARM = [1.0, 0.86, 0.68]
COOL = [0.7, 0.86, 1.0]
WHITE = [1.0, 1.0, 1.0]
HEIGHT_MIN = 0.03
HEIGHT_MAX = 2.0

# name -> (key light, cast shadows, fill light or None). The first is the light
# the page starts with; the rest are the presets, the fill, and the far ends of
# every slider, where a mistake in one version shows up first.
CASES = {
    "start": (dict(**START, color=WHITE), True, None),
    "start-no-shadows": (dict(**START, color=WHITE), False, None),
    "default-and-fill": (dict(**DEFAULT, color=WHITE), True, dict(**DEFAULT_FILL, color=WHITE)),
    "left-warm-fill": (dict(x=-0.1, y=0.4, height=0.35, intensity=1.3, ambient=0.06, color=WHITE), True, dict(x=1.0, y=0.3, height=0.35, intensity=0.6, color=WARM)),
    "low-and-warm": (dict(x=0.0, y=0.9, height=0.12, intensity=1.6, ambient=0.2, color=WARM), True, None),
    "grazing-right": (dict(x=1.05, y=0.5, height=HEIGHT_MIN, intensity=2.0, ambient=0.06, color=WHITE), True, None),
    "overhead-blown": (dict(x=0.5, y=0.5, height=HEIGHT_MAX, intensity=4.0, ambient=1.0, color=COOL), True, None),
    "fill-only": (dict(x=0.5, y=0.5, height=0.25, intensity=0.0, ambient=0.0, color=WHITE), True, dict(x=-0.3, y=1.2, height=HEIGHT_MIN, intensity=4.0, color=COOL)),
    "outside-top-strong-fill": (dict(x=1.6, y=-0.4, height=0.5, intensity=1.5, ambient=0.12, color=WHITE), False, dict(x=0.5, y=0.5, height=HEIGHT_MAX, intensity=4.0, color=WHITE)),
    "below-coloured": (dict(x=0.3, y=1.3, height=0.08, intensity=3.0, ambient=0.3, color=[1.0, 0.5, 0.2]), True, dict(x=0.9, y=0.1, height=0.2, intensity=0.3, color=[0.2, 0.4, 1.0])),
}
LARGE_CASES = ("start", "default-and-fill", "grazing-right")


def _light(spec: dict | None) -> R.Light | None:
    if spec is None:
        return None
    return R.Light(spec["x"], spec["y"], height=spec["height"], intensity=spec["intensity"], ambient=spec.get("ambient", 0.0), color=tuple(spec["color"]))


def _inputs(name: str, width: int, ramp: bool) -> tuple[Image.Image, np.ndarray, np.ndarray, np.ndarray | None, float]:
    """The sample shrunk to `width`, as 8-bit pictures: photo (RGB), depth (grey), normals (RGB), the depth's alpha (None
    when the sample has no open sky); and its relief."""
    folder = SAMPLES / name
    relief = json.loads((folder / "scene.json").read_text())["relief"]
    photo = Image.open(folder / "photo.jpg").convert("RGB")
    height = max(1, round(width * photo.height / photo.width))
    if ramp:
        x = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :].repeat(height, 0)
        y = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None].repeat(width, 1)
        rgb = np.dstack([x, y, 1.0 - 0.5 * (x + y)])
        photo = Image.fromarray((rgb * 255.0 + 0.5).astype(np.uint8))
    else:
        photo = photo.resize((width, height), Image.BOX)
    depth, sky = R.read_depth_image(Image.open(folder / "depth.png"))
    depth = cv2.resize(depth, (width, height), interpolation=cv2.INTER_AREA)
    normals = np.asarray(Image.open(folder / "normals.png").convert("RGB"), dtype=np.float32) / 255.0 * 2.0 - 1.0
    normals = cv2.resize(normals, (width, height), interpolation=cv2.INTER_AREA)
    normals /= np.maximum(np.linalg.norm(normals, axis=2, keepdims=True), 1e-6)
    # The two encodings of routers/relight.py scene(), as in make_samples.py.
    depth_u8 = (np.clip(depth, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    normals_u8 = ((normals * 0.5 + 0.5) * 255.0 + 0.5).astype(np.uint8)
    alpha_u8 = None
    if sky is not None:
        sky = cv2.resize(sky, (width, height), interpolation=cv2.INTER_AREA)
        alpha_u8 = (255.0 - np.clip(sky, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    return photo, depth_u8, normals_u8, alpha_u8, relief


def _geometry(depth_u8: np.ndarray, normals_u8: np.ndarray, relief: float, alpha_u8: np.ndarray | None = None) -> R.Geometry:
    """The scene as the browser reads it back from its PNGs (sceneArrays in lib/relightMath.ts)."""
    z = (depth_u8.astype(np.float32) / 255.0) * np.float32(relief)
    n = normals_u8.astype(np.float32) / 255.0 * 2.0 - 1.0
    n /= np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-6)
    sky = None if alpha_u8 is None or alpha_u8.min() == 255 else ((255.0 - alpha_u8.astype(np.float32)) / 255.0).astype(np.float32)
    return R.Geometry(z=z.astype(np.float32), normals=n.astype(np.float32), relief=relief, sky=sky)


def _png(img: Image.Image, path: Path) -> int:
    img.save(path, format="PNG", optimize=True)
    return path.stat().st_size


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    scenes = []
    total = 0
    for name in NAMES:
        for scene, width, ramp, cases in ((name, SMALL_WIDTH, False, tuple(CASES)), (f"{name}-large", LARGE_WIDTH, True, LARGE_CASES)):
            photo, depth_u8, normals_u8, alpha_u8, relief = _inputs(name, width, ramp)
            folder = OUT / scene
            folder.mkdir(parents=True)
            total += _png(photo, folder / "photo.png")
            depth_png = Image.fromarray(depth_u8)
            if alpha_u8 is not None:
                depth_png = Image.merge("LA", (depth_png, Image.fromarray(alpha_u8)))
            total += _png(depth_png, folder / "depth.png")
            total += _png(Image.fromarray(normals_u8), folder / "normals.png")
            geom = _geometry(depth_u8, normals_u8, relief, alpha_u8)
            for case in cases:
                key, cast, fill = CASES[case]
                out = R.relight(photo, geom, _light(key), cast_shadows=cast, fill=_light(fill))
                total += _png(out, folder / f"{case}.png")
            scenes.append({"name": scene, "sample": name, "width": photo.width, "height": photo.height, "relief": relief, "cases": list(cases)})
            print(f"{scene}: {photo.width} x {photo.height}, {len(cases)} lights")
    cases_json = {name: {"light": key, "shadows": cast, "fill": fill} for name, (key, cast, fill) in CASES.items()}
    (OUT / "cases.json").write_text(json.dumps({"cases": cases_json, "scenes": scenes}, indent=2) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {total / 1024:.0f} KB of pictures")


if __name__ == "__main__":
    main()
