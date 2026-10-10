"""Endpoints that are not about one photo: health and job polling."""

from fastapi import APIRouter, HTTPException

from ..config import get_settings
from ..jobs import jobs
from ..schemas import Health, JobStatus

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
