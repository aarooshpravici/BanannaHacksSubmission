"""HTTP-level tests of the shared endpoints and the provider mock/fixture paths."""

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pydantic import BaseModel

from app.config import get_settings
from app.images import decode_image, encode_image
from app.jobs import jobs
from app.main import app
from app.providers import generation, llm

client = TestClient(app)


def _character() -> Image.Image:
    """A crude 'character': a red body and a skin-tone head on a pale background."""
    img = Image.new("RGB", (256, 256), (235, 235, 240))
    d = ImageDraw.Draw(img)
    d.rectangle((96, 110, 160, 230), fill=(200, 40, 40))
    d.ellipse((98, 40, 158, 110), fill=(240, 200, 170))
    return img


def test_health_reports_mode_and_never_leaks_keys():
    body = client.get("/health").json()
    assert body["ok"] is True and body["mock_mode"] is True
    assert set(body["providers"]) == {"fal", "replicate", "anthropic", "gemini"}
    assert all(isinstance(v, bool) for v in body["providers"].values())


def test_job_polling_roundtrip_and_404():
    job_id = jobs.submit(lambda: {"answer": 42})
    for _ in range(200):
        body = client.get(f"/jobs/{job_id}").json()
        if body["status"] != "pending":
            break
    assert body == {"status": "done", "result": {"answer": 42}, "error": None}
    assert client.get("/jobs/does-not-exist").status_code == 404


def test_bad_image_is_a_400_not_a_500():
    resp = client.post("/cutout", json={"image": "definitely not base64 image data"})
    assert resp.status_code == 400 and "image" in resp.json()["detail"]


def test_missing_field_is_a_422():
    assert client.post("/cutout", json={}).status_code == 422


def test_unexpected_error_is_a_json_500_the_browser_is_allowed_to_read(monkeypatch):
    def boom(_):
        raise RuntimeError("model fell over")

    monkeypatch.setattr("app.routers.common.remove_background", boom)
    image = encode_image(Image.new("RGB", (8, 8)))
    resp = client.post("/cutout", json={"image": image}, headers={"Origin": "http://localhost:3000"})
    assert resp.status_code == 500 and "unexpected error" in resp.json()["detail"]
    # Without this header the browser hides the response and the page says the backend is unreachable.
    assert resp.headers["access-control-allow-origin"] == "*"


# --- providers without keys -------------------------------------------------


def test_mock_inpaint_only_changes_the_masked_region():
    img = Image.fromarray(np.random.default_rng(1).integers(0, 255, (64, 64, 3), dtype=np.uint8))
    mask = np.zeros((64, 64), np.uint8)
    mask[20:40, 20:40] = 255
    out = generation.inpaint(img, mask, "anything", n=3)
    assert len(out) == 3 and all(o.size == img.size for o in out)
    a, b = np.asarray(img), np.asarray(out[0])
    assert np.array_equal(a[mask == 0], b[mask == 0])
    assert not np.array_equal(a[mask == 255], b[mask == 255])


def test_real_generation_without_key_fails_with_a_clear_message(monkeypatch):
    monkeypatch.setattr(get_settings(), "mock_mode", False)
    monkeypatch.setattr(get_settings(), "fal_key", "")
    with pytest.raises(generation.GenerationError, match="FAL_KEY"):
        generation.inpaint(Image.new("RGB", (8, 8)), np.full((8, 8), 255, np.uint8), "x")


class _Answer(BaseModel):
    label: str
    count: int


def test_llm_mock_then_saved_answer_then_unavailable(monkeypatch, tmp_path):
    monkeypatch.setattr(llm, "FIXTURE_DIR", tmp_path)
    img = _character()

    # 1. mock mode returns the mock
    assert llm.vision_json([img], "how many?", _Answer, mock=_Answer(label="m", count=1)).label == "m"

    # 2. no mock mode and no key: the request is written out for a human to answer
    monkeypatch.setattr(get_settings(), "mock_mode", False)
    monkeypatch.setattr(get_settings(), "anthropic_api_key", "")
    monkeypatch.setattr(get_settings(), "gemini_api_key", "")
    with pytest.raises(llm.LLMUnavailable) as exc:
        llm.vision_json([img], "how many?", _Answer)
    request_dir, answer_path = exc.value.request_dir, exc.value.answer_path
    assert (request_dir / "image_0.png").exists() and (request_dir / "prompt.txt").read_text() == "how many?"

    # 3. once the answer file exists it is served, even over the mock
    answer_path.write_text('{"label": "by hand", "count": 2}')
    got = llm.vision_json([img], "how many?", _Answer, mock=_Answer(label="m", count=1))
    assert got == _Answer(label="by hand", count=2)

    # a different prompt is a different request
    with pytest.raises(llm.LLMUnavailable):
        llm.vision_json([img], "what colour?", _Answer)

    # a saved answer of the wrong shape is an error, not a silent pass
    answer_path.write_text('{"label": "x"}')
    with pytest.raises(llm.LLMError, match="does not match"):
        llm.vision_json([img], "how many?", _Answer)


