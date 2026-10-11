"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { XIcon } from "./icons";
import { cn } from "@/lib/cn";

/**
 * A yellow "?" beside a control's name. It opens a few lines that say what the
 * control does, for where the page has no room to print them: beside the stage
 * a slider has no line under it on a laptop window, and a phone has no hover
 * text. A tester who had never seen Height explained asked for it. The first
 * "?" was grey and he did not see it at all; the second read "What is this?",
 * which he found too much. Hence a "?" again, in the page's yellow, and `show`.
 *
 * The box is laid out against the nearest positioned ancestor (the control),
 * just under it, so the control stays in view and can be tried while the box
 * is open.
 */
export function Help({
  about,
  show = false,
  children,
}: {
  about: string;
  /** True once the reader has used the control by hand. The box then opens by itself, once, unless it has been opened before. */
  show?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Whether the box has been on screen yet: it opens by itself only if it has not.
  const [seen, setSeen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const id = useId();

  if (show && !seen) {
    setSeen(true);
    setOpen(true);
  }

  // Closed by Escape, and by a click or a tap anywhere outside the control it explains.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const at = e.target as Node;
      const control = box.current?.offsetParent;
      if (!button.current?.contains(at) && !box.current?.contains(at) && !control?.contains(at)) setOpen(false);
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
        onClick={() => {
          setSeen(true);
          setOpen((o) => !o);
        }}
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-accent text-[11px] font-bold leading-none transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70",
          open ? "bg-accent text-black" : "bg-accent/20 text-accent hover:bg-accent/40",
        )}
      >
        ?
      </button>
      {open && (
        // A click on the words must not reach whatever the box happens to lie over.
        <span
          ref={box}
          id={id}
          role="note"
          onClick={(e) => e.preventDefault()}
          className="absolute inset-x-0 top-full z-30 mt-1.5 block cursor-default space-y-1.5 rounded-xl border border-white/15 bg-surface py-3 pl-3 pr-9 text-xs font-normal leading-5 text-zinc-300 shadow-2xl"
        >
          {/* In the corner, and first for the Tab key. The words keep clear of it (pr-9). */}
          <button
            type="button"
            aria-label="Close"
            onClick={() => {
              setOpen(false);
              button.current?.focus();
            }}
            className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-white/10 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/70"
          >
            <XIcon />
          </button>
          {children}
        </span>
      )}
    </>
  );
}
