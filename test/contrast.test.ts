/**
 * High-contrast appearance (issue #1797).
 *
 * Run: node --experimental-strip-types --test test/contrast.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyContrast } from "../src/contrast.ts";

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
    getAttribute(name: string) {
      return attrs.get(name) ?? null;
    },
  };
}

describe("applyContrast", () => {
  it("sets data-contrast=high when enabled", () => {
    const root = fakeRoot();
    applyContrast(true, root);
    assert.equal(root.getAttribute("data-contrast"), "high");
  });

  it("removes the attribute when disabled, never writing an explicit off", () => {
    const root = fakeRoot();
    applyContrast(true, root);
    applyContrast(false, root);
    assert.equal(root.getAttribute("data-contrast"), null);
  });
});

describe("index.css high-contrast contract", () => {
  it("overrides the same tokens for both themes, plus an OS media query", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(
      path.join(import.meta.dirname, "../src/index.css"),
      "utf8",
    );
    assert.match(css, /:root\[data-contrast="high"\]\s*\{/);
    assert.match(
      css,
      /:root\[data-theme="light"\]\[data-contrast="high"\]\s*\{/,
    );
    assert.match(css, /@media\s*\(prefers-contrast:\s*more\)/);
    // The OS fallback must not fire once the toggle has set the attribute.
    assert.match(css, /:root:not\(\[data-contrast\]\)/);
    assert.match(
      css,
      /:root\[data-theme="light"\]:not\(\[data-contrast\]\)/,
    );

    const darkHigh =
      css.split(':root[data-contrast="high"]')[1]?.split("}")[0] ?? "";
    const lightHigh =
      css
        .split(':root[data-theme="light"][data-contrast="high"]')[1]
        ?.split("}")[0] ?? "";
    for (const token of [
      "--text-muted",
      "--text-dim",
      "--border",
      "--border-soft",
      "--focus-ring",
      "--focus-ring-color",
    ] as const) {
      assert.match(darkHigh, new RegExp(`${token}:`), `dark override: ${token}`);
      assert.match(lightHigh, new RegExp(`${token}:`), `light override: ${token}`);
    }
    // The accent stays untouched by the high-contrast overrides.
    assert.doesNotMatch(darkHigh, /--accent:/);
    assert.doesNotMatch(lightHigh, /--accent:/);
  });
});
