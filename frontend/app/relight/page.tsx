"use client";

import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BeforeAfter } from "@/components/BeforeAfter";
import { ErrorBanner } from "@/components/ErrorBanner";
import { FitBox, PageIntro, Panel, Stage, Workspace } from "@/components/Panel";
import { BusyLabel, BusyOverlay } from "@/components/Spinner";
import { UploadDropzone } from "@/components/UploadDropzone";
import { DownloadIcon, EyeIcon, SparklesIcon, SunIcon, UploadIcon } from "@/components/icons";
import { RelightCanvas } from "@/components/relight/RelightCanvas";
import { Button, Segmented, Slider, Toggle } from "@/components/ui";
import { errorMessage, isAbort, relightEnhance, relightRender, relightScene } from "@/lib/api";
import { cn } from "@/lib/cn";
import { type LoadedImage, downloadBase64AsPng, downloadCanvas, toDataUrl } from "@/lib/image";
import { sampleRelightPhoto } from "@/lib/samples";
import { DEFAULT_LIGHT, type Light, type RelightRender, type RelightScene } from "@/lib/types";
import { useJob } from "@/lib/useJob";

/** How far outside the photo the light may be dragged, in image widths/heights. */
const OUTSIDE = 0.5;
const WARM: [number, number, number] = [1.0, 0.86, 0.68];
const COOL: [number, number, number] = [0.7, 0.86, 1.0];

type LightBase = Omit<Light, "color">;

const START: LightBase = { x: DEFAULT_LIGHT.x, y: DEFAULT_LIGHT.y, height: DEFAULT_LIGHT.height, intensity: DEFAULT_LIGHT.intensity, ambient: DEFAULT_LIGHT.ambient };

const PRESETS: { label: string; light: Partial<LightBase>; warmth?: number }[] = [
  { label: "Left", light: { x: -0.1, y: 0.4, height: 0.35, intensity: 1.3 } },
  { label: "Right", light: { x: 1.1, y: 0.4, height: 0.35, intensity: 1.3 } },
  { label: "Top", light: { x: 0.5, y: -0.15, height: 0.35, intensity: 1.3 } },
  { label: "Low and warm", light: { x: 0.0, y: 0.9, height: 0.12, intensity: 1.6, ambient: 0.2 }, warmth: 1 },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, digits = 3) => Number(v.toFixed(digits));

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
function useServerPreview(enabled: boolean, scene: RelightScene | null, light: Light, shadows: boolean) {
  const [state, setState] = useState<{ sceneId: string | null; image: string | null; error: string | null }>({ sceneId: null, image: null, error: null });
  useEffect(() => {
    if (!enabled || !scene) return;
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const render = await relightRender({ scene_id: scene.scene_id, light, shadows }, controller.signal);
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
  }, [enabled, scene, light, shadows]);
  // The last render outlives a change of photo: never show or export it over another scene.
  return enabled && scene && state.sceneId === scene.scene_id ? state : { ...state, image: null };
}

