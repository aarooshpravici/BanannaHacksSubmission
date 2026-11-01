// Known answers for lib/relightMath.ts on scenes small enough to work out by
// hand (tests/scenes.ts). These say what the shading must do; the agreement
// test (agreement.test.ts) says it does the same as the Python.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  HIGHLIGHT_KNEE,
  TERMINATOR_SOFTNESS,
  gaussianKernel,
  lightPosition,
  linearToSrgb,
  pyRound,
  relightPixels,
  sceneArrays,
  shadowHeightField,
  shadowMap,
  softTerminator,
  srgbToLinear,
} from "../lib/relightMath";
import { block, dome, fill, light, mean, plane } from "./scenes";

const SIZE = 64;
const DOME_EDGE = 0.25 * SIZE; // the dome's radius, in pixels
const onDome = (i: number, j: number) => Math.hypot(i + 0.5 - SIZE / 2, j + 0.5 - SIZE / 2) < DOME_EDGE - 1;
const leftHalf = (i: number, j: number) => onDome(i, j) && i < SIZE / 2 - 2;
const rightHalf = (i: number, j: number) => onDome(i, j) && i >= SIZE / 2 + 2;
// Strips of floor beside the block (tests/scenes.ts), which spans pixels 24 to 39: just left of it, facing a light on the left, and just right of it, behind it.
const BEFORE = (i: number, j: number) => i >= 18 && i < 23 && j > 26 && j < 38;
const BEHIND = (i: number, j: number) => i >= 40 && i < 46 && j > 26 && j < 38;

describe("small helpers", () => {
  test("pyRound rounds halves to even, as Python's round() does", () => {
    assert.deepEqual([0.5, 1.5, 2.5, 3.5, 2.4, 2.6].map(pyRound), [0, 2, 2, 4, 2, 3]);
  });

  test("softTerminator is plain cosine above the softness, a quarter of it edge-on, nothing past it", () => {
    const k = TERMINATOR_SOFTNESS;
    assert.equal(softTerminator(1), 1);
    assert.equal(softTerminator(k + 0.1), k + 0.1);
    assert.ok(Math.abs(softTerminator(0) - k / 4) < 1e-12);
    assert.equal(softTerminator(-k), 0);
    assert.equal(softTerminator(-1), 0);
    // It meets the cosine without a step or a kink.
    assert.ok(Math.abs(softTerminator(k - 1e-9) - k) < 1e-6);
    assert.ok(Math.abs((softTerminator(k - 1e-6) - softTerminator(k - 2e-6)) / 1e-6 - 1) < 1e-3);
  });

  test("gaussianKernel has OpenCV's width and sums to 1", () => {
    for (const sigma of [1, 3, 8]) {
      const kernel = gaussianKernel(sigma);
      assert.equal(kernel.length * 2 - 1, Math.round(sigma * 8 + 1) | 1);
      assert.ok(Math.abs(kernel[0] + 2 * kernel.slice(1).reduce((a, b) => a + b, 0) - 1) < 1e-12);
    }
  });

  test("the sRGB curves undo each other", () => {
    // Not to the last digit: the two standard break points (0.04045 and 0.0031308) are a hair apart.
    for (const c of [0, 0.002, 0.04045, 0.2, 0.5, 1]) assert.ok(Math.abs(linearToSrgb(srgbToLinear(c)) - c) < 1e-6);
  });
});

