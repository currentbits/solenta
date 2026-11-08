"use strict";

/**
 * Keep Claude's model ceiling separate from its running compaction policy.
 * The launched CLI resolves settings, env, account and remote model defaults.
 * get_context_usage is an estimate: even 2.1.318 ignores the percentage override
 * there (anthropics/claude-code#97568). autocompact_state reports the trigger.
 */
function claudeCompaction(value, streamed = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const enabled = streamed ? value.enabled : value.isAutoCompactEnabled;
  if (enabled === false) return { kind: "disabled" };
  if (enabled !== true) return null;
  if (streamed && value.enforced === false) return { kind: "reactive" };
  if (streamed && value.enforced !== true) return null;
  // With the tuned default window, newer CLIs may compact only after an API
  // context-limit error. A /context display buffer is not an enforced trigger.
  if (!streamed && value.autocompactSource === "auto") return null;
  const threshold = streamed ? value.threshold : value.autoCompactThreshold;
  const window = streamed ? value.effective_window : value.maxTokens;
  if (!Number.isSafeInteger(threshold) || threshold <= 0 ||
      !Number.isSafeInteger(window) || window <= 0 || threshold > window) return null;
  return { kind: "threshold", tokens: threshold, source: streamed ? "enforced" : "reported" };
}

module.exports = { claudeCompaction };
