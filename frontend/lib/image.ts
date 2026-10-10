// Browser-side image plumbing: files, base64 strings and canvases.
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
