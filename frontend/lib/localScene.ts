// A scene worked out in the browser, with no server: the photo's depth from the
// model in lib/depth.worker.js, in the same shape POST /relight/scene returns.
// The photo never leaves the device. The only downloads are the model's own
// files, once, which the browser then keeps.
//
// What it cannot do is the backend's detailed normals (a second, much larger
// model): these scenes have normals taken from the depth map's slope.

import { base64ToBitmap, canvasToBase64, ctx2d, makeCanvas, sniffMime, stripDataUrl } from "./image";
import { type DepthDevice, type DepthReply, type DepthRequest, type DepthStage, RELIEF, SCENE_MAX_SIDE } from "./sceneGeometry";
import type { RelightScene } from "./types";

export type { DepthDevice } from "./sceneGeometry";

/**
 * How long the Worker may say nothing while the model is downloading or being
 * set up, in milliseconds, before the page stops waiting. The download reports
 * every percent, so silence means a dead connection; but the last 5 MB (the code
 * that runs the model) arrives without reports, and a slow connection needs
 * most of a minute for that.
 */
const QUIET_TIMEOUT_MS = 60_000;
/**
 * How long the model may take over one photo, in milliseconds. A laptop needs
 * 0.1 to 2 seconds and a slow phone perhaps twenty; past this the tab is more
 * likely out of memory than still working.
 */
const ESTIMATE_TIMEOUT_MS = 90_000;

/** The backend never issued these ids: like a sample's scene, it has to be sent there before Enhance or a server render. */
const LOCAL_ID_PREFIX = "local:";

export const isLocalScene = (scene: RelightScene) => scene.scene_id.startsWith(LOCAL_ID_PREFIX);

/** What the page shows while it waits. */
export interface LocalProgress {
  stage: "prepare" | DepthStage;
  device?: DepthDevice;
  /** Bytes of the model file, while it downloads. */
  loaded?: number;
  total?: number;
  /** The file is coming from this browser's own store, not the network. */
  cached?: boolean;
}

export interface LocalScene {
  scene: RelightScene;
  /** How the depth model was run. */
  device: DepthDevice;
}

/** The line under the spinner. */
export function progressText(progress: LocalProgress): string {
  if (progress.stage === "prepare") return "Preparing your photo…";
  if (progress.stage === "estimate") return "Working out the shape of your photo…";
  if (progress.stage === "start") return "Starting the depth model…";
  if (progress.cached) return "Loading the depth model…";
  if (!progress.total) return "Downloading the depth model, once…";
  return `Downloading the depth model, ${Math.round(progress.total / 1e6)} MB, once… ${Math.floor(((progress.loaded ?? 0) / progress.total) * 100)}%`;
}

const SAMPLES_STILL_WORK = "The sample photos work without it.";

/** A failure -> a sentence for the page. The technical reason goes to the console (the Worker logs it). */
function failureText(stage: DepthStage | "library" | "timeout", message: string): string {
  if (stage === "timeout") return `Working out the shape took too long on this device, so it was stopped. ${SAMPLES_STILL_WORK}`;
  // The code that runs the model is fetched after the model itself: failing to get it is the same failure to the user.
  if (stage === "library" || stage === "download" || /fetch|network|import/i.test(message)) return `The depth model could not be downloaded. Check your connection and try again. ${SAMPLES_STILL_WORK}`;
  if (/memory|alloc/i.test(message)) return `This device ran out of memory running the depth model. Close other tabs and try again, or try a smaller photo. ${SAMPLES_STILL_WORK}`;
  return `This browser could not run the depth model. Try a current Chrome, Edge, Firefox or Safari. ${SAMPLES_STILL_WORK}`;
}

interface Job {
  id: number;
  resolve: (reply: Extract<DepthReply, { type: "done" }>) => void;
  reject: (error: Error) => void;
  onProgress: (progress: LocalProgress) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

// One Worker for the page's lifetime, so the model stays set up between photos.
let worker: Worker | null = null;
let job: Job | null = null;
let nextId = 0;

/** Stop waiting for the Worker and throw it away: whatever it was doing, it is not answering. A fresh one starts with the next photo. */
function fail(error: Error): void {
  const failed = job;
  job = null;
  if (failed?.timer) clearTimeout(failed.timer);
  worker?.terminate();
  worker = null;
  failed?.reject(error);
}

function watch(current: Job, ms: number, text: string): void {
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    if (job === current) fail(new Error(text));
  }, ms);
}

