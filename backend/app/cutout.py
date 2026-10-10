"""Background removal: a subject cutout with a transparent background."""

import threading
from functools import lru_cache

import numpy as np
from PIL import Image, ImageOps
from rembg import new_session, remove

from .images import to_rgb

# isnet-general-use handles photos and drawings; isnet-anime is better for
# anime-style characters. Weights download on first use (about 170 MB each).
DEFAULT_MODEL = "isnet-general-use"

_lock = threading.Lock()


@lru_cache
def _session(model: str):
    return new_session(model)


def remove_background(img: Image.Image, *, model: str = DEFAULT_MODEL) -> Image.Image:
    """Return the image as RGBA with the background made transparent."""
    session = _session(model)
    # rembg turns its own copy upright when the image carries an EXIF rotation,
    # so do the same here or its alpha would not line up with these pixels.
    rgb = to_rgb(ImageOps.exif_transpose(img))
    with _lock:
        out = remove(rgb, session=session)
    # rembg darkens the colors at soft edges (it multiplies them by the alpha).
    # Compositing that onto a background darkens them a second time, leaving a
    # grey fringe, so keep only its alpha and take the colors from the original.
    cutout = rgb.convert("RGBA")
    cutout.putalpha(out.convert("RGBA").getchannel("A"))
    return cutout


def subject_mask(cutout: Image.Image) -> np.ndarray:
    """0/255 mask of the subject from a cutout's alpha channel."""
    alpha = np.asarray(cutout.getchannel("A"))
    return np.where(alpha > 127, 255, 0).astype(np.uint8)


def crop_to_subject(cutout: Image.Image, *, margin: float = 0.08) -> Image.Image:
    """Crop a cutout to its subject plus a margin, so the subject fills the frame."""
    mask = subject_mask(cutout)
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return cutout
    w, h = cutout.size
    pad = round(margin * max(xs.max() - xs.min(), ys.max() - ys.min()))
    box = (max(0, xs.min() - pad), max(0, ys.min() - pad), min(w, xs.max() + pad + 1), min(h, ys.max() + pad + 1))
    return cutout.crop(box)


def on_background(cutout: Image.Image, color: tuple[int, int, int] = (255, 255, 255), *, square: bool = False) -> Image.Image:
    """Flatten a cutout onto a solid color, optionally padded to a square.

    Novel-view and reference-conditioned models expect a centered subject on a
    plain background.
    """
    if square:
        side = max(cutout.size)
        canvas = Image.new("RGBA", (side, side), (*color, 0))
        canvas.paste(cutout, ((side - cutout.width) // 2, (side - cutout.height) // 2))
        cutout = canvas
    return to_rgb(cutout, color)
