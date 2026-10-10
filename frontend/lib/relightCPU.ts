// The CPU renderer as the page sees it: the same render(light, shadows) call as
// the WebGL renderer (lib/relightGL.ts), drawn into a 2D canvas.
//
// A picture takes a noticeable fraction of a second on the CPU, so:
//   - the work is done in a Worker, and the page's thread only copies pixels;
//   - while the light is moving, a small quick "preview" is shaded and stretched
//     over the canvas, and requests that pile up are skipped, newest wins;
//   - once the light has been still for SETTLE_MS, the full picture is shaded:
//     exactly what lib/relightMath.ts relightPixels() gives, at the scene's size.
// If the Worker cannot be started (some hosts block the script), the same code
// runs on the page's thread between events instead.

import { ctx2d, makeCanvas } from "./image";
import { type CpuFrame, type CpuPixels, type CpuQuality, type CpuReply, type CpuRequest, CpuScene, type CpuSceneData, PREVIEW_MAX_SIDE } from "./relightCpuCore";
import type { Light } from "./types";

/**
 * How long the light must be still before the full-quality picture is shaded,
 * in milliseconds. Shorter and a slow drag keeps starting full renders that are
 * thrown away; longer and the picture stays soft after the light has stopped.
 */
const SETTLE_MS = 180;
/**
 * How long the Worker gets to answer its first request before the page gives up
 * on it and shades on its own thread. A blocked Worker script does not always
 * report an error; a slow phone needs a second or two to start one.
 */
const WORKER_START_TIMEOUT_MS = 5000;

/** The scene's three pictures as plain pixels, at the scene's size and at the preview's. */
export function cpuSceneData(width: number, height: number, relief: number, image: ImageBitmap, depth: ImageBitmap, normals: ImageBitmap): CpuSceneData {
  const pixels = (source: ImageBitmap, w: number, h: number): CpuPixels => {
    const canvas = makeCanvas(w, h);
    const ctx = ctx2d(canvas, true);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
  };
  const shrink = Math.min(1, PREVIEW_MAX_SIDE / Math.max(width, height));
  const pw = Math.max(1, Math.round(width * shrink));
  const ph = Math.max(1, Math.round(height * shrink));
  return {
    width,
    height,
    relief,
    image: pixels(image, width, height),
    depth: pixels(depth, width, height),
    normals: pixels(normals, width, height),
    preview: { image: pixels(image, pw, ph), depth: pixels(depth, pw, ph), normals: pixels(normals, pw, ph) },
  };
}

export interface CpuRendererEvents {
  /** A picture has been drawn. `ms` is the time the shading took, without the copy to the canvas. */
  onFrame?: (quality: CpuQuality, ms: number) => void;
  /** Shading failed altogether: nothing more will be drawn. */
  onError?: (message: string) => void;
}

interface Job {
  id: number;
  light: Light;
  shadows: boolean;
  quality: CpuQuality;
}

export class CpuRelightRenderer {
  private ctx: CanvasRenderingContext2D;
  private scratch: HTMLCanvasElement | null = null;
  private worker: Worker | null = null;
  /** Kept until the Worker has proved itself, in case the page has to take over. */
  private data: CpuSceneData | null;
  private local: CpuScene | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private localTimer: ReturnType<typeof setTimeout> | null = null;

  /** What the page last asked for. `version` goes up with every request. */
  private wanted: { light: Light; shadows: boolean; version: number } | null = null;
  private running: (Job & { version: number }) | null = null;
  private nextId = 0;
  /** The newest request a preview, and a full picture, has been drawn for. */
  private previewShown = 0;
  private fullShown = 0;
  /** The request the light came to rest on: a full picture is owed for it. */
  private settled = 0;
  private waiting: (() => void)[] = [];
  private dead = false;

  /** Throws if this browser cannot make a 2D canvas. The canvas takes the scene's pixel size. */
  constructor(
    private canvas: HTMLCanvasElement,
    data: CpuSceneData,
    private events: CpuRendererEvents = {},
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("this browser could not create a 2D canvas");
    this.ctx = ctx;
    this.data = data;
    canvas.width = data.width;
    canvas.height = data.height;
    this.startWorker(data);
  }

  /** True while the shading runs in a Worker, false once it is on the page's own thread. */
  get threaded(): boolean {
    return this.worker !== null;
  }

