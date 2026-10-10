// Sample inputs drawn on a canvas, so each page can be tried without hunting
// for a file. They are deliberately flat-shaded: the lighting, fill and views
// are what the app adds.

import { type LoadedImage, canvasToImage, ctx2d, makeCanvas } from "./image";

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

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

/** A poster with two obvious holes in the layout (upper right, lower left). */
export function sampleDesign(): LoadedImage {
  const w = 1200, h = 800;
  const canvas = makeCanvas(w, h);
  const ctx = ctx2d(canvas);
  ctx.fillStyle = "#14213d";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#1b2b4d";
  ctx.fillRect(0, 0, w, 56);

  ctx.textBaseline = "top";
  ctx.fillStyle = "#fca311";
  ctx.font = "600 20px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.fillText("OPEN AIR  /  THREE NIGHTS  /  ONE STAGE", 84, 18);

  ctx.fillStyle = "#ffffff";
  ctx.font = "800 104px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.fillText("Summer", 80, 104);
  ctx.fillText("Sound", 80, 208);
  ctx.fillStyle = "#fca311";
  ctx.fillText("Festival", 80, 312);

  ctx.fillStyle = "#e5e5e5";
  ctx.font = "500 26px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.fillText("July 18 to 20, Riverside Park", 84, 446);

  // Line-up cards, lower right.
  const cards: [string, string, string][] = [
    ["#fca311", "FRI", "Night Owls"],
    ["#e5e5e5", "SAT", "Paper Kites"],
    ["#5bc0be", "SUN", "Low Tide"],
  ];
  cards.forEach(([color, day, act], i) => {
    const x = 672 + i * 150, y = 430;
    ctx.fillStyle = color;
    roundRect(ctx, x, y, 134, 290, 18);
    ctx.fillStyle = "#14213d";
    ctx.font = "800 34px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillText(day, x + 18, y + 22);
    ctx.font = "600 17px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillText(act, x + 18, y + 248);
    ctx.beginPath();
    ctx.arc(x + 67, y + 150, 38, 0, Math.PI * 2);
    ctx.fill();
  });
  return canvasToImage(canvas, "sample-poster.png");
}

/** A front-facing cartoon character on a transparent background, with asymmetric props. */
export function sampleCharacter(): LoadedImage {
  const w = 640, h = 896;
  const canvas = makeCanvas(w, h);
  const ctx = ctx2d(canvas);
  const cx = w / 2;

  // Backpack, peeking out on one side.
  ctx.fillStyle = "#3d5a80";
  roundRect(ctx, cx + 70, 360, 96, 190, 28);
  // Legs and boots.
  ctx.fillStyle = "#293241";
  roundRect(ctx, cx - 82, 600, 62, 190, 20);
  roundRect(ctx, cx + 20, 600, 62, 190, 20);
  ctx.fillStyle = "#ee6c4d";
  roundRect(ctx, cx - 100, 760, 92, 58, 22);
  roundRect(ctx, cx + 8, 760, 92, 58, 22);
  // Arms.
  ctx.fillStyle = "#f2c9a0";
  roundRect(ctx, cx - 168, 380, 52, 190, 26);
  roundRect(ctx, cx + 116, 380, 52, 190, 26);
  // Body.
  ctx.fillStyle = "#98c1d9";
  roundRect(ctx, cx - 124, 340, 248, 290, 56);
  // Chest emblem, off-centre.
  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.arc(cx - 52, 440, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#293241";
  ctx.beginPath();
  ctx.arc(cx - 52, 440, 12, 0, Math.PI * 2);
  ctx.fill();
  // Scarf, trailing to one side.
  ctx.fillStyle = "#ee6c4d";
  roundRect(ctx, cx - 116, 314, 232, 50, 24);
  roundRect(ctx, cx + 60, 330, 44, 150, 18);
  // Head.
  ctx.fillStyle = "#f2c9a0";
  ctx.beginPath();
  ctx.arc(cx, 208, 128, 0, Math.PI * 2);
  ctx.fill();
  // Hair, swept to one side.
  ctx.fillStyle = "#293241";
  ctx.beginPath();
  ctx.arc(cx, 190, 134, Math.PI * 1.02, Math.PI * 1.98);
  ctx.quadraticCurveTo(cx + 40, 150, cx - 10, 132);
  ctx.quadraticCurveTo(cx - 90, 120, cx - 134, 186);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + 96, 96);
  ctx.quadraticCurveTo(cx + 190, 40, cx + 170, 150);
  ctx.quadraticCurveTo(cx + 150, 120, cx + 96, 96);
  ctx.fill();
  // Face.
  ctx.fillStyle = "#293241";
  ctx.beginPath();
  ctx.arc(cx - 46, 226, 13, 0, Math.PI * 2);
  ctx.arc(cx + 46, 226, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#293241";
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, 262, 30, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
  return canvasToImage(canvas, "sample-character.png");
}
