"use client";

import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { BeforeAfter } from "@/components/BeforeAfter";
import { ErrorBanner } from "@/components/ErrorBanner";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Help } from "@/components/Help";
import { FitBox, PageIntro, Panel, Stage, Workspace } from "@/components/Panel";
import { BusyLabel, BusyOverlay } from "@/components/Spinner";
import { UploadDropzone } from "@/components/UploadDropzone";
import { AlertIcon, DownloadIcon, EyeIcon, OrbitIcon, SparklesIcon, UploadIcon } from "@/components/icons";
import { RelightCanvas, type ShadingPath } from "@/components/relight/RelightCanvas";
import { AMBIENT_HELP, AMBIENT_HINT, BOTH_LIGHTS, COLOUR_HELP, FILL_HELP, HEIGHT_ENDS, HEIGHT_HELP, HEIGHT_HINT, INTENSITY_HELP, SHADOWS_HELP, SHADOWS_HELP_WITH_FILL, SHINE_HELP, SHINE_HINT } from "@/components/relight/lightHelp";
import { HANDLE_MARGIN_PX, HANDLE_MARGIN_Y_PX, LightSun, type Which, handleMarginX } from "@/components/relight/LightSun";
import { ShadingNote } from "@/components/relight/ShadingNote";
import { type StartTab, StartTabs } from "@/components/relight/StartTabs";
import { type WithBackendScene, useServerPreview } from "@/components/relight/useServerPreview";
import { Button, Segmented, Slider, Switch, Toggle } from "@/components/ui";
import { ApiError, errorMessage, isAbort, relightAdoptScene, relightEnhance, relightScene } from "@/lib/api";
import { cn } from "@/lib/cn";
import { API_URL, DEMO, MOCK } from "@/lib/config";
import { type Draft, draftName, fingerprint, isDraftScene, readDraftScene, saveDraft, smallPicture, useDrafts } from "@/lib/drafts";
import { HOME_EVENT } from "@/lib/home";
import { COOL, HEIGHT_MAX, HEIGHT_MIN, WARM, clamp, cssColor, round, warmthToColor } from "@/lib/lightValues";
import { type LoadedImage, downloadBase64AsPng, downloadCanvas, sniffMime, toDataUrl } from "@/lib/image";
import { type DepthDevice, type LocalProgress, depthDeviceText, isLocalScene, localScene, progressText } from "@/lib/localScene";
import { SAMPLES, type SamplePhoto, isSampleScene, loadSampleScene, sampleThumbUrl } from "@/lib/samples";
import { SWEEP_MS, SWEEP_STEPS, sweepLoop, sweepProgress } from "@/lib/sweep";
import type { FillLight, Light, RelightRender, RelightScene } from "@/lib/types";
import { useJob } from "@/lib/useJob";

/** How far outside the photo the light may be dragged, in image widths/heights. */
const OUTSIDE = 0.5;

/**
 * Scrolling over the sun: how much one pixel of scroll changes the Height, as
 * a power of e. A mouse wheel's notch is about 100 px, so one notch is a
 * quarter more or less: 13 notches from the starting Height to the top, 6 to
 * the bottom. Larger and a trackpad's glide overshoots; smaller and a wheel
 * needs a tiring number of turns.
 */
const WHEEL_HEIGHT_PER_PX = 0.0022;
/** The + and - keys: each press changes the Height by this ratio, like half a wheel notch. */
const KEY_HEIGHT_RATIO = 1.12;
/** Two fingers on a touch screen: spreading them to twice as far apart multiplies the Height by 2 to this power. 2.5 reaches either end from the start in one comfortable pinch. */
const PINCH_POWER = 2.5;
/** Two fingers closer than this, in pixels, count as this far apart, so that fingers landing side by side do not make a tiny move a huge change. */
const PINCH_MIN_SPREAD_PX = 24;
/** A second finger landing within this many milliseconds of the first means a pinch was meant from the start: the light goes back to where it was before the first finger moved it. */
const PINCH_GRACE_MS = 350;
/**
 * The space between the LIGHT panel's rows where the sidebar is beside the stage. The Key | Fill row is one row more than the sidebar was fitted to.
 * The demo has the height for it (its ENHANCE panel is shorter), so it keeps the spacing it had. With a backend the rows sit closer in a window under 874px
 * (2px each under 771px, 4px each from there up), which gives back most of what the new row takes: LIGHT, ENHANCE and the folded GEOMETRY row fit again
 * at 1280 x 720 and from 719px up, except in the few pixels above each step of the layout (771 to 784 and 832 to 842, and 709 to 718), where the sidebar
 * scrolls by up to 14px and did not before the row.
 */
