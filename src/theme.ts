/**
 * Appearance preference → resolved light/dark (issue #651).
 *
 * The CSS contract is `:root` (dark values) plus `:root[data-theme="light"]`.
 * This module only sets `data-theme` and `color-scheme` on `<html>`; it does
 * not branch in components.
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "solenta-theme";

export function resolveTheme(
  preference: ThemePreference,
  matchesDark: boolean,
): ResolvedTheme {
  if (preference === "light" || preference === "dark") return preference;
  return matchesDark ? "dark" : "light";
}

export type ThemeRoot = {
  setAttribute(name: string, value: string): void;
  style: { colorScheme: string };
};

export function applyResolvedTheme(
  theme: ResolvedTheme,
  root: ThemeRoot = document.documentElement,
): void {
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
}

function defaultStorage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // private mode / missing global
  }
  return null;
}

export function persistThemePreference(
  preference: ThemePreference,
  storage: Storage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // ignore quota / missing storage
  }
}

export function readStoredThemePreference(
  storage: Storage | null = defaultStorage(),
): ThemePreference | null {
  try {
    const v = storage?.getItem(THEME_STORAGE_KEY);
    return v === "system" || v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function systemPrefersDark(): boolean {
  try {
    return (
      typeof matchMedia === "function" &&
      matchMedia("(prefers-color-scheme: dark)").matches
    );
  } catch {
    return false;
  }
}

/**
 * First-paint helper. Missing storage → dark (the upgrade default) so a
 * light OS does not flash the new light theme before settings load.
 */
export function bootThemeFromStorage(
  matchesDark: () => boolean = systemPrefersDark,
  storage: Storage | null = defaultStorage(),
  root?: ThemeRoot,
): ResolvedTheme {
  const pref = readStoredThemePreference(storage) ?? "dark";
  const theme = resolveTheme(pref, matchesDark());
  applyResolvedTheme(theme, root);
  return theme;
}

export type SystemMedia = {
  matches: boolean;
  addEventListener(
    type: "change",
    fn: (e: { matches: boolean }) => void,
  ): void;
  removeEventListener(
    type: "change",
    fn: (e: { matches: boolean }) => void,
  ): void;
};

function defaultSystemMedia(): SystemMedia | null {
  try {
    if (typeof matchMedia === "function") {
      return matchMedia("(prefers-color-scheme: dark)");
    }
  } catch {
    // jsdom / headless
  }
  return null;
}

export function subscribeSystemTheme(
  onChange: (matchesDark: boolean) => void,
  media: SystemMedia | null = defaultSystemMedia(),
): () => void {
  if (!media) return () => {};
  const handler = (e: { matches: boolean }) => onChange(e.matches);
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}

/** Persist, paint, and (for system) follow OS flips. Returns the unsub. */
export function syncTheme(preference: ThemePreference): () => void {
  persistThemePreference(preference);
  applyResolvedTheme(resolveTheme(preference, systemPrefersDark()));
  if (preference !== "system") return () => {};
  return subscribeSystemTheme((matchesDark) => {
    applyResolvedTheme(resolveTheme("system", matchesDark));
  });
}
