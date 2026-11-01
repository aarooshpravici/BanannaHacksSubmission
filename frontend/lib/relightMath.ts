// CPU port of backend/app/ideas/relight.py, kept line-for-line close to the Python.
//
// It has three jobs: it is the reference the WebGL shader (lib/relightGL.ts) is
// checked against, it backs the mock /relight/render and /relight/enhance, and
// it prepares the low-resolution height field the shader marches for shadows.
//
// Conventions (same as the backend): x right, y down, z toward the viewer.
// Lengths are in image widths: x in [0, 1], y in [0, H/W], z = depth * relief.

import type { FillLight, Light } from "./types";

export const MAX_FALLOFF = 3.0; // relight.MAX_FALLOFF
/** relight.TERMINATOR_SOFTNESS: how gradually a surface goes dark as it turns away from the light. */
export const TERMINATOR_SOFTNESS = 0.6;
export const SHADOW_STEPS = 48; // shadows(steps=48)
export const SHADOW_MAX_SIDE = 256; // shadows(max_side=256)
export const SHADOW_SOFTNESS = 0.02; // shadows(softness=0.02)
export const SHADOW_BIAS = 0.02; // bias = 0.02 * relief
// The next six are relight.py's constants of the same names; the reasons for
// each value are written there. Shadows are sorted into a near, a mid and a far
// layer by the gap between blocker and receiver (as a fraction of the relief).
export const SHADOW_GAP_NEAR = 0.1;
export const SHADOW_GAP_MID = 0.3;
export const SHADOW_GAP_FAR = 0.7;
/** Blur of the near, mid and far layers, in shadow-map pixels. */
export const SHADOW_BLUR_SIGMAS = [1.0, 3.0, 8.0] as const;
/** How dark a shadow on a far background gets (1 = as dark as a contact shadow). */
export const SHADOW_FAR_STRENGTH = 0.35;
/** The gap is measured between the highest and lowest surface within this many shadow-map pixels. */
export const SHADOW_SPREAD = 2;
export const HIGHLIGHT_KNEE = 0.8; // apply_shading knee
/**
 * relight.SHININESS: how tight a highlight is, the power of n . h. Shine (a
 * light's `shine`, 0 = matte) is a glossy highlight, Blinn-Phong style, from
 * each light, as relight.py's shine_map:
 *
 *   shine = Shine * intensity * max(n . h, 0) ** SHININESS * diffuse * shadow
 *   h     = normalize(l + v),  l = unit direction to the light,  v = (0, 0, 1)
 *
 * added to the lit photo in the light's colour (not the photo's) before the
 * roll-off, kept off open sky, and for the fill with the key's Shine and no
 * shadow. Why each part, and why 48: the comment above SHININESS in relight.py.
 */
export const SHININESS = 48.0;
/** cv2.remap interpolates on a 1/32-pixel grid (INTER_BITS = 5). */
export const REMAP_SUBPIXEL = 32;

export type Vec3 = [number, number, number];

/** Python's round(): halves go to the nearest even integer. */
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** _light_position: where the light is, in image widths. The main light or the fill. */
export function lightPosition(width: number, height: number, relief: number, light: Pick<Light, "x" | "y" | "height">): Vec3 {
  return [light.x, (light.y * height) / width, relief + Math.max(light.height, 1e-3)];
}

/** _soft_terminator: max(cos, 0) with the corner rounded off. */
export function softTerminator(cos: number): number {
  const k = TERMINATOR_SOFTNESS;
  const eased = Math.max(cos + k, 0.0) ** 2 / (4.0 * k);
  return cos >= k ? cos : eased;
}

/** _gloss: max(n . h, 0) ** SHININESS, for the unit normal n and the unit direction (lx, ly, lz) to the light, with the viewer straight ahead. */
export function gloss(nx: number, ny: number, nz: number, lx: number, ly: number, lz: number): number {
  const hz = lz + 1.0;
  const length = Math.max(Math.hypot(lx, ly, hz), 1e-6);
  return Math.max((nx * lx + ny * ly + nz * hz) / length, 0.0) ** SHININESS;
}