const LIGHT_ROW_GAPS = DEMO ? "lg:short:gap-2" : "lg:short:gap-1.5 lg:[@media(min-height:771px)_and_(max-height:873px)]:gap-2";

type LightBase = Omit<Light, "color">;

/**
 * The fill light as the page holds it, from the first time it is switched on:
 * its switch, its own place, Height and Intensity, and its own Colour slider.
 * Switched off it keeps its numbers, for the next time. It has no Ambient and
 * no Shine: those are shared, and are the key's.
 */
interface FillState {
  on: boolean;
  base: Omit<LightBase, "ambient" | "shine">;
  warmth: number;
}

/**
 * What the fill light starts with the first time it is switched on, besides
 * its place (the key's, mirrored across the photo's middle). Further back and
 * a third as strong as the key starts: enough to open the shadows, not enough
 * to make a second lit side.
 */
const FILL_START = { height: 0.35, intensity: 0.6 };

/** What a draft holds besides its name and its small picture. Compared with what is on screen to tell whether anything needs saving. */
interface DraftContent {
  scene: RelightScene;
  base: LightBase;
  warmth: number;
  fill: FillState | null;
  picked: Which;
  shadows: boolean;
  detail: boolean;
}

/** The user's own photo, as a draft (lib/drafts.ts). A sample is never one: it opens at once as it is. */
interface OwnPhoto {
  /** The photo this is about. A draft is only saved while this is the photo on screen. */
  photo: LoadedImage;
  /** The draft's id: a fingerprint of the picture, which takes a moment to work out. */
  id: Promise<string>;
  name: string;
  createdAt: number;
  /** What the browser's storage has been given for it, null before the first save and after a failed one. */
  kept: DraftContent | null;
  /** The scene whose first save has been started: later ones wait for the light to rest (DRAFT_SAVE_MS). */
  begun: RelightScene | null;
}

/**
 * The light a fresh scene (and Reset) starts with. The API's own default
 * (x 0.20, y 0.20, height 0.25) lights a photo so evenly that testers read it
 * as "nothing happened". This one sits low and to the left of the subject, so
 * one side is clearly lit and the other falls into shadow, on a face and on an
 * object alike; it is still inside the photo, so the handle is in plain sight.
 * Intensity 1.4 and Ambient 0.20, not the 1.8 and 0.06 it first had:
 * testers found that too harsh (a tester scored the Portrait 2.5 to 3.5 at the
 * start and about 4.5 with the dark side lifted), and with these the dark side
 * keeps its detail while the light still clearly comes from the left.
 */
const START: LightBase = { x: 0.12, y: 0.35, height: 0.12, intensity: 1.4, ambient: 0.2, shine: 0 };

/** Enhance and server renders, for a built-in sample with no backend to send it to. */
const ENHANCE_OFFLINE = `Enhance needs the backend, which cannot be reached at ${API_URL}. The live preview and Export PNG still work without it.`;
const ENHANCE_HINT = "A photoreal pass over this lighting. Takes a few seconds.";
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
/**
 * Drafts (lib/drafts.ts): how long after the light or a switch was last touched
 * the draft is brought up to date, in milliseconds. Long enough that a drag or
 * a Sweep is one save and not hundreds, short enough to have happened before
 * the tab is closed.
 */
const DRAFT_SAVE_MS = 800;
/** On the Drafts tab, when the browser's storage would not give a draft back. */
const DRAFT_UNREADABLE = "That draft could not be opened.";

