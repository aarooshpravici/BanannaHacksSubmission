// The frontend mock layer: canned answers for every endpoint, with realistic
// delays and placeholder images drawn in the browser. lib/api.ts routes here
// when mock mode is on, so the page works end to end with no backend.
//
// Nothing in here is a model. The scene's geometry is a synthetic dome, and
// Enhance is a contrast-and-bloom filter over the shaded preview.

import { ApiError } from "./api";
import { base64ToCanvas, canvasToBase64, ctx2d, makeCanvas, stripDataUrl } from "./image";
import { type SceneArrays, relightPixels, sceneArrays } from "./relightMath";
import {
  DEFAULT_LIGHT,
  type Health,
  type JobRef,
  type JobStatus,
  type LightIn,
  type RelightEnhanceIn,
  type RelightRender,
  type RelightRenderIn,
  type RelightScene,
  type RelightSceneIn,
} from "./types";

// --- helpers --------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const between = (min: number, max: number) => min + Math.random() * (max - min);
const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

/** Decode an upload the way the backend would, with the backend's error. */
async function decode(image: string): Promise<HTMLCanvasElement> {
  try {
    return await base64ToCanvas(image);
  } catch {
    throw new ApiError("could not read image", 400);
  }
}

// --- jobs -----------------------------------------------------------------------

interface MockJob {
  readyAt: number;
  settled: boolean;
  result?: unknown;
  error?: string;
}

const jobs = new Map<string, MockJob>();

/** Start `work` now; the job reports "pending" for at least `delayMs`. */
function submit(delayMs: number, work: () => Promise<unknown>): JobRef {
  const entry: MockJob = { readyAt: Date.now() + delayMs, settled: false };
  const job_id = uid("job");
  jobs.set(job_id, entry);
  work()
    .then(
      (result) => {
        entry.result = result;
      },
      (error: unknown) => {
        entry.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      },
    )
    .finally(() => {
      entry.settled = true;
    });
  return { job_id };
}

// --- shared endpoints -------------------------------------------------------------

export async function health(): Promise<Health> {
  await sleep(120);
  return { ok: true, mock_mode: true, providers: { fal: false, gemini: false } };
}

export async function job<T>(jobId: string): Promise<JobStatus<T>> {
  await sleep(80);
  const entry = jobs.get(jobId);
  if (!entry) throw new ApiError("unknown job id (jobs are lost when the server restarts)", 404);
  if (!entry.settled || Date.now() < entry.readyAt) return { status: "pending", result: null, error: null };
  if (entry.error !== undefined) return { status: "error", result: null, error: entry.error };
  return { status: "done", result: entry.result as T, error: null };
}

// --- relight --------------------------------------------------------------------

const MOCK_RELIEF = 0.3;
/** The mock renders on the CPU, so it works on a smaller copy of the scene. */
const MOCK_RENDER_SIDE = 768;

interface MockScene {
  image: HTMLCanvasElement;
  depth: HTMLCanvasElement;
  normals: HTMLCanvasElement;
  relief: number;
  arrays?: SceneArrays;
}

const scenes = new Map<string, MockScene>();

/**
 * A synthetic scene: a sphere-ish bump in the middle of a flat backdrop. The
 * normals come from the slope of the height field, exactly as the backend
 * derives them when the detailed normals model is off.
 */
function syntheticGeometry(width: number, height: number): { depth: HTMLCanvasElement; normals: HTMLCanvasElement } {
  const radius = 0.38 * Math.min(width, height);
  const nearness = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const dx = (i + 0.5 - width / 2) / radius;
      const dy = (j + 0.5 - height / 2) / radius;
      const r2 = dx * dx + dy * dy;
      nearness[j * width + i] = r2 < 1 ? Math.pow(1 - r2, 0.6) : 0;
    }
  }

  const depthPixels = new ImageData(width, height);
  const normalPixels = new ImageData(width, height);
  const depthData = depthPixels.data;
  const normalData = normalPixels.data;
  const z = (i: number, j: number) => nearness[Math.min(height - 1, Math.max(0, j)) * width + Math.min(width - 1, Math.max(0, i))] * MOCK_RELIEF;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const p = (j * width + i) * 4;
      const v = Math.round(nearness[j * width + i] * 255);
      depthData[p] = v;
      depthData[p + 1] = v;
      depthData[p + 2] = v;
      depthData[p + 3] = 255;
      // Slopes with x and y in image widths: one pixel is 1 / width.
      const dzdx = ((z(i + 1, j) - z(i - 1, j)) / 2) * width;
      const dzdy = ((z(i, j + 1) - z(i, j - 1)) / 2) * width;
      const len = Math.hypot(dzdx, dzdy, 1);
      // Encoded as n * 0.5 + 0.5, with G = y pointing down.
      normalData[p] = Math.round(((-dzdx / len) * 0.5 + 0.5) * 255);
      normalData[p + 1] = Math.round(((-dzdy / len) * 0.5 + 0.5) * 255);
      normalData[p + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      normalData[p + 3] = 255;
    }
  }

  const toCanvas = (pixels: ImageData) => {
    const canvas = makeCanvas(width, height);
    ctx2d(canvas).putImageData(pixels, 0, 0);
    return canvas;
  };
  return { depth: toCanvas(depthPixels), normals: toCanvas(normalPixels) };
}

