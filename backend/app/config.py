"""Settings loaded from the repo-root .env file."""

import os
from functools import lru_cache
from pathlib import Path

from dotenv import dotenv_values
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = REPO_ROOT / ".env"

# The provider SDKs (fal, replicate, anthropic) read their keys from os.environ,
# so export the non-empty ones. Empty values are skipped on purpose: an empty
# ANTHROPIC_API_KEY would shadow other credential sources.
for _name, _value in dotenv_values(ENV_FILE).items():
    if _value and _name not in os.environ:
        os.environ[_name] = _value


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")

    fal_key: str = ""
    replicate_api_token: str = ""
    anthropic_api_key: str = ""
    gemini_api_key: str = ""
    hf_token: str = ""

    # When true, providers return canned results and never call a paid API.
    mock_mode: bool = True

    llm_model: str = "claude-opus-5-5"
    # Used only when there is a Gemini key and no Anthropic key. Model ids are
    # from ai.google.dev/gemini-api/docs/models as of 2026-10-10.
    gemini_model: str = "gemini-3.8-flash"
    gemini_image_model: str = "gemini-3.1-flash-image"
    cache_dir: Path = REPO_ROOT / ".cache"

    def configured(self) -> dict[str, bool]:
        """Which providers have a key set. Never returns the keys themselves."""
        return {
            "fal": bool(self.fal_key),
            "replicate": bool(self.replicate_api_token),
            "anthropic": bool(self.anthropic_api_key),
            "gemini": bool(self.gemini_api_key),
        }


@lru_cache
def get_settings() -> Settings:
    return Settings()