describe("relightPixels", () => {
  test("a surface at the centre of the scene facing the light is lit exactly 1.0, wherever the light is", () => {
    // 65 pixels: the middle one is the centre of the scene; depth 0.5 is half the relief, the centre's height.
    const flat = plane(65, 65);
    const centre = (32 * 65 + 32) * 4;
    for (const height of [0.03, 0.25, 2]) {
      const out = relightPixels(flat, light({ height }), false);
      assert.equal(out[centre], 128, `height ${height}: a lighting of exactly 1 gives the photo back`);
    }
  });

  test("on a dome lit from the left, the left side is brighter than the right", () => {
    const shape = dome(SIZE);
    for (const shadows of [false, true]) {
      const out = relightPixels(shape, light({ x: -0.2, y: 0.5, intensity: 1.5, ambient: 0.1 }), shadows);
      const left = mean(out, SIZE, leftHalf);
      const right = mean(out, SIZE, rightHalf);
      assert.ok(left > right + 30, `shadows ${shadows}: left ${left.toFixed(1)}, right ${right.toFixed(1)}`);
    }
  });

  test("moving the light to the other side swaps which side is bright", () => {
    const shape = dome(SIZE);
    const out = relightPixels(shape, light({ x: 1.2, y: 0.5, intensity: 1.5, ambient: 0.1 }), true);
    assert.ok(mean(out, SIZE, rightHalf) > mean(out, SIZE, leftHalf) + 30);
  });

  test("on a flat floor the light falls off with distance", () => {
    const flat = plane(SIZE, SIZE, 0);
    const out = relightPixels(flat, light({ x: 0.1, y: 0.1, height: 0.2, ambient: 0 }), false);
    const under = mean(out, SIZE, (i, j) => i < 10 && j < 10);
    const far = mean(out, SIZE, (i, j) => i > SIZE - 10 && j > SIZE - 10);
    assert.ok(under > far + 40, `under the light ${under.toFixed(1)}, far corner ${far.toFixed(1)}`);
  });

  test("a block casts its shadow away from the light, and only when shadows are on", () => {
    // A low block: the shadow of a tall one counts as one on a far background, and is faded on purpose (SHADOW_FAR_STRENGTH).
    const shape = block(SIZE, 0.375, 0.625, 0.25);
    const key = light({ x: 0.05, y: 0.5, height: 0.03, intensity: 1.5, ambient: 0.1 });
    const lit = relightPixels(shape, key, false);
    const shadowed = relightPixels(shape, key, true);
    assert.ok(mean(shadowed, SIZE, BEHIND) < mean(lit, SIZE, BEHIND) - 12, "the floor behind the block is darker with shadows on");
    assert.ok(Math.abs(mean(shadowed, SIZE, BEFORE) - mean(lit, SIZE, BEFORE)) < 2, "the floor in front of it is not");
  });

  test("with no fill, or a fill of intensity 0, the picture is exactly the key light's", () => {
    const shape = dome(SIZE);
    const key = light({ x: 0.2, y: 0.3, intensity: 1.5, ambient: 0.12 });
    const alone = relightPixels(shape, key, true);
    assert.deepEqual(relightPixels(shape, key, true, null), alone);
    assert.deepEqual(relightPixels(shape, key, true, fill({ intensity: 0 })), alone);
  });

  test("a fill on the right brightens surfaces facing right more than those facing left, and darkens nothing", () => {
    const shape = dome(SIZE);
    const key = light({ x: -0.2, y: 0.5, intensity: 1.2, ambient: 0.05 });
    const without = relightPixels(shape, key, true);
    const withFill = relightPixels(shape, key, true, fill({ x: 1.3, y: 0.5, height: 0.25, intensity: 0.8 }));
    const gain = (inside: (i: number, j: number) => boolean) => mean(withFill, SIZE, inside) - mean(without, SIZE, inside);
    assert.ok(gain(rightHalf) > gain(leftHalf) + 15, `right side +${gain(rightHalf).toFixed(1)}, left side +${gain(leftHalf).toFixed(1)}`);
    for (let p = 0; p < without.length; p++) assert.ok(withFill[p] >= without[p], "a fill never takes light away");
  });

  test("the fill casts no shadow", () => {
    const shape = block(SIZE, 0.375, 0.625, 0.25);
    const low = { x: 0.05, y: 0.5, height: 0.03 };
    // The same light as the key does throw a shadow here, so a shadow from the fill would show.
    assert.notDeepEqual(relightPixels(shape, light({ ...low, intensity: 1 }), true), relightPixels(shape, light({ ...low, intensity: 1 }), false));
    // As the fill, with the key turned off, Cast shadows changes nothing.
    const dark = light({ intensity: 0, ambient: 0 });
    const lowFill = fill({ ...low, intensity: 1 });
    const on = relightPixels(shape, dark, true, lowFill);
    assert.deepEqual(on, relightPixels(shape, dark, false, lowFill));
    assert.ok(mean(on, SIZE, BEHIND) > 40, "the floor behind the block is lit by the fill");
  });

  test("the output is whole: RGBA bytes, alpha 255, nothing black that has light on it, at the far ends of every slider", () => {
    const shape = dome(SIZE);
    const extremes = [
      light({ x: -5, y: 5, height: 0.03, intensity: 4, ambient: 1 }),
      light({ x: 0.5, y: 0.5, height: 2, intensity: 4, ambient: 1, color: [0.7, 0.86, 1] }),
      light({ x: 0.5, y: 0.5, height: 0.0001, intensity: 0, ambient: 0.01 }),
    ];
    for (const key of extremes) {
      for (const shadows of [false, true]) {
        const out = relightPixels(shape, key, shadows, fill({ x: 9, y: -9, height: 2, intensity: 4 }));
        assert.ok(out instanceof Uint8ClampedArray);
        assert.equal(out.length, SIZE * SIZE * 4);
        for (let p = 0; p < out.length; p += 4) {
          assert.equal(out[p + 3], 255);
          // A NaN would come out as 0: with ambient above 0 on a grey photo nothing can be black.
          assert.ok(out[p] > 0 && out[p + 1] > 0 && out[p + 2] > 0, `pixel ${p / 4} is black under ${JSON.stringify(key)}`);
        }
      }
    }
  });

  test("a transparent pixel is laid on white first", () => {
    const flat = plane(65, 65);
    flat.rgba.fill(0); // black, fully transparent
    const out = relightPixels(flat, light(), false);
    // White lit at exactly 1, past the knee: see below.
    assert.equal(out[(32 * 65 + 32) * 4], 247);
  });
});