  private startWorker(data: CpuSceneData): void {
    try {
      const worker = new Worker(new URL("./relightCpu.worker.js", import.meta.url));
      worker.onmessage = (event: MessageEvent<CpuReply>) => this.onReply(event.data);
      worker.onerror = (event) => {
        event.preventDefault();
        this.takeOver(`the Worker failed (${event.message || "it could not be loaded"})`);
      };
      const request: CpuRequest = { type: "scene", data };
      worker.postMessage(request);
      this.worker = worker;
    } catch (error) {
      this.takeOver(`Workers are not available (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** Give up on the Worker and shade on the page's thread from here on. */
  private takeOver(why: string): void {
    if (this.dead || this.local) return;
    console.warn(`Relight: shading on the page's own thread because ${why}.`);
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.worker?.terminate();
    this.worker = null;
    this.running = null;
    try {
      if (!this.data) throw new Error("the scene is gone");
      this.local = new CpuScene(this.data);
      this.data = null;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    this.pump();
  }

  private fail(message: string): void {
    if (this.dead) return;
    this.events.onError?.(message);
    this.dispose();
  }

  /** Ask for the scene lit by `light`. Returns at once; the picture follows, a preview first. */
  render(light: Light, shadows: boolean): void {
    if (this.dead) return;
    const version = (this.wanted?.version ?? 0) + 1;
    this.wanted = { light, shadows, version };
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.settled = version;
      this.pump();
    }, SETTLE_MS);
    this.pump();
  }

  /** Resolves once the canvas holds the full-quality picture for the latest light (for Export and snapshots). */
  whenSettled(): Promise<void> {
    if (this.dead || !this.wanted || this.fullShown === this.wanted.version) return Promise.resolve();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Start the next piece of work, if there is any and nothing is running. */
  private pump(): void {
    const wanted = this.wanted;
    if (this.dead || !wanted || this.running) return;
    let quality: CpuQuality;
    if (this.settled === wanted.version && this.fullShown !== wanted.version) quality = "full";
    else if (this.previewShown !== wanted.version && this.fullShown !== wanted.version) quality = "preview";
    else return;
    const job = { id: ++this.nextId, light: wanted.light, shadows: wanted.shadows, quality, version: wanted.version };
    this.running = job;
    if (this.worker) {
      const request: CpuRequest = { type: "render", id: job.id, light: job.light, shadows: job.shadows, quality };
      this.worker.postMessage(request);
      if (this.data && this.startTimer === null) this.startTimer = setTimeout(() => this.takeOver("the Worker did not answer"), WORKER_START_TIMEOUT_MS);
    } else if (this.local) {
      const scene = this.local;
      // After a timeout, not at once: the browser gets to paint the sun's new position first.
      this.localTimer = setTimeout(() => {
        this.localTimer = null;
        try {
          const started = performance.now();
          const frame = scene.render(job.light, job.shadows, quality);
          this.onReply({ type: "frame", id: job.id, frame, ms: performance.now() - started });
        } catch (error) {
          this.onReply({ type: "error", id: job.id, message: error instanceof Error ? error.message : String(error) });
        }
      }, 0);
    }
  }

  private onReply(reply: CpuReply): void {
    const job = this.running;
    if (this.dead || !job || reply.id !== job.id) return;
    this.running = null;
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.startTimer = null;
    if (this.worker) this.data = null; // the Worker works: the page's copy can go
    if (reply.type === "error") return this.fail(reply.message);
    this.draw(reply.frame);
    if (job.quality === "full") this.fullShown = job.version;
    else this.previewShown = job.version;
    this.events.onFrame?.(job.quality, reply.ms);
    if (this.wanted && this.fullShown === this.wanted.version) for (const resolve of this.waiting.splice(0)) resolve();
    this.pump();
  }

  private draw(frame: CpuFrame): void {
    const { canvas, ctx } = this;
    const image = new ImageData(frame.pixels, frame.width, frame.height);
    if (frame.width === canvas.width && frame.height === canvas.height) return ctx.putImageData(image, 0, 0);
    const scratch = (this.scratch ??= document.createElement("canvas"));
    if (scratch.width !== frame.width || scratch.height !== frame.height) {
      scratch.width = frame.width;
      scratch.height = frame.height;
    }
    scratch.getContext("2d")?.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
  }

  dispose(): void {
    this.dead = true;
    for (const timer of [this.startTimer, this.settleTimer, this.localTimer]) if (timer !== null) clearTimeout(timer);
    this.worker?.terminate();
    this.worker = null;
    this.local = null;
    this.data = null;
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}
