"""Character-view endpoints: analyze a drawing, then generate another view of it."""

import threading
from collections import OrderedDict

from fastapi import APIRouter, HTTPException

from ..ideas import turnaround as T
from ..images import decode_image, encode_image
from ..jobs import jobs
from ..schemas import Alternate, AnalyzeOut, GenerateIn, ImageIn, JobRef, ViewResult, ViewScores

router = APIRouter(prefix="/turnaround")

MAX_CHARACTERS = 16
_characters: OrderedDict[str, T.Character] = OrderedDict()
_lock = threading.Lock()


@router.post("/analyze")
def analyze(body: ImageIn) -> AnalyzeOut:
    character = T.analyze(decode_image(body.image))
    with _lock:
        _characters[character.id] = character
        while len(_characters) > MAX_CHARACTERS:
            _characters.popitem(last=False)
    return AnalyzeOut(
        character_id=character.id,
        cutout=encode_image(character.cutout),
        source_view=character.source_view,
        spec=character.spec,
    )


def _generate(character: T.Character, body: GenerateIn) -> dict:
    result = T.generate_view(character, body.target_view, body.features, fresh=body.fresh)
    best = result.best
    return ViewResult(
        image=encode_image(best.item),
        scores=ViewScores(**best.scores, total=best.total),
        checklist=best.notes,
        retries=result.retries,
        alternates=[Alternate(image=encode_image(c.item), total=c.total) for c in result.candidates[1:4]],
    ).model_dump()


@router.post("/generate")
def generate(body: GenerateIn) -> JobRef:
    with _lock:
        character = _characters.get(body.character_id)
    if character is None:
        raise HTTPException(404, "unknown character id; upload the drawing again")
    return JobRef(job_id=jobs.submit(_generate, character, body))
