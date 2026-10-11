// The depth model, run in the browser: Depth Anything V2 Small (the model the
// backend runs, backend/app/ideas/relight.py) through transformers.js, then
// lib/sceneGeometry.ts turns its output into the scene's depth and normal maps.
// In a Worker so the page stays smooth while the model downloads and runs.
//
// Plain JavaScript for the same reason as lib/relightCpu.worker.js: the bundler
// copies this file as it stands into the build folder.

import { CHECK_MAX_ROUGHNESS, CHECK_MIN_AGREEMENT, CHECK_SIDE, checkPasses, checkPicture, checkScores } from "./depthCheck";
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
 * Why the graphics chip is not to be tried again on this page; null while it
 * may be. A chip that got the test picture wrong, or threw, will do the same for
 * the next photo: the processor takes over without asking the user.
 * @type {import("./sceneGeometry").DepthFallback | null}
 */
let gpuProblem = null;
/** The graphics chip's maker and family, where the browser gives them out (for bug reports). */
let chip = "unknown";
/**
 * The graphics chip threw or went quiet in this Worker, which is then of no
 * more use: transformers.js runs one model at a time, each behind the last, so
 * a run that failed or never finished keeps every later one here from starting,
 * the processor's too. No route is tried here again: the page is told at once
 * and starts a clean Worker (localScene in lib/localScene.ts).
 */
let spoiled = false;

/** The name the check's failure is thrown under, to tell it from a chip that threw by itself. */
const CHECK_FAILED = "DepthCheckFailed";
/** How long a graphics chip that has gone wrong may take to hand its memory back, in milliseconds, before the processor starts regardless. */
const RELEASE_TIMEOUT_MS = 3000;
/** How long the graphics chip may take over the test picture, in milliseconds: a laptop needs 0.2 s and a phone a few; past this it is not going to answer. */
const CHECK_TIMEOUT_MS = 20000;

/**
 * Graphics chips that a tester has seen get this model wrong, so that they are
 * not left to the check alone. So far one: Qualcomm's Adreno under Windows (a
 * Snapdragon X laptop, Adreno X1-85, October 2026) covered every photo in a
 * grid of dimples. Other systems with a Qualcomm chip (Android) have not
 * reported and are left to the check.
 * @param {{ vendor?: string }} info what the browser says about the chip
 */
const knownBad = (info) => /qualcomm/i.test(info.vendor ?? "") && /Windows/i.test(navigator.userAgent);

/**
 * The routes this device can take, best first. The graphics chip only when it does 16-bit maths, which the model file needs.
 * @param {import("./sceneGeometry").DepthChoice} choice
 * @returns {Promise<Route[]>}
 */
async function routes(choice) {
  if (choice === "wasm" || gpuProblem) return ["wasm"];
  try {
    const adapter = await /** @type {any} */ (navigator).gpu?.requestAdapter();
    if (adapter?.info) chip = `${adapter.info.vendor || "unknown"} ${adapter.info.architecture || ""}`.trim();
    // Only when the chip would otherwise have been used, and never when a tester has asked for it by name or for the check ("webgpu", "check").
    if (choice === "auto" && adapter?.info && adapter.features.has("shader-f16") && knownBad(adapter.info)) {
      gpuProblem = "known";
      console.warn(`Relight: the graphics chip (${chip}) is on the list of chips known to get the depth model wrong. The processor is used instead. Add ?depth=check to the address to try the chip with the check, or ?depth=webgpu to use it unchecked.`);
      return ["wasm"];
    }
    // A tester who asks for the graphics chip gets it tried even without 16-bit maths: what goes wrong is the thing being looked for.
    // Never without a chip at all, though: a start that fails for want of one leaves the processor route unable to start too.
    if (adapter && (adapter.features.has("shader-f16") || choice === "webgpu")) return ["webgpu", "wasm"];
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

/** Let go of the model that is set up, and with it the graphics chip's memory. */
async function release() {
  const old = ready;
  ready = null;
  if (!old) return;
  try {
    await Promise.race([old.model.dispose(), new Promise((resolve) => setTimeout(resolve, RELEASE_TIMEOUT_MS))]);
  } catch {
    // It had already failed: there is nothing more to do with it.
  }
}

/**
 * Run the model on the built-in test picture and compare the answer with the
 * processor's (lib/depthCheck.ts). Throws when the graphics chip gets it wrong.
 * One more run of the model: about 0.15 s on a laptop's graphics chip.
 * @param {typeof import("@huggingface/transformers")} lib
 * @param {any} model
 */
async function check(lib, model) {
  const started = performance.now();
  const pixel_values = new lib.Tensor("float32", checkPicture(), [1, 3, CHECK_SIDE, CHECK_SIDE]);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let limit;
  const { predicted_depth } = await Promise.race([
    model({ pixel_values }),
    new Promise((_, reject) => (limit = setTimeout(() => reject(new Error("the graphics chip did not answer the depth model's check")), CHECK_TIMEOUT_MS))),
  ]).finally(() => clearTimeout(limit));
  const raw = Float32Array.from(predicted_depth.data);
  predicted_depth.dispose();
  pixel_values.dispose();
  const scores = raw.length === CHECK_SIDE * CHECK_SIDE ? checkScores(raw) : { agreement: NaN, roughness: NaN };
  const numbers = `agreement ${scores.agreement.toFixed(4)} (${CHECK_MIN_AGREEMENT} or more passes), roughness ${scores.roughness.toFixed(2)} times the processor's (${CHECK_MAX_ROUGHNESS} or less passes), ${Math.round(performance.now() - started)} ms`;
  if (checkPasses(scores)) return console.info(`Relight: the graphics chip (${chip}) passed the depth model's check: ${numbers}.`);
  const error = new Error(`the graphics chip (${chip}) got the depth model's test picture wrong: ${numbers}. The processor is used instead. Add ?depth=webgpu to the address to use the graphics chip anyway.`);
  error.name = CHECK_FAILED;
  throw error;
}

/** @param {Float32Array} raw */
function isFlat(raw) {
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] < low) low = raw[i];
    if (raw[i] > high) high = raw[i];
  }
  return !(high > low);
}

