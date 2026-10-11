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
//   --describe       rewrite the "about" and "see" text in manifest.json from this file and exit (no pictures are taken).
//   --out DIR        where the JPEGs go.           Default: <repo>/testing/screenshots
//   --photos DIR     where the test photos are.    Default: <repo>/testing/photos
//   --chrome PATH    the Chrome binary.            Default: the macOS Google Chrome app, or $CHROME_PATH
//   --headed         show the browser window instead of running headless (for debugging the tool).
//   --backend-stopped  say that the backend process really is stopped (pill reads "offline"). Use it with
//                    --only stopped to photograph the real thing: "stopped" picks every shot that never
//                    needs a reply from the backend (the offline pages and the samples used without it).
//
// WHAT THE APP MUST BE RUNNING AS
//   Most shots need the frontend talking to a backend that runs with MOCK_MODE=1
//   (the status pill reads "online, mock providers"):
//     cd backend  && MOCK_MODE=1 .venv/bin/python -m uvicorn app.main:app --port 8123
//     cd frontend && NEXT_PUBLIC_MOCK=0 NEXT_PUBLIC_API_URL=http://localhost:8123 npm run dev -- --port 3123
//   The shots named "mock-..." need the frontend alone in its own mock mode (pill reads "mock"):
//     cd frontend && NEXT_PUBLIC_MOCK=1 npm run dev -- --port 3123
//   Next.js refuses a second "npm run dev" in a folder where one is already running. Then build and
//   serve instead, with the same variables on the build (they are read at build time), one setup at a time:
//     cd frontend && NEXT_PUBLIC_MOCK=0 NEXT_PUBLIC_API_URL=http://localhost:8123 npm run build && npx next start --port 3123
//     cd frontend && NEXT_PUBLIC_MOCK=1 npm run build && npx next start --port 3123
//   and finish with a plain "npm run build", so the build folder is not left set up for port 8123 or mock mode.
//   The shots named "demo-..." need the static demo build (pill reads "demo: runs in your browser",
//   or just "demo" on a phone),
//   served from a folder that matches the base path it was built for (see frontend/README.md):
//     cd frontend && npm run build:demo
//     python3 -m http.server 3199 --directory <folder that holds a copy of out/>
//     node tools/screenshots.mjs http://localhost:3199
//   The tool reads the status pill first and skips the shots that do not fit, saying so.
//   The four built-in sample photos come from static files, so their shots work in either setup.
//   The shots of a photo analysed in the browser download the open depth model from huggingface.co
//   (19 MB) and the code that runs it from cdn.jsdelivr.net, so they need the internet.
//
// HOW THE SPECIAL STATES ARE PRODUCED (nothing here changes the app or the backend)
//   - "Backend offline": the browser's requests to the backend are refused inside Chrome.
//     The page sees exactly what it sees when the backend process is stopped.
//   - "Loading" and "Enhancing": the backend's reply is held back until the picture is taken.
//   - Status "online" (green): the real /health reply is passed on with mock_mode changed to false.
//     The backend itself is never run with MOCK_MODE=0, so no paid API is called.
//   - A weaker device: a script that runs before the page's own code takes one ability away from
//     the browser, the way the developers do when they check each fallback (see "A weaker device" below):
//       no WebGL2 at all          canvas.getContext("webgl2") returns null         -> the processor shades
//       no float colour buffers   the two colour-buffer extensions are not offered -> "compatibility mode"
//       no float filtering        OES_texture_float_linear is not offered          -> nothing changes
//       no Workers                new Worker(...) throws                           -> the processor, on the page's own thread
//       a broken shader compiler  every shader reports that it did not compile     -> the processor shades
//       no 2D canvas either       canvas.getContext("2d") returns null as well     -> nothing here can shade: the red bar
//     A slow processor is made with Chrome's own CPU throttle, and a graphics chip that stops
//     responding with WebGL's own "lose context" test hook.
//   - A photo analysed in the browser, stopped part of the way: the depth model runs in a Worker that
//     tells the page how far it has got. From one chosen message on, the tool keeps those messages
//     back until the picture is taken, so the page stays on that line. The Worker itself is not slowed.
//   - "The depth model cannot be downloaded": requests to huggingface.co are refused inside Chrome,
//     after this browser's stored copy of the model has been deleted.
//   - An image dragged from another web site: a real drop, made by Chrome itself, of the address of
//     a picture on a small web server that the tool starts on another port for that one shot. That
//     server answers the way a site does that lets no other page read its pictures (most do not).
//   - An iPhone photo (HEIC): Chrome cannot read one itself, so the page fetches a converter from
//     cdn.jsdelivr.net; those shots need the internet. "Converting your photo…" is kept on screen by
//     holding that download back, and "the converter could not be downloaded" by refusing it. The
//     photo that is too large to convert is made on the spot with macOS's own converter (sips).
//   - The light's distance: the mouse wheel and a two-finger pinch are Chrome's own wheel and touch
//     input, sent to the sun on the photo.
//   - A tooltip (the text that appears when the mouse rests on a control) cannot be photographed
//     headless. Where one matters, its text is read from the page into manifest.json instead.
//
// It also writes <out>/manifest.json: for each shot the file, what it shows, the
// light position read from the page and how the photo was being shaded when it was taken
// ("shading": webgl, cpu, server or none; "shadingPath": the exact path, such as gpu-packed).

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const PHONE = { width: 390, height: 844, scale: 2, mobile: true };
const JPEG_QUALITY = 88;
/**
 * Processor shading: how long the canvas must have held its full-quality picture
 * before it is photographed, in milliseconds. The page starts that picture 180 ms
 * after the light stops (SETTLE_MS in frontend/lib/relightCPU.ts); this has to be
 * longer, or a picture of the light before could pass for the finished one.
 * Longer only makes each of those shots slower.
 */
const CPU_SHARP_WATCH_MS = 400;
/** Where the mouse is parked for a picture, in CSS pixels from the left: the top bar's own padding, left of the "Relight" name, where nothing reacts to it at any width. */
const MOUSE_PARK_X = 4;

// ---------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { url: null, only: null, list: false, headed: false, out: join(REPO, "testing", "screenshots"), photos: join(REPO, "testing", "photos"), chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") args.list = true;
    else if (a === "--describe") args.describe = true;
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
  const ACCENT = "rgb(251, 209, 61)"; // --color-accent in globals.css, as getComputedStyle reports it
  const shadingNote = () => [...document.querySelectorAll('p[role="status"]')].map((e) => e.textContent.trim()).find((x) => x.startsWith("Shading on this device") || x.startsWith("This device's processor")) ?? null;
  const shadingLine = () => [...document.querySelectorAll("aside p.font-mono span[title]")].find((e) => e.textContent.trim().startsWith("shading:")) ?? null;
  const depthLine = () => document.querySelector("aside p.font-mono span[data-depth-device]");
  const busyText = () => photoBox()?.querySelector('svg[role="status"]')?.parentElement.innerText.trim() ?? null; // the line beside the spinner on the photo
  const howPanel = () => document.querySelector("header dialog");
  const alerts = () => [...document.querySelectorAll('[role="alert"]')].filter((e) => e.offsetParent !== null).map((e) => e.querySelector("p")?.textContent.trim() ?? e.textContent.trim());
`;

const KEYS = { Escape: 27, Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, "+": 187, "-": 189 };

class Page {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.console = []; // errors and warnings the page logged
    this.rules = []; // network rules, see route()
    this.held = [];
    this.seen = []; // every request made while a rule was in force, for "nothing was asked of the backend"
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
   *   "watch"       let it through; it is only written down in this.seen
   */
  async route(fragment, action) {
    this.rules.push({ fragment, action });
    await this.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  }

  async onPaused({ requestId, request }) {
    const rule = this.rules.find((r) => request.url.includes(r.fragment));
    this.seen.push(`${request.method} ${request.url}`);
    // CORS preflights are let through so that only the real request is affected.
    if (!rule || request.method === "OPTIONS") return void (await this.send("Fetch.continueRequest", { requestId }));
    if (rule.action === "fail") return void (await this.send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }));
    if (rule.action === "hold") return void this.held.push(requestId);
    if (rule.action === "watch") return void (await this.send("Fetch.continueRequest", { requestId }));
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

  /** Turn the mouse wheel at a point: `deltaY` in pixels, negative for "up" (a wheel's notch is about 100). */
  async wheel(x, y, deltaY) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, button: "none", buttons: 0, pointerType: "mouse" });
  }

  /** Fingers on a touch screen: `type` is touchStart, touchMove or touchEnd, `points` is where every finger now is ([] once all are lifted). */
  async touch(type, points) {
    await this.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })) });
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
   * Wait until the photo is analysed and shaded. Returns "webgl" when the
   * graphics chip is drawing the live canvas, "cpu" when the processor is (and
   * its full-quality picture is up), or "server" when the picture is a render
   * from the server. Fails if the canvas is blank.
   */
  async sceneReady(timeout = 240_000) {
    const mode = await this.waitFor(
      `(() => {
        const text = document.body.innerText;
        if (text.includes("Estimating depth") || text.includes("Preparing the shader")) return false;
        if (!photoBox() || busyText()) return false; // busyText: the lines shown while the browser analyses a photo itself
        const unavailable = text.includes("Live shading is unavailable");
        if (alerts().length && !unavailable) return "error";
        if (unavailable || text.includes("so the server draws the photo instead")) return document.querySelector('img[alt="Relit photo"]')?.complete ? "server" : false;
        const canvas = document.querySelector("canvas");
        if (!canvas || canvas.classList.contains("opacity-0") || !lightHandle()) return false;
        if (![...document.querySelectorAll('img[alt$=" map"]')].every((i) => i.complete && i.naturalWidth > 0)) return false;
        const path = canvas.dataset.shading ?? "";
        if (path.startsWith("cpu")) return canvas.dataset.quality === "full" ? "cpu" : false;
        return path.startsWith("gpu") ? "webgl" : false;
      })()`,
      "the photo to be analysed and shaded",
      timeout,
    );
    if (mode === "error") throw new Error(`The page shows an error instead of the scene: ${JSON.stringify(await this.js("alerts()"))}`);
    if (mode === "webgl" || mode === "cpu") {
      const check = await this.canvasCheck();
      if (!check.ok) throw new Error(`The live canvas is blank (${JSON.stringify(check)}). Chrome flags: ${this.browser.flags.join(" ") || "(none)"}`);
    }
    await this.painted();
    return mode;
  }

  /**
   * On the processor the picture is a soft preview while the light moves and the
   * full one follows once it has been still for a moment. Wait for the full one:
   * the canvas has to say "full" for CPU_SHARP_WATCH_MS without a break, because
   * straight after a click it still says so about the light before.
   */
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

  /** Read the live canvas back: is it drawn at all, and does it differ from the plain photo? */
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

  /**
   * Drop something on a point of the page, the way a drag from another window
   * ends. `items` is what the drag carries: [{ mimeType, data }], for example
   * the "text/uri-list" and "text/html" a picture dragged out of a web page has.
   */
  async drop(x, y, items) {
    const data = { items, dragOperationsMask: 1 }; // 1 = copy
    for (const type of ["dragEnter", "dragOver", "drop"]) await this.send("Input.dispatchDragEvent", { type, x, y, data });
  }

  // --- pictures ------------------------------------------------------------------------

  /**
   * Take the picture. By default the mouse is parked at the empty left end of the
   * top bar and keyboard focus is dropped, so no hover or focus ring is in it.
   *   clip      { x, y, width, height, scale } in CSS pixels, to photograph part of the page
   *   fullPage  photograph the whole scrolling page, not just the viewport
   *   asIs      leave the mouse and focus alone (for "while the button is held" shots)
   *   quick     do not wait for animations to end (for a picture taken during the Sweep)
   * (snap() in main also takes sidebar: "bottom", which scrolls the right-hand sidebar down first.)
   */
  async capture(file, { clip, fullPage = false, asIs = false, quick = false } = {}) {
    if (!asIs) {
      await this.mouse("mouseMoved", MOUSE_PARK_X, 28);
      await this.js(`(document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement.blur() : 0, true)`);
    }
    // Let one-off animations (an error banner sliding in) finish; endless ones (spinners, the pulsing dot) are left alone.
    // "quick" skips the wait, for a picture of something that is moving (the Sweep).
    if (!quick) await this.js(`Promise.race([Promise.allSettled(document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished)), new Promise((r) => setTimeout(r, 3000))]).then(() => true)`);
    if (!quick) await this.painted();
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
    // No file name: the picture is handed back instead, for a shot that is put together from two (sideBySide).
    if (file === null) return data;
    writeFileSync(file, Buffer.from(data, "base64"));
  }

  /**
   * A clip for capture() around the element the in-page expression returns, scrolled into view first.
   * `pad` is the margin kept round it in CSS pixels, `scale` the magnification.
   * The clip is in page coordinates, which is what Chrome wants once the page has scrolled.
   */
  async clipOf(elementExpression, what, { pad = 12, scale = 2, block = "center" } = {}) {
    const r = await this.js(`(() => { const e = ${elementExpression}; if (!e) return null; e.scrollIntoView({ block: ${JSON.stringify(block)}, inline: "nearest", behavior: "instant" }); const r = rectOf(e); return { ...r, x: r.x + window.scrollX, y: r.y + window.scrollY }; })()`);
    if (!r || r.w === 0) throw new Error(`Could not find on the page: ${what}`);
    return { clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + 2 * pad, height: r.h + 2 * pad, scale } };
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
  heic: "09-iphone-portrait.heic",
  heicSideways: "10-iphone-sideways.heic",
  heic12mp: "11-iphone-12mp.heic",
  heicBroken: "broken-photo.heic",
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

/** Open the page and click one of the four built-in sample thumbnails ("Portrait", "Coffee cup", "Cat", "Rocket"). No backend is needed. */
async function openSample(t, label = "Portrait", path = "/") {
  await t.page.goto(t.url + path, { settleStatus: !t.page.rules.length });
  await clickSample(t, label);
  const started = Date.now();
  t.note.shading = await t.page.sceneReady();
  t.note.sceneSeconds = Number(((Date.now() - started) / 1000).toFixed(1));
  t.note.sample = label;
}

async function clickSample(t, label) {
  const button = `document.querySelector('button[aria-label=${JSON.stringify("Sample photo: " + label)}]')`;
  await t.page.waitFor(`(() => { const b = ${button}; return !!b && b.querySelector("img").complete && b.querySelector("img").naturalWidth > 0; })()`, `the "${label}" sample thumbnail`);
  await t.page.clickOn(button, `the "${label}" sample thumbnail`);
}

/** Open the GEOMETRY panel at the bottom of the sidebar (it starts folded away). */
async function openGeometry(t) {
  const header = `[...document.querySelectorAll("aside button[aria-expanded]")].find((b) => b.textContent.includes("Geometry"))`;
  if (await t.page.js(`${header}?.getAttribute("aria-expanded") === "true"`)) return;
  await t.page.clickOn(header, "the GEOMETRY panel header");
  await t.page.waitFor(`${header}.getAttribute("aria-expanded") === "true" && !!document.querySelector('button[role="switch"][aria-label="Detailed normals"]')?.offsetParent`, "the GEOMETRY panel to open");
  await sleep(450); // the sidebar scrolls the panel into view smoothly
}

// ----- A weaker device. Each of these runs a script before the page's own code on every page loaded from now on. -----

/** Run `source` in the page before anything of its own, on every page loaded from now on. */
const beforeLoad = (t, source) => t.page.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { ${source} })();` });

/** No WebGL2: canvas.getContext("webgl2") returns null, as in an old browser or with the graphics chip switched off. The processor shades instead. */
const withoutWebGL2 = (t) =>
  beforeLoad(t, `const real = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return kind === "webgl2" ? null : real.call(this, kind, ...rest); };`);

/** WebGL2 without the named extensions, as on a graphics chip that does not offer them. */
const withoutExtensions = (t, names) =>
  beforeLoad(
    t,
    `const gone = ${JSON.stringify(names)}; const proto = WebGL2RenderingContext.prototype; const get = proto.getExtension, list = proto.getSupportedExtensions;
     proto.getExtension = function (name) { return gone.includes(name) ? null : get.call(this, name); };
     proto.getSupportedExtensions = function () { return (list.call(this) ?? []).filter((name) => !gone.includes(name)); };`,
  );
/** The two extensions that let a shader draw into a floating-point buffer. Without both, the page keeps its shadows in 8-bit buffers ("compatibility mode"). */
const FLOAT_COLOUR_BUFFERS = ["EXT_color_buffer_float", "EXT_color_buffer_half_float"];
/** Smooth sampling of float textures. The shader is written not to need it. */
const FLOAT_FILTERING = ["OES_texture_float_linear"];

/** A graphics chip whose driver rejects every shader. The processor shades instead. */
const withBrokenShaders = (t) =>
  beforeLoad(t, `const proto = WebGL2RenderingContext.prototype; const real = proto.getShaderParameter; proto.getShaderParameter = function (shader, what) { return what === this.COMPILE_STATUS ? false : real.call(this, shader, what); };`);

/** No Workers (some hosts block the script): the processor shades on the page's own thread. */
const withoutWorkers = (t) => beforeLoad(t, `window.Worker = function () { throw new Error("blocked for this test"); };`);

/** No 2D canvas either, so the processor cannot shade. With withoutWebGL2 this leaves nothing in the browser that can. Use a sample: an upload needs a 2D canvas to be read at all. */
const withoutCanvas2D = (t) =>
  beforeLoad(t, `const real = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return kind === "2d" ? null : real.call(this, kind, ...rest); };`);

/**
 * How many times slower the page's own thread is made for the slow-processor
 * shots (Chrome's CPU throttle). The page calls a processor slow when one full
 * picture takes over 1.2 s (CPU_SLOW_MS in frontend/app/relight/page.tsx); on
 * the computer these were taken on a picture takes about a tenth of a second, so
 * this has to be well over 12. Higher only makes the shot take longer.
 */
const SLOW_CPU_RATE = 40;

/**
 * Open the "Portrait" sample on a slow device and wait until the page has
 * timed a full picture, found it too slow and put a server render in its place.
 * The throttle goes on after the first page has loaded and comes off again here.
 */