/** The size shadows() works at: longest side capped at max_side. */
export function shadowSize(width: number, height: number): [number, number] {
  const scale = Math.min(1.0, SHADOW_MAX_SIDE / Math.max(height, width));
  return [Math.max(1, pyRound(width * scale)), Math.max(1, pyRound(height * scale))];
}

/**
 * The 1-D kernel cv2.GaussianBlur(src, (0, 0), sigma) uses on float images:
 * ksize = round(sigma * 8 + 1) | 1, weights exp(-x^2 / 2 sigma^2), normalised.
 * Returns the centre weight first, then the weights at distance 1, 2, ...
 */
export function gaussianKernel(sigma: number): number[] {
  const ksize = Math.round(sigma * 8 + 1) | 1;
  const radius = (ksize - 1) / 2;
  const half: number[] = [];
  let sum = 0;
  for (let i = 0; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    half.push(w);
    sum += i === 0 ? w : 2 * w;
  }
  return half.map((w) => w / sum);
}

/** cv2.BORDER_REFLECT_101: ... 2 1 | 0 1 2 ... n-1 | n-2 n-3 ... */
function reflect101(i: number, n: number): number {
  if (n === 1) return 0;
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * (n - 1) - i;
  return i;
}

/**
 * cv2.resize(src, (dw, dh), interpolation=cv2.INTER_AREA) for shrinking: every
 * destination pixel is the average of the source area it covers, with partial
 * pixels weighted by how much of them is covered.
 */
export function resizeArea(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  if (sw === dw && sh === dh) return src.slice();
  const axis = (s: number, d: number) => {
    const scale = s / d;
    const taps: { index: number; weight: number }[][] = [];
    for (let i = 0; i < d; i++) {
      const start = i * scale;
      const end = Math.min((i + 1) * scale, s);
      const row: { index: number; weight: number }[] = [];
      let total = 0;
      for (let j = Math.floor(start); j < Math.ceil(end) && j < s; j++) {
        const weight = Math.min(j + 1, end) - Math.max(j, start);
        if (weight > 1e-9) {
          row.push({ index: j, weight });
          total += weight;
        }
      }
      if (row.length === 0) {
        row.push({ index: Math.min(s - 1, Math.floor(start)), weight: 1 });
        total = 1;
      }
      for (const tap of row) tap.weight /= total;
      taps.push(row);
    }
    return taps;
  };
  const xTaps = axis(sw, dw);
  const yTaps = axis(sh, dh);
  const tmp = new Float32Array(dw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      let acc = 0;
      for (const tap of xTaps[x]) acc += src[y * sw + tap.index] * tap.weight;
      tmp[y * dw + x] = acc;
    }
  }
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let acc = 0;
      for (const tap of yTaps[y]) acc += tmp[tap.index * dw + x] * tap.weight;
      out[y * dw + x] = acc;
    }
  }
  return out;
}

/** _smoothstep */
export function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3.0 - 2.0 * t);
}

/**
 * cv2.dilate (sign = 1) or cv2.erode (sign = -1) with a square of ones reaching
 * `radius` pixels each way: the largest or smallest value in the square.
 * Pixels outside the image are ignored, as OpenCV's default border does.
 */
function spread(src: Float32Array, w: number, h: number, radius: number, sign: 1 | -1): Float32Array {
  const pass = (from: Float32Array, n: number, m: number, at: (line: number, i: number) => number) => {
    const to = new Float32Array(w * h);
    for (let line = 0; line < m; line++) {
      for (let i = 0; i < n; i++) {
        let best = from[at(line, i)];
        for (let k = Math.max(0, i - radius); k <= Math.min(n - 1, i + radius); k++) {
          const v = from[at(line, k)];
          if (sign * v > sign * best) best = v;
        }
        to[at(line, i)] = best;
      }
    }
    return to;
  };
  const rows = pass(src, w, h, (j, i) => j * w + i);
  return pass(rows, h, w, (i, j) => j * w + i);
}

