// Tiny made-up scenes for the unit tests, with shapes whose lighting can be
// worked out by hand: a flat plane, a dome, a block standing on a floor.

import type { SceneArrays } from "../lib/relightMath";
import type { FillLight, Light } from "../lib/types";

export const RELIEF = 0.3;

/** A scene of one grey (or the colour given), with nearness and normals from `shape(x, y)` in image widths. */
export function scene(width: number, height: number, shape: (x: number, y: number) => { near: number; normal: [number, number, number] }, grey: [number, number, number] = [128, 128, 128]): SceneArrays {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const depth = new Float32Array(width * height);
  const normals = new Float32Array(width * height * 3);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const p = j * width + i;
      const { near, normal } = shape((i + 0.5) / width, (j + 0.5) / width);
      const length = Math.hypot(...normal);
      depth[p] = near;
      normals.set(normal.map((v) => v / length), p * 3);
      rgba.set([...grey, 255], p * 4);
    }
  }
  return { width, height, relief: RELIEF, rgba, depth, normals };
}

const FACING: [number, number, number] = [0, 0, 1];

export const plane = (width: number, height: number, near = 0.5, grey?: [number, number, number]) => scene(width, height, () => ({ near, normal: FACING }), grey);

/** A half ball of radius `radius` (image widths) in the middle of a floor at nearness 0, its top at radius / RELIEF. */
export const dome = (size: number, radius = 0.25) =>
  scene(size, size, (x, y) => {
    const dx = x - 0.5;
    const dy = y - 0.5;
    const r2 = dx * dx + dy * dy;
    if (r2 >= radius * radius) return { near: 0, normal: FACING };
    const h = Math.sqrt(radius * radius - r2);
    return { near: h / RELIEF, normal: [dx, dy, h] };
  });

/** A box whose top faces the viewer, standing at nearness `top` on a floor at 0. `from` and `to` are its edges, in image widths. */
export const block = (size: number, from = 0.375, to = 0.625, top = 0.8) =>
  scene(size, size, (x, y) => ({ near: x >= from && x < to && y >= from && y < to ? top : 0, normal: FACING }));

export const light = (overrides: Partial<Light> = {}): Light => ({ x: 0.5, y: 0.5, height: 0.25, intensity: 1, ambient: 0, color: [1, 1, 1], shine: 0, ...overrides });

export const fill = (overrides: Partial<FillLight> = {}): FillLight => ({ x: 0.8, y: 0.5, height: 0.25, intensity: 0.6, color: [1, 1, 1], ...overrides });

/** The mean of the red channel over the pixels for which `inside(i, j)` holds. */
export function mean(pixels: Uint8ClampedArray, width: number, inside: (i: number, j: number) => boolean): number {
  let sum = 0;
  let count = 0;
  for (let p = 0; p < pixels.length / 4; p++) {
    if (!inside(p % width, Math.floor(p / width))) continue;
    sum += pixels[p * 4];
    count++;
  }
  if (count === 0) throw new Error("no pixels in the region");
  return sum / count;
}
