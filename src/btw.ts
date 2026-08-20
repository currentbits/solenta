/**
 * `/btw` side question (issue #471). Pure parse so the renderer can intercept
 * a send before the busy-queue path, and so Alt+Enter can prefix a plain
 * draft. The runner re-parses independently (electron/btw.js).
 */

/**
 * The question after `/btw`, or null. A bare `/btw` (no task) falls through
 * so it is not dispatched as an empty side question — same rule as
 * `/advisor` in orchcommands.
 */
export function parseBtwCommand(prompt: string): string | null {
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trim();
  const m = /^\/btw(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  const question = (m[1] || "").trim();
  return question || null;
}

/**
 * Prefix a plain draft so the send intercept (and the runner) see `/btw`.
 * Returns null when there is nothing to ask (empty, or a bare `/btw`).
 */
export function asBtwPrompt(prompt: string): string | null {
  const trimmed = String(prompt || "").trim();
  if (!trimmed) return null;
  if (parseBtwCommand(trimmed)) return trimmed;
  if (/^\/btw\b/.test(trimmed)) return null;
  return `/btw ${trimmed}`;
}
