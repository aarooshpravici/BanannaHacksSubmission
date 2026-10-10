// The frontend mock layer: canned answers for every endpoint, with realistic
// delays and placeholder images drawn in the browser. lib/api.ts routes here
// when mock mode is on, so every page works end to end with no backend.
//
// Nothing in here is a model. Relight returns a synthetic dome as geometry,
// autocomplete "fills" with tinted gradients, turnaround mirrors the upload.

import { ApiError } from "./api";
import {
  type BBox,
  base64ToCanvas,
  canvasToBase64,
  ctx2d,
  makeCanvas,
  maskToAlphaCanvas,
  rectToMask,
  stripDataUrl,
} from "./image";
import { type SceneArrays, relightPixels, sceneArrays } from "./relightMath";
import {
  type AnalyzeOut,
  type ChecklistItem,
  type CutoutOut,
  DEFAULT_LIGHT,
  type DetectOut,
  type Feature,
  type FillCandidate,
  type FillIn,
  type FillResult,
  type GenerateIn,
  type Health,
  type ImageIn,
  type JobRef,
  type JobStatus,
  type LightIn,
  type MaskedImageIn,
  type PlanOut,
  type RelightEnhanceIn,
  type RelightRender,
  type RelightRenderIn,
  type RelightScene,
  type RelightSceneIn,
  type ScoreIn,
  type ScoreOut,
  VIEWS,
  type View,
  type ViewResult,
} from "./types";

// --- helpers --------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const between = (min: number, max: number) => min + Math.random() * (max - min);
const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Decode an upload the way the backend would, with the backend's error. */
async function decode(image: string): Promise<HTMLCanvasElement> {
  try {
    return await base64ToCanvas(image);
  } catch {
    throw new ApiError("could not read image", 400);
  }
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** The most common colours of an image, ignoring transparent pixels. */
function extractPalette(canvas: HTMLCanvasElement, count = 5): string[] {
  const small = makeCanvas(48, 48);
  const ctx = ctx2d(small, true);
  ctx.drawImage(canvas, 0, 0, 48, 48);
  const data = ctx.getImageData(0, 0, 48, 48).data;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const key = ((data[i] >> 5) << 6) | ((data[i + 1] >> 5) << 3) | (data[i + 2] >> 5);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++;
    bucket.r += data[i];
    bucket.g += data[i + 1];
    bucket.b += data[i + 2];
    buckets.set(key, bucket);
  }
  const top = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, count);
  return top.length ? top.map((b) => hex(b.r / b.n, b.g / b.n, b.b / b.n)) : ["#808080"];
}

/** Bounding box and coverage of a mask's alpha channel. */
function alphaBounds(mask: HTMLCanvasElement): { bbox: BBox; coverage: number } | null {
  const { width: w, height: h } = mask;
  const data = ctx2d(mask, true).getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1, on = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] <= 127) continue;
      on++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { bbox: [minX, minY, maxX - minX + 1, maxY - minY + 1], coverage: on / (w * h) };
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
  return { ok: true, mock_mode: true, providers: { fal: false, replicate: false, anthropic: false, gemini: false } };
}

export async function job<T>(jobId: string): Promise<JobStatus<T>> {
  await sleep(80);
  const entry = jobs.get(jobId);
  if (!entry) throw new ApiError("unknown job id (jobs are lost when the server restarts)", 404);
  if (!entry.settled || Date.now() < entry.readyAt) return { status: "pending", result: null, error: null };
  if (entry.error !== undefined) return { status: "error", result: null, error: entry.error };
  return { status: "done", result: entry.result as T, error: null };
}

export async function cutout(body: ImageIn): Promise<CutoutOut> {
  const [canvas] = await Promise.all([decode(body.image), sleep(between(600, 1000))]);
  return { cutout: canvasToBase64(canvas), palette: extractPalette(canvas) };
}

export async function score(body: ScoreIn): Promise<ScoreOut> {
  await Promise.all([decode(body.reference), decode(body.candidate), sleep(between(500, 900))]);
  const scores: Record<string, number> = { identity: 0.82, palette: 0.9 };
  if (body.prompt) scores.intent = 0.76;
  // Same rule as the backend's weighted_total: renormalise over the axes present.
  const weights = body.weights ?? { identity: 0.6, palette: 0.4 };
  let sum = 0;
  let weightSum = 0;
  for (const [axis, weight] of Object.entries(weights)) {
    if (axis in scores && weight > 0) {
      sum += scores[axis] * weight;
      weightSum += weight;
    }
  }
  if (weightSum === 0) throw new ApiError("no weighted score axes present", 400);
  return { scores, total: round3(sum / weightSum) };
}

