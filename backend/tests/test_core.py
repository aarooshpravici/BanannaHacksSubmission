"""Tests for the shared core that need no model downloads and no network."""

import base64
import io
import time

import numpy as np
import pytest
from PIL import Image

from app import images
from app.cache import ImageCache
from app.critic.palette import extract_palette, palette_score
from app.critic.scoring import generate_and_rank, weighted_total
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


def test_mask_is_binarized_and_resized_to_image():
    mask = Image.new("L", (20, 10), 0)
    mask.paste(200, (0, 0, 10, 10))
    arr = images.decode_mask(_png_b64(mask), size=(40, 20))
    assert arr.shape == (20, 40) and set(np.unique(arr)) == {0, 255}
    assert arr[:, :20].all() and not arr[:, 20:].any()


def test_mask_drawn_on_transparent_canvas_uses_alpha():
    canvas = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
    canvas.paste((0, 0, 0, 255), (2, 2, 6, 6))  # black brush strokes
    arr = images.decode_mask(_png_b64(canvas), size=(10, 10))
    assert arr[3, 3] == 255 and arr[0, 0] == 0


def test_empty_mask_is_rejected():
    with pytest.raises(images.ImageError):
        images.decode_mask(_png_b64(Image.new("L", (10, 10), 0)), size=(10, 10))


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


# --- palette --------------------------------------------------------------


def _two_tone(left: tuple, right: tuple, split: int = 30) -> Image.Image:
    img = Image.new("RGB", (40, 40), right)
    img.paste(left, (0, 0, split, 40))
    return img


def test_palette_finds_colors_in_order_of_area():
    p = extract_palette(_two_tone((255, 0, 0), (0, 0, 255)), k=2)
    assert [s.hex for s in p] == ["#ff0000", "#0000ff"]
    assert p[0].weight == pytest.approx(0.75, abs=0.02)


def test_palette_ignores_transparent_pixels():
    img = Image.new("RGBA", (40, 40), (0, 255, 0, 0))  # transparent green
    img.paste((255, 0, 0, 255), (0, 0, 10, 10))
    p = extract_palette(img, k=3)
    assert [s.hex for s in p] == ["#ff0000"]


def test_palette_respects_mask():
    mask = np.zeros((40, 40), np.uint8)
    mask[:, 30:] = 255
    p = extract_palette(_two_tone((255, 0, 0), (0, 0, 255)), k=2, mask=mask)
    assert [s.hex for s in p] == ["#0000ff"]


def test_palette_score_orders_same_similar_different():
    base = extract_palette(_two_tone((200, 30, 30), (30, 30, 200)), k=2)
    same = extract_palette(_two_tone((200, 30, 30), (30, 30, 200)), k=2)
    near = extract_palette(_two_tone((215, 45, 40), (40, 40, 185)), k=2)
    far = extract_palette(_two_tone((30, 200, 30), (240, 240, 60)), k=2)
    s_same, s_near, s_far = (palette_score(base, p) for p in (same, near, far))
    assert s_same == pytest.approx(1.0)
    assert s_same > s_near > s_far
    assert s_near > 0.8 and s_far < 0.3


def test_palette_score_penalizes_a_dropped_color():
    full = extract_palette(_two_tone((200, 30, 30), (30, 30, 200), split=20), k=2)
    lost_blue = extract_palette(Image.new("RGB", (40, 40), (200, 30, 30)), k=2)
    assert palette_score(full, lost_blue) < 0.8
    assert palette_score(full, lost_blue) == pytest.approx(palette_score(lost_blue, full))


# --- scoring --------------------------------------------------------------


def test_weighted_total_renormalizes_over_present_axes():
    weights = {"style": 0.4, "seam": 0.4, "intent": 0.2}
    assert weighted_total({"style": 1.0, "seam": 0.5, "intent": 0.0}, weights) == pytest.approx(0.6)
    assert weighted_total({"style": 1.0, "seam": 0.5}, weights) == pytest.approx(0.75)
    with pytest.raises(ValueError):
        weighted_total({"other": 1.0}, weights)


def test_loop_ranks_and_stops_when_first_batch_passes():
    calls = []

    def generate(attempt, best):
        calls.append(attempt)
        return [0.2, 0.9, 0.5]

    result = generate_and_rank(generate, lambda x: ({"q": x}, None), {"q": 1.0}, threshold=0.8, max_retries=2)
    assert calls == [0]
    assert result.best.item == 0.9 and result.passed and result.retries == 0
    assert [c.item for c in result.candidates] == [0.9, 0.5, 0.2]


def test_loop_retries_with_feedback_until_threshold():
    seen_feedback = []

    def generate(attempt, best):
        seen_feedback.append(best.notes if best else None)
        return [0.3 + 0.3 * attempt]

    result = generate_and_rank(
        generate, lambda x: ({"q": x}, f"missing scarf at {x:.1f}"), {"q": 1.0}, threshold=0.8, max_retries=3
    )
    assert result.retries == 2 and result.passed and result.best.item == pytest.approx(0.9)
    assert seen_feedback == [None, "missing scarf at 0.3", "missing scarf at 0.6"]
    assert result.history == pytest.approx([0.3, 0.6, 0.9])


def test_loop_keeps_earlier_best_when_retries_get_worse():
    def generate(attempt, best):
        return [0.6 - 0.2 * attempt]

    result = generate_and_rank(generate, lambda x: ({"q": x}, None), {"q": 1.0}, threshold=0.9, max_retries=2)
    assert result.best.item == pytest.approx(0.6) and result.best.attempt == 0
    assert not result.passed and result.retries == 2 and len(result.candidates) == 3
