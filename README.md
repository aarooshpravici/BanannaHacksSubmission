# Relight

Drag a light around a photo and watch the highlights and shadows follow, live, in your browser. Two pretrained vision models measure the photo's shape once; from then on every frame is drawn by our own lighting maths in a WebGL shader, with no model and no server in the loop.

![The light travelling once around the Portrait sample, with the shading and the cast shadows following it](docs/relight-sweep.gif)

*The Portrait sample with the light on the path the app's Sweep button takes (the small orange dot is the light). These frames were rendered by our Python reference of the shading; the browser runs the same maths in a shader.*

**Live demo: https://aarooshpravici.github.io/BanannaHacksSubmission/** (the four sample photos or your own, in your browser, nothing to install)

Built for the Banana Hacks hackathon. The app has a "How it works" button in the top bar that shows each step below as a picture.

The sun on the photo is the light. Drag it to move the light. Scroll on it (or pinch with two fingers on a touch screen, or press + and - with it selected) to bring the light nearer or push it back: the sun grows as the light comes nearer, and the Height slider follows.

## How it works

```mermaid
flowchart LR
  photo([Your photo])

  subgraph pre["Pretrained models, once per photo"]
    depth["Depth Anything V2 Small<br/>depth map"]
    normals["Marigold<br/>surface normals"]
  end

  subgraph ours["Our code, every frame, in a WebGL2 shader"]
    diffuse["Diffuse shading<br/>with a falloff that keeps exposure steady"]
    shadows["Ray-marched cast shadows<br/>near, mid and far layers, each with its own blur"]
    mix["Multiply into the photo<br/>in linear light"]
  end

  subgraph hosted["Hosted model, optional"]
    enhance["Enhance<br/>Gemini image model or IC-Light v2"]
  end

  light([The light you drag])
  screen([Live preview])

  photo --> depth
  photo --> normals
  normals --> diffuse
  depth --> diffuse
  depth --> shadows
  light --> diffuse
  light --> shadows
  diffuse --> mix
  shadows --> mix
  photo --> mix
  mix --> screen
  screen -. "only if you press Enhance" .-> enhance
```

1. **Depth, once per photo (pretrained: Depth Anything V2 Small).** How near each pixel is to the camera. We scale it into a height field.
2. **Surface normals, once per photo (pretrained: Marigold).** Which way each surface faces. Normals worked out from the depth map alone left faces almost unshaded, so a second model does this.
3. **Diffuse shading, every frame (ours).** Each pixel is lit by how squarely its surface faces the light, easing to dark as it turns away. Distance falloff is measured against the centre of the scene, so moving the light changes where it falls and not the overall exposure.
4. **Cast shadows, every frame (ours).** Each pixel walks toward the light across the height field. Whatever blocks it is sorted into a near, mid or far layer by how far in front of the receiving surface it stands, and each layer is blurred by a different amount: a contact shadow stays crisp, a shadow on a far background spreads and fades.
5. **Into the photo, every frame (ours).** The shading is multiplied into the photo in linear light. From 80% of white upward the result eases toward white, so highlights roll off softly instead of clipping.
6. **Enhance, only on request (hosted: the Gemini image model, or IC-Light v2 on fal.ai).** Sends the shaded preview for a more photographic finish. The app is complete without it.

Steps 3 to 5 exist three times and are kept in agreement: `backend/app/ideas/relight.py` (the Python reference), `frontend/lib/relightMath.ts` (a CPU port) and `frontend/lib/relightGL.ts` (the shader you watch).

If a device cannot run the shader, the page falls back by itself: first to the same shader with 8-bit shadow buffers, then to the CPU port in a background thread (a quick preview while the light moves, the full picture when it stops). With the backend running, a processor that needs more than 1.2 seconds a picture hands the drawing to the backend. The last line of the GEOMETRY panel says which path is in use. Only the full-quality shader has run on real hardware; the fallbacks were tried by switching features off in the same browser.

## What is ours and what is not

| | |
| --- | --- |
| **Ours** | All of the lighting: the diffuse shading, the exposure-steady falloff, the soft edge where a surface turns from the light, the ray-marched shadows and their three layers, the linear-light mix, written three times (Python, TypeScript, GLSL). The server that runs the two models once and hands the browser the maps, and the port of its depth-to-maps step to the browser (`sceneGeometry.ts`). The self-test that compares a graphics chip's answer from the depth model with the processor's before a photo is trusted to it (`depthCheck.ts`). The page. |
| **Not ours** | The depth model (Depth Anything V2 Small) and the normals model (Marigold): pretrained, downloaded, run as they are. We trained nothing. The optional Enhance model is a hosted service we call. The decoder for iPhone HEIC photos (libheif-js, LGPL-3.0), which the browser fetches from jsDelivr only when such a photo arrives. |

Without the two pretrained models there is nothing to shade; without our code there is nothing to drag. Dragging the light never calls a model.

## Honest limits

