// HEIC and HEIF photos: telling one from other files, and decoding it where the
// browser cannot (lib/heic.worker.js). An iPhone saves photos this way, and
// AirDrop to a Mac delivers them unchanged, as .heic files.

/** What the page sends the Worker. */
export interface HeicRequest {
  /** The file, whole. */
  bytes: ArrayBuffer;
  /** The longest side the page wants back, in pixels. */
  maxSide: number;
}

/** What the Worker answers: the picture, already shrunk; or its pixels at full size, where it could not shrink them; or why not. */
export type HeicReply =
  | { type: "bitmap"; bitmap: ImageBitmap }
  | { type: "pixels"; width: number; height: number; pixels: Uint8ClampedArray<ArrayBuffer> }
  | { type: "error"; stage: "library" | "decode" | "size"; message: string };

/**
 * How long a conversion may take, in milliseconds, before the page gives up.
 * A 12-megapixel photo takes a second or two, plus a 2 MB download the first
 * time; a minute covers a slow phone on a slow connection, and anything longer
 * is a download that has stalled.
 */
const HEIC_TIMEOUT_MS = 60_000;

/** On the drop box while a photo is being converted. */
export const HEIC_BUSY_TEXT = "Converting your photo…";
const HEIC_JPEG_ADVICE = "Export it as a JPEG (on a Mac: open it in Preview, then File, Export) and use that.";
const HEIC_FAILED = `This HEIC photo could not be converted. ${HEIC_JPEG_ADVICE}`;
const HEIC_NO_DECODER = `This is a HEIC photo, which this browser cannot read by itself, and the converter for it could not be downloaded from cdn.jsdelivr.net. Check the connection and try again, or export the photo as a JPEG and use that.`;

/** The "brands" a HEIC or HEIF file names in its first bytes. AVIF files have the same layout and other brands; browsers read those themselves. */
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"]);
/** How many bytes of the file are read to find its brands: the box that lists them is the first in the file and well under this. */
const SIGNATURE_BYTES = 64;

/**
 * Whether a file is a HEIC or HEIF photo: by its type, by its name, or by its
 * first bytes. A browser that cannot decode the format often gives such a file
 * no type at all, and a pasted or renamed one may have no useful name either.
 */
export async function isHeic(file: Blob): Promise<boolean> {
  if (/^image\/hei[cf](-sequence)?$/i.test(file.type)) return true;
  if (file instanceof File && /\.hei[cf]s?$/i.test(file.name)) return true;
  try {
    const head = new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer());
    const text = String.fromCharCode(...head);
    // Bytes 4 to 8 say "ftyp"; the main brand follows, then a version number, then the compatible brands, four letters each.
    if (text.slice(4, 8) !== "ftyp") return false;
    // The box's own length, from its first four bytes, is where the list ends.
    const end = Math.min(head.length, ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0);
    const brands: string[] = [];
    for (let at = 8; at + 4 <= end; at += 4) if (at !== 12) brands.push(text.slice(at, at + 4));
    // An AVIF file often lists the general "mif1" too. Browsers read AVIF themselves.
    return !brands.some((brand) => brand === "avif" || brand === "avis") && brands.some((brand) => HEIC_BRANDS.has(brand));
  } catch {
    // An unreadable file is not one: the ordinary path reports it.
  }
  return false;
}

/**
 * A HEIC or HEIF file -> its main picture, upright and no larger than `maxSide`
 * on its long side. For the browsers that cannot decode the format themselves.
 * Rejects with a sentence for the page.
 */
export async function decodeHeic(file: Blob, maxSide: number): Promise<ImageBitmap | HTMLCanvasElement> {
  const bytes = await file.arrayBuffer();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./heic.worker.js", import.meta.url));
  } catch (error) {
    console.warn("Relight: the HEIC Worker could not be started.", error);
    throw new Error(HEIC_FAILED);
  }
  try {
    const reply = await new Promise<HeicReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(HEIC_NO_DECODER)), HEIC_TIMEOUT_MS);
      worker.onmessage = (event: MessageEvent<HeicReply>) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        clearTimeout(timer);
        console.warn("Relight: the HEIC Worker failed.", event.message);
        reject(new Error(HEIC_FAILED));
      };
      const request: HeicRequest = { bytes, maxSide };
      worker.postMessage(request, [bytes]);
    });
    if (reply.type === "bitmap") return reply.bitmap;
    if (reply.type === "pixels") {
      const canvas = document.createElement("canvas");
      canvas.width = reply.width;
      canvas.height = reply.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(HEIC_FAILED);
      ctx.putImageData(new ImageData(reply.pixels, reply.width, reply.height), 0, 0);
      return canvas;
    }
    if (reply.stage === "library") throw new Error(HEIC_NO_DECODER);
    if (reply.stage === "size") throw new Error(`This HEIC photo is too large to convert in a browser (${reply.message} pixels). ${HEIC_JPEG_ADVICE}`);
    throw new Error(HEIC_FAILED);
  } finally {
    // Ending the Worker is what frees the decoder's memory. The browser keeps the downloaded file, so the next photo does not fetch it again.
    worker.terminate();
  }
}
