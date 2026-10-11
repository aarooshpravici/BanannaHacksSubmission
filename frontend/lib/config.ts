// Build-time configuration, read from NEXT_PUBLIC_* variables (see .env.local.example).

const rawUrl = (process.env.NEXT_PUBLIC_API_URL ?? "").trim();
const rawMock = (process.env.NEXT_PUBLIC_MOCK ?? "").trim().toLowerCase();
const rawDemo = (process.env.NEXT_PUBLIC_DEMO ?? "").trim().toLowerCase();

const isOn = (value: string) => ["1", "true", "yes", "on"].includes(value);

/** Base URL of the FastAPI backend, without a trailing slash. */
export const API_URL = (rawUrl || "http://localhost:8000").replace(/\/+$/, "");

/**
 * The folder the site is served from, "" at the root or e.g. "/relight-demo".
 * next.config.ts cleans up NEXT_PUBLIC_BASE_PATH and hands it on, so this is
 * already in that shape. Next.js adds it to its own files and links; anything
 * the page fetches from public/ by hand has to add it too.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * Static demo (`npm run build:demo`): a plain folder of files with no server
 * anywhere. Samples and uploads are handled in the browser (lib/localScene.ts);
 * nothing may call a backend.
 */
export const DEMO = isOn(rawDemo);

/**
 * Mock mode: lib/api.ts answers every call itself, in the browser.
 *
 * NEXT_PUBLIC_MOCK decides when it is set. When neither variable is set,
 * `npm run dev` falls back to mock mode so the app is clickable out of the box,
 * and a production build falls back to the real backend. The static demo makes
 * no calls at all, so it is never in mock mode.
 */
export const MOCK = !DEMO && (rawMock !== "" ? isOn(rawMock) : process.env.NODE_ENV !== "production" && rawUrl === "");

/** Where to get the code, for the things the static demo cannot do. */
export const REPO_URL = "https://github.com/aarooshpravici/BanannaHacksSubmission";