/** The height field shadows() marches, at the shadow resolution. */
export interface ShadowField {
  width: number;
  height: number;
  /** z resized to the shadow resolution. */
  z: Float32Array;
  /** cv2.dilate(z): the highest surface within SHADOW_SPREAD pixels. */
  crest: Float32Array;
  /** cv2.erode(z): the lowest surface within SHADOW_SPREAD pixels. */
  floor: Float32Array;
  /** Geometry.sky resized the same way (how much each shadow-map pixel is open sky); null when the scene has none. */
  sky?: Float32Array | null;
}

/**
 * The height field shadows() marches: z resized to the shadow resolution, with
 * its dilated and eroded copies. `depth` is nearness in 0..1 (the scene's depth
 * PNG / 255), dw x dh pixels. `sky` (SceneArrays.sky, the same size) is
 * shrunk alongside it, for shadowMap to keep shadows off open sky.
 */
export function shadowHeightField(
  depth: Float32Array,
  dw: number,
  dh: number,
  sceneWidth: number,
  sceneHeight: number,
  relief: number,
  sky: Float32Array | null = null,
): ShadowField {
  const [width, height] = shadowSize(sceneWidth, sceneHeight);
  const z = resizeArea(depth, dw, dh, width, height);
  for (let i = 0; i < z.length; i++) z[i] *= relief;
  const crest = spread(z, width, height, SHADOW_SPREAD, 1);
  const floor = spread(z, width, height, SHADOW_SPREAD, -1);
  return { width, height, z, crest, floor, sky: sky ? resizeArea(sky, dw, dh, width, height) : null };
}

/** cv2.GaussianBlur(src, (0, 0), sigma) on a float image: separable, BORDER_REFLECT_101. */
function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const kernel = gaussianKernel(sigma);
  const radius = kernel.length - 1;
  const tmp = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += kernel[Math.abs(k)] * src[j * w + reflect101(i + k, w)];
      tmp[j * w + i] = acc;
    }
  }
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += kernel[Math.abs(k)] * tmp[reflect101(j + k, h) * w + i];
      out[j * w + i] = acc;
    }
  }
  return out;
}

/**
 * shadows(): 1 = fully lit, 0 = fully shadowed, at the shadow resolution
 * (already blurred; the caller upsamples it bilinearly).
 */
