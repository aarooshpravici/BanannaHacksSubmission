"use client";

import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { BeforeAfter } from "@/components/BeforeAfter";
import { ErrorBanner } from "@/components/ErrorBanner";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Help } from "@/components/Help";
import { FitBox, PageIntro, Panel, Stage, Workspace } from "@/components/Panel";
import { BusyLabel, BusyOverlay } from "@/components/Spinner";
import { UploadDropzone } from "@/components/UploadDropzone";
import { AlertIcon, DownloadIcon, EyeIcon, OrbitIcon, SparklesIcon, SunIcon, UploadIcon } from "@/components/icons";
import { RelightCanvas, type ShadingPath } from "@/components/relight/RelightCanvas";
import { ShadingNote } from "@/components/relight/ShadingNote";
import { type StartTab, StartTabs } from "@/components/relight/StartTabs";
import { Button, Segmented, Slider, Switch, Toggle } from "@/components/ui";
import { ApiError, errorMessage, isAbort, relightAdoptScene, relightEnhance, relightRender, relightScene } from "@/lib/api";
import { cn } from "@/lib/cn";
import { API_URL, DEMO, MOCK } from "@/lib/config";
import { type Draft, draftName, fingerprint, isDraftScene, readDraftScene, saveDraft, smallPicture, useDrafts } from "@/lib/drafts";
import { HOME_EVENT } from "@/lib/home";
import { type LoadedImage, downloadBase64AsPng, downloadCanvas, sniffMime, toDataUrl } from "@/lib/image";
import { type DepthDevice, type LocalProgress, depthDeviceText, isLocalScene, localScene, progressText } from "@/lib/localScene";
import { SAMPLES, type SamplePhoto, isSampleScene, loadSampleScene, sampleThumbUrl } from "@/lib/samples";
import type { FillLight, Light, RelightRender, RelightScene } from "@/lib/types";
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
/** Under every slider's "?": its number can be typed as well as dragged. */
const TYPE_IT = <span className="block text-zinc-500">Click the number on the right to type an exact value.</span>;
/** Height spelt out, behind the "?" beside its name: beside the stage a laptop window has no room for HEIGHT_HINT, and a tester who lit an outdoor photo of his own from low down found the result odd and nothing to say why. It opens by itself the first time the Height is changed by hand (heightUsed). */
const HEIGHT_HELP = (
  <>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Height</strong> is how far the light floats in front of the photo.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Low</strong>: the light skims across the surface. One side goes bright, shadows stretch, and every bump in the estimated shape shows. On a photo of your own, outdoors above all, that can look odd.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">High</strong>: the light faces the photo. The whole frame is lit evenly, shadows are short, and near and far things differ less.
    </span>
    <span className="block text-zinc-500">Scrolling or pinching on the sun changes it too. Click the number on the right to type an exact value.</span>
  </>
);
/** The other settings of the LIGHT panel, behind their own "?". What each says follows the shading itself: brightness = Ambient + Intensity x the light that reaches a surface. */
const INTENSITY_HELP = (
  <>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Intensity</strong> is how strong the light is.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Higher</strong>: the lit side gets brighter and stands out more against the dark side.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">At 0</strong> the light is off, and only the Ambient light is left.
    </span>
    {TYPE_IT}
  </>
);
const AMBIENT_HELP = (
  <>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Ambient</strong> is even light that reaches everything, shadows included, like daylight filling a room.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Low</strong>: the side away from the light stays dark. Dramatic, but detail is lost there.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Higher</strong>: the shadows lift and the picture softens towards the original photo. For a gentle look on a face, try 0.3 to 0.6 with a lower Intensity.
    </span>
    {TYPE_IT}
  </>
);
const COLOUR_HELP = (
  <>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Colour</strong> is the colour of the light.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Left</strong> is cool and bluish, like shade or a screen. <strong className="font-semibold text-zinc-100">The middle</strong> is plain white. <strong className="font-semibold text-zinc-100">Right</strong> is warm and orange, like a lamp or a low sun.
    </span>
    <span className="block text-zinc-500">Click the words on the right to type a number: -100 is the coolest, 0 is neutral, 100 the warmest.</span>
  </>
);
const SHADOWS_HELP = (
  <>
    <span className="block">
      <strong className="font-semibold text-zinc-100">On</strong>: things block the light and throw shadows on whatever is behind them, as a nose does on a cheek.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Off</strong>: every surface is still brighter or darker by the way it faces, but nothing throws a shadow.
    </span>
    <span className="block">Behind something that stands in front of open sky, a thrown shadow shows as a soft dark band on the sky. Switch this off and the band goes.</span>
  </>
);
/** Added to SHADOWS_HELP while the fill light is on: the one switch is for the picture, and the picture's shadows are the key's. */
const SHADOWS_HELP_WITH_FILL = <span className="block">Only the key light throws shadows. The fill light never does.</span>;
/** The fill light, behind the "?" beside its switch. */
const FILL_HELP = (
  <>
    <span className="block">
      A <strong className="font-semibold text-zinc-100">fill light</strong> is a second, weaker light, usually on the side opposite the main one, which is called the key. It lifts the shadows the key leaves.
    </span>
    <span className="block">
      <strong className="font-semibold text-zinc-100">Ambient</strong> lifts everything evenly, which flattens the picture. A fill has a direction, so shapes keep their roundness.
    </span>
    <span className="block">It casts no shadows of its own.</span>
    <span className="block text-zinc-500">Each light has its own sun on the photo, marked K and F. Key and Fill, on the left, choose which one Height, Intensity and Colour change.</span>
  </>
);
/** Beside Ambient and Cast shadows while the fill light is on: the two settings that Key and Fill do not switch between. */
const BOTH_LIGHTS = "both lights";
/**
 * The space between the LIGHT panel's rows where the sidebar is beside the stage. The Key | Fill row is one row more than the sidebar was fitted to.
 * The demo has the height for it (its ENHANCE panel is shorter), so it keeps the spacing it had. With a backend the rows sit closer in a window under 874px
 * (2px each under 771px, 4px each from there up), which gives back most of what the new row takes: LIGHT, ENHANCE and the folded GEOMETRY row fit again
 * at 1280 x 720 and from 719px up, except in the few pixels above each step of the layout (771 to 784 and 832 to 842, and 709 to 718), where the sidebar
 * scrolls by up to 14px and did not before the row.
 */
