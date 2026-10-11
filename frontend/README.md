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

This writes a plain static site to `out/` (about 3 MB). Upload the contents of that folder to any
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
  The graphics chip is used only if it does 16-bit maths (`shader-f16`, which the model file needs) and
  passes a check first (next section). The Geometry panel says which route was taken, and why.
- **What is downloaded, once:** the model file `onnx/model_q4f16.onnx` (19 MB) from `huggingface.co` and its
  download host, and the code that runs it (5.5 MB) from `cdn.jsdelivr.net`: 24.7 MB in all. The browser keeps
  both (Cache Storage, under `transformers-cache`), so later photos and later visits download nothing.
  The photo itself is never sent anywhere.
- **What is different from a backend scene:** the depth map goes through the same steps (`lib/sceneGeometry.ts`
  is a port of `estimate_height` and `build_geometry` in `backend/app/ideas/relight.py`; if the Python changes,
  change it too). The backend's detailed normals come from a second model, Marigold, which is too large for a
  browser, so these scenes take their normals from the slope of the depth map: surfaces shade flatter.
  The page says so in the Geometry panel, and "Detailed normals" is off for them.
- **The depth-step rule.** Where the depth jumps from one object to what is behind it, the slope is nearly
  vertical and the normal taken from it points sideways. Lit from the side, every object then had a bright rim
  towards the light and a dark one away from it (GitHub issue 6). So `buildGeometry()` takes a slope that
  steep for a jump between objects, not a surface, and turns the normal there to face the viewer. The slope
  (rise over run, both in image widths) is multiplied by one minus a weight that is a smoothstep from 0 at
  `DEPTH_STEP_SLOPE_LOW` (1.5, a tilt of 56 degrees) to 1 at `DEPTH_STEP_SLOPE_HIGH` (4, 76 degrees), spread
  to every pixel within `DEPTH_STEP_GROW` (3 pixels at 512 width, by the `dilate()` helper) and blurred with
  a sigma of `DEPTH_STEP_FEATHER` (2 pixels at 512 width). It is a port of `_depth_steps()` in the Python,
  which a backend scene with "Detailed normals" off goes through too. The cost: a surface that really is
  that steep, such as the rounded edge of a cup, is shaded as if it faced the viewer. Measured by an
  independent check on Oct 11 (Python reference and headless Chrome 155, one Mac): a plane is shown as it is
  up to 58 degrees, less steep than it is beyond that, never steeper than 61, and flat from 76; on a ball as
  deep as it is wide the flattening starts at 83% of the radius and is complete at 97%; a jump of less than
  about 6% of the depth range is left alone, so a rim can stay there, and on photos under about 200 pixels
  wide part of the rim stays; thin things are flattened right across; and `buildGeometry()` alone takes
  about 130 ms at 1024 x 1024 in Node, where it took about 53. `testing/PENDING.md` (K72 to K75) says how
  that looks on a photo.
- **The library is loaded only when a photo is analysed.** It is a separate 576 KB file that the first page
  does not fetch.

## The check on the graphics chip

Some graphics drivers run the depth model without any error and get it wrong. On a tester's Snapdragon X
laptop (Adreno X1-85, Windows on ARM) the WebGPU route gave a depth map covered in a regular grid of bumps,
one per 14-pixel patch of the model, on both photos the tester tried (GitHub issue 4). So the WebGPU route is not trusted
until it has passed a check.

- **The check** (`lib/depthCheck.ts`). Each time the model is set up on WebGPU, before any photo,
  `lib/depth.worker.js` runs it on a 518 x 518 test picture built in code (a wall, a floor, a ball, a box and
  a post) and scores the answer against the one the WebAssembly route gives for the same picture, stored in
  `lib/depthCheckReference.ts`. Two scores: **agreement**, the correlation patch by patch
  (`CHECK_MIN_AGREEMENT`, 0.99 or more passes), and **roughness** of the flat areas as a multiple of the
  reference's own (`CHECK_MAX_ROUGHNESS`, 6 or less passes). The processor scores 1.00 by definition. The one
  healthy chip measured, an Apple one in Chrome 155, scores 0.9999 and 3.27 on every run. Grid noise added by
  a program is rejected from about 0.1% to 0.3% of the depth range, which is about where it first shows on a
  blank wall under a low side light; at 3% it scored about 95 to 135. The check is one more run of the model:
  150 to 250 ms on that Mac (up to about 0.75 s the very first time in a new browser profile), once per page
  load, on WebGPU only. The chip gets `CHECK_TIMEOUT_MS` (20 s) to
  answer.
