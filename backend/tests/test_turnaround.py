"""Character views: prompt building, checklist scoring and the endpoints (mock generator and LLM)."""

import time

import pytest
from PIL import Image, ImageDraw

from app.ideas import turnaround as T
from app.schemas import CharacterSpec, Feature

ALL = ["front", "three_quarter", "side", "back"]
FEATURES = [
    Feature(id="f0", name="red scarf", visible_from=ALL, critical=True),
    Feature(id="f1", name="scar over left eye", visible_from=["front", "three_quarter"], critical=False),
    Feature(id="f2", name="yellow backpack", visible_from=["side", "back"], critical=False),
]
SPEC = CharacterSpec(summary="a kid explorer", art_style="flat cartoon", features=FEATURES, palette=[])


def _drawing() -> Image.Image:
    img = Image.new("RGB", (256, 256), (235, 235, 240))
    d = ImageDraw.Draw(img)
    d.rectangle((96, 110, 160, 230), fill=(200, 40, 40))
    d.ellipse((98, 40, 158, 110), fill=(240, 200, 170))
    return img


def test_prompt_lists_only_features_visible_from_the_target_view():
    back = T.view_prompt(SPEC, FEATURES, "back")
    assert "back view" in back and "red scarf" in back and "yellow backpack" in back
    assert "scar over left eye" not in back and "flat cartoon" in back
    front = T.view_prompt(SPEC, FEATURES, "front")
    assert "scar over left eye" in front and "yellow backpack" not in front


def test_retry_prompt_spells_out_what_was_wrong():
    retry = T.view_prompt(SPEC, FEATURES, "side", missing=["red scarf"])
    assert "previous attempt" in retry and retry.rstrip().endswith("red scarf.")
    assert "previous attempt" not in T.view_prompt(SPEC, FEATURES, "side")


@pytest.mark.models
def test_checklist_score_weights_critical_features_and_penalizes_wrongly_shown_ones(monkeypatch):
    character = T.analyze(_drawing())

    def answer(present):
        def fake(images, prompt, schema, **kwargs):
            return schema(checks=[{"feature_id": k, "present": v} for k, v in present.items()])
        return fake

    # Back view: scarf and backpack expected, scar must be hidden.
    monkeypatch.setattr(T, "vision_json", answer({"f0": True, "f1": False, "f2": True}))
    scores, checklist = T.check(character.reference, character, FEATURES, "back")
    assert scores["checklist"] == pytest.approx(1.0)
    assert [(c.expected_visible, c.present) for c in checklist] == [(True, True), (False, False), (True, True)]
    assert scores["identity"] == pytest.approx(1.0, abs=0.01) and scores["palette"] > 0.9

    monkeypatch.setattr(T, "vision_json", answer({"f0": False, "f1": False, "f2": True}))  # critical scarf missing
    assert T.check(character.reference, character, FEATURES, "back")[0]["checklist"] == pytest.approx(0.5)

    monkeypatch.setattr(T, "vision_json", answer({"f0": True, "f1": True, "f2": True}))  # scar shown on a back view
    assert T.check(character.reference, character, FEATURES, "back")[0]["checklist"] == pytest.approx(0.75)

    monkeypatch.setattr(T, "vision_json", answer({"f0": True}))  # features the LLM skipped count as absent
    assert T.check(character.reference, character, FEATURES, "back")[0]["checklist"] == pytest.approx(0.75)


@pytest.mark.models
def test_turnaround_endpoints_end_to_end():
    from fastapi.testclient import TestClient

    from app.images import decode_image, encode_image
    from app.main import app

    client = TestClient(app)
    analyzed = client.post("/turnaround/analyze", json={"image": encode_image(_drawing())}).json()
    assert analyzed["source_view"] == "front" and len(analyzed["spec"]["features"]) >= 3
    assert decode_image(analyzed["cutout"]).mode == "RGBA" and len(analyzed["spec"]["palette"]) >= 2

    body = {"character_id": analyzed["character_id"], "target_view": "side"}
    job_id = client.post("/turnaround/generate", json=body).json()["job_id"]
    for _ in range(600):
        status = client.get(f"/jobs/{job_id}").json()
        if status["status"] != "pending":
            break
        time.sleep(0.1)
    assert status["status"] == "done", status
    result = status["result"]
    assert decode_image(result["image"]).size[0] > 0 and 0 <= result["scores"]["total"] <= 1
    assert {c["feature_id"] for c in result["checklist"]} == {f["id"] for f in analyzed["spec"]["features"]}
    assert result["retries"] in (0, 1, 2) and len(result["alternates"]) >= 1

    assert client.post("/turnaround/generate", json={"character_id": "nope", "target_view": "side"}).status_code == 404
    assert client.post("/turnaround/generate", json={**body, "target_view": "top"}).status_code == 422
