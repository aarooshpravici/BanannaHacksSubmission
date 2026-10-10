"use client";

import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BeforeAfter } from "@/components/BeforeAfter";
import { ErrorBanner } from "@/components/ErrorBanner";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { FitBox, PageIntro, Panel, Stage, Workspace } from "@/components/Panel";
import { BusyLabel, BusyOverlay } from "@/components/Spinner";
import { UploadDropzone } from "@/components/UploadDropzone";
import { AlertIcon, DownloadIcon, EyeIcon, OrbitIcon, SparklesIcon, SunIcon, UploadIcon } from "@/components/icons";
import { RelightCanvas } from "@/components/relight/RelightCanvas";
import { Button, Segmented, Slider, Toggle } from "@/components/ui";
import { ApiError, errorMessage, isAbort, relightAdoptScene, relightEnhance, relightRender, relightScene } from "@/lib/api";
import { cn } from "@/lib/cn";
import { API_URL } from "@/lib/config";
import { type LoadedImage, downloadBase64AsPng, downloadCanvas, toDataUrl } from "@/lib/image";
import { SAMPLES, type SamplePhoto, isSampleScene, loadSampleScene, sampleThumbUrl } from "@/lib/samples";
import type { Light, RelightRender, RelightScene } from "@/lib/types";
import { useJob } from "@/lib/useJob";

/** How far outside the photo the light may be dragged, in image widths/heights. */
const OUTSIDE = 0.5;
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
/** Sweep: the share of the time spent gliding from the user's light onto the orbit, and again back to it, so nothing jumps. */
const SWEEP_BLEND = 0.15;

/** Enhance and server renders, for a built-in sample with no backend to send it to. */
const ENHANCE_OFFLINE = `Enhance needs the backend, which cannot be reached at ${API_URL}. The live preview and Export PNG still work without it.`;
const ENHANCE_HINT = "A photoreal pass over this lighting. Takes a few seconds.";
const SERVER_RENDER_OFFLINE = `This browser cannot shade the photo itself, so it needs the backend, which cannot be reached at ${API_URL}.`;

const PRESETS: { label: string; light: Partial<LightBase>; warmth?: number }[] = [
  { label: "Left", light: { x: -0.1, y: 0.4, height: 0.35, intensity: 1.3 } },
  { label: "Right", light: { x: 1.1, y: 0.4, height: 0.35, intensity: 1.3 } },
  { label: "Top", light: { x: 0.5, y: -0.15, height: 0.35, intensity: 1.3 } },
  { label: "Low and warm", light: { x: 0.0, y: 0.9, height: 0.12, intensity: 1.6, ambient: 0.2 }, warmth: 1 },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, digits = 3) => Number(v.toFixed(digits));
const smoothstep = (t: number) => t * t * (3 - 2 * t);

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
 * Fallback for browsers without WebGL2: ask the server to render each light
 * position (debounced), instead of shading in the browser.
 */
function useServerPreview(enabled: boolean, scene: RelightScene | null, light: Light, shadows: boolean, withBackendScene: WithBackendScene) {
  const [state, setState] = useState<{ sceneId: string | null; image: string | null; error: string | null }>({ sceneId: null, image: null, error: null });
  useEffect(() => {
    if (!enabled || !scene) return;
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const render = await withBackendScene(scene, SERVER_RENDER_OFFLINE, (scene_id) => relightRender({ scene_id, light, shadows }, controller.signal));
        if (!cancelled) setState({ sceneId: scene.scene_id, image: render.image, error: null });
      } catch (error) {
        if (!cancelled && !isAbort(error)) setState((s) => ({ ...s, error: errorMessage(error) }));
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, scene, light, shadows, withBackendScene]);
  // The last render outlives a change of photo: never show or export it over another scene.
  return enabled && scene && state.sceneId === scene.scene_id ? state : { ...state, image: null };
}

