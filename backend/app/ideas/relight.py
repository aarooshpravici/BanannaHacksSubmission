"""Relight a photo from a movable point light.

photo -> depth -> height field -> surface normals -> diffuse shading + cast
shadows -> multiply into the photo. A second light, the fill, can be added: it
is shaded the same way but casts no shadow (fill_map).

Conventions (everything is in image space, so there are no axis flips):
  x grows to the right, y grows downward, z grows toward the viewer.
  Lengths are in units of image width: x in [0, 1], y in [0, H/W].
  The height field z(x, y) is the depth model's output scaled to [0, relief],
  with the nearest surface at z = relief and the farthest at z = 0.
The depth model (Depth Anything V2) outputs larger values for closer surfaces,
which already matches "z toward the viewer"; no sign flip is applied.
"""

import threading
from dataclasses import dataclass
from functools import lru_cache

import cv2
import numpy as np
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForDepthEstimation

from ..images import to_rgb

DEPTH_MODEL = "depth-anything/Depth-Anything-V2-Small-hf"
NORMALS_MODEL = "prs-eth/marigold-normals-v1-1"

_lock = threading.Lock()
# Loading a model is not safe to do twice at once: two overlapping first requests
# left the normals pipeline half-built and every later request failed.
_load_lock = threading.Lock()


@lru_cache
def device() -> str:
    """Where the normals model runs: a GPU if there is one, otherwise the CPU."""
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _depth_model():
    with _load_lock:
        return _load_depth_model()


@lru_cache
def _load_depth_model():
    # CPU on purpose: this small model runs in ~0.3 s on CPU, faster than the
    # round trip to the Mac GPU, and it keeps the preview free of any GPU need.
    processor = AutoImageProcessor.from_pretrained(DEPTH_MODEL)
    model = AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL).eval()
    return processor, model


def estimate_height(img: Image.Image) -> np.ndarray:
    """Per-pixel nearness in [0, 1] (1 = closest to the camera), image-sized."""
    processor, model = _depth_model()
    inputs = processor(images=to_rgb(img), return_tensors="pt")
    with _lock, torch.no_grad():
        raw = model(**inputs).predicted_depth[0].numpy()
    raw = cv2.resize(raw, img.size, interpolation=cv2.INTER_CUBIC)
    # Percentiles, not min/max, so one stray pixel cannot squash the range.
    lo, hi = np.percentile(raw, [1, 99])
    if hi - lo < 1e-6:
        return np.zeros_like(raw, dtype=np.float32)
    return np.clip((raw - lo) / (hi - lo), 0.0, 1.0).astype(np.float32)


def _normals_model():
    with _load_lock:
        return _load_normals_model()


@lru_cache
def _load_normals_model():
    from diffusers import MarigoldNormalsPipeline

    if device() == "cpu":
        return MarigoldNormalsPipeline.from_pretrained(NORMALS_MODEL)
    return MarigoldNormalsPipeline.from_pretrained(NORMALS_MODEL, variant="fp16", torch_dtype=torch.float16).to(device())


def estimate_normals(img: Image.Image) -> np.ndarray:
    """Detailed per-pixel surface normals from Marigold, (H, W, 3), unit length.

    Far more detailed than normals derived from the depth map (it resolves a
    nose, cheeks, cloth folds), but it is a diffusion model: about 2 s on an
    Apple GPU, slow on CPU. Returned in this module's convention (y downward);
    Marigold's own output has y pointing up.
    """
    pipe = _normals_model()
    with _lock:
        out = pipe(to_rgb(img), num_inference_steps=1, generator=torch.Generator("cpu").manual_seed(0))
    normals = out.prediction[0].astype(np.float32) * np.array([1, -1, 1], dtype=np.float32)
    return normals / np.maximum(np.linalg.norm(normals, axis=2, keepdims=True), 1e-6)


@dataclass
class Geometry:
    """Everything about a photo that does not depend on the light."""

    z: np.ndarray  # (H, W) height toward the viewer, in image widths, 0..relief
    normals: np.ndarray  # (H, W, 3) unit surface normals (x right, y down, z to viewer)
    relief: float


# Normals taken from the slope of the height field go wrong where one object
# ends and what is behind it begins: the depth jumps, the slope there is very
# steep, and the normal points sideways. Lit from the side, every object then
# gets a bright rim towards the light and a dark rim away from it, like a
# cut-out. So a slope this steep is taken for a jump between objects, and the
# normal there is turned to face the viewer, like the flat ground beside it.
# The price is paid by surfaces that really are that steep: on a ball as deep
# as it is wide the flattening starts at about 83% of the radius and is
# complete at 97%, and a thin pole is lit evenly right across. Nothing is
# shown tilted more than 61 degrees.
#
# The slope (rise over run, both in image widths) below which a normal is kept
# as it is, and above which it faces the viewer; in between, a mix. 1.5 is a
# surface tilted 56 degrees from the viewer and 4 is 76 degrees. Lower removes
# more of the rim but flattens the rounded edge of a cup or a cheek sooner.
DEPTH_STEP_SLOPE = (1.5, 4.0)
# How far the flattening reaches to either side of a jump, and how softly it
# fades out, in pixels at 512 width: the blur of the height field (smooth)
# spreads a jump over several pixels, and its gentler shoulders would
# otherwise be left as a thinner rim.
DEPTH_STEP_GROW = 3.0
DEPTH_STEP_FEATHER = 2.0


