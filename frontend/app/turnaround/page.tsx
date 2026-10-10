"use client";

import { useRef, useState } from "react";
import { ErrorBanner } from "@/components/ErrorBanner";
import { PageIntro, Panel, Stage, Workspace } from "@/components/Panel";
import { ScoreBars } from "@/components/ScoreBars";
import { BusyOverlay, Skeleton, Spinner } from "@/components/Spinner";
import { UploadDropzone } from "@/components/UploadDropzone";
import { AlertIcon, CheckIcon, DownloadIcon, MinusIcon, RefreshIcon, UploadIcon, XIcon } from "@/components/icons";
import { FeatureChecklist, VIEW_LABELS, VIEW_NAMES } from "@/components/turnaround/FeatureChecklist";
import { Badge, Button } from "@/components/ui";
import { errorMessage, turnaroundAnalyze, turnaroundGenerate } from "@/lib/api";
import { cn } from "@/lib/cn";
import { type LoadedImage, downloadBase64AsPng, toDataUrl } from "@/lib/image";
import { sampleCharacter } from "@/lib/samples";
import { type AnalyzeOut, type ChecklistItem, type Feature, VIEWS, type View, type ViewResult } from "@/lib/types";
import { type Job, useJob } from "@/lib/useJob";

/** The three outcomes that matter for a checklist item, plus the uneventful one. */
function verdict(item: ChecklistItem): { tone: "good" | "bad" | "warn" | "neutral"; text: string } {
  if (item.expected_visible && item.present) return { tone: "good", text: "Visible, as expected" };
  if (item.expected_visible) return { tone: "bad", text: "Missing: should be visible" };
  if (item.present) return { tone: "warn", text: "Shown: should be hidden in this view" };
  return { tone: "neutral", text: "Hidden, as expected" };
}

const VERDICT_STYLE = {
  good: "bg-emerald-400/15 text-emerald-300",
  bad: "bg-rose-500/15 text-rose-300",
  warn: "bg-amber-400/15 text-amber-300",
  neutral: "bg-white/[0.07] text-zinc-400",
} as const;

function VerdictIcon({ tone }: { tone: keyof typeof VERDICT_STYLE }) {
  const Icon = tone === "good" ? CheckIcon : tone === "bad" ? XIcon : tone === "warn" ? AlertIcon : MinusIcon;
  return (
    <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full", VERDICT_STYLE[tone])}>
      <Icon className="h-3 w-3" />
    </span>
  );
}

