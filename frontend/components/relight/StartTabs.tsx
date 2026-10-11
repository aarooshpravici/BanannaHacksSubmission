"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { DEMO, MOCK } from "@/lib/config";
import { type Draft, type DraftsState, MAX_DRAFTS, deleteAllDrafts, deleteDraft, refreshDrafts, whenChanged } from "@/lib/drafts";

export type StartTab = "samples" | "drafts";

const TABS: { value: StartTab; label: string }[] = [
  { value: "samples", label: "Samples" },
  { value: "drafts", label: "Drafts" },
];

/**
 * With no drafts. The last sentence is only true where the photo is analysed in
 * the browser (the static demo, mock mode). With a Relight server the photo is
 * sent there to be analysed, and what stays on the device is the draft.
 */
const NO_DRAFTS = `No drafts yet. A photo you upload is kept here, on this device, with the light where you left it. ${DEMO || MOCK ? "Nothing is uploaded." : "The draft is not sent anywhere."}`;
const KEPT_NOTE = `Kept in this browser, on this device only. The ${MAX_DRAFTS} most recent are kept.`;
/** The browser's storage is switched off, full, or not answering (lib/drafts.ts). Not an error of the page's, so it is a quiet line and not a red bar. */
const DRAFTS_OFF = "Drafts cannot be kept in this browser. Everything else works without them.";
/** How often the list is read again while it is on screen, in milliseconds: keeps "5 minutes ago" true, and shows what another tab has saved. */
const REFRESH_MS = 60_000;

interface DraftsPanelProps {
  drafts: DraftsState;
  /** The id of the draft, or the name of the sample, that is being opened: nothing else can be until it is. */
  opening: string | null;
  onOpen: (draft: Draft) => void;
  /** A line about the draft that was last asked for, when it could not be opened. */
  note: string | null;
  /** Deleting takes the button that was pressed off the page: the keyboard is put back on the Drafts tab. */
  focusTab: () => void;
}