export default function RelightPage() {
  const [photo, setPhoto] = useState<LoadedImage | null>(null);
  const [scene, setScene] = useState<RelightScene | null>(null);
  const [detail, setDetail] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [base, setBase] = useState<LightBase>(START);
  const [warmth, setWarmth] = useState(0);
  const [shadows, setShadows] = useState(true);
  const light = useMemo<Light>(() => ({ ...base, color: warmthToColor(warmth) }), [base, warmth]);

  const [ready, setReady] = useState(false); // first GPU frame is on screen
  const [gpuProblem, setGpuProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [tab, setTab] = useState<"live" | "enhanced">("live");
  const [prompt, setPrompt] = useState("");
  const [snapshot, setSnapshot] = useState<string | null>(null);

  const enhance = useJob<RelightRender>();
  const server = useServerPreview(gpuProblem !== null, scene, light, shadows);

  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const imageBox = useRef<HTMLDivElement>(null);
  const request = useRef(0);

  const resetEnhance = enhance.reset;
  const load = useCallback(
    async (image: LoadedImage, withDetail: boolean) => {
      const id = ++request.current;
      setPhoto(image);
      setScene(null);
      setReady(false);
      setGpuProblem(null);
      setError(null);
      setTab("live");
      setSnapshot(null);
      resetEnhance();
      setLoading(true);
      try {
        const result = await relightScene({ image: image.base64, detail: withDetail });
        if (request.current === id) setScene(result);
      } catch (e) {
        if (request.current === id) setError(errorMessage(e));
      } finally {
        if (request.current === id) setLoading(false);
      }
    },
    [resetEnhance],
  );

  const startOver = () => {
    request.current++;
    setPhoto(null);
    setScene(null);
    setLoading(false);
    setError(null);
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
    const p = insideStage(clamp(base.x + dx, -OUTSIDE, 1 + OUTSIDE), clamp(base.y + dy, -OUTSIDE, 1 + OUTSIDE));
    setBase((b) => ({ ...b, ...p }));
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
    const result = await enhance.run(() => relightEnhance({ scene_id: scene.scene_id, light, shadows, prompt: prompt.trim() }));
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
        <UploadDropzone onImage={(image) => void load(image, detail)} title="Drop a photo here" sample={{ label: "Use a sample photo", make: sampleRelightPhoto }} />
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

  return (
    <Workspace
      sidebar={
        <>
          <Panel title="Light" hint="Drag the sun on the photo. It can sit outside the frame.">
            <div className={cn("flex flex-col gap-5", !canShade && "pointer-events-none opacity-50")}>
              <div className="flex items-center justify-between rounded-xl bg-black/30 px-3 py-2 font-mono text-xs tabular-nums text-zinc-400">
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
                hint="How far in front of the subject the light floats. Low grazes the surface and stretches the shadows."
              />
              <Slider label="Intensity" value={base.intensity} min={0} max={4} step={0.05} onChange={(v) => setBase((b) => ({ ...b, intensity: v }))} />
              <Slider
                label="Ambient"
                value={base.ambient}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setBase((b) => ({ ...b, ambient: v }))}
                hint="Light that reaches everything, so shadows are not pure black."
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
              <Toggle label="Cast shadows" hint="Ray-march the depth map toward the light." checked={shadows} onChange={setShadows} />
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    size="sm"
                    onClick={() => {
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
                  onClick={() => {
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

          <Panel title="Enhance" hint="Send this lighting to the diffusion model for a photoreal pass. Takes a few seconds.">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              placeholder="Optional: describe the mood, e.g. golden hour, soft window light"
              className="w-full resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-accent/60 focus:outline-none"
            />
            <div className="mt-3 flex items-center gap-2">
              <Button variant="primary" className="flex-1" disabled={!canShade} busy={enhance.status === "pending"} onClick={() => void runEnhance()}>
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

          <Panel title="Geometry" hint="What the models recovered from the photo. The shader lights these.">
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
            <div className="mt-4">
              <Toggle
                label="Detailed normals"
                hint="Slower to analyse, much better surface detail."
                checked={detail}
                onChange={(next) => {
                  setDetail(next);
                  void load(photo, next);
                }}
              />
            </div>
            {scene && (
              <p className="mt-3 font-mono text-[11px] text-zinc-500">
                {scene.width} x {scene.height} px, relief {scene.relief}
              </p>
            )}
          </Panel>
        </>
      }
    >
      <ErrorBanner message={error} onDismiss={() => setError(null)} onRetry={scene ? undefined : () => void load(photo, detail)} />
      {gpuProblem !== null && (
        <ErrorBanner message={`Live shading is unavailable (${gpuProblem}). Showing server renders instead, which lag slightly behind the light.`} />
      )}
      <ErrorBanner message={server.error} />

      <Stage>
        {/* The whole stage is the drag surface, so the light can be pulled past the photo's edge. */}
        <div
          ref={surface}
          className={cn("absolute inset-0 touch-none", live && canShade && (dragging ? "cursor-grabbing" : "cursor-crosshair"))}
          onPointerDown={(e) => {
            if (!live || !canShade || e.button !== 0) return;
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
                  <img src={photoUrl} alt="Original photo" draggable={false} className="absolute inset-0 h-full w-full" />
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
              disabled={!canShade}
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
            <Button size="sm" variant="glass" className="pointer-events-auto" disabled={!canShade} onClick={() => void exportPng()}>
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
