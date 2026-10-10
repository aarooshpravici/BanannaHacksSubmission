import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { Spinner } from "./Spinner";
import { cn } from "@/lib/cn";

// --- Button ---------------------------------------------------------------------

const BUTTON_VARIANTS = {
  primary: "bg-accent text-black hover:bg-[#ffdf66] shadow-[0_0_24px_-6px] shadow-accent/50",
  secondary: "border border-white/10 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.11]",
  ghost: "text-zinc-300 hover:bg-white/[0.07] hover:text-white",
  /** For buttons that float over an image. */
  glass: "border border-white/10 bg-black/55 text-zinc-100 backdrop-blur hover:bg-black/80",
} as const;

const BUTTON_SIZES = {
  sm: "h-8 gap-1.5 rounded-lg px-2.5 text-[13px]",
  md: "h-10 gap-2 rounded-xl px-4 text-sm",
} as const;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
  /** Shows a spinner and disables the button. */
  busy?: boolean;
}

export function Button({ variant = "secondary", size = "md", busy = false, disabled, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={cn(
        "inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70",
        "disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...rest}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

// --- Slider ---------------------------------------------------------------------

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** How to print the value next to the label. */
  format?: (value: number) => string;
  /** A CSS background for the whole track, replacing the "filled up to the thumb" look. */
  track?: string;
  hint?: string;
}

export function Slider({ label, value, min, max, step = 0.01, onChange, format, track, hint }: SliderProps) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <label className="block">
      <span className="mb-2 flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-medium text-zinc-200">{label}</span>
        <span className="font-mono text-xs tabular-nums text-zinc-400">{format ? format(value) : value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={(track ? { background: track } : { "--fill": `${fill}%` }) as CSSProperties}
      />
      {hint && <span className="mt-1.5 block text-xs leading-4 text-zinc-500">{hint}</span>}
    </label>
  );
}

// --- Toggle ---------------------------------------------------------------------

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}

export function Toggle({ label, checked, onChange, hint }: ToggleProps) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4">
      <span>
        <span className="block text-[13px] font-medium text-zinc-200">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-4 text-zinc-500">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-10 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70",
          checked ? "bg-accent" : "bg-white/15",
        )}
      >
        <span className={cn("absolute left-0.5 top-0.5 h-5 w-5 rounded-full shadow transition-transform", checked ? "translate-x-4 bg-black" : "bg-white")} />
      </button>
    </label>
  );
}

// --- Badge ----------------------------------------------------------------------

const BADGE_TONES = {
  neutral: "border-white/10 bg-white/[0.06] text-zinc-300",
  accent: "border-accent/30 bg-accent/15 text-accent",
  good: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  warn: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  bad: "border-rose-400/30 bg-rose-400/10 text-rose-300",
} as const;

export function Badge({ tone = "neutral", className, children }: { tone?: keyof typeof BADGE_TONES; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4", BADGE_TONES[tone], className)}>
      {children}
    </span>
  );
}

// --- Segmented control ------------------------------------------------------------

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  className?: string;
}

export function Segmented<T extends string>({ value, onChange, options, className }: SegmentedProps<T>) {
  return (
    <div role="tablist" className={cn("inline-flex rounded-xl border border-white/10 bg-black/40 p-0.5 backdrop-blur", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            option.value === value ? "bg-white/[0.14] text-white" : "text-zinc-400 hover:text-zinc-100",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
