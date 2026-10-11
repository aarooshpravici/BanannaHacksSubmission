// A check the graphics chip has to pass before the depth model is trusted with
// a photo on it, in the spirit of the shader's self-test in lib/relightGL.ts.
//
// Some graphics drivers run the model without any error and get it wrong: on a
// Snapdragon X laptop (Adreno X1-85) the depth came back covered in a fine
// regular grid of bumps, one per 14-pixel patch of the model, and the normals
// turned every surface into hammered metal. So lib/depth.worker.js first runs
// the model on a small picture built here and compares the result with the
// answer the processor gives for the same picture (lib/depthCheckReference.ts).
//
// No DOM in here: it runs in a Worker.

import { CHECK_REFERENCE, CHECK_REFERENCE_ROUGHNESS } from "./depthCheckReference";
import { nearness } from "./sceneGeometry";

/** Side of the test picture, in pixels: the size the model sees a square photo at, so the check runs exactly what a photo will. */
export const CHECK_SIDE = 518;
/** The model reads the picture in patches this many pixels wide: the grid a faulty chip's noise sits on. */
const PATCH = 14;
/** The reference answer is one number per patch. */
const CELLS = CHECK_SIDE / PATCH;

/** What the model's own preprocessing does to a photo's colours (the ImageNet mean and spread). */
const MEAN = [0.485, 0.456, 0.406];
const SPREAD = [0.229, 0.224, 0.225];

/**
 * How far apart the three samples of a second difference are, in pixels. Half a
 * patch answers most strongly to one bump per patch and to patches that differ
 * from their neighbours; the second, shorter step catches a pattern that
 * repeats twice per patch, which half a patch steps over. Shorter steps were
 * tried and left out: a healthy graphics chip's own fine grain (its 16-bit
 * maths) is strongest at 1 to 3 pixels and would hide the fault being looked for.
 */
const ROUGHNESS_STEPS = [5, 7];
/**
 * A patch counts as flat when the reference bends by no more than this there and
 * in the patches round it (second difference from patch to patch, with the
 * reference's range as 1000). Lower leaves too few patches to measure; higher
 * lets the edges of the shapes in, whose roughness would drown the noise.
 */
const FLAT_BEND = 12;

/**
 * The lowest agreement (correlation, patch by patch) with the reference that
 * passes, and the highest roughness of the flat areas, as a multiple of the
 * reference's own. Measured in Chrome 155 on an Apple-chip laptop:
 *                                              agreement   roughness
 *   processor, 9 runs (all alike)              1.000000      1.00
 *   graphics chip, 16 runs (all alike)         0.999930      3.27
 *   the same with patches lifted and dropped
 *   at random by 0.1% of the depth's range     0.99993       4.9   (normals tilt 0.7 degrees: not seen)
 *   by 0.2%                                    0.99993       7.1   (1.3 degrees: just seen on a plain wall)
 *   by 1%                                      0.99977      26.6   (5.7 degrees: plainly dimpled)
 *   by 5%                                      0.99607     111     (19 degrees: hammered metal)
 * A healthy chip is already three times rougher than the processor, from its
 * 16-bit maths, so the roughness limit sits a little under twice that. Lower
 * and a working chip of another make may be turned away to the processor,
 * twenty times slower; higher and faint dimples get through. The agreement
 * hardly moves under grid noise: its limit is for an answer that is plain wrong.
 */
export const CHECK_MIN_AGREEMENT = 0.99;
export const CHECK_MAX_ROUGHNESS = 6;

/**
 * The test picture, as the model takes it (three colour planes, values already
 * shifted and scaled): a wall and a floor, with a ball, a box and a post at
 * different distances. The wall, the floor and the faces of the shapes are
 * large and plain, which is where a grid of noise stands out.
 */
export function checkPicture(): Float32Array<ArrayBuffer> {
  const n = CHECK_SIDE;
  const out = new Float32Array(3 * n * n);
  const horizon = 0.58;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n;
      const y = (j + 0.5) / n;
      let rgb: number[];
      let shade: number;
      const ballX = (x - 0.3) / 0.2;
      const ballY = (y - 0.66) / 0.2;
      const ball = ballX * ballX + ballY * ballY;
      if (x > 0.47 && x < 0.56 && y > 0.42) {
        // The post, nearest: round, so lighter on its lit side.
        rgb = [0.9, 0.84, 0.4];
        shade = 1 - 0.55 * ((x - 0.47) / 0.09);
      } else if (ball < 1) {
        // The ball, lit from the upper left.
        const towards = Math.sqrt(1 - ball);
        rgb = [0.86, 0.3, 0.2];
        shade = 0.25 + 0.75 * Math.max(0, 0.6 * towards - 0.5 * ballX - 0.6 * ballY);
      } else if (x > 0.62 && x < 0.9 && y > 0.3 && y < 0.68) {
        // The box, furthest, against the wall: a lit front and a dark side.
        rgb = [0.25, 0.5, 0.36];
        shade = x > 0.83 ? 0.55 : 1;
      } else if (y < horizon) {
        rgb = [0.62, 0.68, 0.76];
        shade = 0.82 + 0.18 * (y / horizon);
      } else {
        // The floor, lighter towards the viewer, with the ball's shadow on it.
        const near = (y - horizon) / (1 - horizon);
        const shadowX = (x - 0.38) / 0.22;
        const shadowY = (y - 0.87) / 0.035;
        rgb = [0.56, 0.46, 0.37];
        shade = (0.7 + 0.5 * near) * (shadowX * shadowX + shadowY * shadowY < 1 ? 0.6 : 1);
      }
      for (let c = 0; c < 3; c++) out[c * n * n + j * n + i] = (Math.min(1, rgb[c] * shade) - MEAN[c]) / SPREAD[c];
    }
  }
  return out;
}

