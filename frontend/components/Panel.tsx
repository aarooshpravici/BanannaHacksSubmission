import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A titled card: the unit every sidebar is built from. */
export function Panel({
  title,
  hint,
  actions,
  className,
  children,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("rounded-2xl border border-white/[0.08] bg-surface/80 p-3.5 backdrop-blur", className)}>
      {(title || actions) && (
        <header className="mb-2.5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-zinc-400">{title}</h2>}
            {hint && <p className="mt-0.5 text-xs leading-4 text-zinc-500">{hint}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * The page layout: a large working area on the left
 * and a scrolling sidebar of panels on the right. On narrow screens they stack.
 */
export function Workspace({ children, sidebar }: { children: ReactNode; sidebar: ReactNode }) {
  return (
    <div className="mx-auto grid w-full max-w-[1680px] flex-1 content-start gap-4 p-4 lg:h-[calc(100dvh-3.5rem)] lg:flex-none lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-[minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3 lg:min-h-0">{children}</div>
      <aside className="thin-scroll flex min-w-0 flex-col gap-2.5 lg:min-h-0 lg:overflow-y-auto lg:pr-1">{sidebar}</aside>
    </div>
  );
}

/**
 * The dark surface the image being worked on sits on. Fills the space it is given.
 *
 * On screens too narrow for the sidebar the page stacks and scrolls, so there
 * is no given space: with `hug` the stage is as tall as an image of that size
 * needs (see .stage-hug in globals.css), which keeps the first controls on screen.
 */
export function Stage({ hug, className, children }: { hug?: { width: number; height: number }; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn("relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/[0.08] bg-black/50", hug && "stage-hug", className)}
      style={hug ? ({ "--stage-ratio": hug.height / hug.width } as CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}

/**
 * Fits a box of the given pixel aspect ratio inside its (positioned, sized)
 * parent, centred, as large as possible. Children are laid out relative to
 * the box, so overlays can use percentages of the image.
 */
export function FitBox({
  width,
  height,
  className,
  style,
  children,
}: {
  width: number;
  height: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className="absolute inset-0" style={{ containerType: "size" }}>
      <div
        className={cn("absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2", className)}
        style={{ width: `min(100cqw, ${width / height} * 100cqh)`, aspectRatio: `${width} / ${height}`, ...style }}
      >
        {children}
      </div>
    </div>
  );
}

/** The centred intro the page shows before anything is uploaded. */
export function PageIntro({ eyebrow, title, lead, children }: { eyebrow: string; title: string; lead: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-4 py-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{eyebrow}</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white sm:text-5xl">{title}</h1>
      <p className="mt-4 max-w-xl text-base leading-7 text-zinc-400">{lead}</p>
      <div className="mt-6">{children}</div>
    </div>
  );
}
