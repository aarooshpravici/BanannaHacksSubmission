"""FastAPI app. Run from backend/ with:  .venv/bin/uvicorn app.main:app --reload

Run a single worker: jobs and loaded models live in this process's memory.
"""

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .images import ImageError
from .providers.generation import GenerationError
from .providers.llm import LLMError
from .routers import common, relight

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="Banana Hacks backend")

# No auth and no cookies, so any origin may call the API (local dev, Vercel previews).
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(ImageError)
async def bad_image(_: Request, exc: ImageError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(GenerationError)
@app.exception_handler(LLMError)
async def provider_failed(_: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(exc)})


app.include_router(common.router)
app.include_router(relight.router)
