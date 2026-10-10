// A sample photo drawn on a canvas, so the page can be tried without hunting
// for a file. It is deliberately flat-shaded: the lighting is what the app adds.

import { type LoadedImage, canvasToImage, ctx2d, makeCanvas } from "./image";

/** A matte ball on a studio backdrop: something with obvious form to light. */
export function sampleRelightPhoto(): LoadedImage {
  const w = 960, h = 720;
  const canvas = makeCanvas(w, h);
  const ctx = ctx2d(canvas);
  ctx.fillStyle = "#8fa3ad";
  ctx.fillRect(0, 0, w, h);
  // Backdrop panels, so light falloff across the wall is easy to see.
  ctx.fillStyle = "#9db1ba";
  for (let i = 0; i < 6; i++) ctx.fillRect(i * 160 + 6, 0, 148, h);
  ctx.fillStyle = "#7d8f99";
  ctx.fillRect(0, h * 0.82, w, h * 0.18);

  const cx = w / 2, cy = h / 2, r = 0.38 * h;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = "#e9785b";
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.fillStyle = "#f4d35e";
  ctx.fillRect(cx - r, cy - r * 0.22, r * 2, r * 0.3);
  ctx.fillStyle = "#2f4858";
  ctx.fillRect(cx - r, cy + r * 0.16, r * 2, r * 0.1);
  ctx.fillStyle = "#fff4e0";
  for (let i = 0; i < 7; i++) {
    ctx.beginPath();
    ctx.arc(cx - r + (i + 0.5) * ((r * 2) / 7), cy - r * 0.52, r * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  return canvasToImage(canvas, "sample-ball.png");
}
