"use client";

import { type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BeforeAfter } from "@/components/BeforeAfter";
import { ErrorBanner } from "@/components/ErrorBanner";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { FitBox, PageIntro, Panel, Stage, Workspace } from "@/components/Panel";
import { BusyLabel, BusyOverlay } from "@/components/Spinner";
import { UploadDropzone } from "@/components/UploadDropzone";
import { AlertIcon, DownloadIcon, EyeIcon, OrbitIcon, SparklesIcon, SunIcon, UploadIcon } from "@/components/icons";
import { RelightCanvas, type ShadingPath } from "@/components/relight/RelightCanvas";
import { ShadingNote } from "@/components/relight/ShadingNote";
import { Button, Segmented, Slider, Toggle } from "@/components/ui";
import { ApiError, errorMessage, isAbort, relightAdoptScene, relightEnhance, relightRender, relightScene } from "@/lib/api";
import { cn } from "@/lib/cn";
import { API_URL, DEMO, MOCK } from "@/lib/config";
import { type LoadedImage, downloadBase64AsPng, downloadCanvas, toDataUrl } from "@/lib/image";
import { type DepthDevice, type LocalProgress, isLocalScene, localScene, progressText } from "@/lib/localScene";
import { SAMPLES, type SamplePhoto, isSampleScene, loadSampleScene, sampleThumbUrl } from "@/lib/samples";
import type { Light, RelightRender, RelightScene } from "@/lib/types";
import { useJob } from "@/lib/useJob";

/** How far outside the photo the light may be dragged, in image widths/heights. */
const OUTSIDE = 0.5;
/** How close the middle of the sun may come to the stage's edge, in pixels: close enough to reach past a photo that fills the stage, far enough that most of the sun stays in view. Also read by .light-handle in globals.css. */
const HANDLE_MARGIN_PX = 18;
/**
 * On a touch screen, how far the middle of the sun keeps from the left and right
 * sides of the screen, in pixels. A phone's browser takes a finger that goes down
 * at the very side of the screen as its Back or Forward swipe, and a page cannot
 * switch that off. With the stage 17 px from the side, a sun parked at the stage's
 * edge sat inside that strip: a tester who reached for it on an iPhone left the page.
 */
const TOUCH_EDGE_CLEAR_PX = 48;
/** Height: how far in front of the subject the light floats, in image widths. The slider's two ends. */
const HEIGHT_MIN = 0.03;
const HEIGHT_MAX = 2;
/**
 * The sun shows its height, so that the light's distance can be read off the
 * photo with no words: a light near the surface is a small disc with a tight
 * glow and its shadow right under it; pulled toward the viewer it grows, its
 * glow spreads and its shadow falls away below it. Each number is the value at
 * the lowest and at the highest Height; between them it follows the share of
 * the way up in equal ratios (heightShare), because 0.03 to 0.06 changes the
 * picture as much as 1 to 2 does.
 *
 * The disc is 40 px at the Height a new photo starts with (0.12, a third of
 * the way up): 0.64 and 1.72 of that are far enough apart to tell at a glance,
 * while the small one is still easy to see and the large one hides little of
 * the photo. The button itself never goes under 40 px, so it stays easy to grab.
 */
const HANDLE_PX = 40;
const SUN_SCALE = [0.64, 1.72];
/** How far the glow reaches past the disc, and how soft its edge is, in pixels. 24 and 12 at the starting Height, as before the sun showed its height. */
const SUN_GLOW_REACH_PX = [8, 56];
const SUN_GLOW_BLUR_PX = [4, 28];
/** The shadow under the disc: how far below it falls, how soft it is, and how dark. About 3 px, 11 px and 0.7 at the starting Height, much as before. */
const SUN_SHADOW_DROP_PX = [0, 30];
const SUN_SHADOW_BLUR_PX = [4, 24];
const SUN_SHADOW_ALPHA = [0.8, 0.6];

/**
 * Scrolling over the sun: how much one pixel of scroll changes the Height, as
 * a power of e. A mouse wheel's notch is about 100 px, so one notch is a
 * quarter more or less: 13 notches from the starting Height to the top, 6 to
 * the bottom. Larger and a trackpad's glide overshoots; smaller and a wheel
 * needs a tiring number of turns.
 */
const WHEEL_HEIGHT_PER_PX = 0.0022;
/** The most one scroll event may count for, in pixels: a wheel that speeds up when spun must not jump the light from one end to the other. */
const WHEEL_MAX_STEP_PX = 150;
/** A browser that counts in lines, not pixels (Firefox with a mouse): what one line is worth, so that a notch of three lines matches a notch elsewhere. */
const WHEEL_LINE_PX = 33;
/** A trackpad pinch arrives as a scroll with Ctrl held and much smaller numbers: this many times more is made of each. */
const WHEEL_PINCH_GAIN = 8;
/** The + and - keys: each press changes the Height by this ratio, like half a wheel notch. */
const KEY_HEIGHT_RATIO = 1.12;
/** Two fingers on a touch screen: spreading them to twice as far apart multiplies the Height by 2 to this power. 2.5 reaches either end from the start in one comfortable pinch. */
const PINCH_POWER = 2.5;
/** Two fingers closer than this, in pixels, count as this far apart, so that fingers landing side by side do not make a tiny move a huge change. */
const PINCH_MIN_SPREAD_PX = 24;
/** A second finger landing within this many milliseconds of the first means a pinch was meant from the start: the light goes back to where it was before the first finger moved it. */
const PINCH_GRACE_MS = 350;
/** Shown under the sun while the mouse rests on it. */
const SUN_HINT = "Scroll to bring the light nearer or push it back";
const HEIGHT_HINT = "Scroll or pinch on the sun to change it. Low grazes the surface and stretches the shadows.";
const HEIGHT_ENDS: [string, string] = ["close to the surface", "close to you"];

const WARM: [number, number, number] = [1.0, 0.86, 0.68];
const COOL: [number, number, number] = [0.7, 0.86, 1.0];

type LightBase = Omit<Light, "color">;

/**
 * The light a fresh scene (and Reset) starts with. The API's own default
 * (x 0.20, y 0.20, height 0.25) lights a photo so evenly that testers read it
 * as "nothing happened". This one sits low and to the left of the subject with
 * little ambient light, so one side is clearly lit and the other falls into
 * shadow, on a face and on an object alike; it is still inside the photo, so
 * the handle is in plain sight.
 */
const START: LightBase = { x: 0.12, y: 0.35, height: 0.12, intensity: 1.8, ambient: 0.06 };

/** Sweep: how long the light takes to travel once around the subject. Long enough to read, short enough for a demo clip. */
const SWEEP_MS = 6000;
/** Sweep: the orbit's centre and radius, in photo widths/heights. 0.5 around the middle runs the light along the photo's edges, where side lighting is strongest. */
const SWEEP_CENTRE = { x: 0.5, y: 0.5 };
const SWEEP_RADIUS = 0.5;
/** Sweep: the share of the loop spent gliding from the user's light onto the orbit, and again back to it, so nothing jumps. */
const SWEEP_BLEND = 0.15;
/** Sweep: the share of the time spent speeding up at the start, and again slowing down at the end. Between the two the sun keeps one steady speed. */
const SWEEP_RAMP = 0.08;
/** Sweep: how many pieces the loop is measured in, so that the sun can be moved along it by distance. */
const SWEEP_STEPS = 360;

