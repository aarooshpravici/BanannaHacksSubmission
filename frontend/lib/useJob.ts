"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, getJob } from "./api";
import type { JobRef } from "./types";

export type JobHookStatus = "idle" | "pending" | "done" | "error";

interface JobState<T> {
  status: JobHookStatus;
  result: T | null;
  error: string | null;
}

export interface Job<T> extends JobState<T> {
  /**
   * Submit a job and poll it to completion. `submit` is the API call that
   * returns the JobRef. Resolves with the result, or null if the job failed
   * (see `error`) or was superseded by another run, a reset or an unmount.
   */
  run: (submit: () => Promise<JobRef>) => Promise<T | null>;
  /** Forget the current job and go back to "idle". */
  reset: () => void;
}

const IDLE = { status: "idle", result: null, error: null } as const;

/** Give up on a job that has been pending this long. */
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Background jobs: POST returns a JobRef straight away, then GET /jobs/{id} is
 * polled about once a second until the status is no longer "pending".
 * Polling stops when the component unmounts.
 */
export function useJob<T>(pollMs = 1000): Job<T> {
  const [state, setState] = useState<JobState<T>>(IDLE);
  // Each run gets a number; a run that is no longer the current one goes quiet.
  const current = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = useRef<(() => void) | null>(null);
  const controller = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    current.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    // Let a run that is waiting between polls notice straight away that it is over.
    wake.current?.();
    wake.current = null;
    controller.current?.abort();
    controller.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const run = useCallback(
    async (submit: () => Promise<JobRef>): Promise<T | null> => {
      stop();
      const id = current.current;
      const alive = () => current.current === id;
      const abort = new AbortController();
      controller.current = abort;
      setState({ status: "pending", result: null, error: null });
      const startedAt = Date.now();
      try {
        const ref = await submit();
        while (alive()) {
          const job = await getJob<T>(ref.job_id, abort.signal);
          if (!alive()) return null;
          if (job.status === "done") {
            setState({ status: "done", result: job.result, error: null });
            return job.result;
          }
          if (job.status === "error") {
            setState({ status: "error", result: null, error: job.error || "The job failed." });
            return null;
          }
          if (Date.now() - startedAt > TIMEOUT_MS) {
            setState({ status: "error", result: null, error: "The job is taking too long. Try again." });
            return null;
          }
          await new Promise<void>((resolve) => {
            wake.current = resolve;
            timer.current = setTimeout(resolve, pollMs);
          });
        }
        return null;
      } catch (error) {
        if (alive()) setState({ status: "error", result: null, error: errorMessage(error) });
        return null;
      }
    },
    [stop, pollMs],
  );

  const reset = useCallback(() => {
    stop();
    setState(IDLE);
  }, [stop]);

  return { ...state, run, reset };
}
