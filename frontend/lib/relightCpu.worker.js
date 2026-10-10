// The CPU renderer's Worker: lib/relightCpuCore.ts, off the page's thread so the
// sun and the sliders stay smooth while a picture is being shaded.
//
// Plain JavaScript on purpose: the bundler also copies this file as it stands
// into the build folder, and a stray .ts file there fails the next build's type check.

import { CpuScene } from "./relightCpuCore";

/** @type {CpuScene | null} */
let scene = null;

/** @param {MessageEvent<import("./relightCpuCore").CpuRequest>} event */
self.onmessage = (event) => {
  const request = event.data;
  if (request.type === "scene") {
    scene = null;
    try {
      scene = new CpuScene(request.data);
    } catch (error) {
      console.warn("Relight: the CPU renderer could not load the scene.", error);
    }
    return;
  }
  /** @type {import("./relightCpuCore").CpuReply} */
  let reply;
  const transfer = [];
  try {
    if (!scene) throw new Error("no scene");
    const started = performance.now();
    const frame = scene.render(request.light, request.shadows, request.quality);
    reply = { type: "frame", id: request.id, frame, ms: performance.now() - started };
    transfer.push(frame.pixels.buffer);
  } catch (error) {
    reply = { type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(reply, { transfer });
};
