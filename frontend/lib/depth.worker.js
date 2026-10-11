// The depth model, run in the browser: Depth Anything V2 Small (the model the
// backend runs, backend/app/ideas/relight.py) through transformers.js, then
// lib/sceneGeometry.ts turns its output into the scene's depth and normal maps.
// In a Worker so the page stays smooth while the model downloads and runs.
//
// Plain JavaScript for the same reason as lib/relightCpu.worker.js: the bundler
// copies this file as it stands into the build folder.

import { buildGeometry, nearness, resizeCubic } from "./sceneGeometry";

/** An ONNX build of the backend's model, for transformers.js. Apache-2.0, like the original. */
const MODEL_ID = "onnx-community/depth-anything-v2-small";
/** The exact upload of it that was tested, so a later change on the hub cannot change or break the demo. */
const MODEL_REVISION = "4472b7362082ad9968fee890ca0f1e5aca36b93d";
/** Where transformers.js keeps what it downloads (its default name), to tell a first download from a later load. */
const CACHE_NAME = "transformers-cache";

/**
 * Which of the hub's builds of the model to download: 19 MB, 4-bit weights with
 * 16-bit maths. Measured against the backend's own maps for the sample photos:
 *   this one             19 MB  depth agrees to r = 0.98 to 0.996, normals within 2 to 4 degrees, smooth
 *   "q8" (8-bit)         27 MB  depth agrees better, but its noise shows as speckle on flat walls
 *   "fp16" (16-bit)      50 MB  the closest to the backend (r = 0.999, normals within 1.5 degrees)
 * The smallest that shades cleanly wins, because the download is the wait a
 * first-time visitor sees. For the closest match, set dtype "fp16" and file
 * "onnx/model_fp16.onnx": nothing else changes.
 */
const MODEL_FILE = { dtype: /** @type {const} */ ("q4f16"), file: "onnx/model_q4f16.onnx" };

/**
 * The two ways to run it, from the same file:
 *   webgpu  on the graphics chip: about 0.1 s a photo on a laptop.
 *   wasm    on the processor: about 2 s a photo on a laptop, and works everywhere.
 * @typedef {import("./sceneGeometry").DepthDevice} Route
 */

/** @param {import("./sceneGeometry").DepthReply} reply @param {Transferable[]} [transfer] */
const post = (reply, transfer = []) => self.postMessage(reply, { transfer });

/**
 * The routes this device can take, best first. The graphics chip only when it does 16-bit maths, which the model file needs.
 * @returns {Promise<Route[]>}
 */
async function routes() {
  try {
    const adapter = await /** @type {any} */ (navigator).gpu?.requestAdapter();
    if (adapter?.features.has("shader-f16")) return ["webgpu", "wasm"];
  } catch {
    // No usable graphics chip: the processor does it.
  }
  return ["wasm"];
}

/** @param {string} file */
async function isCached(file) {
  try {
    const keys = await (await caches.open(CACHE_NAME)).keys();
    return keys.some((request) => request.url.includes(MODEL_REVISION) && request.url.endsWith(file));
  } catch {
    return false;
  }
}

/** The model that is set up and ready, with the route it runs on. Kept between photos: the second one only has to run it. */
/** @type {{ route: Route; model: any } | null} */
let ready = null;
/** @type {any} */
let processor = null;
/** The newest request. An older one still waiting its turn is dropped. */
let newest = 0;
/** What the current request is doing, for the error message if it fails. */
/** @type {import("./sceneGeometry").DepthStage | "library"} */
let stage = "library";

/**
 * @param {import("./sceneGeometry").DepthRequest} request
 * @param {Route} route
 */
async function estimateOn(request, route) {
  const { id, width, height } = request;
  stage = "library";
  const lib = await import("@huggingface/transformers");

  if (ready?.route !== route) {
    await ready?.model.dispose();
    ready = null;
    stage = "download";
    const cached = await isCached(MODEL_FILE.file);
    post({ type: "progress", id, stage, device: route, cached });
    processor ??= await lib.AutoProcessor.from_pretrained(MODEL_ID, { revision: MODEL_REVISION });
    let percent = -1;
    const model = await lib.AutoModelForDepthEstimation.from_pretrained(MODEL_ID, {
      revision: MODEL_REVISION,
      device: route,
      dtype: MODEL_FILE.dtype,
      progress_callback: (info) => {
        if (!("file" in info) || info.file !== MODEL_FILE.file) return;
        if (info.status === "progress" && info.total > 0) {
          // One message per percent, not one per network packet.
          const now = Math.floor((info.loaded / info.total) * 100);
          if (now === percent) return;
          percent = now;
          post({ type: "progress", id, stage: "download", device: route, loaded: info.loaded, total: info.total, cached });
        } else if (info.status === "done") {
          stage = "start";
          post({ type: "progress", id, stage, device: route });
        }
      },
    });
    ready = { route, model };
  }

  stage = "estimate";
  post({ type: "progress", id, stage, device: route });
  // The model takes RGB. A canvas has already flattened any transparency, so the fourth byte is dropped.
  const rgb = new Uint8ClampedArray(width * height * 3);
  for (let p = 0, q = 0; p < request.pixels.length; p += 4, q += 3) {
    rgb[q] = request.pixels[p];
    rgb[q + 1] = request.pixels[p + 1];
    rgb[q + 2] = request.pixels[p + 2];
  }
  const inputs = await processor(new lib.RawImage(rgb, width, height, 3));
  const { predicted_depth } = await ready.model(inputs);
  const [modelHeight, modelWidth] = predicted_depth.dims.slice(-2);
  const raw = Float32Array.from(predicted_depth.data);
  predicted_depth.dispose();
  // A graphics driver that gets 16-bit maths wrong gives numbers that are not numbers. Better the slower route than a blank map.
  if (!raw.every(Number.isFinite)) throw new Error("the model's output was not a depth map");
  return buildGeometry(nearness(resizeCubic(raw, modelWidth, modelHeight, width, height)), width, height);
}

/** @param {import("./sceneGeometry").DepthRequest} request */
async function estimate(request) {
  const { id } = request;
  if (id !== newest) return post({ type: "skipped", id });
  const started = performance.now();
  // The route that is already set up first; otherwise the best this device has.
  const order = await routes();
  if (ready) order.sort((a, b) => Number(b === ready?.route) - Number(a === ready?.route));
  let failure = { stage, message: "" };
  for (const route of order) {
    try {
      const maps = await estimateOn(request, route);
      return post({ type: "done", id, device: route, ms: performance.now() - started, maps }, [maps.depth.buffer, maps.normals.buffer]);
    } catch (error) {
      failure = { stage, message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      console.warn(`Relight: the depth model failed on ${route} (${failure.stage}).`, error);
      ready = null;
    }
  }
  post({ type: "error", id, ...failure });
}

// One photo at a time: two loading at once would each download the file.
let queue = Promise.resolve();

/** @param {MessageEvent<import("./sceneGeometry").DepthRequest>} event */
self.onmessage = (event) => {
  newest = event.data.id;
  queue = queue.then(() => estimate(event.data));
};
