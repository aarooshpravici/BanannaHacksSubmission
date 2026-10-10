// Build-time configuration, read from NEXT_PUBLIC_* variables (see .env.local.example).

const rawUrl = (process.env.NEXT_PUBLIC_API_URL ?? "").trim();
const rawMock = (process.env.NEXT_PUBLIC_MOCK ?? "").trim().toLowerCase();

/** Base URL of the FastAPI backend, without a trailing slash. */
export const API_URL = (rawUrl || "http://localhost:8000").replace(/\/+$/, "");

/**
 * Mock mode: lib/api.ts answers every call itself, in the browser.
 *
 * NEXT_PUBLIC_MOCK decides when it is set. When neither variable is set,
 * `npm run dev` falls back to mock mode so the app is clickable out of the box,
 * and a production build falls back to the real backend.
 */
export const MOCK =
  rawMock !== ""
    ? ["1", "true", "yes", "on"].includes(rawMock)
    : process.env.NODE_ENV !== "production" && rawUrl === "";
