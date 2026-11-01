// A depth model's raw output -> the depth and normal maps the shader lights.
//
// A port of backend/app/ideas/relight.py: estimate_depth() after the model has
// run (resize, normalise, open sky, the shift) and build_geometry() with normals=None
// (blur, relief, normals seen through a camera, the sky in the depth map's alpha). If the Python changes, change this too. OpenCV and
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
/**
 * DEPTH_STEP_SLOPE in the Python: the slope of the height field (rise over run, both in image widths) below which a
 * normal is kept as it is and above which it is turned to face the viewer. A slope that steep is a jump from one object
 * to what is behind it, not a surface; left alone, it gives every object a bright rim towards the light and a dark one
 * away from it.
 */
const DEPTH_STEP_SLOPE_LOW = 1.5;
const DEPTH_STEP_SLOPE_HIGH = 4;
/** DEPTH_STEP_GROW and DEPTH_STEP_FEATHER: how far the flattening reaches to either side of a jump, and how softly it fades out, in pixels at 512 width. */
const DEPTH_STEP_GROW = 3;
const DEPTH_STEP_FEATHER = 2;
/** DEPTH_STEP_GROW_CAMERA in the Python: DEPTH_STEP_GROW for normals seen through the camera, whose steeper slopes take more of a jump's shoulders past the threshold. */
const DEPTH_STEP_GROW_CAMERA = 5;
/**
 * DEPTH_SHIFT in the Python: how far the farthest part of a photo is from being infinitely far, as a share of its
 * whole depth range, at the least. The reasons are written there.
 */
export const DEPTH_SHIFT = 0.5;
/** FIELD_OF_VIEW in the Python: the angle of view of the camera the normals are seen through, across the longer side, in degrees. */
const FIELD_OF_VIEW = 70;
/** MIN_FACING in the Python: the least a depth-derived normal faces the viewer, so a surface seen edge on still faces it a little. */
const MIN_FACING = 0.05;
/** The share of pixels ignored at each end when the depth is stretched to 0..1, so one stray pixel cannot squash the range. */
const PERCENTILE_LOW = 0.01;
const PERCENTILE_HIGH = 0.99;
/** A depth range smaller than this is a flat picture: the map is all zeros, as on the backend. */
const FLAT_RANGE = 1e-6;
/**
 * SKY_THRESHOLD in the Python: a raw value at or below this share of the picture's 99th percentile is open sky. The
 * model gives exactly 0 for open sky and never 0 for a wall just behind someone; the reasons are written there.
 */
export const SKY_THRESHOLD = 1e-4;
/** SKY_SPECK in the Python: a patch of "sky" narrower than about twice this, in pixels at 512 width, is a speck the model left inside something, and is dropped. */
const SKY_SPECK = 3;
/** SKY_FEATHER in the Python: how softly the sky's edge changes over, in pixels at 512 width (the blur of the sky mask). */
const SKY_FEATHER = 6;
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

/** depth_shift(): buildGeometry's `shift` for a raw depth map stretched from lo (to 0) to hi (to 1). */
export function depthShift(lo: number, hi: number): number {
  if (!(hi - lo >= FLAT_RANGE)) return DEPTH_SHIFT;
  return DEPTH_SHIFT + Math.max(lo, 0) / (hi - lo);
}

/**
 * The model's depth, already at the scene's size -> nearness in 0..1 (1 =
 * closest), and the photo's shift for buildGeometry (estimate_depth in the
 * Python). Depth Anything gives larger values for closer surfaces, which is
 * already "toward the viewer": nothing is flipped.
 */
export function scaleDepth(raw: Float32Array): { nearness: Float32Array; shift: number } {
  const sorted = raw.slice().sort();
  const lo = percentile(sorted, PERCENTILE_LOW);
  const hi = percentile(sorted, PERCENTILE_HIGH);
  const out = new Float32Array(raw.length);
  const shift = depthShift(lo, hi);
  if (!(hi - lo >= FLAT_RANGE)) return { nearness: out, shift };
  for (let i = 0; i < raw.length; i++) out[i] = Math.min(1, Math.max(0, (raw[i] - lo) / (hi - lo)));
  return { nearness: out, shift };
}

/** scaleDepth without the shift. */
export const nearness = (raw: Float32Array): Float32Array => scaleDepth(raw).nearness;

