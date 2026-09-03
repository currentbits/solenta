/**
 * Node module hooks that let tests render real React components.
 *
 * Why this exists: renderer regressions kept shipping green. A reviewer proved
 * you could pass `thread={null}` to the PR card and `prNumber: null` to the
 * sidebar badge, deleting every user-visible part of a feature, with the whole
 * suite, tsc and vite build all passing. Pure modules were tested; the wiring
 * that calls them was not testable at all.
 *
 * Two gaps to close, no new dependency:
 * 1. CSS modules mean nothing outside the bundler, so resolve them to a Proxy
 *    that returns each key as its own class name (styles.foo === "foo"),
 *    which also lets tests assert on class names.
 * 2. Node strips TypeScript but not JSX, so .tsx goes through esbuild, which
 *    vite already depends on.
 *
 * Usage: node --import=./test/support/render.mjs --test test/foo.test.tsx
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const CSS_STUB =
  "data:text/javascript,export default new Proxy({},{get:(_,k)=>typeof k===`string`?k:undefined})";

export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".css")) {
    return { url: CSS_STUB, shortCircuit: true };
  }
  if (specifier.includes("?url")) {
    const dummy = JSON.stringify(specifier.replace(/\?url$/, ""));
    return {
      url: `data:text/javascript,export default ${dummy}`,
      shortCircuit: true,
    };
  }
  // App code imports extensionless ("./Sidebar") the way the bundler allows.
  // Note: vite's resolve.extensions puts .js BEFORE .tsx, this tries .tsx
  // first. There is no foo.js beside a foo.tsx in src/ today; if one appears,
  // this hook and the bundler would disagree about which file wins.
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
    for (const ext of [".tsx", ".ts"]) {
      try {
        return await next(specifier + ext, context);
      } catch {
        // try the next extension
      }
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith(".tsx")) {
    const source = readFileSync(fileURLToPath(url), "utf8");
    const { code } = transformSync(source, {
      loader: "tsx",
      format: "esm",
      jsx: "automatic",
      target: "node20",
      sourcefile: fileURLToPath(url),
    });
    return { format: "module", source: code, shortCircuit: true };
  }
  return next(url, context);
}
