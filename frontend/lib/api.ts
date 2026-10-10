// One typed function per backend endpoint. In mock mode (lib/config.ts) every
// call is answered by lib/mock.ts instead, with the same types and errors.

import { API_URL, DEMO, MOCK } from "./config";
import type {
  Health,
  JobRef,
  JobStatus,
  RelightEnhanceIn,
  RelightRender,
  RelightRenderIn,
  RelightScene,
  RelightSceneIn,
} from "./types";

/** A failed API call. `message` is what to show the user (the backend's `detail`). */
export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the backend could not be reached at all. */
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Any thrown value -> a sentence for the UI. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" && error ? error : "Something went wrong.";
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** FastAPI errors are `{ detail: string }`; validation errors carry a list instead. */
async function readDetail(res: Response): Promise<string> {
  const fallback = `The backend returned ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`;
  try {
    const body: unknown = await res.json();
    const detail = (body as { detail?: unknown } | null)?.detail;
    if (typeof detail === "string" && detail) return detail;
    if (Array.isArray(detail)) {
      const parts = detail.map((item: { loc?: unknown[]; msg?: string }) => {
        const where = Array.isArray(item.loc) ? item.loc.filter((p) => p !== "body").join(".") : "";
        return where ? `${where}: ${item.msg ?? "invalid"}` : (item.msg ?? "invalid");
      });
      if (parts.length) return parts.join("; ");
    }
  } catch {
    // Not JSON (a proxy's HTML error page, say): fall through.
  }
  return fallback;
}

/**
 * Fired on `window` when a request could not reach the backend at all, so the
 * status pill in the nav can re-check at once instead of at its next poll.
 */
export const BACKEND_UNREACHABLE_EVENT = "relight:backend-unreachable";

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  // The static demo has no backend. The page never asks for one there; this makes sure of it.
  if (DEMO) throw new ApiError("This demo runs in your browser, without the Relight server.", 0);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    if (typeof window !== "undefined") window.dispatchEvent(new Event(BACKEND_UNREACHABLE_EVENT));
    throw new ApiError(`Cannot reach the backend at ${API_URL}. Is it running?`, 0);
  }
  if (!res.ok) throw new ApiError(await readDetail(res), res.status);
  return (await res.json()) as T;
}

// The mock layer draws with canvas and is only loaded when it is switched on.
const mock = () => import("./mock");

// --- shared -------------------------------------------------------------------

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  if (MOCK) return (await mock()).health();
  return request("GET", "/health", undefined, signal);
}

export async function getJob<T>(jobId: string, signal?: AbortSignal): Promise<JobStatus<T>> {
  if (MOCK) return (await mock()).job<T>(jobId);
  return request("GET", `/jobs/${encodeURIComponent(jobId)}`, undefined, signal);
}

// --- relight ------------------------------------------------------------------

export async function relightScene(body: RelightSceneIn, signal?: AbortSignal): Promise<RelightScene> {
  if (MOCK) return (await mock()).relightScene(body);
  return request("POST", "/relight/scene", body, signal);
}

/**
 * Give the backend a scene the browser built from static files (a built-in
 * sample), and get back a scene id that /relight/render and /relight/enhance
 * accept. The backend re-estimates the geometry from the photo, with the same
 * settings the sample was baked with.
 */
export async function relightAdoptScene(scene: RelightScene, signal?: AbortSignal): Promise<string> {
  if (MOCK) return (await mock()).adoptScene(scene);
  return (await relightScene({ image: scene.image, detail: true }, signal)).scene_id;
}

export async function relightRender(body: RelightRenderIn, signal?: AbortSignal): Promise<RelightRender> {
  if (MOCK) return (await mock()).relightRender(body);
  return request("POST", "/relight/render", body, signal);
}

/** Job result: RelightRender. */
export async function relightEnhance(body: RelightEnhanceIn, signal?: AbortSignal): Promise<JobRef> {
  if (MOCK) return (await mock()).relightEnhance(body);
  return request("POST", "/relight/enhance", body, signal);
}
