"""Design autocomplete endpoints: detect gaps, plan a fill, generate and rank fills."""

import uuid

from fastapi import APIRouter

from ..ideas import autocomplete as A
from ..images import decode_image, decode_mask, encode_image, encode_mask, to_rgb
from ..jobs import jobs
from ..providers.llm import vision_json
from ..schemas import (
    DetectOut,
    FillCandidate,
    FillIn,
    FillResult,
    FillScores,
    ImageIn,
    JobRef,
    MaskedImageIn,
    PlanOut,
    Region,
    Suggestion,
)

router = APIRouter(prefix="/autocomplete")

MIN_CONFIDENCE = 0.5

_MOCK_PLAN = PlanOut(
    analysis="(Mock answer) The layout repeats a card, and the outlined region is where the next card would go.",
    suggestions=[
        Suggestion(label="Matching card", prompt="A card in the same style as its neighbours, same size, colors and spacing."),
        Suggestion(label="Highlighted card", prompt="A card like its neighbours but with an accent-colored border and a badge."),
    ],
)


@router.post("/detect")
def detect(body: ImageIn) -> DetectOut:
    img = to_rgb(decode_image(body.image))
    gaps = [g for g in A.detect(img) if g.confidence >= MIN_CONFIDENCE]
    regions = [
        Region(
            id=f"r{i}",
            bbox=g.bbox,
            mask=encode_mask(A.gap_mask(g, img.size)),
            reason=g.reason,
            confidence=g.confidence,
            siblings=list(g.siblings),
        )
        for i, g in enumerate(gaps)
    ]
    return DetectOut(width=img.width, height=img.height, regions=regions)


@router.post("/plan")
def plan(body: MaskedImageIn) -> PlanOut:
    img = to_rgb(decode_image(body.image))
    mask = decode_mask(body.mask, img.size)
    return vision_json([img, A.highlight(img, mask)], A.PLAN_PROMPT, PlanOut, mock=_MOCK_PLAN)


def _fill(body: FillIn) -> dict:
    img = to_rgb(decode_image(body.image))
    mask = decode_mask(body.mask, img.size)
    fills = A.fill(img, mask, body.prompt, n=body.n, references=body.references or None, fresh=body.fresh)
    candidates = [
        FillCandidate(
            id=uuid.uuid4().hex[:8],
            image=encode_image(f.image),
            raw=encode_image(f.raw),
            scores=FillScores(**f.scores, total=f.total),
        )
        for f in fills
    ]
    return FillResult(candidates=candidates).model_dump()


@router.post("/fill")
def fill(body: FillIn) -> JobRef:
    return JobRef(job_id=jobs.submit(_fill, body))
