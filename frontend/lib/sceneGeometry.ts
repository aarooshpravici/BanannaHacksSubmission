// A depth model's raw output -> the depth and normal maps the shader lights.
//
// A port of backend/app/ideas/relight.py: estimate_height() after the model has
// run (resize, normalise) and build_geometry() with normals=None (blur, relief,
// normals from the slope). If the Python changes, change this too. OpenCV and
// NumPy do the work there; each function here says which call it stands in for,
// because the details (kernel width, edge handling) are what make the maps match.
//
// No DOM in here: it runs in a Worker (lib/depth.worker.js).

/** Longest side of a scene, in pixels. MAX_SIDE in backend/app/routers/relight.py: shading is per-pixel work, 1024 keeps it fast. */
export const SCENE_MAX_SIDE = 1024;
/** How deep the scene is treated as being, in image widths. build_geometry's default: larger stretches the shadows and tilts the surfaces more. */
export const RELIEF = 0.3;
/** Blur of the depth map, in pixels at 512 width. build_geometry's default: less and depth noise shows as speckled shading, more and edges go soft. */
const SMOOTH = 1.5;
/** The share of pixels ignored at each end when the depth is stretched to 0..1, so one stray pixel cannot squash the range. */
const PERCENTILE_LOW = 0.01;
const PERCENTILE_HIGH = 0.99;
/** A depth range smaller than this is a flat picture: the map is all zeros, as on the backend. */
const FLAT_RANGE = 1e-6;
/** OpenCV's bicubic sharpness (the "a" of the cubic kernel). Not the textbook -0.5: this is what cv2.resize uses. */
const CUBIC_A = -0.75;

const clampIndex = (i: number, n: number) => (i < 0 ? 0 : i >= n ? n - 1 : i);

/** For each output position along one axis: the first of its four source samples and their four weights. */
function cubicTaps(srcSize: number, dstSize: number): { start: Int32Array; weights: Float32Array } {
  const start = new Int32Array(dstSize);
  const weights = new Float32Array(dstSize * 4);
  const scale = srcSize / dstSize;
  for (let d = 0; d < dstSize; d++) {
    const at = (d + 0.5) * scale - 0.5;
    const first = Math.floor(at);
    const f = at - first;
    const w0 = ((CUBIC_A * (f + 1) - 5 * CUBIC_A) * (f + 1) + 8 * CUBIC_A) * (f + 1) - 4 * CUBIC_A;
    const w1 = ((CUBIC_A + 2) * f - (CUBIC_A + 3)) * f * f + 1;
    const w2 = ((CUBIC_A + 2) * (1 - f) - (CUBIC_A + 3)) * (1 - f) * (1 - f) + 1;
    start[d] = first - 1;
    weights.set([w0, w1, w2, 1 - w0 - w1 - w2], d * 4);
  }
  return { start, weights };
}

/** cv2.resize(src, (dstW, dstH), interpolation=cv2.INTER_CUBIC) on one float channel. */
export function resizeCubic(src: Float32Array, srcW: number, srcH: number, dstW: number, dstH: number): Float32Array {
  if (srcW === dstW && srcH === dstH) return src.slice();
  const x = cubicTaps(srcW, dstW);
  const y = cubicTaps(srcH, dstH);
  // Across first, then down: the same result as doing both at once, at a fraction of the work.
  const across = new Float32Array(dstW * srcH);
  for (let j = 0; j < srcH; j++) {
    const row = j * srcW;
    for (let i = 0; i < dstW; i++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += src[row + clampIndex(x.start[i] + k, srcW)] * x.weights[i * 4 + k];
      across[j * dstW + i] = sum;
    }
  }
  const out = new Float32Array(dstW * dstH);
  for (let j = 0; j < dstH; j++) {
    for (let k = 0; k < 4; k++) {
      const row = clampIndex(y.start[j] + k, srcH) * dstW;
      const weight = y.weights[j * 4 + k];
      for (let i = 0; i < dstW; i++) out[j * dstW + i] += across[row + i] * weight;
    }
  }
  return out;
}

/** np.percentile(sorted, q * 100): a straight line between the two nearest values. */
function percentile(sorted: Float32Array, q: number): number {
  const at = q * (sorted.length - 1);
  const below = Math.floor(at);
  const above = Math.min(sorted.length - 1, below + 1);
  return sorted[below] + (sorted[above] - sorted[below]) * (at - below);
}

/**
 * The model's depth, already at the scene's size -> nearness in 0..1 (1 =
 * closest). Depth Anything gives larger values for closer surfaces, which is
 * already "toward the viewer": nothing is flipped.
 */
export function nearness(raw: Float32Array): Float32Array {
  const sorted = raw.slice().sort();
  const lo = percentile(sorted, PERCENTILE_LOW);
  const hi = percentile(sorted, PERCENTILE_HIGH);
  const out = new Float32Array(raw.length);
  if (!(hi - lo >= FLAT_RANGE)) return out;
  for (let i = 0; i < raw.length; i++) out[i] = Math.min(1, Math.max(0, (raw[i] - lo) / (hi - lo)));
  return out;
}

