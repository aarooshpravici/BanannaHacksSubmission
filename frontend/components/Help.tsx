"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A small "?" beside a control's name. It opens a few lines that say what the
 * control does, for where the page has no room to print them: beside the stage
 * a slider has no line under it on a laptop window, and a phone has no hover
 * text. A tester who had never seen Height explained asked for it.
 *
 * The box is laid out against the nearest positioned ancestor, just under it,
 * so the control itself stays in view and can be tried while the box is open.
 */
export function Help({ about, children }: { about: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const id = useId();

  // Closed by Escape, and by a click or a tap anywhere else.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const at = e.target as Node;
      if (!button.current?.contains(at) && !box.current?.contains(at)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`What ${about} does`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold leading-none transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70",
          open ? "border-accent/60 bg-accent/15 text-accent" : "border-white/25 text-zinc-400 hover:border-white/50 hover:text-zinc-100",
        )}
      >
        ?
      </button>
      {open && (
        // Inside a <label>, a click on the words would otherwise be passed on to the slider.
        <span
          ref={box}
          id={id}
          role="note"
          onClick={(e) => e.preventDefault()}
          className="absolute inset-x-0 top-full z-30 mt-1.5 block cursor-default space-y-1.5 rounded-xl border border-white/15 bg-surface p-3 text-xs font-normal leading-5 text-zinc-300 shadow-2xl"
        >
          {children}
        </span>
      )}
    </>
  );
}
