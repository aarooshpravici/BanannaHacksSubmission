"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ErrorBanner } from "./ErrorBanner";
import { BusyLabel } from "./Spinner";
import { UploadIcon } from "./icons";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { HEIC_BUSY_TEXT, isHeic } from "@/lib/heic";
import { type LoadedImage, fileToImage } from "@/lib/image";

/**
 * How long a dropped or pasted image address gets to answer, in milliseconds.
 * A photo on a working site arrives in a second or two; much longer and the
 * user is better served by being told to save the file.
 */
const ADDRESS_TIMEOUT_MS = 15_000;
/** The two ways that always work for an image on another site. */
const OTHER_ROUTES = "Right-click the image and choose Copy image, then paste it on this page; or save it and drop the file here.";

/**
 * The image addresses in a drop or a paste that carries no file, most likely
 * first. Dragging a picture out of another web page gives the page's HTML for
 * it and its address, not the picture; if the picture is a link, the plain
 * address is the link's, so the <img> in the HTML is tried first.
 */
function imageAddresses(data: DataTransfer): string[] {
  const found: string[] = [];
  const html = data.getData("text/html");
  if (html) {
    // Parsed, never put on the page: nothing in it loads or runs.
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const img of doc.querySelectorAll("img")) found.push(img.getAttribute("src") ?? "");
  }
  // A uri-list is one address per line, with # for comments.
  found.push(...data.getData("text/uri-list").split(/\r?\n/).filter((line) => !line.startsWith("#")));
  found.push(data.getData("text/plain"));
  const addresses = found
    .map((value) => value.trim())
    // "//host/picture.jpg" is a full address with the page's own scheme left off.
    .map((value) => (value.startsWith("//") ? `https:${value}` : value))
    .filter((value) => /^(https?:\/\/|data:image\/)\S+$/i.test(value));
  return [...new Set(addresses)];
}

/**
 * An image address -> the image, as a file. Another site's picture can only be
 * read when that site says other pages may (most do not): that is the
 * browser's rule, and the error says so and what to do about it.
 */
async function fetchImage(address: string): Promise<File> {
  const inline = address.startsWith("data:");
  let res: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADDRESS_TIMEOUT_MS);
  try {
    // No cookies and no referrer: the other site learns nothing about this page's user beyond the request itself.
    res = await fetch(address, inline ? undefined : { credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal });
    if (!res.ok) throw new Error(`That image's site answered ${res.status}, so it could not be loaded. ${OTHER_ROUTES}`);
    const blob = await res.blob();
    if (blob.type && !blob.type.startsWith("image/")) throw new Error("That address is a web page, not an image. Drag the picture itself, or save it and drop the file here.");
    const name = inline ? "" : (new URL(address).pathname.split("/").pop() ?? "");
    return new File([blob], name || "dropped image", { type: blob.type });
  } catch (error) {
    // fetch() itself failing is the browser refusing (or the network); the errors thrown above already say what happened.
    if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    if (inline) throw new Error("That image could not be read. Save it and drop the file here.");
    if (controller.signal.aborted) throw new Error(`That image took too long to load. ${OTHER_ROUTES}`);
    throw new Error(`That image's site does not let other pages read it. This is a browser security rule, not a fault in the image. ${OTHER_ROUTES}`);
  } finally {
    clearTimeout(timer);
  }
}

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

/** Drop a file or an image from another page, click to browse, or paste an image or its address. */
export function UploadDropzone({
  onImage,
  title = "Drop an image here",
  hint = "or click to browse, or paste an image or its address",
  format = "auto",
  footer,
  disabled = false,
  className,
}: UploadDropzoneProps) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  // The file being read is a HEIC photo, which takes a moment longer: the wait says why.
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback(
    async (file: Blob | null | undefined) => {
      if (!file || disabled) return;
      // An iPhone photo (.heic) can arrive with a type that does not say "image": its name and first bytes are checked too.
      const heic = await isHeic(file);
      if (file.type && !file.type.startsWith("image/") && !heic) {
        setError("That file is not an image.");
        return;
      }
      setError(null);
      setConverting(heic);
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

  /** A drop or a paste: its image file if it has one, otherwise the image its address points to. Resolves false if it held neither. */
  const acceptTransfer = useCallback(
    async (data: DataTransfer | null): Promise<boolean> => {
      if (!data || disabled) return false;
      const file = [...data.files].find((f) => f.type.startsWith("image/")) ?? data.files[0];
      if (file) {
        await accept(file);
        return true;
      }
      // Read now: the browser empties a drop's data once its event is over.
      const [address] = imageAddresses(data);
      if (!address) return false;
      setError(null);
      setConverting(false);
      setReading(true);
      try {
        await accept(await fetchImage(address));
      } catch (e) {
        setError(errorMessage(e));
        setReading(false);
      }
      return true;
    },
    [accept, disabled],
  );

  // Paste works anywhere on the page while the dropzone is showing.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      // Anything else on the clipboard (a sentence, say) is left for the browser to deal with.
      if (!data || (!data.files.length && !imageAddresses(data).length)) return;
      event.preventDefault();
      void acceptTransfer(data);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptTransfer]);

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
          void acceptTransfer(e.dataTransfer).then((found) => {
            if (!found && !disabled) setError(`Nothing in that drop was an image. ${OTHER_ROUTES}`);
          });
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
          accept="image/*,.heic,.heif"
          className="hidden"
          onChange={(e) => {
            void accept(e.target.files?.[0]);
            e.target.value = ""; // so picking the same file again still fires
          }}
        />
        {reading ? (
          <BusyLabel>{converting ? HEIC_BUSY_TEXT : "Reading image…"}</BusyLabel>
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