/** cv2.GaussianBlur(src, (0, 0), sigma) on one float channel: OpenCV's kernel width for floats, edges mirrored without repeating the edge pixel. */
export function gaussianBlur(src: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (!(sigma > 0)) return src.slice();
  const size = Math.round(sigma * 8 + 1) | 1;
  const half = (size - 1) / 2;
  const kernel = new Float32Array(size);
  let total = 0;
  for (let k = 0; k < size; k++) {
    kernel[k] = Math.exp(-((k - half) * (k - half)) / (2 * sigma * sigma));
    total += kernel[k];
  }
  for (let k = 0; k < size; k++) kernel[k] /= total;
  // BORDER_REFLECT_101: ... 2 1 | 0 1 2 ... n-2 n-1 | n-2 n-3 ...
  const mirror = (i: number, n: number) => {
    if (n === 1) return 0;
    const period = 2 * (n - 1);
    const m = ((i % period) + period) % period;
    return m < n ? m : period - m;
  };

  const across = new Float32Array(width * height);
  const columns = new Int32Array(size);
  for (let i = 0; i < width; i++) {
    for (let k = 0; k < size; k++) columns[k] = mirror(i + k - half, width);
    for (let j = 0; j < height; j++) {
      const row = j * width;
      let sum = 0;
      for (let k = 0; k < size; k++) sum += src[row + columns[k]] * kernel[k];
      across[row + i] = sum;
    }
  }
  const out = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let k = 0; k < size; k++) {
      const row = mirror(j + k - half, height) * width;
      const weight = kernel[k];
      for (let i = 0; i < width; i++) out[j * width + i] += across[row + i] * weight;
    }
  }
  return out;
}

/** The two maps as a canvas wants them: RGBA bytes, encoded as POST /relight/scene encodes its PNGs. */
export interface GeometryMaps {
  /** Grey, white = near. */
  depth: Uint8ClampedArray<ArrayBuffer>;
  /** R = x (right), G = y (down), B = z (to the viewer), each -1..1 stored as 0..255. */
  normals: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * build_geometry(height) with no detailed normals: blur the nearness map, and
 * take the normals from the slope of the height field it stands for. Fast, but
 * the depth map has little fine detail, so the normals are smooth: a face
 * shades flatter than with the backend's detailed normals model.
 */
export function buildGeometry(height: Float32Array, width: number, rows: number): GeometryMaps {
  const blurred = gaussianBlur(height, width, rows, (SMOOTH * width) / 512);
  const depth = new Uint8ClampedArray(width * rows * 4);
  const normals = new Uint8ClampedArray(width * rows * 4);
  const z = (i: number, j: number) => blurred[j * width + i] * RELIEF;
  // np.gradient: the step is one pixel, 1 / width of an image width; one-sided at the edges.
  const slope = (ahead: number, behind: number, steps: number) => ((ahead - behind) / steps) * width;
  for (let j = 0; j < rows; j++) {
    const up = Math.max(0, j - 1);
    const down = Math.min(rows - 1, j + 1);
    for (let i = 0; i < width; i++) {
      const left = Math.max(0, i - 1);
      const right = Math.min(width - 1, i + 1);
      const dzdx = right > left ? slope(z(right, j), z(left, j), right - left) : 0;
      const dzdy = down > up ? slope(z(i, down), z(i, up), down - up) : 0;
      const length = Math.hypot(dzdx, dzdy, 1);
      const p = (j * width + i) * 4;
      const grey = Math.floor(blurred[j * width + i] * 255 + 0.5);
      depth[p] = grey;
      depth[p + 1] = grey;
      depth[p + 2] = grey;
      depth[p + 3] = 255;
      normals[p] = Math.floor(((-dzdx / length) * 0.5 + 0.5) * 255 + 0.5);
      normals[p + 1] = Math.floor(((-dzdy / length) * 0.5 + 0.5) * 255 + 0.5);
      normals[p + 2] = Math.floor(((1 / length) * 0.5 + 0.5) * 255 + 0.5);
      normals[p + 3] = 255;
    }
  }
  return { depth, normals };
}

// --- what the page and the Worker say to each other ---------------------------------

/** How the depth model is run: on the graphics chip, or on the processor. */
export type DepthDevice = "webgpu" | "wasm";

/**
 * Which route to take: "auto" is the graphics chip when it can run the model,
 * is not on the Worker's list of chips known to get it wrong and passes the
 * check in lib/depthCheck.ts, otherwise the processor. The others are a
 * tester's choice (see depthChoice in lib/localScene.ts): "check" is "auto"
 * without the list.
 */
export type DepthChoice = "auto" | "check" | DepthDevice;

/**
 * Why the processor is running the model although the graphics chip could have:
 *   "known"  the chip is on the Worker's list of chips known to get the model wrong; it was not tried
 *   "check"  the chip ran the model and got the test picture wrong (lib/depthCheck.ts)
 *   "error"  the chip threw, setting the model up or running it, or did not answer
 */
export type DepthFallback = "known" | "check" | "error";

/** The photo at the scene's size, as RGBA bytes. */
export interface DepthRequest {
  type: "estimate";
  id: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
  choice: DepthChoice;
  /** What an earlier Worker on this page found wrong with the graphics chip, so a new one does not try it again. */
  fallback: DepthFallback | null;
}

/**
 * Where the Worker has got to:
 *   "download"  the model file is arriving (`loaded` of `total` bytes; `cached` when it comes from this browser's own store)
 *   "start"     the file is here and the model is being set up
 *   "estimate"  the model is looking at the photo
 */
export type DepthStage = "download" | "start" | "estimate";

export type DepthReply =
  | { type: "progress"; id: number; stage: DepthStage; device: DepthDevice; loaded?: number; total?: number; cached?: boolean }
  /** `fallback` says why, when the processor ran it in the graphics chip's place. */
  | { type: "done"; id: number; device: DepthDevice; fallback: DepthFallback | null; ms: number; maps: GeometryMaps }
  /** `stage` is what was going on when it failed; "library" is the code that runs the model failing to load. */
  | { type: "error"; id: number; stage: DepthStage | "library"; message: string; fallback: DepthFallback | null }
  /** A newer photo has taken this one's place. */
  | { type: "skipped"; id: number };