/** open_sky(): where the model's raw depth, at the scene's size, says open sky. 1 = sky, 0 = not. */
export function openSky(raw: Float32Array, width: number, rows: number): Uint8Array {
  const sky = new Uint8Array(raw.length);
  const top = percentile(raw.slice().sort(), PERCENTILE_HIGH);
  if (!(top > 0)) return sky;
  const limit = SKY_THRESHOLD * top;
  const notSky = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) notSky[i] = raw[i] <= limit ? 0 : 1;
  // cv2.morphologyEx(MORPH_OPEN) with a square: erode the sky (grow what is not sky), then dilate it back. Past the
  // picture's edge counts for neither, as OpenCV's default border does.
  const reach = Math.max(1, Math.floor((SKY_SPECK * width) / 512 + 0.5));
  const eroded = dilate(notSky, width, rows, reach);
  for (let i = 0; i < raw.length; i++) eroded[i] = 1 - eroded[i];
  const opened = dilate(eroded, width, rows, reach);
  for (let i = 0; i < raw.length; i++) sky[i] = opened[i];
  return sky;
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
  /** Grey, white = near. Alpha is 255 - 255 * open sky (relight.depth_image): the grey is 0 in the sky, and the alpha 128 or more outside it. */
  depth: Uint8ClampedArray<ArrayBuffer>;
  /** R = x (right), G = y (down), B = z (to the viewer), each -1..1 stored as 0..255. */
  normals: Uint8ClampedArray<ArrayBuffer>;
}

/** cv2.dilate(src, np.ones((2 * reach + 1, 2 * reach + 1))): each pixel becomes the largest value within `reach` pixels of it, sideways and up and down. Past the picture's edge there is nothing to count. */
function dilate(src: Float32Array, width: number, height: number, reach: number): Float32Array {
  // The largest of 2 * reach + 1 values in a row, in a fixed number of steps whatever the reach (van Herk and
  // Gil-Werman): cut the line into blocks that long, keep the largest so far going forwards and going backwards in each
  // block, and every window is the larger of one backward and one forward value. The same answer as looking at every
  // value in the window, at a fraction of the work once the reach is several pixels (it grows with the photo's size).
  const size = 2 * reach + 1;
  const longest = Math.max(width, height) + 2 * reach;
  const ahead = new Float32Array(longest);
  const behind = new Float32Array(longest);
  const runningMax = (line: Float32Array, out: Float32Array, at: number, step: number, count: number) => {
    for (let start = 0; start < line.length; start += size) {
      const end = Math.min(line.length, start + size);
      let most = -Infinity;
      for (let k = start; k < end; k++) ahead[k] = most = line[k] > most ? line[k] : most;
      most = -Infinity;
      for (let k = end - 1; k >= start; k--) behind[k] = most = line[k] > most ? line[k] : most;
    }
    for (let i = 0; i < count; i++) out[at + i * step] = Math.max(behind[i], ahead[i + size - 1]);
  };
  // Past the picture's edge there is nothing to count: the lines are padded with -Infinity.
  const across = new Float32Array(width * height);
  const row = new Float32Array(width + 2 * reach).fill(-Infinity);
  for (let j = 0; j < height; j++) {
    row.set(src.subarray(j * width, (j + 1) * width), reach);
    runningMax(row, across, j * width, 1, width);
  }
  const out = new Float32Array(width * height);
  const column = new Float32Array(height + 2 * reach).fill(-Infinity);
  for (let i = 0; i < width; i++) {
    for (let j = 0; j < height; j++) column[reach + j] = across[j * width + i];
    runningMax(column, out, i, width, height);
  }
  return out;
}

/**
 * build_geometry(height) with no detailed normals: blur the nearness map, and
 * derive the normals from it. With a `shift` (from scaleDepth, more than 0)
 * they are those of the surface the depth stands for, seen through a camera
 * (_camera_normals in the Python, where the formula is worked out); without
 * one, the slope of the height field, as if seen from infinitely far away,
 * which shades a face and a receding table flatter. Fast either way, but the
 * depth map has little fine detail, so the normals are smoother than the
 * backend's detailed normals model's. Where the height jumps from one object
 * to the next, the normal faces the viewer (_depth_steps in the Python). `sky`
 * (from openSky) is where there is open sky: the depth map's alpha says how
 * much each pixel is sky (_sky_fade in the Python: a blur of the mask, a half
 * at its edge, held to a half at most outside it), and in the sky itself the
 * height is 0. A speck too small to survive the blur changes nothing.
 */