const LIGHT_ROW_GAPS = DEMO ? "lg:short:gap-2" : "lg:short:gap-1.5 lg:[@media(min-height:771px)_and_(max-height:873px)]:gap-2";

const WARM: [number, number, number] = [1.0, 0.86, 0.68];
const COOL: [number, number, number] = [0.7, 0.86, 1.0];

type LightBase = Omit<Light, "color">;

/** The page's two lights: the key, which is the light it always had, and the fill. */
type Which = "key" | "fill";

/**
 * The fill light as the page holds it, from the first time it is switched on:
 * its switch, its own place, Height and Intensity, and its own Colour slider.
 * Switched off it keeps its numbers, for the next time. It has no Ambient:
 * that is shared, and is the key's.
 */
interface FillState {
  on: boolean;
  base: Omit<LightBase, "ambient">;
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
function useServerPreview(enabled: boolean, scene: RelightScene | null, light: Light, shadows: boolean, fill: FillLight | null, withBackendScene: WithBackendScene, onFail: () => void) {
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
        // With the fill off the request is, to the letter, what it was before there was one.
        const render = await withBackendScene(scene, SERVER_RENDER_OFFLINE, (scene_id) => relightRender({ scene_id, light, shadows, fill: fill ?? undefined }, controller.signal));
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
  }, [enabled, scene, light, shadows, fill, withBackendScene, onFail, attempt]);
  // The last render outlives a change of photo: never show or export it over another scene.
  const image = enabled && scene && state.sceneId === scene.scene_id ? state.image : null;
  return { image, error: enabled ? state.error : null, retry };
}