export default function RelightPage() {
  const [photo, setPhoto] = useState<LoadedImage | null>(null);
  const [scene, setScene] = useState<RelightScene | null>(null);
  const [detail, setDetail] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The scene request failed and there is nothing to shade: shown on the photo itself, not as a banner.
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null); // sample being fetched
  const [sampleError, setSampleError] = useState<string | null>(null);

  const [base, setBase] = useState<LightBase>(START);
  const [warmth, setWarmth] = useState(0);
  const [shadows, setShadows] = useState(true);
  const light = useMemo<Light>(() => ({ ...base, color: warmthToColor(warmth) }), [base, warmth]);

  const [ready, setReady] = useState(false); // first GPU frame is on screen
  const [gpuProblem, setGpuProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [tab, setTab] = useState<"live" | "enhanced">("live");
  const [prompt, setPrompt] = useState("");
  const [snapshot, setSnapshot] = useState<string | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const imageBox = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const sweepFrame = useRef<number | null>(null);
  // The backend's scene id for the sample on screen, once it has been asked for.
  const adopted = useRef<{ scene: RelightScene; id: Promise<string> } | null>(null);

  const withBackendScene = useCallback<WithBackendScene>(async (scene, offlineMessage, call) => {
    if (!isSampleScene(scene)) return call(scene.scene_id);
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
  const server = useServerPreview(gpuProblem !== null, scene, light, shadows, withBackendScene);

  const stopSweep = useCallback(() => {
    if (sweepFrame.current !== null) cancelAnimationFrame(sweepFrame.current);
    sweepFrame.current = null;
    setSweeping(false);
  }, []);
  // Leaving the page (or having it hidden) ends a sweep in progress.
  useEffect(() => stopSweep, [stopSweep]);

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
   * Ask the backend for the photo's scene. With `keep`, the scene on screen
   * stays up while waiting and survives a failure (used when a working sample
   * is re-analysed). Resolves false if the request failed.
   */
  const load = useCallback(
    async (image: LoadedImage, withDetail: boolean, keep = false): Promise<boolean> => {
      const id = ++request.current;
      clearResults();
      setPhoto(image);
      if (!keep) {
        setScene(null);
        setReady(false);
        setGpuProblem(null);
      }
      setLoading(true);
      try {
        const result = await relightScene({ image: image.base64, detail: withDetail });
        if (request.current === id) {
          setReady(false);
          setGpuProblem(null);
          setScene(result);
        }
        return true;
      } catch (e) {
        if (request.current !== id) return true;
        if (keep) setError(`${errorMessage(e)} The sample keeps the geometry it came with.`);
        else setSceneError(errorMessage(e));
        return false;
      } finally {
        if (request.current === id) setLoading(false);
      }
    },
    [clearResults],
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
      setReady(false);
      setGpuProblem(null);
      setDetail(true); // samples are baked with the detailed normals
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
    setLoading(false);
    setError(null);
    setSceneError(null);
    setPicking(null);
    setSampleError(null);
    setBase(START);
    setWarmth(0);
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
    const cx = clamp(event.clientX, bounds.left + 18, bounds.right - 18);
    const cy = clamp(event.clientY, bounds.top + 18, bounds.bottom - 18);
    const x = round(clamp((cx - box.left) / box.width, -OUTSIDE, 1 + OUTSIDE));
    const y = round(clamp((cy - box.top) / box.height, -OUTSIDE, 1 + OUTSIDE));
    setBase((b) => ({ ...b, x, y }));
  };

  /** Keep a position set without the pointer (preset, arrow keys) inside the stage too, or the handle is clipped away. */
  const insideStage = (x: number, y: number) => {
    const box = imageBox.current?.getBoundingClientRect();
    const bounds = surface.current?.getBoundingClientRect();
    if (!box || !bounds || box.width === 0) return { x, y };
    return {
      x: round(clamp(x, (bounds.left + 18 - box.left) / box.width, (bounds.right - 18 - box.left) / box.width)),
      y: round(clamp(y, (bounds.top + 18 - box.top) / box.height, (bounds.bottom - 18 - box.top) / box.height)),
    };
  };

  const nudge = (dx: number, dy: number) => {
    stopSweep();
    const p = insideStage(clamp(base.x + dx, -OUTSIDE, 1 + OUTSIDE), clamp(base.y + dy, -OUTSIDE, 1 + OUTSIDE));
    setBase((b) => ({ ...b, ...p }));
  };

  /**
   * Carry the light once around the subject and hand it back where it was.
   * For recording a demo; any deliberate move of the light ends it early.
   */
  const startSweep = () => {
    stopSweep();
    const from = { x: base.x, y: base.y };
    const startAngle = Math.atan2(from.y - SWEEP_CENTRE.y, from.x - SWEEP_CENTRE.x);
    const startedAt = performance.now();
    setSweeping(true);
    const frame = (now: number) => {
      const t = clamp((now - startedAt) / SWEEP_MS, 0, 1);
      const angle = startAngle + t * 2 * Math.PI;
      // 0 at both ends (the user's own position), 1 while on the orbit.
      const onOrbit = smoothstep(clamp(Math.min(t, 1 - t) / SWEEP_BLEND, 0, 1));
      const p = insideStage(
        from.x + (SWEEP_CENTRE.x + SWEEP_RADIUS * Math.cos(angle) - from.x) * onOrbit,
        from.y + (SWEEP_CENTRE.y + SWEEP_RADIUS * Math.sin(angle) - from.y) * onOrbit,
      );
      setBase((b) => ({ ...b, ...p }));
      if (t < 1) sweepFrame.current = requestAnimationFrame(frame);
      else stopSweep();
    };
    sweepFrame.current = requestAnimationFrame(frame);
  };

  // --- actions --------------------------------------------------------------------

  const onReady = useCallback(() => setReady(true), []);
  const onUnavailable = useCallback((reason: string) => setGpuProblem(reason), []);

  const exportPng = async () => {
    try {
      if (gpuProblem === null && canvas.current) await downloadCanvas(canvas.current, "relit.png");
      else if (server.image) await downloadBase64AsPng(server.image, "relit.png");
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const runEnhance = async () => {
    if (!scene) return;
    // Freeze what the live preview shows now: it is the "before" of the comparison.
    setSnapshot(gpuProblem === null ? (canvas.current?.toDataURL("image/jpeg", 0.92) ?? null) : server.image ? toDataUrl(server.image) : null);
    // A new run clears the last result, which would leave the Enhanced tab empty, and stuck there if the run fails.
    setTab("live");
    const result = await enhance.run(() => withBackendScene(scene, ENHANCE_OFFLINE, (scene_id) => relightEnhance({ scene_id, light, shadows, prompt: prompt.trim() })));
    if (result) setTab("enhanced");
  };

  // --- render ---------------------------------------------------------------------

  if (!photo) {
    return (
      <PageIntro
        eyebrow="Move the light"
        title="Relight a photo by dragging the light."
        lead="Upload a photo. We estimate its depth and surface normals once, then your browser shades it live: drag the light anywhere around the subject and the highlights and shadows follow instantly."
      >
        <UploadDropzone
          onImage={(image) => void load(image, detail)}
          title="Drop a photo here"
          footer={
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
  const canShade = scene !== null && (ready || gpuProblem !== null);
  // There is a relit picture on screen: the live canvas, or (without WebGL2) a render from the server.
  const canShow = canShade && (gpuProblem === null || server.image !== null);
  const failed = scene === null && !loading && sceneError !== null;

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
                disabled={!canShade || !live}
                aria-pressed={sweeping}
                title="Moves the light once around the subject in about six seconds, then gives it back. Handy for recording a demo."
                className={cn(sweeping && "border-accent/60 text-accent")}
                onClick={sweeping ? stopSweep : startSweep}
              >
                <OrbitIcon />
                {sweeping ? "Stop sweep" : "Sweep"}
              </Button>
            }
          >
            <div className={cn("flex flex-col gap-3 lg:short:gap-2", !canShade && "pointer-events-none opacity-50")}>
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
                min={0.03}
                max={2}
                step={0.01}
                onChange={(v) => setBase((b) => ({ ...b, height: v }))}
                hint="Low grazes the surface and stretches the shadows."
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
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    size="sm"
                    className="px-2"
                    onClick={() => {
                      stopSweep();
                      const p = insideStage(preset.light.x ?? base.x, preset.light.y ?? base.y);
                      setBase((b) => ({ ...b, ...preset.light, ...p }));
                      setWarmth(preset.warmth ?? 0);
                    }}
                  >
                    {preset.label}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  className="px-2"
                  onClick={() => {
                    stopSweep();
                    setBase(START);
                    setWarmth(0);
                    setShadows(true);
                  }}
                >
                  Reset
                </Button>
              </div>
            </div>
          </Panel>

          {/* On a short window beside the stage the hint moves to the button's tooltip and the box loses a row, so the sidebar fits. */}
          <Panel title="Enhance" hint={ENHANCE_HINT} hintClassName="lg:short:hidden">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              placeholder="Optional: describe the mood, e.g. golden hour, soft window light"
              className="block w-full resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-accent/60 focus:outline-none lg:short:h-[2.375rem] lg:short:placeholder:truncate"
            />
            <div className="mt-2.5 flex items-center gap-2">
              <Button variant="primary" className="flex-1" title={ENHANCE_HINT} disabled={!canShade} busy={enhance.status === "pending"} onClick={() => void runEnhance()}>
                {enhance.status !== "pending" && <SparklesIcon />}
                {enhance.status === "pending" ? "Enhancing…" : enhanced ? "Enhance again" : "Enhance"}
              </Button>
              {enhancedBase64 && (
                <Button title="Download the enhanced image" aria-label="Download the enhanced image" onClick={() => void downloadBase64AsPng(enhancedBase64, "relit-enhanced.png")}>
                  <DownloadIcon />
                </Button>
              )}
            </div>
            <ErrorBanner message={enhance.status === "error" ? enhance.error : null} onDismiss={enhance.reset} className="mt-3" />
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
            <p className="mb-2.5 text-xs leading-4 text-zinc-500">What the models recovered from the photo. The shader lights these.</p>
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
                hint="Slower to analyse, much better surface detail."
                checked={detail}
                onChange={(next) => {
                  // A sample already works without the backend: keep it on screen unless the new analysis succeeds.
                  const keep = scene !== null && isSampleScene(scene);
                  setDetail(next);
                  void load(photo, next, keep).then((ok) => {
                    if (!ok && keep) setDetail(!next);
                  });
                }}
              />
            </div>
            {scene && (
              <p className="mt-2.5 font-mono text-[11px] text-zinc-500">
                {scene.width} x {scene.height} px, relief {scene.relief}
              </p>
            )}
          </CollapsiblePanel>
        </>
      }
    >
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      {gpuProblem !== null && (
        <ErrorBanner message={`Live shading is unavailable (${gpuProblem}). Showing server renders instead, which lag slightly behind the light.`} />
      )}
      <ErrorBanner message={server.error} />

      {/* A wide photo on a phone gives a stage too low for the failed-load card: keep room for it. */}
      <Stage hug={{ width, height }} className={cn(failed && "max-lg:min-h-80!")}>
        {/* The whole stage is the drag surface, so the light can be pulled past the photo's edge. */}
        <div
          ref={surface}
          className={cn("absolute inset-0 touch-none", live && canShade && (dragging ? "cursor-grabbing" : "cursor-crosshair"))}
          onPointerDown={(e) => {
            if (!live || !canShade || e.button !== 0) return;
            stopSweep(); // the user has taken the light
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            dragTo(e);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) dragTo(e);
          }}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
        >
          <div className="absolute inset-x-6 bottom-16 top-16 sm:inset-x-14">
            {/* Live preview. Stays mounted behind the Enhanced tab so the GPU scene survives. */}
            <div className={cn("absolute inset-0", !live && "invisible")}>
              <FitBox width={width} height={height}>
                <div ref={imageBox} className="absolute inset-0 overflow-hidden rounded-lg bg-black shadow-2xl ring-1 ring-white/10">
                  <img src={photoUrl} alt="Original photo" draggable={false} className={cn("absolute inset-0 h-full w-full", failed && "opacity-30 grayscale")} />
                  {scene && gpuProblem === null && (
                    <RelightCanvas
                      scene={scene}
                      light={light}
                      shadows={shadows}
                      canvasRef={canvas}
                      onReady={onReady}
                      onUnavailable={onUnavailable}
                      className={cn("absolute inset-0 h-full w-full", (!ready || comparing) && "opacity-0")}
                    />
                  )}
                  {gpuProblem !== null && server.image && !comparing && (
                    <img src={toDataUrl(server.image)} alt="Relit photo" draggable={false} className="absolute inset-0 h-full w-full" />
                  )}
                  {comparing && <span className="absolute left-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-zinc-200 backdrop-blur">Original</span>}
                  {(loading || (scene !== null && !canShade)) && <BusyOverlay>{loading ? "Estimating depth and surface normals…" : "Preparing the shader…"}</BusyOverlay>}
                </div>

                {canShade && (
                  <button
                    type="button"
                    aria-label={`Light position, x ${light.x.toFixed(2)}, y ${light.y.toFixed(2)}. Use the arrow keys to move.`}
                    onKeyDown={(e) => {
                      const step = e.shiftKey ? 0.1 : 0.02;
                      if (e.key === "ArrowLeft") nudge(-step, 0);
                      else if (e.key === "ArrowRight") nudge(step, 0);
                      else if (e.key === "ArrowUp") nudge(0, -step);
                      else if (e.key === "ArrowDown") nudge(0, step);
                      else return;
                      e.preventDefault();
                    }}
                    className={cn(
                      "absolute z-10 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/80",
                      dragging ? "cursor-grabbing" : "cursor-grab",
                    )}
                    style={{ left: `${light.x * 100}%`, top: `${light.y * 100}%` }}
                  >
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -inset-6 rounded-full blur-md"
                      style={{ background: `radial-gradient(circle, ${cssColor(light.color)} 0%, transparent 65%)`, opacity: 0.25 + 0.15 * Math.min(light.intensity, 3) }}
                    />
                    <span
                      className={cn(
                        "pointer-events-none absolute inset-0 flex items-center justify-center rounded-full border-2 border-white text-black/75 shadow-[0_2px_14px_rgb(0_0_0/0.65)] transition-transform",
                        dragging && "scale-110",
                      )}
                      style={{ background: cssColor(light.color) }}
                    >
                      <SunIcon className="h-5 w-5" />
                    </span>
                  </button>
                )}
              </FitBox>
            </div>

            {/* A failed load must not pass for a loaded scene: the photo is dimmed and this sits on top of it. */}
            {failed && (
              <div className="absolute inset-0 z-20 flex items-center justify-center">
                <div role="alert" className="flex max-w-sm animate-rise flex-col items-center gap-2.5 rounded-2xl border border-rose-500/40 bg-ink/90 px-5 py-4 text-center shadow-2xl backdrop-blur">
                  <span className="flex items-center gap-2 text-sm font-semibold text-rose-100">
                    <AlertIcon className="text-rose-400" />
                    This photo could not be analysed
                  </span>
                  <p className="break-words text-sm leading-5 text-rose-100/90">{sceneError}</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => void load(photo, detail)}>
                      Retry
                    </Button>
                    <Button size="sm" onClick={startOver}>
                      Choose another photo
                    </Button>
                  </div>
                </div>
              </div>
            )}

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
              className={cn("pointer-events-auto", comparing && "border-accent/60 text-accent")}
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
    </Workspace>
  );
}
