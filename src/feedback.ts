/**
 * `/feedback` (issue #681). Pure parse so the renderer can intercept a send
 * before the busy-queue path — feedback goes to us, never to the model, and
 * never occupies the live turn. Same shape as `./btw`.
 */

/**
 * The text after `/feedback`, or null. A bare `/feedback` falls through so it
 * is not sent as an empty report — same rule as `/btw`.
 */
export function parseFeedbackCommand(prompt: string): string | null {
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trim();
  const m = /^\/feedback(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  const text = (m[1] || "").trim();
  return text || null;
}