- **What happens on a failure.** After a failed check the Worker releases the WebGPU model and uses
  WebAssembly for this photo and the later ones. After a throw on WebGPU (setting the model up, in the check
  or on a photo), a photo's output on WebGPU that is not finite or is one single value, or no answer to the
  check within 20 s, that Worker is of no more use (transformers.js runs one model at a time, each behind
  the last, so a run that failed or never finished blocks the processor's too). The Worker's error reply
  carries what it found out about the chip, and `localScene()` starts a new Worker on WebAssembly for the
  same photo: about 4 s after an error and about 24 s after the time limit on the developer's Mac. A failure
  while the files are still downloading is not blamed on the chip.
- **The list** (`knownBad()` in `lib/depth.worker.js`). A chip whose adapter vendor matches `qualcomm`, in a
  browser whose user agent says `Windows`, is not tried at all in normal use: that is the one family a tester
  has seen go wrong. Qualcomm chips on Android have not reported and are left to the check. The list is
  applied only on the normal route and only to an adapter that has `shader-f16`.
- **What the Geometry panel says** after "depth: this browser," (`depthDeviceText()` in `lib/localScene.ts`):

  | Words | When |
  | --- | --- |
  | `graphics chip (WebGPU)` | the chip passed the check |
  | `processor (WebAssembly)` | no WebGPU adapter, or one without `shader-f16` |
  | `processor (the graphics chip failed a check)` | the chip got the test picture wrong |
  | `processor (the graphics chip failed)` | the chip threw, gave an unusable output, or did not answer |
  | `processor (this graphics chip is known to get the depth model wrong)` | the chip is on the list |
  | `processor (WebAssembly, asked for with ?depth=wasm)` | the address has `?depth=wasm` |
  | `graphics chip (WebGPU, not checked: ?depth=webgpu)` | the address has `?depth=webgpu` |

- **Options on the address, for testers** (`depthChoice()` in `lib/localScene.ts`):

  | Option | Route |
  | --- | --- |
  | `?depth=wasm` | the processor, whatever the graphics chip can do |
  | `?depth=webgpu` | the graphics chip with no check, ignoring the list, so that a faulty chip can be shown failing |
  | `?depth=check` | the graphics chip with the check, ignoring the list: how to find out whether the check catches a listed chip |
  | `?depth=auto`, nothing, or anything else | the normal route |

- **Console lines**, written by the Worker. For a chip that passes, one `console.info`:
  `Relight: the graphics chip (<vendor> <architecture>) passed the depth model's check: agreement 0.9999 (0.99 or more passes), roughness 3.27 times the processor's (6 or less passes), 175 ms.`
  For a failed check, the `console.warn` that every failed route gets,
  `Relight: the depth model failed on webgpu (start).`, with the error
  `DepthCheckFailed: the graphics chip (…) got the depth model's test picture wrong: …` and the same numbers.
  For a listed chip, one `console.warn` that starts
  `Relight: the graphics chip (…) is on the list of chips known to get the depth model wrong.`
- **What it does not catch, and what has not been run.** The limit of 6 rests on one healthy chip. A healthy
  chip of another make that scores higher is sent to the processor: the right picture, but on the Mac about
  4 to 5 s for the first photo and about 2 s for later ones, against about 0.9 s and 0.2 s. Only the test
  picture is checked, so a chip that gets it right and spoils real photos gets through. Broad noise that is
  not on the 14-pixel grid passes. One tester has run the four routes on the real Qualcomm chip (a
  Snapdragon X laptop, Chromium 152, GitHub issue 4): the list kept the page off the chip, and with
  `?depth=check` the check turned the chip away with agreement 0.6130 and roughness 185.52, in 993 ms.
  Edge and Chrome have not been tried there. Nobody has run any of this on a phone, or on any other
  graphics chip but one Apple one. `testing/PENDING.md` has the detail (K66 to K71, open items 52 to 54).
- **If the model file, its revision or the test picture changes**, the reference has to be measured again;
  the first lines of `lib/depthCheckReference.ts` say how.

## iPhone photos (HEIC and HEIF)

An iPhone saves photos as `.heic`, and AirDrop to a Mac delivers them unchanged. The file chooser, a drop and
a paste all accept them (`lib/heic.ts` tells one by its type, its name or its first bytes).

- **Safari** decodes them itself, like any other image.
- **Chrome, Edge and Firefox** cannot. There the photo is decoded by
  [`libheif-js`](https://www.npmjs.com/package/libheif-js) 1.23.5 (libheif and the libde265 HEVC decoder as
  WebAssembly, **LGPL-3.0**) in a Web Worker (`lib/heic.worker.js`). The Worker ends after each photo, which
  is what gives the decoder's memory back.
- **The decoder is loaded at run time, not bundled.** It is one 2 MB file (620 KB as sent), fetched from
  `cdn.jsdelivr.net` when the first HEIC photo arrives and kept by the browser afterwards. The address names
  one exact version and carries its SHA-384 fingerprint, so the browser refuses anything else. It is not in
  `package.json`, in the build or in `out/`: the first page does not grow, nothing LGPL is shipped from this
  repository, and the published folder gains no third-party bundle. The cost is that a HEIC photo needs the
  internet the first time, also when the app runs on your own machine; the page says so if the download fails.
- The picture comes out upright (the file's own rotation is applied), shrunk to at most 1536 px in the Worker,
  and is handed on as a JPEG, so the backend and the browser's depth model receive what they always did.
- To move to another version: change `DECODER_URL` and `DECODER_SHA384` together in `lib/heic.worker.js`
  (`openssl dgst -sha384 -binary libheif-bundle.js | openssl base64 -A`).

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
  `lib/sceneGeometry.ts` turns its output into the depth and normal maps. `lib/depthCheck.ts` is the check a
  graphics chip has to pass before the model is trusted on it, against the answer in
  `lib/depthCheckReference.ts`.
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
npm run build
npx tsc --noEmit
```