async function slowProcessorScene(t) {
  await withoutWebGL2(t);
  await withoutWorkers(t);
  await t.page.route(t.api, "watch");
  await t.page.goto(t.url + "/");
  await t.page.send("Emulation.setCPUThrottlingRate", { rate: SLOW_CPU_RATE });
  try {
    await clickSample(t, "Portrait");
    await t.page.waitFor(`(shadingNote() ?? "").startsWith("This device's processor is slow") && document.querySelector('img[alt="Relit photo"]')?.complete === true`, "the page to hand a slow processor's work to the server", 180_000);
  } finally {
    await t.page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
  t.note.shading = "server";
  t.note.sample = "Portrait";
  t.note.slowNote = await t.page.js(`shadingNote()`);
  t.note.how = `No WebGL2, no Workers, and the page's own thread slowed ${SLOW_CPU_RATE} times with Chrome's CPU throttle until the page noticed.`;
}

/** Make the graphics chip stop responding for the photo on screen, with WebGL's own test hook. It does not come back by itself. */
const loseGraphicsChip = (t) => t.page.js(`(document.querySelector("canvas").getContext("webgl2").getExtension("WEBGL_lose_context").loseContext(), true)`);

/** Read the "shading:" line at the bottom of the GEOMETRY panel and its tooltip, and the grey note above the stage, into the manifest. */
async function readShading(t) {
  t.note.shadingLine = await t.page.js(`shadingLine()?.textContent.trim() ?? null`);
  t.note.shadingTooltip = await t.page.js(`shadingLine()?.title ?? null`);
  t.note.greyNote = await t.page.js(`shadingNote()`);
  t.note.redBars = await t.page.js(`alerts()`);
}

/** A close-up of the open GEOMETRY panel. */
const geometryClip = (t) => t.page.clipOf(`shadingLine().closest("section")`, "the GEOMETRY panel", { pad: 10, scale: 2, block: "end" });

/** Drop a rule set with page.route() but keep the others. */
const unroute = (t, fragment) => void (t.page.rules = t.page.rules.filter((r) => r.fragment !== fragment));

/** The requests made to the backend while a rule was in force, without the status pill's own /health checks. */
const backendRequests = (t) => t.page.seen.filter((line) => line.includes(t.api) && !line.includes("/health")).map((line) => line.replace(t.api, ""));

// ----- A photo analysed in the browser (the static demo, mock mode, or the normal app when its backend cannot be reached). -----

/** Where the depth model is downloaded from. */
const MODEL_HOST = "huggingface.co";

/** Delete this browser's stored copy of the depth model, so that the next photo downloads it the way a first visit does. Call it once the page is open. */
const forgetDepthModel = (t) => t.page.js(`caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name)))).then(() => true)`);

/**
 * How far the download is let run before the page is kept still for its
 * picture, as a share of the model file. Any value from 0.01 to 0.99 shows the
 * same line with another number; this one is far enough in to be plainly "part
 * of the way".
 */
const DOWNLOAD_HOLD_SHARE = 0.42;

/** The messages from the depth Worker (frontend/lib/depth.worker.js) at which a picture is wanted, as expressions over the message `d`. */
const DEPTH_MESSAGE = {
  downloading: `d.type === "progress" && d.stage === "download" && !d.cached && d.total > 0 && d.loaded / d.total >= ${DOWNLOAD_HOLD_SHARE}`,
  loadingStored: `d.type === "progress" && d.stage === "download" && d.cached === true`,
  starting: `d.type === "progress" && d.stage === "start"`,
  estimating: `d.type === "progress" && d.stage === "estimate"`,
};

/**
 * Keep the page on one line of the analysis. From the first Worker message for
 * which `when` is true, every later message waits until releaseDepth(), so the
 * page goes on showing what that message made it show. The Worker itself runs on.
 * Set before the page loads.
 */
const holdDepthAt = (t, when) =>
  beforeLoad(
    t,
    `const Real = window.Worker; const waiting = []; let holding = false, watching = true;
     window.Worker = class extends Real {
       set onmessage(heard) {
         super.onmessage = heard && ((event) => {
           if (holding) return void waiting.push(() => heard.call(this, event));
           heard.call(this, event);
           const d = event.data;
           if (watching && d && (${when})) holding = true;
         });
       }
       get onmessage() { return super.onmessage; }
     };
     window.__depthHeld = () => holding;
     window.__releaseDepth = () => { watching = false; holding = false; for (const pass of waiting.splice(0)) pass(); return true; };`,
  );
const releaseDepth = (t) => t.page.js(`window.__releaseDepth()`);

/** What the GEOMETRY panel says about a photo the browser analysed, for the manifest: its first sentence, the "depth:" line and that line's tooltip. */
async function readDepth(t) {
  t.note.geometryIntro = await t.page.js(`[...document.querySelectorAll("aside button[aria-expanded]")].find((b) => b.textContent.includes("Geometry")).closest("section").querySelector("p")?.textContent.trim() ?? null`);
  t.note.depthLine = await t.page.js(`depthLine()?.textContent.trim() ?? null`);
  t.note.depthTooltip = await t.page.js(`depthLine()?.title ?? null`);
}

/** Choose a photo and stop on the failed-load card ("This photo could not be analysed"). Its words and buttons go into the manifest. */
async function failedCard(t, timeout = 120_000) {
  await t.page.waitFor(`alerts().length > 0 && !!photoBox() && !!byText("button", "Retry")`, "the failed-load card on the photo", timeout);
  t.note.error = (await t.page.js("alerts()"))[0];
  t.note.card = await t.page.js(`(() => { const card = [...document.querySelectorAll('[role="alert"]')].find((e) => e.offsetParent !== null); return { lines: [...card.querySelectorAll("p")].map((p) => p.textContent.trim()), buttons: [...card.querySelectorAll("button")].map((b) => b.textContent.trim()), yellowButton: [...card.querySelectorAll("button")].find((b) => getComputedStyle(b).backgroundColor === ACCENT)?.textContent.trim() ?? null }; })()`);
}

/** For a shot that clicks its way past the card: its words are kept as what the card said, not as an error in the picture. */
function cardIsGone(t) {
  t.note.cardBeforeTheClick = t.note.card;
  delete t.note.card;
  delete t.note.error;
}

// ----- A picture dragged in from another web site. -----

/**
 * A small web site on another port, for one shot. It answers the ways real sites do:
 *   /closed/...  a picture, with no leave for other pages to read it (what most sites send)
 *   /open/...    the same picture, with that leave
 *   /page        a web page, not a picture
 *   /slow/...    never answers
 *   anything else: 404
 * Returns its address. It is closed again when the shot ends.
 */
async function otherSite(t) {
  const picture = readFileSync(join(t.photos, PHOTO.portrait));
  const readable = { "Access-Control-Allow-Origin": "*" };
  const server = createServer((request, response) => {
    if (request.url.startsWith("/closed/")) response.writeHead(200, { "Content-Type": "image/jpeg" }).end(picture);
    else if (request.url.startsWith("/open/")) response.writeHead(200, { "Content-Type": "image/jpeg", ...readable }).end(picture);
    else if (request.url === "/page") response.writeHead(200, { "Content-Type": "text/html", ...readable }).end("<p>A web page.</p>");
    else if (!request.url.startsWith("/slow/")) response.writeHead(404, { "Content-Type": "text/plain", ...readable }).end("Not found");
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  t.cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

/** What a browser puts in a drag when a picture is pulled out of a web page: the picture's address and the page's HTML for it, never the picture itself. */
const draggedPicture = (address) => [
  { mimeType: "text/uri-list", data: address },
  { mimeType: "text/html", data: `<img src="${address}" alt="">` },
  { mimeType: "text/plain", data: address },
];

/** Open the first page and drop `items` on the dashed drop box. */
async function dropOnBox(t, items) {
  await t.page.goto(t.url + "/");
  const c = await t.page.centre(`document.querySelector('div[role="button"]')`, "the drop box");
  await t.page.drop(c.x, c.y, items);
}

/** A close-up of the first page from the drop box down to the red bar under the thumbnails. */
const dropBoxClip = (t) => t.page.clipOf(`document.querySelector('div[role="button"]').parentElement`, "the drop box and what is under it", { pad: 16, scale: 1.5 });

// ----- The sun and the light's distance (Height). -----

/** How the sun is drawn at this moment, for the manifest: the Height it shows, and the sizes and shadow the page has given it. */
const sunLook = (t) =>
  t.page.js(`(() => {
    const b = lightHandle(); const disc = b.querySelector("[data-sun]"); const glow = b.querySelector("span[aria-hidden]");
    return { height: b.dataset.height, discPx: Math.round(parseFloat(disc.style.width)), buttonPx: Math.round(parseFloat(b.style.width)), glowPx: Math.round(parseFloat(glow.style.width)), glowBlur: glow.style.filter, shadow: disc.style.boxShadow, ariaLabel: b.getAttribute("aria-label") };
  })()`);

/** The side of the square close-up of the sun, in CSS pixels: the largest sun with its whole glow (about 180 across) and some photo round it. */
const SUN_CLOSE_UP_PX = 240;

/** A magnified square of the stage centred on the sun. */
async function sunClip(t, width = SUN_CLOSE_UP_PX, height = SUN_CLOSE_UP_PX, scale = 2) {
  const c = await t.page.centre("lightHandle()", "the light handle");
  return { clip: { x: Math.max(0, c.x - width / 2), y: Math.max(0, c.y - height / 2), width, height, scale } };
}

/** The line under the sun ("Scroll to bring the light nearer or push it back"): its words and how visible it is, 0 to 1. */
const sunCaption = (t) => t.page.js(`(() => { const e = [...lightHandle().querySelectorAll("span[aria-hidden]")].find((x) => x.textContent.trim()); return e ? { text: e.textContent.trim(), opacity: Number(getComputedStyle(e).opacity) } : null; })()`);

/** Rest the mouse on the sun until the line under it has faded in (the page waits half a second first). */
async function restOnSun(t) {
  const c = await t.page.centre("lightHandle()", "the light handle");
  await t.page.mouse("mouseMoved", c.x - 3, c.y - 3);
  await t.page.mouse("mouseMoved", c.x, c.y);
  await t.page.waitFor(`(() => { const e = [...lightHandle().querySelectorAll("span[aria-hidden]")].find((x) => x.textContent.trim()); return !!e && Number(getComputedStyle(e).opacity) > 0.99; })()`, "the line under the sun to appear", 5000);
  return c;
}

/** The Height control as the page lays it out: the words at the two ends of its track, the helper line, and which of them can be seen. */
const heightControl = (t) =>
  t.page.js(`(() => {
    const label = sliderOf("Height").closest("label");
    const [name, value] = [...label.querySelectorAll("span span")].slice(0, 2).map((e) => e.textContent.trim());
    const rows = [...label.children].filter((e) => e.tagName === "SPAN").slice(1);
    const ends = rows.find((e) => e.children.length === 2); const hint = rows.find((e) => e.children.length === 0);
    return { name, value, tooltip: label.title, endLabels: ends ? [...ends.children].map((e) => e.textContent.trim()) : null, endLabelsShown: !!ends && ends.offsetParent !== null, helperLine: hint?.textContent.trim() ?? null, helperLineShown: !!hint && hint.offsetParent !== null };
  })()`);

/** A close-up of the Height control: its name and value, the track, and whatever is under the track. */
const heightClip = (t, scale = 3) => t.page.clipOf(`sliderOf("Height").closest("label")`, "the Height control", { pad: 14, scale });

// ----- iPhone photos (HEIC). -----

/** Where the page downloads its HEIC converter from (DECODER_URL in frontend/lib/heic.worker.js). */
const HEIC_CONVERTER_HOST = "cdn.jsdelivr.net";

/**
 * The side, in pixels, of the square HEIC photo made for the "too large" shot.
 * The page refuses anything over 64 million pixels (MAX_PIXELS in
 * frontend/lib/heic.worker.js); 8192 squared is 67 million, just over, and one
 * flat colour, so the file is small and made in under a second.
 */
const TOO_LARGE_SIDE = 8192;

/** Make a HEIC photo too large for the page to convert, in a temporary folder, with the converter built into macOS (sips). Returns its path. */
function tooLargeHeic(t) {
  const folder = mkdtempSync(join(tmpdir(), "relight-heic-"));
  t.cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
  // A PNG of one colour, written by hand: a length, a name, the data and a checksum for each of its three parts.
  const part = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    const sizes = Buffer.alloc(8);
    sizes.writeUInt32BE(data.length, 0);
    sizes.writeUInt32BE(crc32(body), 4);
    return Buffer.concat([sizes.subarray(0, 4), body, sizes.subarray(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(TOO_LARGE_SIDE, 0);
  header.writeUInt32BE(TOO_LARGE_SIDE, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits a channel, RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(TOO_LARGE_SIDE * 3, Buffer.from([120, 90, 60]))]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), part("IHDR", header), part("IDAT", deflateSync(Buffer.alloc(row.length * TOO_LARGE_SIDE, row), { level: 1 })), part("IEND", Buffer.alloc(0))]);
  writeFileSync(join(folder, "flat.png"), png);
  try {
    execFileSync("sips", ["-s", "format", "heic", join(folder, "flat.png"), "--out", join(folder, "too-large.heic")], { stdio: "ignore" });
  } catch (error) {
    throw new Error(`The large HEIC test photo could not be made with sips (this shot needs macOS): ${error.message}`);
  }
  return join(folder, "too-large.heic");
}

/** Choose a file on the first page and wait for the red bar under the drop box. Its words go into the manifest. */
async function dropBoxError(t, file, timeout = 90_000) {
  await t.page.goto(t.url + "/");
  await t.page.upload(file);
  await t.page.waitFor(`alerts().length > 0 || !!photoBox()`, "the error under the drop box", timeout);
  if (await t.page.js(`!!photoBox()`)) throw new Error("The file was accepted as a photo: no error was shown.");
  t.note.error = (await t.page.js("alerts()"))[0];
}

/** How much of the dark stage the side-by-side picture keeps beside the photo, in CSS pixels: enough for a sun that a preset has put just outside it. */
const SUN_MARGIN_PX = 120;
/** And on the photo's other three sides: a thin frame, small enough to stay clear of the top bar. */
const PHOTO_MARGIN_PX = 20;

/**
 * One file out of two pictures, side by side, each under a line of text.
 * `parts` is [{ label, jpeg }] with the picture as capture(null, ...) hands it back.
 */
async function sideBySide(t, parts) {
  const sheet = await t.page.browser.newPage({ width: 1700, height: 600, scale: 1, mobile: false });
  try {
    await sheet.js(`(() => {
      document.body.style.cssText = "margin:0;padding:16px;background:#0b0b0d;color:#e4e4e7;font:15px/1.4 system-ui,sans-serif;display:flex;gap:16px";
      for (const part of ${JSON.stringify(parts)}) {
        const figure = document.createElement("figure"); figure.style.cssText = "margin:0;flex:1;min-width:0";
        const caption = document.createElement("figcaption"); caption.textContent = part.label; caption.style.cssText = "margin-bottom:8px";
        const img = document.createElement("img"); img.src = "data:image/jpeg;base64," + part.jpeg; img.style.cssText = "display:block;width:100%";
        figure.append(caption, img); document.body.append(figure);
      }
      return Promise.all([...document.images].map((i) => i.decode())).then(() => true);
    })()`);
    await sheet.capture(t.file, { fullPage: true });
  } finally {
    await sheet.close();
  }
}

// ----- The "How it works" panel -----

/** Click "How it works" in the top bar and wait for the panel and the pictures in view. */
async function openHowItWorks(t) {
  await t.page.clickButton("How it works");
  await t.page.waitFor(`howPanel()?.open === true`, "the How it works panel to open");
  await panelPictures(t);
}

/** The panel's pictures are only fetched as they come into view: wait for the ones that have. */
async function panelPictures(t) {
  await t.page.painted();
  await t.page.waitFor(
    `(() => { const box = howPanel().getBoundingClientRect(); return [...howPanel().querySelectorAll("img")].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; }).every((i) => i.complete && i.naturalWidth > 0); })()`,
    "the panel's pictures",
  );
}

/** Scroll the panel so that a numbered step is at the top (with its section heading, if it is the first under one), or to the very end. */
async function scrollPanelTo(t, step) {
  const found = await t.page.js(`(() => {
    const scroller = howPanel().querySelector(".thin-scroll");
    if (${JSON.stringify(step)} === "end") { scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" }); return true; }
    const article = [...howPanel().querySelectorAll("article")].find((a) => a.querySelector("h4 .sr-only")?.textContent.trim() === "Step ${step}:");
    if (!article) return false;
    const target = article.previousElementSibling ? article : article.closest("section");
    scroller.scrollTo({ top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12, behavior: "instant" });
    return true;
  })()`);
  if (!found) throw new Error(`The panel has no step ${step}.`);
  await panelPictures(t);
}

/** What the panel says, for the manifest: its headings, the chip beside each step and the picture captions. */
const panelText = (t) =>
  t.page.js(`({
    title: howPanel().querySelector("h2").textContent.trim(),
    sections: [...howPanel().querySelectorAll("h3")].map((h) => h.textContent.trim() + " | " + (h.nextElementSibling?.tagName === "P" ? h.nextElementSibling.textContent.trim() : "")),
    steps: [...howPanel().querySelectorAll("article")].map((a) => a.querySelector("h4").textContent.trim() + " | " + a.querySelector("h4 + span").textContent.trim()),
    captions: [...howPanel().querySelectorAll("figcaption")].map((c) => c.textContent.trim()),
  })`);

/** A close-up of the panel alone (it is a card in the middle of a desktop window). */
const panelClip = (t) => t.page.clipOf(`howPanel()`, "the How it works panel", { pad: 0, scale: 1.5, block: "nearest" });

/** A magnified picture of the whole top bar of a phone-sized window. */
const phoneBarClip = (t) => ({ clip: { x: 0, y: 0, width: t.page.viewport.width, height: 56, scale: 2 } });

/** The top bar's three parts as the page lays them out: used to check that nothing is pushed off a narrow screen. */
const topBar = (t) =>
  t.page.js(`(() => {
    const header = document.querySelector("header"); const pill = statusPill(); const button = byText("header button", "How it works");
    const shown = [...pill.querySelectorAll("span.font-medium")].find((e) => e.offsetParent !== null);
    return { button: button.textContent.trim(), pill: pill.innerText.replace(/\\s+/g, " ").trim(), pillTextCutOff: shown.scrollWidth > shown.clientWidth, barOverflows: header.scrollWidth > header.clientWidth, pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1, buttonRightPx: Math.round(button.getBoundingClientRect().right), pillLeftPx: Math.round(pill.getBoundingClientRect().left) };
  })()`);

const enhancedReady = `document.querySelector('button[role="tab"][aria-selected="true"]')?.textContent.trim() === "Enhanced" && [...document.querySelectorAll('img[alt="Enhanced"], img[alt="Live preview"]')].length === 2 && [...document.querySelectorAll('img[alt="Enhanced"], img[alt="Live preview"]')].every((i) => i.complete && i.naturalWidth > 0)`;

/** Open a scene, pick the Left preset and run Enhance to the end. */
async function openEnhanced(t) {
  await openScene(t);
  await t.page.clickButton("Left");
  await t.page.clickButton("Enhance");
  await t.page.waitFor(enhancedReady, "the Enhanced tab with both pictures", 120_000);
}

/** How much of the top of the LIGHT panel the Stop sweep close-up takes in, in CSS pixels: the header with the button, and the x / y readout under it. */
const PANEL_TOP_CLOSE_UP_PX = 104;

/** The five buttons at the bottom of the LIGHT panel: their labels, how many lines they take and how wide the row is. */
function presetRow(t) {
  return t.page.js(`(() => {
    const row = byText("button", "Reset light").parentElement;
    const buttons = [...row.querySelectorAll("button")];
    return { labels: buttons.map((b) => b.textContent.trim()), lines: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size, widths: buttons.map((b) => Math.round(b.getBoundingClientRect().width)), rowWidth: Math.round(row.getBoundingClientRect().width) };
  })()`);
}

/** The Detailed normals switch as the page has it: on or off, clickable or not, and the hint beside it (a tooltip on a short window). */
function detailSwitch(t) {
  return t.page.js(`(() => { const s = document.querySelector('button[role="switch"][aria-label="Detailed normals"]'); return { on: s.getAttribute("aria-checked") === "true", disabled: s.disabled, hint: s.closest("label").title }; })()`);
}

/** A magnified picture of the right end of the top bar, where the backend status pill is. */
const statusClip = (t) => ({ clip: { x: t.page.viewport.width - 480, y: 0, width: 480, height: 56, scale: 3 } });

// ---------------------------------------------------------------------------------
// The shots, in the order a tester meets them.
// needs: "backend" = frontend on a MOCK_MODE=1 backend, "mock" = frontend mock mode, "demo" = the static demo build.
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
      // Set before the page loads: a rule switched on afterwards lets this upload's CORS preflight through and then Chrome fails the upload itself.
      await t.page.route("/relight/scene", "hold");
      await t.page.goto(t.url + "/");
      await t.page.upload(join(t.photos, PHOTO.portrait));
      await t.page.waitFor(`document.body.innerText.includes("Estimating depth and surface normals") && !!document.querySelector(".skeleton")`, "the loading overlay");
      await t.snap();
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
    about: "The same loaded scene in a taller window (1440 x 1300): the LIGHT and ENHANCE panels and the folded GEOMETRY row, with room to spare.",
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
    ["drag-centre", 0.5, 0.45, "the middle of the photo, on the neck ring just under the chin"],
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
    about: "Portrait photo, \"Left\" preset, GEOMETRY panel opened, Detailed normals ON (the default). Look at the Normals thumbnail.",
    async run(t) {
      await openScene(t);
      await t.page.clickButton("Left");
      await openGeometry(t);
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "detailed-normals-off",
    about: "The same, after turning the Detailed normals switch OFF and waiting for the photo to be analysed again.",
    async run(t) {
      await openScene(t);
      await openGeometry(t);
      await t.page.toggle("Detailed normals");
      await t.page.waitFor(`document.body.innerText.includes("Estimating depth") || document.querySelector('button[role="switch"][aria-label="Detailed normals"]').getAttribute("aria-checked") === "false"`, "the switch to turn off");
      t.note.shading = await t.page.sceneReady();
      await t.page.clickButton("Left");
      await openGeometry(t);
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
      // Set before the page loads, like the held upload in scene-loading: switched on later, Chrome now and then fails the Enhance request itself.
      if (t.mode === "backend") await t.page.route("/jobs/", "hold");
      await openScene(t);
      await t.page.clickButton("Left");
      await t.page.clickButton("Enhance");
      await t.page.waitFor(`document.body.innerText.includes("Enhancing in the background") && !!byText('button[role="tab"]', "Enhancing…")`, "the Enhancing pill and tab");
      await t.snap({ sidebar: "bottom" });
      const still = await t.page.js(`document.body.innerText.includes("Enhancing in the background") && alerts().length === 0`);
      await t.page.release();
      if (!still) throw new Error(`Enhance had stopped before the picture was taken: ${JSON.stringify(await t.page.js("alerts()"))}`);
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
    name: "sample-portrait",
    about: "Straight after clicking the \"Portrait\" sample thumbnail on the first page: the first frame, nothing else touched.",
    async run(t) {
      await openSample(t, "Portrait");
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
    about: "A photo chosen while the backend is not running (the failed-load state): the photo is grey and dim under a red-bordered card that offers \"Analyse in this browser\", \"Retry\" and \"Choose another photo\".",
    async run(t) {
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/");
      await t.page.upload(join(t.photos, PHOTO.portrait));
      await failedCard(t);
      await t.snap();
    },
  },
  {
    name: "enhance-error",
    needs: "backend",
    about: "The backend stopped after the photo was loaded, then Enhance was clicked: a red bar above the photo (on a window wide enough for the sidebar).",
    async run(t) {
      await openScene(t);
      await t.page.clickButton("Left");
      await t.page.route(t.api, "fail");
      await t.page.clickButton("Enhance");
      await t.page.waitFor(`alerts().length > 0`, "the red bar above the photo");
      t.note.error = (await t.page.js("alerts()"))[0];
      t.note.barIsAbovePhoto = await t.page.js(`!document.querySelector('aside [role="alert"]')?.offsetParent && document.querySelector('[role="alert"]').getBoundingClientRect().bottom <= photoBox().getBoundingClientRect().top`);
      await t.snap();
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
    about: "Close-up of the right end of the top bar during the first moment after the page opens: grey dot, \"checking\".",
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
    about: "A browser without WebGL2, an uploaded photo, \"Left\" preset: a grey note above the stage says the processor is shading, and the photo is lit in the browser as usual. No render is asked of the server.",
    async run(t) {
      await withoutWebGL2(t);
      await t.page.route(t.api, "watch");
      await openScene(t);
      await t.page.clickButton("Left");
      await readShading(t);
      t.note.askedOfBackend = backendRequests(t);
      if (t.note.shading !== "cpu" || t.note.askedOfBackend.some((r) => r.includes("/render"))) throw new Error(`Expected processor shading with no server render: ${JSON.stringify(t.note)}`);
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
    about: "Frontend mock mode with the portrait photo uploaded and the \"Left\" preset: the photo was analysed in the browser, so the shading follows the real face. No dome and no note about one.",
    async run(t) {
      await openScene(t);
      await t.page.clickButton("Left");
      t.note.domeNoteShown = await t.page.js(`document.body.innerText.includes("made-up dome")`);
      if (t.note.domeNoteShown) throw new Error("Mock mode lit the upload as its stand-in dome without being asked.");
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
    about: "Frontend mock mode after Enhance finished on an uploaded photo that the browser analysed: the right half has more contrast and a soft glow.",
    async run(t) {
      await openEnhanced(t);
      await t.snap({ sidebar: "bottom" });
    },
  },
  // ----- Added for the reworked page (sample thumbnails, Sweep, folded GEOMETRY, short and narrow windows). -----
  // New shots go at the end so the numbers of the older files never change.
  {
    name: "sample-thumbnails",
    about: "Close-up of the first page under the drop box: the line \"Or try a sample photo:\" and the four sample thumbnails.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await t.page.waitFor(`[...document.querySelectorAll('button[aria-label^="Sample photo"] img')].length === 4 && [...document.querySelectorAll('button[aria-label^="Sample photo"] img')].every((i) => i.complete && i.naturalWidth > 0)`, "the four thumbnails");
      const r = await t.page.js(`rectOf(document.querySelector('button[aria-label^="Sample photo"]').parentElement.parentElement)`);
      t.note.labels = await t.page.js(`[...document.querySelectorAll('button[aria-label^="Sample photo"]')].map((b) => b.textContent.trim())`);
      await t.snap({ clip: { x: r.x - 16, y: r.y - 12, width: r.w + 32, height: r.h + 24, scale: 2 } });
    },
  },
  {
    name: "sample-loading",
    about: "The moment after clicking the \"Portrait\" thumbnail, held still: the other three thumbnails are dimmed while it loads.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await t.page.route("/samples/portrait/scene.json", "hold");
      await clickSample(t, "Portrait");
      await t.page.waitFor(`[...document.querySelectorAll('button[aria-label^="Sample photo"]')].filter((b) => b.disabled && b.classList.contains("opacity-50")).length === 3`, "the other three thumbnails to dim");
      await t.snap();
      await t.page.release();
      t.note.shading = await t.page.sceneReady();
    },
  },
  ...[
    ["sample-coffee", "Coffee cup"],
    ["sample-cat", "Cat"],
    ["sample-rocket", "Rocket"],
  ].map(([name, label]) => ({
    name,
    about: `Straight after clicking the "${label}" sample thumbnail on the first page: the first frame, nothing else touched.`,
    async run(t) {
      await openSample(t, label);
      await t.snap();
    },
  })),
  {
    name: "sample-backend-stopped",
    needs: "backend",
    stopped: true,
    about: "The \"Portrait\" sample loaded while the backend is not running: the pill reads \"offline\" and the live preview works all the same.",
    async run(t) {
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/");
      await t.page.waitFor(`statusPill().textContent.includes("offline")`, "the offline status");
      await clickSample(t, "Portrait");
      t.note.shading = await t.page.sceneReady();
      await t.page.clickButton("Right");
      await t.snap();
    },
  },
  {
    name: "sample-load-error",
    about: "The \"Cat\" sample's files could not be fetched: a red bar with a plain-words message appears under the thumbnails and the first page stays.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await t.page.route("/samples/cat/scene.json", "fail");
      await clickSample(t, "Cat");
      await t.page.waitFor(`alerts().length > 0`, "the red bar under the thumbnails");
      t.note.error = (await t.page.js("alerts()"))[0];
      t.note.how = "The request for the sample's scene.json was refused inside Chrome. This does not happen in normal use.";
      await t.snap();
    },
  },
  {
    name: "sweep-before",
    about: "Portrait sample, before clicking \"Sweep\": the mouse rests on the Sweep button at the top right of the LIGHT panel.",
    async run(t) {
      await openSample(t, "Portrait");
      const c = await t.page.centre(`byText("button", "Sweep")`, "the Sweep button");
      await t.page.mouse("mouseMoved", c.x, c.y);
      t.note.sweepTooltip = await t.page.js(`byText("button", "Sweep").title`);
      await t.snap({ asIs: true });
    },
  },
  {
    name: "sweep-during",
    about: "About two and a half seconds after clicking \"Sweep\": the light has travelled from the left edge over the top to the right edge, and the button reads \"Stop sweep\".",
    async run(t) {
      await openSample(t, "Portrait");
      await t.page.clickButton("Sweep");
      await t.page.waitFor(`!!byText("button", "Stop sweep") && (() => { const m = lightHandle()?.getAttribute("aria-label").match(/x (-?\\d+\\.\\d+), y (-?\\d+\\.\\d+)/); return !!m && Number(m[1]) > 0.9 && Number(m[2]) < 0.5; })()`, "the light to reach the right edge during the sweep", 8000);
      await t.snap({ quick: true });
      // The light is moving: by the time the picture is taken the readout is a few hundredths further on than this note.
      t.note.light = { ...t.note.light, moving: true };
      t.note.button = await t.page.js(`[...document.querySelectorAll("aside button")].map((b) => b.textContent.trim()).find((x) => /sweep/i.test(x))`);
      t.note.buttonStyle = await t.page.js(`(() => { const b = byText("button", "Stop sweep"); if (!b) return null; const c = getComputedStyle(b); return { pressed: b.getAttribute("aria-pressed"), textColour: c.color, borderColour: c.borderColor }; })()`);
      if (t.note.button !== "Stop sweep") throw new Error(`The sweep had ended before the picture was taken (button reads "${t.note.button}").`);
      await t.page.waitFor(`!!byText("button", "Sweep")`, "the sweep to finish", 10_000);
    },
  },
  {
    name: "sweep-after",
    about: "After the sweep has finished (about six seconds): the light is back where it started and the button reads \"Sweep\" again.",
    async run(t) {
      await openSample(t, "Portrait");
      const before = await t.page.light();
      await t.page.clickButton("Sweep");
      await t.page.waitFor(`!!byText("button", "Stop sweep")`, "the sweep to start");
      const started = Date.now();
      await t.page.waitFor(`!!byText("button", "Sweep")`, "the sweep to finish", 12_000);
      t.note.sweepSeconds = Number(((Date.now() - started) / 1000).toFixed(1));
      const after = await t.page.light();
      if (after.x !== before.x || after.y !== before.y) throw new Error(`The light did not return: before ${before.x}, ${before.y}; after ${after.x}, ${after.y}.`);
      await t.snap();
    },
  },
  {
    name: "geometry-collapsed",
    about: "Close-up of the sidebar with a sample loaded: GEOMETRY is one folded row at the bottom with two tiny thumbnails, the word \"Show\" and a down arrow.",
    async run(t) {
      await openSample(t, "Coffee cup");
      const r = await t.page.js(`rectOf(document.querySelector("aside"))`);
      await t.snap({ clip: { x: r.x - 8, y: r.y - 8, width: r.w + 16, height: Math.min(r.h, t.page.viewport.height - r.y) + 8, scale: 2 } });
    },
  },
  {
    name: "geometry-expanded",
    about: "The same after clicking the GEOMETRY row: the panel is open (\"Hide\", arrow up) with the Depth and Normals pictures, the Detailed normals switch and the size line.",
    async run(t) {
      await openSample(t, "Coffee cup");
      await openGeometry(t);
      t.note.sizeLine = await t.page.js(`(() => { const p = document.querySelector("aside p.font-mono")?.cloneNode(true); p?.querySelector("span")?.remove(); return p?.textContent.trim() ?? null; })()`);
      await readShading(t);
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "sample-enhance-done",
    needs: "backend",
    about: "Enhance finished on the \"Coffee cup\" sample (\"Right\" preset) with the backend running: the Enhanced tab with the before/after divider.",
    async run(t) {
      await openSample(t, "Coffee cup");
      await t.page.clickButton("Right");
      const started = Date.now();
      await t.page.clickButton("Enhance");
      await t.page.waitFor(enhancedReady, "the Enhanced tab with both pictures", 120_000);
      t.note.enhanceSeconds = Number(((Date.now() - started) / 1000).toFixed(1));
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "sample-enhance-backend-stopped",
    needs: "backend",
    stopped: true,
    about: "Enhance clicked on the \"Coffee cup\" sample while the backend is not running: a red bar above the photo, and the live preview stays.",
    async run(t) {
      await t.page.route(t.api, "fail");
      await openSample(t, "Coffee cup");
      await t.page.clickButton("Right");
      await t.page.clickButton("Enhance");
      await t.page.waitFor(`alerts().length > 0`, "the red bar above the photo");
      t.note.error = (await t.page.js("alerts()"))[0];
      await t.snap();
    },
  },
  {
    name: "sample-rocket-left",
    about: "The \"Rocket\" sample (a night photo) with the \"Left\" preset: the shadows are soft-edged and faint on the far background.",
    async run(t) {
      await openSample(t, "Rocket");
      await t.page.clickButton("Left");
      await t.snap();
    },
  },
  {
    name: "sample-detailed-normals-backend-stopped",
    needs: "backend",
    stopped: true,
    about: "The Detailed normals switch clicked on a sample while the backend is not running: a red bar above the stage, the sample stays and the switch goes back to on.",
    async run(t) {
      await t.page.route(t.api, "fail");
      await openSample(t, "Portrait");
      await openGeometry(t);
      await t.page.toggle("Detailed normals");
      await t.page.waitFor(`alerts().some((a) => a.includes("The sample keeps the geometry it came with.")) && document.querySelector('button[role="switch"][aria-label="Detailed normals"]').getAttribute("aria-checked") === "true"`, "the red bar and the switch back on");
      t.note.error = (await t.page.js("alerts()"))[0];
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "laptop-1280x720-scene",
    viewport: { width: 1280, height: 720, scale: 1, mobile: false },
    about: "A small laptop window (1280 x 720) with the \"Portrait\" sample loaded: the whole sidebar fits, down to the GEOMETRY row, with no scrolling.",
    async run(t) {
      await openSample(t, "Portrait");
      t.note.sidebarScrolls = await t.page.js(`(() => { const a = document.querySelector("aside"); return a.scrollHeight > a.clientHeight + 1; })()`);
      t.note.pageScrolls = await t.page.js(`document.documentElement.scrollHeight > window.innerHeight + 1`);
      t.note.enhanceBox = await t.page.js(`(() => { const a = document.querySelector("textarea"); const c = getComputedStyle(a, "::placeholder"); return { height: Math.round(a.getBoundingClientRect().height), placeholderOverflow: c.textOverflow, hintShown: document.body.innerText.includes("A photoreal pass over this lighting"), enhanceTooltip: byText("button", "Enhance").title, helperLinesShown: document.body.innerText.includes("Objects block the light.") }; })()`);
      await t.snap();
    },
  },
  {
    name: "laptop-1280x720-landing",
    viewport: { width: 1280, height: 720, scale: 1, mobile: false },
    about: "The first page in a small laptop window (1280 x 720): the drop box is lower and everything down to the thumbnails fits with no scrolling.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await t.page.waitFor(`[...document.querySelectorAll('button[aria-label^="Sample photo"] img')].every((i) => i.complete && i.naturalWidth > 0)`, "the four thumbnails");
      t.note.pageScrolls = await t.page.js(`document.documentElement.scrollHeight > window.innerHeight + 1`);
      await t.snap();
    },
  },
  {
    name: "laptop-1366x768-scene",
    viewport: { width: 1366, height: 768, scale: 1, mobile: false },
    about: "A 1366 x 768 window with an uploaded photo (the coffee cup) and the \"Right\" preset: the whole sidebar fits without scrolling.",
    async run(t) {
      await openScene(t, PHOTO.object);
      await t.page.clickButton("Right");
      t.note.sidebarScrolls = await t.page.js(`(() => { const a = document.querySelector("aside"); return a.scrollHeight > a.clientHeight + 1; })()`);
      await t.snap();
    },
  },
  {
    name: "window-1440x820-scene",
    viewport: { width: 1440, height: 820, scale: 1, mobile: false },
    about: "A 1440 x 820 window with the \"Portrait\" sample: the grey helper lines under Height, Ambient and Cast shadows are not on the page (they are tooltips), but the line under ENHANCE is.",
    async run(t) {
      await openSample(t, "Portrait");
      t.note.sidebarScrolls = await t.page.js(`(() => { const a = document.querySelector("aside"); return a.scrollHeight > a.clientHeight + 1; })()`);
      await t.snap();
    },
  },
  {
    name: "phone-sample",
    viewport: PHONE,
    about: "A phone-sized window (390 x 844) with the \"Coffee cup\" sample: the stage is only as tall as the photo needs and the LIGHT panel starts right under it.",
    async run(t) {
      await openSample(t, "Coffee cup");
      await t.snap();
    },
  },
  {
    name: "phone-sample-full-page",
    viewport: PHONE,
    about: "The same phone-sized page with the \"Coffee cup\" sample, photographed from top to bottom with the GEOMETRY panel opened.",
    async run(t) {
      await openSample(t, "Coffee cup");
      await openGeometry(t);
      await t.page.js(`(window.scrollTo(0, 0), true)`);
      await t.snap({ fullPage: true });
    },
  },
  {
    name: "phone-load-failed-wide",
    needs: "backend",
    stopped: true,
    viewport: PHONE,
    about: "A phone-sized window, a wide photo chosen while the backend is not running: the failed-load card sits under the stage, not on the photo.",
    async run(t) {
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/", { settleStatus: false });
      await t.page.upload(join(t.photos, PHOTO.wide));
      await failedCard(t);
      t.note.stageHeight = await t.page.js(`Math.round(document.querySelector(".stage-hug").getBoundingClientRect().height)`);
      t.note.cardIsUnderStage = await t.page.js(`[...document.querySelectorAll('[role="alert"]')].find((e) => e.offsetParent !== null).getBoundingClientRect().top >= document.querySelector(".stage-hug").getBoundingClientRect().bottom`);
      await t.snap();
    },
  },
  {
    name: "tablet-768x1024-sample",
    viewport: { width: 768, height: 1024, scale: 1, mobile: true },
    about: "A tablet-sized window (768 x 1024) with the \"Cat\" sample: the page is stacked, with the sidebar panels under the photo.",
    async run(t) {
      await openSample(t, "Cat");
      await t.snap();
    },
  },
  {
    name: "no-webgl-backend-stopped-sample",
    needs: "backend",
    stopped: true,
    about: "A browser without WebGL2, a sample, and the backend not running, \"Right\" preset: the processor lights the photo all the same. A grey note, no red bar, and every light control works.",
    async run(t) {
      await withoutWebGL2(t);
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/", { settleStatus: false });
      await clickSample(t, "Portrait");
      t.note.shading = await t.page.sceneReady();
      await t.page.clickButton("Right");
      await readShading(t);
      t.note.sunShown = await t.page.js(`!!lightHandle()`);
      t.note.buttons = await t.page.js(`["Sweep", "Enhance", "Hold to see original", "Export PNG"].map((x) => x + ": " + (byText("button", x).disabled ? "DISABLED" : "enabled"))`);
      t.note.askedOfBackend = backendRequests(t);
      if (t.note.shading !== "cpu" || t.note.redBars.length || !t.note.sunShown) throw new Error(`Expected processor shading and no red bar: ${JSON.stringify(t.note)}`);
      await t.snap();
    },
  },
  {
    name: "mock-sample",
    needs: "mock",
    about: "Frontend mock mode with the \"Cat\" sample and the \"Left\" preset: samples carry their own real geometry, so the shading follows the cat, not a made-up dome.",
    async run(t) {
      await openSample(t, "Cat");
      await t.page.clickButton("Left");
      await t.snap();
    },
  },
  // ----- Added for the second round: yellow active buttons, the "Reset light" row, the moved error bars,
  // ----- the fixed Detailed normals switch and the static demo build. Again at the end, so no older number changes.
  {
    name: "sweep-stop-button",
    about: "Close-up of the top of the LIGHT panel while a sweep is running: the button reads \"Stop sweep\" in yellow letters with a yellow outline.",
    async run(t) {
      await openSample(t, "Portrait");
      await t.page.clickButton("Sweep");
      const stop = `byText("button", "Stop sweep")`;
      await t.page.waitFor(`!!${stop}`, "the sweep to start");
      await t.page.waitFor(`getComputedStyle(${stop}).color === ACCENT`, "the button to turn yellow", 3000);
      t.note.buttonStyle = await t.page.js(`(() => { const c = getComputedStyle(${stop}); return { pressed: ${stop}.getAttribute("aria-pressed"), textColour: c.color, borderColour: c.borderColor }; })()`);
      const r = await t.page.js(`rectOf(${stop}.closest("section"))`);
      await t.snap({ quick: true, clip: { x: r.x - 8, y: r.y - 8, width: r.w + 16, height: PANEL_TOP_CLOSE_UP_PX, scale: 3 } });
      t.note.light = { ...t.note.light, moving: true };
      if (!(await t.page.js(`!!${stop}`))) throw new Error("The sweep had ended before the picture was taken.");
      await t.page.waitFor(`!!byText("button", "Sweep")`, "the sweep to finish", 10_000);
    },
  },
  {
    name: "hold-original-button",
    about: "Close-up of the two buttons under the photo while \"Hold to see original\" is held down: it has yellow letters and a yellow outline; \"Export PNG\" beside it stays white.",
    async run(t) {
      await openSample(t, "Portrait");
      const hold = `byText("button", "Hold to see original")`;
      const c = await t.page.centre(hold, "the Hold to see original button");
      await t.page.mouse("mouseMoved", c.x, c.y);
      await t.page.mouse("mousePressed", c.x, c.y, 1);
      await t.page.waitFor(`!!byText("span", "Original")`, "the Original tag");
      await t.page.waitFor(`getComputedStyle(${hold}).color === ACCENT`, "the button to turn yellow", 3000);
      t.note.buttonStyle = await t.page.js(`(() => { const c = getComputedStyle(${hold}); return { textColour: c.color, borderColour: c.borderColor }; })()`);
      const other = await t.page.js(`rectOf(byText("button", "Export PNG"))`);
      const margin = 48; // enough of the photo round the buttons to see where they are
      await t.snap({ asIs: true, clip: { x: c.rect.x - margin, y: c.rect.y - margin, width: other.x + other.w - c.rect.x + 2 * margin, height: c.rect.h + 1.5 * margin, scale: 3 } });
      await t.page.mouse("mouseReleased", c.x, c.y, 0);
      await t.page.waitFor(`!byText("span", "Original")`, "the Original tag to go away");
    },
  },
  {
    name: "preset-row",
    about: "Close-up of the bottom of the LIGHT panel: Left, Right, Top, Low and warm and Reset light share one row that fills the panel's width. The mouse rests on \"Reset light\".",
    async run(t) {
      await openSample(t, "Portrait");
      const reset = `byText("button", "Reset light")`;
      const c = await t.page.centre(reset, "the Reset light button");
      await t.page.mouse("mouseMoved", c.x, c.y);
      t.note.resetTooltip = await t.page.js(`${reset}.title`);
      t.note.row = await presetRow(t);
      await t.snap({ asIs: true, ...(await t.page.clipOf(`${reset}.closest("section")`, "the LIGHT panel", { scale: 2 })) });
    },
  },
  ...[
    ["phone-360-preset-row", 360, 740, 1, "A narrow phone (360 px wide)", "still fit on one line"],
    ["phone-320-preset-row", 320, 740, 2, "The narrowest phone (320 px wide)", "take two lines: \"Reset light\" drops to its own line and stretches across the panel"],
  ].map(([name, width, height, lines, what, result]) => ({
    name,
    viewport: { width, height, scale: 2, mobile: true },
    about: `${what}: close-up of the LIGHT panel with the "Coffee cup" sample. The five preset buttons ${result}.`,
    async run(t) {
      await openSample(t, "Coffee cup");
      t.note.row = await presetRow(t);
      if (t.note.row.lines !== lines) throw new Error(`The preset row takes ${t.note.row.lines} line(s) at ${width} px, expected ${lines}.`);
      t.note.pageScrollsSideways = await t.page.js(`document.documentElement.scrollWidth > window.innerWidth + 1`);
      // Lined up with the bottom of the window, so the top bar, which stays put while the page scrolls, is not lying across the panel. The phone's own 2x is magnification enough.
      await t.snap(await t.page.clipOf(`byText("button", "Reset light").closest("section")`, "the LIGHT panel", { pad: 8, scale: 1, block: "end" }));
    },
  })),
  {
    name: "laptop-1280x720-preset-top",
    viewport: { width: 1280, height: 720, scale: 1, mobile: false },
    about: "A small laptop window (1280 x 720), \"Portrait\" sample, \"Top\" preset: the readout shows the preset's own numbers although that point is above the stage, and the sun is drawn at the stage's top edge.",
    async run(t) {
      await openSample(t, "Portrait");
      await t.page.clickButton("Top");
      await t.page.painted();
      t.note.sun = await t.page.js(`(() => { const h = rectOf(lightHandle()), p = rectOf(photoBox()); return { centreAbovePhotoPx: Math.round(p.y - (h.y + h.h / 2)), wherePresetAsksPx: Math.round(0.15 * p.h) }; })()`);
      await t.snap();
    },
  },
  {
    name: "new-photo-starts-clean",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "After changing everything on one photo (a typed mood, Cast shadows off, Detailed normals off, \"Low and warm\"), then \"New photo\" and a second photo: every control is back at its starting value.",
    async run(t) {
      await openScene(t);
      await t.page.clickButton("Low and warm");
      await t.page.toggle("Cast shadows");
      await t.page.clickOn(`document.querySelector("textarea")`, "the Enhance text box");
      await t.page.send("Input.insertText", { text: "golden hour" });
      await openGeometry(t);
      await t.page.toggle("Detailed normals");
      await t.page.waitFor(`document.body.innerText.includes("Estimating depth") || document.querySelector('button[role="switch"][aria-label="Detailed normals"]').getAttribute("aria-checked") === "false"`, "the switch to turn off");
      await t.page.sceneReady();
      t.note.before = { ...(await t.page.light()), prompt: await t.page.js(`document.querySelector("textarea").value`) };
      await t.page.clickButton("New photo");
      await t.page.waitFor(`!photoBox() && !!document.querySelector('input[type="file"]')`, "the first page");
      await t.page.upload(join(t.photos, PHOTO.object));
      t.note.shading = await t.page.sceneReady();
      await openGeometry(t);
      t.note.prompt = await t.page.js(`document.querySelector("textarea").value`);
      const after = await t.page.light();
      if (t.note.prompt !== "" || !after.shadows || !after.detailedNormals || after.x !== 0.12 || after.colour !== "neutral") throw new Error(`"New photo" left something behind: ${JSON.stringify({ ...after, prompt: t.note.prompt })}`);
      await t.snap();
    },
  },
  {
    name: "laptop-1280x720-enhance-error",
    needs: "backend",
    stopped: true,
    viewport: { width: 1280, height: 720, scale: 1, mobile: false },
    about: "A small laptop window (1280 x 720), Enhance clicked on a sample while the backend is not running: the red bar is above the photo and the sidebar still fits without scrolling.",
    async run(t) {
      await t.page.route(t.api, "fail");
      await openSample(t, "Portrait");
      await t.page.clickButton("Enhance");
      await t.page.waitFor(`alerts().length > 0`, "the red bar above the photo");
      t.note.error = (await t.page.js("alerts()"))[0];
      t.note.sidebarScrolls = await t.page.js(`(() => { const a = document.querySelector("aside"); return a.scrollHeight > a.clientHeight + 1; })()`);
      t.note.pageScrolls = await t.page.js(`document.documentElement.scrollHeight > window.innerHeight + 1`);
      await t.snap();
    },
  },
  {
    name: "phone-enhance-error",
    needs: "backend",
    stopped: true,
    viewport: PHONE,
    about: "A phone-sized window, Enhance clicked on a sample while the backend is not running: here the red bar stays inside the ENHANCE panel, under the button.",
    async run(t) {
      await t.page.route(t.api, "fail");
      await openSample(t, "Coffee cup");
      await t.page.clickButton("Enhance");
      await t.page.waitFor(`alerts().length > 0`, "the red bar under the Enhance button");
      t.note.error = (await t.page.js("alerts()"))[0];
      t.note.barIsInEnhancePanel = await t.page.js(`!!document.querySelector('aside [role="alert"]')?.offsetParent`);
      await t.page.js(`(document.querySelector('aside [role="alert"]').closest("section").scrollIntoView({ block: "center", behavior: "instant" }), true)`);
      await t.snap();
    },
  },
  {
    name: "no-webgl-render-lost",
    needs: "backend",
    about: "A browser in which neither the graphics chip nor the processor can shade (no WebGL2 and no 2D canvas), a sample already shown by the server with the \"Left\" preset, then the backend stops and \"Right\" is clicked: the red bar now says the render failed and offers \"Retry\".",
    async run(t) {
      await withoutWebGL2(t);
      await withoutCanvas2D(t);
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      await t.page.waitFor(`new Promise((r) => setTimeout(() => r(document.querySelector('img[alt="Relit photo"]')?.complete === true), 900))`, "the server render for the Left preset");
      await t.page.route(t.api, "fail");
      await t.page.clickButton("Right");
      await t.page.waitFor(`alerts().some((a) => a.includes("the server render that would replace it failed"))`, "the red bar that says the server render failed");
      t.note.errors = await t.page.js("alerts()");
      t.note.retryLink = await t.page.js(`!!byText('[role="alert"] button', "Retry")`);
      t.note.sunShown = await t.page.js(`!!lightHandle()`);
      t.note.buttons = await t.page.js(`["Sweep", "Enhance", "Hold to see original", "Export PNG"].map((x) => x + ": " + (byText("button", x).disabled ? "disabled" : "enabled"))`);
      t.note.how = "Both ways of shading in the browser were taken away before the page loaded. In normal use this needs a browser with no WebGL2 in which the processor fallback also breaks.";
      await t.snap();
    },
  },
  {
    name: "mock-sample-detailed-normals",
    needs: "mock",
    about: "Frontend mock mode with the \"Cat\" sample and GEOMETRY opened: the Detailed normals switch is on, greyed out and cannot be clicked.",
    async run(t) {
      await openSample(t, "Cat");
      await openGeometry(t);
      t.note.detailedNormals = await detailSwitch(t);
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "demo-landing",
    needs: "demo",
    about: "The static demo build: the first page, with a working drop box and a line under it that says the photo stays on this device.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await t.page.waitFor(`[...document.querySelectorAll('button[aria-label^="Sample photo"] img')].length === 4 && [...document.querySelectorAll('button[aria-label^="Sample photo"] img')].every((i) => i.complete && i.naturalWidth > 0)`, "the four thumbnails");
      t.note.fileInputOnPage = await t.page.js(`!!document.querySelector('input[type="file"]')`);
      t.note.intro = await t.page.js(`document.querySelector("h1").parentElement.querySelector("p:not(:first-child)")?.textContent.trim() ?? null`);
      await t.snap();
    },
  },
  {
    // This number was "demo-upload-note", the card that stood where the drop box now is.
    name: "demo-drop-box",
    needs: "demo",
    about: "The static demo build: close-up of the drop box on the first page and the line under it about where the photo goes.",
    async run(t) {
      await t.page.goto(t.url + "/");
      const box = `document.querySelector('div[role="button"]')`;
      t.note.box = await t.page.js(`[...${box}.querySelectorAll("span > span")].map((e) => e.textContent.trim())`);
      t.note.lineUnderIt = await t.page.js(`${box}.nextElementSibling.textContent.trim()`);
      const r = await t.page.js(`(() => { const a = rectOf(${box}), b = rectOf(${box}.nextElementSibling); return { x: a.x, y: a.y, w: a.w, h: b.y + b.h - a.y }; })()`);
      await t.snap({ clip: { x: r.x - 16, y: r.y - 16, width: r.w + 32, height: r.h + 32, scale: 2 } });
    },
  },
  {
    name: "demo-status",
    needs: "demo",
    about: "The static demo build: close-up of the status pill. Green dot, \"demo: runs in your browser\".",
    async run(t) {
      await t.page.goto(t.url + "/");
      t.note.tooltip = (await t.page.status()).title;
      await t.snap(statusClip(t));
    },
  },
  {
    name: "demo-sample",
    needs: "demo",
    about: "The static demo build with the \"Portrait\" sample loaded, nothing else touched: the top-right stage button reads \"New photo\" and the Enhance button is greyed out.",
    async run(t) {
      await openSample(t, "Portrait");
      t.note.enhance = await t.page.js(`({ buttonDisabled: byText("button", "Enhance").disabled, promptBoxOnPage: !!document.querySelector("textarea"), tooltip: byText("button", "Enhance").title })`);
      t.note.stageButton = await t.page.js(`[...document.querySelectorAll("button")].map((b) => b.textContent.trim()).find((x) => x === "Other samples" || x === "New photo")`);
      await t.snap();
    },
  },
  {
    name: "demo-all-panels",
    needs: "demo",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "The static demo build in a taller window (1440 x 1300) with the \"Coffee cup\" sample, the \"Right\" preset and GEOMETRY opened: the whole sidebar at once.",
    async run(t) {
      await openSample(t, "Coffee cup");
      await t.page.clickButton("Right");
      await openGeometry(t);
      t.note.detailedNormals = await detailSwitch(t);
      await t.snap();
    },
  },
  {
    name: "demo-phone-landing",
    needs: "demo",
    viewport: PHONE,
    about: "The static demo build: the first page in a phone-sized window. The pill is shortened to \"demo\".",
    async run(t) {
      await t.page.goto(t.url + "/");
      await t.page.waitFor(`[...document.querySelectorAll('button[aria-label^="Sample photo"] img')].every((i) => i.complete && i.naturalWidth > 0)`, "the four thumbnails");
      await t.snap();
    },
  },
  {
    name: "demo-phone-sample-full-page",
    needs: "demo",
    viewport: PHONE,
    about: "The static demo build on a phone with the \"Cat\" sample, photographed from top to bottom with GEOMETRY opened.",
    async run(t) {
      await openSample(t, "Cat");
      await openGeometry(t);
      await t.page.js(`(window.scrollTo(0, 0), true)`);
      await t.snap({ fullPage: true });
    },
  },
  {
    name: "demo-no-webgl",
    needs: "demo",
    about: "The static demo build in a browser without WebGL2, \"Portrait\" sample, \"Left\" preset: a grey note above the stage, and the processor lights the photo. Nothing is greyed out but Enhance, which the demo never has.",
    async run(t) {
      await withoutWebGL2(t);
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      await readShading(t);
      t.note.sunShown = await t.page.js(`!!lightHandle()`);
      t.note.buttons = await t.page.js(`["Sweep", "Enhance", "Hold to see original", "Export PNG"].map((x) => x + ": " + (byText("button", x).disabled ? "disabled" : "enabled"))`);
      if (t.note.shading !== "cpu" || t.note.redBars.length) throw new Error(`Expected processor shading and no red bar: ${JSON.stringify(t.note)}`);
      await t.snap();
    },
  },
  // ----- Added for the third round: the "How it works" button and panel, the line that says how the photo
  // ----- is being shaded, and each fallback a weaker device takes. At the end again, so no older number changes.
  {
    name: "how-it-works-button",
    about: "Close-up of the right end of the top bar: the \"How it works\" button sits just left of the status pill, on every page.",
    async run(t) {
      await t.page.goto(t.url + "/");
      t.note.bar = await topBar(t);
      await t.snap(statusClip(t));
    },
  },
  {
    name: "how-it-works-open",
    about: "The first page straight after clicking \"How it works\": a card in the middle of the window over the dimmed page.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await openHowItWorks(t);
      t.note.panel = await panelText(t);
      t.note.card = await t.page.js(`(() => { const r = howPanel().getBoundingClientRect(); return { widthPx: Math.round(r.width), heightPx: Math.round(r.height), shareOfWindowHeight: Number((r.height / window.innerHeight).toFixed(2)) }; })()`);
      t.note.focusIsOn = await t.page.js(`document.activeElement.textContent.trim()`);
      await t.snap();
    },
  },
  ...[1, 2, 3, 4].map((step) => ({
    name: `how-it-works-step-${step}`,
    about: `The "How it works" panel alone, enlarged, scrolled to step ${step}.`,
    async run(t) {
      await t.page.goto(t.url + "/");
      await openHowItWorks(t);
      await scrollPanelTo(t, step);
      await t.snap(await panelClip(t));
    },
  })),
  {
    name: "how-it-works-step-5-and-limits",
    about: "The \"How it works\" panel alone, enlarged, scrolled to the very end: the card about moving the light, step 5 and \"Honest limits\".",
    async run(t) {
      await t.page.goto(t.url + "/");
      await openHowItWorks(t);
      await scrollPanelTo(t, "end");
      await t.snap(await panelClip(t));
    },
  },
  {
    name: "how-it-works-over-photo",
    about: "\"How it works\" opened while a photo is being lit (\"Portrait\" sample, \"Left\" preset): the page behind is dimmed and cannot be used until the panel is closed.",
    async run(t) {
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      const open = `howPanel().open === true`;
      // The three ways out, each tried before the picture is taken.
      await openHowItWorks(t);
      // Without this, headless Chrome treats the tab as unfocused and hides it when Escape is pressed, and a hidden tab stops painting.
      await t.page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await t.page.key("Escape");
      await t.page.waitFor(`!(${open})`, "the Escape key to close the panel", 5000);
      if ((await t.page.js(`document.visibilityState`)) !== "visible") throw new Error("Chrome hid the tab when Escape was pressed; the picture would be stale.");
      t.note.escapeCloses = true;
      t.note.focusAfterClosing = await t.page.js(`document.activeElement.textContent.trim()`);
      await openHowItWorks(t);
      await t.page.click(20, Math.round(t.page.viewport.height / 2));
      await t.page.waitFor(`!(${open})`, "a click on the dimmed page to close the panel", 5000);
      t.note.clickOutsideCloses = true;
      await openHowItWorks(t);
      await scrollPanelTo(t, 4);
      const scrolledTo = await t.page.js(`Math.round(howPanel().querySelector(".thin-scroll").scrollTop)`);
      await t.page.clickButton("Close");
      await t.page.waitFor(`!(${open})`, "the Close button to close the panel", 5000);
      t.note.closeButtonCloses = true;
      await openHowItWorks(t);
      t.note.reopensWhereItWasLeft = (await t.page.js(`Math.round(howPanel().querySelector(".thin-scroll").scrollTop)`)) === scrolledTo && scrolledTo > 0;
      await t.page.js(`(howPanel().querySelector(".thin-scroll").scrollTo({ top: 0, behavior: "instant" }), true)`);
      await panelPictures(t);
      await t.snap();
    },
  },
  {
    name: "tablet-768x1024-how-it-works",
    viewport: { width: 768, height: 1024, scale: 1, mobile: true },
    about: "A tablet-sized window (768 x 1024), \"How it works\" open: from 640 px wide the panel is a card with the page showing round it.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await openHowItWorks(t);
      t.note.card = await t.page.js(`(() => { const r = howPanel().getBoundingClientRect(); return { widthPx: Math.round(r.width), heightPx: Math.round(r.height) }; })()`);
      await t.snap();
    },
  },
  {
    name: "phone-top-bar",
    viewport: PHONE,
    about: "The top bar of a phone-sized window (390 px wide), enlarged: \"Relight\", the \"How it works\" button and a one-word status pill.",
    async run(t) {
      await t.page.goto(t.url + "/");
      t.note.bar = await topBar(t);
      t.note.tooltip = (await t.page.status()).title;
      await t.snap(phoneBarClip(t));
    },
  },
  {
    name: "phone-320-top-bar",
    viewport: { width: 320, height: 740, scale: 2, mobile: true },
    about: "The top bar of the narrowest phone (320 px wide), enlarged: the three parts still fit on one line.",
    async run(t) {
      await t.page.goto(t.url + "/");
      t.note.bar = await topBar(t);
      if (t.note.bar.barOverflows || t.note.bar.pageScrollsSideways) throw new Error(`The top bar does not fit at 320 px: ${JSON.stringify(t.note.bar)}`);
      await t.snap(phoneBarClip(t));
    },
  },
  {
    name: "phone-how-it-works-open",
    viewport: PHONE,
    about: "A phone-sized window straight after tapping \"How it works\": the panel fills the whole screen.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await openHowItWorks(t);
      t.note.fillsTheScreen = await t.page.js(`(() => { const r = howPanel().getBoundingClientRect(); return Math.round(r.width) === window.innerWidth && Math.round(r.height) === window.innerHeight; })()`);
      await t.snap();
    },
  },
  ...[1, 2, 3, 4].map((step) => ({
    name: `phone-how-it-works-step-${step}`,
    viewport: PHONE,
    about: `A phone-sized window, the "How it works" panel scrolled to step ${step}.`,
    async run(t) {
      await t.page.goto(t.url + "/");
      await openHowItWorks(t);
      await scrollPanelTo(t, step);
      t.note.sideNoteShown = await t.page.js(`[...howPanel().querySelectorAll("article div.text-zinc-500")].some((e) => e.offsetParent !== null)`);
      await t.snap();
    },
  })),
  {
    name: "phone-how-it-works-step-5-and-limits",
    viewport: PHONE,
    about: "A phone-sized window, the \"How it works\" panel scrolled to the very end: step 5 and \"Honest limits\".",
    async run(t) {
      await t.page.goto(t.url + "/");
      await openHowItWorks(t);
      await scrollPanelTo(t, "end");
      await t.snap();
    },
  },
  {
    name: "shading-line-full-quality",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "Close-up of the open GEOMETRY panel on a computer where everything works: the new last line reads \"shading: graphics chip, full quality\". The mouse rests on it.",
    async run(t) {
      await openSample(t, "Portrait");
      await openGeometry(t);
      await readShading(t);
      const c = await t.page.centre(`shadingLine()`, "the shading line");
      await t.page.mouse("mouseMoved", c.x, c.y);
      await t.snap({ asIs: true, sidebar: "bottom", ...(await geometryClip(t)) });
    },
  },
  {
    name: "no-float-filtering",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "A graphics chip that cannot smooth floating-point textures, \"Portrait\" sample, \"Left\" preset, GEOMETRY open: nothing changes. Still \"graphics chip, full quality\" and no note.",
    async run(t) {
      await withoutExtensions(t, FLOAT_FILTERING);
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      await openGeometry(t);
      await readShading(t);
      t.note.taken = FLOAT_FILTERING;
      if (t.note.shadingLine !== "shading: graphics chip, full quality" || t.note.greyNote) throw new Error(`Expected full quality and no note: ${JSON.stringify(t.note)}`);
      await t.snap();
    },
  },
  {
    name: "no-float-colour-buffers",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "A graphics chip that cannot draw into floating-point buffers, \"Portrait\" sample, \"Left\" preset, GEOMETRY open: the picture looks the same, there is no note, and the last line of GEOMETRY reads \"graphics chip, compatibility mode\".",
    async run(t) {
      await withoutExtensions(t, FLOAT_COLOUR_BUFFERS);
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      await openGeometry(t);
      await readShading(t);
      t.note.taken = FLOAT_COLOUR_BUFFERS;
      if (t.note.shadingLine !== "shading: graphics chip, compatibility mode" || t.note.greyNote) throw new Error(`Expected compatibility mode and no note: ${JSON.stringify(t.note)}`);
      await t.snap();
    },
  },
  {
    name: "shading-line-compatibility-mode",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "Close-up of the open GEOMETRY panel on a graphics chip that cannot draw into floating-point buffers: \"shading: graphics chip, compatibility mode\".",
    async run(t) {
      await withoutExtensions(t, FLOAT_COLOUR_BUFFERS);
      await openSample(t, "Portrait");
      await openGeometry(t);
      await readShading(t);
      await t.snap({ sidebar: "bottom", ...(await geometryClip(t)) });
    },
  },
  {
    name: "no-webgl-all-panels",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "A browser without WebGL2 in a taller window (1440 x 1300), \"Coffee cup\" sample, \"Right\" preset, GEOMETRY open: the grey note, the lit photo and the whole sidebar at once.",
    async run(t) {
      await withoutWebGL2(t);
      await openSample(t, "Coffee cup");
      await t.page.clickButton("Right");
      await openGeometry(t);
      await readShading(t);
      await t.snap();
    },
  },
  {
    name: "processor-note",
    about: "Close-up of the grey note above the stage when the processor is shading (a browser without WebGL2).",
    async run(t) {
      await withoutWebGL2(t);
      await openSample(t, "Portrait");
      await readShading(t);
      t.note.noteHas = await t.page.js(`(() => { const e = [...document.querySelectorAll('p[role="status"]')].find((p) => p.textContent.trim() === shadingNote()); const c = getComputedStyle(e); return { closeButton: !!e.querySelector("button"), retry: e.textContent.includes("Retry"), textColour: c.color, borderColour: c.borderColor, heightPx: Math.round(e.getBoundingClientRect().height) }; })()`);
      await t.snap(await t.page.clipOf(`[...document.querySelectorAll('p[role="status"]')].find((p) => p.textContent.trim() === shadingNote())`, "the grey note", { pad: 16, scale: 2 }));
    },
  },
  {
    name: "shading-line-processor-in-background",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "Close-up of the open GEOMETRY panel in a browser without WebGL2: \"shading: processor, in the background\".",
    async run(t) {
      await withoutWebGL2(t);
      await openSample(t, "Portrait");
      await openGeometry(t);
      await readShading(t);
      if (t.note.shadingLine !== "shading: processor, in the background") throw new Error(`Expected the background processor path: ${JSON.stringify(t.note)}`);
      await t.snap({ sidebar: "bottom", ...(await geometryClip(t)) });
    },
  },
  {
    name: "no-webgl-no-workers",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "A browser without WebGL2 that also blocks background threads (Workers), \"Portrait\" sample, \"Left\" preset, GEOMETRY open: the same grey note, and the last line of GEOMETRY reads \"shading: processor\".",
    async run(t) {
      await withoutWebGL2(t);
      await withoutWorkers(t);
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      await openGeometry(t);
      await readShading(t);
      t.note.timings = await t.page.js(`({ fullPictureMs: Number(document.querySelector("canvas").dataset.fullMs), previewMs: Number(document.querySelector("canvas").dataset.previewMs) })`);
      if (t.note.shadingLine !== "shading: processor") throw new Error(`Expected the page's own thread: ${JSON.stringify(t.note)}`);
      await t.snap();
    },
  },
  {
    name: "shading-line-processor",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "Close-up of the open GEOMETRY panel in a browser without WebGL2 and without Workers: \"shading: processor\".",
    async run(t) {
      await withoutWebGL2(t);
      await withoutWorkers(t);
      await openSample(t, "Portrait");
      await openGeometry(t);
      await readShading(t);
      await t.snap({ sidebar: "bottom", ...(await geometryClip(t)) });
    },
  },
  {
    name: "processor-preview-while-dragging",
    about: "A browser without WebGL2, \"Portrait\" sample, photographed while the sun is being dragged across the photo: the picture is the quick, softer preview.",
    async run(t) {
      await withoutWebGL2(t);
      await openSample(t, "Portrait");
      const from = await t.page.centre("lightHandle()", "the light handle");
      const box = await t.page.js("rectOf(photoBox())");
      const to = { x: box.x + 0.9 * box.w, y: box.y + 0.3 * box.h };
      await t.page.mouse("mouseMoved", from.x, from.y);
      await t.page.mouse("mousePressed", from.x, from.y, 1);
      // The mouse keeps moving while the picture is taken: the full picture arrives a fifth of a second after it stops.
      let i = 0;
      const steps = 240;
      let stop = false;
      const moving = (async () => {
        for (; i < steps && !stop; i++) {
          await t.page.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, 1);
          await sleep(12);
        }
      })();
      await t.page.waitFor(`document.querySelector("canvas").dataset.quality === "preview" && Number(lightHandle().getAttribute("aria-label").match(/x (-?\\d+\\.\\d+)/)[1]) > 0.5`, "the light to be half way across", 10_000);
      await t.snap({ asIs: true, quick: true });
      t.note.pictureAfterTheShot = await t.page.js(`document.querySelector("canvas").dataset.quality`);
      stop = true;
      await moving;
      await t.page.mouse("mouseReleased", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, 0);
      t.note.light = { ...t.note.light, moving: true };
      t.note.previewSize = await t.page.js(`(() => { const c = document.querySelector("canvas"); return { canvasPx: c.width + " x " + c.height, previewMs: Number(c.dataset.previewMs) }; })()`);
      if (t.note.picture !== "quick preview (the light was moving)" || t.note.pictureAfterTheShot !== "preview") throw new Error(`The picture was not the preview: ${JSON.stringify(t.note)}`);
    },
  },
  {
    name: "processor-sharp-after-drag",
    about: "The same drag, a moment after the mouse was let go at the right of the photo: the picture has sharpened to full quality.",
    async run(t) {
      await withoutWebGL2(t);
      await openSample(t, "Portrait");
      await t.page.dragLight(0.9, 0.3);
      await t.page.sharp();
      t.note.timings = await t.page.js(`({ fullPictureMs: Number(document.querySelector("canvas").dataset.fullMs), previewMs: Number(document.querySelector("canvas").dataset.previewMs) })`);
      await t.snap();
    },
  },
  {
    name: "processor-sweep-during",
    about: "A browser without WebGL2, about two and a half seconds into a Sweep: the picture stays the quick, softer preview until the sweep ends.",
    async run(t) {
      await withoutWebGL2(t);
      await openSample(t, "Portrait");
      await t.page.clickButton("Sweep");
      await t.page.waitFor(`!!byText("button", "Stop sweep") && (() => { const m = lightHandle()?.getAttribute("aria-label").match(/x (-?\\d+\\.\\d+), y (-?\\d+\\.\\d+)/); return !!m && Number(m[1]) > 0.9 && Number(m[2]) < 0.5; })()`, "the light to reach the right edge during the sweep", 8000);
      await t.snap({ quick: true });
      t.note.light = { ...t.note.light, moving: true };
      if (t.note.picture !== "quick preview (the light was moving)") throw new Error(`The picture was not the preview: ${JSON.stringify(t.note)}`);
      if (!(await t.page.js(`!!byText("button", "Stop sweep")`))) throw new Error("The sweep had ended before the picture was taken.");
      await t.page.waitFor(`!!byText("button", "Sweep")`, "the sweep to finish", 10_000);
      await t.page.sharp();
      t.note.pictureAfterTheSweep = await t.page.js(`document.querySelector("canvas").dataset.quality`);
    },
  },
  {
    name: "processor-enhance-done",
    needs: "backend",
    about: "A browser without WebGL2, Enhance finished on the \"Portrait\" sample (\"Left\" preset): the Enhanced tab, with the grey note still above the stage.",
    async run(t) {
      await withoutWebGL2(t);
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      await t.page.clickButton("Enhance");
      await t.page.waitFor(enhancedReady, "the Enhanced tab with both pictures", 120_000);
      await readShading(t);
      await t.snap({ sidebar: "bottom" });
    },
  },
  {
    name: "phone-processor-note",
    viewport: PHONE,
    about: "A phone-sized window without WebGL2, \"Coffee cup\" sample: the grey note takes four lines and pushes the photo down by its height.",
    async run(t) {
      await withoutWebGL2(t);
      await openSample(t, "Coffee cup");
      await readShading(t);
      t.note.noteLines = await t.page.js(`(() => { const e = [...document.querySelectorAll('p[role="status"]')].find((p) => p.textContent.trim() === shadingNote()); return Math.round((e.getBoundingClientRect().height - 16) / parseFloat(getComputedStyle(e).lineHeight)); })()`);
      await t.snap();
    },
  },
  {
    name: "phone-processor-full-page",
    viewport: PHONE,
    about: "The same phone-sized page without WebGL2, photographed from top to bottom with GEOMETRY opened.",
    async run(t) {
      await withoutWebGL2(t);
      await openSample(t, "Coffee cup");
      await openGeometry(t);
      await readShading(t);
      await t.page.js(`(window.scrollTo(0, 0), true)`);
      await t.snap({ fullPage: true });
    },
  },
  {
    name: "shader-compile-failed",
    about: "A graphics chip whose driver rejects the shader, \"Portrait\" sample, \"Left\" preset: the processor shades, and the grey note gives that reason in its brackets.",
    async run(t) {
      await withBrokenShaders(t);
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      await readShading(t);
      if (!t.note.greyNote?.includes("the shader did not compile on this graphics chip")) throw new Error(`Expected the compile reason: ${JSON.stringify(t.note)}`);
      await t.snap();
    },
  },
  {
    name: "graphics-chip-stopped-waiting",
    about: "\"Portrait\" sample, \"Left\" preset, in the two and a half seconds after the graphics chip stops responding: the page is waiting for it to come back.",
    async run(t) {
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      await t.page.painted();
      await loseGraphicsChip(t);
      await sleep(600); // inside the 2.5 s the page gives the chip to come back (CONTEXT_RESTORE_WAIT_MS)
      t.note.greyNote = await t.page.js(`shadingNote()`);
      t.note.busyText = await t.page.js(`document.body.innerText.includes("Preparing the shader")`);
      // What is on the stage while the chip is away: the photo under the canvas, and the canvas itself.
      t.note.stage = await t.page.js(`(() => { const photo = document.querySelector('img[alt="Original photo"]'); const canvas = document.querySelector("canvas"); const c = getComputedStyle(canvas); return { photoLoaded: photo.complete && photo.naturalWidth > 0, canvasContextLost: canvas.getContext("webgl2")?.isContextLost() ?? null, canvasOpacity: c.opacity, canvasVisibility: c.visibility, canvasClass: canvas.className }; })()`);
      await t.snap({ quick: true });
      if (t.note.greyNote) throw new Error("The page had already switched to the processor.");
    },
  },
  {
    name: "graphics-chip-stopped",
    about: "The same a few seconds later: the chip did not come back, so the processor has taken over, with the grey note saying why.",
    async run(t) {
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      await t.page.painted();
      const started = Date.now();
      await loseGraphicsChip(t);
      await t.page.waitFor(`(shadingNote() ?? "").includes("the graphics chip stopped responding")`, "the processor to take over", 15_000);
      t.note.secondsUntilTheNote = Number(((Date.now() - started) / 1000).toFixed(1));
      t.note.shading = await t.page.sceneReady();
      await readShading(t);
      await t.snap();
    },
  },
  {
    name: "slow-processor-server-renders",
    needs: "backend",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "A device with no WebGL2 and a slow processor, \"Portrait\" sample, \"Left\" preset, GEOMETRY open: a grey note says the server draws the photo instead, and the last line of GEOMETRY reads \"shading: server renders\".",
    async run(t) {
      await slowProcessorScene(t);
      await t.page.clickButton("Left");
      await t.page.waitFor(`new Promise((r) => setTimeout(() => r(document.querySelector('img[alt="Relit photo"]')?.complete === true), 900))`, "the server render for the Left preset");
      await openGeometry(t);
      await readShading(t);
      t.note.buttons = await t.page.js(`["Sweep", "Enhance", "Hold to see original", "Export PNG"].map((x) => x + ": " + (byText("button", x).disabled ? "disabled" : "enabled"))`);
      if (t.note.shadingLine !== "shading: server renders") throw new Error(`Expected server renders: ${JSON.stringify(t.note)}`);
      await t.snap();
    },
  },
  {
    name: "slow-processor-server-lost",
    needs: "backend",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "The same device after the backend stops and \"Right\" is clicked: no red bar. The page has gone back to shading on the processor, with the usual grey note.",
    async run(t) {
      await slowProcessorScene(t);
      await t.page.clickButton("Left");
      await t.page.waitFor(`new Promise((r) => setTimeout(() => r(document.querySelector('img[alt="Relit photo"]')?.complete === true), 900))`, "the server render for the Left preset");
      unroute(t, t.api);
      await t.page.route(t.api, "fail");
      await t.page.clickButton("Right");
      await t.page.waitFor(`(shadingNote() ?? "").startsWith("Shading on this device") && !document.querySelector('img[alt="Relit photo"]')`, "the page to go back to the processor", 60_000);
      t.note.shading = await t.page.sceneReady();
      await openGeometry(t);
      await readShading(t);
      await t.snap();
    },
  },
  {
    name: "no-shading-at-all-server-renders",
    needs: "backend",
    about: "A browser in which neither the graphics chip nor the processor can shade, \"Portrait\" sample, \"Left\" preset: only now does the red bar appear, and the picture comes from the server.",
    async run(t) {
      await withoutWebGL2(t);
      await withoutCanvas2D(t);
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      await t.page.waitFor(`new Promise((r) => setTimeout(() => r(document.querySelector('img[alt="Relit photo"]')?.complete === true), 900))`, "the server render for the Left preset");
      await readShading(t);
      t.note.sunShown = await t.page.js(`!!lightHandle()`);
      t.note.buttons = await t.page.js(`["Sweep", "Enhance", "Hold to see original", "Export PNG"].map((x) => x + ": " + (byText("button", x).disabled ? "disabled" : "enabled"))`);
      await t.snap();
    },
  },
  {
    name: "no-shading-at-all-backend-stopped",
    needs: "backend",
    stopped: true,
    about: "The same browser with the backend not running: the red bar with \"Retry\" above the plain photo, no sun, and the light controls greyed out.",
    async run(t) {
      await withoutWebGL2(t);
      await withoutCanvas2D(t);
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/", { settleStatus: false });
      await clickSample(t, "Portrait");
      await t.page.waitFor(`alerts().some((a) => a.includes("the server render that would replace it failed"))`, "the red bar that says the server render failed");
      await readShading(t);
      t.note.retryLink = await t.page.js(`!!byText('[role="alert"] button', "Retry")`);
      t.note.sunShown = await t.page.js(`!!lightHandle()`);
      t.note.buttons = await t.page.js(`["Sweep", "Enhance", "Hold to see original", "Export PNG"].map((x) => x + ": " + (byText("button", x).disabled ? "disabled" : "enabled"))`);
      await t.snap();
    },
  },
  {
    name: "demo-top-bar",
    needs: "demo",
    about: "The static demo build: close-up of the right end of the top bar, with the \"How it works\" button beside the pill.",
    async run(t) {
      await t.page.goto(t.url + "/");
      t.note.bar = await topBar(t);
      await t.snap(statusClip(t));
    },
  },
  {
    name: "demo-phone-top-bar",
    needs: "demo",
    viewport: PHONE,
    about: "The static demo build: the top bar of a phone-sized window, enlarged. The pill reads only \"demo\".",
    async run(t) {
      await t.page.goto(t.url + "/");
      t.note.bar = await topBar(t);
      t.note.tooltip = (await t.page.status()).title;
      await t.snap(phoneBarClip(t));
    },
  },
  {
    name: "demo-how-it-works-open",
    needs: "demo",
    about: "The static demo build straight after clicking \"How it works\": the same panel, with the demo's own grey line under \"Once per photo\".",
    async run(t) {
      await t.page.goto(t.url + "/");
      await openHowItWorks(t);
      t.note.panel = await panelText(t);
      await t.snap();
    },
  },
  {
    name: "demo-how-it-works-step-5-and-limits",
    needs: "demo",
    about: "The static demo build: the \"How it works\" panel alone, enlarged, scrolled to the very end. The line under \"Only if you press Enhance\" says it is switched off here.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await openHowItWorks(t);
      await scrollPanelTo(t, "end");
      await t.snap(await panelClip(t));
    },
  },
  {
    name: "demo-phone-how-it-works-open",
    needs: "demo",
    viewport: PHONE,
    about: "The static demo build on a phone straight after tapping \"How it works\": the panel fills the whole screen.",
    async run(t) {
      await t.page.goto(t.url + "/");
      await openHowItWorks(t);
      await t.snap();
    },
  },
  {
    name: "demo-no-float-colour-buffers",
    needs: "demo",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "The static demo build on a graphics chip that cannot draw into floating-point buffers, \"Portrait\" sample, \"Left\" preset, GEOMETRY open: no note, and the last line of GEOMETRY reads \"graphics chip, compatibility mode\".",
    async run(t) {
      await withoutExtensions(t, FLOAT_COLOUR_BUFFERS);
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      await openGeometry(t);
      await readShading(t);
      if (t.note.shadingLine !== "shading: graphics chip, compatibility mode" || t.note.greyNote) throw new Error(`Expected compatibility mode and no note: ${JSON.stringify(t.note)}`);
      await t.snap();
    },
  },
  {
    name: "demo-no-float-filtering",
    needs: "demo",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "The static demo build on a graphics chip that cannot smooth floating-point textures, \"Portrait\" sample, \"Left\" preset, GEOMETRY open: nothing changes.",
    async run(t) {
      await withoutExtensions(t, FLOAT_FILTERING);
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      await openGeometry(t);
      await readShading(t);
      if (t.note.shadingLine !== "shading: graphics chip, full quality" || t.note.greyNote) throw new Error(`Expected full quality and no note: ${JSON.stringify(t.note)}`);
      await t.snap();
    },
  },
  {
    name: "demo-no-webgl-all-panels",
    needs: "demo",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "The static demo build without WebGL2 in a taller window, \"Coffee cup\" sample, \"Right\" preset, GEOMETRY open: the last line of GEOMETRY reads \"shading: processor, in the background\".",
    async run(t) {
      await withoutWebGL2(t);
      await openSample(t, "Coffee cup");
      await t.page.clickButton("Right");
      await openGeometry(t);
      await readShading(t);
      await t.snap();
    },
  },
  {
    name: "demo-phone-no-webgl",
    needs: "demo",
    viewport: PHONE,
    about: "The static demo build on a phone without WebGL2, \"Cat\" sample: the four-line grey note above the photo, and the photo lit by the processor.",
    async run(t) {
      await withoutWebGL2(t);
      await openSample(t, "Cat");
      await readShading(t);
      await t.snap();
    },
  },
  {
    name: "demo-no-shading-at-all",
    needs: "demo",
    about: "The static demo build in a browser in which neither the graphics chip nor the processor can shade: the red bar above the plain photo, no sun, and everything that would change the light greyed out.",
    async run(t) {
      await withoutWebGL2(t);
      await withoutCanvas2D(t);
      await t.page.goto(t.url + "/");
      await clickSample(t, "Portrait");
      await t.page.waitFor(`alerts().some((a) => a.includes("this demo has no server to shade the photo"))`, "the red bar");
      await readShading(t);
      t.note.retryLink = await t.page.js(`!!byText('[role="alert"] button', "Retry")`);
      t.note.sunShown = await t.page.js(`!!lightHandle()`);
      t.note.buttons = await t.page.js(`["Sweep", "Enhance", "Hold to see original", "Export PNG"].map((x) => x + ": " + (byText("button", x).disabled ? "disabled" : "enabled"))`);
      await t.snap();
    },
  },
  // ----- Added for the fourth round: a photo analysed in the browser (the static demo takes uploads, mock mode
  // ----- no longer lights them as a dome, the normal app offers it when its backend is gone), and a picture
  // ----- dragged in from another web site. At the end again, so no older number changes.
  {
    name: "drop-web-image-blocked",
    about: "A picture dragged from another web site onto the drop box, when that site does not let other pages read its pictures (most do not): a red bar under the thumbnails says so and gives the two ways that always work.",
    async run(t) {
      const site = await otherSite(t);
      await dropOnBox(t, draggedPicture(`${site}/closed/photo.jpg`));
      await t.page.waitFor(`alerts().length > 0`, "the red bar");
      t.note.error = (await t.page.js("alerts()"))[0];
      t.note.how = "A real drop, made by Chrome, of the address of a picture on a second web server the tool runs on another port. That server sends the picture without the header that lets other pages read it.";
      await t.snap();
    },
  },
  ...[
    ["drop-web-image-404", "/missing.jpg", "the site answers that the picture is not there (404)", 10_000],
    ["drop-web-image-too-slow", "/slow/photo.jpg", "the site does not answer within 15 seconds", 30_000],
    ["drop-web-page", "/page", "the address is a web page, not a picture", 10_000],
  ].map(([name, path, what, timeout]) => ({
    name,
    about: `Close-up of the drop box and the red bar under the thumbnails after dragging an address from another web site, when ${what}.`,
    async run(t) {
      const site = await otherSite(t);
      const started = Date.now();
      await dropOnBox(t, draggedPicture(site + path));
      await t.page.waitFor(`alerts().length > 0`, "the red bar", timeout);
      t.note.secondsUntilTheBar = Number(((Date.now() - started) / 1000).toFixed(1));
      t.note.error = (await t.page.js("alerts()"))[0];
      await t.snap(await dropBoxClip(t));
    },
  })),
  {
    name: "drop-nothing-an-image",
    about: "Close-up of the drop box and the red bar after dropping something that holds no picture and no picture's address (a few words of text dragged from another page).",
    async run(t) {
      await dropOnBox(t, [{ mimeType: "text/plain", data: "just some words" }]);
      await t.page.waitFor(`alerts().length > 0`, "the red bar");
      t.note.error = (await t.page.js("alerts()"))[0];
      await t.snap(await dropBoxClip(t));
    },
  },
  {
    name: "drop-unreadable-address",
    about: "Close-up of the drop box and the red bar after dropping a picture that a page holds inside its own address (a \"data:\" address) and that is damaged.",
    async run(t) {
      await dropOnBox(t, draggedPicture("data:image/png;base64,@@@"));
      await t.page.waitFor(`alerts().length > 0`, "the red bar");
      t.note.error = (await t.page.js("alerts()"))[0];
      await t.snap(await dropBoxClip(t));
    },
  },
  {
    name: "drop-web-image-accepted",
    about: "A picture dragged from another web site that does let other pages read it: it is taken like a dropped file. \"Left\" preset.",
    async run(t) {
      const site = await otherSite(t);
      await dropOnBox(t, draggedPicture(`${site}/open/photo.jpg`));
      t.note.shading = await t.page.sceneReady();
      await t.page.clickButton("Left");
      t.note.redBars = await t.page.js("alerts()");
      t.note.how = "The same second web server, this time sending the picture with the header that lets other pages read it.";
      await t.snap();
    },
  },
  {
    name: "backend-offline-analyse-in-browser",
    needs: "backend",
    stopped: true,
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "The backend is not running, a photo was chosen and \"Analyse in this browser\" clicked on the failed-load card: the photo is lit all the same. \"Left\" preset, GEOMETRY open.",
    async run(t) {
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/", { settleStatus: false });
      await t.page.upload(join(t.photos, PHOTO.portrait));
      await failedCard(t);
      cardIsGone(t);
      const started = Date.now();
      await t.page.clickButton("Analyse in this browser");
      t.note.shading = await t.page.sceneReady();
      t.note.sceneSeconds = Number(((Date.now() - started) / 1000).toFixed(1));
      await t.page.clickButton("Left");
      await openGeometry(t);
      await readDepth(t);
      await readShading(t);
      t.note.detailedNormals = await detailSwitch(t);
      t.note.askedOfBackend = backendRequests(t);
      await t.snap();
    },
  },
  {
    name: "browser-scene-detailed-normals-backend-stopped",
    needs: "backend",
    stopped: true,
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "The same photo, analysed in the browser, after turning Detailed normals on while the backend is still not running: a red bar above the stage, the photo keeps its shape and the switch goes back off.",
    async run(t) {
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/", { settleStatus: false });
      await t.page.upload(join(t.photos, PHOTO.portrait));
      await failedCard(t);
      cardIsGone(t);
      await t.page.clickButton("Analyse in this browser");
      t.note.shading = await t.page.sceneReady();
      await t.page.clickButton("Left");
      await openGeometry(t);
      await t.page.toggle("Detailed normals");
      await t.page.waitFor(`alerts().some((a) => a.includes("The photo keeps the shape worked out in this browser.")) && document.querySelector('button[role="switch"][aria-label="Detailed normals"]').getAttribute("aria-checked") === "false"`, "the red bar and the switch back off");
      t.note.error = (await t.page.js("alerts()"))[0];
      await readDepth(t);
      t.note.detailedNormals = await detailSwitch(t);
      await t.snap();
    },
  },
  {
    name: "browser-scene-detailed-normals-from-server",
    needs: "backend",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "The same photo, analysed in the browser, after the backend has come back and Detailed normals was turned on: the backend's scene has taken the place of the browser's. \"Left\" preset, GEOMETRY open.",
    async run(t) {
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/", { settleStatus: false });
      await t.page.upload(join(t.photos, PHOTO.portrait));
      await failedCard(t);
      cardIsGone(t);
      await t.page.clickButton("Analyse in this browser");
      t.note.shading = await t.page.sceneReady();
      await openGeometry(t);
      t.note.before = { ...(await detailSwitch(t)), depthLine: await t.page.js(`depthLine()?.textContent.trim() ?? null`) };
      await t.page.release(); // the backend answers again
      // The pill asks the backend how it is every ten seconds (HEALTH_POLL_MS in frontend/components/TopNav.tsx), so it says "offline" a little longer.
      await t.page.waitFor(`!statusPill().textContent.includes("offline")`, "the status pill to notice that the backend is back", 30_000);
      await t.page.toggle("Detailed normals");
      await t.page.waitFor(`!depthLine() && !busyText() && !document.body.innerText.includes("Estimating depth") && document.querySelector('button[role="switch"][aria-label="Detailed normals"]').getAttribute("aria-checked") === "true"`, "the backend's scene", 240_000);
      t.note.shading = await t.page.sceneReady();
      await t.page.clickButton("Left");
      await openGeometry(t);
      await readDepth(t);
      t.note.detailedNormals = await detailSwitch(t);
      t.note.redBars = await t.page.js("alerts()");
      await t.snap();
    },
  },
  {
    name: "mock-analysis-failed",
    needs: "mock",
    about: "Frontend mock mode, a photo chosen when the depth model cannot be downloaded: the failed-load card, which in mock mode alone has the extra button \"Use a stand-in dome\".",
    async run(t) {
      await t.page.route(MODEL_HOST, "fail");
      await t.page.goto(t.url + "/");
      await forgetDepthModel(t);
      await t.page.upload(join(t.photos, PHOTO.portrait));
      await failedCard(t);
      t.note.domeButtonTooltip = await t.page.js(`byText("button", "Use a stand-in dome")?.title ?? null`);
      t.note.how = `Requests to ${MODEL_HOST} were refused inside Chrome after the stored copy of the model was deleted.`;
      await t.snap();
    },
  },
  {
    name: "mock-stand-in-dome",
    needs: "mock",
    about: "The same after clicking \"Use a stand-in dome\", with the \"Left\" preset: the photo is lit as a made-up round dome and a grey note above the stage says so.",
    async run(t) {
      await t.page.route(MODEL_HOST, "fail");
      await t.page.goto(t.url + "/");
      await forgetDepthModel(t);
      await t.page.upload(join(t.photos, PHOTO.portrait));
      await failedCard(t);
      cardIsGone(t);
      await t.page.clickButton("Use a stand-in dome");
      t.note.shading = await t.page.sceneReady();
      await t.page.clickButton("Left");
      t.note.domeNote = await t.page.js(`[...document.querySelectorAll('p[role="status"]')].map((e) => e.textContent.trim()).find((x) => x.includes("made-up dome")) ?? null`);
      await t.snap();
    },
  },
  ...[
    ["demo-depth-downloading", "downloading", "the first photo on this browser, part of the way through downloading the depth model", /^Downloading the depth model, \d+ MB, once… \d+%$/],
    ["demo-depth-starting", "starting", "the depth model has arrived and is being started", /^Starting the depth model…$/],
    ["demo-depth-working-out-shape", "estimating", "the depth model is running on the photo", /^Working out the shape of your photo…$/],
  ].map(([name, at, what, line]) => ({
    name,
    needs: "demo",
    about: `The static demo build just after choosing a photo, held still: ${what}.`,
    async run(t) {
      await holdDepthAt(t, DEPTH_MESSAGE[at]);
      await t.page.goto(t.url + "/");
      await forgetDepthModel(t);
      await t.page.upload(join(t.photos, PHOTO.portrait));
      await t.page.waitFor(`window.__depthHeld() && ${line}.test(busyText() ?? "")`, `the line ${line}`, 180_000);
      t.note.line = await t.page.js(`busyText()`);
      t.note.how = "The messages the depth model's Worker sends the page were kept back from this one on until the picture was taken. In normal use the line changes by itself.";
      await t.snap();
      await releaseDepth(t);
      t.note.shading = await t.page.sceneReady();
    },
  })),
  {
    name: "demo-depth-loading-stored",
    needs: "demo",
    about: "The static demo build just after choosing a photo, held still, on a browser that already has the depth model from an earlier photo: no download, only \"Loading the depth model…\".",
    async run(t) {
      // Once without holding anything, so that this browser has the model.
      await openScene(t);
      await holdDepthAt(t, DEPTH_MESSAGE.loadingStored);
      await t.page.goto(t.url + "/");
      await t.page.upload(join(t.photos, PHOTO.object));
      await t.page.waitFor(`window.__depthHeld() && busyText() === "Loading the depth model…"`, "the line Loading the depth model…", 60_000);
      t.note.line = await t.page.js(`busyText()`);
      t.note.how = "The page was loaded a second time; the first photo had stored the model. The Worker's messages were kept back from this one on until the picture was taken.";
      await t.snap();
      await releaseDepth(t);
      t.note.shading = await t.page.sceneReady();
    },
  },
  {
    name: "demo-own-photo-left",
    needs: "demo",
    about: "The static demo build with an uploaded photo (the astronaut portrait) analysed in the browser, \"Left\" preset. Compare with the next picture.",
    async run(t) {
      await openScene(t);
      await t.page.clickButton("Left");
      await t.snap();
    },
  },
  {
    name: "demo-sample-portrait-left",
    needs: "demo",
    about: "The static demo build with the built-in \"Portrait\" sample, which is the same photograph, at the same light (\"Left\" preset): its maps were made ahead of time by the server's two models.",
    async run(t) {
      await openSample(t, "Portrait");
      await t.page.clickButton("Left");
      await t.snap();
    },
  },
  {
    name: "demo-own-photo-vs-sample",
    needs: "demo",
    about: "The two pictures before this one side by side: left, the uploaded portrait analysed in the browser; right, the built-in \"Portrait\" sample. Same photograph, same light (\"Left\" preset).",
    async run(t) {
      // The photo, with room on its left for the sun, which the Left preset puts outside the picture.
      const stage = async () => {
        const r = await t.page.js(`rectOf(photoBox())`);
        return { clip: { x: r.x - SUN_MARGIN_PX, y: r.y - PHOTO_MARGIN_PX, width: r.w + SUN_MARGIN_PX + PHOTO_MARGIN_PX, height: r.h + 2 * PHOTO_MARGIN_PX, scale: 1 } };
      };
      await openScene(t);
      await t.page.clickButton("Left");
      t.note.light = await t.page.light();
      const own = await t.page.capture(null, await stage());
      await t.page.clickButton("New photo");
      await clickSample(t, "Portrait");
      await t.page.sceneReady();
      await t.page.clickButton("Left");
      t.note.sampleLight = await t.page.light();
      const sample = await t.page.capture(null, await stage());
      await sideBySide(t, [
        { label: "Your own photo, analysed in this browser (depth model only)", jpeg: own },
        { label: "The built-in Portrait sample (depth and detailed normals, made ahead of time)", jpeg: sample },
      ]);
    },
  },
  {
    name: "demo-own-photo-geometry",
    needs: "demo",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "The static demo build: close-up of the open GEOMETRY panel for an uploaded photo analysed in the browser. It says how the maps were made, and has a new \"depth:\" line.",
    async run(t) {
      await openScene(t);
      await openGeometry(t);
      await readDepth(t);
      await readShading(t);
      t.note.detailedNormals = await detailSwitch(t);
      await t.snap({ sidebar: "bottom", ...(await geometryClip(t)) });
    },
  },
  {
    name: "demo-own-photo-detailed-normals",
    needs: "demo",
    viewport: { width: 1440, height: 1300, scale: 1, mobile: false },
    about: "The static demo build: close-up of the Detailed normals switch for an uploaded photo. It is off, greyed out and cannot be clicked.",
    async run(t) {
      await openScene(t);
      await openGeometry(t);
      t.note.detailedNormals = await detailSwitch(t);
      if (t.note.detailedNormals.on || !t.note.detailedNormals.disabled) throw new Error(`Expected the switch off and disabled: ${JSON.stringify(t.note.detailedNormals)}`);
      await t.snap({ sidebar: "bottom", ...(await t.page.clipOf(`document.querySelector('button[role="switch"][aria-label="Detailed normals"]').closest("label")`, "the Detailed normals switch", { pad: 14, scale: 3, block: "end" })) });
    },
  },
  {
    name: "demo-depth-model-not-downloaded",
    needs: "demo",
    about: "The static demo build, a photo chosen when the depth model cannot be downloaded (no connection to the site that holds it): the failed-load card on the grey photo.",
    async run(t) {
      await t.page.route(MODEL_HOST, "fail");
      await t.page.goto(t.url + "/");
      await forgetDepthModel(t);
      const started = Date.now();
      await t.page.upload(join(t.photos, PHOTO.portrait));
      await failedCard(t);
      t.note.secondsUntilTheCard = Number(((Date.now() - started) / 1000).toFixed(1));
      t.note.how = `Requests to ${MODEL_HOST} were refused inside Chrome after the stored copy of the model was deleted.`;
      await t.snap();
    },
  },
  {
    name: "demo-phone-own-photo-full-page",
    needs: "demo",
    viewport: PHONE,
    about: "The static demo build on a phone with an uploaded photo (the coffee cup) analysed in the browser, photographed from top to bottom with GEOMETRY opened.",
    async run(t) {
      await openScene(t, PHOTO.object);
      await openGeometry(t);
      await readDepth(t);
      await t.page.js(`(window.scrollTo(0, 0), true)`);
      await t.snap({ fullPage: true });
    },
  },
  {
    name: "sun-height-close-ups",
    about: "Three close-ups of the sun on the portrait side by side, nothing changed between them but the Height slider: 0.03 (fully left), 0.12 (where a new photo starts) and 2.00 (fully right). The sun's size, glow and shadow show how far in front of the photo the light is.",
    async run(t) {
      await openScene(t);
      const parts = [];
      t.note.sun = [];
      for (const [height, label] of [
        [0.03, "Height 0.03 (slider fully left): close to the surface"],
        [0.12, "Height 0.12: where a new photo starts"],
        [2, "Height 2.00 (slider fully right): close to you"],
      ]) {
        await t.page.setSlider("Height", height);
        t.note.sun.push(await sunLook(t));
        parts.push({ label, jpeg: await t.page.capture(null, await sunClip(t)) });
      }
      t.note.light = await t.page.light();
      await sideBySide(t, parts);
    },
  },
  {
    name: "sun-scroll-hint",
    about: "Close-up of the sun with the mouse resting on it for half a second: a line appears under it that says what the mouse wheel does there.",
    async run(t) {
      await openScene(t);
      await restOnSun(t);
      t.note.caption = await sunCaption(t);
      t.note.sun = await sunLook(t);
      await t.snap({ asIs: true, ...(await sunClip(t, 420, 220)) });
    },
  },
  {
    name: "sun-scrolled-nearer",
    about: "The portrait after turning the mouse wheel five notches up with the pointer on the sun: the light has come nearer, so Height has risen from 0.12 and the sun is larger. The mouse is still on the sun, so the line under it shows.",
    async run(t) {
      await openScene(t);
      const c = await restOnSun(t);
      t.note.heightBefore = (await t.page.light()).height;
      for (let notch = 0; notch < 5; notch++) await t.page.wheel(c.x, c.y, -100);
      await t.page.waitFor(`lightHandle().dataset.height !== "0.12"`, "the Height to change", 5000);
      await t.page.painted();
      t.note.sun = await sunLook(t);
      t.note.pageScrolledBy = await t.page.js(`window.scrollY`);
      await t.snap({ asIs: true });
      // And back down past where it started: seven notches the other way.
      for (let notch = 0; notch < 7; notch++) await t.page.wheel(c.x, c.y, 100);
      await t.page.painted();
      t.note.heightAfterSevenNotchesDown = (await t.page.light()).height;
    },
  },
  {
    name: "sun-keyboard-plus",
    about: "Close-up of the sun with keyboard focus after pressing the + key three times: a white ring round it, the same line under it, and Height three steps up from 0.12.",
    async run(t) {
      await openScene(t);
      await t.page.js(`(lightHandle().focus(), true)`);
      t.note.heights = [(await t.page.light()).height];
      for (let press = 0; press < 3; press++) {
        await t.page.key("+");
        await t.page.painted();
        t.note.heights.push((await t.page.light()).height);
      }
      t.note.focusRing = await t.page.js(`lightHandle().matches(":focus-visible")`);
      await t.page.waitFor(`(() => { const e = [...lightHandle().querySelectorAll("span[aria-hidden]")].find((x) => x.textContent.trim()); return !!e && Number(getComputedStyle(e).opacity) > 0.99; })()`, "the line under the sun to appear", 5000);
      t.note.caption = await sunCaption(t);
      t.note.sun = await sunLook(t);
      await t.snap({ asIs: true, ...(await sunClip(t, 420, 220)) });
      for (let press = 0; press < 3; press++) await t.page.key("-");
      await t.page.painted();
      t.note.heightAfterThreeMinus = (await t.page.light()).height;
    },
  },
  {
    name: "height-end-labels",
    about: "Close-up of the Height control in the LIGHT panel on a window 900 px tall: under the track, the words that say what each end means.",
    async run(t) {
      await openScene(t);
      t.note.heightControl = await heightControl(t);
      await t.snap(await heightClip(t));
    },
  },
  {
    name: "laptop-1280x720-height-control",
    viewport: { width: 1280, height: 720, scale: 1, mobile: false },
    about: "The same Height control on a short window (1280 x 720): no words under the track, so that the sidebar fits without scrolling. They are in the tooltip only.",
    async run(t) {
      await openScene(t);
      t.note.heightControl = await heightControl(t);
      await t.snap(await heightClip(t));
    },
  },
  {
    name: "phone-height-control",
    viewport: PHONE,
    about: "The Height control on a phone: the two end labels under the track, and under them the helper line that mentions pinching.",
    async run(t) {
      await openScene(t);
      t.note.heightControl = await heightControl(t);
      await t.snap(await heightClip(t, 2));
    },
  },
  {
    name: "phone-pinch-nearer",
    viewport: PHONE,
    about: "A phone after putting two fingers on the photo and spreading them to twice as far apart: the light has come nearer (Height has risen from 0.12, the sun is larger) and has not moved sideways.",
    async run(t) {
      await openScene(t);
      const box = await t.page.js("rectOf(photoBox())");
      const before = await t.page.light();
      const y = box.y + box.h * 0.6;
      const mid = box.x + box.w / 2;
      const fingers = (apart) => [{ x: mid - apart / 2, y }, { x: mid + apart / 2, y }];
      await t.page.touch("touchStart", fingers(80).slice(0, 1));
      await t.page.touch("touchStart", fingers(80));
      for (let apart = 90; apart <= 160; apart += 10) await t.page.touch("touchMove", fingers(apart));
      await t.page.touch("touchEnd", []);
      await t.page.painted();
      t.note.before = before;
      t.note.sun = await sunLook(t);
      t.note.how = "Two touch points 80 px apart were put on the photo, the second straight after the first, moved to 160 px apart and lifted (Chrome's own touch input).";
      await t.snap();
    },
  },
  {
    name: "heic-converting",
    about: "Just after choosing an iPhone photo (a .heic file) in Chrome, held still: the drop box reads \"Converting your photo…\" while the converter is fetched and the photo is turned into a picture the browser can show.",
    async run(t) {
      // Set before the page loads, like the other held requests. The converter's download is kept waiting, so the page stays on this line.
      await t.page.route(HEIC_CONVERTER_HOST, "hold");
      await t.page.goto(t.url + "/");
      t.note.fileChooserAccepts = await t.page.js(`document.querySelector('input[type="file"]').accept`);
      await t.page.upload(join(t.photos, PHOTO.heic));
      await t.page.waitFor(`document.body.innerText.includes("Converting your photo…")`, "the line Converting your photo…", 20_000);
      t.note.line = await t.page.js(`document.querySelector('div[role="button"]').innerText.trim()`);
      t.note.how = `The download of the converter from ${HEIC_CONVERTER_HOST} was held back until the picture was taken. In normal use the line shows for a second or two.`;
      await t.snap();
      await t.page.release();
      t.note.shading = await t.page.sceneReady();
    },
  },
  {
    name: "heic-photo-lit",
    about: "The iPhone photo 09-iphone-portrait.heic loaded and lit like any other photo, \"Left\" preset clicked.",
    async run(t) {
      await openScene(t, PHOTO.heic);
      await t.page.clickButton("Left");
      t.note.photoPixels = await t.page.js(`(() => { const i = document.querySelector('img[alt="Original photo"]'); return i.naturalWidth + " x " + i.naturalHeight; })()`);
      await t.snap();
    },
  },
  {
    name: "heic-sideways-photo",
    about: "10-iphone-sideways.heic, a tall photo that the file stores lying on its side with a note to turn it: it comes out upright, taller than wide.",
    async run(t) {
      await openScene(t, PHOTO.heicSideways);
      t.note.photoPixels = await t.page.js(`(() => { const i = document.querySelector('img[alt="Original photo"]'); return i.naturalWidth + " x " + i.naturalHeight; })()`);
      await t.snap();
    },
  },
  {
    name: "heic-12mp-photo",
    about: "11-iphone-12mp.heic, a full-size iPhone photo (4032 x 3024): shrunk while it is converted, then lit as usual.",
    async run(t) {
      await openScene(t, PHOTO.heic12mp);
      t.note.photoPixels = await t.page.js(`(() => { const i = document.querySelector('img[alt="Original photo"]'); return i.naturalWidth + " x " + i.naturalHeight; })()`);
      await t.snap();
    },
  },
  {
    name: "heic-error-cannot-convert",
    about: "A damaged iPhone photo (broken-photo.heic) was chosen: a red error under the drop box says it could not be converted and what to do instead.",
    async run(t) {
      await dropBoxError(t, join(t.photos, PHOTO.heicBroken));
      await t.snap();
    },
  },
  {
    name: "heic-error-no-converter",
    about: "An iPhone photo was chosen when the converter cannot be downloaded (no connection to the site that holds it): a red error under the drop box.",
    async run(t) {
      await t.page.route(HEIC_CONVERTER_HOST, "fail");
      await dropBoxError(t, join(t.photos, PHOTO.heic));
      t.note.how = `Requests to ${HEIC_CONVERTER_HOST} were refused inside Chrome.`;
      await t.snap();
    },
  },
  {
    name: "heic-error-too-large",
    about: "An iPhone-format photo of 8192 x 8192 pixels (67 million, over the 64 million the page converts) was chosen: a red error under the drop box gives its size.",
    async run(t) {
      await dropBoxError(t, tooLargeHeic(t));
      t.note.how = "The photo was made for this picture: one flat colour, saved as HEIC with the converter built into macOS.";
      await t.snap();
    },
  },
  {
    name: "demo-heic-photo",
    needs: "demo",
    about: "The static demo build with the iPhone photo 09-iphone-portrait.heic: converted and analysed in the browser, \"Left\" preset clicked.",
    async run(t) {
      await openScene(t, PHOTO.heic);
      await t.page.clickButton("Left");
      await t.snap();
    },
  },
];

// What a tester should see in each picture, written after looking at it: where the light is,
// which side is bright, what the readouts say. Goes into manifest.json as "see".
const SEE = {
  "landing": "Top bar: \"Relight  Banana Hacks 2026\" on the left; on the right the text button \"How it works\" and then the pill: amber dot, \"backend: online, mock providers\". Below: the yellow words \"MOVE THE LIGHT\", the heading \"Relight a photo by dragging the light.\", a dashed box \"Drop a photo here\", then \"Or try a sample photo:\" and four thumbnails: Portrait, Coffee cup, Cat, Rocket.",
  "upload-empty": "The same page at the address /relight. The dashed drop box is a little lighter because the mouse is on it.",
  "scene-loading": "The photo is dimmed with a pill \"Estimating depth and surface normals…\" in the middle. The whole sidebar is faded, the \"Sweep\", \"Enhance\", \"Hold to see original\" and \"Export PNG\" buttons are greyed out, and the GEOMETRY row has no thumbnails yet. There is no sun on the photo.",
  "scene-default-light": "The round white sun is on the flag at the left edge, about a third of the way down. Readouts: x 0.12, y 0.35, Height 0.12, Intensity 1.80, Ambient 0.06, Colour neutral, Cast shadows on. Under the Height track, in grey: \"close to the surface\" at the left end and \"close to you\" at the right end. The left side of the face (your left) is bright and the right cheek is in shadow; the right of the picture is darker than the left.",
  "scene-all-panels": "The same picture and readouts in a taller window. LIGHT, ENHANCE and the one-row GEOMETRY panel (two tiny thumbnails, \"Show\", down arrow) all show, with empty space under them.",
  "preset-left": "The sun is outside the photo on the left, a little above the middle. Readouts: x -0.10, y 0.40, Height 0.35, Intensity 1.30, Ambient 0.06. The left of the face and suit is bright; the right cheek is in soft shadow.",
  "preset-right": "The sun is outside the photo on the right. Readouts: x 1.10, y 0.40, Height 0.35, Intensity 1.30. The right side of the face and the helmet are bright; the left half of the face is dark.",
  "preset-top": "The sun is at the very top of the dark stage, above the photo in the middle. Readouts: x 0.50, y -0.15, Height 0.35, Intensity 1.30. These are the preset's own numbers on every window; that point is just above the stage here, so the sun is drawn at the stage's top edge. The sun is a little larger than at the start (Height 0.35) and the top of its disc is cut off by the stage's edge. The hair and forehead are bright; under the chin is dark.",
  "preset-low-and-warm": "The sun is orange-tinted at the bottom left corner of the photo. Readouts: x 0.00, y 0.90, Height 0.12, Intensity 1.60, Ambient 0.20, Colour warm 100, and the colour dot is pale orange. The whole picture has a warm orange cast and the face is lit from below.",
  "drag-far-left": "The sun sits on the left edge of the photo, half way down. Readouts: x 0.03, y 0.50; the sliders are still at their starting values (0.12, 1.80, 0.06). The left of the face is bright, the right cheek dark.",
  "drag-far-right": "The sun sits on the right edge of the photo, half way down. Readouts: x 0.97, y 0.50. The right of the face and the white helmet rim are bright; the left half of the face is dark.",
  "drag-top": "The sun sits on the top edge of the photo in the middle, on the hair. Readouts: x 0.50, y 0.03. The hair glows; the face below it is evenly lit.",
  "drag-outside-photo": "The sun is on the dark stage to the right of the photo, next to the sidebar. Readouts: x 1.21, y 0.30 (as far right as the stage allows). The lighting looks like the Right preset: right side bright, left half of the face dark.",
  "drag-centre": "The sun is in the middle of the photo on the metal neck ring. Readouts: x 0.50, y 0.45. The neck ring and chest near the sun are brightest; the face is dimmer than in the other shots because the light is low and below it.",
  "height-min": "Left preset with Height 0.03 (slider fully left). The light skims the surface: the picture is darker overall, with strong shadows across the face and suit. The sun, left of the photo, is at its smallest (about two thirds of its usual size) with almost no glow round it.",
  "height-max": "Left preset with Height 2.00 (slider fully right). The light is far in front: the whole picture is evenly lit, almost like the original photo. The sun, left of the photo, is at its largest (not quite twice its usual size) with a wide soft glow.",
  "intensity-low": "Left preset with Intensity 0.00 (slider fully left). The picture is very dark but still visible, lit only by the Ambient 0.06.",
  "intensity-high": "Left preset with Intensity 4.00 (slider fully right). The picture is very bright; the flag, the suit and the left of the face are close to white.",
  "ambient-low": "Left preset with Ambient 0.00 (slider fully left). Shadows are pure black: the right cheek and the right of the picture are darker than in 06-preset-left.",
  "ambient-high": "Left preset with Ambient 1.00 (slider fully right). No dark shadows are left; the picture is bright and flat.",
  "colour-warm": "Left preset with Colour \"warm 100\" (slider fully right). The sun handle and the colour dot are pale orange and the whole picture has an orange tint.",
  "colour-cool": "Left preset with Colour \"cool 100\" (slider fully left). The sun handle and the colour dot are pale blue and the whole picture has a blue tint.",
  "shadows-on": "Coffee cup, Left preset: readouts x -0.10, y 0.40, Height 0.10, Cast shadows on. The sun is drawn at the left edge of the stage (the true point is a little further left than the stage reaches). The cup throws a dark, soft-edged shadow to the right across the saucer and the spoon.",
  "shadows-off": "The same light with the Cast shadows switch off (grey, knob on the left). The dark shadow to the right of the cup is gone; the saucer and spoon on the right are lit.",
  "detailed-normals-on": "The sidebar is scrolled to the bottom. GEOMETRY is open (\"Hide\", arrow up): a grey Depth picture (\"white = near\"), a rainbow-coloured Normals picture (\"surface direction\") with fine detail, the Detailed normals switch on (yellow), then two small grey lines: \"512 x 512 px, relief 0.3\" and \"shading: graphics chip, full quality\".",
  "detailed-normals-off": "The same with the Detailed normals switch off (grey). The Normals picture is now smooth lilac with no fine detail, and the shading on the photo is flatter, with no outline round the head and shoulders. The two grey lines under the switch are unchanged.",
  "hold-original": "While the \"Hold to see original\" button is held: the untouched photo, evenly lit, with a small tag \"Original\" in its top left corner. The held button has yellow letters and a yellow outline. The sun and the readouts (x -0.10, y 0.40) do not change.",
  "enhance-before": "Left preset. The ENHANCE box holds the typed words \"golden hour\". The yellow button reads \"Enhance\".",
  "enhance-running": "Top left of the stage: two tabs, \"Live preview\" (selected) and \"Enhancing…\" (greyed out). Bottom left: a pill \"Enhancing in the background, keep dragging\". The yellow button is dimmed and reads \"Enhancing…\" with a spinner. The sun can still be dragged.",
  "enhance-done": "The \"Enhanced\" tab is selected. A vertical white line with a round handle splits the photo in the middle: left half tagged \"Live preview\", right half tagged \"Enhanced\". Below: \"Download enhanced\". In the sidebar the button reads \"Enhance again\" with a small download button beside it, and \"Sweep\" is greyed out. There is no sun.",
  "enhance-divider-dragged": "The same, with the divider line and its round handle a quarter of the way from the left edge, so three quarters of the photo shows the Enhanced side.",
  "enhance-back-to-live": "The \"Live preview\" tab is selected again and the sun is back (x -0.10, y 0.40). The \"Enhanced\" tab can be clicked. The sidebar button still reads \"Enhance again\" with the download button beside it.",
  "sample-portrait": "The astronaut portrait, opened from the \"Portrait\" thumbnail with no wait. Sun on the flag at the left; readouts x 0.12, y 0.35, Height 0.12, Intensity 1.80, Ambient 0.06. The left of the face is bright, the right cheek in shadow.",
  "object-side-light": "Coffee cup with the Right preset. Readouts x 1.10, y 0.40, Height 0.35, Intensity 1.30. The sun is drawn at the right edge of the stage, next to the sidebar (the true point is a little further right). The right of the table is bright and the cup's shadow falls to the left.",
  "cat-side-light": "Cat with the Left preset. The sun is at the left edge of the stage; readouts x -0.10, y 0.40. The left of the cat's face is bright and the right side, past the nose, falls off gradually into shade, with no hard dark wedge.",
  "dark-photo": "Night rocket with the Left preset; readouts x -0.10, y 0.40, sun at the left edge of the stage. The left faces of the rocket and of the towers are a little brighter, with faint soft shadows to their right on the sky. No hard black bands.",
  "tall-photo": "A tall, narrow portrait centred in the stage with wide dark margins left and right. Left preset: the sun is on the dark stage left of the photo, readouts x -0.10, y 0.40.",
  "wide-photo": "A wide, short strip of the coffee cup centred in the stage with dark margins above and below. Top preset: the sun is on the dark stage above the photo, readouts x 0.50, y -0.15.",
  "tiny-photo": "The cat photo, soft and blurry because a 200 px picture is stretched to fill the stage. Left preset, readouts x -0.10, y 0.40, sun at the left edge of the stage. The shading still works.",
  "huge-photo": "The portrait again; it looks the same as 06-preset-left, because the app shrinks a 3000 px photo before using it. Readouts x -0.10, y 0.40.",
  "error-not-an-image": "The first page is still showing. Under the four thumbnails is a red bar: \"That file is not an image.\" with an x to close it.",
  "backend-offline": "The first page. Top right pill: red dot, \"backend: offline\". The four sample thumbnails are still there and still work.",
  "backend-offline-upload": "The photo is grey and dim. A red-bordered card in the middle reads \"This photo could not be analysed\", then \"Cannot reach the backend at http://localhost:8123. Is it running?\", then in lighter letters \"Or analyse it in this browser: a depth model of about 25 MB downloads once, and the photo stays on this device. Surfaces shade a little flatter than with the server's detailed normals.\" Under that a yellow \"Analyse in this browser\" button with a plain \"Retry\" beside it, and \"Choose another photo\" on a line of its own. The sidebar is faded, \"Hold to see original\" and \"Export PNG\" are greyed out, and the pill reads \"offline\".",
  "enhance-error": "The live preview is still there (Left preset). Above the photo, across the top of the stage column, a red bar reads \"Cannot reach the backend at http://localhost:8123. Is it running?\" with an x to close it. Nothing red is in the ENHANCE panel, the yellow button reads \"Enhance\" again, and the pill reads \"offline\".",
  "phone-scene": "One column. Top bar: \"Relight\", \"How it works\" and a short pill that reads only \"online\" (amber dot; no word \"backend:\" and no \"mock providers\" at this width). Then the photo with the sun on the flag, \"Hold to see original\" and \"Export PNG\", and the LIGHT panel straight under the stage: x 0.12, y 0.35, Height 0.12, Intensity 1.80, Ambient 0.06. Under the Height track are the grey words \"close to the surface\" (left) and \"close to you\" (right), and under them the helper line \"Scroll or pinch on the sun to change it. Low grazes the surface and stretches the shadows.\" on two lines.",
  "phone-full-page": "The whole phone page: stage, LIGHT (the five buttons Left, Right, Top, Low and warm, Reset light on one line), ENHANCE with its helper line and a two-row box that reads \"Optional: a mood, such as golden hour\", and the one-row GEOMETRY panel at the bottom.",
  "phone-landing": "The first page in one column: the top bar with \"Relight\", \"How it works\" and the pill \"online\"; the heading on two lines, the dashed drop box, \"Or try a sample photo:\" and the four thumbnails in one row.",
  "status-checking": "The right end of the top bar, enlarged: \"How it works\", then the pill with a grey dot and \"backend: checking\". It shows for a moment after the page opens.",
  "status-online-mock-providers": "The right end of the top bar, enlarged: \"How it works\", then the pill with an amber dot and \"backend: online, mock providers\".",
  "status-online": "The right end of the top bar, enlarged: \"How it works\", then the pill with a green dot and \"backend: online\".",
  "status-offline": "The right end of the top bar, enlarged: \"How it works\", then the pill with a red dot and \"backend: offline\".",
  "no-webgl-fallback": "No red bar. Above the stage a grey note with a thin grey outline, no x and no \"Retry\": \"Shading on this device's processor, not its graphics chip (WebGL2 is not available in this browser). The picture is a quick preview while the light moves and sharpens when it stops.\" The photo is lit for the Left preset (x -0.10, y 0.40) exactly as in 06-preset-left, a little smaller because the note takes two lines. The sun, the sliders, \"Sweep\", \"Enhance\", \"Hold to see original\" and \"Export PNG\" are all available. The page asked the backend for nothing but the photo's analysis.",
  "not-found-page": "A black page with \"404\" and \"This page could not be found.\" in the middle, under the normal top bar, which has \"How it works\" and the status pill here too.",
  "mock-landing": "The first page with a yellow dot and \"backend: mock\" in the pill, and \"How it works\" to its left. The text under the heading starts \"Upload a photo or pick a sample. Its depth is estimated once, right here in your browser\". Under the dashed drop box are two grey lines: \"Your photo stays on this device: its shape is worked out in your browser and nothing is uploaded. The first photo downloads a depth model of about 25 MB, once.\" Then \"Or try a sample photo:\" and the four thumbnails.",
  "mock-status": "The right end of the top bar, enlarged: \"How it works\", then the pill with a yellow dot and \"backend: mock\".",
  "mock-scene": "An uploaded portrait in frontend mock mode with the Left preset (x -0.10, y 0.40), analysed in the browser. The shading follows the real face and suit: the left of the face is a little brighter and the right of the picture darker, much as in 06-preset-left but flatter. There is no round dome, and no note above the stage. There is no outline round the hair and shoulders. The GEOMETRY row shows two tiny thumbnails of the real shape.",
  "mock-enhance-running": "Frontend mock mode: tabs \"Live preview\" and \"Enhancing…\", the pill \"Enhancing in the background, keep dragging\" at the bottom left, and the dimmed \"Enhancing…\" button.",
  "mock-enhance-done": "Frontend mock mode, on an uploaded photo the browser analysed: the Enhanced tab with the divider in the middle. The right half (\"Enhanced\") has more contrast and a soft glow; the left half is the live preview. The button reads \"Enhance again\" with the download button beside it.",
  "sample-thumbnails": "The line \"Or try a sample photo:\" and four thumbnails in a row, each with its name under it: Portrait (astronaut), Coffee cup, Cat, Rocket.",
  "sample-loading": "The first page with the Portrait thumbnail at full brightness and the other three dimmed. In normal use this lasts a fraction of a second.",
  "sample-coffee": "The coffee cup sample (600 x 400). Sun on the table at the left, x 0.12, y 0.35, Height 0.12, Intensity 1.80, Ambient 0.06. The left of the cup and saucer is bright; the inside of the cup and the area to its right are in shadow.",
  "sample-cat": "The cat sample. Sun at the left by the ear, x 0.12, y 0.35. The left of the face is bright; the right side, past the nose, is in shadow.",
  "sample-rocket": "The night rocket sample. Sun on the left tower, x 0.12, y 0.35. The sky near the sun is lighter, the rocket's left side is lit, and the right of the picture is darker.",
  "sample-backend-stopped": "Pill: red dot, \"backend: offline\". The Portrait sample is loaded and lit with the Right preset all the same: sun right of the photo, x 1.10, y 0.40, right side of the face bright. No red bar anywhere.",
  "sample-load-error": "The first page. Under the thumbnails a red bar reads \"Could not load the sample photo. Check your connection and try again.\" with an x. No photo opened.",
  "sweep-before": "The Portrait sample at its starting light (x 0.12, y 0.35). The \"Sweep\" button at the top right of the LIGHT panel is slightly lighter because the mouse is on it.",
  "sweep-during": "The button reads \"Stop sweep\" in yellow letters with a yellow outline. The sun has moved to the right edge of the photo, about a quarter of the way down (x about 0.93, y about 0.24, changing as you watch). The right side of the face is bright and the left half is dark. The sliders have not moved.",
  "sweep-after": "The button reads \"Sweep\" again and the sun is back on the flag: x 0.12, y 0.35. The picture is the same as before the sweep.",
  "geometry-collapsed": "The sidebar only, enlarged: LIGHT (with \"Sweep\"), ENHANCE, and at the bottom the single row \"GEOMETRY\" with two tiny thumbnails (grey depth, purple normals), the word \"Show\" and a down arrow.",
  "geometry-expanded": "The sidebar is scrolled to the bottom. GEOMETRY is open: \"Hide\" and an up arrow, the sentence \"What the models recovered from the photo. The shader lights these.\", a grey Depth picture of the cup, a purple and green Normals picture, the Detailed normals switch on, then \"600 x 400 px, relief 0.3\" and under it \"shading: graphics chip, full quality\".",
  "sample-enhance-done": "The Enhanced tab on the coffee cup sample: divider in the middle, \"Live preview\" on the left, \"Enhanced\" on the right, \"Download enhanced\" below. Sidebar: x 1.10, y 0.40, the button reads \"Enhance again\" and \"Sweep\" is greyed out. Pill: \"online, mock providers\".",
  "sample-enhance-backend-stopped": "The coffee cup is still lit live with the Right preset (x 1.10, y 0.40). Above the photo a red bar reads \"Enhance needs the backend, which cannot be reached at http://localhost:8123. The live preview and Export PNG still work without it.\" with an x. Pill: \"offline\".",
  "sample-rocket-left": "Rocket sample, Left preset: the sun is at the left edge of the stage, x -0.10, y 0.40, Height 0.35, Intensity 1.30. To the right of the rocket and of each thin mast there is a faint, blurred darker patch on the sky. There are no hard-edged black stripes.",
  "sample-detailed-normals-backend-stopped": "A red bar above the stage: \"Cannot reach the backend at http://localhost:8123. Is it running? The sample keeps the geometry it came with.\" The portrait is still lit (x 0.12, y 0.35), GEOMETRY is open, the Detailed normals switch is back on (yellow) and the last line still reads \"shading: graphics chip, full quality\". Pill: \"offline\".",
  "laptop-1280x720-scene": "Everything fits with no scrolling: the photo, and in the sidebar LIGHT, ENHANCE and the GEOMETRY row. There are no grey helper lines under Height, Ambient or Cast shadows and no line under ENHANCE. The Enhance box is one row and shows \"Optional: a mood, such as golden hour\" in full. The five preset buttons fill one line. Readouts x 0.12, y 0.35.",
  "laptop-1280x720-landing": "The first page fits with no scrolling: heading, a lower drop box, \"Or try a sample photo:\" and the four thumbnails, with a little space left under them.",
  "laptop-1366x768-scene": "The uploaded coffee cup with the Right preset (x 1.10, y 0.40; the sun is drawn at the right edge of the stage). The sidebar fits without scrolling, in the same compact form as at 1280 x 720: no helper lines, a one-row Enhance box.",
  "window-1440x820-scene": "The sidebar fits without scrolling. There are no grey helper lines under Height, Ambient or Cast shadows, but the line \"A photoreal pass over this lighting. Takes a few seconds.\" under ENHANCE is there and the Enhance box has two rows.",
  "phone-sample": "The coffee cup sample on a phone: the top bar with \"How it works\" and the pill \"online\", a short stage that hugs the wide photo, the two buttons under it, and the LIGHT panel starting about half way down the screen with x 0.12, y 0.35. Under the Height track: \"close to the surface\" and \"close to you\", then the two-line helper \"Scroll or pinch on the sun to change it. Low grazes the surface and stretches the shadows.\" Ambient has its helper line too.",
  "phone-sample-full-page": "The whole phone page with GEOMETRY opened at the bottom: Depth and Normals pictures side by side, the Detailed normals switch on, \"600 x 400 px, relief 0.3\" and \"shading: graphics chip, full quality\".",
  "phone-load-failed-wide": "On a phone: the stage is short and holds only the grey, dimmed photo with \"New photo\" above it and the two greyed-out buttons below it. Under the stage, in its own red-bordered card: \"This photo could not be analysed\", \"Cannot reach the backend at http://localhost:8123. Is it running?\", the four-line offer that starts \"Or analyse it in this browser:\", a yellow \"Analyse in this browser\" with a plain \"Retry\" beside it, and \"Choose another photo\" under them. The LIGHT panel under the card is faded. Pill: \"offline\".",
  "tablet-768x1024-sample": "One column, wider: the cat sample in a stage across the top, then the LIGHT panel at full width with long sliders. Readouts x 0.12, y 0.35. Under the Height track: \"close to the surface\" at the left, \"close to you\" at the right, and under them on one line \"Scroll or pinch on the sun to change it. Low grazes the surface and stretches the shadows.\" Ambient has its helper line too.",
  "no-webgl-backend-stopped-sample": "Pill: red dot, \"backend: offline\". No red bar: only the grey note \"Shading on this device's processor, not its graphics chip (WebGL2 is not available in this browser). The picture is a quick preview while the light moves and sharpens when it stops.\" The portrait is lit with the Right preset (sun right of the photo, x 1.10, y 0.40, right side of the face bright). The LIGHT panel is at full brightness and \"Sweep\", \"Enhance\", \"Hold to see original\" and \"Export PNG\" are all available. The page asked the backend for nothing.",
  "mock-sample": "Frontend mock mode (pill \"mock\") with the Cat sample and the Left preset (x -0.10, y 0.40). The shading follows the cat's face, as in 35-cat-side-light: left side bright, right side in shade.",
  "sweep-stop-button": "Enlarged: the word LIGHT, \"Drag the sun on the photo.\", and at the right the button \"Stop sweep\" in yellow letters with a thin yellow outline. Under them the readout row (x, y, colour dot); its numbers change while the sweep runs.",
  "hold-original-button": "Enlarged: \"Hold to see original\" with yellow letters, a yellow eye icon and a yellow outline while it is held down. \"Export PNG\" to its right keeps white letters and a grey outline.",
  "preset-row": "The LIGHT panel, enlarged. Its last row holds five buttons on one line, from the panel's left edge to its right edge: Left, Right, Top, Low and warm (grey boxes) and Reset light (no box until the mouse is on it; here it is, so it has a faint grey background). The tooltip that appears when the mouse rests on \"Reset light\" is not in the picture. Its words are: \"Puts the light, its colour and Cast shadows back to how they started. The photo and the Enhance text are left alone.\"",
  "phone-360-preset-row": "The LIGHT panel on a 360 px wide phone. Left, Right, Top, Low and warm and Reset light are on one line and reach from edge to edge of the panel, with less space inside each button than on a wider screen. Nothing is cut off.",
  "phone-320-preset-row": "The LIGHT panel on a 320 px wide phone. Left, Right, Top and Low and warm fill one line; \"Reset light\" is alone on a second line, centred, as wide as the panel. Under the Height track the two end labels (\"close to the surface\", \"close to you\") are on one line and the helper under them (\"Scroll or pinch on the sun to change it. Low grazes the surface and stretches the shadows.\") takes three lines; the helper under Ambient takes two.",
  "laptop-1280x720-preset-top": "Readouts x 0.50, y -0.15, Height 0.35, Intensity 1.30: the same numbers as in 08-preset-top. The sun is at the very top edge of the stage, just under the top bar, above the middle of the photo, with the top of its disc cut off by the stage's edge. The hair and forehead are bright.",
  "new-photo-starts-clean": "The coffee cup, freshly loaded. Sun on the table at the left, x 0.12, y 0.35, Height 0.12, Intensity 1.80, Ambient 0.06, Colour neutral, colour dot white, Cast shadows on (yellow). The Enhance box is empty and shows its grey \"Optional: a mood, such as golden hour\". GEOMETRY is open, Detailed normals is on (yellow), and the last two lines read \"600 x 400 px, relief 0.3\" and \"shading: graphics chip, full quality\".",
  "laptop-1280x720-enhance-error": "Above the photo a two-line red bar: \"Enhance needs the backend, which cannot be reached at http://localhost:8123. The live preview and Export PNG still work without it.\" with an x. The photo is a little smaller to make room. The sidebar is exactly as without the error (LIGHT, ENHANCE, the GEOMETRY row) and does not scroll. Pill: \"offline\".",
  "phone-enhance-error": "The page is scrolled down to the ENHANCE panel. Under the yellow \"Enhance\" button a red box reads \"Enhance needs the backend, which cannot be reached at http://localhost:8123. The live preview and Export PNG still work without it.\" with an x. There is no red bar above the photo on a phone. Pill: \"offline\".",
  "no-webgl-render-lost": "One red bar above the stage: \"Live shading is unavailable (WebGL2 is not available in this browser, and shading on the processor failed too: This browser could not create a 2D canvas.), and the server render that would replace it failed: Cannot reach the backend at http://localhost:8123. Is it running? The light controls are off until a render arrives.\" with \"Retry\" at its right end and no x. The photo still shows the last picture the server sent (the Left preset), with no sun. The readout already says x 1.10, y 0.40. The LIGHT panel is faded and \"Sweep\" and \"Enhance\" are greyed out; \"Hold to see original\" and \"Export PNG\" still work on that last picture. Pill: \"offline\". You will not meet this in normal use: it needs a browser in which neither the graphics chip nor the processor can shade.",
  "mock-sample-detailed-normals": "The light has not been moved: the sun is at the left of the photo, where it starts. The sidebar is scrolled to the bottom, GEOMETRY open: grey Depth and purple Normals pictures of the cat, then \"Detailed normals\" with the line \"Always on for a sample photo: its maps were made ahead of time with detailed normals.\" Its switch is on but dull (dark yellow) and does nothing when clicked. Then \"451 x 300 px, relief 0.3\" and \"shading: graphics chip, full quality\". Pill: \"mock\".",
  "demo-landing": "Top right: \"How it works\", then the pill with a green dot and \"demo: runs in your browser\". The text under the heading reads \"Upload a photo or pick a sample. Its depth is estimated once, right here in your browser, which then shades it live: drag the light anywhere around the subject and the highlights and shadows follow instantly.\" Then the same dashed drop box as the normal app (\"Drop a photo here\", \"or click to browse, or paste an image or its address\"), two grey lines under it that start \"Your photo stays on this device:\", then \"Or try a sample photo:\" and the four thumbnails. The card \"This is the in-browser demo.\" is gone.",
  "demo-drop-box": "Enlarged: the dashed box with the upload icon, \"Drop a photo here\" in white and \"or click to browse, or paste an image or its address\" in grey. Under the box, in grey on two lines: \"Your photo stays on this device: its shape is worked out in your browser and nothing is uploaded. The first photo downloads a depth model of about 25 MB, once.\"",
  "demo-status": "The right end of the top bar, enlarged: \"How it works\", then the pill with a green dot and \"demo: runs in your browser\". It never reads \"checking\" or \"offline\".",
  "demo-sample": "The portrait lit live, sun on the flag, x 0.12, y 0.35. The top-right stage button reads \"New photo\" with the upload icon, as in the normal app. ENHANCE holds only the line \"Enhance needs the Relight server, which this demo runs without.\" and a dull, greyed-out \"Enhance\" button; there is no text box. LIGHT, \"Sweep\", \"Hold to see original\" and \"Export PNG\" are all available.",
  "demo-all-panels": "Coffee cup, Right preset (x 1.10, y 0.40; the sun is at the right edge of the stage). The whole sidebar shows: LIGHT, the short ENHANCE panel with its greyed-out button, and GEOMETRY open with Depth and Normals pictures, a dull Detailed normals switch with the line \"Always on for a sample photo: its maps were made ahead of time with detailed normals.\", then \"600 x 400 px, relief 0.3\" and \"shading: graphics chip, full quality\".",
  "demo-phone-landing": "One column. Top bar: \"Relight\", \"How it works\" and a pill that reads only \"demo\" with a green dot. Heading on two lines, the \"Upload a photo or pick a sample.\" text on five lines, the dashed drop box (its grey hint wraps onto two lines), the three grey lines that start \"Your photo stays on this device:\", \"Or try a sample photo:\" and the four thumbnails in one row.",
  "demo-phone-sample-full-page": "The whole phone page with the cat: the top bar with the pill \"demo\", a short stage with \"New photo\", the LIGHT panel with the five preset buttons on one line, the short ENHANCE panel (reason line and greyed-out button, no text box), and GEOMETRY open with the dull Detailed normals switch, \"451 x 300 px, relief 0.3\" and \"shading: graphics chip, full quality\".",
  "demo-no-webgl": "No red bar. Above the stage the grey note \"Shading on this device's processor, not its graphics chip (WebGL2 is not available in this browser). The picture is a quick preview while the light moves and sharpens when it stops.\" It has no x and no \"Retry\". The portrait is lit for the Left preset (sun left of the photo, x -0.10, y 0.40, left of the face bright). The LIGHT panel is at full brightness and \"Sweep\", \"Hold to see original\" and \"Export PNG\" are available. \"Enhance\" is greyed out as it always is in the demo.",
  "how-it-works-button": "Enlarged: the words \"How it works\" in light grey with no box round them (a faint box appears when the mouse is on them), and right of them the status pill, here \"backend: online, mock providers\" with an amber dot.",
  "how-it-works-open": "The first page is dimmed almost to black. In the middle of the window a dark card about half the window wide and most of its height, with a thin border and rounded corners. Top row: \"How Relight works\" and a \"Close\" button with an x. Then three lines that start \"Two pretrained vision models measure the photo once.\", three small chips (\"Pretrained model\" in blue, \"Our code\" in yellow, \"Hosted model, optional\" in grey), the heading \"ONCE PER PHOTO\" with three grey lines that start \"Done by the Relight server when you upload a photo.\" and end \"With no server, the depth model runs in your browser instead and the normals are taken from the slope of the depth map, which shades faces flatter.\", and step 1 \"Estimate depth\" with the blue chip \"Pretrained model: Depth Anything V2\" and two pictures: \"The photo\" and \"Depth map: lighter is nearer\". The top of step 2 shows at the bottom edge; the card scrolls.",
  "how-it-works-step-1": "The card alone. \"ONCE PER PHOTO\" and its three grey lines (\"Done by the Relight server when you upload a photo. For the four samples it was done ahead of time and the two maps ship with the page. With no server, the depth model runs in your browser instead and the normals are taken from the slope of the depth map, which shades faces flatter.\"), then step 1: a round \"1\", \"Estimate depth\", the blue chip \"Pretrained model: Depth Anything V2\", two lines that start \"A pretrained model estimates how near every pixel is to the camera.\", and two square pictures side by side: the astronaut photo (\"The photo\") and the same in greys with the helmet in front nearly white (\"Depth map: lighter is nearer\"). Step 2 starts below.",
  "how-it-works-step-2": "Step 2: \"Estimate surface direction\", the blue chip \"Pretrained model: Marigold\", two lines that start \"A second pretrained model estimates which way every surface faces.\", then one picture in purple, pink and green (\"Normal map: colour is the way a surface faces\") and, to its right, the grey note \"A depth map is too smooth to shade a face: tilts worked out from it left faces almost flat. That is why there is a second model.\" Under it the heading \"EVERY FRAME, IN YOUR BROWSER\" with the grey line \"Our lighting code runs steps 3 and 4 again each time the light moves: in a WebGL2 shader where the device allows, otherwise on the device's processor. If the processor is too slow or cannot do it, the Relight server runs our Python version instead. No AI model is involved in the dragging.\", and the start of step 3.",
  "how-it-works-step-3": "\"EVERY FRAME, IN YOUR BROWSER\" and its grey line, then step 3: \"Shade each pixel from the light\" with the yellow chip \"Our code\", three lines that start \"Diffuse shading: a pixel is bright when its surface faces the light.\", one grey picture of the astronaut like a plaster cast lit from the left (\"Our shading alone, light at the left\") and, to its right, the grey note \"A surface also goes dark gradually as it turns away from the light, not at a hard line, because estimated normals are too noisy for a hard cut.\" Step 4 starts below.",
  "how-it-works-step-4": "Step 4: \"Trace cast shadows in three layers\" with the yellow chip \"Our code\", three lines that start \"Each pixel walks toward the light across the height field\", and two pictures: a white square with a soft grey shadow shape (\"Our shadow map for the same light\") and the astronaut lit from the left (\"Steps 3 and 4 multiplied into the photo\"). Under it a card with no number: the astronaut lit from the right and the note \"Moving the light only reruns steps 3 and 4. The stills in this panel were rendered with our Python version of the same maths; the shader is a port of it and the two are kept in agreement.\"",
  "how-it-works-step-5-and-limits": "The end of the card. The un-numbered card (picture \"The same maps, light moved to the right\" and its note), the heading \"ONLY IF YOU PRESS ENHANCE\" with the grey line \"Off until you ask for it. The app is complete without it.\", step 5 \"A photoreal pass\" with the grey chip \"Hosted model, optional\" and no picture (its text names \"the Gemini image model, or IC-Light v2 on fal.ai\"), then \"HONEST LIMITS\" with two bullets: the first starts \"One photo gives a height field, not real 3D\", the second \"Shading is diffuse only (no shine)\" and ends \"The live shader has been tested in one browser on one computer.\"",
  "how-it-works-over-photo": "The same card over a photo that is being lit: the portrait, its sun, the sidebar and the top bar are all still there behind it but dimmed, and none of them reacts until the card is closed. Before this picture was taken the card was closed three ways (the Escape key, a click on the dimmed page, the \"Close\" button); after the Escape key the keyboard focus was back on \"How it works\". Opened again after being scrolled down, the card comes back at the top.",
  "tablet-768x1024-how-it-works": "At 768 px wide the card is 672 px wide, so only a narrow dimmed strip of the page shows on each side, and more above and below. The content is the same as on a desktop, including the pictures two to a row.",
  "phone-top-bar": "Enlarged, the whole width of a 390 px phone: the yellow square logo and \"Relight\" at the left (no \"Banana Hacks 2026\" at this width), then at the right \"How it works\" and a short pill: amber dot, \"online\". The full text (\"Backend at ... \") is still in the pill's tooltip, which a phone does not show.",
  "phone-320-top-bar": "Enlarged, the whole width of a 320 px phone: logo and \"Relight\", \"How it works\", and the pill \"online\". They fit on one line with a small gap between each; nothing is cut off and the page does not scroll sideways.",
  "phone-how-it-works-open": "The panel covers the whole screen: no dimmed page round it, no rounded corners, and the top bar is hidden behind it. \"How Relight works\" and \"Close\" at the top, the opening text on four lines, the three chips on one line, \"ONCE PER PHOTO\" and step 1, where the blue chip \"Pretrained model: Depth Anything V2\" sits on its own line under \"Estimate depth\". The two pictures are side by side, each about 150 px.",
  "phone-how-it-works-step-1": "\"ONCE PER PHOTO\", its grey text on five lines, ending \"which shades faces flatter.\", and step 1 with its two small pictures side by side; the caption \"Depth map: lighter is nearer\" wraps onto two lines. Step 2 starts below.",
  "phone-how-it-works-step-2": "Step 2 with one picture, the normal map, as wide as the card. The grey note that sits beside it on a wider screen (\"A depth map is too smooth...\") is not shown on a phone. Then \"EVERY FRAME, IN YOUR BROWSER\" and the start of step 3.",
  "phone-how-it-works-step-3": "\"EVERY FRAME, IN YOUR BROWSER\", then step 3 with one picture, the grey shading, as wide as the card. The grey note beside it on a wider screen (\"A surface also goes dark gradually...\") is not shown on a phone. Step 4 starts below, with its yellow chip on a line of its own.",
  "phone-how-it-works-step-4": "Step 4 with its two small pictures side by side (captions on two lines each), then the un-numbered card: a small picture \"The same maps, light moved to the right\" with the note about Python beside it in a narrow column of seven lines. \"ONLY IF YOU PRESS ENHANCE\" and the top of step 5 show at the bottom.",
  "phone-how-it-works-step-5-and-limits": "The end of the panel on a phone: the un-numbered card, \"ONLY IF YOU PRESS ENHANCE\" with \"Off until you ask for it. The app is complete without it.\", step 5 \"A photoreal pass\" with the grey chip \"Hosted model, optional\", and \"HONEST LIMITS\" with its two bullets.",
  "shading-line-full-quality": "The open GEOMETRY panel, enlarged. Under the Detailed normals switch are two small grey lines in typewriter letters: \"512 x 512 px, relief 0.3\" and, new, \"shading: graphics chip, full quality\". The mouse is on the new line; the tooltip it brings up is not in the picture. Its words are: \"The photo is shaded live by the graphics chip (<the chip's name>), at full quality.\"",
  "no-float-filtering": "Exactly what a computer with every ability shows: no note above the stage, the portrait lit for the Left preset (x -0.10, y 0.40), and at the bottom of the open GEOMETRY panel \"shading: graphics chip, full quality\".",
  "no-float-colour-buffers": "No note above the stage and nothing red. The portrait is lit for the Left preset (x -0.10, y 0.40) and looks the same as in 122-no-float-filtering. The only difference is the last grey line of the open GEOMETRY panel: \"shading: graphics chip, compatibility mode\".",
  "shading-line-compatibility-mode": "The open GEOMETRY panel, enlarged: the last line reads \"shading: graphics chip, compatibility mode\". Its tooltip (not in the picture) reads: \"The photo is shaded live by the graphics chip (<the chip's name>). Shadows are kept in 8-bit buffers because this graphics chip cannot draw into floating-point buffers; the picture is the same to within a level or two of brightness.\"",
  "no-webgl-all-panels": "The grey two-line note above the stage, the coffee cup lit with the Right preset (x 1.10, y 0.40, sun at the right edge of the stage, the cup's shadow falling to the left), and the whole sidebar: LIGHT, ENHANCE with a bright yellow \"Enhance\" button, and GEOMETRY open, ending \"600 x 400 px, relief 0.3\" and \"shading: processor, in the background\".",
  "processor-note": "Enlarged: a rounded box with a thin grey outline and light grey words on two lines: \"Shading on this device's processor, not its graphics chip (WebGL2 is not available in this browser). The picture is a quick preview while the light moves and sharpens when it stops.\" It is not red, has no warning triangle, no x and no \"Retry\".",
  "shading-line-processor-in-background": "The open GEOMETRY panel, enlarged: the last line reads \"shading: processor, in the background\". Its tooltip (not in the picture) reads: \"The photo is shaded by the processor, in a background thread, because the graphics chip could not be used: WebGL2 is not available in this browser.\"",
  "no-webgl-no-workers": "The same grey note as in any browser without WebGL2, the portrait lit for the Left preset (x -0.10, y 0.40), and at the bottom of the open GEOMETRY panel the shorter line \"shading: processor\". Nothing else tells the two processor paths apart; on this one the sun and sliders can stutter a little while a picture is being shaded.",
  "shading-line-processor": "The open GEOMETRY panel, enlarged: the last line reads only \"shading: processor\". Its tooltip (not in the picture) reads: \"The photo is shaded by the processor because the graphics chip could not be used: WebGL2 is not available in this browser.\"",
  "processor-preview-while-dragging": "The mouse button is down and the sun is half way across the photo, on the neck ring (x about 0.52, y about 0.32, changing). The picture is the quick preview: look at the stitching on the mission patch and the edge of the helmet, which are slightly blurred next to 131-processor-sharp-after-drag, and at the shadows, which have softer edges. The grey note is above the stage.",
  "processor-sharp-after-drag": "The sun has been let go at the right of the photo (x 0.90, y 0.30). A fraction of a second later the picture is the full-quality one: fine detail is crisp again and the right side of the face is bright with the left in shadow.",
  "processor-sweep-during": "The button reads \"Stop sweep\" in yellow and the sun is at the right edge of the photo (x about 0.93, y about 0.24, changing). The picture is the softer quick preview and stays so for the whole sweep; it sharpens only when the sweep ends and the light is back where it started.",
  "processor-enhance-done": "The \"Enhanced\" tab is selected, with the divider in the middle (\"Live preview\" left, \"Enhanced\" right) and \"Download enhanced\" below. The grey processor note is still above the stage. Sidebar: x -0.10, y 0.40, \"Enhance again\" with the download button, \"Sweep\" greyed out.",
  "phone-processor-note": "On a phone the grey note is four lines tall and sits between the top bar and the stage, so the photo starts lower than in 79-phone-sample by the note's height. The coffee cup is lit as usual (sun at the left, x 0.12, y 0.35) and the LIGHT panel follows under the stage.",
  "phone-processor-full-page": "The whole phone page in a browser without WebGL2: the four-line grey note, the stage, LIGHT, ENHANCE, and GEOMETRY open, ending \"600 x 400 px, relief 0.3\" and \"shading: processor, in the background\".",
  "shader-compile-failed": "The same grey note with a different reason in its brackets: \"Shading on this device's processor, not its graphics chip (the shader did not compile on this graphics chip). The picture is a quick preview while the light moves and sharpens when it stops.\" The portrait is lit for the Left preset (x -0.10, y 0.40) and everything works.",
  "graphics-chip-stopped-waiting": "For about two and a half seconds after the graphics chip stops, the photo's place is taken by a plain white box with a small broken-picture mark in its top left corner (last round's picture showed the plain original photo here; the app's canvas code has not changed since, so this is most likely how the current Chrome draws a canvas whose graphics chip has gone). The readout still says x -0.10, y 0.40 and the sun is in its place. There is no note and no message yet, and the controls look normal but the picture does not answer them.",
  "graphics-chip-stopped": "The grey note has appeared above the stage: \"Shading on this device's processor, not its graphics chip (the graphics chip stopped responding). The picture is a quick preview while the light moves and sharpens when it stops.\" The portrait is lit again for the Left preset (x -0.10, y 0.40), a little smaller because of the note, and everything works.",
  "slow-processor-server-renders": "A grey one-line note above the stage: \"This device's processor is slow at shading (3.0 s a picture), so the server draws the photo instead. It lags slightly behind the light.\" The number is whatever the device measured. The portrait is the server's picture for the Left preset (x -0.10, y 0.40); the sun, the sliders, \"Sweep\", \"Enhance\", \"Hold to see original\" and \"Export PNG\" are all available. GEOMETRY is open and its last line reads \"shading: server renders\".",
  "slow-processor-server-lost": "Pill: red dot, \"backend: offline\". No red bar. The note above the stage has changed back to \"Shading on this device's processor, not its graphics chip (WebGL2 is not available in this browser). The picture is a quick preview while the light moves and sharpens when it stops.\" The portrait is lit by the processor for the Right preset (x 1.10, y 0.40, right side of the face bright), and the last line of GEOMETRY reads \"shading: processor\".",
  "no-shading-at-all-server-renders": "A red bar with a warning triangle above the stage, with no x and no \"Retry\": \"Live shading is unavailable (WebGL2 is not available in this browser, and shading on the processor failed too: This browser could not create a 2D canvas.). Showing server renders instead, which lag slightly behind the light.\" The portrait is the server's picture for the Left preset (x -0.10, y 0.40) with the sun on it, and \"Sweep\", \"Enhance\", \"Hold to see original\" and \"Export PNG\" are available. You will not meet this in normal use: it needs a browser in which neither the graphics chip nor the processor can shade.",
  "no-shading-at-all-backend-stopped": "One red bar above the stage: \"Live shading is unavailable (WebGL2 is not available in this browser, and shading on the processor failed too: This browser could not create a 2D canvas.), and the server render that would replace it failed: Cannot reach the backend at http://localhost:8123. Is it running? The light controls are off until a render arrives.\" with the word \"Retry\" at its right end and no x. The photo is the plain original with no sun on it. The LIGHT panel is faded, and \"Sweep\", \"Enhance\", \"Hold to see original\" and \"Export PNG\" are greyed out. Pill: \"offline\".",
  "demo-top-bar": "The right end of the demo's top bar, enlarged: \"How it works\", then the pill with a green dot and \"demo: runs in your browser\".",
  "demo-phone-top-bar": "Enlarged, the whole width of a 390 px phone: logo and \"Relight\" at the left, \"How it works\" and a short pill at the right: green dot, \"demo\".",
  "demo-how-it-works-open": "The same card as in 105-how-it-works-open over the dimmed demo page. The grey text under \"ONCE PER PHOTO\" differs: \"For the four samples this was done ahead of time and the two maps ship with the page. For your own photo, this demo runs the depth model in your browser and takes the normals from the slope of the depth map, which shades faces flatter: the normals model is too large for a browser. The photo is not uploaded.\"",
  "demo-how-it-works-step-5-and-limits": "The end of the card in the demo. Under \"ONLY IF YOU PRESS ENHANCE\" the grey line reads \"Switched off in this demo, because it needs the server.\" Step 5 and \"HONEST LIMITS\" are word for word as in 110-how-it-works-step-5-and-limits.",
  "demo-phone-how-it-works-open": "The panel covers the whole phone screen. Under \"ONCE PER PHOTO\" the demo's own text, on six lines: \"For the four samples this was done ahead of time and the two maps ship with the page. For your own photo, this demo runs the depth model in your browser and takes the normals from the slope of the depth map, which shades faces flatter: the normals model is too large for a browser. The photo is not uploaded.\" Step 1 and the top of step 2 follow.",
  "demo-no-float-colour-buffers": "The demo with no note above the stage: the portrait lit for the Left preset (x -0.10, y 0.40), the top-right stage button \"New photo\", and GEOMETRY open, ending \"512 x 512 px, relief 0.3\" and \"shading: graphics chip, compatibility mode\".",
  "demo-no-float-filtering": "The demo exactly as on a computer with every ability: no note, the portrait lit for the Left preset, and the last line of GEOMETRY \"shading: graphics chip, full quality\".",
  "demo-no-webgl-all-panels": "The demo with the grey two-line processor note above the stage, the coffee cup lit with the Right preset (x 1.10, y 0.40), the short ENHANCE panel with its greyed-out button, and GEOMETRY open, ending \"600 x 400 px, relief 0.3\" and \"shading: processor, in the background\".",
  "demo-phone-no-webgl": "The demo on a phone: the pill \"demo\", then the grey note on four lines, then the stage with \"New photo\" and the cat lit from the left (sun by the ear, x 0.12, y 0.35), \"Hold to see original\" and \"Export PNG\" available, and the LIGHT panel under it at full brightness.",
  "demo-no-shading-at-all": "One red bar above the stage: \"Live shading is unavailable (WebGL2 is not available in this browser, and shading on the processor failed too: This browser could not create a 2D canvas.), and this demo has no server to shade the photo instead. Open it in a current Chrome, Edge, Firefox or Safari.\" It has no \"Retry\" and no x. The photo is the plain original with no sun. The LIGHT panel is faded and \"Sweep\", \"Enhance\", \"Hold to see original\" and \"Export PNG\" are greyed out. \"New photo\" still works. You will not meet this in normal use: it needs a browser in which neither the graphics chip nor the processor can shade.",
  "drop-web-image-blocked": "The first page is still showing, nothing has loaded. Under the four thumbnails a red bar on three lines, with an x: \"That image's site does not let other pages read it. This is a browser security rule, not a fault in the image. Right-click the image and choose Copy image, then paste it on this page; or save it and drop the file here.\" This is what most pictures dragged from another web site give.",
  "drop-web-image-404": "Enlarged: the drop box, the thumbnails and under them a red bar with an x: \"That image's site answered 404, so it could not be loaded. Right-click the image and choose Copy image, then paste it on this page; or save it and drop the file here.\" The number is whatever the site answered.",
  "drop-web-image-too-slow": "Enlarged: the drop box, the thumbnails and under them a red bar with an x: \"That image took too long to load. Right-click the image and choose Copy image, then paste it on this page; or save it and drop the file here.\" It appears 15 seconds after the drop; until then the drop box shows a spinner and \"Reading image…\".",
  "drop-web-page": "Enlarged: the drop box, the thumbnails and under them a red bar with an x: \"That address is a web page, not an image. Drag the picture itself, or save it and drop the file here.\"",
  "drop-nothing-an-image": "Enlarged: the drop box, the thumbnails and under them a red bar with an x: \"Nothing in that drop was an image. Right-click the image and choose Copy image, then paste it on this page; or save it and drop the file here.\"",
  "drop-unreadable-address": "Enlarged: the drop box, the thumbnails and under them a one-line red bar with an x: \"That image could not be read. Save it and drop the file here.\"",
  "drop-web-image-accepted": "No red bar. The dropped picture (the astronaut portrait) has loaded like a dropped file and is lit with the Left preset: sun left of the photo, x -0.10, y 0.40, exactly as 06-preset-left. Pill: \"online, mock providers\".",
  "backend-offline-analyse-in-browser": "Pill: red dot, \"backend: offline\". No red bar and no card: the portrait is lit with the Left preset (x -0.10, y 0.40), a little flatter on the face than 06-preset-left, with no outline round the hair and shoulders. The Enhance button is bright yellow. GEOMETRY is open: the grey text \"Depth estimated in your browser by Depth Anything V2 Small, the model the Relight server uses. The normals are taken from the slope of that depth map, so they are smoother than the server's detailed normals: a face shades flatter.\", a grey Depth picture, a smooth lilac Normals picture with colour only round the neck ring, the Detailed normals switch OFF (grey, but it can be clicked) with \"Off: this photo was analysed in your browser. Turn on to ask the Relight server for detailed normals.\", then three small lines: \"512 x 512 px, relief 0.3\", \"depth: this browser, graphics chip (WebGPU)\" (or \"processor (WebAssembly)\" on a device without WebGPU) and \"shading: graphics chip, full quality\".",
  "browser-scene-detailed-normals-backend-stopped": "A red bar above the stage with an x: \"Cannot reach the backend at http://localhost:8123. Is it running? The photo keeps the shape worked out in this browser.\" The portrait is still lit (Left preset, x -0.10, y 0.40), a little lower to make room for the bar. GEOMETRY is unchanged from 160: the \"Depth estimated in your browser\" text, the smooth Normals picture, the Detailed normals switch back OFF, and the \"depth: this browser\" line still there.",
  "browser-scene-detailed-normals-from-server": "Pill: amber dot, \"backend: online, mock providers\". No red bar. The same portrait, Left preset (x -0.10, y 0.40), now with the server's scene: the face has more modelling (nose, cheeks) than in 160. GEOMETRY reads \"What the models recovered from the photo. The shader lights these.\", the Normals picture is the detailed rainbow-coloured one, the Detailed normals switch is ON (yellow) with \"Slower to analyse, much better surface detail.\", and there are only two small lines: \"512 x 512 px, relief 0.3\" and \"shading: graphics chip, full quality\". The \"depth: this browser\" line is gone.",
  "mock-analysis-failed": "Pill: \"backend: mock\". The photo is grey and dim under a red-bordered card: \"This photo could not be analysed\", \"The depth model could not be downloaded. Check your connection and try again. The sample photos work without it.\", a yellow \"Retry\", a plain \"Use a stand-in dome\" beside it, and \"Choose another photo\" on a line of its own. The dome button exists in mock mode only. Its tooltip (not in the picture): \"Mock mode only: lights the photo as a made-up dome, not its real shape.\"",
  "mock-stand-in-dome": "Above the stage a grey note on two lines: \"No backend is running (mock mode), so this photo is lit as a made-up dome, not its real shape. The round edge you see is that dome. Use a sample photo, or start the backend to light your own photo properly.\" The portrait (Left preset, x -0.10, y 0.40) has one big round shape over its middle, brighter inside the circle, with a clear round edge across the flag and the wall. It does not follow the face. The GEOMETRY row's two tiny thumbnails are a round blob each.",
  "demo-depth-downloading": "The photo is dimmed and slightly blurred, with a pill in the middle: a spinner and \"Downloading the depth model, 19 MB, once… 42%\". The number counts up as you watch. The sidebar is faded, \"Sweep\", \"Hold to see original\" and \"Export PNG\" are greyed out, GEOMETRY has no thumbnails, and there is no sun. \"New photo\" stays available.",
  "demo-depth-starting": "The same dimmed photo and faded sidebar; the pill reads \"Starting the depth model…\". It follows the download and usually lasts a second or two.",
  "demo-depth-working-out-shape": "The same dimmed photo and faded sidebar; the pill reads \"Working out the shape of your photo…\". On a laptop it lasts from a fraction of a second to a couple of seconds.",
  "demo-depth-loading-stored": "The coffee cup, dimmed, with the pill \"Loading the depth model…\". No size and no percentage: the model is read from this browser's own store. This is what every photo after the first shows in place of the download lines.",
  "demo-own-photo-left": "The demo with an uploaded portrait, Left preset: sun left of the photo, x -0.10, y 0.40, Height 0.35, Intensity 1.30. The left of the face and suit is a little brighter, the wall on the right darker. The face is lit more evenly (flatter) than the sample in the next picture. There is no outline round the hair and the shoulders. Top right of the stage: \"New photo\". The Enhance button is greyed out, as always in the demo.",
  "demo-sample-portrait-left": "The demo with the built-in Portrait sample at the same light (x -0.10, y 0.40). The face has clear modelling: the left cheek is bright and the right side of the nose and the right cheek are in shadow. No outline round the hair.",
  "demo-own-photo-vs-sample": "Two pictures of the photo and its sun, side by side, each under a line of text. Left, \"Your own photo, analysed in this browser (depth model only)\": evenly lit face, no outline. Right, \"The built-in Portrait sample (depth and detailed normals, made ahead of time)\": the same photograph with a shadow down the right side of the nose and cheek and more shape in the suit's folds. Both have the sun in the same place, left of the photo.",
  "demo-own-photo-geometry": "The open GEOMETRY panel, enlarged. Grey text on five lines: \"Depth estimated in your browser by Depth Anything V2 Small, the model the Relight server uses. The normals are taken from the slope of that depth map, so they are smoother than the server's detailed normals: a face shades flatter.\" A grey Depth picture (the helmet in front nearly white) and a Normals picture that is smooth lilac and blue, with pink and blue bands round the neck ring and no detail in the face. The Detailed normals switch is off and dull, with \"Off for your own photo: detailed normals come from a second, much larger model that only the Relight server runs.\" Then three small lines: \"512 x 512 px, relief 0.3\", \"depth: this browser, graphics chip (WebGPU)\" (new; \"processor (WebAssembly)\" on a device without WebGPU) and \"shading: graphics chip, full quality\". The tooltip on the depth line (not in the picture): \"The depth model ran in this browser. The photo was not sent anywhere.\"",
  "demo-own-photo-detailed-normals": "Enlarged: \"Detailed normals\", under it in grey \"Off for your own photo: detailed normals come from a second, much larger model that only the Relight server runs.\", and at the right the switch: off (knob on the left), dull, and it does not react to a click.",
  "demo-depth-model-not-downloaded": "The photo is grey and dim under a red-bordered card: \"This photo could not be analysed\", \"The depth model could not be downloaded. Check your connection and try again. The sample photos work without it.\", a yellow \"Retry\" and \"Choose another photo\". No third button in the demo. The sidebar is faded.",
  "demo-phone-own-photo-full-page": "The whole phone page with an uploaded coffee cup: the pill \"demo\", a short stage with \"New photo\" and the sun at the left of the photo (x 0.12, y 0.35), LIGHT, the short ENHANCE panel with its greyed-out button, and GEOMETRY open: the five-line \"Depth estimated in your browser\" text, Depth and Normals pictures of the cup, the dull Detailed normals switch (off) with its three-line reason, then \"600 x 400 px, relief 0.3\", \"depth: this browser, graphics chip (WebGPU)\" and \"shading: graphics chip, full quality\".",
  "sun-height-close-ups": "Three squares cut from the same place on the portrait (the flag at the left edge; the black strip at the far left is the stage beside the photo), each under a line of text. Left, \"Height 0.03 (slider fully left): close to the surface\": a small sun, 26 px across, with its dark shadow tight round it. Middle, \"Height 0.12: where a new photo starts\": the sun at its usual 40 px with a soft shadow just under it. Right, \"Height 2.00 (slider fully right): close to you\": a large sun, 69 px across, whose shadow has dropped well below it onto the flag. The glow round the sun is white and hardly shows on this pale part of the photo; it is easier to see where the sun is over the dark stage (06-preset-left, 16-height-max). The flag is also lit differently in each square, because Height changes the lighting.",
  "sun-scroll-hint": "Enlarged: the sun on the flag and, just under it, a dark rounded label in small pale letters: \"Scroll to bring the light nearer or push it back\". The label appears half a second after the mouse comes to rest on the sun and goes when the mouse leaves; it is not shown while the sun is being dragged. (The mouse pointer itself is never in these pictures.)",
  "sun-scrolled-nearer": "The whole window. Height now reads 0.36 (it was 0.12) and its slider has moved right; x 0.12 and y 0.35 have not changed. The sun on the flag is larger than in 04-scene-default-light and the label \"Scroll to bring the light nearer or push it back\" is under it. The face is more evenly lit than at 0.12. The page itself did not scroll.",
  "sun-keyboard-plus": "Enlarged: the sun with a thin white ring a little way outside it (keyboard focus) and the same label under it, \"Scroll to bring the light nearer or push it back\". Height went 0.12, 0.13, 0.15, 0.17 with the three presses, so the sun is slightly larger than at the start. Three presses of - bring it back to 0.12.",
  "height-end-labels": "Enlarged: \"Height\" at the left, the value \"0.12\" at the right, the track with its white thumb near the left end, and under the track two grey labels: \"close to the surface\" at the left end, \"close to you\" at the right end. There is no longer a sentence under the track here; the sentence \"Scroll or pinch on the sun to change it. Low grazes the surface and stretches the shadows.\" is the tooltip, which is not in the picture.",
  "laptop-1280x720-height-control": "Enlarged: \"Height\", \"0.12\" and the track only. Nothing is written under the track, and the Intensity row starts straight below it (its top edge is at the bottom of the picture). On a window under 832 px tall the two end labels and the sentence are left out; the sentence is still the tooltip.",
  "phone-height-control": "Enlarged: \"Height\", \"0.12\", the track, then \"close to the surface\" (left) and \"close to you\" (right), and under them on two lines: \"Scroll or pinch on the sun to change it. Low grazes the surface and stretches the shadows.\"",
  "phone-pinch-nearer": "A phone. Height reads 0.68 and its slider is about a third of the way along; x 0.12 and y 0.35 are unchanged, so the light did not move sideways. The sun on the flag is clearly larger than in 45-phone-scene, and the portrait is more evenly lit.",
  "heic-converting": "The first page. Inside the dashed drop box, in place of the icon and \"Drop a photo here\", a small spinner and the words \"Converting your photo…\". Everything else is as in 01-landing. (For any other kind of file the box says \"Reading image…\".)",
  "heic-photo-lit": "The astronaut portrait from the .heic file, lit exactly like the JPEG in 06-preset-left: sun left of the photo, x -0.10, y 0.40, Height 0.35, left of the face bright and right cheek in soft shadow. Colours and sharpness look the same as the JPEG. Nothing on the page says that the file was a HEIC.",
  "heic-sideways-photo": "A tall, narrow portrait of the astronaut, upright: head at the top, flag behind her at the left. The photo is taller than wide (288 x 512). The sun is at its starting place, x 0.12, y 0.35, on the left edge by the collar.",
  "heic-12mp-photo": "The coffee cup, landscape, filling the stage's width, sharp, with the sun at its starting place at the left (x 0.12, y 0.35). The readouts are the starting ones. It loaded in two to three seconds.",
  "heic-error-cannot-convert": "The first page is still showing, with the drop box back to \"Drop a photo here\". Under the four thumbnails is a red bar on two lines: \"This HEIC photo could not be converted. Export it as a JPEG (on a Mac: open it in Preview, then File, Export) and use that.\" with an x to close it.",
  "heic-error-no-converter": "The first page is still showing. Under the four thumbnails is a red bar on three lines: \"This is a HEIC photo, which this browser cannot read by itself, and the converter for it could not be downloaded from cdn.jsdelivr.net. Check the connection and try again, or export the photo as a JPEG and use that.\" with an x to close it.",
  "heic-error-too-large": "The first page is still showing. Under the four thumbnails is a red bar on two lines: \"This HEIC photo is too large to convert in a browser (8192 x 8192 pixels). Export it as a JPEG (on a Mac: open it in Preview, then File, Export) and use that.\" with an x to close it. The two numbers are the chosen photo's own size.",
  "demo-heic-photo": "The static demo (pill \"demo: runs in your browser\") with the astronaut from the .heic file, Left preset: sun left of the photo, x -0.10, y 0.40, Height 0.35. It looks the same as 169-demo-own-photo-left, which is the same photograph chosen as a JPEG. ENHANCE is greyed out, as always in the demo.",
};

const numbered = SHOTS.map((shot, i) => ({ ...shot, needs: shot.needs ?? "any", file: `${String(i + 1).padStart(2, "0")}-${shot.name}.jpg` }));

function selectShots(only) {
  if (!only) return numbered;
  const picked = [];
  for (const want of only) {
    const key = want.replace(/\.(jpe?g|png)$/, "");
    const hit = key === "stopped" ? numbered.filter((s) => s.stopped || ["backend-offline", "backend-offline-upload", "status-offline"].includes(s.name)) : numbered.filter((s) => s.name === key || s.file === `${key}.jpg` || s.file.split("-")[0] === key.padStart(2, "0"));
    if (!hit.length) throw new Error(`No shot called "${want}". Run with --list to see the names.`);
    picked.push(...hit);
  }
  return [...new Set(picked)];
}

// ---------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------

/** Keep one manifest for the whole set: update the entries that were just taken, and the wording of all of them. */
function writeManifest(out, results) {
  const manifestFile = join(out, "manifest.json");
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {
    // first run
  }
  for (const r of results) if (r.status === "ok") manifest[r.file] = r;
  // Forget pictures the tool no longer takes (a shot that was renamed or removed).
  for (const file of Object.keys(manifest)) if (!numbered.some((shot) => shot.file === file)) delete manifest[file];
  const ordered = Object.fromEntries(
    Object.keys(manifest)
      // In shot order: plain sorting would put 100 before 11.
      .sort((a, b) => numbered.findIndex((s) => s.file === a) - numbered.findIndex((s) => s.file === b))
      .map((file) => {
        const shot = numbered.find((s) => s.file === file);
        const { file: f, name, status, about: _about, see: _see, ...rest } = manifest[file];
        return [file, { file: f, name, status, about: shot.about, ...(SEE[shot.name] ? { see: SEE[shot.name] } : {}), ...rest }];
      }),
  );
  writeFileSync(manifestFile, JSON.stringify(ordered, null, 2) + "\n");
}

const MODE_NAMES = { backend: "backend", mock: "frontend-mock", demo: "static-demo" };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return void console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 40).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  if (args.list) return void numbered.forEach((s) => console.log(`${s.file.padEnd(40)} [${s.needs.padEnd(7)}] ${s.about}`));
  if (args.describe) return void writeManifest(args.out, []);
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
    const mode = status.label === "mock" ? "mock" : status.label === "runs in your browser" ? "demo" : "backend";
    const api = (status.title.match(/https?:\/\/[^\s)]+/) ?? [null])[0];
    console.log(`Frontend ${args.url}: status "${status.label}"${api ? `, backend ${api}` : ""}. Running the ${MODE_NAMES[mode]} shots.`);
    if (mode === "backend" && status.label !== "online, mock providers" && !(args.backendStopped && status.label === "offline")) {
      throw new Error(`The status pill reads "${status.label}", not "online, mock providers". Start the backend with MOCK_MODE=1 (this tool never drives a backend that could call a paid API).`);
    }

    for (const shot of shots) {
      const file = join(args.out, shot.file);
      // "any" shots are taken on the backend setup, so one full set shows one consistent app.
      const fits = shot.needs === mode || (shot.needs === "any" && (mode === "backend" || args.only));
      if (!fits) {
        console.log(`skip  ${shot.file}  (needs the ${MODE_NAMES[shot.needs === "any" ? "backend" : shot.needs]} setup; the app is running as ${MODE_NAMES[mode]})`);
        results.push({ file: shot.file, name: shot.name, status: "skipped" });
        continue;
      }
      const page = await browser.newPage(shot.viewport ?? DESKTOP);
      const note = {};
      const cleanup = []; // what a shot started outside the browser, to be stopped when it ends
      const started = Date.now();
      try {
        const t = {
          page,
          file,
          cleanup,
          url: args.url,
          api,
          mode,
          photos: args.photos,
          note,
          snap: async (options = {}) => {
            // With GEOMETRY open the sidebar is taller than the window: show its top, or its bottom when the shot is about Enhance or Geometry.
            await page.js(`(document.querySelector("aside")?.scrollTo({ top: ${options.sidebar === "bottom" ? 100000 : 0}, behavior: "instant" }), true)`);
            note.light = await page.light();
            // On the processor the finished picture follows the light by a moment. "quick" shots want the moving one.
            if (!options.quick) await page.sharp();
            const shown = await page.js(`({ path: document.querySelector("canvas")?.dataset.shading ?? null, quality: document.querySelector("canvas")?.dataset.quality ?? null, serverPicture: !!document.querySelector('img[alt="Relit photo"]'), unavailable: document.body.innerText.includes("Live shading is unavailable") })`);
            if (shown.serverPicture) note.shading = "server";
            // Neither the graphics chip nor the processor can shade and no server picture is up (the demo has no server at all).
            else if (shown.unavailable) note.shading = "none";
            else if (shown.path) {
              note.shading = shown.path.startsWith("cpu") ? "cpu" : "webgl";
              note.shadingPath = shown.path;
              if (shown.quality) note.picture = shown.quality === "full" ? "full quality" : "quick preview (the light was moving)";
            }
            await page.capture(file, options);
          },
        };
        await shot.run(t);
        const light = note.light ? `light x ${note.light.x} y ${note.light.y}` : "";
        const fallback = note.shading === "server" ? "  ** a render from the server, not the live canvas **" : "";
        console.log(`ok    ${shot.file}  ${((Date.now() - started) / 1000).toFixed(1)} s  ${note.shadingPath ?? note.shading ?? ""} ${light}${fallback}`);
        if (args.backendStopped) note.backend = "really stopped while this picture was taken";
        results.push({ file: shot.file, name: shot.name, status: "ok", about: shot.about, ...(SEE[shot.name] ? { see: SEE[shot.name] } : {}), viewport: `${(shot.viewport ?? DESKTOP).width}x${(shot.viewport ?? DESKTOP).height}`, appMode: mode, ...note, console: page.console.slice() });
      } catch (error) {
        console.log(`FAIL  ${shot.file}  ${error.message}`);
        results.push({ file: shot.file, name: shot.name, status: "failed", error: error.message, console: page.console.slice() });
      }
      if (page.console.length) for (const line of [...new Set(page.console)]) console.log(`        page ${line}`);
      for (const stopIt of cleanup) stopIt();
      await page.release().catch(() => {});
      await page.close();
    }
  } finally {
    await stop();
  }

  writeManifest(args.out, results);

  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${count("ok")} taken, ${count("skipped")} skipped, ${count("failed")} failed. Files are in ${args.out}`);
  if (count("failed")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exit(1);
});
