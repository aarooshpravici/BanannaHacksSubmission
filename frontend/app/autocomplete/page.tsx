"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { BeforeAfter } from "@/components/BeforeAfter";
import { type Candidate, CandidateGrid } from "@/components/CandidateGrid";
import { ErrorBanner } from "@/components/ErrorBanner";
import { FitBox, PageIntro, Panel, Stage, Workspace } from "@/components/Panel";
import { BusyLabel, BusyOverlay, Skeleton } from "@/components/Spinner";
import { UploadDropzone } from "@/components/UploadDropzone";
import { MaskCanvas } from "@/components/autocomplete/MaskCanvas";
import { BoxSelectIcon, BrushIcon, CheckIcon, CursorIcon, DownloadIcon, RefreshIcon, SparklesIcon, UndoIcon, UploadIcon } from "@/components/icons";
import { Badge, Button, Segmented } from "@/components/ui";
import { autocompleteDetect, autocompleteFill, autocompletePlan, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { type BBox, type LoadedImage, canvasToMask, downloadBase64AsPng, maskToAlphaCanvas, rectToMask, toDataUrl } from "@/lib/image";
import { sampleDesign } from "@/lib/samples";
import type { FillIn, FillResult, PlanOut, Region } from "@/lib/types";
import { useJob } from "@/lib/useJob";

const CANDIDATES = 4;
const ACCENT_RGB: [number, number, number] = [251, 209, 61];

type Tool = "select" | "box" | "brush";

/** One state of the design: the original, or the design after a fill was applied. */
interface Version {
  id: string;
  image: string;
  label: string;
  /** The detected region this version filled, if any (see regionKey). */
  regionKey?: string;
}

/** The area the user wants filled: a detected region or a hand-drawn mask. */
type Selection =
  | { kind: "region"; regionId: string; mask: string; bbox: BBox; references: BBox[] }
  | { kind: "custom"; mask: string; bbox: BBox };

type Plan = { status: "idle" } | { status: "loading" } | { status: "done"; data: PlanOut } | { status: "error"; error: string };

export default function AutocompletePage() {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [index, setIndex] = useState(0);

  // Region ids are only unique within one detection run, hence the generation counter.
  // width/height are the pixel space the detector reports its boxes in.
  const [detection, setDetection] = useState<{ generation: number; width: number; height: number; regions: Region[] }>({
    generation: 0,
    width: 0,
    height: 0,
    regions: [],
  });
  const [detecting, setDetecting] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);

  const [tool, setTool] = useState<Tool>("select");
  const [brushSize, setBrushSize] = useState(48);
  const [painted, setPainted] = useState(false); // brush strokes waiting to become the selection
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionTint, setSelectionTint] = useState<string | null>(null);

  const [plan, setPlan] = useState<Plan>({ status: "idle" });
  const [prompt, setPrompt] = useState("");
  const fill = useJob<FillResult>();
  const [fillBase, setFillBase] = useState<number | null>(null); // index of the version the candidates were made from
  const [error, setError] = useState<string | null>(null);

  const maskCanvas = useRef<HTMLCanvasElement>(null);
  const candidatesPanel = useRef<HTMLDivElement>(null);
  const detectRequest = useRef(0);
  const planRequest = useRef(0);

  const current: Version | undefined = versions[index];
  const regions = detection.regions;
  const regionKey = (regionId: string) => `${detection.generation}:${regionId}`;
  // A region counts as filled while the version that filled it is still in effect, so undo reopens it.
  const filledKeys = new Set(versions.slice(0, index + 1).map((v) => v.regionKey));
  const isFilled = (region: Region) => filledKeys.has(regionKey(region.id));
  const candidates = fill.result?.candidates ?? [];
  const applied = current ? (candidates.find((c) => c.id === current.id) ?? null) : null;

  // The candidates sit at the bottom of the sidebar: bring them into view when a batch starts, lands or fails.
  const fillStatus = fill.status;
  useEffect(() => {
    if (fillStatus !== "idle") candidatesPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [fillStatus]);

  // --- detect ---------------------------------------------------------------------

  const detect = async (image: string) => {
    const id = ++detectRequest.current;
    setDetecting(true);
    setError(null);
    try {
      const out = await autocompleteDetect({ image });
      if (detectRequest.current !== id) return;
      setDetection((d) => ({ generation: d.generation + 1, width: out.width, height: out.height, regions: out.regions }));
    } catch (e) {
      if (detectRequest.current === id) setError(errorMessage(e));
    } finally {
      if (detectRequest.current === id) setDetecting(false);
    }
  };

  const clearMaskCanvas = () => {
    const canvas = maskCanvas.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setPainted(false);
  };

  const clearSelection = () => {
    planRequest.current++;
    setSelection(null);
    setSelectionTint(null);
    setPlan({ status: "idle" });
    setPrompt("");
    setFillBase(null);
    fill.reset();
  };

  const open = (image: LoadedImage) => {
    clearSelection();
    clearMaskCanvas();
    setSize({ width: image.width, height: image.height });
    setVersions([{ id: "original", image: image.base64, label: "Original" }]);
    setIndex(0);
    setDetection((d) => ({ generation: d.generation + 1, width: 0, height: 0, regions: [] }));
    setTool("select");
    setBrushSize(Math.max(12, Math.round(Math.max(image.width, image.height) * 0.04)));
    void detect(image.base64);
  };

  const startOver = () => {
    detectRequest.current++;
    clearSelection();
    setSize(null);
    setVersions([]);
    setIndex(0);
    setDetection((d) => ({ generation: d.generation + 1, width: 0, height: 0, regions: [] }));
    setDetecting(false);
    setError(null);
  };

  // --- select -> plan -------------------------------------------------------------

  /** Make `next` the selection and ask the planner what could go there. */
  const select = async (next: Selection) => {
    if (!current) return;
    const id = ++planRequest.current;
    setSelection(next);
    setSelectionTint(null);
    setPrompt("");
    setFillBase(null);
    fill.reset();
    setPlan({ status: "loading" });
    try {
      const out = await autocompletePlan({ image: current.image, mask: next.mask });
      if (planRequest.current === id) setPlan({ status: "done", data: out });
    } catch (e) {
      if (planRequest.current === id) setPlan({ status: "error", error: errorMessage(e) });
    }
  };

  const selectRegion = (region: Region) => {
    if (!size) return;
    clearMaskCanvas();
    void select({ kind: "region", regionId: region.id, mask: region.mask, bbox: region.bbox, references: region.siblings ?? [] });
    // Tint the region's real mask (it need not be a rectangle) on the canvas.
    const id = planRequest.current;
    maskToAlphaCanvas(region.mask, size.width, size.height, ACCENT_RGB)
      .then((canvas) => {
        if (planRequest.current === id) setSelectionTint(canvas.toDataURL("image/png"));
      })
      .catch(() => {}); // the outline still shows which region is selected
  };

  const selectBox = (bbox: BBox) => {
    if (!size) return;
    setPainted(false);
    void select({ kind: "custom", mask: rectToMask(bbox, size.width, size.height), bbox });
  };

  const selectPainted = () => {
    const canvas = maskCanvas.current;
    if (!canvas || !size) return;
    const mask = canvasToMask(canvas, size.width, size.height);
    setPainted(false);
    if (!mask) return setError("The mask is empty. Paint over the area you want filled.");
    void select({ kind: "custom", mask: mask.mask, bbox: mask.bbox });
  };

  // --- generate -> apply ----------------------------------------------------------

  const generate = async () => {
    if (!selection || !prompt.trim()) return;
    // Regenerating while a candidate is applied starts again from the design before that fill.
    const baseIndex = applied && fillBase !== null ? fillBase : index;
    const base = versions[baseIndex];
    if (!base) return;
    setFillBase(baseIndex);
    setIndex(baseIndex);
    const request: FillIn = {
      image: base.image,
      mask: selection.mask,
      prompt: prompt.trim(),
      n: CANDIDATES,
      // A detected gap knows which neighbouring blocks the fill should look like.
      references: selection.kind === "region" ? selection.references : [],
      // "Generate again" must not hand back the cached batch.
      fresh: fill.status !== "idle",
    };
    await fill.run(() => autocompleteFill(request));
  };

  /** Put a candidate on the canvas. Picking another one from the same batch replaces it. */
  const apply = (candidateId: string) => {
    const position = candidates.findIndex((c) => c.id === candidateId);
    if (position < 0 || fillBase === null) return;
    const candidate = candidates[position];
    const version: Version = {
      id: candidate.id,
      image: candidate.image,
      label: `Fill ${fillBase + 1}`,
      regionKey: selection?.kind === "region" ? regionKey(selection.regionId) : undefined,
    };
    setVersions((list) => [...list.slice(0, fillBase + 1), version]);
    setIndex(fillBase + 1);
    clearMaskCanvas();
  };

  // --- render ---------------------------------------------------------------------

  if (!size || !current) {
    return (
      <PageIntro
        eyebrow="Design autocomplete"
        title="Point at the gap. Get four ways to fill it."
        lead="Upload a design. We find the areas that look unfinished, suggest what belongs there, generate several options that match your style, and rank them on style, seam quality and intent."
      >
        <UploadDropzone onImage={open} format="png" title="Drop a design here" sample={{ label: "Use a sample poster", make: sampleDesign }} />
      </PageIntro>
    );
  }

  const { width, height } = size;
  // Detected boxes are in the detector's pixel space, which is the image's own unless the server resized it.
  const space = { width: detection.width || width, height: detection.height || height };
  const generating = fill.status === "pending";
  const openRegions = regions.filter((r) => !isFilled(r));
  const hoveredRegion = tool === "select" ? (openRegions.find((r) => r.id === hovered) ?? null) : null;
  const gridItems: Candidate[] = candidates.map((c) => ({
    id: c.id,
    image: c.image,
    scores: { style: c.scores.style, seam: c.scores.seam, intent: c.scores.intent },
    total: c.scores.total,
  }));

  return (
    <Workspace
      sidebar={
        <>
          <Panel
            title="Gaps found"
            hint="Areas the detector thinks are unfinished, most confident first."
            actions={
              <Button
                size="sm"
                variant="ghost"
                disabled={detecting || generating}
                title="Run detection again on the current design"
                onClick={() => {
                  clearSelection();
                  clearMaskCanvas();
                  void detect(current.image);
                }}
              >
                <RefreshIcon />
                Re-detect
              </Button>
            }
          >
            {detecting ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            ) : regions.length === 0 ? (
              <p className="text-sm leading-6 text-zinc-500">Nothing stood out. Draw the area yourself with the box or brush tool above the canvas.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {regions.map((region, i) => {
                  const done = isFilled(region);
                  const active = selection?.kind === "region" && selection.regionId === region.id;
                  return (
                    <li key={region.id}>
                      <button
                        type="button"
                        disabled={done || generating}
                        onClick={() => selectRegion(region)}
                        onPointerEnter={() => setHovered(region.id)}
                        onPointerLeave={() => setHovered(null)}
                        className={cn(
                          "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-default",
                          active ? "border-accent/60 bg-accent/10" : "border-white/[0.07] bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.05]",
                          done && "opacity-50 hover:border-white/[0.07] hover:bg-white/[0.02]",
                        )}
                      >
                        <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold", active ? "bg-accent text-black" : "bg-white/10 text-zinc-200")}>
                          {done ? <CheckIcon className="h-3 w-3" /> : i + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 text-[13px] leading-5 text-zinc-200">{region.reason}</span>
                          <span className="mt-1.5 flex items-center gap-2 text-[11px] text-zinc-500">
                            <span className="h-1 w-16 overflow-hidden rounded-full bg-white/10">
                              <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(region.confidence * 100)}%` }} />
                            </span>
                            {Math.round(region.confidence * 100)}% confident{done ? ", filled" : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title="Plan" hint={selection ? undefined : "Select a gap on the canvas, or draw your own, and the planner reads the layout around it."}>
            {plan.status === "loading" && (
              <div className="flex flex-col gap-2.5">
                <BusyLabel>Reading the layout around the selection…</BusyLabel>
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-11/12" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            )}
            {plan.status === "error" && <ErrorBanner message={plan.error} onRetry={selection ? () => void select(selection) : undefined} />}
            {plan.status === "done" && <p className="text-sm leading-6 text-zinc-300">{plan.data.analysis}</p>}

            {selection && plan.status !== "loading" && (
              <div className="mt-4 flex flex-col gap-3">
                {plan.status === "done" && plan.data.suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {plan.data.suggestions.map((suggestion) => (
                      <button
                        key={suggestion.label}
                        type="button"
                        title={suggestion.prompt}
                        onClick={() => setPrompt(suggestion.prompt)}
                        className={cn(
                          "rounded-full border px-3 py-1 text-[13px] transition-colors",
                          prompt === suggestion.prompt ? "border-accent/60 bg-accent/15 text-accent" : "border-white/10 bg-white/[0.05] text-zinc-200 hover:border-white/25 hover:bg-white/[0.09]",
                        )}
                      >
                        {suggestion.label}
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  placeholder="Pick a suggestion, or describe what should go here"
                  className="w-full resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm leading-5 text-zinc-100 placeholder:text-zinc-600 focus:border-accent/60 focus:outline-none"
                />
                <Button variant="primary" disabled={!prompt.trim()} busy={generating} onClick={() => void generate()}>
                  {!generating && <SparklesIcon />}
                  {generating ? "Generating…" : candidates.length ? "Generate again" : `Generate ${CANDIDATES} options`}
                </Button>
              </div>
            )}
          </Panel>

          {fill.status !== "idle" && (
            <div ref={candidatesPanel}>
              <Panel title="Candidates" hint={fill.status === "done" ? "Ranked by the critic. Click one to put it on the canvas." : undefined}>
                {generating && (
                  <div className="flex flex-col gap-3">
                    <BusyLabel>Generating and scoring {CANDIDATES} candidates…</BusyLabel>
                    <div className="grid grid-cols-2 gap-2.5">
                      {Array.from({ length: CANDIDATES }, (_, i) => (
                        <Skeleton key={i} className="aspect-[4/5] rounded-xl" />
                      ))}
                    </div>
                  </div>
                )}
                <ErrorBanner message={fill.status === "error" ? fill.error : null} onRetry={() => void generate()} />
                {fill.status === "done" && candidates.length === 0 && <p className="text-sm text-zinc-500">The generator returned nothing. Try another prompt.</p>}
                {fill.status === "done" && candidates.length > 0 && <CandidateGrid candidates={gridItems} selectedId={applied?.id ?? null} onSelect={apply} />}
                {applied && (
                  <div className="mt-4">
                    <p className="mb-2 text-xs leading-4 text-zinc-500">What the blend step did: the generator&apos;s raw output against the version merged into your design.</p>
                    <BeforeAfter before={toDataUrl(applied.raw)} after={toDataUrl(applied.image)} beforeLabel="Raw" afterLabel="Blended" />
                  </div>
                )}
              </Panel>
            </div>
          )}
        </>
      }
    >
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <Stage>
        <div className="absolute inset-x-4 bottom-4 top-16 sm:inset-x-8">
          <FitBox width={width} height={height}>
            <div className="checker absolute inset-0 overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/10">
              <img src={toDataUrl(current.image)} alt="Design" draggable={false} className="absolute inset-0 h-full w-full" />
              {selectionTint && !applied && <img src={selectionTint} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full opacity-40" />}
              <MaskCanvas
                width={width}
                height={height}
                tool={tool === "select" || generating ? null : tool}
                brushSize={brushSize}
                canvasRef={maskCanvas}
                onBox={selectBox}
                onStroke={() => setPainted(true)}
                className="absolute inset-0 h-full w-full"
              />

              {/* Detected regions: subtle outlines, clickable with the select tool. */}
              <svg viewBox={`0 0 ${space.width} ${space.height}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
                {/* The blocks a hovered or selected gap was matched against. */}
                {openRegions
                  .filter((region) => region.id === hovered || (selection?.kind === "region" && selection.regionId === region.id && !applied))
                  .flatMap((region) =>
                    (region.siblings ?? []).map(([x, y, w, h], i) => (
                      <rect
                        key={`${region.id}-sibling-${i}`}
                        x={x}
                        y={y}
                        width={w}
                        height={h}
                        fill="none"
                        stroke="#7dd3fc"
                        strokeOpacity={0.8}
                        strokeWidth={1.25}
                        strokeDasharray="2 4"
                        vectorEffect="non-scaling-stroke"
                      />
                    )),
                  )}
                {openRegions.map((region) => {
                  const [x, y, w, h] = region.bbox;
                  const active = selection?.kind === "region" && selection.regionId === region.id;
                  const hot = hovered === region.id;
                  if (active && applied) return null;
                  return (
                    <rect
                      key={region.id}
                      x={x}
                      y={y}
                      width={w}
                      height={h}
                      rx={Math.min(w, h) * 0.04}
                      fill={active ? "rgb(251 209 61 / 0.06)" : hot ? "rgb(251 209 61 / 0.12)" : "rgb(255 255 255 / 0.04)"}
                      stroke={active || hot ? "#fbd13d" : "rgb(255 255 255 / 0.6)"}
                      strokeWidth={active ? 2 : 1.25}
                      strokeDasharray={active ? undefined : "6 5"}
                      vectorEffect="non-scaling-stroke"
                      style={{ pointerEvents: tool === "select" && !generating ? "all" : "none", cursor: "pointer", transition: "fill 0.15s, stroke 0.15s" }}
                      onPointerEnter={() => setHovered(region.id)}
                      onPointerLeave={() => setHovered((id) => (id === region.id ? null : id))}
                      onClick={() => selectRegion(region)}
                    />
                  );
                })}
              </svg>
              {/* A hand-drawn selection, outlined in image pixels. */}
              {selection?.kind === "custom" && !applied && (
                <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
                  <rect
                    x={selection.bbox[0]}
                    y={selection.bbox[1]}
                    width={selection.bbox[2]}
                    height={selection.bbox[3]}
                    fill="none"
                    stroke="#fbd13d"
                    strokeWidth={1.5}
                    strokeDasharray="3 4"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              )}
              {openRegions.map((region) => (
                <span
                  key={region.id}
                  className="pointer-events-none absolute flex h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md bg-black/75 px-1 text-[11px] font-semibold text-accent ring-1 ring-accent/40"
                  style={{ left: `${(region.bbox[0] / space.width) * 100}%`, top: `${(region.bbox[1] / space.height) * 100}%` }}
                >
                  {regions.indexOf(region) + 1}
                </span>
              ))}

              {detecting && <BusyOverlay>Looking for gaps in the layout…</BusyOverlay>}
              {generating && <BusyOverlay>Generating {CANDIDATES} candidates…</BusyOverlay>}
            </div>

            {/* Hover card: why the detector flagged this region. */}
            {hoveredRegion && (
              <div
                className="pointer-events-none absolute z-20 w-64 -translate-x-1/2 animate-rise rounded-xl border border-white/10 bg-surface/95 p-3 text-left shadow-2xl backdrop-blur"
                style={
                  (hoveredRegion.bbox[1] + hoveredRegion.bbox[3]) / space.height > 0.72
                    ? { left: `${((hoveredRegion.bbox[0] + hoveredRegion.bbox[2] / 2) / space.width) * 100}%`, bottom: `${(1 - hoveredRegion.bbox[1] / space.height) * 100 + 1.5}%` }
                    : { left: `${((hoveredRegion.bbox[0] + hoveredRegion.bbox[2] / 2) / space.width) * 100}%`, top: `${((hoveredRegion.bbox[1] + hoveredRegion.bbox[3]) / space.height) * 100 + 1.5}%` }
                }
              >
                <p className="text-[13px] leading-5 text-zinc-200">{hoveredRegion.reason}</p>
                <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-400">
                  <Badge tone="accent">{Math.round(hoveredRegion.confidence * 100)}% confident</Badge>
                  {(hoveredRegion.siblings?.length ?? 0) > 0 && (
                    <span className="text-sky-300">
                      matches {hoveredRegion.siblings.length} similar {hoveredRegion.siblings.length === 1 ? "block" : "blocks"}
                    </span>
                  )}
                  {!(selection?.kind === "region" && selection.regionId === hoveredRegion.id) && <span>click to select</span>}
                </p>
              </div>
            )}
          </FitBox>
        </div>

        <div className="pointer-events-none absolute inset-x-3 top-3 z-30 flex flex-wrap items-center gap-2">
          <Segmented
            className="pointer-events-auto"
            value={tool}
            onChange={(next) => {
              setTool(next);
              if (next === "select") clearMaskCanvas();
            }}
            options={[
              { value: "select", label: <><CursorIcon /> Select</>, title: "Click a detected gap" },
              { value: "box", label: <><BoxSelectIcon /> Box</>, title: "Drag a rectangle to fill" },
              { value: "brush", label: <><BrushIcon /> Brush</>, title: "Paint the area to fill" },
            ]}
          />
          {tool === "brush" && (
            <div className="pointer-events-auto flex h-9 items-center gap-2.5 rounded-xl border border-white/10 bg-black/55 px-3 backdrop-blur">
              <span className="text-xs text-zinc-400">Size</span>
              <input
                type="range"
                aria-label="Brush size"
                className="slider !w-24"
                min={8}
                max={Math.max(64, Math.round(Math.max(width, height) * 0.15))}
                step={2}
                value={brushSize}
                onChange={(e) => setBrushSize(Number(e.target.value))}
                style={{ "--fill": `${((brushSize - 8) / (Math.max(64, Math.round(Math.max(width, height) * 0.15)) - 8)) * 100}%` } as CSSProperties}
              />
              <Button size="sm" variant="primary" disabled={!painted} onClick={selectPainted}>
                Use mask
              </Button>
              <Button size="sm" variant="ghost" disabled={!painted} onClick={clearMaskCanvas}>
                Clear
              </Button>
            </div>
          )}
          <div className="pointer-events-auto ml-auto flex items-center gap-2">
            <Button size="sm" variant="glass" disabled={index === 0 || generating} onClick={() => setIndex((i) => Math.max(0, i - 1))}>
              <UndoIcon />
              Undo
            </Button>
            <Button size="sm" variant="glass" onClick={() => void downloadBase64AsPng(current.image, "design.png").catch((e) => setError(errorMessage(e)))}>
              <DownloadIcon />
              Export PNG
            </Button>
            <Button size="sm" variant="glass" onClick={startOver}>
              <UploadIcon />
              New
            </Button>
          </div>
        </div>
      </Stage>

      {/* Version history: every applied fill, newest last. */}
      <div className="thin-scroll flex shrink-0 items-center gap-2 overflow-x-auto rounded-2xl border border-white/[0.08] bg-surface/80 p-2">
        <span className="px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">History</span>
        {versions.map((version, i) => (
          <button
            key={`${version.id}-${i}`}
            type="button"
            disabled={generating}
            onClick={() => setIndex(i)}
            title={i === index ? `${version.label} (current)` : `Go back to ${version.label}`}
            className={cn(
              "group relative h-14 shrink-0 overflow-hidden rounded-lg border transition-colors",
              i === index ? "border-accent" : "border-white/10 opacity-70 hover:opacity-100",
            )}
            style={{ aspectRatio: `${width} / ${height}` }}
          >
            <img src={toDataUrl(version.image)} alt={version.label} className="h-full w-full object-cover" draggable={false} />
            <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-px text-center text-[10px] text-zinc-200">{version.label}</span>
          </button>
        ))}
        {versions.length === 1 && <span className="px-2 text-xs text-zinc-600">Applied fills appear here. Undo steps back through them.</span>}
      </div>
    </Workspace>
  );
}