function onReply(reply: DepthReply): void {
  if (!job) return;
  const current = job;
  if (reply.id !== current.id) {
    // The photo before this one is still finishing in the Worker, which is not silence: this one's turn comes next.
    if (reply.type === "progress") watch(current, QUIET_TIMEOUT_MS, failureText("download", ""));
    return;
  }
  if (reply.type === "progress") {
    current.onProgress(reply);
    if (reply.stage === "estimate") watch(current, ESTIMATE_TIMEOUT_MS, failureText("timeout", ""));
    else watch(current, QUIET_TIMEOUT_MS, `The depth model stopped downloading. Check your connection and try again. ${SAMPLES_STILL_WORK}`);
    return;
  }
  if (reply.type === "done") {
    job = null;
    if (current.timer) clearTimeout(current.timer);
    current.resolve(reply);
  }
  // A Worker that has failed once keeps failing (the code that runs the model remembers a failed start): Retry gets a new one.
  else if (reply.type === "error") fail(new Error(failureText(reply.stage, reply.message)));
  // "skipped" never comes for the current photo: run() has already rejected the one it belonged to.
}

function run(request: Omit<DepthRequest, "id">, onProgress: (progress: LocalProgress) => void): Promise<Extract<DepthReply, { type: "done" }>> {
  return new Promise((resolve, reject) => {
    // A photo still being worked on has been replaced: its caller is no longer listening for anything but this.
    if (job) {
      if (job.timer) clearTimeout(job.timer);
      job.reject(new DOMException("Another photo was chosen.", "AbortError"));
    }
    const current: Job = { id: ++nextId, resolve, reject, onProgress, timer: null };
    job = current;
    try {
      if (!worker) {
        worker = new Worker(new URL("./depth.worker.js", import.meta.url));
        worker.onmessage = (event: MessageEvent<DepthReply>) => onReply(event.data);
        worker.onerror = (event) => {
          event.preventDefault();
          console.warn("Relight: the depth Worker failed.", event.message);
          fail(new Error(failureText("estimate", event.message ?? "")));
        };
      }
      watch(current, QUIET_TIMEOUT_MS, failureText("download", ""));
      const message: DepthRequest = { ...request, id: current.id };
      worker.postMessage(message, [request.pixels.buffer]);
    } catch (error) {
      console.warn("Relight: the depth Worker could not be started.", error);
      fail(new Error(failureText("estimate", "")));
    }
  });
}

/**
 * Work out a photo's scene in this browser. `image` is base64, as an upload is
 * held. Rejects with a sentence for the page, or with an AbortError when a
 * newer photo has taken this one's place.
 */
export async function localScene(image: string, onProgress: (progress: LocalProgress) => void): Promise<LocalScene> {
  onProgress({ stage: "prepare" });
  const base64 = stripDataUrl(image);
  let bitmap: ImageBitmap;
  try {
    bitmap = await base64ToBitmap(base64);
  } catch {
    throw new Error("That file is not an image this browser can read.");
  }
  // The backend's steps, in its order: transparency onto white, then down to the scene's size limit.
  const scale = Math.min(1, SCENE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = makeCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  const ctx = ctx2d(canvas, true);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const { width, height } = canvas;
  const pixels = ctx.getImageData(0, 0, width, height).data;
  // A JPEG that already fits is kept as it is: saving it again would only soften it.
  const photo = scale === 1 && sniffMime(base64) === "image/jpeg" ? base64 : canvasToBase64(canvas, "image/jpeg");

  const reply = await run({ type: "estimate", width, height, pixels }, onProgress);
  const toPng = (data: Uint8ClampedArray<ArrayBuffer>) => {
    const out = makeCanvas(width, height);
    ctx2d(out).putImageData(new ImageData(data, width, height), 0, 0);
    return canvasToBase64(out);
  };
  return {
    scene: {
      scene_id: `${LOCAL_ID_PREFIX}${Math.random().toString(36).slice(2, 10)}`,
      width,
      height,
      image: photo,
      depth: toPng(reply.maps.depth),
      normals: toPng(reply.maps.normals),
      relief: RELIEF,
    },
    device: reply.device,
  };
}
