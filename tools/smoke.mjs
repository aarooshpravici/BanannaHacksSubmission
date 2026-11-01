#!/usr/bin/env node
// Smoke test for the Relight page: the main flows, end to end, in headless
// Chrome. No npm dependencies: like tools/screenshots.mjs it starts Google Chrome
// with a throwaway profile and drives it over the Chrome DevTools Protocol with
// Node's built-in WebSocket and fetch (Node 22 or newer; Node 26 also lets it
// import lib/relightMath.ts as it is).
//
// USAGE
//   node tools/smoke.mjs <url of a running build> [folder for the pictures] [options]
//
//   node tools/smoke.mjs http://localhost:3199/BanannaHacksSubmission
//   node tools/smoke.mjs http://localhost:3199/BanannaHacksSubmission /tmp/before
//
// OPTIONS
//   --photo FILE   the photo to upload.     Default: <repo>/testing/photos/02-object-coffee.jpg
//   --chrome PATH  the Chrome binary.       Default: the macOS Google Chrome app, or $CHROME_PATH
//   --headed       show the browser window (for debugging the test).
//
// WHAT IT CHECKS, in order. Any failure stops it with a message and exit code 1.
//   1. The first page: the four sample thumbnails, the file input, the Drafts tab.
//   2. Each sample: it opens, the canvas is lit (drawn, and not just the photo),
//      the GEOMETRY panel has its "shading:" line. Where the graphics chip shades,
//      the canvas is also compared with lib/relightMath.ts run here on the same
//      sample under the same light (the shader against the CPU port; see
//      GPU_MAX_LEVELS). The canvas under the starting light is saved as
//      <folder>/<sample>.png, so a later change can be compared with these.
//   3. An upload through the file input (the photo above): it waits for the light
//      handle. With no backend the browser works out the depth itself, which
//      downloads the depth model (19 MB from huggingface.co) on a first run, so
//      this needs the internet and takes a while.
//   4. Left, Right and Reset light: the handle goes where each puts it, and Left
//      lights the left of the picture more than Right does.
//   5. The fill light on, then off: its handle comes and goes, the picture gets
//      brighter, and off again it is the picture from before.
//   6. The logo: the first page comes back, the Drafts tab has a card, and the
//      card opens the photo again with the light it was left with.
// All the way through, a red bar (role="alert") or an error in the console fails it.
//
// WHAT TO RUN IT AGAINST
//   Any build of the page: `npm run dev`, a production build, or the static demo
//   (see frontend/README.md). To test the code in the folder without disturbing a
//   dev server that may be running there, build the demo in a copy:
//     git archive HEAD frontend | tar -x -C /tmp/relight-smoke
//     cd /tmp/relight-smoke/frontend && npm ci && NEXT_PUBLIC_BASE_PATH=/BanannaHacksSubmission npm run build:demo
//     mkdir -p /tmp/relight-serve && cp -R out /tmp/relight-serve/BanannaHacksSubmission
//     python3 -m http.server 5180 --directory /tmp/relight-serve
//     node tools/smoke.mjs http://localhost:5180/BanannaHacksSubmission

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VIEWPORT = { width: 1440, height: 900 };
/** The four built-in samples: the name on the thumbnail's button, and the folder under public/samples. */
const SAMPLES = [
  ["Portrait", "portrait"],
  ["Coffee cup", "coffee"],
  ["Cat", "cat"],
  ["Rocket", "rocket"],
];
/** The light the page starts with (START in frontend/app/relight/page.tsx): where the handle must be after Reset light. */
const START = { x: 0.12, y: 0.35 };
/**
 * The most the graphics chip's picture may differ from lib/relightMath.ts's on a
 * sample, in levels of 255: over the whole picture, and on average. The shader
 * works in 32-bit floats, samples its textures with the chip's own filtering and
 * may keep the shadow map in 16-bit floats, so it is close but not exact; a
 * mistake in its maths (a wrong constant, a missing term) moves whole regions by
 * far more than this. On an Apple M5 (ANGLE on Metal) the four samples came out
 * at most 1 level off, 0.01 on average; a software renderer may need more room.
 */
