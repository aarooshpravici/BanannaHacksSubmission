// lib/sceneGeometry.ts: what the browser does with the depth model's output
// when there is no backend (the stretch to 0..1, the blur, the normals).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DEPTH_SHIFT, RELIEF, buildGeometry, depthShift, gaussianBlur, nearness, openSky, scaleDepth } from "../lib/sceneGeometry";
import { readPng } from "./png";

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

  test("the shift: DEPTH_SHIFT, and more when the stretched range starts well above raw 0", () => {
    // Raw 0..99: the 1st percentile is 0.99, so the range starts 0.99 / 97.02 of itself above 0.
    close(scaleDepth(Float32Array.from({ length: 100 }, (_, i) => i)).shift, DEPTH_SHIFT + 0.99 / 97.02, 1e-9, "a deep scene");
    // A page: everything between raw 2.9 and 4.4, so it starts about twice its own range above 0, and is shaded flatter.
    close(depthShift(2.9, 4.4), DEPTH_SHIFT + 2.9 / 1.5, 1e-12, "a page");
    // Raw just below 0 (where the resize rings round open sky) counts as 0, and a flat map has the least shift.
    assert.equal(depthShift(-0.1, 2), DEPTH_SHIFT);
    assert.equal(scaleDepth(new Float32Array(16).fill(7)).shift, DEPTH_SHIFT);
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

describe("buildGeometry through a camera (with a shift)", () => {
  const [W, H] = [64, 48];
  /** The focal length in image widths, for a 70 degree view across the longer side (FIELD_OF_VIEW). */
  const k = (0.5 * Math.max(W, H)) / W / Math.tan((35 * Math.PI) / 180);

  test("a wall square to the camera faces the viewer everywhere, whatever the shift", () => {
    for (const shift of [0.5, 3]) {
      const { normals } = buildGeometry(new Float32Array(W * H).fill(0.4), W, H, null, shift);
      for (let p = 0; p < W * H; p++) assert.deepEqual([normals[p * 4], normals[p * 4 + 1], normals[p * 4 + 2]], [128, 128, 255]);
    }
  });

  test("a floor going back from the camera has one normal everywhere, the floor's own", () => {
    // A plane's disparity is a straight line across the picture: here 1 + b v, with v the pixel's height from the
    // middle over the focal length. Worked out on paper, that plane's normal is (0, -b, 1), made unit length: the
    // floor faces up and to the viewer, near the bottom of the picture and far up it alike.
    const b = 0.8;
    const height = Float32Array.from({ length: W * H }, (_, p) => 1 + (b * ((Math.floor(p / W) + 0.5) / W - (0.5 * H) / W)) / k - DEPTH_SHIFT);
    const { normals } = buildGeometry(height, W, H, null, DEPTH_SHIFT);
    const expected = [0, -b / Math.hypot(b, 1), 1 / Math.hypot(b, 1)];
    for (const [i, j] of [
      [32, 24],
      [2, 2],
      [61, 3],
      [5, 45],
      [60, 46],
    ])
      decode(normals, j * W + i).forEach((v, c) => close(v, expected[c], 0.01, `pixel ${i}, ${j}, axis ${"xyz"[c]}`));
  });

  test("the edge of a block still faces the viewer (the depth-step rule, on these slopes)", () => {
    const height = Float32Array.from({ length: W * W }, (_, p) => {
      const [i, j] = [p % W, Math.floor(p / W)];
      return i >= 24 && i < 40 && j >= 24 && j < 40 ? 0.8 : 0;
    });
    const { normals } = buildGeometry(height, W, W, null, DEPTH_SHIFT);
    for (const i of [22, 23, 24, 25, 38, 39, 40, 41]) {
      const [x, y, z] = decode(normals, 32 * W + i);
      assert.ok(z > 0.97 && Math.abs(x) < 0.25 && Math.abs(y) < 0.05, `pixel ${i} on row 32: normal ${[x, y, z].map((v) => v.toFixed(2))}`);
    }
  });

  test("a bump tilts more than the height field's slope says, and less with a larger shift (a page)", () => {
    const bump = (x: number, y: number) => 0.5 * Math.exp(-((x - 0.5) ** 2 + (y - 0.5) ** 2) / (2 * 0.15 * 0.15));
    const height = Float32Array.from({ length: W * W }, (_, p) => bump(((p % W) + 0.5) / W, (Math.floor(p / W) + 0.5) / W));
    const tilt = (shift: number | null) => -decode(buildGeometry(height, W, W, null, shift).normals, 32 * W + 16)[0];
    assert.ok(tilt(DEPTH_SHIFT) > 1.5 * tilt(null), `${tilt(DEPTH_SHIFT)} against ${tilt(null)}`);
    assert.ok(tilt(3) < tilt(DEPTH_SHIFT) / 2, `${tilt(3)} against ${tilt(DEPTH_SHIFT)}`);
  });
});

describe("buildGeometry agrees with relight.build_geometry", () => {
  // Pictures the Python made from the same depth maps: backend/scripts/relight_fixtures.py (its docstring says how).
  const FIXTURES = join(import.meta.dirname, "fixtures", "relight");
  const { scenes } = JSON.parse(readFileSync(join(FIXTURES, "cases.json"), "utf8")) as { scenes: { name: string; width: number; height: number; shift: number }[] };

  /** The largest difference over the channels given, in levels of 255. */
  const worst = (ours: Uint8ClampedArray, theirs: Uint8ClampedArray, channels: number[]) => {
    let most = 0;
    for (let p = 0; p < ours.length; p += 4) for (const c of channels) most = Math.max(most, Math.abs(ours[p + c] - theirs[p + c]));
    return most;
  };

  for (const scene of scenes) {
    test(`${scene.name} (${scene.width} x ${scene.height}), shift ${scene.shift}`, () => {
      const read = (file: string) => readPng(join(FIXTURES, scene.name, file)).data;
      const depth = read("depth.png");
      const size = scene.width * scene.height;
      const height = Float32Array.from({ length: size }, (_, p) => depth[p * 4] / 255);
      const sky = Uint8Array.from({ length: size }, (_, p) => (depth[p * 4 + 3] === 0 ? 1 : 0));
      const camera = buildGeometry(height, scene.width, scene.height, sky, scene.shift);
      const slope = buildGeometry(height, scene.width, scene.height, sky);
      assert.ok(worst(camera.normals, read("derived-normals-camera.png"), [0, 1, 2]) <= 1, "normals through a camera");
      assert.ok(worst(slope.normals, read("derived-normals-slope.png"), [0, 1, 2]) <= 1, "normals from the height field's slope");
      assert.ok(worst(camera.depth, read("derived-depth.png"), [0, 3]) <= 1, "depth map and its alpha");
    });
  }
});

describe("open sky", () => {
  test("raw zeros are open sky; a backdrop wall, however far, is not", () => {
    // Like the Portrait: a wall reading 0.012 to 0.09 behind someone whose nearest point reads 8.
    const wall = Float32Array.from({ length: 1000 }, (_, i) => (i < 100 ? 8 : 0.012 + (0.078 * i) / 999));
    assert.equal(openSky(wall, 1000, 1).reduce((a, b) => a + b, 0), 0);
    // Like the Rocket: sky (0, and a little below 0 where the resize rings) round a tower reading 2.
    const rocket = Float32Array.from({ length: 1000 }, (_, i) => (i < 200 ? 2 : i % 7 === 0 ? -0.1 : 0));
    const sky = openSky(rocket, 1000, 1);
    assert.equal(sky[0], 0);
    assert.equal(sky.slice(200).every((v) => v === 1), true);
    assert.equal(openSky(new Float32Array(100), 10, 10).reduce((a, b) => a + b, 0), 0, "a map with nothing in it is not all sky");
  });

  test("a few scattered zeros inside something are specks, not sky", () => {
    // 512 wide, so a speck has to be narrower than about 7 pixels (SKY_SPECK).
    const raw = new Float32Array(512 * 64).fill(3);
    for (let j = 20; j < 24; j++) for (let i = 100; i < 104; i++) raw[j * 512 + i] = 0;
    for (let j = 0; j < 64; j++) for (let i = 300; i < 340; i++) raw[j * 512 + i] = 0;
    const sky = openSky(raw, 512, 64);
    assert.equal(sky[22 * 512 + 101], 0, "a 4-pixel speck is dropped");
    assert.equal(sky[32 * 512 + 320], 1, "a 40-pixel band is kept");
    assert.equal(sky[0 * 512 + 300], 1, "right up to its edges, and the picture's");
  });

  /** A 512-wide picture: a block reading 5 in raw depth, against raw 0. */
  const blockAgainstSky = () => {
    const raw = new Float32Array(512 * 512);
    for (let j = 200; j < 300; j++) for (let i = 200; i < 300; i++) raw[j * 512 + i] = 5;
    return raw;
  };

  test("the sky goes into the depth map's alpha, softly across its edge, with the grey 0 in the sky and the alpha 128 or more outside it", () => {
    const raw = blockAgainstSky();
    const sky = openSky(raw, 512, 512);
    const { depth } = buildGeometry(nearness(raw), 512, 512, sky);
    let below = 0;
    for (let p = 0; p < 512 * 512; p++) {
      const alpha = depth[p * 4 + 3];
      if (alpha === 255) continue;
      below++;
      // So that a canvas, which keeps colours multiplied by alpha, gives the grey back: exactly in the sky, within one level elsewhere.
      if (sky[p]) assert.equal(depth[p * 4], 0, "grey 0 in the sky");
      else assert.ok(alpha >= 128, "never more sky than not outside the sky");
    }
    assert.ok(below > 512 * 512 * 0.9);
    // Across the block's right edge on row 250: what relight.depth_image writes for the same picture (worked out with the Python).
    const row = (c: number, from: number, to: number) => Array.from({ length: to - from }, (_, k) => depth[(250 * 512 + from + k) * 4 + c]);
    assert.deepEqual(row(3, 288, 316), [248, 245, 241, 235, 228, 220, 209, 197, 184, 169, 153, 136, 119, 102, 86, 71, 58, 46, 35, 27, 20, 14, 10, 7, 5, 3, 2, 1]);
    assert.deepEqual(row(0, 292, 306), [255, 255, 255, 255, 253, 244, 216, 161, 0, 0, 0, 0, 0, 0]);
  });

  test("with no sky, or a mask with no sky in it, the maps are what they were, alpha 255 everywhere", () => {
    const wall = nearness(Float32Array.from({ length: 64 * 48 }, (_, i) => 1 + Math.sin(i / 50)));
    const plain = buildGeometry(wall, 64, 48);
    assert.deepEqual(buildGeometry(wall, 64, 48, new Uint8Array(64 * 48)), plain);
    for (let p = 3; p < plain.depth.length; p += 4) assert.equal(plain.depth[p], 255);
  });
});
