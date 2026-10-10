import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" role="status" aria-label="Loading" className={cn("h-4 w-4 animate-spin", className)}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** A shimmering placeholder block; size it with classes. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton rounded-lg", className)} />;
}

/** A spinner with a line of text, for "the server is working on it" moments. */
export function BusyLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5 text-sm text-zinc-300", className)}>
      <Spinner className="text-accent" />
      <span>{children}</span>
    </div>
  );
}

/** Dims whatever it sits on top of and shows a busy label, with a moving scan line. */
export function BusyOverlay({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center overflow-hidden rounded-[inherit] bg-ink/60 backdrop-blur-[2px]">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[10%] animate-scan bg-gradient-to-b from-transparent via-accent/15 to-transparent" />
      <BusyLabel className="rounded-full border border-white/10 bg-surface/90 px-4 py-2 shadow-xl">{children}</BusyLabel>
    </div>
  );
}