/** The model's answer for the test picture, one mean per patch: what the reference stores. */
export function checkCells(raw: Float32Array): Float32Array {
  const cells = new Float32Array(CELLS * CELLS);
  for (let j = 0; j < CHECK_SIDE; j++) {
    const row = Math.floor(j / PATCH) * CELLS;
    for (let i = 0; i < CHECK_SIDE; i++) cells[row + Math.floor(i / PATCH)] += raw[j * CHECK_SIDE + i];
  }
  for (let c = 0; c < cells.length; c++) cells[c] /= PATCH * PATCH;
  return cells;
}

/** Which patches are flat in the reference: little bend there and in the eight patches round it. Never the outermost ring. */
function flatCells(): Uint8Array {
  const bend = new Float32Array(CELLS * CELLS).fill(Infinity);
  for (let j = 1; j < CELLS - 1; j++) {
    for (let i = 1; i < CELLS - 1; i++) {
      const c = j * CELLS + i;
      const here = 2 * CHECK_REFERENCE[c];
      bend[c] = Math.max(Math.abs(CHECK_REFERENCE[c - 1] + CHECK_REFERENCE[c + 1] - here), Math.abs(CHECK_REFERENCE[c - CELLS] + CHECK_REFERENCE[c + CELLS] - here));
    }
  }
  const flat = new Uint8Array(CELLS * CELLS);
  for (let j = 1; j < CELLS - 1; j++) {
    for (let i = 1; i < CELLS - 1; i++) {
      let worst = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) worst = Math.max(worst, bend[(j + dj) * CELLS + i + di]);
      flat[j * CELLS + i] = worst <= FLAT_BEND ? 1 : 0;
    }
  }
  return flat;
}

/**
 * How rough the flat areas of the model's answer are: the mean absolute second
 * difference, across and down, of the depth stretched to 0..1 as a photo's is.
 * A smooth surface gives nearly nothing, however it slopes; a grid of bumps of
 * height h gives about 2 h.
 */
export function flatRoughness(raw: Float32Array): number {
  const n = CHECK_SIDE;
  const z = nearness(raw);
  const flat = flatCells();
  let sum = 0;
  let count = 0;
  for (let j = 0; j < n; j++) {
    const row = Math.floor(j / PATCH) * CELLS;
    for (let i = 0; i < n; i++) {
      if (!flat[row + Math.floor(i / PATCH)]) continue;
      const p = j * n + i;
      for (const step of ROUGHNESS_STEPS) {
        sum += Math.abs(z[p - step] + z[p + step] - 2 * z[p]) + Math.abs(z[p - step * n] + z[p + step * n] - 2 * z[p]);
        count += 2;
      }
    }
  }
  return sum / count;
}

export interface CheckScores {
  /** Correlation with the reference, patch by patch: 1 is the same shape. */
  agreement: number;
  /** Roughness of the flat areas, as a multiple of the reference's: 1 is as smooth as the processor's answer. */
  roughness: number;
}

/** Compare the model's answer for the test picture (CHECK_SIDE x CHECK_SIDE values) with the reference. */
export function checkScores(raw: Float32Array): CheckScores {
  const cells = checkCells(raw);
  let meanA = 0;
  let meanB = 0;
  for (let c = 0; c < cells.length; c++) {
    meanA += cells[c] / cells.length;
    meanB += CHECK_REFERENCE[c] / cells.length;
  }
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let c = 0; c < cells.length; c++) {
    const a = cells[c] - meanA;
    const b = CHECK_REFERENCE[c] - meanB;
    ab += a * b;
    aa += a * a;
    bb += b * b;
  }
  return { agreement: ab / Math.sqrt(aa * bb), roughness: flatRoughness(raw) / CHECK_REFERENCE_ROUGHNESS };
}

/** Written this way round so that a score that is not a number fails. */
export const checkPasses = (scores: CheckScores) => scores.agreement >= CHECK_MIN_AGREEMENT && scores.roughness <= CHECK_MAX_ROUGHNESS;
