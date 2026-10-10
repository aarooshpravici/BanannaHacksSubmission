"""Disk cache for generated images.

Two jobs: never pay twice for the same request while developing, and keep the
demo working when a hosted API is slow or down (a cached request still answers).
The images themselves are stored, not the provider's result URLs, because those
URLs expire.
"""

import hashlib
import json
from pathlib import Path
from typing import Any

from PIL import Image

from .config import get_settings


def _key(payload: Any) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()[:32]


class ImageCache:
    def __init__(self, root: Path | None = None):
        self.root = root or get_settings().cache_dir

    def _dir(self, namespace: str, payload: Any) -> Path:
        return self.root / namespace.replace("/", "_") / _key(payload)

    def get(self, namespace: str, payload: Any) -> list[Image.Image] | None:
        """The images saved for this exact request, or None."""
        folder = self._dir(namespace, payload)
        if not (folder / "done").exists():
            return None
        images = []
        for path in sorted(folder.glob("*.png")):
            img = Image.open(path)
            img.load()
            images.append(img)
        return images or None

    def set(self, namespace: str, payload: Any, images: list[Image.Image]) -> None:
        folder = self._dir(namespace, payload)
        folder.mkdir(parents=True, exist_ok=True)
        # Clear the marker first, so an interrupted overwrite is a miss, not a partial hit.
        (folder / "done").unlink(missing_ok=True)
        for old in folder.glob("*.png"):
            old.unlink()
        for i, img in enumerate(images):
            img.save(folder / f"{i:02d}.png")
        # Written last: a half-written folder is never read as a hit.
        (folder / "done").touch()


cache = ImageCache()
