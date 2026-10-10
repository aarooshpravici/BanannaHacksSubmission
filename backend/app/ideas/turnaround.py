"""Character views: one drawing of a character in, another view of the same
character out, checked against a feature list.

analyst (vision LLM writes the character spec)
  -> generator (instruction-based image edit, conditioned on the drawing)
  -> critic (identity embedding + palette + per-feature checklist)
  -> retry with the failed features spelled out, if the best result is not good enough.
"""

import uuid
from dataclasses import dataclass, field

from PIL import Image
from pydantic import BaseModel

from ..critic import embeddings
from ..critic.palette import Swatch, extract_palette, palette_score
from ..critic.scoring import LoopResult, generate_and_rank
from ..cutout import crop_to_subject, on_background, remove_background
from ..providers import generation
from ..providers.llm import vision_json
from ..schemas import CharacterSpec, ChecklistItem, Feature, View

VIEW_PHRASES: dict[str, str] = {
    "front": "a front view, facing the viewer directly",
    "three_quarter": "a three-quarter view, the body turned about 45 degrees to the side",
    "side": "a side profile view, the body turned a full 90 degrees so only one side is visible",
    "back": "a back view, facing directly away from the viewer so the face is not visible",
}

SCORE_WEIGHTS = {"identity": 0.4, "palette": 0.2, "checklist": 0.4}
# Starting point only: it has not been calibrated against real generations.
PASS_THRESHOLD = 0.75


# --- analyst --------------------------------------------------------------------


class _FeatureAnswer(BaseModel):
    name: str
    visible_from: list[View]
    critical: bool


class _SpecAnswer(BaseModel):
    source_view: View
    summary: str
    art_style: str
    features: list[_FeatureAnswer]


ANALYZE_PROMPT = """This is a drawing of a single character on a plain background.

Describe the character so that another artist could redraw it from a different angle and keep it recognisably the same.

- source_view: which view this drawing shows (front, three_quarter, side or back).
- summary: one sentence naming the character's body type, age impression, hair and outfit.
- art_style: one short phrase for the rendering style (line weight, shading, palette, genre).
- features: the 5 to 8 most identifying features, most distinctive first. For each: a short specific name ("red scarf with frayed ends", not "scarf"); visible_from: every view from which it would be visible on a real figure (a face-only detail is not visible from the back; a backpack is visible from the side and back); critical: true if the character would no longer read as the same character without it."""

_MOCK_SPEC = _SpecAnswer(
    source_view="front",
    summary="(Mock answer) A character in a simple outfit.",
    art_style="flat cartoon",
    features=[
        _FeatureAnswer(name="hair", visible_from=["front", "three_quarter", "side", "back"], critical=True),
        _FeatureAnswer(name="outfit colors", visible_from=["front", "three_quarter", "side", "back"], critical=True),
        _FeatureAnswer(name="face", visible_from=["front", "three_quarter", "side"], critical=False),
    ],
)


@dataclass
class Character:
    id: str
    cutout: Image.Image  # RGBA, cropped to the character
    reference: Image.Image  # the cutout on white, padded square: what the generator sees
    source_view: str
    spec: CharacterSpec
    palette: list[Swatch] = field(default_factory=list)


def analyze(img: Image.Image) -> Character:
    cutout = crop_to_subject(remove_background(img))
    reference = on_background(cutout, square=True)
    answer = vision_json([reference], ANALYZE_PROMPT, _SpecAnswer, mock=_MOCK_SPEC)
    palette = extract_palette(cutout)
    spec = CharacterSpec(
        summary=answer.summary,
        art_style=answer.art_style,
        features=[Feature(id=f"f{i}", **f.model_dump()) for i, f in enumerate(answer.features)],
        palette=[s.hex for s in palette],
    )
    return Character(uuid.uuid4().hex[:12], cutout, reference, answer.source_view, spec, palette)


# --- generator ------------------------------------------------------------------


def view_prompt(spec: CharacterSpec, features: list[Feature], target_view: str, missing: list[str] = ()) -> str:
    visible = [f.name for f in features if target_view in f.visible_from]
    prompt = (
        f"Redraw this exact character as {VIEW_PHRASES[target_view]}. Keep the same character: same proportions, "
        f"same colors, same outfit and the same art style ({spec.art_style}). Full body, standing in a neutral pose, "
        f"centered on a plain white background, no text."
    )
    if visible:
        prompt += " Clearly visible from this angle: " + "; ".join(visible) + "."
    if missing:
        prompt += " The previous attempt got these wrong, so make sure they are correct this time: " + "; ".join(missing) + "."
    return prompt


# --- critic ---------------------------------------------------------------------


class _FeatureCheck(BaseModel):
    feature_id: str
    present: bool


class _ChecklistAnswer(BaseModel):
    checks: list[_FeatureCheck]


def _check_prompt(features: list[Feature]) -> str:
    listing = "\n".join(f"- {f.id}: {f.name}" for f in features)
    return (
        "Image 1 is the original character. Image 2 is a new drawing that should show the same character from "
        "another angle.\n\nFor each feature below, report whether it is actually visible in image 2 (present: true) "
        "or not (present: false). Judge only what can be seen in image 2; do not assume.\n\n" + listing
    )


def check(candidate: Image.Image, character: Character, features: list[Feature], target_view: str):
    """Score one candidate. Returns (scores, checklist) for generate_and_rank."""
    expected = {f.id: target_view in f.visible_from for f in features}
    mock = _ChecklistAnswer(checks=[_FeatureCheck(feature_id=f.id, present=expected[f.id]) for f in features])
    answer = vision_json([character.reference, candidate], _check_prompt(features), _ChecklistAnswer, mock=mock)
    seen = {c.feature_id: c.present for c in answer.checks}
    checklist = [
        ChecklistItem(feature_id=f.id, expected_visible=expected[f.id], present=seen.get(f.id, False)) for f in features
    ]
    # A critical feature counts double. A feature that should be hidden but is
    # shown (a face on a back view) is as wrong as one that should be there and is not.
    weight = {f.id: 2.0 if f.critical else 1.0 for f in features}
    right = sum(weight[c.feature_id] for c in checklist if c.present == c.expected_visible)
    scores = {
        "identity": embeddings.image_similarity(character.reference, candidate),
        "palette": palette_score(character.palette, extract_palette(remove_background(candidate))),
        "checklist": right / sum(weight.values()) if features else 1.0,
    }
    return scores, checklist


def generate_view(
    character: Character, target_view: str, features: list[Feature] | None = None, *, n: int = 3, max_retries: int = 2
) -> LoopResult[Image.Image]:
    features = features if features is not None else character.spec.features
    by_id = {f.id: f.name for f in features}

    def generate(attempt, best):
        wrong = [by_id[c.feature_id] for c in best.notes if c.present != c.expected_visible] if best else []
        prompt = view_prompt(character.spec, features, target_view, wrong)
        return generation.edit_image(character.reference, prompt, n=n, seed=attempt)

    return generate_and_rank(
        generate,
        lambda img: check(img, character, features, target_view),
        SCORE_WEIGHTS,
        threshold=PASS_THRESHOLD,
        max_retries=max_retries,
    )
