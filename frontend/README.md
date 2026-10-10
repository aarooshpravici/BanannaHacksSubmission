# Banana Hacks frontend

Next.js (App Router) + React + TypeScript + Tailwind. One shared core and one page per idea:

| Route | Idea |
| --- | --- |
| `/relight` | Move the light: drag a light around a photo, shaded live in a WebGL2 shader |
| `/autocomplete` | Design autocomplete: detect or draw a gap, plan, generate and rank fills |
| `/turnaround` | Character views: feature checklist, generate views, check and score them |

## Run

```bash
npm install
npm run dev          # http://localhost:3000, mock mode: no backend needed
```

To use the real FastAPI backend, copy `.env.local.example` to `.env.local` and set:

```bash
NEXT_PUBLIC_MOCK=0
NEXT_PUBLIC_API_URL=http://localhost:8000
```

then restart `npm run dev`. The dot in the top-right corner shows which mode you are in
(`mock`, `online`, `online, mock providers` when the backend itself has `MOCK_MODE=1`, or `offline`).

With neither variable set, `npm run dev` uses mock mode and a production build uses the real backend.
`NEXT_PUBLIC_*` values are baked in at build time, so set them before `npm run build`.

## Layout

- `lib/types.ts` mirrors `backend/app/schemas.py` field for field. Change them together.
- `lib/api.ts` has one typed function per endpoint; `lib/mock.ts` answers them in mock mode.
- `lib/useJob.ts` submits a background job and polls `/jobs/{id}`.
- `lib/image.ts` handles files, base64, canvases, masks and downloads.
- `lib/relightGL.ts` is the live shader; `lib/relightMath.ts` is the same math on the CPU.
  Both are ports of `backend/app/ideas/relight.py`: if the Python changes, change both.
- `components/` holds the shared UI (dropzone, score bars, candidate grid, before/after, panels).

## Checks

```bash
npm run lint
npm run build
```
