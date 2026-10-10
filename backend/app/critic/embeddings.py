"""Image and text embeddings for "does this look like that" scoring.

DINOv2 compares two images by appearance (identity / style consistency).
CLIP compares an image with a text prompt (did the output match the intent).
Models load on first use and stay in memory.
"""

import threading
from functools import lru_cache

import numpy as np
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModel, CLIPModel, CLIPProcessor

from ..images import to_rgb

DINO_MODEL = "facebook/dinov2-small"
CLIP_MODEL = "openai/clip-vit-base-patch32"

# Model calls from concurrent job threads are serialized; MPS is not thread-safe.
_lock = threading.Lock()


@lru_cache
def device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


@lru_cache
def _dino():
    processor = AutoImageProcessor.from_pretrained(DINO_MODEL)
    model = AutoModel.from_pretrained(DINO_MODEL).to(device()).eval()
    return processor, model


@lru_cache
def _clip():
    processor = CLIPProcessor.from_pretrained(CLIP_MODEL)
    model = CLIPModel.from_pretrained(CLIP_MODEL).to(device()).eval()
    return processor, model


def _unit(t: torch.Tensor) -> np.ndarray:
    t = torch.nn.functional.normalize(t.float(), dim=-1)
    return t[0].cpu().numpy()


def _pooled(out) -> torch.Tensor:
    # get_*_features returned a bare tensor in transformers 4 and an output
    # object in 5; accept both.
    return out if isinstance(out, torch.Tensor) else out.pooler_output


def image_embedding(img: Image.Image) -> np.ndarray:
    """Unit-length DINOv2 embedding (the CLS token) of an image."""
    processor, model = _dino()
    inputs = processor(images=to_rgb(img), return_tensors="pt").to(device())
    with _lock, torch.no_grad():
        out = model(**inputs)
    return _unit(out.last_hidden_state[:, 0])


def clip_image_embedding(img: Image.Image) -> np.ndarray:
    processor, model = _clip()
    inputs = processor(images=to_rgb(img), return_tensors="pt").to(device())
    with _lock, torch.no_grad():
        out = model.get_image_features(**inputs)
    return _unit(_pooled(out))


def clip_text_embedding(text: str) -> np.ndarray:
    processor, model = _clip()
    inputs = processor(text=[text], return_tensors="pt", padding=True, truncation=True).to(device())
    with _lock, torch.no_grad():
        out = model.get_text_features(**inputs)
    return _unit(_pooled(out))


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity of two unit vectors, in [-1, 1]."""
    return float(np.clip(np.dot(a, b), -1.0, 1.0))


def image_similarity(a: Image.Image, b: Image.Image) -> float:
    """How alike two images look, 0..1 (DINOv2 cosine, negatives clipped)."""
    return max(0.0, cosine(image_embedding(a), image_embedding(b)))


def text_image_similarity(text: str, img: Image.Image) -> float:
    """Raw CLIP cosine between a prompt and an image.

    CLIP text-image cosines live in a narrow band (roughly 0.15 unrelated to
    0.35 strong match), so use this to rank candidates against each other, not
    as an absolute 0..1 quality score.
    """
    return cosine(clip_text_embedding(text), clip_image_embedding(img))
