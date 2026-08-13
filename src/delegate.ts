/**
 * Composer delegation command. Pure so the token rules are testable.
 *
 * A prompt whose FIRST token is `@<providerId>` (an installed provider id)
 * delegates the rest of the prompt to that provider instead of sending it to
 * the current thread: the caller forks the thread onto that provider and
 * starts the task as the fork's first run. Anything else (`@file.ts`
 * mentions, `@` mid-sentence, unknown or uninstalled ids) parses to null so
 * the normal send path keeps working.
 */
export interface DelegateRequest {
  /** Installed provider id taken from the first token. */
  provider: string;
  /** Remainder of the prompt after the `@provider` token. */
  task: string;
}

export function parseDelegate(
  prompt: string,
  installedProviderIds: string[],
): DelegateRequest | null {
  const trimmed = prompt.trim();
  const m = /^@(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  const id = m[1] ?? "";
  if (!installedProviderIds.includes(id)) return null;
  const task = (m[2] ?? "").trim();
  // A bare "@grok" has nothing to delegate; fall through to a normal send.
  if (!task) return null;
  return { provider: id, task };
}