describe("open sky", () => {
  /** The low block of the shadow test, its floor all open sky (sky 1: the depth PNG's alpha 0), the block not. */
  const blockAgainstSky = () => {
    const shape = block(SIZE, 0.375, 0.625, 0.25);
    shape.sky = Float32Array.from(shape.depth, (near) => (near === 0 ? 1 : 0));
    return shape;
  };
  const key = light({ x: 0.05, y: 0.5, height: 0.03, intensity: 1.5, ambient: 0.1 });

  test("receives no shadow, and is left exactly as the photo has it, whatever the lights", () => {
    const shape = blockAgainstSky();
    const relief = shape.relief;
    const field = shadowHeightField(shape.depth, SIZE, SIZE, SIZE, SIZE, relief, shape.sky);
    const shadow = shadowMap(field, relief, lightPosition(SIZE, SIZE, relief, key));
    // The shadow map is the picture's own size here (64 is under 256).
    for (let p = 0; p < SIZE * SIZE; p++) if (BEHIND(p % SIZE, Math.floor(p / SIZE))) assert.ok(shadow[p] > 0.999, `no shadow behind the block: ${shadow[p]}`);
    const without = shadowMap(shadowHeightField(shape.depth, SIZE, SIZE, SIZE, SIZE, relief), relief, lightPosition(SIZE, SIZE, relief, key));
    assert.ok(without[32 * SIZE + 42] < 0.9, "where the floor is not sky, the block's shadow falls there");
    for (const [k, f] of [[key, null], [light({ x: 0.5, y: 0.5, height: 2, intensity: 4, ambient: 1 }), fill({ x: 1.2, intensity: 4 })]] as const) {
      const out = relightPixels(shape, k, true, f);
      for (let p = 0; p < SIZE * SIZE; p++) if (shape.depth[p] === 0) assert.deepEqual([...out.subarray(p * 4, p * 4 + 4)], [128, 128, 128, 255]);
    }
  });

  test("a depth map whose alpha is 255 everywhere, or a sky of 0 everywhere, shades exactly as before there was sky", () => {
    const shape = block(SIZE, 0.375, 0.625, 0.25);
    const toImage = (bytes: Uint8ClampedArray) => ({ width: SIZE, height: SIZE, data: bytes }) as unknown as ImageData;
    const depthBytes = new Uint8ClampedArray(SIZE * SIZE * 4).map((_, k) => (k % 4 === 3 ? 255 : Math.round(shape.depth[k >> 2] * 255)));
    const normalBytes = new Uint8ClampedArray(SIZE * SIZE * 4).map((_, k) => (k % 4 === 3 ? 255 : k % 4 === 2 ? 255 : 128));
    assert.equal(sceneArrays(toImage(shape.rgba), toImage(depthBytes), toImage(normalBytes), shape.relief).sky, null);
    const zero = { ...shape, sky: new Float32Array(SIZE * SIZE) };
    for (const f of [null, fill({ x: 1.2 })]) {
      for (const cast of [true, false]) assert.deepEqual(relightPixels(zero, key, cast, f), relightPixels(shape, key, cast, f));
    }
  });
});

describe("the highlight knee", () => {
  // A one-pixel scene whose pixel is the centre and faces the light: its lighting is exactly the ambient.
  const lit = (photo: number, amount: number) => relightPixels(plane(1, 1, 0.5, [photo, photo, photo]), light({ intensity: 0, ambient: amount }), false)[0];
  const byHand = (photo: number, amount: number) => {
    let v = srgbToLinear(photo / 255) * amount;
    const k = HIGHLIGHT_KNEE;
    if (v > k) v = k + (1 - k) * (1 - Math.exp(-(v - k) / (1 - k)));
    return Math.floor(Math.min(1, Math.max(0, linearToSrgb(v))) * 255 + 0.5);
  };

  test("below the knee light multiplies the photo; above it the formula rolls it off", () => {
    for (const photo of [30, 128, 200, 255]) for (const amount of [0, 0.5, 1, 1.5, 3, 6]) assert.equal(lit(photo, amount), byHand(photo, amount), `photo ${photo}, light ${amount}`);
  });

  test("white lit at exactly 1 is rolled off to 247, not left at 255", () => {
    assert.equal(lit(255, 1), 247);
    assert.equal(lit(255, HIGHLIGHT_KNEE), byHand(255, HIGHLIGHT_KNEE));
  });

  test("more light never makes a pixel darker, and it reaches white only far past the knee", () => {
    let last = 0;
    for (let amount = 0; amount <= 8; amount += 0.05) {
      const now = lit(200, amount);
      assert.ok(now >= last, `light ${amount.toFixed(2)}: ${now} after ${last}`);
      last = now;
    }
    assert.ok(lit(255, 1.5) < 255);
    assert.equal(lit(255, 8), 255);
  });
});
