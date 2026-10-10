# Relight

Upload a photo, or click one of four built-in samples, and drag a light around it: the highlights and shadows follow live in your browser. The backend works out the photo's depth and surface direction once, and an optional "Enhance" step sends the shaded preview to a hosted image model for a photoreal finish.

Built for the Banana Hacks hackathon. The earlier three-idea version is on the `overnight-foundation` branch; `docs/overnight-report.md` describes it.

## Layout

```
backend/    FastAPI app (Python 3.12)
  app/ideas/relight.py        depth, surface normals, shading and cast shadows
  app/routers/                the HTTP endpoints: /health, /jobs, /relight/scene, /relight/render, /relight/enhance
  app/providers/generation.py the hosted Enhance call (Gemini or fal.ai), its disk cache and its spending cap
  app/schemas.py              every request and response shape (the API contract)
  scripts/                    proof_relight.py (proof sheets), make_samples.py (bakes the built-in sample scenes),
                              live_checks.py (one real Enhance call)
  tests/                      pytest suite
frontend/   Next.js app. One page, served at / and /relight
  public/samples/             the four sample scenes: photo, depth, normals, thumbnail (written by make_samples.py)
proofs/     output images from the scripts
testing/    what to test and how, written for the testers
tools/      check_secrets.py, which keeps keys out of the repository
```

## Backend

```bash
cd backend
conda create -y -p .venv python=3.12
.venv/bin/python -m pip install -r requirements.txt
cp ../.env.example ../.env        # never commit .env
.venv/bin/uvicorn app.main:app --port 8000
```

The first photo downloads the two local models (a few GB), so it is slow once.

`MOCK_MODE=1` in `.env` (the default) means Enhance never calls a paid service: it returns the preview unchanged. Depth, normals and shading are always real. Set `MOCK_MODE=0` and add a key to use the real Enhance.

## Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local   # set NEXT_PUBLIC_MOCK=0 to use the backend
npm run dev
```

Open http://localhost:3000. With `NEXT_PUBLIC_MOCK=1` the page runs with no backend at all: an uploaded photo gets a made-up dome shape instead of real depth, while the samples keep their real shape. The dot in the top-right corner says which mode you are in.

## Sample scenes

The four samples on the first page (Portrait, Coffee cup, Cat, Rocket) are static files under `frontend/public/samples/<name>/`, so they open with no backend running. Enhance on a sample still needs the backend. To bake them again from `testing/photos` after changing the depth or normals code:

```bash
cd backend
MOCK_MODE=1 .venv/bin/python -m scripts.make_samples
```

It uses only the local models and writes about 1 MB in total. Commit the changed files.

## Tests

```bash
cd backend
MOCK_MODE=1 .venv/bin/python -m pytest -q            # fast tests
MOCK_MODE=1 .venv/bin/python -m pytest -q --models   # also the tests that load the local models

cd ../frontend
npm run lint && npx tsc --noEmit && npm run build
```

The tests never call a paid service. `backend/scripts/live_checks.py` does (one image call), so run it only on purpose.

## Testing by hand

Testers: do not use the commands above. Start at `testing/README.md` and follow `testing/SETUP.md`; they say exactly what to install, what to click and what should appear.
