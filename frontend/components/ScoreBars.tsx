import { cn } from "@/lib/cn";

interface ScoreBarsProps {
  /** Named scores in 0..1. A "total" key is ignored here; pass it as `total`. */
  scores: Record<string, number>;
  /** The combined score, shown as its own row at the bottom. */
  total?: number;
  /** Tighter rows, for use inside cards. */
  compact?: boolean;
  className?: string;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
const pretty = (name: string) => name.replace(/_/g, " ");

function barColor(value: number): string {
  if (value >= 0.75) return "bg-emerald-400";
  if (value >= 0.5) return "bg-amber-400";
  return "bg-rose-400";
}

function Row({ name, value, compact, strong }: { name: string; value: number; compact: boolean; strong?: boolean }) {
  const v = clamp01(value);
  return (
    <div className={cn("grid items-center gap-2", compact ? "grid-cols-[4.2rem_1fr_1.8rem] text-[11px]" : "grid-cols-[5.5rem_1fr_2.2rem] text-[13px]")}>
      <span className={cn("truncate capitalize", strong ? "font-semibold text-zinc-100" : "text-zinc-400")}>{pretty(name)}</span>
      <span
        role="meter"
        aria-label={pretty(name)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
        className={cn("overflow-hidden rounded-full bg-white/10", compact ? "h-1" : "h-1.5")}
      >
        <span className={cn("block h-full rounded-full transition-[width] duration-500", strong ? "bg-accent" : barColor(v))} style={{ width: `${v * 100}%` }} />
      </span>
      <span className={cn("text-right font-mono tabular-nums", strong ? "font-semibold text-accent" : "text-zinc-300")}>{Math.round(v * 100)}</span>
    </div>
  );
}

/** Named 0..1 scores as labelled bars, plus a total. */
export function ScoreBars({ scores, total, compact = false, className }: ScoreBarsProps) {
  const entries = Object.entries(scores).filter(([name]) => name !== "total");
  return (
    <div className={cn("flex flex-col", compact ? "gap-1" : "gap-2", className)}>
      {entries.map(([name, value]) => (
        <Row key={name} name={name} value={value} compact={compact} />
      ))}
      {total !== undefined && (
        <div className={cn("border-t border-white/[0.08]", compact ? "mt-0.5 pt-1.5" : "mt-1 pt-2.5")}>
          <Row name="total" value={total} compact={compact} strong />
        </div>
      )}
    </div>
  );
}
