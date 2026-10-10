import { cn } from "@/lib/cn";

/**
 * A quiet line above the stage for a slower way of shading that still works
 * (the processor, or the server standing in for a slow one). Not an error, so
 * it is not red and not an alert: ErrorBanner is for when nothing works.
 */
export function ShadingNote({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null;
  return (
    <p role="status" className={cn("animate-rise rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm leading-5 text-zinc-300", className)}>
      {message}
    </p>
  );
}