const PRESETS: { label: string; light: Partial<LightBase>; warmth?: number }[] = [
  { label: "Left", light: { x: -0.1, y: 0.4, height: 0.35, intensity: 1.3 } },
  { label: "Right", light: { x: 1.1, y: 0.4, height: 0.35, intensity: 1.3 } },
  { label: "Top", light: { x: 0.5, y: -0.15, height: 0.35, intensity: 1.3 } },
  { label: "Low and warm", light: { x: 0.0, y: 0.9, height: 0.12, intensity: 1.6, ambient: 0.2 }, warmth: 1 },
];

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
  const [picking, setPicking] = useState<string | null>(null); // sample being fetched, or draft being read
  const [sampleError, setSampleError] = useState<string | null>(null);
  // The first page's two tabs. Kept here, not in the tabs, so New photo comes back to the one the photo was opened from.
  const [startTab, setStartTab] = useState<StartTab>("samples");
  const drafts = useDrafts();
  const [draftNote, setDraftNote] = useState<string | null>(null);
  // For a scene opened from a draft: the Geometry panel's words for how its depth was made, as they were when it was saved.
  const [draftDepth, setDraftDepth] = useState<{ scene: RelightScene; text: string } | null>(null);

  const [base, setBase] = useState<LightBase>(START);
  const [warmth, setWarmth] = useState(0);
  const [shadows, setShadows] = useState(true);
  const light = useMemo<Light>(() => ({ ...base, color: warmthToColor(warmth) }), [base, warmth]);
  // The fill light: null until it is first switched on, then kept, on or off, with its numbers.
  const [fill, setFill] = useState<FillState | null>(null);
  // What is shaded: the fill while it is on, and nothing of it while it is off.
  const fillLight = useMemo<FillLight | null>(() => (fill?.on ? { ...fill.base, color: warmthToColor(fill.warmth) } : null), [fill]);
  // The light the LIGHT panel's Height, Intensity and Colour are on, and that a click on the photo moves. It can only be the fill while the fill is on.
  const [picked, setPicked] = useState<Which>("key");
  const which: Which = picked === "fill" && fillLight !== null ? "fill" : "key";
  const fillSwitch = useId();

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
  // The reader has changed the Height by hand (the slider, a scroll, a pinch or a key): the moment to explain it. Presets and Reset light do not count.
  const [heightUsed, setHeightUsed] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [tab, setTab] = useState<"live" | "enhanced">("live");
  const [prompt, setPrompt] = useState("");
  const [snapshot, setSnapshot] = useState<string | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  // The photo as it came, under the canvas: a draft's small picture is taken from it when there is no lit one.
  const original = useRef<HTMLImageElement>(null);
  // Resolves when the canvas holds the finished picture for the current light (the processor shades a quick preview first).
  const settle = useRef<(() => Promise<void>) | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const imageBox = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const sweepFrame = useRef<number | null>(null);
  // Each light's Height on screen, for the handlers that change it between two renders. `exact` is where scrolling has got to before rounding to the slider's steps.
  const heightNow = useRef<Record<Which, { shown: number; exact: number }>>({
    key: { shown: START.height, exact: START.height },
    fill: { shown: FILL_START.height, exact: FILL_START.height },
  });
  // The light the pointer on the stage has hold of: the sun that was pressed, or the picked light when the press was beside them.
  const grabbed = useRef<Which>("key");
  // The fingers on the stage, where that light was before the first of them landed, and how a pinch started.
  const fingers = useRef(new Map<number, { x: number; y: number }>());
  const beforeTouch = useRef<{ which: Which; x: number; y: number; at: number } | null>(null);
  const pinch = useRef<{ which: Which; spread: number; height: number } | null>(null);
  // The backend's scene id for the sample on screen, once it has been asked for.
  const adopted = useRef<{ scene: RelightScene; id: Promise<string> } | null>(null);
  // The user's own photo on screen, as a draft.
  const own = useRef<OwnPhoto | null>(null);
  // What a draft is made from, as last drawn: read when one is saved from outside a render.
  const shown = useRef<(Omit<DraftContent, "scene"> & { photo: LoadedImage | null; scene: RelightScene | null; depthDevice: DepthDevice | null; depthText: string | null; drawn: boolean; lit: boolean }) | null>(null);

  const withBackendScene = useCallback<WithBackendScene>(async (scene, offlineMessage, call) => {
    // A scene the browser worked out is sent the same way. The backend analyses the photo again with detailed normals,
    // so its renders are a little more detailed than the live preview of such a scene.
    // So is a scene opened from a draft: the server that made it may have forgotten it since.
    if (!isSampleScene(scene) && !isLocalScene(scene) && !isDraftScene(scene)) return call(scene.scene_id);
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
  const server = useServerPreview(askServer, scene, light, shadows, fillLight, withBackendScene, onServerFail);
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
        // What stays on screen, and where it came from.
        const kept = scene === null ? "" : isLocalScene(scene) ? "The photo keeps the shape worked out in this browser." : isDraftScene(scene) ? "The draft keeps the geometry it was saved with." : "The sample keeps the geometry it came with.";
        if (keep) setError(`${errorMessage(e)} ${kept}`);
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

  // --- drafts: the user's own photos, kept on this device (lib/drafts.ts) ------------

  // The photo has been lit, or never will be here (canShade, below): from then on it is a draft.
  const drawn = scene !== null && (ready || localProblem !== null);
  const depthSaid = draftDepth !== null && draftDepth.scene === scene ? draftDepth.text : null;
  useEffect(() => {
    shown.current = {
      photo,
      scene,
      base,
      warmth,
      fill,
      picked: which,
      shadows,
      detail,
      depthDevice,
      depthText: depthSaid ?? (depthDevice ? depthDeviceText(depthDevice) : null),
      drawn,
      lit: showCanvas && ready,
    };
  });

  /**
   * Keep the photo on screen as a draft, if it is the user's own, has been lit
   * and is not already kept as it is now. The small picture is taken from the
   * canvas as it is at this moment, so this is called before a photo is taken
   * off the page, not after. `urgent`: the page itself is going away.
   */
  const keepDraft = useCallback((urgent = false) => {
    const mine = own.current;
    const now = shown.current;
    if (!mine || !now || mine.photo !== now.photo || now.scene === null || !now.drawn) return;
    const { scene, base, warmth, fill, picked, shadows, detail, depthDevice, depthText } = now;
    const before = mine.kept;
    if (before && before.scene === scene && before.base === base && before.warmth === warmth && before.fill === fill && before.picked === picked && before.shadows === shadows && before.detail === detail) return;
    const kept: DraftContent = { scene, base, warmth, fill, picked, shadows, detail };
    mine.kept = kept;
    // The lit picture. If there is none to be had (nothing on this device can shade), the photo itself.
    const lit = now.lit && canvas.current ? smallPicture(canvas.current, scene.width, scene.height) : null;
    const thumb = lit ?? (original.current ? smallPicture(original.current, scene.width, scene.height) : null) ?? "";
    const { name, createdAt } = mine;
    const updatedAt = Date.now();
    void mine.id
      // The maps are only written when they are new: moving the light writes the small record alone.
      .then((id) =>
        saveDraft(
          { id, name, createdAt, updatedAt, light: base, warmth, fill: fill && { on: fill.on, ...fill.base, warmth: fill.warmth }, picked, shadows, detail, depthDevice, depthText, thumb },
          before?.scene === scene ? null : scene,
          urgent,
        ),
      )
      .then((saved) => {
        // Not kept: the next change sends the whole draft again.
        if (!saved && mine.kept === kept) mine.kept = null;
      });
  }, []);

  // A draft is made as soon as the user's own photo is first lit, and brought up to date a moment after the light or a switch was last touched.
  useEffect(() => {
    const mine = own.current;
    if (!mine || mine.photo !== photo || scene === null || !drawn) return;
    let stale = false;
    const timer = setTimeout(
      async () => {
        mine.begun = scene;
        await settle.current?.(); // not the quick preview
        if (!stale) keepDraft();
      },
      mine.begun === scene ? DRAFT_SAVE_MS : 0,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [photo, scene, drawn, base, warmth, fill, which, shadows, detail, keepDraft]);

  // The page is being closed, reloaded or put in the background: keep the draft now, as far as a browser lets a page that is going away do anything. Nothing waits for it.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") keepDraft(true);
    };
    const onLeave = () => keepDraft(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onLeave);
    };
  }, [keepDraft]);

  /** A photo of the user's own, from the drop box. It becomes a draft once it has been lit; if the same picture is one already, it takes that draft's place. */
  const loadOwn = (image: LoadedImage) => {
    own.current = { photo: image, id: fingerprint(image.base64), name: draftName(image.name), createdAt: Date.now(), kept: null, begun: null };
    void load(image, detail);
  };

  /** A draft: the photo, its maps and the light as they were left. All of it is read from this device: nothing is worked out again and no server is asked. */
  const openDraft = async (draft: Draft) => {
    const id = ++request.current;
    setPicking(draft.id);
    setSampleError(null);
    setDraftNote(null);
    const result = await readDraftScene(draft.id);
    if (request.current !== id) return;
    setPicking(null);
    if (!result) {
      setDraftNote(DRAFT_UNREADABLE);
      return;
    }
    const image: LoadedImage = { base64: result.image, mime: sniffMime(result.image) === "image/jpeg" ? "image/jpeg" : "image/png", width: result.width, height: result.height, name: draft.name };
    // Kept inside what the controls can show, whatever the record says.
    const light: LightBase = {
      x: clamp(draft.light.x, -OUTSIDE, 1 + OUTSIDE),
      y: clamp(draft.light.y, -OUTSIDE, 1 + OUTSIDE),
      height: clamp(draft.light.height, HEIGHT_MIN, HEIGHT_MAX),
      intensity: clamp(draft.light.intensity, 0, 4),
      ambient: clamp(draft.light.ambient, 0, 1),
      shine: clamp(draft.light.shine, 0, 1),
    };
    const colour = clamp(draft.warmth, -1, 1);
    // The fill light as it was left, switched on or off. A draft from before there was one has none, and opens with it off.
    const filling: FillState | null = draft.fill && {
      on: draft.fill.on,
      base: {
        x: clamp(draft.fill.x, -OUTSIDE, 1 + OUTSIDE),
        y: clamp(draft.fill.y, -OUTSIDE, 1 + OUTSIDE),
        height: clamp(draft.fill.height, HEIGHT_MIN, HEIGHT_MAX),
        intensity: clamp(draft.fill.intensity, 0, 4),
      },
      warmth: clamp(draft.fill.warmth, -1, 1),
    };
    const on: Which = draft.picked === "fill" && filling?.on ? "fill" : "key";
    // As kept already: opening a draft does not count as changing it.
    own.current = {
      photo: image,
      id: Promise.resolve(draft.id),
      name: draft.name,
      createdAt: draft.createdAt,
      kept: { scene: result, base: light, warmth: colour, fill: filling, picked: on, shadows: draft.shadows, detail: draft.detail },
      begun: result,
    };
    clearResults();
    setPhoto(image);
    resetShading();
    setDetail(draft.detail);
    setDepthDevice(draft.depthDevice);
    setDraftDepth(draft.depthText === null ? null : { scene: result, text: draft.depthText });
    setBase(light);
    setWarmth(colour);
    setFill(filling);
    setPicked(on);
    setShadows(draft.shadows);
    setScene(result);
  };

  const startOver = () => {
    // While the lit picture is still on the page.
    keepDraft();
    own.current = null;
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
    setDraftNote(null);
    // A new photo starts clean: nothing set for the last one carries over.
    setBase(START);
    setWarmth(0);
    setFill(null);
    setPicked("key");
    setShadows(true);
    setDetail(true);
    setPrompt("");
    setTab("live");
    setSnapshot(null);
    enhance.reset();
  };

  // The logo in the top bar (lib/home.ts): the first page as it is on arrival, in place. Whatever was going on is abandoned the way New photo abandons it.
  const showFirstPage = useEffectEvent(() => {
    startOver();
    setStartTab("samples");
    window.scrollTo(0, 0);
  });
  useEffect(() => {
    const onHome = (event: Event) => {
      // "Done here": the logo's link is not followed, so nothing is loaded again.
      event.preventDefault();
      showFirstPage();
    };
    window.addEventListener(HOME_EVENT, onHome);
    return () => window.removeEventListener(HOME_EVENT, onHome);
  }, []);

  // --- the two lights -------------------------------------------------------------

  /** Change a light's own numbers: the key's, or the fill's. */
  const change = useCallback((of: Which, part: Partial<FillState["base"]>) => {
    if (of === "fill") setFill((f) => f && { ...f, base: { ...f.base, ...part } });
    else setBase((b) => ({ ...b, ...part }));
  }, []);

  /**
   * The fill light's switch. The first time on, it starts across the photo from
   * where the key is at that moment, weaker and further back (FILL_START), in
   * plain white. After that it comes back as it was left. Off, the panel goes
   * back to the key, the only light there is then.
   */
  const switchFill = (on: boolean) => {
    setFill((f) => (f ? { ...f, on } : { on, base: { x: round(1 - base.x), y: base.y, ...FILL_START }, warmth: 0 }));
    if (!on) setPicked("key");
  };

  /** Key or Fill in the LIGHT panel. Asking for the fill while it is off switches it on. */
  const pickLight = (next: Which) => {
    if (next === "fill" && !fill?.on) switchFill(true);
    setPicked(next);
  };

  // --- dragging the light ---------------------------------------------------------

  const dragTo = (event: ReactPointerEvent) => {
    const box = imageBox.current?.getBoundingClientRect();
    const bounds = surface.current?.getBoundingClientRect();
    if (!box || !bounds || box.width === 0) return;
    // The handle may leave the photo but not the stage.
    const marginX = handleMarginX(bounds);
    const cx = clamp(event.clientX, bounds.left + marginX, bounds.right - marginX);
    const cy = clamp(event.clientY, bounds.top + HANDLE_MARGIN_Y_PX, bounds.bottom - HANDLE_MARGIN_Y_PX);
    const x = round(clamp((cx - box.left) / box.width, -OUTSIDE, 1 + OUTSIDE));
    const y = round(clamp((cy - box.top) / box.height, -OUTSIDE, 1 + OUTSIDE));
    change(grabbed.current, { x, y });
  };

  // --- the light's distance: scrolling and pinching on the sun ------------------------

  const fillHeight = fill?.base.height;
  useEffect(() => {
    // The slider, a preset or Reset moved it: scrolling carries on from there.
    const now = heightNow.current;
    if (now.key.shown !== base.height) now.key = { shown: base.height, exact: base.height };
    if (fillHeight !== undefined && now.fill.shown !== fillHeight) now.fill = { shown: fillHeight, exact: fillHeight };
  }, [base.height, fillHeight]);

  /** Set a light's Height from a scroll, a pinch or a key: kept inside the slider's range and on its steps, so the two always agree. */
  const setHeight = useCallback(
    (of: Which, exact: number) => {
      const next = clamp(exact, HEIGHT_MIN, HEIGHT_MAX);
      const height = round(next, 2);
      const changed = height !== heightNow.current[of].shown;
      heightNow.current[of] = { shown: height, exact: next };
      if (changed) change(of, { height });
      if (changed) setHeightUsed(true);
    },
    [change],
  );

  /** The wheel over a sun (LightSun): that light comes nearer or goes back, and is the one the panel is on from then. */
  const scrollHeight = (of: Which, step: number) => {
    setHeight(of, heightNow.current[of].exact * Math.exp(-step * WHEEL_HEIGHT_PER_PX));
    setPicked(of);
  };

  /** The + and - keys: one step nearer (1) or further (-1). Always at least one step of the slider, so no press is lost at the low end. */
  const stepHeight = (of: Which, direction: 1 | -1) => {
    const now = heightNow.current[of].shown;
    const next = round(now * KEY_HEIGHT_RATIO ** direction, 2);
    setHeight(of, next === now ? now + 0.01 * direction : next);
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
      y: round(clamp(y, (bounds.top + HANDLE_MARGIN_Y_PX - box.top) / box.height, (bounds.bottom - HANDLE_MARGIN_Y_PX - box.top) / box.height)),
    };
  };

  const nudge = (of: Which, dx: number, dy: number) => {
    stopSweep();
    const at = of === "fill" && fill ? fill.base : base;
    const p = insideStage(clamp(at.x + dx, -OUTSIDE, 1 + OUTSIDE), clamp(at.y + dy, -OUTSIDE, 1 + OUTSIDE));
    // A preset may have left the light past the stage's edge: a step further out leaves it there, it is not pulled back to the edge.
    const x = dx > 0 ? Math.max(p.x, at.x) : dx < 0 ? Math.min(p.x, at.x) : at.x;
    const y = dy > 0 ? Math.max(p.y, at.y) : dy < 0 ? Math.min(p.y, at.y) : at.y;
    change(of, { x, y });
  };

  /** The keys on a sun: the arrows move that light, plus and minus bring it nearer or push it back. It is the one the panel is on from then. */
  const onSunKey = (of: Which, e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    // With Ctrl or Cmd these two zoom the page: left to the browser.
    if (!e.ctrlKey && !e.metaKey && (e.key === "+" || e.key === "=")) stepHeight(of, 1);
    else if (!e.ctrlKey && !e.metaKey && (e.key === "-" || e.key === "_")) stepHeight(of, -1);
    else if (e.key === "ArrowLeft") nudge(of, -step, 0);
    else if (e.key === "ArrowRight") nudge(of, step, 0);
    else if (e.key === "ArrowUp") nudge(of, 0, -step);
    else if (e.key === "ArrowDown") nudge(of, 0, step);
    else return;
    e.preventDefault();
    setPicked(of);
  };

  /**
   * Carry the light once around the subject and hand it back where it was.
   * For recording a demo; any deliberate move of the light ends it early.
   * It is the key that travels: the fill light stays where it is.
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
    const result = await enhance.run(() => withBackendScene(scene, ENHANCE_OFFLINE, (scene_id) => relightEnhance({ scene_id, light, shadows, fill: fillLight ?? undefined, prompt: prompt.trim() })));
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
          onImage={loadOwn}
          title="Drop a photo here"
          footer={
            <>
              {BROWSER_ONLY && <p className="mt-3 text-sm leading-5 text-zinc-400">{BROWSER_PRIVACY_NOTE}</p>}
              <StartTabs tab={startTab} onTab={setStartTab} samples={samples} drafts={drafts} opening={picking} onOpen={(draft) => void openDraft(draft)} note={draftNote} />
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
  // The light the LIGHT panel's own sliders show and change, and that light's Colour slider.
  const edited: FillLight = which === "fill" && fillLight ? fillLight : light;
  const editedWarmth = which === "fill" && fill ? fill.warmth : warmth;
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
            // Above the panels after it: a "?" box near the bottom of this one hangs down over them, and each panel is a layer of its own (backdrop-blur).
            className="relative z-10"
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
            <div className={cn("flex flex-col gap-3", LIGHT_ROW_GAPS, !canLight && "pointer-events-none opacity-50")} inert={!canLight}>
              {/* The fill light's switch, and which of the two lights the readout and the sliders below are on. The row is what the "?" box is laid out against, so the box is as wide as the panel. */}
              {/* In a short window beside the stage it is drawn closer to the heading above and the readout below: the sidebar was fitted to a 1280 x 720 window before this row was added, and has that much room and no more. */}
              <div className="relative flex items-center justify-between gap-2 lg:short:-mb-1 lg:short:-mt-1.5">
                <Segmented
                  label="Light to change"
                  low
                  value={which}
                  onChange={pickLight}
                  options={[
                    { value: "key", label: "Key" },
                    { value: "fill", label: "Fill" },
                  ]}
                />
                <span className="flex items-center gap-1.5">
                  <label htmlFor={fillSwitch} className="cursor-pointer text-[13px] font-medium text-zinc-200">
                    Fill light
                  </label>
                  <Help about="Fill light">{FILL_HELP}</Help>
                  <Switch id={fillSwitch} label="Fill light" checked={fillLight !== null} onChange={switchFill} />
                </span>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-black/30 px-3 py-1.5 font-mono text-xs tabular-nums text-zinc-400">
                <span>
                  x <span className="text-zinc-100">{edited.x.toFixed(2)}</span>
                </span>
                <span>
                  y <span className="text-zinc-100">{edited.y.toFixed(2)}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  colour <span className="h-3 w-3 rounded-full ring-1 ring-white/30" style={{ background: cssColor(edited.color) }} />
                </span>
              </div>
              <Slider
                label="Height"
                value={edited.height}
                min={HEIGHT_MIN}
                max={HEIGHT_MAX}
                step={0.01}
                onChange={(v) => {
                  change(which, { height: v });
                  setHeightUsed(true);
                }}
                hint={HEIGHT_HINT}
                ends={HEIGHT_ENDS}
                help={HEIGHT_HELP}
                helpNow={heightUsed}
              />
              <Slider label="Intensity" value={edited.intensity} min={0} max={4} step={0.05} onChange={(v) => change(which, { intensity: v })} help={INTENSITY_HELP} />
              {/* Ambient and Shine, the two sliders Key and Fill do not switch between, share a row beside the stage: the sidebar was fitted to a */}
              {/* 1280 x 720 window and has no room for one more row (1 px to spare in the demo). The row is what their "?" boxes are laid out against. */}
              {/* Ambient's side is the wider, for its longer name. A stacked page, which scrolls anyway, has them one under the other. */}
              <div className="relative grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-y-0">
                <Slider
                  label="Ambient"
                  value={base.ambient}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(v) => setBase((b) => ({ ...b, ambient: v }))}
                  hint={AMBIENT_HINT}
                  help={AMBIENT_HELP}
                  note={fillLight ? BOTH_LIGHTS : undefined}
                  paired
                />
                <Slider
                  label="Shine"
                  value={base.shine}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => setBase((b) => ({ ...b, shine: v }))}
                  hint={SHINE_HINT}
                  help={SHINE_HELP}
                  note={fillLight ? BOTH_LIGHTS : undefined}
                  paired
                />
                {/* Where a laptop window has room for lines under the sliders, Ambient keeps the one it had, across the row. */}
                <span className="col-span-2 mt-1.5 hidden text-xs leading-4 text-zinc-500 lg:tall:block">{AMBIENT_HINT}</span>
              </div>
              <Slider
                label="Colour"
                value={editedWarmth}
                min={-1}
                max={1}
                step={0.02}
                onChange={(v) => (which === "fill" ? setFill((f) => f && { ...f, warmth: v }) : setWarmth(v))}
                format={(v) => (Math.abs(v) < 0.02 ? "neutral" : v > 0 ? `warm ${Math.round(v * 100)}` : `cool ${Math.round(-v * 100)}`)}
                track={`linear-gradient(to right, ${cssColor(COOL)}, #ffffff, ${cssColor(WARM)})`}
                help={COLOUR_HELP}
                typed={{
                  text: (v) => String(Math.round(v * 100)),
                  parse: (text) => {
                    const hundredths = Number.parseFloat(text.trim().replace(",", "."));
                    return Number.isFinite(hundredths) ? hundredths / 100 : null;
                  },
                }}
              />
              <Toggle
                label="Cast shadows"
                hint="Objects block the light."
                checked={shadows}
                onChange={setShadows}
                help={
                  fillLight ? (
                    <>
                      {SHADOWS_HELP}
                      {SHADOWS_HELP_WITH_FILL}
                    </>
                  ) : (
                    SHADOWS_HELP
                  )
                }
                note={fillLight ? BOTH_LIGHTS : undefined}
              />
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
                      // A preset is the key's: the fill light stays as it is.
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
                  title={
                    fillLight
                      ? "Puts the light, its colour and Cast shadows back to how they started, and switches the fill light off. The photo and the Enhance text are left alone."
                      : "Puts the light, its colour and Cast shadows back to how they started. The photo and the Enhance text are left alone."
                  }
                  onClick={() => {
                    stopSweep();
                    setBase(START);
                    setWarmth(0);
                    setShadows(true);
                    // As the page starts: no fill light, and none remembered. Switched on again it is placed afresh, across from the key.
                    setFill(null);
                    setPicked("key");
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
                  // A sample, a photo analysed in the browser, or one opened from a draft, already works without the backend: keep it on screen unless the new analysis succeeds.
                  const keep = sampleScene || localShape || (scene !== null && isDraftScene(scene));
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
                    depth: this browser, {depthSaid ?? depthDeviceText(depthDevice)}
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
              // A second finger: from here the two set the light's distance, and neither drags it. The light is the one the first finger took.
              const before = beforeTouch.current;
              if (before && e.timeStamp - before.at < PINCH_GRACE_MS) change(before.which, { x: before.x, y: before.y });
              pinch.current = { which: grabbed.current, spread: fingerSpread(), height: heightNow.current[grabbed.current].shown };
              return;
            }
            if (fingers.current.size > 2) return;
            stopSweep(); // the user has taken the light
            // A press on a sun takes that light, and the panel goes to it. A press anywhere else moves the light the panel is on.
            const pressed = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-light]")?.dataset.light : undefined;
            const taken: Which = pressed === "key" ? "key" : pressed === "fill" && fill?.on ? "fill" : which;
            const at = taken === "fill" && fill ? fill.base : base;
            grabbed.current = taken;
            setPicked(taken);
            beforeTouch.current = { which: taken, x: at.x, y: at.y, at: e.timeStamp };
            setDragging(true);
            dragTo(e);
          }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            if (fingers.current.has(e.pointerId)) fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            // Spreading the fingers brings the light nearer, pinching pushes it back. Once a pinch has begun, a finger left on the screen does not drag.
            if (pinch.current) {
              if (fingers.current.size >= 2) setHeight(pinch.current.which, pinch.current.height * (fingerSpread() / pinch.current.spread) ** PINCH_POWER);
            } else dragTo(e);
          }}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          {/* The margins round the photo. .light-handle (globals.css) reads the two variables to know where the stage ends. */}
          <div className="absolute inset-x-(--stage-inset-x) inset-y-(--stage-inset-y) [--stage-inset-x:1.5rem] [--stage-inset-y:4rem] sm:[--stage-inset-x:3.5rem]">
            {/* Live preview. Stays mounted behind the Enhanced tab so the scene it has loaded survives. */}
            <div className={cn("absolute inset-0", !live && "invisible")}>
              <FitBox width={width} height={height} raise={canLight}>
                <div ref={imageBox} className="absolute inset-0 overflow-hidden rounded-lg bg-black shadow-2xl ring-1 ring-white/10">
                  <img ref={original} src={photoUrl} alt="Original photo" draggable={false} className={cn("absolute inset-0 h-full w-full", failed && "opacity-30 grayscale")} />
                  {scene && showCanvas && (
                    <RelightCanvas
                      scene={scene}
                      light={light}
                      shadows={shadows}
                      fill={fillLight}
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

                {/* While the fill light is off there is one sun, as there always was. While it is on there are two, each with its letter, and the one the panel is on lies on top. */}
                {canLight && (
                  <LightSun
                    which="key"
                    light={light}
                    letter={fillLight ? "K" : null}
                    onTop={which === "key"}
                    dragging={dragging && which === "key"}
                    name={fillLight ? "Key light position" : "Light position"}
                    photoRatio={width / height}
                    marginX={sunMarginX}
                    onScroll={(step) => scrollHeight("key", step)}
                    onKeyDown={(e) => onSunKey("key", e)}
                  />
                )}
                {canLight && fillLight && (
                  <LightSun
                    which="fill"
                    light={fillLight}
                    letter="F"
                    onTop={which === "fill"}
                    dragging={dragging && which === "fill"}
                    name="Fill light position"
                    photoRatio={width / height}
                    marginX={sunMarginX}
                    onScroll={(step) => scrollHeight("fill", step)}
                    onKeyDown={(e) => onSunKey("fill", e)}
                  />
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
