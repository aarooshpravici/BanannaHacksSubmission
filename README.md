# BanannaHacksSubmission
For the bannana hacks hackathon

This branch holds a shared foundation for three candidate ideas (Relight, Design Autocomplete, Character Views) so the team can pick one and keep building. See `OVERNIGHT_REPORT.md` for what works, what is untested, and the proof images.

## Layout

```
backend/    FastAPI app (Python 3.12)
  app/ideas/        one module per idea: relight.py, autocomplete.py, turnaround.py
  app/critic/       shared scoring: image similarity, palette match, rank-and-retry loop
  app/providers/    hosted calls: fal.ai / Replicate image generation, vision LLM
  app/schemas.py    every request and response shape (the API contract)
  scripts/          proof and live-check scripts
  tests/            pytest suite
frontend/   Next.js app with one page per idea
proofs/     output images from the proof scripts
```

## Backend

```bash
cd backend
conda create -y -p .venv python=3.12
.venv/bin/python -m pip install -r requirements.txt
cp ../.env.example ../.env        # then fill in keys; never commit .env
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Interactive API docs are at http://localhost:8000/docs. The first request to each model downloads its weights (about 6 GB in total).

`MOCK_MODE=1` in `.env` (the default) makes every hosted call return a local stand-in, so the whole app runs with no keys. Set `MOCK_MODE=0` to use the real services.

```bash
.venv/bin/python -m pytest                 # fast tests
.venv/bin/python -m pytest --models        # also the tests that load local models
.venv/bin/python -m scripts.proof_relight        # writes proofs/relight/
.venv/bin/python -m scripts.proof_autocomplete   # scores gap detection, writes proofs/autocomplete/
.venv/bin/python -m scripts.live_checks          # one real call per hosted service; needs keys
```

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000. With `NEXT_PUBLIC_MOCK=1` the pages run on canned data with no backend; set it to `0` and `NEXT_PUBLIC_API_URL=http://localhost:8000` to use the backend.
