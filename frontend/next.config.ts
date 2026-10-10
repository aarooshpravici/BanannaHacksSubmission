import type { NextConfig } from "next";

// NEXT_PUBLIC_DEMO=1 (set by `npm run build:demo`) turns the build into a plain
// folder of static files in out/, for any static host. See README.md.
const demo = ["1", "true", "yes", "on"].includes((process.env.NEXT_PUBLIC_DEMO ?? "").trim().toLowerCase());

// The folder the site is served from, e.g. "/relight-demo" for
// https://example.github.io/relight-demo/. Any spelling is accepted
// ("relight-demo", "/relight-demo/"); Next.js wants a leading slash and no trailing one.
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "")
  .trim()
  .replace(/^\/*/, "/")
  .replace(/\/+$/, "");

const nextConfig: NextConfig = {
  /* config options here */
  // Both render parts of a page on a server, which a static export does not have: the build refuses them together.
  cacheComponents: !demo,
  partialPrefetching: !demo,
  // The floating dev-mode badge sits on top of the page's own controls.
  devIndicators: false,
  basePath,
  // The page reads the cleaned-up value (lib/config.ts), so the sample fetches use the same folder as Next.js.
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  // A static host serves /relight/ from relight/index.html; without the slash it would need a rewrite rule.
  ...(demo ? { output: "export" as const, trailingSlash: true } : {}),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
