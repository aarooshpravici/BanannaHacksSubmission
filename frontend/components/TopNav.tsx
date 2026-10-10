"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { HowItWorks } from "./HowItWorks";
import { BananaMark } from "./icons";
import { BACKEND_UNREACHABLE_EVENT, getHealth, isAbort } from "@/lib/api";
import { cn } from "@/lib/cn";
import { API_URL, DEMO, MOCK } from "@/lib/config";
import type { Health } from "@/lib/types";

type Status = { kind: "demo" } | { kind: "mock" } | { kind: "checking" } | { kind: "online"; health: Health } | { kind: "offline" };

const HEALTH_POLL_MS = 10_000;

/** A small dot that says whether the backend is reachable (or that we are mocking it). */
function BackendStatus() {
  const [status, setStatus] = useState<Status>(DEMO ? { kind: "demo" } : MOCK ? { kind: "mock" } : { kind: "checking" });

  useEffect(() => {
    // Neither has a backend to ask.
    if (DEMO || MOCK) return;
    const controller = new AbortController();
    const check = async () => {
      try {
        const health = await getHealth(controller.signal);
        setStatus({ kind: "online", health });
      } catch (error) {
        if (!isAbort(error)) setStatus({ kind: "offline" });
      }
    };
    void check();
    const timer = setInterval(check, HEALTH_POLL_MS);
    // A request anywhere on the page just failed to connect: say so now, not at the next poll.
    // The poll keeps running and turns the pill back when the backend returns.
    const onUnreachable = () => setStatus((s) => (s.kind === "offline" ? s : { kind: "offline" }));
    window.addEventListener(BACKEND_UNREACHABLE_EVENT, onUnreachable);
    return () => {
      window.removeEventListener(BACKEND_UNREACHABLE_EVENT, onUnreachable);
      clearInterval(timer);
      controller.abort();
    };
  }, []);

  let dot = "bg-zinc-500";
  let prefix = "backend:";
  let label = "checking";
  // On a phone the bar also has to hold the "How it works" button, so a long label gives way to one word there. The full text stays in the tooltip.
  let shortLabel: string | null = null;
  let title = `Checking ${API_URL}`;
  if (status.kind === "demo") {
    dot = "bg-emerald-400";
    prefix = "demo:";
    label = "runs in your browser";
    shortLabel = "demo";
    title = "Static demo: the sample photos are shaded entirely in your browser and no server is contacted. Uploading your own photo and Enhance need the Relight server.";
  } else if (status.kind === "mock") {
    dot = "bg-accent";
    label = "mock";
    title = "Mock mode: responses are generated in the browser, no backend is called. Set NEXT_PUBLIC_MOCK=0 to use the real one.";
  } else if (status.kind === "online") {
    const providers = Object.entries(status.health.providers);
    const listed = providers.map(([name, ready]) => `${name}: ${ready ? "ready" : "no key"}`).join(", ");
    dot = status.health.mock_mode ? "bg-amber-400" : "bg-emerald-400";
    label = status.health.mock_mode ? "online, mock providers" : "online";
    if (status.health.mock_mode) shortLabel = "online";
    title = `Backend at ${API_URL}${listed ? ` (${listed})` : ""}`;
  } else if (status.kind === "offline") {
    dot = "bg-rose-500";
    label = "offline";
    title = `Cannot reach the backend at ${API_URL}`;
  }

  return (
    <div title={title} className="flex min-w-0 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-zinc-300">
      <span className="relative flex h-2 w-2 shrink-0">
        {status.kind !== "offline" && status.kind !== "checking" && (
          <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-50", dot)} />
        )}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", dot)} />
      </span>
      <span className="hidden sm:inline">{prefix}</span>
      <span className={cn("truncate font-medium text-zinc-100", shortLabel && "hidden sm:inline")}>{label}</span>
      {shortLabel && <span className="font-medium text-zinc-100 sm:hidden">{shortLabel}</span>}
    </div>
  );
}

export function TopNav() {
  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b border-white/[0.08] bg-ink/80 px-4 backdrop-blur-xl">
      <Link href="/" className="mr-auto flex shrink-0 items-center gap-2 rounded-lg py-1 pr-2 text-sm font-semibold tracking-tight text-white">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-black">
          <BananaMark className="h-4 w-4" />
        </span>
        <span>Relight</span>
        <span className="hidden font-normal text-zinc-500 sm:inline">Banana Hacks 2026</span>
      </Link>
      <HowItWorks />
      <BackendStatus />
    </header>
  );
}
