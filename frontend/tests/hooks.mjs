// Loaded before every test file (see "test" in package.json). Node runs the
// app's .ts files as they are, by stripping the types, but it insists on the
// file ending in an import, and the app's code is written for Next.js, which
// leaves it off ("./image", "@/lib/types"). This adds it back: a relative or
// "@/" import with no ending is looked for as .ts, then .tsx, then .js. And it
// says the app's .ts files are modules, which Node would otherwise only find out
// by failing to read them the old way first (and say so in a warning each time).

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENDINGS = [".ts", ".tsx", ".js"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    let base = null;
    if (specifier.startsWith("@/")) base = resolve(FRONTEND, specifier.slice(2));
    else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) base = resolve(dirname(fileURLToPath(context.parentURL)), specifier);
    if (base && !/\.[cm]?[jt]sx?$/.test(base)) {
      const found = ENDINGS.map((ending) => base + ending).find((path) => existsSync(path));
      if (found) return nextResolve(pathToFileURL(found).href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts")) return nextLoad(url, { ...context, format: "module-typescript" });
    return nextLoad(url, context);
  },
});