# --- endpoints that load models ---------------------------------------------


@pytest.mark.models
def test_score_endpoint_separates_same_from_different():
    char = _character()
    recolored = Image.new("RGB", (256, 256), (20, 20, 20))
    ImageDraw.Draw(recolored).polygon([(10, 240), (128, 10), (246, 240)], fill=(40, 200, 90))
    same = client.post("/score", json={"reference": encode_image(char), "candidate": encode_image(char)}).json()
    diff = client.post("/score", json={"reference": encode_image(char), "candidate": encode_image(recolored)}).json()
    assert same["total"] == pytest.approx(1.0, abs=0.01)
    assert diff["total"] < 0.5
    assert set(same["scores"]) == {"identity", "palette"}
    with_prompt = client.post(
        "/score",
        json={"reference": encode_image(char), "candidate": encode_image(char), "prompt": "a person in a red coat"},
    ).json()
    assert "intent" in with_prompt["scores"]
    bad = client.post("/score", json={"reference": encode_image(char), "candidate": encode_image(char), "weights": {"nope": 1}})
    assert bad.status_code == 422 and "identity" in bad.json()["detail"]


@pytest.mark.models
def test_cutout_endpoint_removes_background_and_reports_palette():
    resp = client.post("/cutout", json={"image": encode_image(_character())})
    assert resp.status_code == 200
    cut = decode_image(resp.json()["cutout"])
    assert cut.mode == "RGBA" and cut.size == (256, 256)
    alpha = np.asarray(cut.getchannel("A"))
    assert alpha[5, 5] < 30, "background corner should be transparent"
    assert alpha[170, 128] > 225, "body should be opaque"
    assert 0.08 < (alpha > 127).mean() < 0.45, "subject should be a minority of the frame"
    # Colors must be the original's, not darkened at soft edges (no grey fringe).
    visible = alpha > 0
    assert np.array_equal(np.asarray(cut)[..., :3][visible], np.asarray(_character())[visible])
    assert len(resp.json()["palette"]) >= 2


@pytest.mark.models
def test_cutout_of_an_exif_rotated_image_is_upright_and_lined_up():
    from app.cutout import remove_background

    upright = _character().resize((256, 192))
    for orientation, undo in ((3, Image.ROTATE_180), (6, Image.ROTATE_90)):
        # Store the pixels turned and tag them, the way a phone camera does.
        stored = upright.transpose(undo)
        exif = Image.Exif()
        exif[0x0112] = orientation
        stored.info["exif"] = exif.tobytes()
        stored.getexif()[0x0112] = orientation
        cut = remove_background(stored)
        assert cut.size == upright.size
        alpha = np.asarray(cut.getchannel("A"))
        assert alpha[5, 5] < 30 and alpha[130, 128] > 225, "the alpha must sit on the upright character"
        assert np.array_equal(np.asarray(cut)[..., :3], np.asarray(upright))


def test_spending_cap_refuses_calls_past_the_limit(monkeypatch, tmp_path):
    monkeypatch.setattr(get_settings(), "cache_dir", tmp_path)
    for _ in range(3):
        generation._charge("gemini_image", 3)
    with pytest.raises(generation.GenerationError, match="spending cap reached"):
        generation._charge("gemini_image", 3)
    assert '"gemini_image": 3' in (tmp_path / "spend.json").read_text()


def test_provider_prefers_gemini_when_it_has_a_key(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "image_provider", "auto")
    monkeypatch.setattr(s, "gemini_api_key", "x")
    assert generation.provider() == "gemini"
    monkeypatch.setattr(s, "gemini_api_key", "")
    assert generation.provider() == "fal"
    monkeypatch.setattr(s, "image_provider", "fal")
    monkeypatch.setattr(s, "gemini_api_key", "x")
    assert generation.provider() == "fal"


def test_the_test_suite_cannot_see_real_keys():
    assert not any(get_settings().configured().values())
