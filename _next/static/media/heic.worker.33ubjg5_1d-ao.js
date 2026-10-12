// HEIC and HEIF photos (what an iPhone saves and AirDrop delivers), decoded in
// the browsers that cannot read them: Chrome, Edge and Firefox. Safari can, and
// never gets here (lib/heic.ts tries the browser's own decoder first).
//
// In a Worker so the page stays smooth during the second or two a 12-megapixel
// photo takes, and so that ending the Worker hands back everything the decoder
// held: its memory only ever grows, and one such photo takes it past 150 MB.
//
// Plain JavaScript for the same reason as lib/relightCpu.worker.js: the bundler
// copies this file as it stands into the build folder.

/**
 * The decoder: libheif with the libde265 HEVC decoder, built to WebAssembly and
 * published as the npm package libheif-js (LGPL-3.0). It is 2 MB and only a few
 * visitors need it, so it is not part of this site at all: it is fetched from
 * jsDelivr when the first such photo arrives, and the browser keeps it.
 * One exact version, with its fingerprint: the browser refuses the file if a
 * single byte of it differs from the copy that was tested.
 */
const DECODER_URL = "https://cdn.jsdelivr.net/npm/libheif-js@1.23.5/libheif-wasm/libheif-bundle.js";
const DECODER_SHA384 = "sha384-QYMUACFeOR9DQlmZGsI+VXolKAMA0hYyiOXLSyd8o5rgrg9L+aKyRZCiiY7RNhPF";

/**
 * The largest photo that is decoded, in pixels. Decoded, a photo takes 4 bytes
 * a pixel here and about as much again inside the decoder: 64 million pixels
 * (five times an iPhone's 12) is about half a gigabyte, which a laptop has to
 * spare and a phone may not. Larger files are refused with a message.
 */
const MAX_PIXELS = 64_000_000;

/** @param {import("./heic").HeicReply} reply @param {Transferable[]} [transfer] */
const post = (reply, transfer = []) => self.postMessage(reply, { transfer });

/** The decoder, once it is loaded. */
/** @type {any} */
let libheif = null;

async function loadDecoder() {
  if (libheif) return libheif;
  const response = await fetch(DECODER_URL, { integrity: DECODER_SHA384, credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(`the download answered ${response.status}`);
  // The file is a plain script that leaves a function named libheif behind. Run this way it works in every kind of Worker.
  const factory = new Function(`${await response.text()}\n;return libheif;`)();
  libheif = factory();
  return libheif;
}

/**
 * Refuses a file that stops before its own contents do, as an interrupted
 * AirDrop or download leaves it. A HEIC file is a row of boxes, each starting
 * with its length; a box that claims to run past the end of the file means the
 * rest is missing. The decoder does not notice this in a tiled photo (which an
 * iPhone's are): it fills the missing tiles with green and reports success.
 * @param {ArrayBuffer} buffer
 */
function assertWhole(buffer) {
  const view = new DataView(buffer);
  for (let at = 0; at + 8 <= buffer.byteLength; ) {
    let size = view.getUint32(at);
    // A length of 1 means the real length follows as 64 bits; 0 means the box runs to the end of the file.
    if (size === 1 && at + 16 <= buffer.byteLength) size = Number(view.getBigUint64(at + 8));
    else if (size === 0) return;
    if (size < 8 || at + size > buffer.byteLength) throw new Error("the file is cut short");
    at += size;
  }
}

/**
 * The photo's main image, upright, no larger than `maxSide` on its long side.
 * @param {import("./heic").HeicRequest} request
 */
async function convert(request) {
  /** @type {"library" | "decode"} */
  let stage = "library";
  /** @type {any[]} */
  let images = [];
  try {
    const lib = await loadDecoder();
    stage = "decode";
    assertWhole(request.bytes);
    images = new lib.HeifDecoder().decode(new Uint8Array(request.bytes));
    // A file may hold several pictures (a burst, a live photo's still and extras): the one marked as the main one is the photo.
    const image = images.find((candidate) => candidate.is_primary()) ?? images[0];
    if (!image) throw new Error("no picture was found in the file");
    // The size after the file's own rotation and cropping, which the decoder applies: an upright iPhone photo comes out upright.
    const width = image.get_width();
    const height = image.get_height();
    if (!(width > 0 && height > 0)) throw new Error("the picture has no size");
    if (width * height > MAX_PIXELS) return post({ type: "error", stage: "size", message: `${width} x ${height}` });
    const pixels = new Uint8ClampedArray(width * height * 4);
    await new Promise((resolve, reject) => {
      image.display({ data: pixels, width, height }, (/** @type {unknown} */ shown) => (shown ? resolve(shown) : reject(new Error("the picture's data could not be decoded"))));
    });
    const scale = Math.min(1, request.maxSide / Math.max(width, height));
    try {
      // Shrunk here, so that the page is handed a small picture and never the full 4 bytes a pixel.
      const bitmap = await createImageBitmap(new ImageData(pixels, width, height), {
        resizeWidth: Math.max(1, Math.round(width * scale)),
        resizeHeight: Math.max(1, Math.round(height * scale)),
        resizeQuality: "high",
      });
      post({ type: "bitmap", bitmap }, [bitmap]);
    } catch {
      // A browser that cannot make a picture in a Worker gets the pixels, and the page shrinks them.
      post({ type: "pixels", width, height, pixels }, [pixels.buffer]);
    }
  } catch (error) {
    console.warn("Relight: a HEIC photo could not be converted.", stage, error);
    post({ type: "error", stage, message: error instanceof Error ? error.message : String(error) });
  } finally {
    for (const image of images) image.free();
  }
}

/** @param {MessageEvent<import("./heic").HeicRequest>} event */
self.onmessage = (event) => void convert(event.data);