def _depth_steps(dz_dx: np.ndarray, dz_dy: np.ndarray, w: int) -> np.ndarray:
    """Where the height field jumps from one object to what is behind it: 0 = a surface, 1 = a jump."""
    steep = _smoothstep(*DEPTH_STEP_SLOPE, np.hypot(dz_dx, dz_dy)).astype(np.float32)
    grow = max(1, int(DEPTH_STEP_GROW * w / 512 + 0.5))
    steep = cv2.dilate(steep, np.ones((2 * grow + 1, 2 * grow + 1), np.uint8))
    return cv2.GaussianBlur(steep, (0, 0), DEPTH_STEP_FEATHER * w / 512)


def build_geometry(
    height: np.ndarray, *, normals: np.ndarray | None = None, relief: float = 0.3, smooth: float = 1.5
) -> Geometry:
    """Turn a nearness map into a height field with normals.

    relief is how deep the scene is treated as being, relative to image width:
    larger makes cast shadows longer and, for depth-derived normals, surfaces
    tilt more.
    normals, if given (from estimate_normals), are used as they are; otherwise
    normals are derived from the slope of the height field, which is fast but
    flat-looking because the depth map has little fine detail. Where the height
    jumps from one object to the next they face the viewer (see DEPTH_STEP_SLOPE).
    smooth is a blur (pixels at 512 width) that removes depth-map noise, which
    would otherwise show up as speckled shading.
    """
    h, w = height.shape
    sigma = smooth * w / 512
    if sigma > 0:
        height = cv2.GaussianBlur(height, (0, 0), sigma)
    z = height * relief
    if normals is None:
        # Slopes with x and y in image widths: a step of one pixel is 1/W.
        dz_dy, dz_dx = np.gradient(z, 1.0 / w)
        surface = 1.0 - _depth_steps(dz_dx, dz_dy, w)
        normals = np.dstack([-dz_dx * surface, -dz_dy * surface, np.ones_like(z)])
        normals /= np.linalg.norm(normals, axis=2, keepdims=True)
    elif normals.shape[:2] != (h, w):
        raise ValueError(f"normals {normals.shape[:2]} do not match height {(h, w)}")
    return Geometry(z=z.astype(np.float32), normals=normals.astype(np.float32), relief=relief)


@dataclass
class Light:
    x: float  # 0 = left edge, 1 = right edge (may go outside 0..1)
    y: float  # 0 = top edge, 1 = bottom edge
    height: float = 0.5  # distance in front of the nearest surface, in image widths
    intensity: float = 1.0
    ambient: float = 0.3  # light that reaches everything, so shadows are not pure black (not used for a fill light)
    color: tuple[float, float, float] = (1.0, 1.0, 1.0)


def _light_position(geom: Geometry, light: Light) -> np.ndarray:
    h, w = geom.z.shape
    return np.array([light.x, light.y * h / w, geom.relief + max(light.height, 1e-3)], dtype=np.float32)


def _pixel_positions(geom: Geometry) -> np.ndarray:
    h, w = geom.z.shape
    xs = (np.arange(w, dtype=np.float32) + 0.5) / w
    ys = (np.arange(h, dtype=np.float32) + 0.5) / w
    gx, gy = np.meshgrid(xs, ys)
    return np.dstack([gx, gy, geom.z])


# Cap on how much brighter than the scene centre a surface next to the light can get.
MAX_FALLOFF = 3.0
# How gradually a surface goes dark as it turns away from the light, as a cosine
# of the angle to the light. Plain Lambert shading cuts to nothing exactly where
# a surface is edge-on to the light, and estimated normals swing through that
# angle within a few pixels along a nose, a brow or a cheek: the result was a
# straight, hard-edged dark patch across a face that looked like a cast shadow.
# With this, shading is plain Lambert above the value, eases to nothing at the
# same amount past edge-on, and an edge-on surface gets a quarter of it. That is
# roughly what a large lamp does compared with a bare bulb. Higher is softer but
# flattens the modelling of a face; 0 would be plain Lambert.
TERMINATOR_SOFTNESS = 0.6


