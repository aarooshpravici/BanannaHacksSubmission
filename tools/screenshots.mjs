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
//   The tool reads the status pill first and skips the shots that do not fit, saying so.
//   The four built-in sample photos come from static files, so their shots work in either setup.
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
   *   quick     do not wait for animations to end (for a picture taken during the Sweep)
   * (snap() in main also takes sidebar: "bottom", which scrolls the right-hand sidebar down first.)
   */
  async capture(file, { clip, fullPage = false, asIs = false, quick = false } = {}) {
    if (!asIs) {
      await this.mouse("mouseMoved", Math.round(this.viewport.width / 2), 28);
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

/** Make canvas.getContext("webgl2") return null on every page loaded from now on, as an old browser would. */
async function withoutWebGL2(t) {
  await t.page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { const real = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return kind === "webgl2" ? null : real.call(this, kind, ...rest); }; })();`,
  });
}

const enhancedReady = `document.querySelector('button[role="tab"][aria-selected="true"]')?.textContent.trim() === "Enhanced" && [...document.querySelectorAll('img[alt="Enhanced"], img[alt="Live preview"]')].length === 2 && [...document.querySelectorAll('img[alt="Enhanced"], img[alt="Live preview"]')].every((i) => i.complete && i.naturalWidth > 0)`;

/** Open a scene, pick the Left preset and run Enhance to the end. */
async function openEnhanced(t) {
  await openScene(t);
  await t.page.clickButton("Left");
  await t.page.clickButton("Enhance");
  await t.page.waitFor(enhancedReady, "the Enhanced tab with both pictures", 120_000);
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
    about: "A photo chosen while the backend is not running (the failed-load state): the photo is grey and dim under a red-bordered card with \"Retry\" and \"Choose another photo\".",
    async run(t) {
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/");
      await t.page.upload(join(t.photos, PHOTO.portrait));
      await t.page.waitFor(`alerts().length > 0 && !!photoBox() && !!byText("button", "Retry")`, "the failed-load card on the photo");
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
      await withoutWebGL2(t);
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
    about: "The \"Cat\" sample's files could not be fetched: a red bar appears under the thumbnails and the first page stays.",
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
      t.note.sizeLine = await t.page.js(`[...document.querySelectorAll("aside p.font-mono")].map((p) => p.textContent.trim())[0] ?? null`);
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
    about: "Enhance clicked on the \"Coffee cup\" sample while the backend is not running: a red bar in the ENHANCE panel, and the live preview stays.",
    async run(t) {
      await t.page.route(t.api, "fail");
      await openSample(t, "Coffee cup");
      await t.page.clickButton("Right");
      await t.page.clickButton("Enhance");
      await t.page.waitFor(`alerts().length > 0`, "the red bar in the ENHANCE panel");
      t.note.error = (await t.page.js("alerts()"))[0];
      await t.snap({ sidebar: "bottom" });
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
    about: "A phone-sized window, a wide photo chosen while the backend is not running: the failed-load card fits between the buttons above and below it.",
    async run(t) {
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/", { settleStatus: false });
      await t.page.upload(join(t.photos, PHOTO.wide));
      await t.page.waitFor(`alerts().length > 0 && !!photoBox() && !!byText("button", "Retry")`, "the failed-load card on the photo");
      t.note.error = (await t.page.js("alerts()"))[0];
      t.note.stageHeight = await t.page.js(`Math.round(document.querySelector(".stage-hug").getBoundingClientRect().height)`);
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
    about: "A browser without WebGL2, a sample, and the backend not running: two red bars above the plain photo, and \"Hold to see original\" and \"Export PNG\" are greyed out.",
    async run(t) {
      await withoutWebGL2(t);
      await t.page.route(t.api, "fail");
      await t.page.goto(t.url + "/", { settleStatus: false });
      await clickSample(t, "Portrait");
      await t.page.waitFor(`alerts().some((a) => a.includes("Live shading is unavailable")) && alerts().some((a) => a.includes("cannot shade the photo itself"))`, "both red bars");
      t.note.errors = await t.page.js("alerts()");
      t.note.greyedOut = await t.page.js(`["Hold to see original", "Export PNG"].map((x) => x + ": " + (byText("button", x).disabled ? "disabled" : "ENABLED"))`);
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
];

// What a tester should see in each picture, written after looking at it: where the light is,
// which side is bright, what the readouts say. Goes into manifest.json as "see".
const SEE = {
  "landing": "Yellow word \"MOVE THE LIGHT\", the heading \"Relight a photo by dragging the light.\", a dashed box \"Drop a photo here\", then \"Or try a sample photo:\" and four thumbnails: Portrait, Coffee cup, Cat, Rocket. Top right pill: amber dot, \"backend: online, mock providers\".",
  "upload-empty": "The same page at the address /relight. The dashed drop box is a little lighter because the mouse is on it.",
  "scene-loading": "The photo is dimmed with a pill \"Estimating depth and surface normals…\" in the middle. The whole sidebar is faded, the \"Sweep\", \"Enhance\", \"Hold to see original\" and \"Export PNG\" buttons are greyed out, and the GEOMETRY row has no thumbnails yet. There is no sun on the photo.",
  "scene-default-light": "The round white sun is on the flag at the left edge, about a third of the way down. Readouts: x 0.12, y 0.35, Height 0.12, Intensity 1.80, Ambient 0.06, Colour neutral, Cast shadows on. The left side of the face (your left) is bright and the right cheek is in shadow; the right of the picture is darker than the left.",
  "scene-all-panels": "The same picture and readouts in a taller window. LIGHT, ENHANCE and the one-row GEOMETRY panel (two tiny thumbnails, \"Show\", down arrow) all show, with empty space under them.",
  "preset-left": "The sun is outside the photo on the left, a little above the middle. Readouts: x -0.10, y 0.40, Height 0.35, Intensity 1.30, Ambient 0.06. The left of the face and suit is bright; the right cheek is in soft shadow.",
  "preset-right": "The sun is outside the photo on the right. Readouts: x 1.10, y 0.40, Height 0.35, Intensity 1.30. The right side of the face and the helmet are bright; the left half of the face is dark.",
  "preset-top": "The sun is above the photo in the middle, at the very top of the dark stage. Readouts: x 0.50, y -0.07 (the preset asks for -0.15; the stage stops it at -0.07 in this window), Height 0.35, Intensity 1.30. The hair and forehead are bright; under the chin is dark.",
  "preset-low-and-warm": "The sun is orange-tinted at the bottom left corner of the photo. Readouts: x 0.00, y 0.90, Height 0.12, Intensity 1.60, Ambient 0.20, Colour warm 100, and the colour dot is pale orange. The whole picture has a warm orange cast and the face is lit from below.",
  "drag-far-left": "The sun sits on the left edge of the photo, half way down. Readouts: x 0.03, y 0.50; the sliders are still at their starting values (0.12, 1.80, 0.06). The left of the face is bright, the right cheek dark.",
  "drag-far-right": "The sun sits on the right edge of the photo, half way down. Readouts: x 0.97, y 0.50. The right of the face and the white helmet rim are bright; the left half of the face is dark.",
  "drag-top": "The sun sits on the top edge of the photo in the middle, on the hair. Readouts: x 0.50, y 0.03. The hair glows; the face below it is evenly lit.",
  "drag-outside-photo": "The sun is on the dark stage to the right of the photo, next to the sidebar. Readouts: x 1.21, y 0.30 (as far right as the stage allows). The lighting looks like the Right preset: right side bright, left half of the face dark.",
  "drag-centre": "The sun is in the middle of the photo on the metal neck ring. Readouts: x 0.50, y 0.45. The neck ring and chest near the sun are brightest; the face is dimmer than in the other shots because the light is low and below it.",
  "height-min": "Left preset with Height 0.03 (slider fully left). The light skims the surface: the picture is darker overall, with strong shadows across the face and suit.",
  "height-max": "Left preset with Height 2.00 (slider fully right). The light is far in front: the whole picture is evenly lit, almost like the original photo.",
  "intensity-low": "Left preset with Intensity 0.00 (slider fully left). The picture is very dark but still visible, lit only by the Ambient 0.06.",
  "intensity-high": "Left preset with Intensity 4.00 (slider fully right). The picture is very bright; the flag, the suit and the left of the face are close to white.",
  "ambient-low": "Left preset with Ambient 0.00 (slider fully left). Shadows are pure black: the right cheek and the right of the picture are darker than in 06-preset-left.",
  "ambient-high": "Left preset with Ambient 1.00 (slider fully right). No dark shadows are left; the picture is bright and flat.",
  "colour-warm": "Left preset with Colour \"warm 100\" (slider fully right). The sun handle and the colour dot are pale orange and the whole picture has an orange tint.",
  "colour-cool": "Left preset with Colour \"cool 100\" (slider fully left). The sun handle and the colour dot are pale blue and the whole picture has a blue tint.",
  "shadows-on": "Coffee cup, sun at the left edge (x -0.04, y 0.40), Height 0.10, Cast shadows on. The cup throws a dark, soft-edged shadow to the right across the saucer and the spoon.",
  "shadows-off": "The same light with the Cast shadows switch off (grey, knob on the left). The dark shadow to the right of the cup is gone; the saucer and spoon on the right are lit.",
  "detailed-normals-on": "The sidebar is scrolled to the bottom. GEOMETRY is open (\"Hide\", arrow up): a grey Depth picture (\"white = near\"), a rainbow-coloured Normals picture (\"surface direction\") with fine detail, the Detailed normals switch on (yellow), and \"512 x 512 px, relief 0.3\".",
  "detailed-normals-off": "The same with the Detailed normals switch off (grey). The Normals picture is now smooth lilac with no fine detail, and the shading on the photo is flatter with a thin light outline around the head and shoulders.",
  "hold-original": "While the \"Hold to see original\" button is held: the untouched photo, evenly lit, with a small tag \"Original\" in its top left corner. The sun and the readouts (x -0.10, y 0.40) do not change.",
  "enhance-before": "Left preset. The ENHANCE box holds the typed words \"golden hour\". The yellow button reads \"Enhance\".",
  "enhance-running": "Top left of the stage: two tabs, \"Live preview\" (selected) and \"Enhancing…\" (greyed out). Bottom left: a pill \"Enhancing in the background, keep dragging\". The yellow button is dimmed and reads \"Enhancing…\" with a spinner. The sun can still be dragged.",
  "enhance-done": "The \"Enhanced\" tab is selected. A vertical white line with a round handle splits the photo in the middle: left half tagged \"Live preview\", right half tagged \"Enhanced\". Below: \"Download enhanced\". In the sidebar the button reads \"Enhance again\" with a small download button beside it, and \"Sweep\" is greyed out. There is no sun.",
  "enhance-divider-dragged": "The same, with the divider line and its round handle a quarter of the way from the left edge, so three quarters of the photo shows the Enhanced side.",
  "enhance-back-to-live": "The \"Live preview\" tab is selected again and the sun is back (x -0.10, y 0.40). The \"Enhanced\" tab can be clicked. The sidebar button still reads \"Enhance again\" with the download button beside it.",
  "sample-portrait": "The astronaut portrait, opened from the \"Portrait\" thumbnail with no wait. Sun on the flag at the left; readouts x 0.12, y 0.35, Height 0.12, Intensity 1.80, Ambient 0.06. The left of the face is bright, the right cheek in shadow.",
  "object-side-light": "Coffee cup with the Right preset. The sun is on the dark stage just right of the photo; readouts x 1.04, y 0.40 (the stage stops it short of 1.10), Height 0.35, Intensity 1.30. The right of the table is bright and the cup's shadow falls to the left.",
  "cat-side-light": "Cat with the Left preset. The sun is at the left edge of the stage; readouts x -0.04, y 0.40. The left of the cat's face is bright and the right side, past the nose, is in shadow.",
  "dark-photo": "Night rocket with the Left preset; readouts x -0.04, y 0.40. The left faces of the rocket and of the towers are a little brighter, with faint soft shadows to their right on the sky. No hard black bands.",
  "tall-photo": "A tall, narrow portrait centred in the stage with wide dark margins left and right. Left preset: the sun is on the dark stage left of the photo, readouts x -0.10, y 0.40.",
  "wide-photo": "A wide, short strip of the coffee cup centred in the stage with dark margins above and below. Top preset: the sun is on the dark stage above the photo, readouts x 0.50, y -0.15.",
  "tiny-photo": "The cat photo, soft and blurry because a 200 px picture is stretched to fill the stage. Left preset, readouts x -0.04, y 0.40. The shading still works.",
  "huge-photo": "The portrait again; it looks the same as 06-preset-left, because the app shrinks a 3000 px photo before using it. Readouts x -0.10, y 0.40.",
  "error-not-an-image": "The first page is still showing. Under the four thumbnails is a red bar: \"That file is not an image.\" with an x to close it.",
  "backend-offline": "The first page. Top right pill: red dot, \"backend: offline\". The four sample thumbnails are still there and still work.",
  "backend-offline-upload": "The photo is grey and dim. A red-bordered card in the middle reads \"This photo could not be analysed\", then \"Cannot reach the backend at http://localhost:8123. Is it running?\", with a yellow \"Retry\" button and a \"Choose another photo\" button. The sidebar is faded, \"Hold to see original\" and \"Export PNG\" are greyed out, and the pill reads \"offline\".",
  "enhance-error": "The live preview is still there (Left preset). In the ENHANCE panel, under the yellow \"Enhance\" button, a red bar reads \"Cannot reach the backend at http://localhost:8123. Is it running?\" with an x. The pill reads \"offline\".",
  "phone-scene": "One column. The photo with the sun on the flag, then \"Hold to see original\" and \"Export PNG\", then the LIGHT panel straight under the stage: x 0.12, y 0.35, Height 0.12, Intensity 1.80, Ambient 0.06. The helper lines under Height and Ambient show. The pill has no word \"backend:\", only \"online, mock providers\".",
  "phone-full-page": "The whole phone page: stage, LIGHT (the \"Reset\" button wraps onto its own row), ENHANCE with its helper line and a two-row box, and the one-row GEOMETRY panel at the bottom.",
  "phone-landing": "The first page in one column: heading on two lines, the dashed drop box, \"Or try a sample photo:\" and the four thumbnails in one row.",
  "status-checking": "Grey dot, \"backend: checking\". It shows for a moment after the page opens.",
  "status-online-mock-providers": "Amber dot, \"backend: online, mock providers\".",
  "status-online": "Green dot, \"backend: online\".",
  "status-offline": "Red dot, \"backend: offline\".",
  "no-webgl-fallback": "A red bar above the stage: \"Live shading is unavailable (WebGL2 is not available in this browser). Showing server renders instead, which lag slightly behind the light.\" The photo is lit by the server for the Left preset (x -0.10, y 0.40) and looks softer and more even than the live shading. \"Hold to see original\" and \"Export PNG\" are available.",
  "not-found-page": "A black page with \"404\" and \"This page could not be found.\" in the middle, under the normal top bar.",
  "mock-landing": "The first page with a yellow dot and \"backend: mock\" in the pill. Everything else is the same as 01-landing.",
  "mock-status": "Yellow dot, \"backend: mock\".",
  "mock-scene": "An uploaded portrait in frontend mock mode with the Left preset (x -0.10, y 0.40). The shading is one big round dome over the middle of the picture, bright on its left and dark on its right. It does not follow the face.",
  "mock-enhance-running": "Frontend mock mode: tabs \"Live preview\" and \"Enhancing…\", the pill \"Enhancing in the background, keep dragging\" at the bottom left, and the dimmed \"Enhancing…\" button.",
  "mock-enhance-done": "Frontend mock mode: the Enhanced tab with the divider in the middle. The right half (\"Enhanced\") has more contrast and a soft glow; the left half is the live preview.",
  "sample-thumbnails": "The line \"Or try a sample photo:\" and four thumbnails in a row, each with its name under it: Portrait (astronaut), Coffee cup, Cat, Rocket.",
  "sample-loading": "The first page with the Portrait thumbnail at full brightness and the other three dimmed. In normal use this lasts a fraction of a second.",
  "sample-coffee": "The coffee cup sample (600 x 400). Sun on the table at the left, x 0.12, y 0.35, Height 0.12, Intensity 1.80, Ambient 0.06. The left of the cup and saucer is bright; the inside of the cup and the area to its right are in shadow.",
  "sample-cat": "The cat sample. Sun at the left by the ear, x 0.12, y 0.35. The left of the face is bright; the right side, past the nose, is in shadow.",
  "sample-rocket": "The night rocket sample. Sun on the left tower, x 0.12, y 0.35. The sky near the sun is lighter, the rocket's left side is lit, and the right of the picture is darker.",
  "sample-backend-stopped": "Pill: red dot, \"backend: offline\". The Portrait sample is loaded and lit with the Right preset all the same: sun right of the photo, x 1.10, y 0.40, right side of the face bright. No red bar anywhere.",
  "sample-load-error": "The first page. Under the thumbnails a red bar reads \"Failed to fetch\" with an x. No photo opened.",
  "sweep-before": "The Portrait sample at its starting light (x 0.12, y 0.35). The \"Sweep\" button at the top right of the LIGHT panel is slightly lighter because the mouse is on it.",
  "sweep-during": "The button reads \"Stop sweep\". The sun has moved to the right edge of the photo, about a quarter of the way down (x about 0.93, y about 0.24, changing as you watch). The right side of the face is bright and the left half is dark. The sliders have not moved.",
  "sweep-after": "The button reads \"Sweep\" again and the sun is back on the flag: x 0.12, y 0.35. The picture is the same as before the sweep.",
  "geometry-collapsed": "The sidebar only, enlarged: LIGHT (with \"Sweep\"), ENHANCE, and at the bottom the single row \"GEOMETRY\" with two tiny thumbnails (grey depth, purple normals), the word \"Show\" and a down arrow.",
  "geometry-expanded": "The sidebar is scrolled to the bottom. GEOMETRY is open: \"Hide\" and an up arrow, the sentence \"What the models recovered from the photo. The shader lights these.\", a grey Depth picture of the cup, a purple and green Normals picture, the Detailed normals switch on, and \"600 x 400 px, relief 0.3\".",
  "sample-enhance-done": "The Enhanced tab on the coffee cup sample: divider in the middle, \"Live preview\" on the left, \"Enhanced\" on the right, \"Download enhanced\" below. Sidebar: x 1.04, y 0.40, the button reads \"Enhance again\". Pill: \"online, mock providers\".",
  "sample-enhance-backend-stopped": "The coffee cup is still lit live with the Right preset. Under the \"Enhance\" button a red bar reads \"Enhance needs the backend, which cannot be reached at http://localhost:8123. The live preview and Export PNG still work without it.\" Pill: \"offline\".",
  "sample-rocket-left": "Rocket sample, Left preset: the sun is at the left edge of the stage, x -0.04, y 0.40, Height 0.35, Intensity 1.30. To the right of the rocket and of each thin mast there is a faint, blurred darker patch on the sky. There are no hard-edged black stripes.",
  "sample-detailed-normals-backend-stopped": "A red bar above the stage: \"Cannot reach the backend at http://localhost:8123. Is it running? The sample keeps the geometry it came with.\" The portrait is still lit (x 0.12, y 0.35), GEOMETRY is open and the Detailed normals switch is back on (yellow). Pill: \"offline\".",
  "laptop-1280x720-scene": "Everything fits with no scrolling: the photo, and in the sidebar LIGHT, ENHANCE and the GEOMETRY row. There are no grey helper lines under Height, Ambient or Cast shadows and no line under ENHANCE. The Enhance box is one row and its grey text is cut off at the right edge. Readouts x 0.12, y 0.35.",
  "laptop-1280x720-landing": "The first page fits with no scrolling: heading, a lower drop box, \"Or try a sample photo:\" and the four thumbnails, with a little space left under them.",
  "laptop-1366x768-scene": "The uploaded coffee cup with the Right preset (x 1.05, y 0.40). The sidebar fits without scrolling, in the same compact form as at 1280 x 720: no helper lines, a one-row Enhance box.",
  "window-1440x820-scene": "The sidebar fits without scrolling. There are no grey helper lines under Height, Ambient or Cast shadows, but the line \"A photoreal pass over this lighting. Takes a few seconds.\" under ENHANCE is there and the Enhance box has two rows.",
  "phone-sample": "The coffee cup sample on a phone: a short stage that hugs the wide photo, the two buttons under it, and the LIGHT panel starting about half way down the screen with x 0.12, y 0.35 and the helper lines showing.",
  "phone-sample-full-page": "The whole phone page with GEOMETRY opened at the bottom: Depth and Normals pictures side by side, the Detailed normals switch on, \"600 x 400 px, relief 0.3\".",
  "phone-load-failed-wide": "On a phone: the red-bordered card \"This photo could not be analysed\" with \"Retry\" and \"Choose another photo\" sits in the stage with clear space between it and \"New photo\" above and the two greyed-out buttons below. The LIGHT panel under it is faded. Pill: \"offline\".",
  "tablet-768x1024-sample": "One column, wider: the cat sample in a stage across the top, then the LIGHT panel at full width with long sliders. Readouts x 0.12, y 0.35. The helper lines show.",
  "no-webgl-backend-stopped-sample": "Two red bars above the stage: \"Live shading is unavailable (WebGL2 is not available in this browser). Showing server renders instead, which lag slightly behind the light.\" and \"This browser cannot shade the photo itself, so it needs the backend, which cannot be reached at http://localhost:8123.\" The photo is the plain original, not relit. \"Hold to see original\" and \"Export PNG\" are greyed out.",
  "mock-sample": "Frontend mock mode (pill \"mock\") with the Cat sample and the Left preset (x -0.04, y 0.40). The shading follows the cat's face, as in 35-cat-side-light: left side bright, right side in shadow.",
};

const numbered = SHOTS.map((shot, i) => ({ ...shot, needs: shot.needs ?? "any", file: `${String(i + 1).padStart(2, "0")}-${shot.name}.jpg` }));

function selectShots(only) {
  if (!only) return numbered;
  const picked = [];
  for (const want of only) {
    const key = want.replace(/\.(jpe?g|png)$/, "");
    const hit = key === "stopped" ? numbered.filter((s) => s.stopped || ["backend-offline", "backend-offline-upload", "status-offline"].includes(s.name)) : numbered.filter((s) => s.name === key || s.file === `${key}.jpg` || s.file.slice(0, 2) === key.padStart(2, "0"));
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
      .sort()
      .map((file) => {
        const shot = numbered.find((s) => s.file === file);
        const { file: f, name, status, about: _about, see: _see, ...rest } = manifest[file];
        return [file, { file: f, name, status, about: shot.about, ...(SEE[shot.name] ? { see: SEE[shot.name] } : {}), ...rest }];
      }),
  );
  writeFileSync(manifestFile, JSON.stringify(ordered, null, 2) + "\n");
}

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
            // With GEOMETRY open the sidebar is taller than the window: show its top, or its bottom when the shot is about Enhance or Geometry.
            await page.js(`(document.querySelector("aside")?.scrollTo({ top: ${options.sidebar === "bottom" ? 100000 : 0}, behavior: "instant" }), true)`);
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
        if (args.backendStopped) note.backend = "really stopped while this picture was taken";
        results.push({ file: shot.file, name: shot.name, status: "ok", about: shot.about, ...(SEE[shot.name] ? { see: SEE[shot.name] } : {}), viewport: `${(shot.viewport ?? DESKTOP).width}x${(shot.viewport ?? DESKTOP).height}`, appMode: mode, ...note, console: page.console.slice() });
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

  writeManifest(args.out, results);

  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${count("ok")} taken, ${count("skipped")} skipped, ${count("failed")} failed. Files are in ${args.out}`);
  if (count("failed")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exit(1);
});
