"""Vision LLM calls that return validated, typed JSON.

Used for the planner (what is missing here?), the analyst (describe this
character as a feature list) and the checklist critic (is each feature present?).

Answers are looked up in this order:
  1. a saved answer in backend/fixtures/llm/ (committed, so demo images work
     with no key and no network);
  2. the mock response, when MOCK_MODE is on;
  3. a live call, with ANTHROPIC_API_KEY if set, else GEMINI_API_KEY;
  4. otherwise the request (images + prompt + schema) is written next to where
     its answer belongs and LLMUnavailable is raised, so someone can look at
     the images and write the answer file by hand.
"""

import hashlib
import json
import logging
from pathlib import Path
from typing import TypeVar

import anthropic
from PIL import Image
from pydantic import BaseModel, ValidationError

from ..config import get_settings
from ..images import encode_image, resize_max_side

log = logging.getLogger(__name__)

SchemaT = TypeVar("SchemaT", bound=BaseModel)

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "llm"

# Longest image side sent to the model. Larger images cost more tokens without
# helping layout- or feature-level questions.
LLM_MAX_SIDE = 1568

# A stalled call must fail, not hang a request or pin a job worker forever.
LLM_TIMEOUT_SECONDS = 90


class LLMError(RuntimeError):
    """The vision LLM call failed in a way the caller should report."""


class LLMUnavailable(LLMError):
    """No saved answer and no API key. `request_dir` holds the pending request."""

    def __init__(self, request_dir: Path, answer_path: Path):
        super().__init__(f"no vision LLM available; write the answer to {answer_path}")
        self.request_dir = request_dir
        self.answer_path = answer_path


def _prepared(images: list[Image.Image]) -> list[Image.Image]:
    return [resize_max_side(img, LLM_MAX_SIDE) for img in images]


def request_key(images: list[Image.Image], prompt: str, schema: type[BaseModel]) -> str:
    """Stable id for a request: same images + prompt + schema, same key."""
    h = hashlib.sha256()
    for img in _prepared(images):
        h.update(img.convert("RGBA").tobytes())
        h.update(str(img.size).encode())
    h.update(prompt.encode())
    h.update(json.dumps(schema.model_json_schema(), sort_keys=True).encode())
    return h.hexdigest()[:20]


def _load_fixture(path: Path, schema: type[SchemaT]) -> SchemaT | None:
    if not path.exists():
        return None
    try:
        return schema.model_validate_json(path.read_text())
    except ValidationError as e:
        raise LLMError(f"saved answer {path} does not match {schema.__name__}: {e}") from e


def _save_request(request_dir: Path, images: list[Image.Image], prompt: str, schema: type[BaseModel]) -> None:
    request_dir.mkdir(parents=True, exist_ok=True)
    for i, img in enumerate(images):
        img.save(request_dir / f"image_{i}.png")
    (request_dir / "prompt.txt").write_text(prompt)
    (request_dir / "schema.json").write_text(json.dumps(schema.model_json_schema(), indent=2))


def vision_json(
    images: list[Image.Image],
    prompt: str,
    schema: type[SchemaT],
    *,
    system: str | None = None,
    mock: SchemaT | None = None,
) -> SchemaT:
    """Ask the vision LLM about one or more images; get back a `schema` instance."""
    settings = get_settings()
    images = _prepared(images)
    full_prompt = f"{system}\n\n{prompt}" if system else prompt
    key = request_key(images, full_prompt, schema)
    answer_path = FIXTURE_DIR / f"{key}.json"

    if (saved := _load_fixture(answer_path, schema)) is not None:
        return saved
    if settings.mock_mode:
        if mock is None:
            raise LLMError("MOCK_MODE is on and this call has no mock response")
        return mock

    if settings.anthropic_api_key:
        answer = _ask_anthropic(images, prompt, schema, system)
    elif settings.gemini_api_key:
        answer = _ask_gemini(images, full_prompt, schema)
    else:
        request_dir = FIXTURE_DIR / f"{key}.request"
        _save_request(request_dir, images, full_prompt, schema)
        raise LLMUnavailable(request_dir, answer_path)

    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    answer_path.write_text(answer.model_dump_json(indent=2))
    return answer


def _ask_anthropic(images: list[Image.Image], prompt: str, schema: type[SchemaT], system: str | None) -> SchemaT:
    """UNTESTED: no Anthropic key was available when this was written."""
    client = anthropic.Anthropic(timeout=LLM_TIMEOUT_SECONDS)
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": encode_image(img, "PNG")}}
        for img in images
    ] + [{"type": "text", "text": prompt}]
    kwargs = {"system": system} if system else {}
    try:
        # Server-side fallback: if the model's safety classifier declines the
        # request, the API reruns it on Anthropic's recommended fallback model.
        response = client.beta.messages.parse(
            model=get_settings().llm_model,
            max_tokens=16000,
            messages=[{"role": "user", "content": content}],
            output_format=schema,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            **kwargs,
        )
    except anthropic.AuthenticationError as e:
        raise LLMError("ANTHROPIC_API_KEY was rejected") from e
    except anthropic.RateLimitError as e:
        raise LLMError("vision LLM rate limit hit; retry shortly") from e
    except anthropic.APIStatusError as e:
        raise LLMError(f"vision LLM API error {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise LLMError("could not reach the vision LLM API") from e
    except ValidationError as e:
        # parse() validates the reply itself, so JSON cut off by max_tokens surfaces here.
        raise LLMError(f"vision LLM returned JSON that does not match {schema.__name__}") from e

    if response.stop_reason == "refusal":
        raise LLMError("the vision LLM declined this image")
    if response.stop_reason == "max_tokens" or response.parsed_output is None:
        raise LLMError(f"vision LLM returned no usable JSON (stop_reason={response.stop_reason})")
    return response.parsed_output


def _ask_gemini(images: list[Image.Image], prompt: str, schema: type[SchemaT]) -> SchemaT:
    """UNTESTED: no Gemini key was available when this was written."""
    import httpx
    from google import genai
    from google.genai import errors as genai_errors
    from google.genai import types as genai_types

    client = genai.Client(
        api_key=get_settings().gemini_api_key,
        http_options=genai_types.HttpOptions(timeout=LLM_TIMEOUT_SECONDS * 1000),
    )
    try:
        response = client.models.generate_content(
            model=get_settings().gemini_model,
            contents=[*images, prompt],
            config={"response_mime_type": "application/json", "response_schema": schema},
        )
    except genai_errors.APIError as e:
        raise LLMError(f"Gemini API error {e.code}: {e.message}") from e
    except httpx.TimeoutException as e:
        raise LLMError(f"Gemini did not answer within {LLM_TIMEOUT_SECONDS} s") from e
    except httpx.TransportError as e:
        raise LLMError("could not reach the Gemini API") from e
    try:
        return schema.model_validate_json(response.text or "")
    except ValidationError as e:
        raise LLMError(f"Gemini returned JSON that does not match {schema.__name__}") from e
