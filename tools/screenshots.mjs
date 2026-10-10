#!/usr/bin/env node
// Screenshot tool for the Relight app. No npm dependencies: it starts Google
// Chrome headless with a throwaway profile and drives it over the Chrome
// DevTools Protocol with Node's built-in WebSocket and fetch (Node 22 or newer).
//
// USAGE
//   node tools/screenshots.mjs <frontend-url> [options]
//
//   node tools/screenshots.mjs http://localhost:3123                 every shot that fits the running app
//   node tools/screenshots.mjs http://localhost:3123 --only preset-left
//   node tools/screenshots.mjs http://localhost:3123 --only 05,06,enhance-done
//   node tools/screenshots.mjs --list                                print every shot name and what it shows
//
// OPTIONS
//   --only a,b,c     capture only these shots. A name ("preset-left"), a number ("05") or a file name all work.
//   --list           list the shots and exit (no browser is started).
//   --out DIR        where the JPEGs go.           Default: <repo>/testing/screenshots
//   --photos DIR     where the test photos are.    Default: <repo>/testing/photos
//   --chrome PATH    the Chrome binary.            Default: the macOS Google Chrome app, or $CHROME_PATH
//   --headed         show the browser window instead of running headless (for debugging the tool).
//   --backend-stopped  say that the backend process really is stopped (pill reads "offline"). Use it with
//                    --only backend-offline,backend-offline-upload,status-offline to photograph the real thing.
//
// WHAT THE APP MUST BE RUNNING AS
//   Most shots need the frontend talking to a backend that runs with MOCK_MODE=1
//   (the status pill reads "online, mock providers"):
//     cd backend  && MOCK_MODE=1 .venv/bin/python -m uvicorn app.main:app --port 8123
//     cd frontend && NEXT_PUBLIC_MOCK=0 NEXT_PUBLIC_API_URL=http://localhost:8123 npm run dev -- --port 3123
//   The shots named "mock-..." need the frontend alone in its own mock mode (pill reads "mock"):
//     cd frontend && NEXT_PUBLIC_MOCK=1 npm run dev -- --port 3123
//   The tool reads the status pill first and skips the shots that do not fit, saying so.
//
// HOW THE SPECIAL STATES ARE PRODUCED (nothing here changes the app or the backend)
//   - "Backend offline": the browser's requests to the backend are refused inside Chrome.
//     The page sees exactly what it sees when the backend process is stopped.
//   - "Loading" and "Enhancing": the backend's reply is held back until the picture is taken.
//   - Status "online" (green): the real /health reply is passed on with mock_mode changed to false.
//     The backend itself is never run with MOCK_MODE=0, so no paid API is called.
//   - "No WebGL2": canvas.getContext("webgl2") is made to return null, as an old browser would.
//
// It also writes <out>/manifest.json: for each shot the file, what it shows, the
// light position read from the page and whether live (WebGL) shading was on screen.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const PHONE = { width: 390, height: 844, scale: 2, mobile: true };
const JPEG_QUALITY = 88;

// ---------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { url: null, only: null, list: false, headed: false, out: join(REPO, "testing", "screenshots"), photos: join(REPO, "testing", "photos"), chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") args.list = true;
    else if (a === "--headed") args.headed = true;
    else if (a === "--backend-stopped") args.backendStopped = true;
    else if (a === "--only") args.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--photos") args.photos = resolve(argv[++i]);
    else if (a === "--chrome") args.chrome = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("--") && !args.url) args.url = a.replace(/\/+$/, "");
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------
// Chrome and the DevTools Protocol
// ---------------------------------------------------------------------------------

class Browser {
  static async launch(chromePath, extraFlags, headed) {
    if (!existsSync(chromePath)) throw new Error(`Chrome was not found at ${chromePath}. Pass --chrome PATH.`);
    const profile = mkdtempSync(join(tmpdir(), "relight-shots-"));
    const flags = [
      ...(headed ? [] : ["--headless=new"]),
      "--remote-debugging-port=0", // Chrome picks a free port and writes it to DevToolsActivePort
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-component-update",
      "--mute-audio",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      `--window-size=${DESKTOP.width},${DESKTOP.height}`,
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

  async newPage(viewport = DESKTOP) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.init(viewport);
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
const IN_PAGE = `
  const byText = (selector, text) => [...document.querySelectorAll(selector)].find((e) => e.textContent.trim() === text);
  const rectOf = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const photoBox = () => document.querySelector('img[alt="Original photo"]')?.parentElement ?? null;
  const sliderOf = (label) => [...document.querySelectorAll("label")].find((e) => e.querySelector("span span")?.textContent.trim() === label)?.querySelector('input[type="range"]') ?? null;
  const lightHandle = () => document.querySelector('button[aria-label^="Light position"]');
  const statusPill = () => document.querySelector("header div[title]");
  const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((e) => e.querySelector("p")?.textContent.trim() ?? e.textContent.trim());
`;

const KEYS = { Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };

class Page {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.console = []; // errors and warnings the page logged
    this.rules = []; // network rules, see route()
    this.held = [];
    this.viewport = DESKTOP;
    this.listener = (message) => {
      if (message.sessionId !== this.sessionId) return;
      void this.onEvent(message.method, message.params).catch(() => {});
    };
    browser.listeners.add(this.listener);
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }

  async init(viewport) {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");
    await this.send("Log.enable");
    await this.setViewport(viewport);
  }

  async setViewport(viewport) {
    this.viewport = viewport;
    await this.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: viewport.mobile });
  }

