// lib/sceneGeometry.ts: what the browser does with the depth model's output
// when there is no backend (the stretch to 0..1, the blur, the normals).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RELIEF, buildGeometry, gaussianBlur, nearness } from "../lib/sceneGeometry";

const close = (actual: number, expected: number, within: number, what: string) => assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual}, expected ${expected} (within ${within})`);

/** A normal as the PNG stores it (0..255 per axis) -> -1..1. */
const decode = (maps: Uint8ClampedArray, p: number): [number, number, number] => [0, 1, 2].map((c) => (maps[p * 4 + c] / 255) * 2 - 1) as [number, number, number];

describe("nearness", () => {
  test("stretches the 1st to the 99th percentile over 0..1, as np.percentile does", () => {
    const raw = Float32Array.from({ length: 100 }, (_, i) => i);
    const out = nearness(raw);
    // np.percentile([0..99], [1, 99]) = 0.99 and 98.01.
    close(out[50], (50 - 0.99) / (98.01 - 0.99), 1e-6, "the middle");
    assert.equal(out[0], 0);
    assert.equal(out[99], 1);
  });

  test("one stray pixel cannot squash the range", () => {
    const raw = Float32Array.from({ length: 1000 }, (_, i) => i / 999);
    raw[500] = 1e6;
    const out = nearness(raw);
    assert.equal(out[500], 1);
    close(out[250], 0.25, 0.02, "a quarter of the way");
  });

  test("larger values are nearer: nothing is flipped", () => {
    const out = nearness(Float32Array.from([3, 1, 2, 5, 4]));
    assert.ok(out[3] > out[4] && out[4] > out[0] && out[0] > out[2] && out[2] > out[1]);
  });

  test("a flat picture gives all zeros, as on the backend", () => {
    assert.deepEqual([...nearness(new Float32Array(16).fill(7))], new Array(16).fill(0));
  });
});

describe("gaussianBlur", () => {
  // sigma 0.5: OpenCV's kernel is 5 wide, weights exp(-2 k^2) for k = -2..2, divided by their sum.
  const sum = 1 + 2 * Math.exp(-2) + 2 * Math.exp(-8);
  const [w0, w1, w2] = [1, Math.exp(-2), Math.exp(-8)].map((w) => w / sum);

  test("spreads one bright pixel by the kernel, worked out by hand", () => {
    const out = gaussianBlur(Float32Array.from([0, 0, 0, 0, 1, 0, 0, 0, 0]), 9, 1, 0.5);
    [0, 0, w2, w1, w0, w1, w2, 0, 0].forEach((expected, i) => close(out[i], expected, 1e-6, `pixel ${i}`));
  });

  test("mirrors at the edge without repeating the edge pixel (BORDER_REFLECT_101)", () => {
    // Pixel 0 sees pixel 1 on both sides of it: once as itself and once as its mirror image at -1.
    // And pixel 1 sees itself again two to the left, mirrored at -1.
    const out = gaussianBlur(Float32Array.from([0, 1, 0, 0, 0]), 5, 1, 0.5);
    close(out[0], 2 * w1, 1e-6, "pixel 0");
    close(out[1], w0 + w2, 1e-6, "pixel 1");
    close(out[2], w1, 1e-6, "pixel 2");
  });

  test("blurs down the columns the same way as along the rows", () => {
    const across = gaussianBlur(Float32Array.from([0, 1, 0, 0, 1]), 5, 1, 0.5);
    const down = gaussianBlur(Float32Array.from([0, 1, 0, 0, 1]), 1, 5, 0.5);
    across.forEach((v, i) => close(down[i], v, 1e-7, `pixel ${i}`));
  });

  test("keeps a flat picture flat, and a sigma of 0 changes nothing", () => {
    const flat = new Float32Array(7 * 4).fill(0.3);
    for (const v of gaussianBlur(flat, 7, 4, 2)) close(v, 0.3, 1e-6, "flat");
    const ramp = Float32Array.from({ length: 12 }, (_, i) => i);
    assert.deepEqual(gaussianBlur(ramp, 4, 3, 0), ramp);
  });
});

describe("buildGeometry", () => {
  const SIZE = 64;

  test("the edge of a block faces the viewer, not sideways (the depth-step rule)", () => {
    // A box at nearness 0.8 on a floor at 0. The slope across its edge is about 8 (rise over run), far past 4.
    const height = Float32Array.from({ length: SIZE * SIZE }, (_, p) => {
      const [i, j] = [p % SIZE, Math.floor(p / SIZE)];
      return i >= 24 && i < 40 && j >= 24 && j < 40 ? 0.8 : 0;
    });
    const { depth, normals } = buildGeometry(height, SIZE, SIZE);
    for (const i of [22, 23, 24, 25, 38, 39, 40, 41]) {
      const [x, y, z] = decode(normals, 32 * SIZE + i);
      assert.ok(z > 0.97 && Math.abs(x) < 0.25 && Math.abs(y) < 0.05, `pixel ${i} on row 32: normal ${[x, y, z].map((v) => v.toFixed(2))}`);
    }
    // The depth map is the nearness, blurred a little, in 0..255.
    assert.equal(depth[(32 * SIZE + 32) * 4], 204);
    assert.equal(depth[(4 * SIZE + 4) * 4], 0);
    assert.equal(depth[(4 * SIZE + 4) * 4 + 3], 255);
  });

  test("a gentle dome keeps the normals its slope gives", () => {
    // A wide bump, at most 0.6 rise over run: well under 1.5, where the depth-step rule starts.
    const amplitude = 0.5;
    const spread = 0.15; // image widths
    const bump = (x: number, y: number) => amplitude * Math.exp(-((x - 0.5) ** 2 + (y - 0.5) ** 2) / (2 * spread * spread));
    const height = Float32Array.from({ length: SIZE * SIZE }, (_, p) => bump(((p % SIZE) + 0.5) / SIZE, (Math.floor(p / SIZE) + 0.5) / SIZE));
    const { normals } = buildGeometry(height, SIZE, SIZE);
    for (const [i, j] of [
      [16, 32],
      [48, 32],
      [32, 16],
      [32, 48],
      [22, 22],
      [42, 40],
    ]) {
      const [x, y] = [(i + 0.5) / SIZE, (j + 0.5) / SIZE];
      // The slope of z = bump * RELIEF, worked out on paper.
      const dzdx = (-RELIEF * bump(x, y) * (x - 0.5)) / (spread * spread);
      const dzdy = (-RELIEF * bump(x, y) * (y - 0.5)) / (spread * spread);
      const length = Math.hypot(dzdx, dzdy, 1);
      const expected = [-dzdx / length, -dzdy / length, 1 / length];
      const got = decode(normals, j * SIZE + i);
      got.forEach((v, c) => close(v, expected[c], 0.03, `pixel ${i}, ${j}, axis ${"xyz"[c]}`));
    }
    // Facing away from the middle: on the left flank the normal leans left.
    assert.ok(decode(normals, 32 * SIZE + 16)[0] < -0.2);
  });

  test("a flat floor faces the viewer everywhere", () => {
    const { normals } = buildGeometry(new Float32Array(SIZE * SIZE).fill(0.4), SIZE, SIZE);
    for (let p = 0; p < SIZE * SIZE; p++) assert.deepEqual([normals[p * 4], normals[p * 4 + 1], normals[p * 4 + 2], normals[p * 4 + 3]], [128, 128, 255, 255]);
  });
});