// --- relight --------------------------------------------------------------------

const MOCK_RELIEF = 0.3;
/** The mock renders on the CPU, so it works on a smaller copy of the scene. */
const MOCK_RENDER_SIDE = 768;

interface MockScene {
  image: HTMLCanvasElement;
  depth: HTMLCanvasElement;
  normals: HTMLCanvasElement;
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
  scenes.set(scene_id, { image, depth, normals });
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
    scene.arrays = sceneArrays(read(scene.image), read(scene.depth), read(scene.normals), MOCK_RELIEF);
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

// --- design autocomplete ----------------------------------------------------------

const MOCK_REGIONS: { frac: BBox; reason: string; confidence: number; siblings: BBox[] }[] = [
  {
    frac: [0.56, 0.12, 0.36, 0.32],
    reason: "Large empty area in the upper right. The block below it has no counterpart here, so the layout is weighted to the left.",
    confidence: 0.87,
    siblings: [[0.56, 0.54, 0.36, 0.36]],
  },
  {
    frac: [0.07, 0.66, 0.4, 0.24],
    reason: "Blank band in the lower left, where a supporting graphic or call to action would normally sit.",
    confidence: 0.64,
    siblings: [],
  },
];

export async function autocompleteDetect(body: ImageIn): Promise<DetectOut> {
  const [design] = await Promise.all([decode(body.image), sleep(between(900, 1400))]);
  const { width, height } = design;
  return {
    width,
    height,
    regions: MOCK_REGIONS.map((region, i) => {
      const toPixels = ([fx, fy, fw, fh]: BBox): BBox => [Math.round(fx * width), Math.round(fy * height), Math.round(fw * width), Math.round(fh * height)];
      const bbox = toPixels(region.frac);
      return {
        id: `r${i}`,
        bbox,
        mask: rectToMask(bbox, width, height),
        reason: region.reason,
        confidence: region.confidence,
        siblings: region.siblings.map(toPixels),
      };
    }),
  };
}

async function readMask(mask: string, width: number, height: number): Promise<{ alpha: HTMLCanvasElement; bbox: BBox; coverage: number }> {
  let alpha: HTMLCanvasElement;
  try {
    alpha = await maskToAlphaCanvas(mask, width, height);
  } catch {
    throw new ApiError("could not read mask", 400);
  }
  const bounds = alphaBounds(alpha);
  if (!bounds) throw new ApiError("mask is empty", 400);
  return { alpha, ...bounds };
}

export async function autocompletePlan(body: MaskedImageIn): Promise<PlanOut> {
  const [design] = await Promise.all([decode(body.image), sleep(between(800, 1300))]);
  const { width, height } = design;
  const { bbox, coverage } = await readMask(body.mask, width, height);
  const cx = (bbox[0] + bbox[2] / 2) / width;
  const cy = (bbox[1] + bbox[3] / 2) / height;
  const vertical = cy < 0.4 ? "upper" : cy > 0.6 ? "lower" : "middle";
  const horizontal = cx < 0.4 ? "left" : cx > 0.6 ? "right" : "centre";
  const where = horizontal === "centre" && vertical === "middle" ? "centre" : `${vertical} ${horizontal}`;
  const palette = extractPalette(design, 3);
  const shape = bbox[2] > bbox[3] * 1.4 ? "wide" : bbox[3] > bbox[2] * 1.4 ? "tall" : "roughly square";
  return {
    analysis:
      `The selected area is a ${shape} gap in the ${where} of the design, about ${Math.max(1, Math.round(coverage * 100))}% of the canvas. ` +
      `The layout around it is built on ${palette.join(", ")}. Whatever goes here should balance the composition ` +
      `and stay inside that palette so it reads as part of the original design.`,
    suggestions: [
      {
        label: "Hero illustration",
        prompt: `A bold flat illustration that fills the ${where} area, using ${palette[0]} and ${palette[1] ?? palette[0]}, matching the existing shapes and line weight.`,
      },
      {
        label: "Abstract shapes",
        prompt: `Overlapping abstract geometric shapes in the design's palette, soft gradients, no text, continuing the background seamlessly.`,
      },
      {
        label: "Product badge",
        prompt: `A circular badge with a simple icon in the middle, in the same visual style and palette as the rest of the design.`,
      },
      {
        label: "Texture only",
        prompt: `Extend the background into this area with a subtle texture and a gentle gradient, nothing that draws attention.`,
      },
    ],
  };
}

const FILL_HUES = [46, 198, 322, 152, 14, 262, 96, 0];

/** Placeholder "generated" content: a tinted gradient with a few shapes, covering `bbox`. */
function paintFill(width: number, height: number, bbox: BBox, hue: number, seed: number): HTMLCanvasElement {
  const canvas = makeCanvas(width, height);
  const ctx = ctx2d(canvas);
  const [x, y, w, h] = bbox;
  const gradient = ctx.createLinearGradient(x, y, x + w, y + h);
  gradient.addColorStop(0, `hsl(${hue} 78% 62%)`);
  gradient.addColorStop(1, `hsl(${(hue + 44) % 360} 72% 38%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, w, h);
  const unit = Math.min(w, h);
  const spots: [number, number, number, string][] = [
    [0.3 + 0.1 * seed, 0.4, 0.34, `hsl(${(hue + 20) % 360} 90% 76% / 0.75)`],
    [0.68 - 0.06 * seed, 0.62, 0.24, `hsl(${(hue + 320) % 360} 80% 30% / 0.6)`],
    [0.55, 0.3 + 0.05 * seed, 0.14, "hsl(0 0% 100% / 0.8)"],
  ];
  for (const [fx, fy, fr, fill] of spots) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x + (fx - Math.floor(fx)) * w, y + fy * h, fr * unit, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "hsl(0 0% 100% / 0.35)";
  ctx.lineWidth = Math.max(2, unit * 0.03);
  ctx.beginPath();
  ctx.moveTo(x, y + h * (0.75 - 0.08 * seed));
  ctx.lineTo(x + w, y + h * (0.35 + 0.08 * seed));
  ctx.stroke();
  return canvas;
}

/** `design` with `content` laid over it wherever `alpha` is opaque. */
function composite(design: HTMLCanvasElement, content: HTMLCanvasElement, alpha: HTMLCanvasElement): HTMLCanvasElement {
  const layer = makeCanvas(design.width, design.height);
  const layerCtx = ctx2d(layer);
  layerCtx.drawImage(content, 0, 0);
  layerCtx.globalCompositeOperation = "destination-in";
  layerCtx.drawImage(alpha, 0, 0);
  const out = makeCanvas(design.width, design.height);
  const ctx = ctx2d(out);
  ctx.drawImage(design, 0, 0);
  ctx.drawImage(layer, 0, 0);
  return out;
}

export async function autocompleteFill(body: FillIn): Promise<JobRef> {
  await sleep(between(150, 300));
  const n = body.n ?? 4;
  if (!Number.isInteger(n) || n < 1 || n > 8) throw new ApiError("n: Input should be between 1 and 8", 422);
  return submit(between(2800, 3800), async () => {
    const design = await decode(body.image);
    const { width, height } = design;
    const { alpha, bbox } = await readMask(body.mask, width, height);

    // The blended version feathers the mask edge; the raw one has the hard seam.
    const feathered = makeCanvas(width, height);
    const featherCtx = ctx2d(feathered);
    featherCtx.filter = `blur(${Math.max(3, Math.round(Math.max(width, height) * 0.012))}px)`;
    featherCtx.drawImage(alpha, 0, 0);

    const candidates: FillCandidate[] = [];
    for (let i = 0; i < n; i++) {
      const content = paintFill(width, height, bbox, FILL_HUES[i % FILL_HUES.length], i);
      const raw = composite(design, content, alpha);
      // A generator re-renders the whole frame, so the raw output drifts a little everywhere.
      const rawCtx = ctx2d(raw);
      rawCtx.fillStyle = `hsl(${FILL_HUES[i % FILL_HUES.length]} 80% 50% / 0.07)`;
      rawCtx.fillRect(0, 0, width, height);
      const style = clamp01(0.93 - 0.07 * i - Math.random() * 0.02);
      const seam = clamp01(0.9 - 0.05 * i - Math.random() * 0.02);
      const intent = clamp01(0.86 - 0.08 * i - Math.random() * 0.02);
      candidates.push({
        id: uid("cand"),
        image: canvasToBase64(composite(design, content, feathered)),
        raw: canvasToBase64(raw),
        scores: { style: round3(style), seam: round3(seam), intent: round3(intent), total: round3(0.4 * style + 0.3 * seam + 0.3 * intent) },
      });
    }
    candidates.sort((a, b) => b.scores.total - a.scores.total);
    const result: FillResult = { candidates };
    return result;
  });
}

// --- turnaround -------------------------------------------------------------------

interface MockCharacter {
  cutout: HTMLCanvasElement;
  features: Feature[];
}

const characters = new Map<string, MockCharacter>();

export async function turnaroundAnalyze(body: ImageIn): Promise<AnalyzeOut> {
  const [cutoutCanvas] = await Promise.all([decode(body.image), sleep(between(1000, 1600))]);
  const features: Feature[] = [
    { id: "hair", name: "Hair shape and colour", visible_from: [...VIEWS], critical: true },
    { id: "face", name: "Face and eyes", visible_from: ["front", "three_quarter", "side"], critical: true },
    { id: "emblem", name: "Chest emblem", visible_from: ["front", "three_quarter"], critical: false },
    { id: "backpack", name: "Backpack", visible_from: ["three_quarter", "side", "back"], critical: false },
    { id: "boots", name: "Boots", visible_from: [...VIEWS], critical: false },
  ];
  const character_id = uid("char");
  characters.set(character_id, { cutout: cutoutCanvas, features });
  return {
    character_id,
    cutout: canvasToBase64(cutoutCanvas),
    source_view: "front",
    spec: {
      summary: "A stylised full-body character with a clear silhouette, a small set of signature props and a limited colour palette.",
      art_style: "Flat-shaded cartoon illustration with clean outlines",
      features,
      palette: extractPalette(cutoutCanvas),
    },
  };
}

const VIEW_SQUEEZE: Record<View, number> = { front: 1, three_quarter: 0.88, side: 0.72, back: 1 };

/** A stand-in for a generated view: the cutout mirrored, narrowed and filtered. */
function fakeView(cutoutCanvas: HTMLCanvasElement, mirror: boolean, squeeze: number, filter: string): string {
  const { width, height } = cutoutCanvas;
  const out = makeCanvas(width, height);
  const ctx = ctx2d(out);
  ctx.filter = filter;
  ctx.translate(width / 2, 0);
  ctx.scale(mirror ? -squeeze : squeeze, 1);
  ctx.drawImage(cutoutCanvas, -width / 2, 0);
  return canvasToBase64(out);
}

export async function turnaroundGenerate(body: GenerateIn): Promise<JobRef> {
  await sleep(between(150, 300));
  const character = characters.get(body.character_id);
  if (!character) throw new ApiError("unknown character id; upload the drawing again", 404);
  const features = body.features ?? character.features;
  const view = body.target_view;
  return submit(between(3000, 4200), async () => {
    const squeeze = VIEW_SQUEEZE[view];
    const checklist: ChecklistItem[] = features.map((feature) => {
      const expected_visible = feature.visible_from.includes(view);
      return { feature_id: feature.id, expected_visible, present: expected_visible };
    });
    // Exactly one item fails: a non-critical feature goes missing, or, if none
    // is expected in this view, something that should be hidden shows up.
    const missing = checklist.find((item, i) => item.expected_visible && !features[i].critical);
    const leaked = checklist.find((item) => !item.expected_visible);
    if (missing) missing.present = false;
    else if (leaked) leaked.present = true;

    const passed = checklist.filter((item) => item.present === item.expected_visible).length;
    const identity = 0.84;
    const palette = 0.91;
    const checklistScore = checklist.length ? passed / checklist.length : 1;
    const result: ViewResult = {
      image: fakeView(character.cutout, true, squeeze, view === "back" ? "brightness(0.8) saturate(0.85)" : "none"),
      scores: {
        identity,
        palette,
        checklist: round3(checklistScore),
        total: round3(0.4 * identity + 0.2 * palette + 0.4 * checklistScore),
      },
      checklist,
      retries: 1,
      alternates: [
        { image: fakeView(character.cutout, true, squeeze * 0.94, "hue-rotate(18deg)"), total: 0.71 },
        { image: fakeView(character.cutout, false, squeeze, "hue-rotate(-24deg) saturate(0.8)"), total: 0.63 },
      ],
    };
    return result;
  });
}
