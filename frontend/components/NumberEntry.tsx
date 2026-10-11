"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A slider's value, printed beside its name, that can also be typed: click the
 * number, type another, press Enter. For an exact value, or a setting somebody
 * else has sent. A tester asked for it.
 *
 * Enter or a click elsewhere keeps what was typed; Escape, or something that is
 * not a number, leaves the value as it was.
 */
export function NumberEntry({
  about,
  shown,
  text,
  parse,
  onChange,
}: {
  /** The control's name, for a screen reader. */
  about: string;
  /** The value as the page prints it, for example "0.12" or "warm 40". */
  shown: string;
  /** The value as a plain number to start typing from, for example "40". */
  text: string;
  /** What was typed, as a value the slider can take; null if it is not one. */
  parse: (typed: string) => number | null;
  onChange: (value: number) => void;
}) {
  // What is in the box while typing; null when the number is only being shown.
  const [draft, setDraft] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const dropped = useRef(false);
  const typed = useRef(false);

  // After typing, the keyboard's place goes back to the number, so Tab carries on from there.
  useEffect(() => {
    if (draft === null && typed.current) {
      typed.current = false;
      button.current?.focus();
    }
  }, [draft]);

  if (draft === null) {
    return (
      <button
        ref={button}
        type="button"
        title="Click to type a value"
        aria-label={`${about}: ${shown}. Click to type a value`}
        onClick={() => setDraft(text)}
        className="cursor-text rounded font-mono text-xs tabular-nums text-zinc-400 underline decoration-zinc-600 decoration-dotted underline-offset-4 hover:text-zinc-100 hover:decoration-zinc-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
      >
        {shown}
      </button>
    );
  }

  const finish = (keep: boolean) => {
    // Taking the box away can send one more "left the box": only the first ending counts.
    if (dropped.current) return;
    dropped.current = true;
    typed.current = true;
    const value = keep ? parse(draft) : null;
    if (value !== null) onChange(value);
    setDraft(null);
  };

  return (
    <input
      autoFocus
      type="text"
      inputMode="decimal"
      aria-label={`${about}: type a value, then press Enter`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => {
        dropped.current = false;
        e.target.select();
      }}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      className="w-16 rounded border border-accent/60 bg-black/50 px-1 text-right font-mono text-xs tabular-nums text-zinc-100 outline-none"
    />
  );
}
