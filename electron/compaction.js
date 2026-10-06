"use strict";

/**
 * Provider-native context compaction (#318, #1493 E).
 *
 * Claude: a bare `/compact` user turn (stdin stream-json, CLI 2.1.283) runs
 * the CLI's own compaction and emits `system/compact_boundary` with
 * `compact_metadata.{trigger, pre_tokens, post_tokens}`. Auto-compaction
 * emits the same event with trigger "auto".
 * Codex: app-server `thread/compact/start {threadId}` runs a turn whose only
 * item is `contextCompaction` (codex-cli 0.159.2); auto-compaction emits the
 * same item inside a normal turn. The next tokenUsage.last is post-compaction.
 * Every other provider falls back to fork-to-fresh in the renderer.
 */

const NATIVE_COMPACT_PROVIDERS = new Set(["claude", "codex"]);

/** True when this turn should be sent as the provider's own compaction. */
function isNativeCompactTurn(provider, prompt, sessionId) {
  return (
    NATIVE_COMPACT_PROVIDERS.has(String(provider || "")) &&
    Boolean(sessionId) &&
    String(prompt ?? "").trim() === "/compact"
  );
}

function formatTokens(n) {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

function positive(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Post a "Context compacted" event and reset the ring to the post size.
 * Unknown sizes are left out of the text; the ring then waits for the
 * provider's next usage report.
 * @param {{ store: object, appendMessage: Function }} deps
 * @param {string} threadId
 * @param {string} runId
 * @param {{ pre?: number | null, post?: number | null, auto?: boolean }} info
 */
function recordCompaction(deps, threadId, runId, info) {
  const { store, appendMessage } = deps;
  const pre = positive(info.pre);
  const post = positive(info.post);
  const prev = store.getUsage(threadId);
  if (post && prev) store.setUsage(threadId, { ...prev, contextTokens: post });
  const sizes =
    pre && post
      ? ` (${formatTokens(pre)} → ${formatTokens(post)} tokens)`
      : post
        ? ` (now ${formatTokens(post)} tokens)`
        : "";
  const text = `${info.auto ? "Context auto-compacted" : "Context compacted"}${sizes}`;
  appendMessage(threadId, "event", text, runId);
  return text;
}

module.exports = { NATIVE_COMPACT_PROVIDERS, isNativeCompactTurn, recordCompaction };