def _soft_terminator(cos: np.ndarray) -> np.ndarray:
    """max(cos, 0) with the corner rounded off: see TERMINATOR_SOFTNESS."""
    k = TERMINATOR_SOFTNESS
    eased = np.maximum(cos + k, 0.0) ** 2 / (4.0 * k)
    return np.where(cos >= k, cos, eased)


def diffuse(geom: Geometry, light: Light) -> np.ndarray:
    """Lambert shading with distance falloff, (H, W).

    Brightness = cos(angle between surface normal and direction to the light),
    eased to nothing where the surface turns away instead of cut off (see
    TERMINATOR_SOFTNESS), times an inverse-square falloff measured relative to
    the centre of the scene. So wherever the light is, a surface at the centre that faces it gets
    exactly 1.0: moving the light changes direction and gradient, not the
    overall exposure. (A plain inverse-square falloff made the whole photo go
    dark as soon as the light moved off to one side.)
    """
    h, w = geom.z.shape
    light_pos = _light_position(geom, light)
    to_light = light_pos - _pixel_positions(geom)
    dist = np.linalg.norm(to_light, axis=2)
    cos = np.einsum("hwc,hwc->hw", geom.normals, to_light) / np.maximum(dist, 1e-6)
    centre = np.array([0.5, 0.5 * h / w, geom.relief / 2], dtype=np.float32)
    reference = np.linalg.norm(light_pos - centre)
    falloff = np.minimum((reference / np.maximum(dist, 1e-6)) ** 2, MAX_FALLOFF)
    return np.minimum(_soft_terminator(cos), 1.0) * falloff


# Cast shadows are sorted by how far the thing casting them stands in front of
# the surface receiving them ("the gap", as a fraction of the scene's relief),
# into three layers that are blurred by different amounts. A small gap is a
# contact shadow (a nose on a cheek) and stays crisp. A large gap is a far
# background, which the height field wrongly treats as a wall right behind the
# subject: its shadow is spread wide and faded, as a real one would be.
#
# The gaps at which a shadow is fully "near", "mid" and "far"; in between, it is
# shared between the two neighbouring layers. Lower values soften more shadows,
# higher values keep more of them crisp.
SHADOW_GAP_NEAR = 0.1
SHADOW_GAP_MID = 0.3
SHADOW_GAP_FAR = 0.7
# Blur of the near, mid and far layers, in pixels of the reduced shadow map. The
# first only hides the pixel grid; the last has to be wide enough that a shadow
# on a far background shows no steps, and narrow enough that it does not spill
# far onto whatever stands next to it.
SHADOW_BLUR_SIGMAS = (1.0, 3.0, 8.0)
# How dark a shadow on a far background gets (1 = as dark as a contact shadow).
# Lower hides the height field's mistakes more but also weakens real shadows.
SHADOW_FAR_STRENGTH = 0.35
# The gap is measured from the highest surface within this many shadow-map
# pixels of the blocker to the lowest within as many of the receiver, so the
# blurred rim of a silhouette counts as the tall object it belongs to and not as
# a low wall. Larger is safer at edges but lets small bumps beside a tall object
# borrow its height.
SHADOW_SPREAD = 2


