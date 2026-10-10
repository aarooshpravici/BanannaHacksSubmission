"use client";

import { type ReactNode, useId, useRef, useState } from "react";
import { ChevronDownIcon } from "./icons";
import { cn } from "@/lib/cn";

/**
 * A Panel whose body is folded away until its header is clicked, for content
 * that is good to have but not needed to use the page. `peek` sits in the
 * header while it is closed, so it is clear there is something inside.
 */
export function CollapsiblePanel({
  title,
  peek,
  defaultOpen = false,
  children,
}: {
  title: string;
  peek?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const body = useRef<HTMLDivElement>(null);
  const id = useId();
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-surface/80 backdrop-blur">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
          // The panel is last in a scrolling sidebar: bring what just opened into view.
          if (!open) requestAnimationFrame(() => body.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
        }}
        className="flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
      >
        <span className="text-[13px] font-semibold uppercase tracking-[0.08em] text-zinc-400">{title}</span>
        <span className="ml-auto flex min-w-0 items-center gap-2 text-xs text-zinc-500">
          {!open && peek}
          <span>{open ? "Hide" : "Show"}</span>
        </span>
        <ChevronDownIcon className={cn("text-zinc-400 transition-transform", open && "rotate-180")} />
      </button>
      <div ref={body} id={id} hidden={!open} className="px-3.5 pb-3.5">
        {children}
      </div>
    </section>
  );
}
