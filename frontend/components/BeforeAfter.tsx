"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/cn";

interface BeforeAfterProps {
  /** Image URLs (data: or blob:). `before` shows left of the divider, `after` right. */
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
  /** Fill the (positioned, sized) parent instead of taking the image's own aspect ratio. */
  fill?: boolean;
  className?: string;
}

/** Two images of the same thing with a draggable divider between them. */
export function BeforeAfter({ before, after, beforeLabel = "Before", afterLabel = "After", fill = false, className }: BeforeAfterProps) {
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(50); // divider, % from the left
  const [aspect, setAspect] = useState<string | undefined>(undefined);

  const moveTo = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setPosition(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
  };

  return (
    <div
      ref={box}
      className={cn("relative touch-none select-none overflow-hidden rounded-xl bg-black/40", fill ? "h-full w-full" : "w-full", className)}
      style={fill ? undefined : { aspectRatio: aspect ?? "4 / 3" }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        moveTo(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) moveTo(e.clientX);
      }}
    >
      <img
        src={after}
        alt={afterLabel}
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
        onLoad={(e) => setAspect(`${e.currentTarget.naturalWidth} / ${e.currentTarget.naturalHeight}`)}
      />
      <img
        src={before}
        alt={beforeLabel}
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
        style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
      />

      <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-zinc-200 backdrop-blur">{beforeLabel}</span>
      <span className="pointer-events-none absolute right-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-zinc-200 backdrop-blur">{afterLabel}</span>

      <div className="pointer-events-none absolute inset-y-0 w-px bg-white/90 shadow-[0_0_8px_rgb(0_0_0/0.6)]" style={{ left: `${position}%` }} />
      <div
        role="slider"
        tabIndex={0}
        aria-label="Comparison divider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setPosition((p) => Math.max(0, p - 4));
          if (e.key === "ArrowRight") setPosition((p) => Math.min(100, p + 4));
        }}
        className="absolute top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border border-white/80 bg-black/70 text-white shadow-lg backdrop-blur focus-visible:outline-2 focus-visible:outline-accent"
        style={{ left: `${position}%` }}
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m9 7-5 5 5 5M15 7l5 5-5 5" />
        </svg>
      </div>
    </div>
  );
}
