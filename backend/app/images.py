"""Image and mask conversion helpers shared by every endpoint.

Wire format: images travel as base64 strings (a `data:image/...;base64,` prefix
is accepted on input and never produced on output). Masks are single-channel
PNGs the same size as their image, white = the region to act on.
"""

import base64
import binascii
import io

import httpx
import numpy as np
from PIL import Image, ImageOps

MAX_SIDE = 2048


class ImageError(ValueError):
    """The client sent something that is not a usable image or mask."""


def _b64_bytes(data: str) -> bytes:
    if data.startswith("data:"):
        _, _, data = data.partition(",")
    try:
        return base64.b64decode(data, validate=False)
    except (binascii.Error, ValueError) as e:
        raise ImageError("not valid base64") from e


def decode_image(data: str, *, max_side: int = MAX_SIDE) -> Image.Image:
    """Decode a base64 image to RGB, or RGBA if it has transparency."""
    try:
        img = Image.open(io.BytesIO(_b64_bytes(data)))
        img.load()
    except ImageError:
        raise
    except Exception as e:
        raise ImageError("could not read image") from e
    img = ImageOps.exif_transpose(img)
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    img = img.convert("RGBA" if has_alpha else "RGB")
    return resize_max_side(img, max_side)


def decode_mask(data: str, size: tuple[int, int]) -> np.ndarray:
    """Decode a base64 mask to a uint8 array of 0/255 with shape (h, w).

    `size` is the (width, height) of the image the mask belongs to. A mask of a
    different size is resized, since browsers often export the canvas at another
    scale than the uploaded image.
    """
    try:
        mask = Image.open(io.BytesIO(_b64_bytes(data)))
        mask.load()
    except ImageError:
        raise
    except Exception as e:
        raise ImageError("could not read mask") from e
    if mask.mode in ("RGBA", "LA"):
        # A mask drawn on a transparent canvas: the painted pixels are the mask.
        mask = mask.getchannel("A")
    mask = mask.convert("L")
    if mask.size != size:
        mask = mask.resize(size, Image.NEAREST)
    arr = np.where(np.asarray(mask) > 127, 255, 0).astype(np.uint8)
    if not arr.any():
        raise ImageError("mask is empty")
    return arr


def encode_image(img: Image.Image, fmt: str = "PNG") -> str:
    buf = io.BytesIO()
    if fmt.upper() in ("JPEG", "JPG"):
        img = to_rgb(img)
        img.save(buf, format="JPEG", quality=92)
    else:
        img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def encode_mask(mask: np.ndarray) -> str:
    return encode_image(Image.fromarray(mask.astype(np.uint8)))


def to_data_url(img: Image.Image, fmt: str = "PNG") -> str:
    mime = "image/jpeg" if fmt.upper() in ("JPEG", "JPG") else f"image/{fmt.lower()}"
    return f"data:{mime};base64,{encode_image(img, fmt)}"


def to_rgb(img: Image.Image, background: tuple[int, int, int] = (255, 255, 255)) -> Image.Image:
    """Flatten transparency onto a solid background."""
    if img.mode == "RGB":
        return img
    if img.mode != "RGBA":
        return img.convert("RGB")
    flat = Image.new("RGB", img.size, background)
    flat.paste(img, mask=img.getchannel("A"))
    return flat


def resize_max_side(img: Image.Image, max_side: int) -> Image.Image:
    w, h = img.size
    scale = max_side / max(w, h)
    if scale >= 1:
        return img
    return img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)


def fetch_image(url: str, *, timeout: float = 60.0) -> Image.Image:
    """Download a generated image from a provider's result URL (or a data URL)."""
    if url.startswith("data:"):
        return decode_image(url)
    resp = httpx.get(url, timeout=timeout, follow_redirects=True)
    resp.raise_for_status()
    img = Image.open(io.BytesIO(resp.content))
    img.load()
    return img.convert("RGBA" if img.mode in ("RGBA", "LA") else "RGB")
