"""Dominant-color palettes and a palette match score."""

from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image

# Lab distance at which two colors count as completely different. A just
# noticeable difference is about 2.3; 50 is roughly "red vs orange-yellow".
MAX_DELTA_E = 50.0


@dataclass
class Swatch:
    hex: str
    weight: float  # fraction of pixels, 0..1
    lab: tuple[float, float, float]


def _pixels_lab(img: Image.Image, mask: np.ndarray | None, sample_side: int) -> np.ndarray:
    """Float Lab pixels (L 0..100, a/b about -127..127) of the visible area."""
    rgba = img.convert("RGBA")
    rgba.thumbnail((sample_side, sample_side), Image.BILINEAR)
    arr = np.asarray(rgba)
    keep = arr[..., 3] > 127
    if mask is not None:
        small = cv2.resize(mask, (arr.shape[1], arr.shape[0]), interpolation=cv2.INTER_NEAREST)
        keep &= small > 127
    rgb = arr[..., :3].astype(np.float32) / 255.0
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2Lab)
    return lab[keep]


def extract_palette(
    img: Image.Image, k: int = 5, *, mask: np.ndarray | None = None, sample_side: int = 128
) -> list[Swatch]:
    """The k dominant colors of an image, most common first.

    Transparent pixels are ignored, so a character cutout gives the character's
    palette and not the background's. `mask` (0/255, image-sized) restricts the
    palette to a region.
    """
    pixels = _pixels_lab(img, mask, sample_side)
    if len(pixels) == 0:
        return []
    k = min(k, len(np.unique(pixels.round(), axis=0)))
    if k == 1:
        # One flat color (or a single visible pixel): nothing to cluster, and
        # k-means rejects it.
        lab = pixels.mean(axis=0).astype(np.float32)
        r, g, b = np.clip(cv2.cvtColor(lab.reshape(1, 1, 3), cv2.COLOR_Lab2RGB).reshape(3) * 255.0, 0, 255).round().astype(int)
        return [Swatch(hex=f"#{r:02x}{g:02x}{b:02x}", weight=1.0, lab=tuple(map(float, lab)))]
    cv2.setRNGSeed(0)  # same image, same palette
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    _, labels, centers = cv2.kmeans(pixels, k, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(labels.ravel(), minlength=k).astype(np.float64)
    weights = counts / counts.sum()
    rgb = cv2.cvtColor(centers.reshape(1, k, 3).astype(np.float32), cv2.COLOR_Lab2RGB).reshape(k, 3)
    rgb8 = np.clip(rgb * 255.0, 0, 255).round().astype(int)
    swatches = [
        Swatch(hex="#{:02x}{:02x}{:02x}".format(*rgb8[i]), weight=float(weights[i]), lab=tuple(map(float, centers[i])))
        for i in range(k)
    ]
    return sorted(swatches, key=lambda s: -s.weight)


def _one_way(a: list[Swatch], b: list[Swatch]) -> float:
    """Weighted mean Lab distance from each color in `a` to its nearest in `b`."""
    b_lab = np.array([s.lab for s in b])
    total = 0.0
    for s in a:
        nearest = np.linalg.norm(b_lab - np.array(s.lab), axis=1).min()
        total += s.weight * min(float(nearest), MAX_DELTA_E)
    return total / sum(s.weight for s in a)


def palette_score(a: list[Swatch], b: list[Swatch]) -> float:
    """How well two palettes match, 0..1. Symmetric.

    Both directions are checked, so a candidate is penalized for dropping one of
    the original's colors and for introducing a color the original lacks.
    """
    if not a or not b:
        return 0.0
    distance = (_one_way(a, b) + _one_way(b, a)) / 2
    return 1.0 - distance / MAX_DELTA_E