/** One light's sun on the photo: the key's, and beside it the fill's while the fill light is on. */
function LightSun({
  which,
  light,
  letter,
  onTop,
  dragging,
  name,
  photoRatio,
  marginX,
  onScroll,
  onKeyDown,
}: {
  /** The light it stands for. The stage reads this off the sun that was pressed. */
  which: Which;
  /** Where that light is, how high, how strong and what colour. */
  light: FillLight;
  /** A small letter on the disc, K or F, while there are two suns to tell apart. Null while the key's is the only one, which then looks exactly as it did before there was a fill light. */
  letter: string | null;
  /** Drawn above the other sun: the light the LIGHT panel is on, so it is the one a press reaches where the two overlap. */
  onTop: boolean;
  dragging: boolean;
  /** For a screen reader, ahead of the numbers. */
  name: string;
  /** The photo's width over its height. */
  photoRatio: number;
  /** How close the drawn sun may come to the stage's sides (handleMarginX). */
  marginX: number;
  /** The wheel was turned over this sun, by this many pixels of scroll. */
  onScroll: (step: number) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  // The sun, once it is on the page: scrolling over it needs a listener of its own (below).
  const [handle, setHandle] = useState<HTMLButtonElement | null>(null);
  const scrolled = useEffectEvent(onScroll);

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
      if (step !== 0) scrolled(step);
    };
    handle.addEventListener("wheel", onWheel, { passive: false });
    return () => handle.removeEventListener("wheel", onWheel);
  }, [handle]);

  // How the sun is drawn at this Height (see SUN_SCALE).
  const lift = heightShare(light.height);
  const sunPx = HANDLE_PX * between(SUN_SCALE, lift);
  const glowReachPx = between(SUN_GLOW_REACH_PX, lift);
  // The shadow stays under the disc until the light is well off the surface, then falls away quickly.
  const sunShadow = `0 ${between(SUN_SHADOW_DROP_PX, lift * lift).toFixed(1)}px ${between(SUN_SHADOW_BLUR_PX, lift).toFixed(1)}px rgb(0 0 0 / ${between(SUN_SHADOW_ALPHA, lift).toFixed(2)})`;
  // The fill's sun is a ring in the fill's colour with the photo showing through it, where the key's is a full disc: the two are told apart before either letter is read.
  const hollow = which === "fill";
  return (
    <button
      ref={setHandle}
      type="button"
      aria-label={`${name}, x ${light.x.toFixed(2)}, y ${light.y.toFixed(2)}, height ${light.height.toFixed(2)}. Use the arrow keys to move, and plus or minus to bring the light nearer or push it back.`}
      data-light={which}
      data-height={light.height.toFixed(2)}
      onKeyDown={onKeyDown}
      className={cn(
        `light-handle group absolute ${onTop ? "z-10" : "z-9"} -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/80`,
        dragging ? "cursor-grabbing" : "cursor-grab",
      )}
      style={
        {
          // As large as the disc, and never smaller than the 40 px that is easy to grab.
          width: Math.max(HANDLE_PX, sunPx),
          height: Math.max(HANDLE_PX, sunPx),
          "--light-x": light.x,
          "--light-y": light.y,
          "--photo-ratio": photoRatio,
          "--handle-margin": `${HANDLE_MARGIN_PX}px`,
          "--handle-margin-x": `${marginX}px`,
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
          "pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2",
          hollow ? "bg-black/25" : "border-white text-black/75",
          "transition-[scale,width,height,box-shadow] motion-reduce:transition-none",
          dragging && "scale-110",
        )}
        style={
          hollow
            ? // A dark hairline on each side of the ring keeps a pale ring in sight on a pale part of the photo.
              { width: sunPx, height: sunPx, boxShadow: `${sunShadow}, 0 0 0 1px rgb(0 0 0 / 0.6), inset 0 0 0 1px rgb(0 0 0 / 0.6)`, borderColor: cssColor(light.color) }
            : { width: sunPx, height: sunPx, boxShadow: sunShadow, background: cssColor(light.color) }
        }
      >
        {/* Marked important: the icon's own default size is set the same way, and which class wins otherwise is down to the stylesheet's order. */}
        {!hollow && <SunIcon className="h-1/2! w-1/2!" />}
        {/* On the disc's rim, lower right, whatever its size: 85.4% is the middle plus cos 45 degrees of the radius. */}
        {letter && (
          <span data-letter className="absolute left-[85.4%] top-[85.4%] flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/85 text-[10px] font-bold leading-none text-white ring-1 ring-white/70">
            {letter}
          </span>
        )}
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
  );
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
    const cy = clamp(event.clientY, bounds.top + HANDLE_MARGIN_PX, bounds.bottom - HANDLE_MARGIN_PX);
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
      y: round(clamp(y, (bounds.top + HANDLE_MARGIN_PX - box.top) / box.height, (bounds.bottom - HANDLE_MARGIN_PX - box.top) / box.height)),
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
              <Slider
                label="Ambient"
                value={base.ambient}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setBase((b) => ({ ...b, ambient: v }))}
                hint="Light that reaches everything, shadows included."
                help={AMBIENT_HELP}
                note={fillLight ? BOTH_LIGHTS : undefined}
              />
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
