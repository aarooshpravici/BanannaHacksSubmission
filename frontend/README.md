# Relight frontend

Next.js (App Router) + React + TypeScript + Tailwind. One page: drag a light around a photo, shaded live in a WebGL2 shader. It is served at both `/` and `/relight`.

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

## Static demo (no server at all)

```bash
npm run build:demo                                             # served from the root of a site
NEXT_PUBLIC_BASE_PATH=/BanannaHacksSubmission npm run build:demo   # served from a sub-folder
```

This writes a plain static site to `out/` (about 2.3 MB). Upload the contents of that folder to any
static host. In it the four sample photos work fully in the browser: drag, sliders, presets, Sweep,
hold to compare, Export PNG and the Geometry maps. Nothing calls a backend: the status pill reads
`demo: runs in your browser`, the drop box is replaced by a note that uploading needs the Relight
server, and Enhance is switched off with the same reason.

- `NEXT_PUBLIC_BASE_PATH` is the folder the site is served from. For
  `https://example.github.io/BanannaHacksSubmission/` it is `/BanannaHacksSubmission`. Leave it unset
  when the site sits at the root of its address. A build only works at the path it was built for.
- The build adds an empty `out/.nojekyll`, which GitHub Pages needs before it will serve the `_next` folder.
- To look at it locally, serve it from a folder that matches the base path:

  ```bash
  mkdir -p /tmp/site && cp -R out /tmp/site/BanannaHacksSubmission
  python3 -m http.server 3142 --directory /tmp/site      # http://localhost:3142/BanannaHacksSubmission/
  ```

`npm run build:demo` sets `NEXT_PUBLIC_DEMO=1`. Without it, `npm run dev` and `npm run build` behave as described above.

## Built-in samples

The four samples on the first page are static files, so they work with no backend and in the static demo.
Each is a folder `public/samples/<name>/`:

| File | What it is |
| --- | --- |
| `photo.jpg` | the photo, at most 1024 px on its longer side |
| `depth.png` | the depth map, grey, white = near |
| `normals.png` | the surface normals, each axis -1..1 stored as 0..255 |
| `thumb.jpg` | a 320 px wide preview for the sample row |
| `scene.json` | `{"width", "height", "relief"}` |

They are written by `backend/scripts/make_samples.py`, which puts each photo through the same steps as
`POST /relight/scene` (same size limit, same two models, same encodings). It needs the backend's Python
environment and the two local models, and calls no paid service.

**To regenerate them** (after changing the depth or normals code):

```bash
cd ../backend
MOCK_MODE=1 .venv/bin/python -m scripts.make_samples
```

**To add or replace one:**

1. Put the photo in `testing/photos/`.
2. Add a line to `SAMPLES` in `backend/scripts/make_samples.py`: the folder name, then the photo's file name.
3. Run the command above. It prints each sample's size and fails if one is over 600 KB.
4. Add an entry with the same folder name to `SAMPLES` in `lib/samples.ts` (`name`, the `label` under the thumbnail, and `alt` text). The page shows the samples in that order,
   in a row laid out for four: a fifth wraps onto a second line (`grid-cols-4` in `app/relight/page.tsx`).
5. Commit the new folder. Then run `npm run build:demo` again if a static demo is published.

The pictures in the "How it works" panel (`public/how-it-works/`) and `docs/relight-sweep.gif` are rendered from
the `portrait` sample by `docs/make_explainer_images.py`. If that sample changes, run it again (the command is in
its first lines).

## Layout

- `lib/types.ts` mirrors `backend/app/schemas.py` field for field. Change them together.
- `lib/api.ts` has one typed function per endpoint; `lib/mock.ts` answers them in mock mode.
- `lib/useJob.ts` submits a background job and polls `/jobs/{id}`.
- `lib/image.ts` handles files, base64, canvases and downloads.
- `lib/relightGL.ts` is the live shader; `lib/relightMath.ts` is the same math on the CPU.
  Both are ports of `backend/app/ideas/relight.py`: if the Python changes, change both.
- `components/HowItWorks.tsx` is the "How it works" button in the top bar and the panel it opens. Its text describes
  the pipeline: if the pipeline changes, change the text.
- `components/` holds the shared UI (dropzone, before/after, panels, buttons and sliders); `components/relight/RelightCanvas.tsx` is the live preview.

## Checks

```bash
npm run lint
npx tsc --noEmit
npm run build
```