export function shadowMap(field: ShadowField, relief: number, lightPos: Vec3): Float32Array {
  const { width: w, height: h, z, crest, floor } = field;
  const sky = field.sky ?? null;
  const [lx, ly, lz] = lightPos;
  const bias = SHADOW_BIAS * relief;
  // cv2.remap(src, mx, my, INTER_LINEAR, borderMode=BORDER_CONSTANT, borderValue=0)
  const sample = (src: Float32Array, mx: number, my: number) => {
    const fetch = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : src[y * w + x]);
    mx = Math.round(mx * REMAP_SUBPIXEL) / REMAP_SUBPIXEL;
    my = Math.round(my * REMAP_SUBPIXEL) / REMAP_SUBPIXEL;
    const x0 = Math.floor(mx);
    const y0 = Math.floor(my);
    const ax = mx - x0;
    const ay = my - y0;
    const top = fetch(x0, y0) * (1 - ax) + fetch(x0 + 1, y0) * ax;
    const bottom = fetch(x0, y0 + 1) * (1 - ax) + fetch(x0 + 1, y0 + 1) * ax;
    return top * (1 - ay) + bottom * ay;
  };

  const near = new Float32Array(w * h);
  const mid = new Float32Array(w * h);
  const far = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const p = j * w + i;
      const px = (i + 0.5) / w;
      const py = (j + 0.5) / w; // widths, so the aspect ratio is kept
      const pz = z[p];
      // The ray can only be blocked while it is below the tallest surface.
      const tEnd = Math.min(1, Math.max(0, (relief - pz) / Math.max(lz - pz, 1e-6)));
      for (let s = 1; s <= SHADOW_STEPS; s++) {
        const t = tEnd * (s / SHADOW_STEPS);
        const qx = px + (lx - px) * t;
        const qy = py + (ly - py) * t;
        const qz = pz + (lz - pz) * t;
        const mx = qx * w - 0.5;
        const my = qy * w - 0.5;
        const surface = sample(z, mx, my);
        let occlusion = Math.min(1, Math.max(0, (surface - qz - bias) / SHADOW_SOFTNESS));
        if (occlusion <= 0) continue; // nothing to add to any layer
        const gap = (sample(crest, mx, my) - floor[p]) / relief;
        const toMid = smoothstep(SHADOW_GAP_NEAR, SHADOW_GAP_MID, gap);
        const toFar = smoothstep(SHADOW_GAP_MID, SHADOW_GAP_FAR, gap);
        occlusion = occlusion * (1.0 - (1.0 - SHADOW_FAR_STRENGTH) * smoothstep(SHADOW_GAP_NEAR, SHADOW_GAP_FAR, gap));
        near[p] = Math.max(near[p], occlusion * (1.0 - toMid));
        mid[p] = Math.max(mid[p], occlusion * toMid * (1.0 - toFar));
        far[p] = Math.max(far[p], occlusion * toMid * toFar);
      }
      // Open sky receives no shadow, taken out before the blur and twice as fast as its brightness is given back, as in shadows().
      if (sky) {
        const keep = Math.fround(1.0 - Math.min(2.0 * sky[p], 1.0));
        near[p] *= keep;
        mid[p] *= keep;
        far[p] *= keep;
      }
    }
  }

  const lit = new Float32Array(w * h).fill(1);
  [near, mid, far].forEach((layer, k) => {
    const blurred = gaussianBlur(layer, w, h, SHADOW_BLUR_SIGMAS[k]);
    for (let p = 0; p < lit.length; p++) lit[p] = lit[p] * (1.0 - blurred[p]);
  });
  return lit;
}

/** cv2.resize(src, (dw, dh), interpolation=cv2.INTER_LINEAR) sampled at one destination pixel. */
function sampleBilinear(src: Float32Array, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): number {
  let fx = ((dx + 0.5) * sw) / dw - 0.5;
  let fy = ((dy + 0.5) * sh) / dh - 0.5;
  fx = Math.min(sw - 1, Math.max(0, fx));
  fy = Math.min(sh - 1, Math.max(0, fy));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(sw - 1, x0 + 1);
  const y1 = Math.min(sh - 1, y0 + 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const top = src[y0 * sw + x0] * (1 - ax) + src[y0 * sw + x1] * ax;
  const bottom = src[y1 * sw + x0] * (1 - ax) + src[y1 * sw + x1] * ax;
  return top * (1 - ay) + bottom * ay;
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 1e-8), 1 / 2.4) - 0.055;
}

/** A scene as plain arrays, all `width` x `height`. */
export interface SceneArrays {
  width: number;
  height: number;
  relief: number;
  /** RGBA bytes of the photo (canvas ImageData layout). */
  rgba: Uint8ClampedArray;
  /** Nearness 0..1, 1 = closest to the camera. */
  depth: Float32Array;
  /** Unit normals, 3 floats per pixel: x right, y down, z to the viewer. */
  normals: Float32Array;
  /**
   * How much each pixel is open sky, 0..1: (255 - the depth PNG's alpha) / 255,
   * as Geometry.sky in the Python. Null (or left out) when the alpha is 255
   * everywhere, as in every depth map from before there was sky: then not a
   * line of the shading below is different from what it was.
   */
  sky?: Float32Array | null;
}