export default function TurnaroundPage() {
  const [upload, setUpload] = useState<LoadedImage | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeOut | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [edited, setEdited] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<View | null>(null); // the view on screen
  /** Which image of a view's result is displayed: null = the winner, n = alternates[n]. */
  const [alternate, setAlternate] = useState<Partial<Record<View, number | null>>>({});
  /** The checklist each view was generated against, for naming its checklist items. */
  const [sent, setSent] = useState<Partial<Record<View, Feature[]>>>({});

  // One job per view, so several views can generate at once.
  const jobs: Record<View, Job<ViewResult>> = {
    front: useJob<ViewResult>(),
    three_quarter: useJob<ViewResult>(),
    side: useJob<ViewResult>(),
    back: useJob<ViewResult>(),
  };
  const request = useRef(0);

  const resetViews = () => {
    for (const v of VIEWS) jobs[v].reset();
    setView(null);
    setAlternate({});
    setSent({});
  };

  const analyze = async (image: LoadedImage) => {
    const id = ++request.current;
    resetViews();
    setUpload(image);
    setAnalysis(null);
    setFeatures([]);
    setEdited(false);
    setError(null);
    setLoading(true);
    try {
      const out = await turnaroundAnalyze({ image: image.base64 });
      if (request.current !== id) return;
      setAnalysis(out);
      setFeatures(out.spec.features);
    } catch (e) {
      if (request.current === id) setError(errorMessage(e));
    } finally {
      if (request.current === id) setLoading(false);
    }
  };

  const startOver = () => {
    request.current++;
    resetViews();
    setUpload(null);
    setAnalysis(null);
    setFeatures([]);
    setEdited(false);
    setLoading(false);
    setError(null);
  };

  const generate = (target: View) => {
    if (!analysis) return;
    const checklist = features.map((f) => ({ ...f, name: f.name.trim() })).filter((f) => f.name);
    setView(target);
    setAlternate((a) => ({ ...a, [target]: null }));
    setSent((s) => ({ ...s, [target]: checklist }));
    void jobs[target].run(() =>
      // The schema wants the checklist only when the user changed it.
      turnaroundGenerate({ character_id: analysis.character_id, target_view: target, features: edited ? checklist : null }),
    );
  };

  if (!upload) {
    return (
      <PageIntro
        eyebrow="Character views"
        title="One drawing in. Consistent views out."
        lead="Upload a character. We list the features that make it recognisable, generate the views you ask for, and check each one against that list, retrying when something is missing or shows up where it should not."
      >
        <UploadDropzone onImage={(image) => void analyze(image)} format="png" title="Drop a character here" sample={{ label: "Use a sample character", make: sampleCharacter }} />
      </PageIntro>
    );
  }

  const sourceView = analysis?.source_view ?? null;
  const job = view ? jobs[view] : null;
  const result = job?.result ?? null;
  const altIndex = view ? (alternate[view] ?? null) : null;
  const shownImage = result ? (altIndex !== null && result.alternates[altIndex] ? result.alternates[altIndex].image : result.image) : null;
  const nameOf = (featureId: string) => {
    const pool = (view && sent[view]) || features;
    return pool.find((f) => f.id === featureId)?.name || analysis?.spec.features.find((f) => f.id === featureId)?.name || featureId;
  };
  const isCritical = (featureId: string) => ((view && sent[view]) || features).find((f) => f.id === featureId)?.critical ?? false;
  const failed = result ? result.checklist.filter((item) => item.present !== item.expected_visible).length : 0;

  return (
    <Workspace
      sidebar={
        <>
          <Panel title="Character">
            {analysis ? (
              <div className="flex flex-col gap-3.5">
                <p className="text-sm leading-6 text-zinc-300">{analysis.spec.summary}</p>
                <dl className="grid grid-cols-[5.5rem_1fr] gap-y-2 text-[13px]">
                  <dt className="text-zinc-500">Art style</dt>
                  <dd className="text-zinc-200">{analysis.spec.art_style}</dd>
                  <dt className="text-zinc-500">Source view</dt>
                  <dd>
                    <Badge tone="accent">{VIEW_LABELS[analysis.source_view]}</Badge>
                  </dd>
                  <dt className="self-center text-zinc-500">Palette</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {analysis.spec.palette.map((color, i) => (
                      <span key={`${color}-${i}`} title={color} className="h-6 w-6 rounded-md ring-1 ring-white/15" style={{ background: color }} />
                    ))}
                  </dd>
                </dl>
              </div>
            ) : loading ? (
              <div className="flex flex-col gap-2.5">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="mt-2 h-6 w-40" />
              </div>
            ) : (
              <p className="text-sm text-zinc-500">The analysis did not finish.</p>
            )}
          </Panel>

          {view && result && (
            <Panel
              title={`Check: ${VIEW_LABELS[view]} view`}
              actions={failed === 0 ? <Badge tone="good">all passed</Badge> : <Badge tone="bad">{failed} failed</Badge>}
            >
              <ScoreBars
                scores={{ identity: result.scores.identity, palette: result.scores.palette, checklist: result.scores.checklist }}
                total={result.scores.total}
              />
              <ul className="mt-4 flex flex-col gap-2">
                {result.checklist.map((item) => {
                  const v = verdict(item);
                  return (
                    <li key={item.feature_id} className="flex items-start gap-2.5">
                      <VerdictIcon tone={v.tone} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-200">
                          <span className="truncate">{nameOf(item.feature_id)}</span>
                          {isCritical(item.feature_id) && <Badge tone={v.tone === "bad" ? "bad" : "neutral"}>critical</Badge>}
                        </span>
                        <span className={cn("block text-xs", v.tone === "bad" ? "text-rose-300" : v.tone === "warn" ? "text-amber-300" : "text-zinc-500")}>{v.text}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}

          <Panel
            title="Feature checklist"
            hint="Every generated view is checked against this list. Starred features are critical. Edit it before you generate."
            actions={
              edited && analysis ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setFeatures(analysis.spec.features);
                    setEdited(false);
                  }}
                >
                  Reset
                </Button>
              ) : undefined
            }
          >
            {analysis ? (
              <>
                <FeatureChecklist
                  features={features}
                  onChange={(next) => {
                    setFeatures(next);
                    setEdited(true);
                  }}
                />
                {edited && <p className="mt-3 text-xs leading-4 text-accent/90">Edited. Your list is sent with the next view you generate.</p>}
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-[4.5rem]" />
                <Skeleton className="h-[4.5rem]" />
                <Skeleton className="h-[4.5rem]" />
              </div>
            )}
          </Panel>

        </>
      }
    >
      <ErrorBanner message={error} onDismiss={() => setError(null)} onRetry={analysis ? undefined : () => void analyze(upload)} />

      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-2">
        {/* Original */}
        <Stage className="checker min-h-72">
          <img
            src={toDataUrl(analysis?.cutout ?? upload.base64)}
            alt="Original character"
            draggable={false}
            className="absolute inset-0 h-full w-full object-contain p-8 pt-14"
          />
          <div className="absolute left-3 top-3 flex items-center gap-2">
            <span className="rounded-lg bg-black/65 px-2.5 py-1 text-xs font-medium text-zinc-100 backdrop-blur">Original</span>
            {sourceView && <Badge tone="accent" className="bg-black/65 backdrop-blur">{VIEW_LABELS[sourceView]} view</Badge>}
          </div>
          <Button size="sm" variant="glass" className="absolute right-3 top-3" onClick={startOver}>
            <UploadIcon />
            New
          </Button>
          {loading && <BusyOverlay>Cutting out the character and listing its features…</BusyOverlay>}
        </Stage>

        {/* Result */}
        <Stage className="checker min-h-72">
          {view && shownImage && (
            <img key={`${view}-${altIndex ?? "best"}`} src={toDataUrl(shownImage)} alt={`${VIEW_NAMES[view]} view`} draggable={false} className="absolute inset-0 h-full w-full animate-rise object-contain p-8 pt-14" />
          )}
          {!view && (
            <div className="absolute inset-0 flex items-center justify-center bg-ink/70 p-8 text-center">
              <p className="max-w-xs text-sm leading-6 text-zinc-400">
                {analysis ? "Pick a view below to generate it. You can start several at once." : "The views appear here once the character is analysed."}
              </p>
            </div>
          )}
          {view && job?.status === "pending" && <BusyOverlay>Generating the {VIEW_NAMES[view]} view, then checking it…</BusyOverlay>}
          {view && job?.status === "error" && (
            <div className="absolute inset-0 flex items-center justify-center bg-ink/70 p-6">
              <ErrorBanner message={job.error} onRetry={() => generate(view)} className="max-w-sm" />
            </div>
          )}
          {view && (
            <div className="absolute left-3 top-3 flex flex-wrap items-center gap-2">
              <span className="rounded-lg bg-black/65 px-2.5 py-1 text-xs font-medium text-zinc-100 backdrop-blur">{VIEW_LABELS[view]} view</span>
              {result && result.retries > 0 && (
                <Badge tone="accent" className="bg-black/65 backdrop-blur">
                  <RefreshIcon className="h-3 w-3" />
                  fixed after {result.retries} {result.retries === 1 ? "retry" : "retries"}
                </Badge>
              )}
              {result && altIndex !== null && <Badge className="bg-black/65 backdrop-blur">alternate {altIndex + 1}</Badge>}
            </div>
          )}
          {view && result && shownImage && (
            <div className="absolute right-3 top-3 flex items-center gap-2">
              <Button size="sm" variant="glass" onClick={() => generate(view)}>
                <RefreshIcon />
                Regenerate
              </Button>
              <Button
                size="sm"
                variant="glass"
                onClick={() => void downloadBase64AsPng(shownImage, `character-${view}.png`).catch((e) => setError(errorMessage(e)))}
              >
                <DownloadIcon />
                Download PNG
              </Button>
            </div>
          )}
        </Stage>
      </div>

      {/* Alternates: the runners-up from the same generation. */}
      {view && result && result.alternates.length > 0 && (
        <div className="thin-scroll flex shrink-0 items-center gap-2 overflow-x-auto rounded-2xl border border-white/[0.08] bg-surface/80 p-2">
          <span className="px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Alternates</span>
          {[{ image: result.image, total: result.scores.total, index: null as number | null }, ...result.alternates.map((a, i) => ({ ...a, index: i as number | null }))].map((option) => (
            <button
              key={option.index ?? "best"}
              type="button"
              onClick={() => setAlternate((a) => ({ ...a, [view]: option.index }))}
              title={option.index === null ? "The winner" : `Alternate ${option.index + 1}`}
              className={cn(
                "checker relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border transition-colors",
                option.index === altIndex ? "border-accent" : "border-white/10 opacity-75 hover:opacity-100",
              )}
            >
              <img src={toDataUrl(option.image)} alt="" draggable={false} className="h-full w-full object-contain" />
              <span className="absolute inset-x-0 bottom-0 bg-black/70 py-px text-center font-mono text-[10px] text-zinc-200">
                {option.index === null ? "best " : ""}
                {Math.round(option.total * 100)}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* The four views. */}
      <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
        {VIEWS.map((v) => {
          const isSource = v === sourceView;
          const state = jobs[v];
          const selected = v === view;
          return (
            <button
              key={v}
              type="button"
              disabled={!analysis || isSource}
              title={isSource ? "This is the view you uploaded" : undefined}
              onClick={() => (state.status === "done" || state.status === "pending" ? setView(v) : generate(v))}
              className={cn(
                "flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed",
                selected ? "border-accent/70 bg-accent/10" : "border-white/[0.08] bg-surface/80 hover:border-white/25",
                (!analysis || isSource) && "opacity-50 hover:border-white/[0.08]",
              )}
            >
              <span>
                <span className="block text-sm font-semibold text-zinc-100">{VIEW_LABELS[v]}</span>
                <span className="mt-0.5 block text-xs text-zinc-500">
                  {isSource
                    ? "source view"
                    : state.status === "pending"
                      ? "generating…"
                      : state.status === "done"
                        ? "ready, click to view"
                        : state.status === "error"
                          ? "failed, click to retry"
                          : "click to generate"}
                </span>
              </span>
              {state.status === "pending" && <Spinner className="text-accent" />}
              {state.status === "done" && state.result && (
                <span className="font-mono text-sm font-semibold tabular-nums text-accent">{Math.round(state.result.scores.total * 100)}</span>
              )}
              {state.status === "error" && <AlertIcon className="text-rose-400" />}
            </button>
          );
        })}
      </div>
    </Workspace>
  );
}
