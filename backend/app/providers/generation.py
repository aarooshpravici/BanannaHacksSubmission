"""Hosted image generation (fal.ai, Replicate).

Every call goes through the disk cache, so a repeated request costs nothing
and a cached demo keeps working when the provider is down. In mock mode the
functions return cheap local stand-ins so the rest of the pipeline can run
with no key.

Endpoint input fields were checked against the fal model pages on 2026-10-10.
"""

import logging
from typing import Callable

import fal_client
import numpy as np
import replicate
from PIL import Image, ImageFilter

from ..cache import cache
from ..config import get_settings
from ..images import fetch_image, to_data_url, to_rgb

log = logging.getLogger(__name__)

FAL_INPAINT = "fal-ai/flux-pro/v1/fill"
FAL_RELIGHT = "fal-ai/iclight-v2"
REPLICATE_NOVEL_VIEW = "jd7h/zero123plusplus"

FAL_MAX_IMAGES_PER_CALL = 4


class GenerationError(RuntimeError):
    """A hosted generation call failed in a way the caller should report."""


def _require(key_present: bool, name: str) -> None:
    if not key_present:
        raise GenerationError(f"{name} is not set in .env")


def _cached(namespace: str, payload: dict, produce: Callable[[], list[Image.Image]], fresh: bool) -> list[Image.Image]:
    """Return the saved images for this request, or produce and save them.

    `fresh` skips the lookup (a "regenerate" button must not replay the cache)
    but still saves, so the newest result is what a later replay returns.
    """
    if not fresh and (hit := cache.get(namespace, payload)) is not None:
        log.info("cache hit for %s", namespace)
        return hit
    images = produce()
    cache.set(namespace, payload, images)
    return images


def fal_run(endpoint: str, arguments: dict) -> list[Image.Image]:
    """Run a fal image model and download the images it returns."""
    _require(bool(get_settings().fal_key), "FAL_KEY")
    try:
        result = fal_client.subscribe(endpoint, arguments=arguments, client_timeout=300)
    except fal_client.FalClientHTTPError as e:
        raise GenerationError(f"fal {endpoint} failed ({e.status_code}): {e.message}") from e
    except fal_client.FalClientError as e:
        raise GenerationError(f"fal {endpoint} failed: {e}") from e
    images = [fetch_image(item["url"]) for item in result.get("images", [])]
    if not images:
        raise GenerationError(f"fal {endpoint} returned no images")
    return images


def inpaint(
    image: Image.Image, mask: np.ndarray, prompt: str, *, n: int = 4, seed: int | None = None, fresh: bool = False
) -> list[Image.Image]:
    """Fill the white region of `mask` in `image` according to `prompt`.

    Returns n full-size candidates. FLUX Fill regenerates only the masked area
    but re-encodes the whole picture, so composite the result back through the
    mask if untouched pixels must stay bit-identical.
    """
    image = to_rgb(image)
    if get_settings().mock_mode:
        return _mock_inpaint(image, mask, n)
    base = {
        "prompt": prompt,
        "image_url": to_data_url(image, "PNG"),
        "mask_url": to_data_url(Image.fromarray(mask), "PNG"),
        "output_format": "png",
    }

    def produce() -> list[Image.Image]:
        results: list[Image.Image] = []
        while len(results) < n:
            arguments = {**base, "num_images": min(FAL_MAX_IMAGES_PER_CALL, n - len(results))}
            if seed is not None:
                arguments["seed"] = seed + len(results)
            results += fal_run(FAL_INPAINT, arguments)
        return [r.convert("RGB").resize(image.size, Image.LANCZOS) for r in results[:n]]

    return _cached(FAL_INPAINT, {**base, "n": n, "seed": seed}, produce, fresh)


def relight_enhance(
    image: Image.Image, prompt: str, *, light_from: str = "None", seed: int | None = None, fresh: bool = False
) -> Image.Image:
    """Diffusion relight (IC-Light v2) used to clean up a shaded preview.

    light_from is one of None / Left / Right / Top / Bottom: the coarse
    direction the model starts the lighting from.
    """
    image = to_rgb(image)
    if get_settings().mock_mode:
        return image
    arguments = {
        "prompt": prompt,
        "image_url": to_data_url(image, "PNG"),
        "initial_latent": light_from,
        "output_format": "png",
    }
    if seed is not None:
        arguments["seed"] = seed
    return _cached(FAL_RELIGHT, arguments, lambda: fal_run(FAL_RELIGHT, arguments)[:1], fresh)[0].convert("RGB")


def novel_views(image: Image.Image, *, fresh: bool = False) -> Image.Image:
    """Zero123++: one object image in, a 3x2 grid of six fixed new views out.

    The six views are at azimuths 30, 90, 150, 210, 270, 330 degrees from the
    input, alternating between looking slightly down and slightly up.
    UNTESTED: no REPLICATE_API_TOKEN was available when this was written.
    """
    image = to_rgb(image)
    if get_settings().mock_mode:
        return _mock_view_grid(image)
    _require(bool(get_settings().replicate_api_token), "REPLICATE_API_TOKEN")
    payload = {"image": to_data_url(image, "PNG")}

    def produce() -> list[Image.Image]:
        try:
            output = replicate.run(REPLICATE_NOVEL_VIEW, input=payload)
        except replicate.exceptions.ReplicateError as e:
            raise GenerationError(f"replicate {REPLICATE_NOVEL_VIEW} failed: {e}") from e
        first = output[0] if isinstance(output, (list, tuple)) else output
        return [fetch_image(str(getattr(first, "url", first)))]

    return _cached(REPLICATE_NOVEL_VIEW, payload, produce, fresh)[0]


def _mock_inpaint(image: Image.Image, mask: np.ndarray, n: int) -> list[Image.Image]:
    """Stand-in fills: the masked area replaced by blurred surroundings, with a
    different blur per candidate so they are distinguishable and rank differently."""
    out = []
    mask_img = Image.fromarray(mask)
    for i in range(n):
        blurred = image.filter(ImageFilter.GaussianBlur(8 + 10 * i))
        candidate = image.copy()
        candidate.paste(blurred, mask=mask_img)
        out.append(candidate)
    return out


def _mock_view_grid(image: Image.Image) -> Image.Image:
    cell = image.resize((320, 320))
    grid = Image.new("RGB", (640, 960), (128, 128, 128))
    for i in range(6):
        view = cell.transpose(Image.FLIP_LEFT_RIGHT) if i % 2 else cell
        grid.paste(view, ((i % 2) * 320, (i // 2) * 320))
    return grid