/** Enhance and server renders, for a built-in sample with no backend to send it to. */
const ENHANCE_OFFLINE = `Enhance needs the backend, which cannot be reached at ${API_URL}. The live preview and Export PNG still work without it.`;
const ENHANCE_HINT = "A photoreal pass over this lighting. Takes a few seconds.";
const SERVER_RENDER_OFFLINE = `Cannot reach the backend at ${API_URL}. Is it running?`;
/**
 * Where a photo's scene comes from: the Relight server (depth and detailed
 * normals), or the depth model run in this browser (lib/localScene.ts).
 */
type SceneRoute = "backend" | "browser";
/** With no server (the static demo, mock mode) the browser is the only place a photo can be analysed. */
const BROWSER_ONLY = DEMO || MOCK;
const FIRST_ROUTE: SceneRoute = BROWSER_ONLY ? "browser" : "backend";
/** Under the drop box when the browser does the analysis. 25 MB is the model (19 MB) and the code that runs it (5.5 MB), as measured; the progress line gives the model's own figure. */
const BROWSER_PRIVACY_NOTE =
  "Your photo stays on this device: its shape is worked out in your browser and nothing is uploaded. The first photo downloads a depth model of about 25 MB, once.";
/** On the failure card, when the server cannot be reached and the browser can do the analysis instead. */
const BROWSER_OFFER_NOTE = "Or analyse it in this browser: a depth model of about 25 MB downloads once, and the photo stays on this device. Surfaces shade a little flatter than with the server's detailed normals.";
/** In the Geometry panel, for a scene the browser worked out. */
const BROWSER_GEOMETRY_NOTE =
  "Depth estimated in your browser by Depth Anything V2 Small, the model the Relight server uses. The normals are taken from the slope of that depth map, so they are smoother than the server's detailed normals: a face shades flatter.";
const DETAIL_HINT = "Slower to analyse, much better surface detail.";
const DETAIL_HINT_SAMPLE = "Always on for a sample photo: its maps were made ahead of time with detailed normals.";
const DETAIL_HINT_BROWSER_ONLY = "Off for your own photo: detailed normals come from a second, much larger model that only the Relight server runs.";
const DETAIL_HINT_BROWSER = "Off: this photo was analysed in your browser. Turn on to ask the Relight server for detailed normals.";
const DEPTH_DEVICE_LABEL: Record<DepthDevice, string> = { webgpu: "graphics chip (WebGPU)", wasm: "processor (WebAssembly)" };
/** Mock mode only, and only when asked for on the failure card: why the photo has a round edge. */
const STAND_IN_SHAPE_NOTE =
  "No backend is running (mock mode), so this photo is lit as a made-up dome, not its real shape. The round edge you see is that dome. Use a sample photo, or click New photo and try again once the depth model can be downloaded.";

const DEMO_ENHANCE_NOTE = "Enhance needs the Relight server, which this demo runs without.";
/**
 * Shading on the processor: a full-quality picture that takes longer than this,
 * in milliseconds, is slow enough that the server's renders are the better
 * picture, when there is a server. Lower and ordinary laptops would be sent to
 * the network for nothing; higher and a slow phone waits seconds for each picture.
 */
const CPU_SLOW_MS = 1200;
/** Shown in the prompt box. Short enough for one line of the sidebar at every window size, so it is never cut off. */
const PROMPT_PLACEHOLDER = "Optional: a mood, such as golden hour";

const PRESETS: { label: string; light: Partial<LightBase>; warmth?: number }[] = [
  { label: "Left", light: { x: -0.1, y: 0.4, height: 0.35, intensity: 1.3 } },
  { label: "Right", light: { x: 1.1, y: 0.4, height: 0.35, intensity: 1.3 } },
  { label: "Top", light: { x: 0.5, y: -0.15, height: 0.35, intensity: 1.3 } },
  { label: "Low and warm", light: { x: 0.0, y: 0.9, height: 0.12, intensity: 1.6, ambient: 0.2 }, warmth: 1 },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** How close the middle of the sun may come to the stage's left and right edges: HANDLE_MARGIN_PX, or more on a touch screen where the stage reaches the side of the screen (TOUCH_EDGE_CLEAR_PX). */
function handleMarginX(bounds: DOMRect | undefined) {
  if (!bounds || !window.matchMedia("(pointer: coarse)").matches) return HANDLE_MARGIN_PX;
  const gap = Math.min(bounds.left, document.documentElement.clientWidth - bounds.right);
  return Math.max(HANDLE_MARGIN_PX, TOUCH_EDGE_CLEAR_PX - gap);
}
const round = (v: number, digits = 3) => Number(v.toFixed(digits));
const smoothstep = (t: number) => t * t * (3 - 2 * t);
/** Height: 0 at the slider's low end, 1 at its high end, in equal ratios between. */
const heightShare = (height: number) => clamp(Math.log(height / HEIGHT_MIN) / Math.log(HEIGHT_MAX / HEIGHT_MIN), 0, 1);
const between = ([low, high]: number[], t: number) => low + (high - low) * t;

/** Sweep: the light a share `s` (0 to 1) of the way round its loop from `from`: out onto the orbit, once round, and back. */
function sweepPoint(from: { x: number; y: number }, s: number) {
  const angle = Math.atan2(from.y - SWEEP_CENTRE.y, from.x - SWEEP_CENTRE.x) + s * 2 * Math.PI;
  // 0 at both ends (the user's own position), 1 while on the orbit.
  const onOrbit = smoothstep(clamp(Math.min(s, 1 - s) / SWEEP_BLEND, 0, 1));
  return {
    x: from.x + (SWEEP_CENTRE.x + SWEEP_RADIUS * Math.cos(angle) - from.x) * onOrbit,
    y: from.y + (SWEEP_CENTRE.y + SWEEP_RADIUS * Math.sin(angle) - from.y) * onOrbit,
  };
}

/**
 * Sweep: the loop as points, with the distance travelled to each as it is seen
 * on screen (`aspect` is the photo's width over its height). Turning the angle
 * evenly made the glide on and off the orbit almost twice as fast as the orbit
 * itself, which a tester saw as a sweep that slows down in the middle.
 */
function sweepLoop(from: { x: number; y: number }, aspect: number) {
  const points = Array.from({ length: SWEEP_STEPS + 1 }, (_, i) => sweepPoint(from, i / SWEEP_STEPS));
  const travelled = [0];
  for (let i = 1; i < points.length; i++) {
    travelled.push(travelled[i - 1] + Math.hypot((points[i].x - points[i - 1].x) * aspect, points[i].y - points[i - 1].y));
  }
  return { points, travelled };
}

/** Sweep: the share of the distance covered after a share `t` of the time. One steady speed, with a short ramp up and down so the sun neither jumps off nor stops dead. */
function sweepProgress(t: number) {
  const cruise = 1 / (1 - SWEEP_RAMP);
  if (t < SWEEP_RAMP) return (cruise * t * t) / (2 * SWEEP_RAMP);
  if (t > 1 - SWEEP_RAMP) return 1 - (cruise * (1 - t) * (1 - t)) / (2 * SWEEP_RAMP);
  return cruise * (t - SWEEP_RAMP / 2);
}

/** Runs a backend call that needs a scene id, first obtaining one if the scene is a built-in sample. */
type WithBackendScene = <T>(scene: RelightScene, offlineMessage: string, call: (sceneId: string) => Promise<T>) => Promise<T>;

/** -1 = cool, 0 = white, 1 = warm -> the light's colour multiplier. */
function warmthToColor(warmth: number): [number, number, number] {
  const target = warmth >= 0 ? WARM : COOL;
  const t = Math.abs(warmth);
  return [round(1 + (target[0] - 1) * t), round(1 + (target[1] - 1) * t), round(1 + (target[2] - 1) * t)];
}

const cssColor = (c: [number, number, number]) => `rgb(${c.map((v) => Math.round(clamp(v, 0, 1) * 255)).join(" ")})`;

/**
 * Fallback for browsers that cannot shade, or shade too slowly: ask the server
 * to render each light position (debounced), instead of shading in the browser.
 * `onFail` is called each time a render fails.
 */
function useServerPreview(enabled: boolean, scene: RelightScene | null, light: Light, shadows: boolean, withBackendScene: WithBackendScene, onFail: () => void) {
  const [state, setState] = useState<{ sceneId: string | null; image: string | null; error: string | null }>({ sceneId: null, image: null, error: null });
  // Bumped by retry(). While renders fail the light is locked, so moving it cannot be what asks again.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!enabled || !scene) return;
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const render = await withBackendScene(scene, SERVER_RENDER_OFFLINE, (scene_id) => relightRender({ scene_id, light, shadows }, controller.signal));
        if (!cancelled) setState({ sceneId: scene.scene_id, image: render.image, error: null });
      } catch (error) {
        if (cancelled || isAbort(error)) return;
        setState((s) => ({ ...s, error: errorMessage(error) }));
        onFail();
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, scene, light, shadows, withBackendScene, onFail, attempt]);
  // The last render outlives a change of photo: never show or export it over another scene.
  const image = enabled && scene && state.sceneId === scene.scene_id ? state.image : null;
  return { image, error: enabled ? state.error : null, retry };
}

