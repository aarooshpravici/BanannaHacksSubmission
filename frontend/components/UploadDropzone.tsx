"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ErrorBanner } from "./ErrorBanner";
import { BusyLabel } from "./Spinner";
import { UploadIcon } from "./icons";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { type LoadedImage, fileToImage } from "@/lib/image";

interface UploadDropzoneProps {
  /** Called with the image, already downscaled and base64-encoded. */
  onImage: (image: LoadedImage) => void;
  title?: string;
  hint?: string;
  /** "auto" keeps JPEGs as JPEG and turns everything else into PNG. */
  format?: "auto" | "png" | "jpeg";
  /** Shown under the drop box, above its error line (the built-in sample photos). */
  footer?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** Drop a file, click to browse, or paste from the clipboard. */
export function UploadDropzone({
  onImage,
  title = "Drop an image here",
  hint = "or click to browse, or paste from the clipboard",
  format = "auto",
  footer,
  disabled = false,
  className,
}: UploadDropzoneProps) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback(
    async (file: Blob | null | undefined) => {
      if (!file || disabled) return;
      if (file.type && !file.type.startsWith("image/")) {
        setError("That file is not an image.");
        return;
      }
      setError(null);
      setReading(true);
      try {
        onImage(await fileToImage(file, { format }));
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setReading(false);
      }
    },
    [disabled, format, onImage],
  );

  // Paste works anywhere on the page while the dropzone is showing.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) {
        event.preventDefault();
        void accept(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [accept]);

  return (
    <div className={className}>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={() => !disabled && input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            input.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void accept(e.dataTransfer.files[0]);
        }}
        className={cn(
          "group relative flex min-h-44 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-8 text-center transition-colors short:min-h-0 short:py-5",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70",
          dragging ? "border-accent bg-accent/10" : "border-white/15 bg-white/[0.025] hover:border-white/30 hover:bg-white/[0.05]",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void accept(e.target.files?.[0]);
            e.target.value = ""; // so picking the same file again still fires
          }}
        />
        {reading ? (
          <BusyLabel>Reading image…</BusyLabel>
        ) : (
          <>
            <span className={cn("flex h-12 w-12 items-center justify-center rounded-2xl border transition-colors", dragging ? "border-accent/50 bg-accent/20 text-accent" : "border-white/10 bg-white/[0.06] text-zinc-300 group-hover:text-white")}>
              <UploadIcon className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-base font-medium text-zinc-100">{title}</span>
              <span className="mt-1 block text-sm text-zinc-500">{hint}</span>
            </span>
          </>
        )}
      </div>

      {footer}

      <ErrorBanner message={error} onDismiss={() => setError(null)} className="mt-3" />
    </div>
  );
}