/** The Drafts tab's content: the user's own photos that this browser has kept, and nothing else. */
function DraftsPanel({ drafts, opening, onOpen, note, focusTab }: DraftsPanelProps) {
  // "Delete all drafts" asks once more. `declined` puts the keyboard back on the button the question took the place of.
  const [confirm, setConfirm] = useState<"idle" | "asking" | "declined">("idle");
  const count = drafts.drafts.length;

  useEffect(() => {
    refreshDrafts();
    const timer = setInterval(refreshDrafts, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      {note && (
        <p role="status" className="mb-3 text-sm leading-5 text-zinc-300">
          {note}
        </p>
      )}
      {/* Nothing until the storage has answered, so that "No drafts yet" never flashes up before the drafts do. */}
      {drafts.loaded && count === 0 && <p className="text-sm leading-5 text-zinc-400">{drafts.problem ? DRAFTS_OFF : NO_DRAFTS}</p>}
      {count > 0 && (
        <>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {drafts.drafts.map((draft) => {
              const when = whenChanged(draft.updatedAt, drafts.at);
              return (
                // Two buttons side by side, not one inside the other: deleting must not be something a click on the card can do.
                <li
                  key={draft.id}
                  className={cn(
                    "relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition-colors hover:border-accent/60 hover:bg-white/[0.07]",
                    opening !== null && opening !== draft.id && "opacity-50",
                  )}
                >
                  <button
                    type="button"
                    disabled={opening !== null}
                    aria-label={`Draft: ${draft.name}, changed ${when}`}
                    onClick={() => onOpen(draft)}
                    className="block w-full rounded-xl text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent/70 disabled:cursor-progress"
                  >
                    {draft.thumb ? (
                      <img src={draft.thumb} alt="" draggable={false} className="aspect-[4/3] w-full object-cover" />
                    ) : (
                      <span className="block aspect-[4/3] w-full bg-black/40" />
                    )}
                    <span className="block truncate px-2 pt-1.5 text-xs font-medium text-zinc-300">{draft.name}</span>
                    <span className="block truncate px-2 pb-1.5 text-[11px] leading-4 text-zinc-500">{when}</span>
                  </button>
                  <button
                    type="button"
                    disabled={opening !== null}
                    aria-label={`Delete draft: ${draft.name}`}
                    onClick={() => void deleteDraft(draft.id).then(focusTab)}
                    className="absolute right-1.5 top-1.5 h-7 rounded-lg border border-white/10 bg-black/55 px-2 text-xs font-medium text-zinc-100 backdrop-blur transition-colors hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="text-xs leading-4 text-zinc-500">{KEPT_NOTE}</p>
            {/* One draft has its own Delete, which is all "Delete all" could do. */}
            {count > 1 &&
              (confirm === "asking" ? (
                <div role="group" aria-label={`Delete all ${count} drafts?`} className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-zinc-200">Delete all {count} drafts?</span>
                  <Button size="sm" onClick={() => void deleteAllDrafts().then(focusTab)}>
                    Delete
                  </Button>
                  <Button size="sm" variant="ghost" autoFocus onClick={() => setConfirm("declined")}>
                    Keep
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" autoFocus={confirm === "declined"} onClick={() => setConfirm("asking")}>
                  Delete all drafts
                </Button>
              ))}
          </div>
          {drafts.problem && <p className="mt-2 text-xs leading-4 text-zinc-400">{DRAFTS_OFF}</p>}
        </>
      )}
    </>
  );
}

interface StartTabsProps extends Omit<DraftsPanelProps, "focusTab"> {
  tab: StartTab;
  onTab: (tab: StartTab) => void;
  /** The sample photos, exactly as the first page showed them before it had tabs. */
  samples: ReactNode;
}

/**
 * The two tabs under the drop box on the first page: the built-in sample
 * photos, and the drafts this browser has kept of the user's own photos
 * (lib/drafts.ts). Tabs in the full sense: the arrow keys move between them and
 * a screen reader is told which panel belongs to which.
 *
 * From 40rem (Tailwind's sm) the two sit at the right-hand end of the line
 * that says "Or try a sample photo:", and take no room of their own: the first
 * page was fitted to a 1280 x 720 window to the pixel, thumbnails and all, and
 * has none to give. A phone has no room on that line, and scrolls anyway, so
 * there they are a row of their own above it.
 */
export function StartTabs({ tab, onTab, samples, drafts, opening, onOpen, note }: StartTabsProps) {
  const id = useId();
  const buttons = useRef<Partial<Record<StartTab, HTMLButtonElement | null>>>({});
  const count = drafts.drafts.length;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((t) => t.value === tab);
    const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length].value;
    onTab(next);
    buttons.current[next]?.focus();
  };

  return (
    <div className="mt-4 sm:mt-0">
      {/* sm: moved down onto the samples' first line (their own top margin, then the line) and taking no height. Drawn above that line, which is as wide as the page and would otherwise take the clicks. */}
      <div
        role="tablist"
        aria-label="Sample photos and drafts"
        onKeyDown={onKeyDown}
        className="flex gap-5 border-b border-white/[0.08] sm:relative sm:top-3 sm:z-10 sm:-mb-7 sm:ml-auto sm:w-fit sm:border-b-0"
      >
        {TABS.map((t) => {
          const selected = t.value === tab;
          return (
            <button
              key={t.value}
              ref={(button) => {
                buttons.current[t.value] = button;
              }}
              type="button"
              role="tab"
              id={`${id}-${t.value}`}
              aria-selected={selected}
              aria-controls={selected ? `${id}-panel` : undefined}
              // Tab reaches the selected one only; the arrow keys move between the two.
              tabIndex={selected ? 0 : -1}
              onClick={() => onTab(t.value)}
              className={cn(
                "-mb-px flex h-9 items-center gap-1.5 rounded-t-md border-b-2 px-0.5 text-[13px] font-semibold uppercase tracking-[0.08em] transition-colors sm:mb-0 sm:h-7",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70",
                selected ? "border-accent text-accent" : "border-transparent text-zinc-400 hover:text-zinc-100",
              )}
            >
              {t.label}
              {t.value === "drafts" && count > 0 && (
                <span className={cn("rounded-full px-1.5 py-px font-mono text-[11px] leading-4 tracking-normal tabular-nums", selected ? "bg-accent/15" : "bg-white/10 text-zinc-300")}>{count}</span>
              )}
            </button>
          );
        })}
      </div>
      {tab === "samples" ? (
        <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-samples`}>
          {samples}
        </div>
      ) : (
        <div className="grid">
          {/* The first page is centred in the window, so a shorter panel would move everything on it, the tabs included, from under the pointer. The samples lie unseen under the drafts and keep this panel at least as tall as theirs. */}
          <div aria-hidden inert className="invisible col-start-1 row-start-1">
            {samples}
          </div>
          {/* With no draft there is no button in the panel for the Tab key to land on, so the panel itself takes it. sm: the drafts start where the sample thumbnails do, under the tabs. */}
          <div
            role="tabpanel"
            id={`${id}-panel`}
            aria-labelledby={`${id}-drafts`}
            tabIndex={count === 0 ? 0 : undefined}
            className="col-start-1 row-start-1 mt-4 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent/70 sm:mt-11"
          >
            <DraftsPanel drafts={drafts} opening={opening} onOpen={onOpen} note={note} focusTab={() => buttons.current.drafts?.focus()} />
          </div>
        </div>
      )}
    </div>
  );
}