- One photo gives a height field, not real 3D, so shadows are approximate. Light from below looks blotchy on faces, and a faint dark column remains on open sky.
- Shading is diffuse only: no shine. Light already in the photo is not removed.
- The live shader has been tested by people on three devices so far: an Apple-chip Mac (Chrome and Safari), a Windows laptop with Intel graphics (Chrome) and one phone.
- Real Enhance has run once, and it weakened the side lighting. In the default setup (`MOCK_MODE=1`) Enhance returns the preview unchanged.
- With no backend (the static demo, mock mode, or the backend not answering), your own photo is analysed in the browser: the same depth model (an ONNX build, `onnx-community/depth-anything-v2-small`, Apache-2.0, run by transformers.js on WebGPU or WebAssembly; about 25 MB downloaded once from Hugging Face and jsDelivr, the photo itself is not uploaded). The normals model is too large for a browser, so those scenes take their normals from the slope of the depth map and faces shade flatter. Tested by the developer in Chrome on one Apple-chip Mac only. On one tester's Snapdragon laptop (a Qualcomm Adreno graphics chip, on Windows) the model ran on WebGPU without an error and gave a depth map covered in a regular grid of dimples. So before the first photo the page now runs the model on a built-in test picture and compares the result with the processor's answer to that picture, which is stored in the code; it uses the processor (WebAssembly, slower) when the graphics chip gets the picture wrong, when it throws, or when it is that chip family on Windows. The test's limit was set from one healthy chip, an Apple one, so a healthy chip of another make may be turned away to the slower route, and the fix has not yet been confirmed on the faulty laptop.
- iPhone photos (`.heic`, `.heif`, as AirDrop delivers them) are accepted everywhere a photo is. Safari decodes them itself. Chrome, Edge and Firefox cannot, so there the page fetches a decoder when the first such photo arrives: [`libheif-js`](https://www.npmjs.com/package/libheif-js) 1.23.5, which is libheif with the libde265 HEVC decoder built to WebAssembly, licensed LGPL-3.0. It is not part of this repository or of the site: the browser downloads that one pinned file (2 MB, checked against a fingerprint) from jsDelivr, so a HEIC photo needs the internet the first time. The photo itself is converted on the device and is not uploaded for that. Tested in Chrome on one Apple-chip Mac with files made by macOS, not yet with a photo straight from an iPhone, and not in Safari or Firefox.
- Scrolling and pinching on the sun have only been driven by a program, in Chrome on one Mac. No real mouse wheel, trackpad or finger has tried them yet. In Safari on a Mac the trackpad pinch on the sun does nothing; two-finger scrolling on it works.

`testing/PENDING.md` is the full list of what has not been verified.

## Run it

Three ways, shortest first:

- **No backend:** `cd frontend && npm install && npm run dev`, then open http://localhost:3000 and click a sample or upload your own photo (its depth is estimated in the browser). See "Frontend".
- **Everything, including detailed normals and Enhance:** start the backend ("Backend"), then the frontend with `NEXT_PUBLIC_MOCK=0`.
- **A static folder for a web host:** see "Static demo".

The earlier three-idea version of the project is on the `overnight-foundation` branch; `docs/overnight-report.md` describes it.

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
  out/                        the static demo, written by `npm run build:demo` (see "Static demo")
  public/samples/             the four sample scenes: photo, depth, normals, thumbnail (written by make_samples.py)
  public/how-it-works/        the stills in the "How it works" panel (written by docs/make_explainer_images.py)
  lib/                        relightGL.ts (the shader), relightMath.ts (the CPU port), and the CPU fallback that runs it:
                              relightCPU.ts, relightCpuCore.ts, relightCpu.worker.js
                              localScene.ts, depth.worker.js, sceneGeometry.ts (a photo's depth and normals worked out in
                              the browser when there is no backend)
                              depthCheck.ts, depthCheckReference.ts (the test picture a graphics chip has to get right
                              before the depth model is trusted on it, and the processor's answer to that picture)
                              heic.ts, heic.worker.js (iPhone HEIC photos decoded in the browsers that cannot read them;
                              the decoder itself is fetched at run time, see "Honest limits")
docs/       relight-sweep.gif and the script that renders it; submission/ holds the write-up drafts
proofs/     output images from the scripts
testing/    what to test and how, written for the testers
tools/      check_secrets.py (keeps keys out of the repository), screenshots.mjs (retakes the tester kit's screenshots)
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

Open http://localhost:3000. With `NEXT_PUBLIC_MOCK=1` the page runs with no backend at all: an uploaded photo's depth is estimated in the browser (see "Honest limits"), and the samples keep the shape they were baked with. The dot in the top-right corner says which mode you are in.

## Static demo

```bash
cd frontend
NEXT_PUBLIC_BASE_PATH=/BanannaHacksSubmission npm run build:demo   # leave the variable out for a site at the root of its address
```

This writes a plain static site to `frontend/out/`, for a host with no server of ours (GitHub Pages, say), so a judge can open the app from a link. The four samples and your own photos work in it, analysed and shaded in the browser; Enhance is switched off and the page says why. Upload everything inside `out/`, including the hidden `.nojekyll`. A build only works at the path it was built for; `frontend/README.md` has the details.

## Sample scenes

The four samples on the first page (Portrait, Coffee cup, Cat, Rocket) are static files under `frontend/public/samples/<name>/`, so they open with no backend running. Enhance on a sample still needs the backend. To bake them again from `testing/photos` after changing the depth or normals code:

```bash
cd backend
MOCK_MODE=1 .venv/bin/python -m scripts.make_samples
```

It uses only the local models and writes about 1 MB in total. Commit the changed files. `frontend/README.md` says how to add a fifth sample.

The animation at the top of this page and the stills in the app's "How it works" panel are rendered from the Portrait sample by the Python reference. After changing the shading maths or that sample, render them again:

```bash
cd backend
MOCK_MODE=1 PYTHONPATH=. .venv/bin/python ../docs/make_explainer_images.py
```

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

`testing/` is a kit for three human testers: setup steps, a test plan with screenshots of what should appear, and `PENDING.md`, the list of what the developer could not verify.

Testers: do not use the commands above. Start at `testing/README.md` and follow `testing/SETUP.md`; they say exactly what to install, what to click and what should appear.
