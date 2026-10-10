"""Endpoints every idea needs: health, job polling, cutout, scoring."""

from fastapi import APIRouter, HTTPException

from ..config import get_settings
from ..critic import embeddings
from ..critic.palette import extract_palette, palette_score
from ..critic.scoring import weighted_total
from ..cutout import remove_background
from ..images import decode_image, encode_image
from ..jobs import jobs
from ..schemas import CutoutOut, Health, ImageIn, JobStatus, ScoreIn, ScoreOut

router = APIRouter()


@router.get("/health")
def health() -> Health:
    settings = get_settings()
    return Health(mock_mode=settings.mock_mode, providers=settings.configured())


@router.get("/jobs/{job_id}")
def job_status(job_id: str) -> JobStatus:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "unknown job id (jobs are lost when the server restarts)")
    return JobStatus(status=job.status, result=job.result, error=job.error)


@router.post("/cutout")
def cutout(body: ImageIn) -> CutoutOut:
    cut = remove_background(decode_image(body.image))
    return CutoutOut(cutout=encode_image(cut), palette=[s.hex for s in extract_palette(cut)])


@router.post("/score")
def score(body: ScoreIn) -> ScoreOut:
    """How closely a candidate matches a reference image, per axis and overall."""
    reference, candidate = decode_image(body.reference), decode_image(body.candidate)
    scores = {
        "identity": embeddings.image_similarity(reference, candidate),
        "palette": palette_score(extract_palette(reference), extract_palette(candidate)),
    }
    if body.prompt:
        scores["intent"] = embeddings.text_image_similarity(body.prompt, candidate)
    return ScoreOut(scores=scores, total=weighted_total(scores, body.weights))