const GPU_MAX_LEVELS = 3;
const GPU_MEAN_LEVELS = 0.25;
/** Processor shading: how long the canvas must have said "full" before it is read (SETTLE_MS in lib/relightCPU.ts is 180). */
const CPU_SHARP_WATCH_MS = 400;
/** Uploading: the depth model may have to be downloaded first. */
const UPLOAD_TIMEOUT_MS = 300_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { url: null, out: null, photo: join(REPO, "testing", "photos", "02-object-coffee.jpg"), headed: false, chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headed") args.headed = true;
    else if (a === "--photo") args.photo = resolve(argv[++i]);
    else if (a === "--chrome") args.chrome = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
    else if (!args.url) args.url = a.replace(/\/+$/, "");
    else if (!args.out) args.out = resolve(a);
    else throw new Error(`Unexpected argument: ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------------------------
// Chrome and the DevTools Protocol (a trimmed copy of what tools/screenshots.mjs does)
// ---------------------------------------------------------------------------------

class Browser {
  static async launch(chromePath, extraFlags, headed) {
    if (!existsSync(chromePath)) throw new Error(`Chrome was not found at ${chromePath}. Pass --chrome PATH.`);
    const profile = mkdtempSync(join(tmpdir(), "relight-smoke-"));
    const flags = [
      ...(headed ? [] : ["--headless=new"]),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-component-update",
      "--mute-audio",
      "--force-color-profile=srgb",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      ...extraFlags,
      "about:blank",
    ];
    const proc = spawn(chromePath, flags, { stdio: "ignore" });
    const browser = new Browser(proc, profile, extraFlags);
    try {
      const portFile = join(profile, "DevToolsActivePort");
      const deadline = Date.now() + 20_000;
      while (!existsSync(portFile) || !readFileSync(portFile, "utf8").includes("\n")) {
        if (proc.exitCode !== null) throw new Error(`Chrome exited straight away (code ${proc.exitCode}).`);
        if (Date.now() > deadline) throw new Error("Chrome did not open its debugging port within 20 s.");
        await sleep(50);
      }
      const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      browser.version = version.Browser;
      await browser.connect(version.webSocketDebuggerUrl);
      return browser;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  constructor(proc, profile, flags) {
    this.proc = proc;
    this.profile = profile;
    this.flags = flags;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
  }

  connect(url) {
    return new Promise((resolveOpen, rejectOpen) => {
      this.ws = new WebSocket(url);
      this.ws.addEventListener("open", () => resolveOpen());
      this.ws.addEventListener("error", () => rejectOpen(new Error("Could not connect to Chrome's debugging socket.")));
      this.ws.addEventListener("close", () => {
        for (const { reject } of this.pending.values()) reject(new Error("Chrome closed the connection."));
        this.pending.clear();
      });
      this.ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== undefined) {
          const waiter = this.pending.get(message.id);
          if (!waiter) return;
          this.pending.delete(message.id);
          if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
          else waiter.resolve(message.result);
        } else {
          for (const listener of this.listeners) listener(message);
        }
      });
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async newPage() {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.init();
    return page;
  }

  async close() {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) await Promise.race([this.send("Browser.close"), sleep(2000)]);
    } catch {
      // already gone
    }
    if (this.proc.exitCode === null) {
      const exited = new Promise((r) => this.proc.once("exit", r));
      await Promise.race([exited, sleep(3000)]);
      if (this.proc.exitCode === null) {
        this.proc.kill("SIGKILL");
        await Promise.race([exited, sleep(2000)]);
      }
    }
    try {
      rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // a leftover temp profile is harmless
    }
  }
}

// Small helpers that run inside the page. Every page.js() call gets them.
// A slider or switch is found by its <label for>: the words beside it (components/ui.tsx).
const IN_PAGE = `
  const rectOf = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const controlOf = (label) => { const l = [...document.querySelectorAll("label[for]")].find((e) => e.textContent.trim() === label); return l ? document.getElementById(l.htmlFor) : null; };
  const switchOf = (label) => document.querySelector('button[role="switch"][aria-label=' + JSON.stringify(label) + ']');
  const photoBox = () => document.querySelector('img[alt="Original photo"]')?.parentElement ?? null;
  // The key light's handle is "Light position", or "Key light position" while the fill light is on.
  const lightHandle = () => document.querySelector('button[aria-label^="Light position"], button[aria-label^="Key light position"]');
  const fillHandle = () => document.querySelector('button[aria-label^="Fill light position"]');
  const busyText = () => photoBox()?.querySelector('svg[role="status"]')?.parentElement.innerText.trim() ?? null;
  const shadingLine = () => [...document.querySelectorAll("aside p.font-mono span[title]")].find((e) => e.textContent.trim().startsWith("shading:")) ?? null;
  const alerts = () => [...document.querySelectorAll('[role="alert"]')].filter((e) => e.offsetParent !== null).map((e) => e.innerText.trim().replace(/\\s+/g, " "));
  const draftsTab = () => [...document.querySelectorAll('button[role="tab"]')].find((b) => b.textContent.trim().startsWith("Drafts"));
  const handleAt = (handle) => { const m = handle?.getAttribute("aria-label").match(/x (-?\\d+\\.\\d+), y (-?\\d+\\.\\d+), height (-?\\d+\\.\\d+)/); return m ? { x: Number(m[1]), y: Number(m[2]), height: Number(m[3]) } : null; };
  /** The live canvas as RGBA bytes at its own size, and the mean brightness of its left and right thirds. */
  const canvasPixels = () => {
    const canvas = document.querySelector("canvas");
    if (!canvas || !canvas.width) return null;
    const copy = document.createElement("canvas"); copy.width = canvas.width; copy.height = canvas.height;
    const g = copy.getContext("2d", { willReadFrequently: true }); g.drawImage(canvas, 0, 0);
    return { width: canvas.width, height: canvas.height, data: g.getImageData(0, 0, canvas.width, canvas.height).data };
  };
`;

class Page {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.errors = []; // errors the page logged or threw
    this.listener = (message) => {
      if (message.sessionId !== this.sessionId) return;
      this.onEvent(message.method, message.params);
    };
    browser.listeners.add(this.listener);
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }

  async init() {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");
    await this.send("Log.enable");
    await this.send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
  }

  onEvent(method, params) {
    if (method === "Runtime.consoleAPICalled" && params.type === "error") {
      this.errors.push(`console.error: ${params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400)}`);
    } else if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails;
      this.errors.push(`uncaught: ${(d.exception?.description ?? d.text ?? "").slice(0, 400)}`);
    } else if (method === "Log.entryAdded" && params.entry.level === "error") {
      this.errors.push(`log.error: ${params.entry.text.slice(0, 300)} ${params.entry.url ?? ""}`);
    }
  }

  async js(expression) {
    const result = await this.send("Runtime.evaluate", { expression: `(async () => { ${IN_PAGE}\n return (${expression}); })()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`In-page error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}\n  in: ${expression.slice(0, 200)}`);
    return result.result.value;
  }

  /** Poll until `expression` is truthy. A red bar on the way fails at once, unless `allowAlert`. */
  async waitFor(expression, what, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await this.js(expression).catch(() => null); // the page may be mid-navigation
      if (value) return value;
      await this.healthy(`waiting for ${what}`);
      if (Date.now() > deadline) {
        const seen = await this.js(`document.body ? document.body.innerText.slice(0, 600) : ""`).catch(() => "");
        throw new Error(`Timed out after ${timeout / 1000} s waiting for ${what}.\n  Page text: ${JSON.stringify(seen)}`);
      }
      await sleep(100);
    }
  }

  /** Fail on a red bar or a console error. */
  async healthy(when) {
    const bars = await this.js("alerts()").catch(() => []);
    if (bars.length) throw new Error(`A red bar is showing (${when}): ${JSON.stringify(bars)}`);
    if (this.errors.length) throw new Error(`The page logged an error (${when}):\n  ${this.errors.join("\n  ")}`);
  }

  async painted() {
    await this.js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
  }

  async goto(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor(`document.readyState === "complete" && !!document.querySelector("header a[data-home]")`, `the page at ${url} to load`);
    await this.waitFor(`(() => { const e = document.querySelector('input[type="file"]'); return !!e && Object.keys(e).some((k) => k.startsWith("__reactProps")); })()`, "React to take over the page");
  }

  async click(x, y) {
    for (const [type, buttons] of [
      ["mouseMoved", 0],
      ["mousePressed", 1],
      ["mouseReleased", 0],
    ]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse" });
    }
  }

  /** A real mouse click on the middle of the element the in-page expression returns, scrolled into view first. */
  async clickOn(elementExpression, what) {
    const r = await this.js(`(() => { const e = ${elementExpression}; if (!e) return null; e.scrollIntoView({ block: "nearest", inline: "nearest" }); return rectOf(e); })()`);
    if (!r || r.w === 0) throw new Error(`Could not find on the page: ${what}`);
    await this.click(r.x + r.w / 2, r.y + r.h / 2);
  }

  clickButton(text) {
    return this.clickOn(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`, `the "${text}" button`);
  }

  async upload(file) {
    if (!existsSync(file)) throw new Error(`The test photo is missing: ${file}`);
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type="file"]' });
    if (!nodeId) throw new Error("The page has no file input.");
    await this.send("DOM.setFileInputFiles", { nodeId, files: [file] });
  }

  /** Wait until a photo is shaded on the live canvas, its full-quality picture if the processor shades. Returns the canvas's shading path ("gpu-...", "cpu-..."). */
  async lit(what, timeout = 60_000) {
    const path = await this.waitFor(
      `(() => {
        const text = document.body.innerText;
        if (text.includes("Estimating depth") || text.includes("Preparing the shader") || !photoBox() || busyText()) return false;
        const canvas = document.querySelector("canvas");
        if (!canvas || canvas.classList.contains("opacity-0") || !lightHandle()) return false;
        if (![...document.querySelectorAll('img[alt$=" map"]')].every((i) => i.complete && i.naturalWidth > 0)) return false;
        const path = canvas.dataset.shading ?? "";
        if (path.startsWith("cpu")) return canvas.dataset.quality === "full" ? path : false;
        return path.startsWith("gpu") ? path : false;
      })()`,
      what,
      timeout,
    );
    await this.sharp();
    await this.painted();
    const check = await this.js(`(() => {
      const canvas = document.querySelector("canvas"), photo = document.querySelector('img[alt="Original photo"]');
      const n = 64, read = (source) => { const c = document.createElement("canvas"); c.width = n; c.height = n; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(source, 0, 0, n, n); return g.getImageData(0, 0, n, n).data; };
      const a = read(canvas), b = read(photo);
      let alpha = 0, diff = 0;
      for (let i = 0; i < a.length; i += 4) { alpha += a[i + 3]; diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); }
      return { alpha: alpha / (n * n), differsFromPhoto: diff / (n * n * 3) };
    })()`);
    if (check.alpha < 250 || check.differsFromPhoto < 1) throw new Error(`The canvas is not lit after ${what}: ${JSON.stringify(check)} (shading path ${path})`);
    await this.healthy(what);
    return path;
  }

  /** On the processor, wait until the canvas has held its full-quality picture for a moment (straight after a click it may still be the one from before). */
  async sharp() {
    await this.js(`new Promise((done) => {
      let since = null;
      const tick = () => {
        const canvas = document.querySelector("canvas");
        if (!canvas || !(canvas.dataset.shading ?? "").startsWith("cpu")) return done(true);
        if (canvas.dataset.quality !== "full") since = null;
        else if (since === null) since = performance.now();
        else if (performance.now() - since > ${CPU_SHARP_WATCH_MS}) return done(true);
        setTimeout(tick, 30);
      };
      tick();
    })`);
  }

  /** The live canvas's pixels, read back in the page, as { width, height, data: Uint8Array }. */
  async pixels() {
    const got = await this.js(`(() => { const p = canvasPixels(); if (!p) return null; let s = ""; for (let i = 0; i < p.data.length; i += 0x8000) s += String.fromCharCode(...p.data.subarray(i, i + 0x8000)); return { width: p.width, height: p.height, data: btoa(s) }; })()`);
    if (!got) throw new Error("There is no live canvas to read.");
    return { width: got.width, height: got.height, data: new Uint8Array(Buffer.from(got.data, "base64")) };
  }

  async close() {
    this.browser.listeners.delete(this.listener);
    await this.browser.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
  }
}

const GPU_FLAG_SETS = [
  [],
  ["--use-angle=metal"],
  ["--ignore-gpu-blocklist", "--use-angle=metal"],
  ["--ignore-gpu-blocklist", "--enable-gpu"],
  ["--enable-unsafe-swiftshader"],
  ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
];

const WEBGL_PROBE = `(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 16; canvas.height = 16;
  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
  if (!gl) return { ok: false, why: "getContext('webgl2') returned null" };
  gl.clearColor(1, 0.5, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  const px = new Uint8Array(4); gl.readPixels(8, 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return { ok: px[0] === 255 && px[3] === 255, renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
})()`;

/** Chrome with the first set of flags under which WebGL2 really draws. If none does, plain Chrome: the page then shades on the processor, which is tested instead. */
async function launch(args) {
  for (const flags of GPU_FLAG_SETS) {
    let browser;
    try {
      browser = await Browser.launch(args.chrome, flags, args.headed);
      const page = await browser.newPage();
      const probe = await page.js(WEBGL_PROBE);
      await page.close();
      if (probe.ok) {
        console.log(`Chrome ${browser.version}; WebGL2 with flags: ${flags.join(" ") || "(none needed)"}; renderer: ${probe.renderer}`);
        browser.webgl = true;
        return browser;
      }
    } catch {
      // try the next set
    }
    await browser?.close();
  }
  console.log("WebGL2 does not work in this Chrome: the page will shade on the processor, and the shader is not tested.");
  return Browser.launch(args.chrome, [], args.headed);
}

// ---------------------------------------------------------------------------------
// The shader against the CPU port
// ---------------------------------------------------------------------------------

/** lib/relightMath.ts, imported as it is (Node strips the types). */
async function relightMath() {
  // Node would say that it had to guess the file is a module (frontend/package.json does not say): expected here, so not said.
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const code = typeof rest[0] === "object" ? rest[0]?.code : rest[1];
    if (code !== "MODULE_TYPELESS_PACKAGE_JSON") emit.call(process, warning, ...rest);
  };
  return import(pathToFileURL(join(REPO, "frontend", "lib", "relightMath.ts")).href);
}

/** A sample's three pictures, decoded in the page the way the page decodes them (lib/image.ts), as RGBA bytes. */
async function samplePictures(page, base, folder) {
  const got = await page.js(`(async () => {
    const read = async (file, raw) => {
      const blob = await (await fetch(${JSON.stringify(base)} + "/samples/${folder}/" + file)).blob();
      const bitmap = await createImageBitmap(blob, raw ? { colorSpaceConversion: "none", premultiplyAlpha: "none" } : undefined);
      const c = document.createElement("canvas"); c.width = bitmap.width; c.height = bitmap.height;
      const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(bitmap, 0, 0);
      const data = g.getImageData(0, 0, c.width, c.height).data;
      let s = ""; for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return { width: c.width, height: c.height, data: btoa(s) };
    };
    const scene = await (await fetch(${JSON.stringify(base)} + "/samples/${folder}/scene.json")).json();
    return { scene, image: await read("photo.jpg", false), depth: await read("depth.png", true), normals: await read("normals.png", true) };
  })()`);
  const decode = (p) => ({ width: p.width, height: p.height, data: new Uint8ClampedArray(Buffer.from(p.data, "base64")) });
  return { scene: got.scene, image: decode(got.image), depth: decode(got.depth), normals: decode(got.normals) };
}

/** The light the page is showing, read from the handle and the sliders. Null if its colour is not plain white (the comparison then is not made). */
async function shownLight(page) {
  return page.js(`(() => {
    const at = handleAt(lightHandle());
    const value = (label) => Number(controlOf(label)?.value);
    if (!at || value("Colour") !== 0) return null;
    return { light: { ...at, intensity: value("Intensity"), ambient: value("Ambient"), color: [1, 1, 1] }, shadows: switchOf("Cast shadows")?.getAttribute("aria-checked") === "true", fill: switchOf("Fill light")?.getAttribute("aria-checked") === "true" };
  })()`);
}

function difference(a, b) {
  let worst = 0;
  let total = 0;
  for (let p = 0; p < a.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[p + c] - b[p + c]);
      total += d;
      if (d > worst) worst = d;
    }
  }
  return { worst, mean: total / ((a.length / 4) * 3) };
}

// ---------------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------------

const DRAFT_CARD = `document.querySelector('div[role="tabpanel"] button[aria-label^="Draft: "]')`;

/** Mean brightness of the left and right thirds of a picture. */
function sides({ width, height, data }) {
  let left = 0;
  let right = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const v = data[p] + data[p + 1] + data[p + 2];
      if (x < width / 3) left += v;
      else if (x >= (2 * width) / 3) right += v;
    }
  }
  return { left, right };
}

async function run(args) {
  const math = await relightMath();
  const browser = await launch(args);
  const steps = [];
  const step = async (name, work) => {
    const started = Date.now();
    const note = await work();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    steps.push(name);
    console.log(`  ok  ${name} (${seconds} s)${note ? `: ${note}` : ""}`);
  };
  try {
    const page = await browser.newPage();

    await step("the first page", async () => {
      await page.goto(args.url + "/");
      await page.waitFor(`[...document.querySelectorAll('button[aria-label^="Sample photo: "] img')].length === 4 && [...document.querySelectorAll('button[aria-label^="Sample photo: "] img')].every((i) => i.complete && i.naturalWidth > 0)`, "the four sample thumbnails");
      if (!(await page.js("!!draftsTab()"))) throw new Error('The first page has no "Drafts" tab.');
      await page.healthy("on the first page");
    });

    // Where the page's own files are: the samples are fetched from there, under the base path the build was made for.
    const base = new URL(args.url).pathname.replace(/\/+$/, "");
    for (const [label, folder] of SAMPLES) {
      await step(`the ${label} sample`, async () => {
        await page.goto(args.url + "/");
        const thumb = `document.querySelector('button[aria-label=${JSON.stringify(`Sample photo: ${label}`)}]')`;
        await page.waitFor(`(() => { const b = ${thumb}; return !!b && !b.disabled && b.querySelector("img").complete; })()`, `the "${label}" thumbnail`);
        await page.clickOn(thumb, `the "${label}" thumbnail`);
        const path = await page.lit(`opening the ${label} sample`);
        // The GEOMETRY panel starts folded; its "shading:" line says how the photo is drawn.
        const header = `[...document.querySelectorAll("aside button[aria-expanded]")].find((b) => b.textContent.includes("Geometry"))`;
        if ((await page.js(`${header}?.getAttribute("aria-expanded")`)) !== "true") await page.clickOn(header, "the GEOMETRY panel's header");
        const line = await page.waitFor(`shadingLine()?.textContent.trim()`, 'the "shading:" line in the GEOMETRY panel');
        if (!/^shading: \S/.test(line)) throw new Error(`The GEOMETRY panel's shading line is empty: ${JSON.stringify(line)}`);
        // The page checks its shader against the CPU port on a test picture and shades on the processor if they disagree (relightGL.ts, SELF_TEST_MAX_MEAN): with WebGL2 working, that is a broken shader.
        if (browser.webgl && !path.startsWith("gpu")) throw new Error(`WebGL2 works in this Chrome, but the page shades ${label} on the processor (${path}): "${line}". The shader failed its own check, or could not start.`);
        const canvas = await page.pixels();
        if (args.out) {
          const png = await page.js(`document.querySelector("canvas").toDataURL("image/png")`);
          writeFileSync(join(args.out, `${folder}.png`), Buffer.from(png.split(",")[1], "base64"));
        }
        let compared = "";
        if (path.startsWith("gpu")) {
          const shown = await shownLight(page);
          const pictures = await samplePictures(page, base, folder);
          if (shown && !shown.fill && canvas.width === pictures.image.width && canvas.height === pictures.image.height) {
            const arrays = math.sceneArrays(pictures.image, pictures.depth, pictures.normals, pictures.scene.relief);
            const cpu = math.relightPixels(arrays, shown.light, shown.shadows, null);
            const { worst, mean } = difference(canvas.data, cpu);
            if (worst > GPU_MAX_LEVELS || mean > GPU_MEAN_LEVELS) {
              if (args.out) writeFileSync(join(args.out, `${folder}-cpu.raw`), cpu);
              throw new Error(`The shader's picture of ${label} is off from lib/relightMath.ts's: at most ${worst} levels (allowed ${GPU_MAX_LEVELS}), ${mean.toFixed(2)} on average (allowed ${GPU_MEAN_LEVELS}).`);
            }
            compared = `, shader against relightMath.ts: at most ${worst} levels, ${mean.toFixed(2)} on average`;
          } else compared = ", not compared with relightMath.ts (the light or the size is not the one expected)";
        }
        return `${line}, canvas ${canvas.width} x ${canvas.height}${compared}`;
      });
    }

    await step(`uploading ${args.photo.split("/").pop()}`, async () => {
      await page.goto(args.url + "/");
      await page.upload(args.photo);
      const path = await page.lit("the uploaded photo to be analysed and shaded", UPLOAD_TIMEOUT_MS);
      const depth = await page.js(`document.querySelector("aside p.font-mono span[data-depth-device]")?.textContent.trim() ?? "depth from the server"`);
      return `${path}; ${depth}`;
    });

    const at = () => page.js("handleAt(lightHandle())");
    const presetTo = async (button, x, y) => {
      await page.clickButton(button);
      await page.waitFor(`(() => { const a = handleAt(lightHandle()); return !!a && Math.abs(a.x - ${x}) < 0.005 && Math.abs(a.y - ${y}) < 0.005; })()`, `the light to move to x ${x}, y ${y} after "${button}"`);
      await page.lit(`clicking "${button}"`);
      return page.pixels();
    };

    await step("Left, Right and Reset light", async () => {
      const left = sides(await presetTo("Left", -0.1, 0.4));
      const right = sides(await presetTo("Right", 1.1, 0.4));
      await presetTo("Reset light", START.x, START.y);
      // Each side is compared with itself under the other light, so the photo's own bright and dark parts cancel out.
      if (!(left.left > right.left && right.right > left.right)) throw new Error(`Left and Right do not light their own sides: under Left the thirds are ${left.left} | ${left.right}, under Right ${right.left} | ${right.right}.`);
      return `handle at ${JSON.stringify(await at())} after Reset light`;
    });

    await step("the fill light on and off", async () => {
      const before = await page.pixels();
      await page.clickOn(`switchOf("Fill light")`, 'the "Fill light" switch');
      await page.waitFor(`switchOf("Fill light")?.getAttribute("aria-checked") === "true" && !!fillHandle()`, "the fill light to come on, with its own handle");
      await page.lit("switching the fill light on");
      const on = await page.pixels();
      const brighter = on.data.reduce((sum, v, i) => (i % 4 === 3 ? sum : sum + v), 0) - before.data.reduce((sum, v, i) => (i % 4 === 3 ? sum : sum + v), 0);
      if (!(brighter > 0)) throw new Error("Switching the fill light on did not make the picture any brighter.");
      await page.clickOn(`switchOf("Fill light")`, 'the "Fill light" switch');
      await page.waitFor(`switchOf("Fill light")?.getAttribute("aria-checked") === "false" && !fillHandle()`, "the fill light to go off, and its handle with it");
      await page.lit("switching the fill light off");
      const off = await page.pixels();
      const { worst } = difference(before.data, off.data);
      if (worst > 2) throw new Error(`With the fill light off again the picture is not what it was: up to ${worst} levels different.`);
      return `on: ${(brighter / (on.width * on.height * 3)).toFixed(1)} levels brighter on average; off: back to before (at most ${worst} levels)`;
    });

    await step("the logo, the Drafts tab and the draft", async () => {
      await page.clickOn(`document.querySelector("header a[data-home]")`, 'the "Relight" logo');
      await page.waitFor(`!!document.querySelector('input[type="file"]') && !photoBox() && /^Drafts\\d+$/.test(draftsTab()?.textContent.trim() ?? "")`, 'the first page again, with a number beside "Drafts"');
      await page.clickOn("draftsTab()", 'the "Drafts" tab');
      await page.waitFor(`draftsTab()?.getAttribute("aria-selected") === "true" && !!${DRAFT_CARD}`, "a card on the Drafts tab");
      const card = await page.js(`${DRAFT_CARD}.getAttribute("aria-label")`);
      await page.clickOn(DRAFT_CARD, "the draft's card");
      await page.lit("opening the draft");
      const light = await at();
      if (!light || Math.abs(light.x - START.x) > 0.005 || Math.abs(light.y - START.y) > 0.005) throw new Error(`The draft opened with the light at ${JSON.stringify(light)}, not where it was left (${JSON.stringify(START)}).`);
      if (await page.js(`switchOf("Fill light")?.getAttribute("aria-checked") !== "false"`)) throw new Error("The draft opened with the fill light on; it was left off.");
      return `${JSON.stringify(card)}, light back at x ${light.x}, y ${light.y}`;
    });

    await page.healthy("at the end");
    await page.close();
    return steps.length;
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    console.log("Usage: node tools/smoke.mjs <url of a running build> [folder for the pictures] [--photo FILE] [--chrome PATH] [--headed]");
    process.exit(args.help ? 0 : 2);
  }
  if (args.out) mkdirSync(args.out, { recursive: true });
  const started = Date.now();
  console.log(`Smoke test of ${args.url}`);
  try {
    const count = await run(args);
    console.log(`PASSED: ${count} steps in ${((Date.now() - started) / 1000).toFixed(0)} s.${args.out ? ` The canvas of each sample under the starting light is in ${args.out}.` : ""}`);
  } catch (error) {
    console.error(`\nFAILED after ${((Date.now() - started) / 1000).toFixed(0)} s: ${error.message}`);
    process.exit(1);
  }
}

await main();
