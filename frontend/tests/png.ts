// Just enough of PNG to read the test fixtures, so the tests need nothing from
// npm: 8 bits a channel, grey, grey and alpha, RGB or RGBA, not interlaced. That
// is every PNG Pillow writes for an 8-bit image, which is what
// backend/scripts/relight_fixtures.py writes. Node's own zlib does the inflating.

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

export interface Picture {
  width: number;
  height: number;
  /** RGBA bytes, the layout of a canvas's ImageData. */
  data: Uint8ClampedArray;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Colour type -> channels a pixel. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** The filters a PNG row can be stored with: the byte before, the one above, both, or the Paeth guess. */
function unfilter(type: number, row: Uint8Array, above: Uint8Array, bpp: number): void {
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? row[i - bpp] : 0;
    const up = above[i];
    const corner = i >= bpp ? above[i - bpp] : 0;
    let guess = 0;
    if (type === 1) guess = left;
    else if (type === 2) guess = up;
    else if (type === 3) guess = (left + up) >> 1;
    else if (type === 4) {
      const p = left + up - corner;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - corner);
      guess = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
    } else if (type !== 0) throw new Error(`unknown PNG filter ${type}`);
    row[i] = (row[i] + guess) & 255;
  }
}

export function decodePng(bytes: Uint8Array): Picture {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts: Uint8Array[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      channels = CHANNELS[colour] ?? 0;
      if (depth !== 8 || !channels || interlace !== 0) throw new Error(`unsupported PNG: depth ${depth}, colour type ${colour}, interlace ${interlace}`);
    } else if (type === "IDAT") parts.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const data = new Uint8ClampedArray(width * height * 4);
  let above: Uint8Array = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const row = Uint8Array.from(raw.subarray(start + 1, start + 1 + stride));
    unfilter(raw[start], row, above, channels);
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const s = x * channels;
      if (channels <= 2) {
        data[p] = data[p + 1] = data[p + 2] = row[s];
        data[p + 3] = channels === 2 ? row[s + 1] : 255;
      } else {
        data[p] = row[s];
        data[p + 1] = row[s + 1];
        data[p + 2] = row[s + 2];
        data[p + 3] = channels === 4 ? row[s + 3] : 255;
      }
    }
    above = row;
  }
  return { width, height, data };
}

export const readPng = (path: string): Picture => decodePng(readFileSync(path));
