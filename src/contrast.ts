/**
 * High-contrast appearance (issue #1797).
 *
 * The CSS contract is `:root[data-contrast="high"]` (dark) plus
 * `:root[data-theme="light"][data-contrast="high"]` (light), both in
 * src/index.css, overriding a handful of text/border/focus variables.
 * A separate `@media (prefers-contrast: more)` block in the same file
 * covers the OS preference on its own — @media is live, no JS listener
 * needed — scoped to `:not([data-contrast])` so it only applies when this
 * module has NOT set the attribute. This module only ever sets
 * `data-contrast="high"` or removes it; it never writes an explicit "off",
 * so the OS preference keeps the last word whenever the user hasn't
 * forced the toggle on (the toggle's own persistence lives in uiPrefs.ts,
 * next to the app's other boolean display preferences).
 */

export type ContrastRoot = {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

export function applyContrast(
  enabled: boolean,
  root: ContrastRoot = document.documentElement,
): void {
  if (enabled) root.setAttribute("data-contrast", "high");
  else root.removeAttribute("data-contrast");
}
