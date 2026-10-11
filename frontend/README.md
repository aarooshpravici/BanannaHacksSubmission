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

This writes a plain static site to `out/` (about 3.3 MB). Upload the contents of that folder to any
static host. In it the four sample photos and your own photos work fully in the browser: drag, sliders,
presets, Sweep, hold to compare, Export PNG and the Geometry maps. Nothing calls a backend: the status
pill reads `demo: runs in your browser`, an uploaded photo is analysed in the browser (next section),
and Enhance is switched off because it needs the Relight server.

- `NEXT_PUBLIC_BASE_PATH` is the folder the site is served from. For
  `https://example.github.io/BanannaHacksSubmission/` it is `/BanannaHacksSubmission`. Leave it unset
  when the site sits at the root of its address. A build only works at the path it was built for.
- The build adds an empty `out/.nojekyll`, which GitHub Pages needs before it will serve the `_next` folder.
- The build also deletes a 27 MB `ort-wasm-*.wasm` that the bundler copies into `out/_next/static/media/`.
  The page never asks for that copy: the code that runs the depth model is fetched from jsDelivr (next section).
- To look at it locally, serve it from a folder that matches the base path:

  ```bash
  mkdir -p /tmp/site && cp -R out /tmp/site/BanannaHacksSubmission
  python3 -m http.server 3142 --directory /tmp/site      # http://localhost:3142/BanannaHacksSubmission/
  ```

`npm run build:demo` sets `NEXT_PUBLIC_DEMO=1`. Without it, `npm run dev` and `npm run build` behave as described above.

## Your own photo without a server

When there is no backend to ask (the static demo, mock mode) an uploaded photo is analysed in the browser.
In the normal app the backend comes first; if it cannot be reached, the failure card offers
"Analyse in this browser".

- **Model:** Depth Anything V2 Small, the depth model the backend runs, as the ONNX build
  [`onnx-community/depth-anything-v2-small`](https://huggingface.co/onnx-community/depth-anything-v2-small)
  (Apache-2.0), pinned to one revision in `lib/depth.worker.js`. It is run by
  [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) 4.3.1 (Apache-2.0),
  the only dependency this adds.
- **Where it runs:** in a Web Worker, on the graphics chip through WebGPU when the browser has it
  (about 0.1 s a photo on an Apple-chip laptop), otherwise on the processor through WebAssembly (about 2 s).
  The Geometry panel says which.
- **What is downloaded, once:** the model file `onnx/model_q4f16.onnx` (19 MB) from `huggingface.co` and its
  download host, and the code that runs it (5.5 MB) from `cdn.jsdelivr.net`: 24.7 MB in all. The browser keeps
  both (Cache Storage, under `transformers-cache`), so later photos and later visits download nothing.
  The photo itself is never sent anywhere.
- **What is different from a backend scene:** the depth map goes through the same steps (`lib/sceneGeometry.ts`
  is a port of `estimate_height` and `build_geometry` in `backend/app/ideas/relight.py`; if the Python changes,
  change it too). The backend's detailed normals come from a second model, Marigold, which is too large for a
  browser, so these scenes take their normals from the slope of the depth map: surfaces shade flatter and
  outlines get a darker rim. The page says so in the Geometry panel, and "Detailed normals" is off for them.
- **The library is loaded only when a photo is analysed.** It is a separate 576 KB file that the first page
  does not fetch.

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
- `lib/localScene.ts` works out a photo's scene in the browser; `lib/depth.worker.js` runs the depth model and
  `lib/sceneGeometry.ts` turns its output into the depth and normal maps.
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