export function buildGeometry(height: Float32Array, width: number, rows: number, sky: Uint8Array | null = null, shift: number | null = null): GeometryMaps {
  const blurred = gaussianBlur(height, width, rows, (SMOOTH * width) / 512);
  let alpha: Uint8Array | null = null;
  if (sky && sky.some((v) => v === 1)) {
    const inside = Float32Array.from(sky);
    const spread = gaussianBlur(inside, width, rows, (SKY_FEATHER * width) / 512);
    alpha = new Uint8Array(sky.length);
    let any = false;
    for (let i = 0; i < sky.length; i++) {
      const fade = sky[i] ? spread[i] : Math.min(spread[i], 0.5);
      alpha[i] = Math.floor(255 - fade * 255 + 0.5);
      if (alpha[i] < 255) any = true;
      // Exactly 0 in the sky: a canvas keeps colours multiplied by alpha, and 0 is the one grey that survives that at every
      // alpha. Outside it the alpha is 128 or more, which a canvas carries through to within one level.
      if (sky[i] && alpha[i] < 255) blurred[i] = 0;
    }
    if (!any) alpha = null;
  }
  const depth = new Uint8ClampedArray(width * rows * 4);
  const normals = new Uint8ClampedArray(width * rows * 4);
  // Through a camera: the slope of ln(nearness + shift), times the focal length in image widths (k). Otherwise the height field's.
  const camera = shift !== null;
  const k = (0.5 * Math.max(width, rows)) / width / Math.tan((FIELD_OF_VIEW * Math.PI) / 360);
  let field = blurred;
  if (camera) {
    field = new Float32Array(blurred.length);
    for (let i = 0; i < blurred.length; i++) field[i] = Math.log(blurred[i] + shift);
  }
  const scale = camera ? k : RELIEF;
  const z = (i: number, j: number) => field[j * width + i] * scale;
  // np.gradient: the step is one pixel, 1 / width of an image width; one-sided at the edges.
  const slope = (ahead: number, behind: number, steps: number) => ((ahead - behind) / steps) * width;
  const slopeX = new Float32Array(width * rows);
  const slopeY = new Float32Array(width * rows);
  const steep = new Float32Array(width * rows);
  for (let j = 0; j < rows; j++) {
    const up = Math.max(0, j - 1);
    const down = Math.min(rows - 1, j + 1);
    for (let i = 0; i < width; i++) {
      const left = Math.max(0, i - 1);
      const right = Math.min(width - 1, i + 1);
      const dzdx = right > left ? slope(z(right, j), z(left, j), right - left) : 0;
      const dzdy = down > up ? slope(z(i, down), z(i, up), down - up) : 0;
      slopeX[j * width + i] = dzdx;
      slopeY[j * width + i] = dzdy;
      // _smoothstep(*DEPTH_STEP_SLOPE, slope)
      const t = Math.min(1, Math.max(0, (Math.hypot(dzdx, dzdy) - DEPTH_STEP_SLOPE_LOW) / (DEPTH_STEP_SLOPE_HIGH - DEPTH_STEP_SLOPE_LOW)));
      steep[j * width + i] = t * t * (3 - 2 * t);
    }
  }
  // _depth_steps: 0 = a surface, 1 = a jump from one object to what is behind it.
  const grow = camera ? DEPTH_STEP_GROW_CAMERA : DEPTH_STEP_GROW;
  const grown = dilate(steep, width, rows, Math.max(1, Math.floor((grow * width) / 512 + 0.5)));
  const steps = gaussianBlur(grown, width, rows, (DEPTH_STEP_FEATHER * width) / 512);
  for (let j = 0; j < rows; j++) {
    // The pixel's direction from the middle of the photo, over the focal length (u, v in _camera_normals).
    const v = ((j + 0.5) / width - (0.5 * rows) / width) / k;
    for (let i = 0; i < width; i++) {
      const surface = 1 - steps[j * width + i];
      const dzdx = slopeX[j * width + i] * surface;
      const dzdy = slopeY[j * width + i] * surface;
      const u = ((i + 0.5) / width - 0.5) / k;
      const facing = camera ? Math.max(1 - (dzdx * u + dzdy * v), MIN_FACING) : 1;
      const length = Math.hypot(dzdx, dzdy, facing);
      const p = (j * width + i) * 4;
      const grey = Math.floor(blurred[j * width + i] * 255 + 0.5);
      depth[p] = grey;
      depth[p + 1] = grey;
      depth[p + 2] = grey;
      depth[p + 3] = alpha ? alpha[j * width + i] : 255;
      normals[p] = Math.floor(((-dzdx / length) * 0.5 + 0.5) * 255 + 0.5);
      normals[p + 1] = Math.floor(((-dzdy / length) * 0.5 + 0.5) * 255 + 0.5);
      normals[p + 2] = Math.floor(((facing / length) * 0.5 + 0.5) * 255 + 0.5);
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
