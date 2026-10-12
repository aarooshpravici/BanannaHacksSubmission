"""HTTP-level tests of the shared endpoints and the provider mock/fixture paths."""

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import get_settings
from app.ideas import relight as R
from app.images import decode_image, encode_image
from app.jobs import jobs
from app.main import app
from app.providers import generation
from app.routers import relight as relight_router

client = TestClient(app)


def _stored_scene() -> str:
    """A scene put straight into the server's store, so that no model has to run: a grey photo of a bump on a plane."""
    ys, xs = np.mgrid[0:64, 0:64]
    bump = np.clip(1.0 - ((xs - 32) ** 2 + (ys - 32) ** 2) / 19.0**2, 0.0, 1.0).astype(np.float32)
    scene = relight_router._Scene(Image.new("RGB", (64, 64), (150, 150, 150)), R.build_geometry(bump, smooth=0))
    relight_router._scenes["fill-test"] = scene
    return "fill-test"


def _render(body: dict) -> np.ndarray:
    resp = client.post("/relight/render", json=body)
    assert resp.status_code == 200, resp.text
    return np.asarray(decode_image(resp.json()["image"])).astype(int)


def test_health_reports_mode_and_never_leaks_keys():
    body = client.get("/health").json()
    assert body["ok"] is True and body["mock_mode"] is True
    assert set(body["providers"]) == {"fal", "gemini"}
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
    resp = client.post("/relight/scene", json={"image": "definitely not base64 image data"})
    assert resp.status_code == 400 and "image" in resp.json()["detail"]


def test_missing_field_is_a_422():
    assert client.post("/relight/scene", json={}).status_code == 422


def test_unexpected_error_is_a_json_500_the_browser_is_allowed_to_read(monkeypatch):
    def boom(_):
        raise RuntimeError("model fell over")

    monkeypatch.setattr("app.routers.relight.R.estimate_height", boom)
    image = encode_image(Image.new("RGB", (8, 8)))
    resp = client.post("/relight/scene", json={"image": image}, headers={"Origin": "http://localhost:3000"})
    assert resp.status_code == 500 and "unexpected error" in resp.json()["detail"]
    # Without this header the browser hides the response and the page says the backend is unreachable.
    assert resp.headers["access-control-allow-origin"] == "*"


# --- the fill light ---------------------------------------------------------


def test_a_render_without_a_fill_light_is_what_it_always_was():
    scene_id = _stored_scene()
    light = {"x": -0.2, "y": 0.4, "height": 0.2, "intensity": 1.5, "ambient": 0.1}
    # What a client from before the fill light sends, and what such a client's request gave.
    before = _render({"scene_id": scene_id, "light": light})
    stored = relight_router._scenes[scene_id]
    expected = R.relight(stored.image, stored.geom, R.Light(-0.2, 0.4, 0.2, 1.5, 0.1))
    assert np.array_equal(before, np.asarray(decode_image(encode_image(expected, "JPEG"))))
    assert np.array_equal(_render({"scene_id": scene_id, "light": light, "fill": None}), before), "null is off"
    assert np.array_equal(_render({"scene_id": scene_id, "light": light, "shadows": True}), before)


def test_a_fill_light_on_the_right_lifts_the_right_of_the_picture():
    scene_id = _stored_scene()
    light = {"x": -0.2, "y": 0.4, "height": 0.2, "intensity": 1.5, "ambient": 0.1}
    before = _render({"scene_id": scene_id, "light": light})
    fill = {"x": 1.2, "y": 0.4, "height": 0.35, "intensity": 0.6, "color": [1.0, 1.0, 1.0]}
    after = _render({"scene_id": scene_id, "light": light, "fill": fill})
    assert after[:, 48:].mean() > before[:, 48:].mean() + 15
    assert after[:, 48:].mean() - before[:, 48:].mean() > 2 * (after[:, :16].mean() - before[:, :16].mean())
    # Every field of a fill has a default, as every field of the light has.
    assert _render({"scene_id": scene_id, "light": light, "fill": {}}).mean() > before.mean()
    # A fill has no ambient of its own: one that is sent is not an error, and is not used.
    assert np.array_equal(_render({"scene_id": scene_id, "light": light, "fill": {**fill, "ambient": 0.9}}), after)


@pytest.mark.parametrize(
    "fill",
    [
        {"height": 0},  # a light on the surface itself
        {"height": 2.5},
        {"intensity": -0.1},
        {"intensity": 4.5},
        {"color": [1.0, 1.0]},
        {"x": "left"},
        "on",
        [0.8, 0.2],
    ],
)
def test_a_fill_light_that_makes_no_sense_is_a_422(fill):
    scene_id = _stored_scene()
    assert client.post("/relight/render", json={"scene_id": scene_id, "fill": fill}).status_code == 422
    assert client.post("/relight/enhance", json={"scene_id": scene_id, "fill": fill}).status_code == 422


def test_enhance_takes_a_fill_light_too():
    scene_id = _stored_scene()

    def enhanced(body: dict) -> np.ndarray:
        job_id = client.post("/relight/enhance", json={"scene_id": scene_id, **body}).json()["job_id"]
        for _ in range(200):
            status = client.get(f"/jobs/{job_id}").json()
            if status["status"] != "pending":
                break
        assert status["status"] == "done", status
        return np.asarray(decode_image(status["result"]["image"])).astype(int)

    # In mock mode the provider hands back the picture it was sent.
    light = {"x": -0.2, "y": 0.4}
    plain = enhanced({"light": light})
    assert np.array_equal(enhanced({"light": light, "fill": None}), plain)
    assert enhanced({"light": light, "fill": {"x": 1.2, "y": 0.4}})[:, 48:].mean() > plain[:, 48:].mean() + 10


# --- providers without keys -------------------------------------------------


def test_mock_enhance_returns_the_preview_unchanged():
    img = Image.new("RGB", (8, 8), (1, 2, 3))
    assert generation.relight_enhance(img, "anything") is img


def test_an_empty_enhance_box_asks_for_the_tidy_up_it_always_did():
    # Word for word: results already paid for are found again in the cache by these words.
    assert generation.enhance_instruction("  ", "Left") == (
        "This photo was relit by a rough shading algorithm. Re-render it as a natural, realistic photograph "
        "with physically plausible light and shadow. Keep the light coming from exactly the same direction "
        "and with the same brightness pattern as shown, and keep the subject, pose, framing and colors "
        "unchanged. natural realistic lighting, detailed photo"
    )


def test_a_typed_enhance_request_leads_and_the_tidy_up_is_only_a_preference():
    words = generation.enhance_instruction("  golden hour,\n on a beach ", "Right")
    assert "Request: golden hour, on a beach\n" in words
    assert words.index("Request:") < words.index("prefer, but do not insist on")
    assert "the light coming from the right, as in the photo" in words
    # The old rule, which a request could not get past, is gone.
    assert "unchanged" not in words and "exactly the same direction" not in words
    assert "same direction as in the photo" in generation.enhance_instruction("warmer")
    assert len(generation.enhance_instruction("x" * 5000)) < 1200


def test_real_generation_without_key_fails_with_a_clear_message(monkeypatch):
    monkeypatch.setattr(get_settings(), "mock_mode", False)
    monkeypatch.setattr(get_settings(), "image_provider", "auto")
    monkeypatch.setattr(get_settings(), "fal_key", "")
    with pytest.raises(generation.GenerationError, match="FAL_KEY"):
        generation.relight_enhance(Image.new("RGB", (8, 8)), "x")


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