def _smoothstep(lo: float, hi: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - lo) / (hi - lo), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def shadows(geom: Geometry, light: Light, *, steps: int = 48, max_side: int = 256, softness: float = 0.02) -> np.ndarray:
    """Cast-shadow map, (H, W): 1 = fully lit, 0 = fully shadowed.

    For every pixel, walk in a straight line toward the light and check whether
    the height field rises above the line anywhere on the way. Whatever blocks
    the line is filed under near, mid or far by its gap to the pixel, and each
    layer is blurred on its own: see the SHADOW_ constants. Done at reduced
    resolution and upsampled, since shadows are low-frequency.
    """
    full_h, full_w = geom.z.shape
    scale = min(1.0, max_side / max(full_h, full_w))
    w, h = max(1, round(full_w * scale)), max(1, round(full_h * scale))
    z = cv2.resize(geom.z, (w, h), interpolation=cv2.INTER_AREA)
    spread = np.ones((2 * SHADOW_SPREAD + 1, 2 * SHADOW_SPREAD + 1), np.uint8)
    crest, floor = cv2.dilate(z, spread), cv2.erode(z, spread)

    xs = (np.arange(w, dtype=np.float32) + 0.5) / w
    ys = (np.arange(h, dtype=np.float32) + 0.5) / w  # widths, so the aspect ratio is kept
    px, py = np.meshgrid(xs, ys)
    lx, ly, lz = _light_position(geom, light)

    # The ray can only be blocked while it is below the tallest surface, so stop
    # each ray where it climbs past z = relief instead of marching all the way.
    t_end = np.clip((geom.relief - z) / np.maximum(lz - z, 1e-6), 0.0, 1.0)
    # Skip the first stretch so a surface does not shadow itself.
    bias = 0.02 * geom.relief
    near, mid, far = np.zeros_like(z), np.zeros_like(z), np.zeros_like(z)
    for i in range(1, steps + 1):
        t = t_end * (i / steps)
        qx, qy, qz = px + (lx - px) * t, py + (ly - py) * t, z + (lz - z) * t
        mx, my = qx * w - 0.5, qy * w - 0.5
        surface = cv2.remap(z, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        top = cv2.remap(crest, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        occlusion = np.clip((surface - qz - bias) / softness, 0.0, 1.0)
        gap = (top - floor) / geom.relief
        to_mid = _smoothstep(SHADOW_GAP_NEAR, SHADOW_GAP_MID, gap)
        to_far = _smoothstep(SHADOW_GAP_MID, SHADOW_GAP_FAR, gap)
        occlusion = occlusion * (1.0 - (1.0 - SHADOW_FAR_STRENGTH) * _smoothstep(SHADOW_GAP_NEAR, SHADOW_GAP_FAR, gap))
        near = np.maximum(near, occlusion * (1.0 - to_mid))
        mid = np.maximum(mid, occlusion * to_mid * (1.0 - to_far))
        far = np.maximum(far, occlusion * to_mid * to_far)

    lit = np.ones_like(z)
    for layer, sigma in zip((near, mid, far), SHADOW_BLUR_SIGMAS):
        lit = lit * (1.0 - cv2.GaussianBlur(layer, (0, 0), sigma))
    return cv2.resize(lit, (full_w, full_h), interpolation=cv2.INTER_LINEAR)


def shading_map(geom: Geometry, light: Light, *, cast_shadows: bool = True) -> np.ndarray:
    """Total light reaching each pixel, (H, W). ambient where unlit; can exceed 1."""
    direct = diffuse(geom, light)
    if cast_shadows:
        direct = direct * shadows(geom, light)
    return light.ambient + light.intensity * direct


def fill_map(geom: Geometry, fill: Light) -> np.ndarray:
    """What a fill light adds at each pixel, (H, W).

    A fill is a second, weaker light, usually on the side opposite the main
    one, that lifts the shadows the main light leaves. It is shaded exactly as
    the main light is (diffuse(), from its own position and height), with two
    things left out. It casts no shadow and is not darkened by the main
    light's: a fill that threw shadows of its own would put a second set of
    them on a face. And it has no ambient: that is shared, and is the main
    light's.
    """
    return fill.intensity * diffuse(geom, fill)


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.maximum(c, 1e-8) ** (1 / 2.4) - 0.055)


def apply_shading(
    img: Image.Image,
    shading: np.ndarray,
    color: tuple[float, float, float] = (1.0, 1.0, 1.0),
    *,
    fill: np.ndarray | None = None,
    fill_color: tuple[float, float, float] = (1.0, 1.0, 1.0),
) -> Image.Image:
    """Multiply the photo by a shading map, in linear light.

    Photos store brightness on a perceptual (sRGB) curve; multiplying there
    gives muddy shadows. Converting to linear light first makes "half the
    light" actually look like half the light. Values above white roll off
    smoothly instead of clipping.

    fill, if given (from fill_map), is a second light's share, in its own
    colour: the photo times it is added before the roll-off, so the two lights
    together cannot clip either. Without it, the result is what it always was.
    """
    rgb = np.asarray(to_rgb(img), dtype=np.float32) / 255.0
    linear = _srgb_to_linear(rgb)
    lit = linear * shading[..., None] * np.asarray(color, dtype=np.float32)
    if fill is not None:
        lit = lit + linear * fill[..., None] * np.asarray(fill_color, dtype=np.float32)
    knee = 0.8
    over = np.maximum(lit - knee, 0.0)
    lit = np.where(lit > knee, knee + (1 - knee) * (1 - np.exp(-over / (1 - knee))), lit)
    out = np.clip(_linear_to_srgb(lit), 0.0, 1.0)
    return Image.fromarray((out * 255.0 + 0.5).astype(np.uint8))


def relight(img: Image.Image, geom: Geometry, light: Light, *, cast_shadows: bool = True, fill: Light | None = None) -> Image.Image:
    """The photo lit by `light` (the main, or key, light) and, if given, by a fill light as well: see fill_map."""
    shading = shading_map(geom, light, cast_shadows=cast_shadows)
    if fill is None:
        return apply_shading(img, shading, light.color)
    return apply_shading(img, shading, light.color, fill=fill_map(geom, fill), fill_color=fill.color)


def normals_preview(geom: Geometry) -> Image.Image:
    """Normals as the usual purple-blue debug image (x->R, up->G, z->B)."""
    n = geom.normals * np.array([1, -1, 1], dtype=np.float32)
    return Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8))
