// The CPU port (lib/relightMath.ts) against the Python reference
// (backend/app/ideas/relight.py): the four samples, made smaller, under ten
// lights, rendered by the Python ahead of time into tests/fixtures/relight/.
// Every channel of every pixel must be within MAX_LEVELS of the Python's.
//
// After an intentional change to the maths, change both versions (and the
// shader in lib/relightGL.ts), then make the pictures again and commit them
// with the change:
//   cd backend && MOCK_MODE=1 .venv/bin/python -m scripts.relight_fixtures
// That script's docstring says what the fixtures are and how they were shrunk.
// If this fails and nobody meant to change the maths, the two have drifted.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CpuScene } from "../lib/relightCpuCore";
import { relightPixels, sceneArrays } from "../lib/relightMath";
import type { FillLight, Light } from "../lib/types";
import { type Picture, readPng } from "./png";

/** The most any channel may differ, in levels of 255. Rounding in float32 against float64 accounts for 1. */
const MAX_LEVELS = 2;

const FIXTURES = join(import.meta.dirname, "fixtures", "relight");

interface Case {
  light: Light;
  shadows: boolean;
  fill: FillLight | null;
}

interface Scene {
  name: string;
  width: number;
  height: number;
  relief: number;
  cases: string[];
}

const { cases, scenes } = JSON.parse(readFileSync(join(FIXTURES, "cases.json"), "utf8")) as { cases: Record<string, Case>; scenes: Scene[] };

const asImage = (picture: Picture) => picture as unknown as ImageData;

/** The largest difference over the three colour channels, and how many pixels differ at all. */
function compare(ours: Uint8ClampedArray, theirs: Uint8ClampedArray) {
  let worst = 0;
  let at = -1;
  let differ = 0;
  for (let p = 0; p < ours.length; p += 4) {
    let pixel = 0;
    for (let c = 0; c < 3; c++) pixel = Math.max(pixel, Math.abs(ours[p + c] - theirs[p + c]));
    if (pixel > 0) differ++;
    if (pixel > worst) {
      worst = pixel;
      at = p / 4;
    }
  }
  return { worst, at, differ };
}

test("the fixtures are there: every sample, small and large", () => {
  assert.equal(scenes.length, 8);
  assert.ok(Object.keys(cases).length >= 10);
});

for (const scene of scenes) {
  test(`relightMath agrees with relight.py: ${scene.name} (${scene.width} x ${scene.height})`, () => {
    const read = (file: string) => readPng(join(FIXTURES, scene.name, file));
    const photo = read("photo.png");
    const depth = read("depth.png");
    const normals = read("normals.png");
    assert.equal(photo.width, scene.width);
    assert.equal(photo.height, scene.height);
    const arrays = sceneArrays(asImage(photo), asImage(depth), asImage(normals), scene.relief);
    // The renderer the page runs on the processor: it keeps the shadow map between frames, so it is asked for the lights in turn on one scene.
    const core = new CpuScene({ width: scene.width, height: scene.height, relief: scene.relief, image: photo, depth, normals, preview: { image: photo, depth, normals } });
    const failures: string[] = [];
    for (const name of scene.cases) {
      const { light, shadows, fill } = cases[name];
      const ours = relightPixels(arrays, light, shadows, fill);
      const expected = read(`${name}.png`);
      const { worst, at, differ } = compare(ours, expected.data);
      if (worst > MAX_LEVELS) {
        failures.push(`${name}: ${worst} levels off at x ${at % scene.width}, y ${Math.floor(at / scene.width)} (${differ} of ${scene.width * scene.height} pixels differ)`);
      }
      // CpuScene's full quality is relightPixels exactly, shadow map kept or not.
      const frame = core.render(light, shadows, "full", fill);
      assert.deepEqual(frame.pixels, ours, `${name}: CpuScene's full-quality frame is not relightPixels'`);
    }
    assert.deepEqual(failures, [], `relightMath.ts and relight.py disagree by more than ${MAX_LEVELS} levels:\n${failures.join("\n")}`);
  });
}
