/** Numbers the Relight page's light is made of, and the small sums done on them. No React: the page, its sun and the Sweep share these. */

/** Height: how far in front of the subject the light floats, in image widths. The slider's two ends. */
export const HEIGHT_MIN = 0.03;
export const HEIGHT_MAX = 2;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const round = (v: number, digits = 3) => Number(v.toFixed(digits));
/** Height: 0 at the slider's low end, 1 at its high end, in equal ratios between. */
export const heightShare = (height: number) => clamp(Math.log(height / HEIGHT_MIN) / Math.log(HEIGHT_MAX / HEIGHT_MIN), 0, 1);
export const between = ([low, high]: number[], t: number) => low + (high - low) * t;

export const WARM: [number, number, number] = [1.0, 0.86, 0.68];
export const COOL: [number, number, number] = [0.7, 0.86, 1.0];

/** -1 = cool, 0 = white, 1 = warm -> the light's colour multiplier. */
export function warmthToColor(warmth: number): [number, number, number] {
  const target = warmth >= 0 ? WARM : COOL;
  const t = Math.abs(warmth);
  return [round(1 + (target[0] - 1) * t), round(1 + (target[1] - 1) * t), round(1 + (target[2] - 1) * t)];
}

export const cssColor = (c: [number, number, number]) => `rgb(${c.map((v) => Math.round(clamp(v, 0, 1) * 255)).join(" ")})`;
