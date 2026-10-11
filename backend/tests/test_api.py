"""HTTP-level tests of the shared endpoints and the provider mock/fixture paths."""

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import get_settings
from app.images import encode_image
from app.jobs import jobs
from app.main import app
from app.providers import generation

client = TestClient(app)


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
