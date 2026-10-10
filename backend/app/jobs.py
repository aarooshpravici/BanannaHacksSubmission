"""In-memory background jobs for slow work (the Enhance call).

An endpoint submits a function and returns the job id straight away; the
frontend polls until the status is "done" or "error". State lives in this
process only, so a restart loses jobs and the server must run a single worker.
"""

import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

log = logging.getLogger(__name__)

Status = Literal["pending", "done", "error"]


@dataclass
class Job:
    id: str
    status: Status = "pending"
    result: Any = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None


class JobStore:
    def __init__(self, max_workers: int = 4, max_jobs: int = 200):
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="job")
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._max_jobs = max_jobs

    def submit(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> str:
        job = Job(id=uuid.uuid4().hex[:12])
        with self._lock:
            self._evict()
            self._jobs[job.id] = job
        self._pool.submit(self._run, job, fn, args, kwargs)
        return job.id

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def _run(self, job: Job, fn: Callable[..., Any], args: tuple, kwargs: dict) -> None:
        try:
            result = fn(*args, **kwargs)
        except Exception as e:  # the job boundary: report any failure to the poller
            log.exception("job %s failed", job.id)
            with self._lock:
                job.status, job.error, job.finished_at = "error", f"{type(e).__name__}: {e}", time.time()
            return
        with self._lock:
            job.status, job.result, job.finished_at = "done", result, time.time()

    def _evict(self) -> None:
        # Drop the oldest finished jobs so base64 results don't pile up in memory.
        if len(self._jobs) < self._max_jobs:
            return
        finished = sorted((j for j in self._jobs.values() if j.status != "pending"), key=lambda j: j.created_at)
        for job in finished[: len(self._jobs) - self._max_jobs + 1]:
            del self._jobs[job.id]


jobs = JobStore()
