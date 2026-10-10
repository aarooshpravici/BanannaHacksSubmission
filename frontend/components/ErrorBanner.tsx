import { AlertIcon, XIcon } from "./icons";
import { cn } from "@/lib/cn";

interface ErrorBannerProps {
  /** Nothing is rendered while this is empty. */
  message: string | null | undefined;
  onDismiss?: () => void;
  onRetry?: () => void;
  className?: string;
}

/** Shows an API error (the backend's `detail`) where the user is looking. */
export function ErrorBanner({ message, onDismiss, onRetry, className }: ErrorBannerProps) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className={cn(
        "flex animate-rise items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-100",
        className,
      )}
    >
      <AlertIcon className="mt-0.5 text-rose-400" />
      <p className="min-w-0 flex-1 break-words leading-5">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 rounded-md px-2 py-0.5 font-medium text-rose-100 underline-offset-2 hover:underline">
          Retry
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 rounded-md p-0.5 text-rose-300 hover:bg-rose-500/20 hover:text-rose-100">
          <XIcon />
        </button>
      )}
    </div>
  );
}
