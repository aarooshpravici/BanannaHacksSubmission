"""Tests for the shared core that need no model downloads and no network."""

import base64
import io
import time
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app import images
from app.cache import ImageCache
from app.jobs import JobStore


def _png_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


# --- images ---------------------------------------------------------------


def test_image_roundtrip_is_lossless():
    arr = np.random.default_rng(0).integers(0, 255, (40, 60, 3), dtype=np.uint8)
    out = images.decode_image(images.encode_image(Image.fromarray(arr)))
    assert out.mode == "RGB" and np.array_equal(np.asarray(out), arr)


def test_decode_accepts_data_url_and_keeps_alpha():
    rgba = Image.new("RGBA", (10, 10), (255, 0, 0, 0))
    out = images.decode_image("data:image/png;base64," + _png_b64(rgba))
    assert out.mode == "RGBA"


def test_decode_rejects_garbage():
    with pytest.raises(images.ImageError):
        images.decode_image("not an image")


def test_decode_downscales_huge_images():
    out = images.decode_image(_png_b64(Image.new("RGB", (5000, 2500))))
    assert out.size == (2048, 1024)


def test_to_rgb_flattens_transparency_onto_background():
    out = images.to_rgb(Image.new("RGBA", (4, 4), (255, 0, 0, 0)), background=(0, 255, 0))
    assert out.getpixel((0, 0)) == (0, 255, 0)


# --- jobs -----------------------------------------------------------------


def _wait(store: JobStore, job_id: str, timeout: float = 5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = store.get(job_id)
        if job.status != "pending":
            return job
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def test_job_runs_in_background_and_returns_result():
    store = JobStore()
    job_id = store.submit(lambda a, b: (time.sleep(0.05), a + b)[1], 2, 3)
    assert store.get(job_id).status == "pending"
    job = _wait(store, job_id)
    assert job.status == "done" and job.result == 5


def test_job_failure_is_reported_not_raised():
    store = JobStore()
    job = _wait(store, store.submit(lambda: 1 / 0))
    assert job.status == "error" and "ZeroDivisionError" in job.error


def test_unknown_job_is_none():
    assert JobStore().get("nope") is None


def test_old_finished_jobs_are_evicted():
    store = JobStore(max_jobs=3)
    ids = [store.submit(lambda: 1) for _ in range(3)]
    for i in ids:
        _wait(store, i)
    newest = store.submit(lambda: 2)
    assert store.get(ids[0]) is None and store.get(newest) is not None


# --- cache ----------------------------------------------------------------


def test_image_cache_hit_miss_and_key_order(tmp_path):
    c = ImageCache(tmp_path)
    red, blue = Image.new("RGB", (4, 4), (255, 0, 0)), Image.new("RGB", (4, 4), (0, 0, 255))
    assert c.get("ns/model", {"a": 1, "b": 2}) is None
    c.set("ns/model", {"a": 1, "b": 2}, [red, blue])
    hit = c.get("ns/model", {"b": 2, "a": 1})  # key order does not matter
    assert [im.getpixel((0, 0)) for im in hit] == [(255, 0, 0), (0, 0, 255)]
    assert c.get("ns/model", {"a": 1, "b": 3}) is None
    assert c.get("other", {"a": 1, "b": 2}) is None
    c.set("ns/model", {"a": 1, "b": 2}, [blue])  # overwrite replaces, not appends
    assert len(c.get("ns/model", {"a": 1, "b": 2})) == 1


def test_interrupted_cache_overwrite_is_a_miss_not_a_partial_hit(tmp_path, monkeypatch):
    c = ImageCache(tmp_path)
    red = Image.new("RGB", (4, 4), (255, 0, 0))
    c.set("ns", {"a": 1}, [red, red, red])
    real_touch = Path.touch
    monkeypatch.setattr(Path, "touch", lambda self, *a, **k: (_ for _ in ()).throw(OSError("killed mid-write")))
    with pytest.raises(OSError):
        c.set("ns", {"a": 1}, [red])
    monkeypatch.setattr(Path, "touch", real_touch)
    assert c.get("ns", {"a": 1}) is None
