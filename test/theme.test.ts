/**
 * Theme preference resolution (issue #651).
 *
 * Run: node --experimental-strip-types --test test/theme.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyResolvedTheme,
  bootThemeFromStorage,
  persistThemePreference,
  readStoredThemePreference,
  resolveTheme,
  subscribeSystemTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "../src/theme.ts";

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(i: number) {
      return [...map.keys()][i] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    getAttribute(name: string) {
      return attrs.get(name) ?? null;
    },
    style: { colorScheme: "" },
  };
}

describe("resolveTheme", () => {
  it("light and dark ignore the OS", () => {
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("light", false), "light");
    assert.equal(resolveTheme("dark", true), "dark");
    assert.equal(resolveTheme("dark", false), "dark");
  });

  it("system follows prefers-color-scheme", () => {
    assert.equal(resolveTheme("system", true), "dark");
    assert.equal(resolveTheme("system", false), "light");
  });
});

describe("applyResolvedTheme", () => {
  it("sets data-theme and color-scheme on the root", () => {
    const root = fakeRoot();
    applyResolvedTheme("light", root);
    assert.equal(root.getAttribute("data-theme"), "light");
    assert.equal(root.style.colorScheme, "light");
    applyResolvedTheme("dark", root);
    assert.equal(root.getAttribute("data-theme"), "dark");
    assert.equal(root.style.colorScheme, "dark");
  });
});

describe("theme storage", () => {
  it("round-trips a preference and boots from it", () => {
    const storage = memStorage();
    const root = fakeRoot();
    assert.equal(readStoredThemePreference(storage), null);
    persistThemePreference("light", storage);
    assert.equal(readStoredThemePreference(storage), "light");
    bootThemeFromStorage(() => true, storage, root);
    assert.equal(root.getAttribute("data-theme"), "light");
  });

  it("boots dark when nothing is stored (upgrade default)", () => {
    const root = fakeRoot();
    bootThemeFromStorage(() => false, memStorage(), root);
    assert.equal(root.getAttribute("data-theme"), "dark");
  });

  it("boots system from matchMedia when stored as system", () => {
    const storage = memStorage();
    persistThemePreference("system", storage);
    const lightRoot = fakeRoot();
    bootThemeFromStorage(() => false, storage, lightRoot);
    assert.equal(lightRoot.getAttribute("data-theme"), "light");
    const darkRoot = fakeRoot();
    bootThemeFromStorage(() => true, storage, darkRoot);
    assert.equal(darkRoot.getAttribute("data-theme"), "dark");
  });
});

describe("subscribeSystemTheme", () => {
  it("forwards matchMedia change events and unsubscribes", () => {
    const listeners: Array<(e: { matches: boolean }) => void> = [];
    const media = {
      matches: true,
      addEventListener(_type: string, fn: (e: { matches: boolean }) => void) {
        listeners.push(fn);
      },
      removeEventListener(
        _type: string,
        fn: (e: { matches: boolean }) => void,
      ) {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    const seen: boolean[] = [];
    const stop = subscribeSystemTheme((m) => seen.push(m), media);
    assert.equal(listeners.length, 1);
    listeners[0]!({ matches: false });
    assert.deepEqual(seen, [false]);
    stop();
    assert.equal(listeners.length, 0);
  });
});

describe("index.css light contract", () => {
  it("overrides the same tokens under data-theme=light", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(
      path.join(import.meta.dirname, "../src/index.css"),
      "utf8",
    );
    assert.match(css, /:root\s*\{/);
    assert.match(css, /:root\[data-theme="light"\]\s*\{/);
    assert.match(css, /color-scheme:\s*light/);
    const dark = css.split(':root[data-theme="light"]')[0] ?? "";
    const light = css.split(':root[data-theme="light"]')[1] ?? "";
    for (const token of [
      "--bg",
      "--text",
      "--text-dim",
      "--text-muted",
      "--shadow-pop",
      "--focus-ring",
      "--focus-ring-color",
      "--green",
      "--amber",
      "--danger",
      "--violet",
      "--overlay-soft",
      "--overlay-hover",
      "--track",
    ] as const) {
      assert.match(dark, new RegExp(`${token}:`));
      assert.match(light, new RegExp(`${token}:`));
    }
  });
});

export type { ThemePreference };
export { THEME_STORAGE_KEY };