  async onEvent(method, params) {
    if (method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "warning")) {
      this.console.push(`console.${params.type}: ${params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400)}`);
    } else if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails;
      this.console.push(`uncaught: ${(d.exception?.description ?? d.text ?? "").slice(0, 400)}`);
    } else if (method === "Log.entryAdded" && params.entry.level === "error") {
      this.console.push(`log.error: ${params.entry.text.slice(0, 300)} ${params.entry.url ?? ""}`);
    } else if (method === "Fetch.requestPaused") {
      await this.onPaused(params);
    }
  }

  // --- network rules ---------------------------------------------------------------

  /**
   * Decide what happens to requests whose URL contains `fragment`:
   *   "fail"        refuse the connection (the backend looks stopped)
   *   "hold"        keep the request waiting until release() is called
   *   "health-live" pass /health on with mock_mode set to false
   */
  async route(fragment, action) {
    this.rules.push({ fragment, action });
    await this.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  }

  async onPaused({ requestId, request }) {
    const rule = this.rules.find((r) => request.url.includes(r.fragment));
    // CORS preflights are let through so that only the real request is affected.
    if (!rule || request.method === "OPTIONS") return void (await this.send("Fetch.continueRequest", { requestId }));
    if (rule.action === "fail") return void (await this.send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }));
    if (rule.action === "hold") return void this.held.push(requestId);
    if (rule.action === "health-live") {
      const real = await (await fetch(request.url)).json();
      const body = Buffer.from(JSON.stringify({ ...real, mock_mode: false })).toString("base64");
      return void (await this.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: "application/json" },
          { name: "Access-Control-Allow-Origin", value: "*" },
        ],
        body,
      }));
    }
  }

  /** Drop every rule and let held requests continue. */
  async release() {
    this.rules = [];
    const held = this.held.splice(0);
    for (const requestId of held) await this.send("Fetch.continueRequest", { requestId }).catch(() => {});
    await this.send("Fetch.disable").catch(() => {});
  }

  // --- running code in the page ------------------------------------------------------

  /** Evaluate an expression in the page (with the IN_PAGE helpers in scope) and return its value. */
  async js(expression) {
    const result = await this.send("Runtime.evaluate", { expression: `(async () => { ${IN_PAGE}\n return (${expression}); })()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`In-page error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}\n  in: ${expression.slice(0, 200)}`);
    return result.result.value;
  }

  /** Poll the page until `expression` is truthy. This is how the tool waits: it watches, it does not sleep blindly. */
  async waitFor(expression, what, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await this.js(expression).catch(() => null); // the page may be mid-navigation
      if (value) return value;
      if (Date.now() > deadline) {
        const seen = await this.js(`document.body ? document.body.innerText.slice(0, 600) : ""`).catch(() => "");
        throw new Error(`Timed out after ${timeout / 1000} s waiting for: ${what}\n  page text: ${JSON.stringify(seen)}`);
      }
      await sleep(80);
    }
  }

  /** Wait until the browser has painted what the page now holds. */
  async painted() {
    await this.js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
  }

  // --- navigation ------------------------------------------------------------------

  /** Open a path and wait until React has taken over the page (so clicks and uploads are heard). */
  async goto(url, { settleStatus = true } = {}) {
    await this.send("Page.navigate", { url });
    await this.waitFor(`document.readyState === "complete" && !!statusPill()`, `the page at ${url} to load`);
    await this.waitFor(
      `(() => { const e = document.querySelector('input[type="file"]') ?? document.querySelector("header a"); return !!e && Object.keys(e).some((k) => k.startsWith("__reactProps")); })()`,
      "React to hydrate the page",
    );
    if (settleStatus) await this.waitFor(`statusPill().textContent.trim() !== "backend:checking" && !statusPill().textContent.includes("checking")`, "the backend status to leave 'checking'");
  }

  async status() {
    return this.js(`({ label: statusPill().querySelector("span.font-medium").textContent.trim(), title: statusPill().title })`);
  }

  // --- real input --------------------------------------------------------------------

  async mouse(type, x, y, buttons = 0) {
    await this.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? (buttons ? "left" : "none") : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse" });
  }

  async click(x, y) {
    await this.mouse("mouseMoved", x, y);
    await this.mouse("mousePressed", x, y, 1);
    await this.mouse("mouseReleased", x, y, 0);
  }

  /** Press at one point, move in steps, release at another: a real drag. */
  async drag(from, to, steps = 14) {
    await this.mouse("mouseMoved", from.x, from.y);
    await this.mouse("mousePressed", from.x, from.y, 1);
    for (let i = 1; i <= steps; i++) {
      await this.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, 1);
    }
    await this.mouse("mouseReleased", to.x, to.y, 0);
  }

  async key(name) {
    const base = { key: name, code: name, windowsVirtualKeyCode: KEYS[name], nativeVirtualKeyCode: KEYS[name] };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Centre of the element the in-page expression returns, scrolled into view first. */
  async centre(elementExpression, what) {
    const r = await this.js(`(() => { const e = ${elementExpression}; if (!e) return null; e.scrollIntoView({ block: "nearest", inline: "nearest" }); return rectOf(e); })()`);
    if (!r || r.w === 0) throw new Error(`Could not find on the page: ${what}`);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2, rect: r };
  }

  async clickOn(elementExpression, what) {
    const c = await this.centre(elementExpression, what);
    await this.click(c.x, c.y);
  }

  clickButton(text) {
    return this.clickOn(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`, `the "${text}" button`);
  }

  // --- the Relight page ----------------------------------------------------------------

  /** Choose a file through the page's real <input type="file">. */
  async upload(file) {
    if (!existsSync(file)) throw new Error(`Test file is missing: ${file}`);
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type="file"]' });
    if (!nodeId) throw new Error("The page has no file input (is a photo already loaded?).");
    await this.send("DOM.setFileInputFiles", { nodeId, files: [file] });
  }

  /**
   * Wait until the photo is analysed and shaded. Returns "webgl" when the live
   * canvas is on screen, or "server" when the page fell back to server renders.
   * Fails if the WebGL canvas is blank.
   */
  async sceneReady(timeout = 240_000) {
    const mode = await this.waitFor(
      `(() => {
        const text = document.body.innerText;
        if (text.includes("Estimating depth") || text.includes("Preparing the shader")) return false;
        if (!photoBox()) return false;
        if (alerts().length && !text.includes("Live shading is unavailable")) return "error";
        if (text.includes("Live shading is unavailable")) return document.querySelector('img[alt="Relit photo"]')?.complete ? "server" : false;
        const canvas = document.querySelector("canvas");
        if (!canvas || canvas.classList.contains("opacity-0") || !lightHandle()) return false;
        return [...document.querySelectorAll('img[alt$=" map"]')].every((i) => i.complete && i.naturalWidth > 0) ? "webgl" : false;
      })()`,
      "the photo to be analysed and shaded",
      timeout,
    );
    if (mode === "error") throw new Error(`The page shows an error instead of the scene: ${JSON.stringify(await this.js("alerts()"))}`);
    if (mode === "webgl") {
      const check = await this.canvasCheck();
      if (!check.ok) throw new Error(`The WebGL canvas is blank (${JSON.stringify(check)}). Chrome flags: ${this.browser.flags.join(" ") || "(none)"}`);
    }
    await this.painted();
    return mode;
  }

  /** Read the WebGL canvas back: is it drawn at all, and does it differ from the plain photo? */
  canvasCheck() {
    return this.js(`(() => {
      const canvas = document.querySelector("canvas");
      const photo = document.querySelector('img[alt="Original photo"]');
      if (!canvas || !photo) return { ok: false, why: "no canvas" };
      const n = 64;
      const read = (source) => { const c = document.createElement("canvas"); c.width = n; c.height = n; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(source, 0, 0, n, n); return g.getImageData(0, 0, n, n).data; };
      const a = read(canvas), b = read(photo);
      let alpha = 0, sum = 0, diff = 0;
      for (let i = 0; i < a.length; i += 4) { alpha += a[i + 3]; sum += a[i] + a[i + 1] + a[i + 2]; diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); }
      const px = n * n;
      const out = { alpha: Math.round(alpha / px), brightness: Math.round(sum / px / 3), differsFromPhoto: Math.round(diff / px / 3) };
      return { ok: out.alpha > 250, ...out };
    })()`);
  }

  /** The light position and slider values as the sidebar shows them. */
  light() {
    return this.js(`(() => {
      const readout = [...document.querySelectorAll("div.font-mono")].find((e) => /^x\\s/.test(e.textContent.trim()));
      if (!readout) return null;
      const m = readout.textContent.match(/x\\s*(-?[\\d.]+)\\s*y\\s*(-?[\\d.]+)/);
      const shown = (label) => sliderOf(label)?.closest("label").querySelector("span span + span")?.textContent.trim() ?? null;
      return { x: Number(m[1]), y: Number(m[2]), height: shown("Height"), intensity: shown("Intensity"), ambient: shown("Ambient"), colour: shown("Colour"),
        shadows: document.querySelector('button[role="switch"][aria-label="Cast shadows"]')?.getAttribute("aria-checked") === "true",
        detailedNormals: document.querySelector('button[role="switch"][aria-label="Detailed normals"]')?.getAttribute("aria-checked") === "true" };
    })()`);
  }

  /** Drag the sun handle to a position given in photo units (0,0 = top left of the photo, 1,1 = bottom right). */
  async dragLight(x, y) {
    const from = await this.centre("lightHandle()", "the light handle");
    const box = await this.js("rectOf(photoBox())");
    await this.drag(from, { x: box.x + x * box.w, y: box.y + y * box.h });
    await this.painted();
    return this.light();
  }

  /** Set a slider with the mouse and keyboard: click it, then Home/End and arrow keys to the exact value. */
  async setSlider(label, value) {
    const info = await this.js(`(() => { const s = sliderOf(${JSON.stringify(label)}); return s && { min: Number(s.min), max: Number(s.max), step: Number(s.step) }; })()`);
    if (!info) throw new Error(`No slider called "${label}".`);
    const c = await this.centre(`sliderOf(${JSON.stringify(label)})`, `the ${label} slider`);
    await this.click(c.x, c.y); // focuses it (and moves it to the middle)
    const fromMin = Math.round((value - info.min) / info.step);
    const fromMax = Math.round((info.max - value) / info.step);
    if (fromMin <= fromMax) {
      await this.key("Home");
      for (let i = 0; i < fromMin; i++) await this.key("ArrowRight");
    } else {
      await this.key("End");
      for (let i = 0; i < fromMax; i++) await this.key("ArrowLeft");
    }
    const now = await this.js(`Number(sliderOf(${JSON.stringify(label)}).value)`);
    if (Math.abs(now - value) > info.step / 2 + 1e-9) throw new Error(`The ${label} slider is at ${now}, wanted ${value}.`);
    await this.painted();
  }

  async toggle(label) {
    await this.clickOn(`document.querySelector('button[role="switch"][aria-label=${JSON.stringify(label)}]')`, `the "${label}" switch`);
    await this.painted();
  }

  // --- pictures ------------------------------------------------------------------------

  /**
   * Take the picture. By default the mouse is parked on the empty middle of the
   * top bar and keyboard focus is dropped, so no hover or focus ring is in it.
   *   clip      { x, y, width, height, scale } in CSS pixels, to photograph part of the page
   *   fullPage  photograph the whole scrolling page, not just the viewport
   *   asIs      leave the mouse and focus alone (for "while the button is held" shots)
   * (snap() in main also takes sidebar: "bottom", which scrolls the right-hand sidebar down first.)
   */
  async capture(file, { clip, fullPage = false, asIs = false } = {}) {
    if (!asIs) {
      await this.mouse("mouseMoved", Math.round(this.viewport.width / 2), 28);
      await this.js(`(document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement.blur() : 0, true)`);
    }
    // Let one-off animations (an error banner sliding in) finish; endless ones (spinners, the pulsing dot) are left alone.
    await this.js(`Promise.race([Promise.allSettled(document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished)), new Promise((r) => setTimeout(r, 3000))]).then(() => true)`);
    await this.painted();
    // JPEG at quality 88: about a quarter of the size of PNG, and the text in the shots stays readable.
    const params = { format: "jpeg", quality: JPEG_QUALITY };
    if (fullPage) {
      const { cssContentSize } = await this.send("Page.getLayoutMetrics");
      params.clip = { x: 0, y: 0, width: Math.ceil(cssContentSize.width), height: Math.ceil(cssContentSize.height), scale: 1 };
      params.captureBeyondViewport = true;
    } else if (clip) {
      params.clip = { scale: 1, ...clip };
    }
    const { data } = await this.send("Page.captureScreenshot", params);
    writeFileSync(file, Buffer.from(data, "base64"));
  }

  async close() {
    this.browser.listeners.delete(this.listener);
    await this.browser.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------
// Making WebGL work in headless Chrome
// ---------------------------------------------------------------------------------

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
  const copy = document.createElement("canvas"); copy.width = 16; copy.height = 16;
  const g = copy.getContext("2d"); g.drawImage(canvas, 0, 0); const back = g.getImageData(8, 8, 1, 1).data;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return { ok: px[0] === 255 && px[3] === 255 && back[0] === 255 && back[3] === 255, readPixels: [...px], drawImage: [...back], renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
})()`;

/** Start Chrome with the first set of flags under which a WebGL2 canvas really draws and reads back. */
async function launchWithWebGL(chromePath, headed) {
  for (const flags of GPU_FLAG_SETS) {
    let browser;
    try {
      browser = await Browser.launch(chromePath, flags, headed);
      const page = await browser.newPage();
      const probe = await page.js(WEBGL_PROBE);
      await page.close();
      if (probe.ok) {
        console.log(`Chrome ${browser.version}; WebGL2 works with flags: ${flags.join(" ") || "(none needed)"}; renderer: ${probe.renderer}`);
        return browser;
      }
      console.log(`WebGL2 does not work with flags [${flags.join(" ") || "none"}]: ${JSON.stringify(probe)}`);
    } catch (error) {
      console.log(`Chrome failed with flags [${flags.join(" ") || "none"}]: ${error.message}`);
    }
    await browser?.close();
  }
  throw new Error("No set of Chrome flags gave a working WebGL2 canvas. Live shading cannot be photographed on this machine.");
}

// ---------------------------------------------------------------------------------
// Steps the shots share
// ---------------------------------------------------------------------------------

const PHOTO = {
  portrait: "01-portrait-astronaut.jpg",
  object: "02-object-coffee.jpg",
  cat: "03-animal-cat.jpg",
  dark: "04-dark-rocket.jpg",
  tall: "05-tall-astronaut-crop.jpg",
  wide: "06-wide-coffee-crop.jpg",
  tiny: "07-tiny-cat-200px.jpg",
  huge: "08-huge-astronaut-3000px.jpg",
  notAnImage: "not-an-image.txt",
};

/** Open the page, choose a photo and wait until it can be lit. */
async function openScene(t, photo = PHOTO.portrait, path = "/") {
  await t.page.goto(t.url + path);
  await t.page.upload(join(t.photos, photo));
  const started = Date.now();
  t.note.shading = await t.page.sceneReady();
  t.note.sceneSeconds = Number(((Date.now() - started) / 1000).toFixed(1));
}

/** Open a scene, pick the Left preset and run Enhance to the end. */
async function openEnhanced(t) {
  await openScene(t);
  await t.page.clickButton("Left");
  await t.page.clickButton("Enhance");
  await t.page.waitFor(
    `document.querySelector('button[role="tab"][aria-selected="true"]')?.textContent.trim() === "Enhanced" && [...document.querySelectorAll('img[alt="Enhanced"], img[alt="Live preview"]')].length === 2 && [...document.querySelectorAll('img[alt="Enhanced"], img[alt="Live preview"]')].every((i) => i.complete && i.naturalWidth > 0)`,
    "the Enhanced tab with both pictures",
    120_000,
  );
}

/** A magnified picture of the right end of the top bar, where the backend status pill is. */
const statusClip = (t) => ({ clip: { x: t.page.viewport.width - 480, y: 0, width: 480, height: 56, scale: 3 } });

// ---------------------------------------------------------------------------------
// The shots, in the order a tester meets them.
// needs: "backend" = frontend on a MOCK_MODE=1 backend, "mock" = frontend mock mode.
// ---------------------------------------------------------------------------------

const SHOTS = [
  {
    name: "landing",
    about: "The first page at \"/\" before any photo is chosen.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await t.snap();
    },
  },
  {
    name: "upload-empty",
    about: "The same empty upload page at \"/relight\", with the mouse resting on the dashed drop box.",
    async run(t) {
      await t.page.goto(t.url + "/relight");
      const c = await t.page.centre(`document.querySelector('div[role="button"]')`, "the drop box");
      await t.page.mouse("mouseMoved", c.x, c.y + 60);
      await t.snap({ asIs: true });
    },
  },
  {
    name: "scene-loading",
    about: "Just after choosing a photo, while the backend is still working out depth and normals.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await t.page.route("/relight/scene", "hold");
      await t.page.upload(join(t.photos, PHOTO.portrait));
      await t.page.waitFor(`document.body.innerText.includes("Estimating depth and surface normals") && !!document.querySelector(".skeleton")`, "the loading overlay");
      await t.snap({ sidebar: "bottom" });
      await t.page.release();
      t.note.shading = await t.page.sceneReady();
    },
  },
  {
    name: "scene-default-light",
    about: "Portrait photo loaded, nothing touched: the light is at its starting place.",
    async run(t) {
      await openScene(t);
      await t.snap();
    },
  },
  {
    name: "scene-all-panels",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "The same loaded scene in a taller window (1440 x 1300), so all three sidebar panels show at once without scrolling.",
    async run(t) {
      await openScene(t);
      await t.snap();
    },
  },
  ...[
    ["preset-left", "Left"],
    ["preset-right", "Right"],
    ["preset-top", "Top"],
    ["preset-low-and-warm", "Low and warm"],
  ].map(([name, label]) => ({
    name,
    about: `Portrait photo after clicking the "${label}" preset button.`,
    async run(t) {
      await openScene(t);
      await t.page.clickButton(label);
      await t.snap();
    },
  })),
  ...[
    ["drag-far-left", 0.03, 0.5, "the left edge of the photo, half way down"],
    ["drag-far-right", 0.97, 0.5, "the right edge of the photo, half way down"],
    ["drag-top", 0.5, 0.03, "the top edge of the photo, in the middle"],
    ["drag-outside-photo", 1.4, 0.3, "the dark area to the right of the photo (outside the picture)"],
    ["drag-centre", 0.5, 0.45, "the middle of the photo, on the face"],
  ].map(([name, x, y, where]) => ({
    name,
    about: `Portrait photo with the sun handle dragged with the mouse to ${where}.`,
    async run(t) {
      await openScene(t);
      await t.page.dragLight(x, y);
      await t.snap();
    },
  })),
  ...[
    ["height-min", "Height", 0.03, "all the way left (0.03)"],
    ["height-max", "Height", 2, "all the way right (2.00)"],
    ["intensity-low", "Intensity", 0, "all the way left (0.00)"],
    ["intensity-high", "Intensity", 4, "all the way right (4.00)"],
    ["ambient-low", "Ambient", 0, "all the way left (0.00)"],
    ["ambient-high", "Ambient", 1, "all the way right (1.00)"],
    ["colour-warm", "Colour", 1, "all the way right (warm 100)"],
    ["colour-cool", "Colour", -1, "all the way left (cool 100)"],
  ].map(([name, slider, value, where]) => ({
    name,
    about: `Portrait photo, "Left" preset clicked, then the ${slider} slider moved ${where}.`,
    async run(t) {
      await openScene(t);
      await t.page.clickButton("Left");
      await t.page.setSlider(slider, value);
      await t.snap();
    },
  })),
  {
    name: "shadows-on",
    about: "Object photo, \"Left\" preset, Height 0.10, Cast shadows ON (the default).",
    async run(t) {
      await openScene(t, PHOTO.object);
      await t.page.clickButton("Left");
      await t.page.setSlider("Height", 0.1);
      await t.snap();
    },
  },
  {
    name: "shadows-off",
    about: "Exactly the same light as shadows-on, with the Cast shadows switch turned OFF.",
    async run(t) {
      await openScene(t, PHOTO.object);
      await t.page.clickButton("Left");
      await t.page.setSlider("Height", 0.1);
      await t.page.toggle("Cast shadows");
      await t.snap();
    },
  },
  {
    name: "detailed-normals-on",
    about: "Portrait photo, \"Left\" preset, Detailed normals ON (the default). Look at the Normals thumbnail.",
    async run(t) {
      await openScene(t);
      await t.page.clickButton("Left");
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "detailed-normals-off",
    about: "The same, after turning the Detailed normals switch OFF and waiting for the photo to be analysed again.",
    async run(t) {
      await openScene(t);
      await t.page.toggle("Detailed normals");
      await t.page.waitFor(`document.body.innerText.includes("Estimating depth") || document.querySelector('button[role="switch"][aria-label="Detailed normals"]').getAttribute("aria-checked") === "false"`, "the switch to turn off");
      t.note.shading = await t.page.sceneReady();
      await t.page.clickButton("Left");
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "hold-original",
    about: "Portrait photo, \"Left\" preset, while the \"Hold to see original\" button is held down.",
    async run(t) {
      await openScene(t);
      await t.page.clickButton("Left");
      const c = await t.page.centre(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Hold to see original")`, "the Hold to see original button");
      await t.page.mouse("mouseMoved", c.x, c.y);
      await t.page.mouse("mousePressed", c.x, c.y, 1);
      await t.page.waitFor(`!!byText("span", "Original")`, "the Original tag");
      await t.snap({ asIs: true });
      await t.page.mouse("mouseReleased", c.x, c.y, 0);
      await t.page.waitFor(`!byText("span", "Original")`, "the Original tag to go away");
    },
  },
  {
    name: "enhance-before",
    about: "Portrait photo, \"Left\" preset, a mood typed into the Enhance box, before clicking Enhance.",
    async run(t) {
      await openScene(t);
      await t.page.clickButton("Left");
      await t.page.clickOn(`document.querySelector("textarea")`, "the Enhance text box");
      await t.page.send("Input.insertText", { text: "golden hour" });
      await t.page.waitFor(`document.querySelector("textarea").value === "golden hour"`, "the typed text");
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "enhance-running",
    about: "Straight after clicking Enhance, while the job is still running.",
    async run(t) {
      await openScene(t);
      await t.page.clickButton("Left");
      if (t.mode === "backend") await t.page.route("/jobs/", "hold");
      await t.page.clickButton("Enhance");
      await t.page.waitFor(`document.body.innerText.includes("Enhancing in the background") && !!byText('button[role="tab"]', "Enhancing…")`, "the Enhancing pill and tab");
      await t.snap({ sidebar: "bottom" });
      await t.page.release();
    },
  },
  {
    name: "enhance-done",
    about: "Enhance finished: the stage has switched to the Enhanced tab with the before/after divider in the middle.",
    async run(t) {
      await openEnhanced(t);
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "enhance-divider-dragged",
    about: "The Enhanced tab with the round divider handle dragged to the left, a quarter of the way across.",
    async run(t) {
      await openEnhanced(t);
      const from = await t.page.centre(`document.querySelector('[role="slider"][aria-label="Comparison divider"]')`, "the comparison divider");
      const box = await t.page.js(`rectOf(document.querySelector('[role="slider"][aria-label="Comparison divider"]').parentElement)`);
      await t.page.drag(from, { x: box.x + box.w * 0.25, y: from.y });
      t.note.divider = await t.page.js(`Number(document.querySelector('[role="slider"][aria-label="Comparison divider"]').getAttribute("aria-valuenow"))`);
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "enhance-back-to-live",
    about: "After an Enhance, back on the \"Live preview\" tab: the button now reads \"Enhance again\".",
    async run(t) {
      await openEnhanced(t);
      await t.page.clickOn(`byText('button[role="tab"]', "Live preview")`, "the Live preview tab");
      await t.page.waitFor(`!!lightHandle() && document.querySelector('button[role="tab"][aria-selected="true"]').textContent.trim() === "Live preview"`, "the live preview");
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "sample-photo",
    about: "After clicking \"Use a sample photo\": the built-in orange ball.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await t.page.clickButton("Use a sample photo");
      t.note.shading = await t.page.sceneReady();
      await t.snap();
    },
  },
  {
    name: "object-side-light",
    about: "The coffee cup photo with the \"Right\" preset.",
    async run(t) {
      await openScene(t, PHOTO.object);
      await t.page.clickButton("Right");
      await t.snap();
    },
  },
  {
    name: "cat-side-light",
    about: "The cat photo with the \"Left\" preset.",
    async run(t) {
      await openScene(t, PHOTO.cat);
      await t.page.clickButton("Left");
      await t.snap();
    },
  },
  {
    name: "dark-photo",
    about: "The dark night-time rocket photo with the \"Left\" preset.",
    async run(t) {
      await openScene(t, PHOTO.dark);
      await t.page.clickButton("Left");
      await t.snap();
    },
  },
  {
    name: "tall-photo",
    about: "A tall, narrow photo with the \"Left\" preset (layout check).",
    async run(t) {
      await openScene(t, PHOTO.tall);
      await t.page.clickButton("Left");
      await t.snap();
    },
  },
  {
    name: "wide-photo",
    about: "A wide, short photo with the \"Top\" preset (layout check).",
    async run(t) {
      await openScene(t, PHOTO.wide);
      await t.page.clickButton("Top");
      await t.snap();
    },
  },
  {
    name: "tiny-photo",
    about: "A very small photo (200 x 133 px) with the \"Left\" preset. It is stretched to fill the stage, so it looks soft.",
    async run(t) {
      await openScene(t, PHOTO.tiny);
      await t.page.clickButton("Left");
      await t.snap();
    },
  },
  {
    name: "huge-photo",
    about: "A very large photo (3000 x 3000 px) with the \"Left\" preset. The app shrinks it before use.",
    async run(t) {
      await openScene(t, PHOTO.huge);
      await t.page.clickButton("Left");
      await t.snap();
    },
  },
  {
    name: "error-not-an-image",
    about: "A text file was given instead of a picture: a red error appears under the drop box.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await t.page.upload(join(t.photos, PHOTO.notAnImage));
      await t.page.waitFor(`alerts().length > 0`, "the error banner");
      t.note.error = (await t.page.js("alerts()"))[0];
      await t.snap();
    },
  },
  {
    name: "backend-offline",
    needs: "backend",
    about: "The first page when the backend is not running: the status pill is red and reads \"offline\".",
    async run(t) {
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/");
      await t.page.waitFor(`statusPill().textContent.includes("offline")`, "the offline status");
      await t.snap();
    },
  },
  {
    name: "backend-offline-upload",
    needs: "backend",
    about: "A photo chosen while the backend is not running: a red error with Retry above the stage.",
    async run(t) {
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/");
      await t.page.upload(join(t.photos, PHOTO.portrait));
      await t.page.waitFor(`alerts().length > 0 && !!photoBox()`, "the error banner above the stage");
      t.note.error = (await t.page.js("alerts()"))[0];
      await t.snap();
    },
  },
  {
    name: "enhance-error",
    needs: "backend",
    about: "The backend stopped after the photo was loaded, then Enhance was clicked: a red error inside the Enhance panel.",
    async run(t) {
      await openScene(t);
      await t.page.clickButton("Left");
      await t.page.route(t.api, "fail");
      await t.page.clickButton("Enhance");
      await t.page.waitFor(`alerts().length > 0`, "the error banner in the Enhance panel");
      t.note.error = (await t.page.js("alerts()"))[0];
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "phone-scene",
    viewport: PHONE,
    about: "A phone-sized window (390 x 844) with the portrait photo loaded: what you see before scrolling.",
    async run(t) {
      await openScene(t);
      await t.snap();
    },
  },
  {
    name: "phone-full-page",
    viewport: PHONE,
    about: "The same phone-sized page photographed from top to bottom, as if you scrolled all the way down.",
    async run(t) {
      await openScene(t);
      await t.snap({ fullPage: true });
    },
  },
  {
    name: "phone-landing",
    viewport: PHONE,
    about: "The empty upload page in a phone-sized window.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await t.snap();
    },
  },
  {
    name: "status-checking",
    needs: "backend",
    about: "Close-up of the status pill in the top right during the first moment after the page opens: grey dot, \"checking\".",
    async run(t) {
      await t.page.route("/health", "hold");
      await t.page.goto(t.url + "/", { settleStatus: false });
      await t.page.waitFor(`statusPill().textContent.includes("checking")`, "the checking status");
      await t.snap(statusClip(t));
      await t.page.release();
    },
  },
  {
    name: "status-online-mock-providers",
    needs: "backend",
    about: "Close-up of the status pill when the backend runs with MOCK_MODE=1: amber dot, \"online, mock providers\".",
    async run(t) {
      await t.page.goto(t.url + "/");
      await t.page.waitFor(`statusPill().textContent.includes("online, mock providers")`, "the online, mock providers status");
      t.note.tooltip = (await t.page.status()).title;
      await t.snap(statusClip(t));
    },
  },
  {
    name: "status-online",
    needs: "backend",
    about: "Close-up of the status pill when the backend runs for real (MOCK_MODE=0): green dot, \"online\".",
    async run(t) {
      await t.page.route("/health", "health-live");
      await t.page.goto(t.url + "/");
      await t.page.waitFor(`statusPill().querySelector("span.font-medium").textContent.trim() === "online"`, "the online status");
      t.note.tooltip = (await t.page.status()).title;
      t.note.how = "The backend was not run with MOCK_MODE=0. Its /health reply was changed on the way to the page.";
      await t.snap(statusClip(t));
    },
  },
  {
    name: "status-offline",
    needs: "backend",
    about: "Close-up of the status pill when the backend is not running: red dot, \"offline\".",
    async run(t) {
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/");
      await t.page.waitFor(`statusPill().textContent.includes("offline")`, "the offline status");
      t.note.tooltip = (await t.page.status()).title;
      await t.snap(statusClip(t));
    },
  },
  {
    name: "no-webgl-fallback",
    needs: "backend",
    about: "A browser without WebGL2: a red notice above the stage, and the picture comes from the server instead.",
    async run(t) {
      await t.page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => { const real = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return kind === "webgl2" ? null : real.call(this, kind, ...rest); }; })();`,
      });
      await openScene(t);
      await t.page.clickButton("Left");
      await t.page.waitFor(`new Promise((r) => setTimeout(() => r(document.querySelector('img[alt="Relit photo"]')?.complete === true), 900))`, "the server render for the new light");
      await t.snap();
    },
  },
  {
    name: "not-found-page",
    about: "An address that no longer exists (\"/autocomplete\"): the plain 404 page.",
    async run(t) {
      await t.page.send("Page.navigate", { url: t.url + "/autocomplete" });
      await t.page.waitFor(`document.readyState === "complete" && document.body.innerText.includes("404")`, "the 404 page");
      await t.snap();
    },
  },
  {
    name: "mock-landing",
    needs: "mock",
    about: "Frontend mock mode (no backend): the first page, status pill yellow \"mock\".",
    async run(t) {
      await t.page.goto(t.url + "/");
      await t.snap();
    },
  },
  {
    name: "mock-status",
    needs: "mock",
    about: "Close-up of the status pill in frontend mock mode: yellow dot, \"mock\".",
    async run(t) {
      await t.page.goto(t.url + "/");
      t.note.tooltip = (await t.page.status()).title;
      await t.snap(statusClip(t));
    },
  },
  {
    name: "mock-scene",
    needs: "mock",
    about: "Frontend mock mode with the portrait photo and the \"Left\" preset: the shading is a made-up round dome, not the real face.",
    async run(t) {
      await openScene(t);
      await t.page.clickButton("Left");
      await t.snap();
    },
  },
  {
    name: "mock-enhance-running",
    needs: "mock",
    about: "Frontend mock mode, straight after clicking Enhance.",
    async run(t) {
      await openScene(t);
      await t.page.clickButton("Left");
      await t.page.clickButton("Enhance");
      await t.page.waitFor(`document.body.innerText.includes("Enhancing in the background") && !!byText('button[role="tab"]', "Enhancing…")`, "the Enhancing pill and tab");
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "mock-enhance-done",
    needs: "mock",
    about: "Frontend mock mode after Enhance finished: the right half has more contrast and a soft glow.",
    async run(t) {
      await openEnhanced(t);
      await t.snap({ sidebar: "bottom" });
    },
  },
];

const numbered = SHOTS.map((shot, i) => ({ ...shot, needs: shot.needs ?? "any", file: `${String(i + 1).padStart(2, "0")}-${shot.name}.jpg` }));

function selectShots(only) {
  if (!only) return numbered;
  const picked = [];
  for (const want of only) {
    const key = want.replace(/\.(jpe?g|png)$/, "");
    const hit = numbered.filter((s) => s.name === key || s.file === `${key}.jpg` || s.file.slice(0, 2) === key.padStart(2, "0"));
    if (!hit.length) throw new Error(`No shot called "${want}". Run with --list to see the names.`);
    picked.push(...hit);
  }
  return [...new Set(picked)];
}

// ---------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return void console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 40).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  if (args.list) return void numbered.forEach((s) => console.log(`${s.file.padEnd(40)} [${s.needs.padEnd(7)}] ${s.about}`));
  if (!args.url) throw new Error("Give the frontend URL, for example: node tools/screenshots.mjs http://localhost:3123   (or --list)");
  if (typeof WebSocket === "undefined") throw new Error("This Node has no built-in WebSocket. Use Node 22 or newer.");

  const shots = selectShots(args.only);
  mkdirSync(args.out, { recursive: true });

  let browser = null;
  const stop = async () => {
    const b = browser;
    browser = null;
    await b?.close();
  };
  process.on("SIGINT", () => void stop().then(() => process.exit(130)));
  process.on("SIGTERM", () => void stop().then(() => process.exit(143)));

  const results = [];
  try {
    browser = await launchWithWebGL(args.chrome, args.headed);

    // What is the app running as? Read it off the status pill.
    const probe = await browser.newPage();
    try {
      await probe.goto(args.url + "/");
    } catch (error) {
      throw new Error(`Could not open the frontend at ${args.url}. Is it running?\n  ${error.message}`);
    }
    const status = await probe.status();
    await probe.close();
    const mode = status.label === "mock" ? "mock" : "backend";
    const api = (status.title.match(/https?:\/\/[^\s)]+/) ?? [null])[0];
    console.log(`Frontend ${args.url}: status "${status.label}"${api ? `, backend ${api}` : ""}. Running the ${mode === "mock" ? "frontend-mock" : "backend"} shots.`);
    if (mode === "backend" && status.label !== "online, mock providers" && !(args.backendStopped && status.label === "offline")) {
      throw new Error(`The status pill reads "${status.label}", not "online, mock providers". Start the backend with MOCK_MODE=1 (this tool never drives a backend that could call a paid API).`);
    }

    for (const shot of shots) {
      const file = join(args.out, shot.file);
      // "any" shots are taken on the backend setup, so one full set shows one consistent app.
      const fits = shot.needs === mode || (shot.needs === "any" && (mode === "backend" || args.only));
      if (!fits) {
        console.log(`skip  ${shot.file}  (needs ${shot.needs === "mock" ? "frontend mock mode" : "the backend"}; the app is running ${mode === "mock" ? "in frontend mock mode" : "on the backend"})`);
        results.push({ file: shot.file, name: shot.name, status: "skipped" });
        continue;
      }
      const page = await browser.newPage(shot.viewport ?? DESKTOP);
      const note = {};
      const started = Date.now();
      try {
        const t = {
          page,
          url: args.url,
          api,
          mode,
          photos: args.photos,
          note,
          snap: async (options = {}) => {
            // The sidebar is taller than a 900 px window: show its top, or its bottom when the shot is about Enhance or Geometry.
            await page.js(`(document.querySelector("aside")?.scrollTo(0, ${options.sidebar === "bottom" ? 100000 : 0}), true)`);
            note.light = await page.light();
            const mainText = await page.js(`document.body.innerText`);
            if (mainText.includes("Live shading is unavailable")) note.shading = "server";
            await page.capture(file, options);
          },
        };
        await shot.run(t);
        const light = note.light ? `light x ${note.light.x} y ${note.light.y}` : "";
        const fallback = note.shading === "server" ? "  ** SERVER-RENDER FALLBACK, not the live canvas **" : "";
        console.log(`ok    ${shot.file}  ${((Date.now() - started) / 1000).toFixed(1)} s  ${note.shading ?? ""} ${light}${fallback}`);
        results.push({ file: shot.file, name: shot.name, status: "ok", about: shot.about, viewport: `${(shot.viewport ?? DESKTOP).width}x${(shot.viewport ?? DESKTOP).height}`, appMode: mode, ...note, console: page.console.slice() });
      } catch (error) {
        console.log(`FAIL  ${shot.file}  ${error.message}`);
        results.push({ file: shot.file, name: shot.name, status: "failed", error: error.message, console: page.console.slice() });
      }
      if (page.console.length) for (const line of [...new Set(page.console)]) console.log(`        page ${line}`);
      await page.release().catch(() => {});
      await page.close();
    }
  } finally {
    await stop();
  }

  // Keep one manifest for the whole set: update the entries that were just taken.
  const manifestFile = join(args.out, "manifest.json");
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {
    // first run
  }
  for (const r of results) if (r.status === "ok") manifest[r.file] = r;
  const ordered = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
  writeFileSync(manifestFile, JSON.stringify(ordered, null, 2) + "\n");

  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${count("ok")} taken, ${count("skipped")} skipped, ${count("failed")} failed. Files are in ${args.out}`);
  if (count("failed")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exit(1);
});