export default function RelightPage() {
  const [photo, setPhoto] = useState<LoadedImage | null>(null);
  const [scene, setScene] = useState<RelightScene | null>(null);
  const [detail, setDetail] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The scene request failed and there is nothing to shade: shown on the photo itself, not as a banner.
  // `route` is what was tried; `offline` is the server not answering at all, which the browser can stand in for.
  const [sceneError, setSceneError] = useState<{ message: string; route: SceneRoute; offline: boolean } | null>(null);
  // The browser is analysing the photo: how far it has got.
  const [progress, setProgress] = useState<LocalProgress | null>(null);
  // How the depth model was run for the scene on screen, when the browser worked it out.
  const [depthDevice, setDepthDevice] = useState<DepthDevice | null>(null);
  const [picking, setPicking] = useState<string | null>(null); // sample being fetched
  const [sampleError, setSampleError] = useState<string | null>(null);

  const [base, setBase] = useState<LightBase>(START);
  const [warmth, setWarmth] = useState(0);
  const [shadows, setShadows] = useState(true);
  const light = useMemo<Light>(() => ({ ...base, color: warmthToColor(warmth) }), [base, warmth]);

  const [ready, setReady] = useState(false); // the first shaded picture is on the canvas
  // How the canvas is being shaded (graphics chip or processor), once it is.
  const [path, setPath] = useState<ShadingPath | null>(null);
  // Why nothing in this browser can shade the photo: neither the graphics chip nor the processor.
  const [localProblem, setLocalProblem] = useState<string | null>(null);
  // The processor shades, but takes this many milliseconds over a picture: too long (see CPU_SLOW_MS).
  const [cpuSlowMs, setCpuSlowMs] = useState<number | null>(null);
  // A server render failed, so being slow is no longer a reason to ask the server.
  const [serverDown, setServerDown] = useState(false);
  const [dragging, setDragging] = useState(false);
  // How close the drawn sun may come to the stage's sides: more on a touch screen (handleMarginX).
  const [sunMarginX, setSunMarginX] = useState(HANDLE_MARGIN_PX);
  const [sweeping, setSweeping] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [tab, setTab] = useState<"live" | "enhanced">("live");
  const [prompt, setPrompt] = useState("");
  const [snapshot, setSnapshot] = useState<string | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  // Resolves when the canvas holds the finished picture for the current light (the processor shades a quick preview first).
  const settle = useRef<(() => Promise<void>) | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const imageBox = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const sweepFrame = useRef<number | null>(null);
  // The sun, once it is on the page: scrolling over it needs a listener of its own (below).
  const [handle, setHandle] = useState<HTMLButtonElement | null>(null);
  // The Height on screen, for the handlers that change it between two renders. `exact` is where scrolling has got to before rounding to the slider's steps.
  const heightNow = useRef({ shown: START.height, exact: START.height });
  // The fingers on the stage, where the light was before the first of them landed, and how a pinch started.
  const fingers = useRef(new Map<number, { x: number; y: number }>());
  const beforeTouch = useRef<{ x: number; y: number; at: number } | null>(null);
  const pinch = useRef<{ spread: number; height: number } | null>(null);
  // The backend's scene id for the sample on screen, once it has been asked for.
  const adopted = useRef<{ scene: RelightScene; id: Promise<string> } | null>(null);

  const withBackendScene = useCallback<WithBackendScene>(async (scene, offlineMessage, call) => {
    // A scene the browser worked out is sent the same way. The backend analyses the photo again with detailed normals,
    // so its renders are a little more detailed than the live preview of such a scene.
    if (!isSampleScene(scene) && !isLocalScene(scene)) return call(scene.scene_id);
    const sceneId = () => {
      if (adopted.current?.scene !== scene) {
        const id = relightAdoptScene(scene);
        adopted.current = { scene, id };
        // A failed attempt must not be the one that gets reused.
        id.catch(() => {
          if (adopted.current?.id === id) adopted.current = null;
        });
      }
      return adopted.current.id.catch((e: unknown) => {
        throw e instanceof ApiError && e.status === 0 ? new Error(offlineMessage) : e;
      });
    };
    try {
      return await call(await sceneId());
    } catch (e) {
      // The backend forgot the scene (it restarted, or newer scenes pushed it out): send the sample again, once.
      if (!(e instanceof ApiError && e.status === 404)) throw e;
      adopted.current = null;
      return call(await sceneId());
    }
  }, []);

  const enhance = useJob<RelightRender>();
  // Server renders stand in when the browser cannot shade at all, or only slowly. The static demo has no server to render on.
  const askServer = !DEMO && (localProblem !== null || (cpuSlowMs !== null && !serverDown));
  const onServerFail = useCallback(() => setServerDown(true), []);
  const server = useServerPreview(askServer, scene, light, shadows, withBackendScene, onServerFail);
  // The canvas is the picture, unless nothing here can shade or a server render has taken its place.
  const showCanvas = localProblem === null && !(askServer && server.image !== null);

  /** A new scene starts from the best shading path again. */
  const resetShading = useCallback(() => {
    setReady(false);
    setPath(null);
    setLocalProblem(null);
    setCpuSlowMs(null);
    setServerDown(false);
  }, []);

  const stopSweep = useCallback(() => {
    if (sweepFrame.current !== null) cancelAnimationFrame(sweepFrame.current);
    sweepFrame.current = null;
    setSweeping(false);
  }, []);
  // Leaving the page (or having it hidden) ends a sweep in progress.
  useEffect(() => stopSweep, [stopSweep]);
  // The stage's distance from the side of the screen changes with the photo, the window and a turned phone.
  // A ref callback, so the watching starts when the stage is put on the page, whenever that is.
  const watchStage = useCallback((stage: HTMLDivElement | null) => {
    surface.current = stage;
    if (!stage) return;
    const measure = () => setSunMarginX(handleMarginX(stage.getBoundingClientRect()));
    // Once now: the watcher below only reports while the page is being drawn, which a tab in the background is not.
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      watcher.disconnect();
      window.removeEventListener("resize", measure);
      surface.current = null;
    };
  }, []);

  const resetEnhance = enhance.reset;
  /** Everything that belongs to the photo on screen, cleared before another one takes its place. */
  const clearResults = useCallback(() => {
    stopSweep();
    setError(null);
    setSceneError(null);
    setTab("live");
    setSnapshot(null);
    resetEnhance();
  }, [stopSweep, resetEnhance]);

  /**
   * Get the photo's scene: from the backend, or worked out in this browser.
   * With `keep`, the scene on screen stays up while waiting and survives a
   * failure (used when a scene that already works is analysed again). Resolves
   * false if it failed.
   */
  const load = useCallback(
    async (image: LoadedImage, withDetail: boolean, keep = false, route: SceneRoute = FIRST_ROUTE): Promise<boolean> => {
      const id = ++request.current;
      clearResults();
      setPhoto(image);
      if (!keep) {
        setScene(null);
        setDepthDevice(null);
        resetShading();
      }
      setProgress(route === "browser" ? { stage: "prepare" } : null);
      setLoading(true);
      try {
        let result: RelightScene;
        let device: DepthDevice | null = null;
        if (route === "browser") {
          const local = await localScene(image.base64, (next) => {
            if (request.current === id) setProgress(next);
          });
          result = local.scene;
          device = local.device;
        } else result = await relightScene({ image: image.base64, detail: withDetail });
        if (request.current === id) {
          resetShading();
          setScene(result);
          setDepthDevice(device);
          // The browser has no detailed normals model: the switch says what the scene has.
          if (device !== null) setDetail(false);
        }
        return true;
      } catch (e) {
        if (request.current !== id || isAbort(e)) return true;
        if (keep) setError(`${errorMessage(e)} ${scene !== null && isLocalScene(scene) ? "The photo keeps the shape worked out in this browser." : "The sample keeps the geometry it came with."}`);
        else setSceneError({ message: errorMessage(e), route, offline: e instanceof ApiError && e.status === 0 });
        return false;
      } finally {
        if (request.current === id) {
          setLoading(false);
          setProgress(null);
        }
      }
    },
    [clearResults, resetShading, scene],
  );

  /** A built-in sample: its scene comes from static files, so this works with no backend. */
  const pickSample = async (sample: SamplePhoto) => {
    const id = ++request.current;
    setPicking(sample.name);
    setSampleError(null);
    try {
      const result = await loadSampleScene(sample);
      if (request.current !== id) return;
      clearResults();
      setPhoto({ base64: result.image, mime: "image/jpeg", width: result.width, height: result.height, name: `${sample.name}.jpg` });
      resetShading();
      setDetail(true); // samples are baked with the detailed normals
      setDepthDevice(null);
      setScene(result);
      setPicking(null);
    } catch (e) {
      if (request.current !== id) return;
      setSampleError(errorMessage(e));
      setPicking(null);
    }
  };

  const startOver = () => {
    request.current++;
    stopSweep();
    setPhoto(null);
    setScene(null);
    setDepthDevice(null);
    setLoading(false);
    setProgress(null);
    setError(null);
    setSceneError(null);
    setPicking(null);
    setSampleError(null);
    // A new photo starts clean: nothing set for the last one carries over.
    setBase(START);
    setWarmth(0);
    setShadows(true);
    setDetail(true);
    setPrompt("");
    setTab("live");
    setSnapshot(null);
    enhance.reset();
  };

  // --- dragging the light ---------------------------------------------------------

  const dragTo = (event: ReactPointerEvent) => {
    const box = imageBox.current?.getBoundingClientRect();
    const bounds = surface.current?.getBoundingClientRect();
    if (!box || !bounds || box.width === 0) return;
    // The handle may leave the photo but not the stage.
    const marginX = handleMarginX(bounds);
    const cx = clamp(event.clientX, bounds.left + marginX, bounds.right - marginX);
    const cy = clamp(event.clientY, bounds.top + HANDLE_MARGIN_PX, bounds.bottom - HANDLE_MARGIN_PX);
    const x = round(clamp((cx - box.left) / box.width, -OUTSIDE, 1 + OUTSIDE));
    const y = round(clamp((cy - box.top) / box.height, -OUTSIDE, 1 + OUTSIDE));
    setBase((b) => ({ ...b, x, y }));
  };

  // --- the light's distance: scrolling and pinching on the sun ------------------------

  useEffect(() => {
    // The slider, a preset or Reset moved it: scrolling carries on from there.
    if (heightNow.current.shown !== base.height) heightNow.current = { shown: base.height, exact: base.height };
  }, [base.height]);

  /** Set the Height from a scroll, a pinch or a key: kept inside the slider's range and on its steps, so the two always agree. */
  const setHeight = useCallback((exact: number) => {
    const next = clamp(exact, HEIGHT_MIN, HEIGHT_MAX);
    const height = round(next, 2);
    const changed = height !== heightNow.current.shown;
    heightNow.current = { shown: height, exact: next };
    if (changed) setBase((b) => ({ ...b, height }));
  }, []);

  /**
   * Scrolling while the pointer is over the sun moves the light toward the
   * viewer or away. Only over the sun: anywhere else the wheel scrolls the page
   * as it always did. Scrolling up (or spreading two fingers on a trackpad)
   * brings the light nearer and the sun grows, the way the same gesture zooms
   * in on a map. A Sweep in progress carries on at the new Height.
   * Listened for directly: React's own wheel listener may not stop the page from scrolling.
   */
  useEffect(() => {
    if (!handle) return;
    const onWheel = (event: WheelEvent) => {
      // Over the sun the wheel is the light's, at the ends of the range too: the page must not start to scroll when the light stops.
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 1 : WHEEL_LINE_PX;
      const step = clamp(event.deltaY * unit * (event.ctrlKey ? WHEEL_PINCH_GAIN : 1), -WHEEL_MAX_STEP_PX, WHEEL_MAX_STEP_PX);
      if (step !== 0) setHeight(heightNow.current.exact * Math.exp(-step * WHEEL_HEIGHT_PER_PX));
    };
    handle.addEventListener("wheel", onWheel, { passive: false });
    return () => handle.removeEventListener("wheel", onWheel);
  }, [handle, setHeight]);

  /** The + and - keys: one step nearer (1) or further (-1). Always at least one step of the slider, so no press is lost at the low end. */
  const stepHeight = (direction: 1 | -1) => {
    const now = heightNow.current.shown;
    const next = round(now * KEY_HEIGHT_RATIO ** direction, 2);
    setHeight(next === now ? now + 0.01 * direction : next);
  };

  /** How far apart the first two fingers on the stage are, in pixels. */
  const fingerSpread = () => {
    const [a, b] = [...fingers.current.values()];
    return Math.max(PINCH_MIN_SPREAD_PX, Math.hypot(a.x - b.x, a.y - b.y));
  };

  /**
   * The arrow keys move the light by hand, like a drag, so they stop at the
   * stage's edge as a drag does. Presets and Sweep do not come through here:
   * they put the light where they say whatever the window's size, and only the
   * drawn sun is held on the stage (.light-handle in globals.css).
   */
  const insideStage = (x: number, y: number) => {
    const box = imageBox.current?.getBoundingClientRect();
    const bounds = surface.current?.getBoundingClientRect();
    if (!box || !bounds || box.width === 0) return { x, y };
    const marginX = handleMarginX(bounds);
    return {
      x: round(clamp(x, (bounds.left + marginX - box.left) / box.width, (bounds.right - marginX - box.left) / box.width)),
      y: round(clamp(y, (bounds.top + HANDLE_MARGIN_PX - box.top) / box.height, (bounds.bottom - HANDLE_MARGIN_PX - box.top) / box.height)),
    };
  };

  const nudge = (dx: number, dy: number) => {
    stopSweep();
    const p = insideStage(clamp(base.x + dx, -OUTSIDE, 1 + OUTSIDE), clamp(base.y + dy, -OUTSIDE, 1 + OUTSIDE));
    // A preset may have left the light past the stage's edge: a step further out leaves it there, it is not pulled back to the edge.
    const x = dx > 0 ? Math.max(p.x, base.x) : dx < 0 ? Math.min(p.x, base.x) : base.x;
    const y = dy > 0 ? Math.max(p.y, base.y) : dy < 0 ? Math.min(p.y, base.y) : base.y;
    setBase((b) => ({ ...b, x, y }));
  };

  /**
   * Carry the light once around the subject and hand it back where it was.
   * For recording a demo; any deliberate move of the light ends it early.
   */
  const startSweep = () => {
    stopSweep();
    const { points, travelled } = sweepLoop({ x: base.x, y: base.y }, scene ? scene.width / scene.height : 1);
    const startedAt = performance.now();
    let i = 0; // the piece of the loop the light is on; it only ever moves forward
    setSweeping(true);
    const frame = (now: number) => {
      const t = clamp((now - startedAt) / SWEEP_MS, 0, 1);
      const distance = sweepProgress(t) * travelled[SWEEP_STEPS];
      while (i < SWEEP_STEPS - 1 && travelled[i + 1] < distance) i++;
      const within = clamp((distance - travelled[i]) / (travelled[i + 1] - travelled[i] || 1), 0, 1);
      const x = round(points[i].x + (points[i + 1].x - points[i].x) * within);
      const y = round(points[i].y + (points[i + 1].y - points[i].y) * within);
      setBase((b) => ({ ...b, x, y }));
      if (t < 1) sweepFrame.current = requestAnimationFrame(frame);
      else stopSweep();
    };
    sweepFrame.current = requestAnimationFrame(frame);
  };

  // --- actions --------------------------------------------------------------------

  const onReady = useCallback((next: ShadingPath) => {
    setReady(true);
    setPath(next);
  }, []);
  const onUnavailable = useCallback((reason: string) => setLocalProblem(reason), []);
  const onFullRender = useCallback((ms: number) => {
    if (ms > CPU_SLOW_MS) setCpuSlowMs(ms);
  }, []);

  const exportPng = async () => {
    try {
      if (showCanvas && canvas.current) {
        await settle.current?.(); // not the quick preview
        if (canvas.current) await downloadCanvas(canvas.current, "relit.png");
      } else if (server.image) await downloadBase64AsPng(server.image, "relit.png");
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const runEnhance = async () => {
    if (!scene) return;
    // Freeze what the live preview shows now: it is the "before" of the comparison.
    if (showCanvas) await settle.current?.(); // not the quick preview
    setSnapshot(showCanvas ? (canvas.current?.toDataURL("image/jpeg", 0.92) ?? null) : server.image ? toDataUrl(server.image) : null);
    // A new run clears the last result, which would leave the Enhanced tab empty, and stuck there if the run fails.
    setTab("live");
    const result = await enhance.run(() => withBackendScene(scene, ENHANCE_OFFLINE, (scene_id) => relightEnhance({ scene_id, light, shadows, prompt: prompt.trim() })));
    if (result) setTab("enhanced");
  };

  // --- render ---------------------------------------------------------------------

  if (!photo) {
    const samples = (
      <div className="mt-4">
        <p className="text-sm text-zinc-400">Or try a sample photo:</p>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {SAMPLES.map((sample) => (
            <button
              key={sample.name}
              type="button"
              disabled={picking !== null}
              aria-label={`Sample photo: ${sample.label}`}
              onClick={() => void pickSample(sample)}
              className={cn(
                "overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] text-left transition-colors hover:border-accent/60 hover:bg-white/[0.07]",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70 disabled:cursor-progress",
                picking !== null && picking !== sample.name && "opacity-50",
              )}
            >
              <img src={sampleThumbUrl(sample)} alt={sample.alt} draggable={false} className="aspect-[4/3] w-full object-cover" />
              <span className="block truncate px-2 py-1.5 text-xs font-medium text-zinc-300">{sample.label}</span>
            </button>
          ))}
        </div>
        <ErrorBanner message={sampleError} onDismiss={() => setSampleError(null)} className="mt-3" />
      </div>
    );
    return (
      <PageIntro
        eyebrow="Move the light"
        title="Relight a photo by dragging the light."
        lead={
          BROWSER_ONLY
            ? "Upload a photo or pick a sample. Its depth is estimated once, right here in your browser, which then shades it live: drag the light anywhere around the subject and the highlights and shadows follow instantly."
            : "Upload a photo. We estimate its depth and surface normals once, then your browser shades it live: drag the light anywhere around the subject and the highlights and shadows follow instantly."
        }
      >
        <UploadDropzone
          onImage={(image) => void load(image, detail)}
          title="Drop a photo here"
          footer={
            <>
              {BROWSER_ONLY && <p className="mt-3 text-sm leading-5 text-zinc-400">{BROWSER_PRIVACY_NOTE}</p>}
              {samples}
            </>
          }
        />
      </PageIntro>
    );
  }

  const width = scene?.width ?? photo.width;
  const height = scene?.height ?? photo.height;
  const photoUrl = toDataUrl(scene?.image ?? photo.base64);
  const enhancedBase64 = enhance.result?.image ?? null;
  const enhanced = enhancedBase64 ? toDataUrl(enhancedBase64) : null;
  const live = tab === "live";
  const canShade = scene !== null && (ready || localProblem !== null);
  // There is a relit picture on screen: the live canvas, or a render from the server.
  const canShow = canShade && (showCanvas || server.image !== null);
  // When nothing here can shade, the picture only changes when the server sends a render. With no server (the demo) or a failing one, nothing the light controls do can show.
  const stuck = localProblem !== null && (DEMO || server.error !== null);
  const canLight = canShade && !stuck;
  const failed = scene === null && !loading && sceneError !== null;
  // One bar for the missing live shading, saying what is true now.
  const gpuMessage =
    localProblem === null
      ? null
      : DEMO
        ? `Live shading is unavailable (${localProblem}), and this demo has no server to shade the photo instead. Open it in a current Chrome, Edge, Firefox or Safari.`
        : server.error !== null
          ? `Live shading is unavailable (${localProblem}), and the server render that would replace it failed: ${server.error} The light controls are off until a render arrives.`
          : `Live shading is unavailable (${localProblem}). Showing server renders instead, which lag slightly behind the light.`;
  const onProcessor = path !== null && path.kind.startsWith("cpu");
  // A quiet line for the slower ways of shading that still work. The red bar above is for when none does.
  // Mock mode's own answer to a scene request is a made-up dome. It is only used when the browser's
  // analysis failed and the user asked for it. A tester reported that dome as a bug: say what it is.
  const standInShape = MOCK && scene !== null && !isSampleScene(scene) && !isLocalScene(scene);
  const localShape = scene !== null && isLocalScene(scene);

  const shadingNote =
    localProblem !== null || !ready || path === null
      ? null
      : !showCanvas
        ? `This device's processor is slow at shading (${((cpuSlowMs ?? 0) / 1000).toFixed(1)} s a picture), so the server draws the photo instead. It lags slightly behind the light.`
        : onProcessor
          ? `Shading on this device's processor, not its graphics chip (${path.why}). The picture is a quick preview while the light moves and sharpens when it stops.`
          : null;
  // The picture on screen is one the server drew: for a slow processor, or because nothing here can shade.
  const fromServer = !showCanvas && server.image !== null;
  // The Geometry panel says which path is in use; the tooltip has the detail a bug report needs.
  const shadingLine = fromServer ? "server renders" : !ready || path === null || !showCanvas ? null : path.label;
  const shadingDetail = fromServer
    ? localProblem !== null
      ? `The photo is drawn by the server, because nothing on this device can shade it: ${localProblem.replace(/\.$/, "")}.`
      : `The photo is drawn by the server, because this device's processor takes ${((cpuSlowMs ?? 0) / 1000).toFixed(1)} s to shade one picture.${path?.why ? ` The graphics chip could not be used: ${path.why}.` : ""}`
    : path === null
      ? undefined
      : path.kind === "gpu-full"
        ? `The photo is shaded live by the graphics chip (${path.chip}), at full quality.`
        : path.kind === "gpu-packed"
          ? `The photo is shaded live by the graphics chip (${path.chip}). Shadows are kept in 8-bit buffers because ${path.why}; the picture is the same to within a level or two of brightness.`
          : `The photo is shaded by the processor${path.kind === "cpu-worker" ? ", in a background thread," : ""} because the graphics chip could not be used: ${path.why}.`;
  // A built-in sample comes with detailed normals; a photo analysed in the browser never has them.
  // Only a real backend can change either, so with none the switch just says which it is.
  const sampleScene = scene !== null && isSampleScene(scene);
  const detailHint = BROWSER_ONLY ? (sampleScene ? DETAIL_HINT_SAMPLE : DETAIL_HINT_BROWSER_ONLY) : localShape ? DETAIL_HINT_BROWSER : DETAIL_HINT;
  // The server did not answer, and this browser can do the analysis itself.
  const offerBrowser = !BROWSER_ONLY && sceneError !== null && sceneError.route === "backend" && sceneError.offline;
  // Mock mode, and the browser's analysis failed: the made-up dome is still there for someone working on the page itself.
  const offerDome = MOCK && sceneError !== null && sceneError.route === "browser";
  const enhanceError = enhance.status === "error" ? enhance.error : null;
  const endPointer = (e: ReactPointerEvent) => {
    fingers.current.delete(e.pointerId);
    if (fingers.current.size > 0) return;
    pinch.current = null;
    setDragging(false);
  };
  // How the sun is drawn at this Height (see SUN_SCALE).
  const lift = heightShare(light.height);
  const sunPx = HANDLE_PX * between(SUN_SCALE, lift);
  const glowReachPx = between(SUN_GLOW_REACH_PX, lift);
  // The shadow stays under the disc until the light is well off the surface, then falls away quickly.
  const sunShadow = `0 ${between(SUN_SHADOW_DROP_PX, lift * lift).toFixed(1)}px ${between(SUN_SHADOW_BLUR_PX, lift).toFixed(1)}px rgb(0 0 0 / ${between(SUN_SHADOW_ALPHA, lift).toFixed(2)})`;
  const failedCard = (
    <div role="alert" className="flex max-w-sm animate-rise flex-col items-center gap-2.5 rounded-2xl border border-rose-500/40 bg-ink/90 px-5 py-4 text-center shadow-2xl backdrop-blur max-lg:mx-auto">
      <span className="flex items-center gap-2 text-sm font-semibold text-rose-100">
        <AlertIcon className="text-rose-400" />
        This photo could not be analysed
      </span>
      <p className="break-words text-sm leading-5 text-rose-100/90">{sceneError?.message}</p>
      {offerBrowser && <p className="text-sm leading-5 text-zinc-300">{BROWSER_OFFER_NOTE}</p>}
      <div className="flex flex-wrap justify-center gap-2">
        {offerBrowser && (
          <Button size="sm" variant="primary" onClick={() => void load(photo, detail, false, "browser")}>
            Analyse in this browser
          </Button>
        )}
        <Button size="sm" variant={offerBrowser ? "secondary" : "primary"} onClick={() => void load(photo, detail, false, sceneError?.route)}>
          Retry
        </Button>
        {offerDome && (
          <Button size="sm" title="Mock mode only: lights the photo as a made-up dome, not its real shape." onClick={() => void load(photo, detail, false, "backend")}>
            Use a stand-in dome
          </Button>
        )}
        <Button size="sm" onClick={startOver}>
          Choose another photo
        </Button>
      </div>
    </div>
  );

  return (
    <Workspace
      sidebar={
        <>
          <Panel
            title="Light"
            hint="Drag the sun on the photo."
            actions={
              <Button
                size="sm"
                disabled={!canLight || !live}
                aria-pressed={sweeping}
                active={sweeping}
                title="Moves the light once around the subject in about six seconds, then gives it back. Handy for recording a demo."
                onClick={sweeping ? stopSweep : startSweep}
              >
                <OrbitIcon />
                {sweeping ? "Stop sweep" : "Sweep"}
              </Button>
            }
          >
            <div className={cn("flex flex-col gap-3 lg:short:gap-2", !canLight && "pointer-events-none opacity-50")} inert={!canLight}>
              <div className="flex items-center justify-between rounded-xl bg-black/30 px-3 py-1.5 font-mono text-xs tabular-nums text-zinc-400">
                <span>
                  x <span className="text-zinc-100">{light.x.toFixed(2)}</span>
                </span>
                <span>
                  y <span className="text-zinc-100">{light.y.toFixed(2)}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  colour <span className="h-3 w-3 rounded-full ring-1 ring-white/30" style={{ background: cssColor(light.color) }} />
                </span>
              </div>
              <Slider
                label="Height"
                value={base.height}
                min={HEIGHT_MIN}
                max={HEIGHT_MAX}
                step={0.01}
                onChange={(v) => setBase((b) => ({ ...b, height: v }))}
                hint={HEIGHT_HINT}
                ends={HEIGHT_ENDS}
              />
              <Slider label="Intensity" value={base.intensity} min={0} max={4} step={0.05} onChange={(v) => setBase((b) => ({ ...b, intensity: v }))} />
              <Slider
                label="Ambient"
                value={base.ambient}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setBase((b) => ({ ...b, ambient: v }))}
                hint="Light that reaches everything, shadows included."
              />
              <Slider
                label="Colour"
                value={warmth}
                min={-1}
                max={1}
                step={0.02}
                onChange={setWarmth}
                format={(v) => (Math.abs(v) < 0.02 ? "neutral" : v > 0 ? `warm ${Math.round(v * 100)}` : `cool ${Math.round(-v * 100)}`)}
                track={`linear-gradient(to right, ${cssColor(COOL)}, #ffffff, ${cssColor(WARM)})`}
              />
              <Toggle label="Cast shadows" hint="Objects block the light." checked={shadows} onChange={setShadows} />
              {/* The five share one row: each starts with next to no padding of its own and takes an equal share of what is left, so the row fits a 360 px phone and fills the sidebar alike. */}
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    size="sm"
                    className="flex-auto px-0.5!"
                    onClick={() => {
                      stopSweep();
                      // Exactly the preset's numbers, on every window and photo, so the same preset always gives the same lighting.
                      setBase((b) => ({ ...b, ...preset.light }));
                      setWarmth(preset.warmth ?? 0);
                    }}
                  >
                    {preset.label}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  className="flex-auto px-0.5!"
                  title="Puts the light, its colour and Cast shadows back to how they started. The photo and the Enhance text are left alone."
                  onClick={() => {
                    stopSweep();
                    setBase(START);
                    setWarmth(0);
                    setShadows(true);
                  }}
                >
                  Reset light
                </Button>
              </div>
            </div>
          </Panel>

          {/* On a short window beside the stage the hint moves to the button's tooltip and the box loses a row, so the sidebar fits. */}
          {/* The static demo has no server for Enhance: the reason takes the place of the hint and of the prompt box, which would have nothing to do. */}
          <Panel title="Enhance" hint={DEMO ? DEMO_ENHANCE_NOTE : ENHANCE_HINT} hintClassName={DEMO ? undefined : "lg:short:hidden"}>
            {!DEMO && (
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={2}
                placeholder={PROMPT_PLACEHOLDER}
                className="mb-2.5 block w-full resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-accent/60 focus:outline-none lg:short:h-[2.375rem]"
              />
            )}
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                className="flex-1"
                title={DEMO ? DEMO_ENHANCE_NOTE : ENHANCE_HINT}
                disabled={DEMO || !canLight}
                busy={enhance.status === "pending"}
                onClick={() => void runEnhance()}
              >
                {enhance.status !== "pending" && <SparklesIcon />}
                {enhance.status === "pending" ? "Enhancing…" : enhanced ? "Enhance again" : "Enhance"}
              </Button>
              {enhancedBase64 && (
                <Button title="Download the enhanced image" aria-label="Download the enhanced image" onClick={() => void downloadBase64AsPng(enhancedBase64, "relit-enhanced.png")}>
                  <DownloadIcon />
                </Button>
              )}
            </div>
            {/* Beside the stage the sidebar has no room to spare, so there the message goes above the photo instead (below). */}
            <ErrorBanner message={enhanceError} onDismiss={enhance.reset} className="mt-3 lg:hidden" />
          </Panel>

          <CollapsiblePanel
            title="Geometry"
            peek={
              scene ? (
                <span className="flex gap-1" aria-hidden>
                  <img src={toDataUrl(scene.depth)} alt="" className="h-5 w-7 rounded-[4px] object-cover ring-1 ring-white/15" />
                  <img src={toDataUrl(scene.normals)} alt="" className="h-5 w-7 rounded-[4px] object-cover ring-1 ring-white/15" />
                </span>
              ) : undefined
            }
          >
            <p className="mb-2.5 text-xs leading-4 text-zinc-500">{localShape ? BROWSER_GEOMETRY_NOTE : "What the models recovered from the photo. The shader lights these."}</p>
            {scene ? (
              <div className="grid grid-cols-2 gap-2.5">
                {[
                  { label: "Depth", src: scene.depth, note: "white = near" },
                  { label: "Normals", src: scene.normals, note: "surface direction" },
                ].map((map) => (
                  <figure key={map.label} className="overflow-hidden rounded-xl border border-white/[0.08] bg-black/40">
                    <img src={toDataUrl(map.src)} alt={`${map.label} map`} className="aspect-[4/3] w-full object-cover" />
                    <figcaption className="px-2.5 py-1.5 text-xs leading-4">
                      <span className="block font-medium text-zinc-200">{map.label}</span>
                      <span className="block text-zinc-500">{map.note}</span>
                    </figcaption>
                  </figure>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2.5">
                <div className="skeleton aspect-[4/3] rounded-xl" />
                <div className="skeleton aspect-[4/3] rounded-xl" />
              </div>
            )}
            <div className="mt-3">
              <Toggle
                label="Detailed normals"
                hint={detailHint}
                checked={BROWSER_ONLY ? sampleScene : detail}
                disabled={BROWSER_ONLY}
                onChange={(next) => {
                  // A sample, or a photo analysed in the browser, already works without the backend: keep it on screen unless the new analysis succeeds.
                  const keep = sampleScene || localShape;
                  setDetail(next);
                  void load(photo, next, keep, "backend").then((ok) => {
                    if (!ok && keep) setDetail(!next);
                  });
                }}
              />
            </div>
            {scene && (
              <p className="mt-2.5 font-mono text-[11px] text-zinc-500">
                {scene.width} x {scene.height} px, relief {scene.relief}
                {depthDevice && (
                  <span className="mt-0.5 block" data-depth-device={depthDevice} title="The depth model ran in this browser. The photo was not sent anywhere.">
                    depth: this browser, {DEPTH_DEVICE_LABEL[depthDevice]}
                  </span>
                )}
                {shadingLine && (
                  <span className="mt-0.5 block" title={shadingDetail}>
                    shading: {shadingLine}
                  </span>
                )}
              </p>
            )}
          </CollapsiblePanel>
        </>
      }
    >
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <ErrorBanner message={enhanceError} onDismiss={enhance.reset} className="max-lg:hidden" />
      <ErrorBanner message={gpuMessage} onRetry={!DEMO && server.error !== null ? server.retry : undefined} />
      <ShadingNote message={standInShape ? STAND_IN_SHAPE_NOTE : null} />
      <ShadingNote message={shadingNote} />

      <Stage hug={{ width, height }}>
        {/* The whole stage is the drag surface, so the light can be pulled past the photo's edge. */}
        <div
          ref={watchStage}
          className={cn("absolute inset-0 touch-none", live && canLight && (dragging ? "cursor-grabbing" : "cursor-crosshair"))}
          onPointerDown={(e) => {
            if (!live || !canLight || e.button !== 0) return;
            // A first pointer means no finger is still down, whatever an earlier touch left behind.
            if (e.isPrimary) fingers.current.clear();
            e.currentTarget.setPointerCapture(e.pointerId);
            fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (fingers.current.size === 2) {
              // A second finger: from here the two set the light's distance, and neither drags it.
              const before = beforeTouch.current;
              if (before && e.timeStamp - before.at < PINCH_GRACE_MS) setBase((b) => ({ ...b, x: before.x, y: before.y }));
              pinch.current = { spread: fingerSpread(), height: heightNow.current.shown };
              return;
            }
            if (fingers.current.size > 2) return;
            stopSweep(); // the user has taken the light
            beforeTouch.current = { x: base.x, y: base.y, at: e.timeStamp };
            setDragging(true);
            dragTo(e);
          }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            if (fingers.current.has(e.pointerId)) fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            // Spreading the fingers brings the light nearer, pinching pushes it back. Once a pinch has begun, a finger left on the screen does not drag.
            if (pinch.current) {
              if (fingers.current.size >= 2) setHeight(pinch.current.height * (fingerSpread() / pinch.current.spread) ** PINCH_POWER);
            } else dragTo(e);
          }}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          {/* The margins round the photo. .light-handle (globals.css) reads the two variables to know where the stage ends. */}
          <div className="absolute inset-x-(--stage-inset-x) inset-y-(--stage-inset-y) [--stage-inset-x:1.5rem] [--stage-inset-y:4rem] sm:[--stage-inset-x:3.5rem]">
            {/* Live preview. Stays mounted behind the Enhanced tab so the scene it has loaded survives. */}
            <div className={cn("absolute inset-0", !live && "invisible")}>
              <FitBox width={width} height={height}>
                <div ref={imageBox} className="absolute inset-0 overflow-hidden rounded-lg bg-black shadow-2xl ring-1 ring-white/10">
                  <img src={photoUrl} alt="Original photo" draggable={false} className={cn("absolute inset-0 h-full w-full", failed && "opacity-30 grayscale")} />
                  {scene && showCanvas && (
                    <RelightCanvas
                      scene={scene}
                      light={light}
                      shadows={shadows}
                      canvasRef={canvas}
                      settleRef={settle}
                      onReady={onReady}
                      onUnavailable={onUnavailable}
                      onFullRender={onFullRender}
                      className={cn("absolute inset-0 h-full w-full", (!ready || comparing) && "opacity-0")}
                    />
                  )}
                  {!showCanvas && server.image && !comparing && (
                    <img src={toDataUrl(server.image)} alt="Relit photo" draggable={false} className="absolute inset-0 h-full w-full" />
                  )}
                  {comparing && <span className="absolute left-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-zinc-200 backdrop-blur">Original</span>}
                  {(loading || (scene !== null && !canShade)) && <BusyOverlay>{loading ? (progress ? progressText(progress) : "Estimating depth and surface normals…") : "Preparing the shader…"}</BusyOverlay>}
                </div>

                {canLight && (
                  <button
                    ref={setHandle}
                    type="button"
                    aria-label={`Light position, x ${light.x.toFixed(2)}, y ${light.y.toFixed(2)}, height ${light.height.toFixed(2)}. Use the arrow keys to move, and plus or minus to bring the light nearer or push it back.`}
                    data-height={light.height.toFixed(2)}
                    onKeyDown={(e) => {
                      const step = e.shiftKey ? 0.1 : 0.02;
                      // With Ctrl or Cmd these two zoom the page: left to the browser.
                      if (!e.ctrlKey && !e.metaKey && (e.key === "+" || e.key === "=")) stepHeight(1);
                      else if (!e.ctrlKey && !e.metaKey && (e.key === "-" || e.key === "_")) stepHeight(-1);
                      else if (e.key === "ArrowLeft") nudge(-step, 0);
                      else if (e.key === "ArrowRight") nudge(step, 0);
                      else if (e.key === "ArrowUp") nudge(0, -step);
                      else if (e.key === "ArrowDown") nudge(0, step);
                      else return;
                      e.preventDefault();
                    }}
                    className={cn(
                      "light-handle group absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/80",
                      dragging ? "cursor-grabbing" : "cursor-grab",
                    )}
                    style={
                      {
                        // As large as the disc, and never smaller than the 40 px that is easy to grab.
                        width: Math.max(HANDLE_PX, sunPx),
                        height: Math.max(HANDLE_PX, sunPx),
                        "--light-x": light.x,
                        "--light-y": light.y,
                        "--photo-ratio": width / height,
                        "--handle-margin": `${HANDLE_MARGIN_PX}px`,
                        "--handle-margin-x": `${sunMarginX}px`,
                      } as CSSProperties
                    }
                  >
                    <span
                      aria-hidden
                      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                      style={{
                        width: sunPx + 2 * glowReachPx,
                        height: sunPx + 2 * glowReachPx,
                        filter: `blur(${between(SUN_GLOW_BLUR_PX, lift).toFixed(1)}px)`,
                        background: `radial-gradient(circle, ${cssColor(light.color)} 0%, transparent 65%)`,
                        opacity: 0.25 + 0.15 * Math.min(light.intensity, 3),
                      }}
                    />
                    <span
                      data-sun
                      className={cn(
                        "pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white text-black/75 transition-[scale,width,height,box-shadow] motion-reduce:transition-none",
                        dragging && "scale-110",
                      )}
                      style={{ width: sunPx, height: sunPx, boxShadow: sunShadow, background: cssColor(light.color) }}
                    >
                      {/* Marked important: the icon's own default size is set the same way, and which class wins otherwise is down to the stylesheet's order. */}
                      <SunIcon className="h-1/2! w-1/2!" />
                    </span>
                    {/* Appears when the mouse has rested on the sun for a moment, and never while it is being dragged. */}
                    {!dragging && (
                      <span
                        aria-hidden
                        className="pointer-events-none absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/70 px-2 py-0.5 text-[11px] font-medium text-zinc-200 opacity-0 backdrop-blur transition-opacity delay-0 group-hover:opacity-100 group-hover:delay-500 group-focus-visible:opacity-100"
                      >
                        {SUN_HINT}
                      </span>
                    )}
                  </button>
                )}
              </FitBox>
            </div>

            {/* A failed load must not pass for a loaded scene: the photo is dimmed and, beside the sidebar, this sits on top of it. */}
            {failed && <div className="absolute inset-0 z-20 flex items-center justify-center max-lg:hidden">{failedCard}</div>}

            {!live && enhanced && snapshot && (
              <FitBox width={width} height={height}>
                <BeforeAfter fill before={snapshot} after={enhanced} beforeLabel="Live preview" afterLabel="Enhanced" className="rounded-lg shadow-2xl ring-1 ring-white/10" />
              </FitBox>
            )}
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-3 top-3 z-30 flex items-start justify-between gap-2">
          <div className="pointer-events-auto">
            {(enhanced || enhance.status === "pending") && (
              <Segmented
                value={tab}
                onChange={setTab}
                options={[
                  { value: "live", label: "Live preview" },
                  { value: "enhanced", label: enhance.status === "pending" ? "Enhancing…" : "Enhanced", disabled: !enhanced },
                ]}
              />
            )}
          </div>
          <Button size="sm" variant="glass" className="pointer-events-auto" onClick={startOver}>
            <UploadIcon />
            New photo
          </Button>
        </div>

        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex items-center justify-center gap-2">
          {enhance.status === "pending" && (
            <BusyLabel className="pointer-events-auto mr-auto rounded-full border border-white/10 bg-black/60 px-3 py-1.5 text-xs backdrop-blur">Enhancing in the background, keep dragging</BusyLabel>
          )}
          {live && (
            <Button
              size="sm"
              variant="glass"
              className="pointer-events-auto"
              active={comparing}
              disabled={!canShow}
              onPointerDown={() => setComparing(true)}
              onPointerUp={() => setComparing(false)}
              onPointerLeave={() => setComparing(false)}
              onPointerCancel={() => setComparing(false)}
              onKeyDown={(e) => (e.key === " " || e.key === "Enter") && setComparing(true)}
              onKeyUp={() => setComparing(false)}
              onBlur={() => setComparing(false)}
            >
              <EyeIcon />
              Hold to see original
            </Button>
          )}
          {live ? (
            <Button size="sm" variant="glass" className="pointer-events-auto" disabled={!canShow} onClick={() => void exportPng()}>
              <DownloadIcon />
              Export PNG
            </Button>
          ) : (
            enhancedBase64 && (
              <Button size="sm" variant="glass" className="pointer-events-auto" onClick={() => void downloadBase64AsPng(enhancedBase64, "relit-enhanced.png")}>
                <DownloadIcon />
                Download enhanced
              </Button>
            )
          )}
        </div>
      </Stage>
      {/* On a stacked page the stage is only as tall as the photo, so the card goes under it, where it cannot hide a wide one. */}
      {failed && <div className="lg:hidden">{failedCard}</div>}
    </Workspace>
  );
}