/** Decode the scene's PNGs (as canvas ImageData) into the arrays the math uses. */
export function sceneArrays(
  image: ImageData,
  depth: ImageData,
  normals: ImageData,
  relief: number,
): SceneArrays {
  const { width, height } = image;
  if (depth.width !== width || depth.height !== height || normals.width !== width || normals.height !== height) {
    throw new Error("depth and normals must be the same size as the image");
  }
  const n = width * height;
  const d = new Float32Array(n);
  const nrm = new Float32Array(n * 3);
  let sky: Float32Array | null = null;
  for (let i = 0; i < n; i++) {
    d[i] = depth.data[i * 4] / 255;
    const alpha = depth.data[i * 4 + 3];
    if (alpha !== 255) {
      sky ??= new Float32Array(n);
      sky[i] = (255 - alpha) / 255;
    }
    const x = (normals.data[i * 4] / 255) * 2 - 1;
    const y = (normals.data[i * 4 + 1] / 255) * 2 - 1;
    const z = (normals.data[i * 4 + 2] / 255) * 2 - 1;
    const len = Math.max(Math.hypot(x, y, z), 1e-6);
    nrm[i * 3] = x / len;
    nrm[i * 3 + 1] = y / len;
    nrm[i * 3 + 2] = z / len;
  }
  return { width, height, relief, rgba: image.data, depth: d, normals: nrm, sky };
}

/** A finished shadow map (the output of shadowMap) with its size. */
export interface ShadowLayer {
  map: Float32Array;
  width: number;
  height: number;
}

/**
 * relight(): diffuse() * shadows() -> shading_map() -> apply_shading().
 * `fill` is relight()'s fill light: null = none. Only `light` casts shadows.
 * Returns RGBA bytes ready for putImageData.
 */
export function relightPixels(scene: SceneArrays, light: Light, castShadows = true, fill: FillLight | null = null): Uint8ClampedArray<ArrayBuffer> {
  const { width: w, height: h, relief, depth } = scene;
  let shadow: ShadowLayer | null = null;
  if (castShadows) {
    const field = shadowHeightField(depth, w, h, w, h, relief, scene.sky ?? null);
    shadow = { map: shadowMap(field, relief, lightPosition(w, h, relief, light)), width: field.width, height: field.height };
  }
  return shadePixels(scene, light, shadow, fill);
}

/**
 * The per-pixel half of relight(): diffuse() -> shading_map() -> apply_shading(),
 * with the shadow map handed in (null = no cast shadows). Split from
 * relightPixels so the CPU renderer (lib/relightCpuCore.ts) can keep the
 * height field between frames instead of rebuilding it for every one.
 *
 * With a fill light, fill_map() is added the way apply_shading() adds it: the
 * photo times the fill's share, in the fill's colour, before the roll-off.
 * Without one, not a line of the arithmetic below is different from before.
 * The same for open sky (scene.sky): where there is some, the result is moved
 * towards the photo by that share after the roll-off, as apply_shading() does.
 * And for Shine (light.shine, see SHININESS): at 0, or left out, none of its
 * lines run.
 */