/**
 * @param {import("./sceneGeometry").DepthRequest} request
 * @param {Route} route
 */
async function estimateOn(request, route) {
  const { id, width, height } = request;
  stage = "library";
  const lib = await import("@huggingface/transformers");

  if (ready?.route !== route) {
    await release();
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
    // Once for each time the model is set up on the graphics chip, before any photo. A tester who asked for the chip by name gets it unchecked.
    if (route === "webgpu" && request.choice !== "webgpu") await check(lib, model);
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
  // The model never gives one single value for a whole picture, even a blank one. On the processor a flat map is kept, as before: there is nothing slower to turn to.
  if (route === "webgpu" && isFlat(raw)) throw new Error("the model's output was flat");
  return buildGeometry(nearness(resizeCubic(raw, modelWidth, modelHeight, width, height)), width, height);
}

/** @param {import("./sceneGeometry").DepthRequest} request */
async function estimate(request) {
  const { id } = request;
  if (id !== newest) return post({ type: "skipped", id });
  const started = performance.now();
  gpuProblem ??= request.fallback;
  // The route that is already set up first; otherwise the best this device has.
  const order = spoiled ? [] : await routes(request.choice);
  if (ready) order.sort((a, b) => Number(b === ready?.route) - Number(a === ready?.route));
  let failure = { stage, message: "" };
  for (const route of order) {
    try {
      const maps = await estimateOn(request, route);
      return post({ type: "done", id, device: route, fallback: route === "wasm" ? gpuProblem : null, ms: performance.now() - started, maps }, [maps.depth.buffer, maps.normals.buffer]);
    } catch (error) {
      failure = { stage, message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      console.warn(`Relight: the depth model failed on ${route} (${failure.stage}).`, error);
      // The chip is blamed only for what happens once the files are here: a download that broke says nothing about it.
      if (route === "webgpu" && (stage === "start" || stage === "estimate") && !/fetch|network|import/i.test(failure.message)) {
        gpuProblem = error instanceof Error && error.name === CHECK_FAILED ? "check" : "error";
        // A failed check is different: the chip answered, and the processor can follow it here.
        spoiled = gpuProblem === "error";
      }
      if (spoiled) break;
      await release();
    }
  }
  // With what was found out about the chip: a failed start can leave this Worker unable to start the processor either, and the page's next Worker must not try the chip again.
  post({ type: "error", id, ...failure, fallback: gpuProblem });
}

// One photo at a time: two loading at once would each download the file.
let queue = Promise.resolve();

/** @param {MessageEvent<import("./sceneGeometry").DepthRequest>} event */
self.onmessage = (event) => {
  newest = event.data.id;
  queue = queue.then(() => estimate(event.data));
};
