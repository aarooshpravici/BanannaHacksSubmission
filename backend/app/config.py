"""Settings loaded from the repo-root .env file."""

import os
from functools import lru_cache
from pathlib import Path

from dotenv import dotenv_values
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = REPO_ROOT / ".env"

# Some libraries read their keys from os.environ (fal reads FAL_KEY, the
# Hugging Face downloader reads HF_TOKEN), so export the non-empty ones. Empty
# values are skipped on purpose so they cannot shadow other credential sources.
for _name, _value in dotenv_values(ENV_FILE).items():
    if _value and _name not in os.environ:
        os.environ[_name] = _value


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")

    fal_key: str = ""
    gemini_api_key: str = ""

    # When true, providers return canned results and never call a paid API.
    mock_mode: bool = True

    # Model id from ai.google.dev/gemini-api/docs/models as of 2026-10-10.
    gemini_image_model: str = "gemini-3.1-flash-image"

    # Which service makes images: "gemini", "fal", or "auto" (Gemini if it has
    # a key, otherwise fal).
    image_provider: str = "auto"
    # Hard cap on paid Gemini image generations, counted across runs in
    # .cache/spend.json. Raise it deliberately; cached results do not count.
    gemini_image_call_limit: int = 10
    cache_dir: Path = REPO_ROOT / ".cache"

    def configured(self) -> dict[str, bool]:
        """Which providers have a key set. Never returns the keys themselves."""
        return {
            "fal": bool(self.fal_key),
            "gemini": bool(self.gemini_api_key),
        }


@lru_cache
def get_settings() -> Settings:
    return Settings()