export async function relightScene(body: RelightSceneIn): Promise<RelightScene> {
  const [image] = await Promise.all([decode(body.image), sleep(between(900, 1500))]);
  const { depth, normals } = syntheticGeometry(image.width, image.height);
  const scene_id = uid("scene");
  scenes.set(scene_id, { image, depth, normals, relief: MOCK_RELIEF });
  return {
    scene_id,
    width: image.width,
    height: image.height,
    image: stripDataUrl(body.image),
    depth: canvasToBase64(depth),
    normals: canvasToBase64(normals),
    relief: MOCK_RELIEF,
  };
}

/**
 * Register a scene the page already holds (a built-in sample, which comes with
 * real depth and normals) so mock renders and Enhance use its own geometry.
 */
export async function adoptScene(scene: RelightScene): Promise<string> {
  const [image, depth, normals] = await Promise.all([decode(scene.image), base64ToCanvas(scene.depth, true), base64ToCanvas(scene.normals, true), sleep(between(300, 600))]);
  const scene_id = uid("scene");
  scenes.set(scene_id, { image, depth, normals, relief: scene.relief });
  return scene_id;
}

/** The backend's relight(), run by lib/relightMath.ts on a reduced copy of the scene. */
function renderScene(sceneId: string, lightIn: LightIn | undefined, shadows: boolean): HTMLCanvasElement {
  const scene = scenes.get(sceneId);
  if (!scene) throw new ApiError("unknown scene id; upload the photo again", 404);
  if (!scene.arrays) {
    const scale = Math.min(1, MOCK_RENDER_SIDE / Math.max(scene.image.width, scene.image.height));
    const w = Math.max(1, Math.round(scene.image.width * scale));
    const h = Math.max(1, Math.round(scene.image.height * scale));
    const read = (source: HTMLCanvasElement) => {
      const canvas = makeCanvas(w, h);
      const ctx = ctx2d(canvas, true);
      ctx.drawImage(source, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h);
    };
    scene.arrays = sceneArrays(read(scene.image), read(scene.depth), read(scene.normals), scene.relief);
  }
  const { width, height } = scene.arrays;
  const pixels = relightPixels(scene.arrays, { ...DEFAULT_LIGHT, ...lightIn }, shadows);
  const out = makeCanvas(width, height);
  ctx2d(out).putImageData(new ImageData(pixels, width, height), 0, 0);
  return out;
}

export async function relightRender(body: RelightRenderIn): Promise<RelightRender> {
  await sleep(between(150, 300));
  return { image: canvasToBase64(renderScene(body.scene_id, body.light, body.shadows ?? true), "image/jpeg") };
}

export async function relightEnhance(body: RelightEnhanceIn): Promise<JobRef> {
  await sleep(between(150, 300));
  if (!scenes.has(body.scene_id)) throw new ApiError("unknown scene id; upload the photo again", 404);
  return submit(between(3000, 4200), async () => {
    const lit = renderScene(body.scene_id, body.light, body.shadows ?? true);
    // Stand-in for the diffusion clean-up: more contrast and a soft bloom.
    const out = makeCanvas(lit.width, lit.height);
    const ctx = ctx2d(out);
    ctx.filter = "contrast(1.12) saturate(1.2)";
    ctx.drawImage(lit, 0, 0);
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.28;
    ctx.filter = `blur(${Math.round(Math.max(lit.width, lit.height) * 0.02)}px)`;
    ctx.drawImage(lit, 0, 0);
    const result: RelightRender = { image: canvasToBase64(out, "image/jpeg") };
    return result;
  });
}