export function shadePixels(scene: SceneArrays, light: Light, shadow: ShadowLayer | null, fill: FillLight | null = null): Uint8ClampedArray<ArrayBuffer> {
  const { width: w, height: h, relief, rgba, depth, normals } = scene;
  const sky = scene.sky ?? null;
  const [lx, ly, lz] = lightPosition(w, h, relief, light);

  // diffuse(): exposure is measured relative to the centre of the scene.
  const reference = Math.hypot(lx - 0.5, ly - (0.5 * h) / w, lz - relief / 2);
  // The same for the fill, from its own place and height.
  const [fx, fy, fz] = fill ? lightPosition(w, h, relief, fill) : [0, 0, 0];
  const fillReference = Math.hypot(fx - 0.5, fy - (0.5 * h) / w, fz - relief / 2);
  const out = new Uint8ClampedArray(w * h * 4);
  const knee = HIGHLIGHT_KNEE;
  // Shared by the two lights, like the ambient. Not above 0 (left out, or from something that knows nothing of it): none.
  const shine = light.shine > 0 ? light.shine : 0;

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const p = j * w + i;
      const tx = lx - (i + 0.5) / w;
      const ty = ly - (j + 0.5) / w;
      const tz = lz - depth[p] * relief;
      const dist = Math.hypot(tx, ty, tz);
      const safe = Math.max(dist, 1e-6);
      const cos = (normals[p * 3] * tx + normals[p * 3 + 1] * ty + normals[p * 3 + 2] * tz) / safe;
      const falloff = Math.min((reference / safe) ** 2, MAX_FALLOFF);
      let direct = Math.min(softTerminator(cos), 1.0) * falloff;
      if (shadow) direct *= sampleBilinear(shadow.map, shadow.width, shadow.height, i, j, w, h);
      const shading = light.ambient + light.intensity * direct;

      // fill_map(): intensity * diffuse(), with no shadow and no ambient.
      let fillShading = 0;
      // shine_map(), for each light: Shine * intensity * gloss * diffuse, the key's with its shadow (direct has it already).
      let keyShine = 0;
      let fillShine = 0;
      if (shine > 0) keyShine = light.intensity * shine * gloss(normals[p * 3], normals[p * 3 + 1], normals[p * 3 + 2], tx / safe, ty / safe, tz / safe) * direct;
      if (fill) {
        const ux = fx - (i + 0.5) / w;
        const uy = fy - (j + 0.5) / w;
        const uz = fz - depth[p] * relief;
        const fillSafe = Math.max(Math.hypot(ux, uy, uz), 1e-6);
        const fillCos = (normals[p * 3] * ux + normals[p * 3 + 1] * uy + normals[p * 3 + 2] * uz) / fillSafe;
        const fillFalloff = Math.min((fillReference / fillSafe) ** 2, MAX_FALLOFF);
        fillShading = fill.intensity * (Math.min(softTerminator(fillCos), 1.0) * fillFalloff);
        if (shine > 0) {
          const fillGloss = gloss(normals[p * 3], normals[p * 3 + 1], normals[p * 3 + 2], ux / fillSafe, uy / fillSafe, uz / fillSafe);
          fillShine = fill.intensity * shine * fillGloss * (Math.min(softTerminator(fillCos), 1.0) * fillFalloff);
        }
      }
      // None of the shine on open sky, right up to its edge: taken out twice as fast as the sky's brightness is given back, as apply_shading() does.
      const shineKept = shine > 0 && sky && sky[p] > 0 ? 1.0 - Math.min(2.0 * sky[p], 1.0) : 1.0;

      // apply_shading(): multiply in linear light, roll highlights off above the knee.
      const alpha = rgba[p * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) {
        // to_rgb() flattens transparency onto white.
        const srgb = (rgba[p * 4 + c] / 255) * alpha + (1 - alpha);
        let lit = srgbToLinear(srgb) * shading * light.color[c];
        if (fill) lit = lit + srgbToLinear(srgb) * fillShading * fill.color[c];
        // Shine is light the surface reflects: in each light's colour, and not multiplied by the photo.
        if (shine > 0) {
          let glossy = keyShine * light.color[c];
          if (fill) glossy = glossy + fillShine * fill.color[c];
          lit = lit + glossy * shineKept;
        }
        if (lit > knee) lit = knee + (1 - knee) * (1 - Math.exp(-(lit - knee) / (1 - knee)));
        // Open sky keeps the photo's own brightness: all of it where it is wholly sky.
        if (sky && sky[p] > 0) lit = lit * (1 - sky[p]) + srgbToLinear(srgb) * sky[p];
        const v = Math.min(1, Math.max(0, linearToSrgb(lit)));
        out[p * 4 + c] = Math.floor(v * 255 + 0.5);
      }
      out[p * 4 + 3] = 255;
    }
  }
  return out;
}
