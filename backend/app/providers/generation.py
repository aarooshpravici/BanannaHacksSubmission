"""Hosted image generation for the Enhance step (Gemini or fal.ai).

Every call goes through the disk cache, so a repeated request costs nothing
and a cached demo keeps working when the provider is down. In mock mode Enhance
returns its input unchanged, so the rest of the pipeline can run with no key.

Endpoint input fields were checked against the fal model pages on 2026-10-10.
"""

import io
import json
import logging
import threading
from typing import Callable

import fal_client
from PIL import Image

from ..cache import cache
from ..config import get_settings
from ..images import fetch_image, to_data_url, to_rgb

log = logging.getLogger(__name__)

FAL_RELIGHT = "fal-ai/iclight-v2"

IMAGE_TIMEOUT_SECONDS = 180  # a stalled call must fail, not pin a job worker forever


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


def provider() -> str:
    """Which service makes images for this run: "gemini" or "fal"."""
    settings = get_settings()
    if settings.image_provider != "auto":
        return settings.image_provider
    return "gemini" if settings.gemini_api_key else "fal"


_spend_lock = threading.Lock()


def _charge(meter: str, limit: int) -> None:
    """Count one paid call against a hard cap, refusing it once the cap is reached.

    Calls are counted when attempted, so a failed call still counts. The count
    lives in the cache folder: deleting .cache resets it.
    """
    path = get_settings().cache_dir / "spend.json"
    with _spend_lock:
        spent = json.loads(path.read_text()) if path.exists() else {}
        if spent.get(meter, 0) >= limit:
            raise GenerationError(
                f"spending cap reached: {limit} {meter} calls already made. "
                f"Raise {meter.upper()}_CALL_LIMIT in .env to allow more."
            )
        spent[meter] = spent.get(meter, 0) + 1
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(spent))


def gemini_image(prompt: str, images: list[Image.Image] = (), *, variant: int = 0, fresh: bool = False) -> Image.Image:
    """Generate or edit an image with Gemini's image model ("Nano Banana").

    With no input images this is text-to-image; with images it is an
    instruction-based edit. `variant` only separates cache entries, so asking
    for variants 0..n-1 gives n different results.
    """
    import httpx
    from google import genai
    from google.genai import errors as genai_errors
    from google.genai import types as genai_types

    settings = get_settings()
    _require(bool(settings.gemini_api_key), "GEMINI_API_KEY")
    model = settings.gemini_image_model
    payload = {"prompt": prompt, "images": [to_data_url(to_rgb(i), "PNG") for i in images], "variant": variant}

    def produce() -> list[Image.Image]:
        _charge("gemini_image", settings.gemini_image_call_limit)
        client = genai.Client(
            api_key=settings.gemini_api_key, http_options=genai_types.HttpOptions(timeout=IMAGE_TIMEOUT_SECONDS * 1000)
        )
        try:
            response = client.models.generate_content(model=model, contents=[*[to_rgb(i) for i in images], prompt])
        except genai_errors.APIError as e:
            raise GenerationError(f"Gemini {model} failed ({e.code}): {e.message}") from e
        except httpx.TimeoutException as e:
            raise GenerationError(f"Gemini {model} did not answer within {IMAGE_TIMEOUT_SECONDS} s") from e
        except httpx.TransportError as e:
            raise GenerationError(f"could not reach Gemini {model}") from e
        for candidate in response.candidates or []:
            for part in (candidate.content.parts if candidate.content else None) or []:
                if part.inline_data and part.inline_data.data:
                    img = Image.open(io.BytesIO(part.inline_data.data))
                    img.load()
                    return [img.convert("RGB")]
        raise GenerationError(f"Gemini {model} returned no image")

    return _cached(f"gemini/{model}", payload, produce, fresh)[0]


def fal_run(endpoint: str, arguments: dict) -> list[Image.Image]:
    """Run a fal image model and download the images it returns."""
    _require(bool(get_settings().fal_key), "FAL_KEY")
    try:
        result = fal_client.subscribe(endpoint, arguments=arguments, client_timeout=IMAGE_TIMEOUT_SECONDS)
    except fal_client.FalClientTimeoutError as e:
        raise GenerationError(f"fal {endpoint} did not answer within {IMAGE_TIMEOUT_SECONDS} s") from e
    except fal_client.FalClientHTTPError as e:
        raise GenerationError(f"fal {endpoint} failed ({e.status_code}): {e.message}") from e
    except fal_client.FalClientError as e:
        raise GenerationError(f"fal {endpoint} failed: {e}") from e
    images = [fetch_image(item["url"]) for item in result.get("images", [])]
    if not images:
        raise GenerationError(f"fal {endpoint} returned no images")
    return images


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
    if provider() == "gemini":
        instruction = (
            "This photo was relit by a rough shading algorithm. Re-render it as a natural, realistic photograph "
            "with physically plausible light and shadow. Keep the light coming from exactly the same direction "
            "and with the same brightness pattern as shown, and keep the subject, pose, framing and colors "
            f"unchanged. {prompt}"
        )
        return gemini_image(instruction, [image], fresh=fresh).resize(image.size, Image.LANCZOS)
    arguments = {
        "prompt": prompt,
        "image_url": to_data_url(image, "PNG"),
        "initial_latent": light_from,
        "output_format": "png",
    }
    if seed is not None:
        arguments["seed"] = seed
    return _cached(FAL_RELIGHT, arguments, lambda: fal_run(FAL_RELIGHT, arguments)[:1], fresh)[0].convert("RGB")
