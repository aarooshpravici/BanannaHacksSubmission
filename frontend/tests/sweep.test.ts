// lib/sweep.ts and lib/lightValues.ts: the Sweep's path and timing, and the
// small sums the light's controls are made of.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HEIGHT_MAX, HEIGHT_MIN, WARM, heightShare, warmthToColor } from "../lib/lightValues";
import { SWEEP_CENTRE, SWEEP_RADIUS, SWEEP_STEPS, sweepLoop, sweepPoint, sweepProgress } from "../lib/sweep";

const close = (actual: number, expected: number, within: number, what: string) => assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual}, expected ${expected} (within ${within})`);

describe("sweepPoint", () => {
  const from = { x: 0.12, y: 0.35 };

  test("starts and ends at the user's own light, so nothing jumps", () => {
    assert.deepEqual(sweepPoint(from, 0), from);
    const end = sweepPoint(from, 1);
    close(end.x, from.x, 1e-12, "x at the end");
    close(end.y, from.y, 1e-12, "y at the end");
  });

  test("is on the orbit halfway round, opposite where it started", () => {
    const half = sweepPoint(from, 0.5);
    close(Math.hypot(half.x - SWEEP_CENTRE.x, half.y - SWEEP_CENTRE.y), SWEEP_RADIUS, 1e-12, "distance from the centre");
    // Started left of the middle, so halfway round it is right of it.
    assert.ok(half.x > SWEEP_CENTRE.x);
  });
});

describe("sweepLoop", () => {
  test("measures the distance travelled, never going back", () => {
    const { points, travelled } = sweepLoop({ x: 0.12, y: 0.35 }, 1.5);
    assert.equal(points.length, SWEEP_STEPS + 1);
    assert.equal(travelled[0], 0);
    for (let i = 1; i < travelled.length; i++) assert.ok(travelled[i] >= travelled[i - 1], `step ${i}`);
    // Round an orbit of radius 0.5, stretched 1.5 times across: more than the plain circle, less than its box.
    assert.ok(travelled[SWEEP_STEPS] > 2 * Math.PI * SWEEP_RADIUS);
  });
});

describe("sweepProgress", () => {
  test("runs from 0 to 1 without a jump or a step back", () => {
    assert.equal(sweepProgress(0), 0);
    close(sweepProgress(1), 1, 1e-12, "at the end");
    let last = 0;
    for (let i = 1; i <= 1000; i++) {
      const now = sweepProgress(i / 1000);
      assert.ok(now >= last, `at ${i / 1000}`);
      assert.ok(now - last < 0.0015, `jump at ${i / 1000}: ${now - last}`);
      last = now;
    }
  });
});

describe("lightValues", () => {
  test("heightShare is 0 and 1 at the slider's ends, and a third of the way up at the starting Height", () => {
    assert.equal(heightShare(HEIGHT_MIN), 0);
    assert.equal(heightShare(HEIGHT_MAX), 1);
    close(heightShare(0.12), 1 / 3, 0.005, "Height 0.12");
  });

  test("warmthToColor is white at 0 and the warm colour at 1", () => {
    assert.deepEqual(warmthToColor(0), [1, 1, 1]);
    assert.deepEqual(warmthToColor(1), WARM);
  });
});
