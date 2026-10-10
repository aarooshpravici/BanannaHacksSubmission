// Browser-side image plumbing: files, base64 strings, canvases and masks.
// Wire format (see lib/types.ts): raw base64 without a `data:` prefix.

/** Longest side, in pixels, of anything we upload. */
export const MAX_UPLOAD_SIDE = 1536;

export type ImageMime = "image/png" | "image/jpeg";

/** An image ready to send to the API, plus what the UI needs to lay it out. */
export interface LoadedImage {
  base64: string;
  mime: ImageMime;
  width: number;
  height: number;
  name: string;
}

export type BBox = [number, number, number, number];

// --- base64 <-> things ----------------------------------------------------------

export function stripDataUrl(value: string): string {
  return value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
}

/** The API never says which format a base64 image is; the first bytes do. */
export function sniffMime(base64: string): string {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
}

/** base64 -> something an <img src> accepts. Passes existing data: URLs through. */
export function toDataUrl(base64: string): string {
  return base64.startsWith("data:") ? base64 : `data:${sniffMime(base64)};base64,${base64}`;
}

export function base64ToBlob(base64: string): Blob {
  const raw = stripDataUrl(base64);
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: sniffMime(raw) });
}

/** base64 -> object URL. The caller owns it: URL.revokeObjectURL when done. */
export function base64ToObjectUrl(base64: string): string {
  return URL.createObjectURL(base64ToBlob(base64));
}

// --- canvases -------------------------------------------------------------------

export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function ctx2d(canvas: HTMLCanvasElement, willReadFrequently = false): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently });
  if (!ctx) throw new Error("This browser could not create a 2D canvas.");
  return ctx;
}

export function canvasToBase64(canvas: HTMLCanvasElement, mime: ImageMime = "image/png", quality = 0.92): string {
  return stripDataUrl(canvas.toDataURL(mime, quality));
}

/**
 * Decode a base64 image.
 * `raw` skips colour management and alpha premultiplication, which is what data
 * textures (depth, normals) need: the bytes must reach the shader untouched.
 */
export async function base64ToBitmap(base64: string, raw = false): Promise<ImageBitmap> {
  const blob = base64ToBlob(base64);
  try {
    return await createImageBitmap(
      blob,
      raw ? { colorSpaceConversion: "none", premultiplyAlpha: "none" } : undefined,
    );
  } catch {
    throw new Error("Could not decode an image returned by the server.");
  }
}

export async function base64ToCanvas(base64: string, raw = false): Promise<HTMLCanvasElement> {
  const bitmap = await base64ToBitmap(base64, raw);
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  ctx2d(canvas).drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

// --- files ----------------------------------------------------------------------

async function decodeFile(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    // Applies the EXIF orientation, so phone photos come out upright.
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Formats createImageBitmap refuses (some SVGs) still load through <img>.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await img.decode();
      return img;
    } catch {
      throw new Error("That file is not an image this browser can read.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * File (or pasted/dropped blob) -> base64, downscaled so the longest side is at
 * most `maxSide`. Photos (JPEG in) stay JPEG to keep uploads small; everything
 * else becomes PNG so transparency and flat design colours survive.
 */
export async function fileToImage(
  file: Blob,
  options: { maxSide?: number; format?: "auto" | "png" | "jpeg" } = {},
): Promise<LoadedImage> {
  const { maxSide = MAX_UPLOAD_SIDE, format = "auto" } = options;
  const source = await decodeFile(file);
  const sw = "naturalWidth" in source ? source.naturalWidth : source.width;
  const sh = "naturalHeight" in source ? source.naturalHeight : source.height;
  if (!sw || !sh) throw new Error("That image has no size.");

  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = makeCanvas(sw * scale, sh * scale);
  const ctx = ctx2d(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if ("close" in source) source.close();

  const mime: ImageMime =
    format === "png" ? "image/png" : format === "jpeg" || file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  return {
    base64: canvasToBase64(canvas, mime),
    mime,
    width: canvas.width,
    height: canvas.height,
    name: file instanceof File ? file.name : "pasted image",
  };
}

export function canvasToImage(canvas: HTMLCanvasElement, name: string, mime: ImageMime = "image/png"): LoadedImage {
  return { base64: canvasToBase64(canvas, mime), mime, width: canvas.width, height: canvas.height, name };
}

// --- masks ----------------------------------------------------------------------

/**
 * A drawing canvas (anything painted = selected, at any resolution) -> the mask
 * the API wants: an opaque PNG exactly `width` x `height`, white = selected.
 * Returns null when nothing is painted.
 */
export function canvasToMask(source: HTMLCanvasElement, width: number, height: number): { mask: string; bbox: BBox } | null {
  const out = makeCanvas(width, height);
  const ctx = ctx2d(out, true);
  ctx.drawImage(source, 0, 0, out.width, out.height);
  const pixels = ctx.getImageData(0, 0, out.width, out.height);
  const data = pixels.data;
  let minX = out.width, minY = out.height, maxX = -1, maxY = -1;
  for (let y = 0, i = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++, i += 4) {
      const on = data[i + 3] > 127;
      const v = on ? 255 : 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
      if (on) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  ctx.putImageData(pixels, 0, 0);
  return { mask: canvasToBase64(out), bbox: [minX, minY, maxX - minX + 1, maxY - minY + 1] };
}

/** A rectangle, in image pixels -> mask PNG base64. */
export function rectToMask(bbox: BBox, width: number, height: number): string {
  const canvas = makeCanvas(width, height);
  const ctx = ctx2d(canvas);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(bbox[0], bbox[1], bbox[2], bbox[3]);
  return canvasToBase64(canvas);
}

/**
 * Mask PNG (white = selected) -> a canvas whose alpha channel is the mask and
 * whose colour is `rgb`. Used to tint the selection on screen and, in the mock
 * layer, to cut generated content to the mask.
 */
export async function maskToAlphaCanvas(
  mask: string,
  width: number,
  height: number,
  rgb: [number, number, number] = [255, 255, 255],
): Promise<HTMLCanvasElement> {
  const bitmap = await base64ToBitmap(mask, true);
  const canvas = makeCanvas(width, height);
  const ctx = ctx2d(canvas, true);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    // A mask may also arrive as "painted on transparent": then alpha is the mask.
    const luminance = data[i + 3] < 255 ? data[i + 3] : data[i];
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = luminance;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

// --- downloads ------------------------------------------------------------------

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  // Give the browser a moment to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadBase64(base64: string, filename: string): void {
  downloadBlob(base64ToBlob(base64), filename);
}

/** Download any base64 image as a PNG, converting if the server sent a JPEG. */
export async function downloadBase64AsPng(base64: string, filename: string): Promise<void> {
  if (sniffMime(stripDataUrl(base64)) === "image/png") return downloadBase64(base64, filename);
  await downloadCanvas(await base64ToCanvas(base64), filename);
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("Could not export the canvas."));
      downloadBlob(blob, filename);
      resolve();
    }, "image/png");
  });
}
