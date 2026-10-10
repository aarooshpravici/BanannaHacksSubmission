// CPU port of backend/app/ideas/relight.py, kept line-for-line close to the Python.
//
// It has three jobs: it is the reference the WebGL shader (lib/relightGL.ts) is
// checked against, it backs the mock /relight/render and /relight/enhance, and
// it prepares the low-resolution height field the shader marches for shadows.
//
// Conventions (same as the backend): x right, y down, z toward the viewer.
// Lengths are in image widths: x in [0, 1], y in [0, H/W], z = depth * relief.

import type { Light } from "./types";

export const MAX_FALLOFF = 3.0; // relight.MAX_FALLOFF
export const SHADOW_STEPS = 48; // shadows(steps=48)
export const SHADOW_MAX_SIDE = 256; // shadows(max_side=256)
export const SHADOW_SOFTNESS = 0.02; // shadows(softness=0.02)
export const SHADOW_BIAS = 0.02; // bias = 0.02 * relief
export const SHADOW_BLUR_SIGMA = 1.0; // cv2.GaussianBlur(1 - occlusion, (0, 0), 1.0)
export const HIGHLIGHT_KNEE = 0.8; // apply_shading knee
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

/** _light_position: where the light is, in image widths. */
export function lightPosition(width: number, height: number, relief: number, light: Light): Vec3 {
  return [light.x, (light.y * height) / width, relief + Math.max(light.height, 1e-3)];
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

/**
 * The height field shadows() marches: z resized to the shadow resolution.
 * `depth` is nearness in 0..1 (the scene's depth PNG / 255), dw x dh pixels.
 */
export function shadowHeightField(
  depth: Float32Array,
  dw: number,
  dh: number,
  sceneWidth: number,
  sceneHeight: number,
  relief: number,
): { z: Float32Array; width: number; height: number } {
  const [width, height] = shadowSize(sceneWidth, sceneHeight);
  const z = resizeArea(depth, dw, dh, width, height);
  for (let i = 0; i < z.length; i++) z[i] *= relief;
  return { z, width, height };
}

/**
 * shadows(): 1 = fully lit, 0 = fully shadowed, at the shadow resolution
 * (already blurred; the caller upsamples it bilinearly).
 */
export function shadowMap(z: Float32Array, w: number, h: number, relief: number, lightPos: Vec3): Float32Array {
  const [lx, ly, lz] = lightPos;
  const bias = SHADOW_BIAS * relief;
  const fetch = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : z[y * w + x]);
  // cv2.remap(z, mx, my, INTER_LINEAR, borderMode=BORDER_CONSTANT, borderValue=0)
  const sample = (mx: number, my: number) => {
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

  const lit = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const px = (i + 0.5) / w;
      const py = (j + 0.5) / w; // widths, so the aspect ratio is kept
      const pz = z[j * w + i];
      // The ray can only be blocked while it is below the tallest surface.
      const tEnd = Math.min(1, Math.max(0, (relief - pz) / Math.max(lz - pz, 1e-6)));
      let occlusion = 0;
      for (let s = 1; s <= SHADOW_STEPS; s++) {
        const t = tEnd * (s / SHADOW_STEPS);
        const qx = px + (lx - px) * t;
        const qy = py + (ly - py) * t;
        const qz = pz + (lz - pz) * t;
        const surface = sample(qx * w - 0.5, qy * w - 0.5);
        const o = Math.min(1, Math.max(0, (surface - qz - bias) / SHADOW_SOFTNESS));
        if (o > occlusion) occlusion = o;
      }
      lit[j * w + i] = 1 - occlusion;
    }
  }

  // cv2.GaussianBlur(lit, (0, 0), 1.0): separable, BORDER_REFLECT_101.
  const kernel = gaussianKernel(SHADOW_BLUR_SIGMA);
  const radius = kernel.length - 1;
  const tmp = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += kernel[Math.abs(k)] * lit[j * w + reflect101(i + k, w)];
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
  for (let i = 0; i < n; i++) {
    d[i] = depth.data[i * 4] / 255;
    const x = (normals.data[i * 4] / 255) * 2 - 1;
    const y = (normals.data[i * 4 + 1] / 255) * 2 - 1;
    const z = (normals.data[i * 4 + 2] / 255) * 2 - 1;
    const len = Math.max(Math.hypot(x, y, z), 1e-6);
    nrm[i * 3] = x / len;
    nrm[i * 3 + 1] = y / len;
    nrm[i * 3 + 2] = z / len;
  }
  return { width, height, relief, rgba: image.data, depth: d, normals: nrm };
}

/**
 * relight(): diffuse() * shadows() -> shading_map() -> apply_shading().
 * Returns RGBA bytes ready for putImageData.
 */
export function relightPixels(scene: SceneArrays, light: Light, castShadows = true): Uint8ClampedArray<ArrayBuffer> {
  const { width: w, height: h, relief, rgba, depth, normals } = scene;
  const lightPos = lightPosition(w, h, relief, light);
  const [lx, ly, lz] = lightPos;

  let shadow: { map: Float32Array; width: number; height: number } | null = null;
  if (castShadows) {
    const field = shadowHeightField(depth, w, h, w, h, relief);
    shadow = { map: shadowMap(field.z, field.width, field.height, relief, lightPos), width: field.width, height: field.height };
  }

  // diffuse(): exposure is measured relative to the centre of the scene.
  const reference = Math.hypot(lx - 0.5, ly - (0.5 * h) / w, lz - relief / 2);
  const out = new Uint8ClampedArray(w * h * 4);
  const knee = HIGHLIGHT_KNEE;

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
      let direct = Math.min(1, Math.max(0, cos)) * falloff;
      if (shadow) direct *= sampleBilinear(shadow.map, shadow.width, shadow.height, i, j, w, h);
      const shading = light.ambient + light.intensity * direct;

      // apply_shading(): multiply in linear light, roll highlights off above the knee.
      const alpha = rgba[p * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) {
        // to_rgb() flattens transparency onto white.
        const srgb = (rgba[p * 4 + c] / 255) * alpha + (1 - alpha);
        let lit = srgbToLinear(srgb) * shading * light.color[c];
        if (lit > knee) lit = knee + (1 - knee) * (1 - Math.exp(-(lit - knee) / (1 - knee)));
        const v = Math.min(1, Math.max(0, linearToSrgb(lit)));
        out[p * 4 + c] = Math.floor(v * 255 + 0.5);
      }
      out[p * 4 + 3] = 255;
    }
  }
  return out;
}
