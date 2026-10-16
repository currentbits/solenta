"use strict";

/**
 * Model routing (#246). A thread carrying `route` ("auto" or a tier) has its
 * provider/model picked on its first turn: "auto" classifies the prompt,
 * a tier is declared by an automation or an orchestrator's thread_fork.
 * The tier maps to an agent profile through the project's `modelRouting`.
 * Permission mode is never routed: a tier picks cost/intelligence, not
 * how much the agent may do unattended.
 */

const TIERS = ["fast", "balanced", "strong"];
const ROUTES = new Set(["auto", ...TIERS]);

// ponytail: keyword + length heuristic, no model call. Upgrade path is a
// cheap classifier run when misroutes show up in the transcript events.
const STRONG = [
  "architect",
  "design",
  "refactor",
  "migrat",
  "rewrite",
  "investigate",
  "root cause",
  "debug",
  "race condition",
  "concurren",
  "security",
  "performance",
  "plan ",
];
const FAST = [
  "typo",
  "rename",
  "reformat",
  "format",
  "lint",
  "bump",
  "changelog",
  "docstring",
  "comment",
  "triage",
  "label",
  "summari",
  "translate",
  "spelling",
];
const FAST_MAX_CHARS = 400;
const STRONG_MIN_CHARS = 1500;

/**
 * @param {string} prompt
 * @returns {{ tier: "fast" | "balanced" | "strong", reason: string }}
 */
function classifyPrompt(prompt) {
  const text = String(prompt || "");
  const lower = text.toLowerCase();
  const strong = STRONG.find((k) => lower.includes(k));
  if (strong) return { tier: "strong", reason: `mentions "${strong.trim()}"` };
  if (text.length >= STRONG_MIN_CHARS) {
    return { tier: "strong", reason: `long prompt (${text.length} chars)` };
  }
  const fast = FAST.find((k) => lower.includes(k));
  if (fast && text.length <= FAST_MAX_CHARS) {
    return { tier: "fast", reason: `short "${fast}" task` };
  }
  return { tier: "balanced", reason: "no light or heavy signals" };
}

/** @param {unknown} v */
function normalizeRoute(v) {
  return typeof v === "string" && ROUTES.has(v) ? v : null;
}

/**
 * Project routing preferences. Tier values are agent profile ids; unknown
 * ids are kept (the profile may come back) and reported at route time.
 * @param {unknown} raw
 * @returns {{ auto?: true, fast?: string, balanced?: string, strong?: string } | null}
 */
function normalizeModelRouting(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  /** @type {{ auto?: true, fast?: string, balanced?: string, strong?: string }} */
  const out = {};
  if (r.auto === true) out.auto = true;
  for (const tier of TIERS) {
    const v = r[tier];
    if (typeof v === "string" && v.trim()) out[tier] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Consume a thread's pending route before its first turn. Never throws: a
 * routing miss keeps the thread's current model and says so.
 *
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {string} prompt
 * @returns {string | null} transcript event text, or null when nothing to route
 */
function applyRoute(store, threadId, prompt) {
  const thread = store.getThread(threadId);
  const route = thread && normalizeRoute(thread.route);
  if (!thread || thread.route == null) return null;
  store.updateThread(threadId, { route: null });
  if (!route || thread.sessionId) return null;

  const { tier, reason } =
    route === "auto"
      ? classifyPrompt(prompt)
      : { tier: route, reason: "declared by the caller" };
  const head = `Auto routing: ${tier} (${reason})`;
  const project = store.getProject(thread.projectId);
  const profileId = project && project.modelRouting && project.modelRouting[tier];
  const settings = store.getSettings();
  const profile = profileId
    ? (settings.agentProfiles || []).find((p) => p.id === profileId)
    : null;
  if (!profile) {
    store.save();
    return `${head}; no profile set for ${tier} in this project, kept ${thread.provider}`;
  }
  const services = require("./services-threads.js");
  try {
    const { parseProviderRef } = require("./providerInstances.js");
    const base = parseProviderRef(profile.provider).provider;
    if (!services.providerInstalledFor(project, base)) {
      store.save();
      return `${head}; ${profile.name} needs ${base}, which is not installed, kept ${thread.provider}`;
    }
    services.setProvider(store, {
      threadId,
      provider: profile.provider,
      model: profile.model,
    });
    if (profile.reasoningEffort) {
      try {
        services.setReasoningEffort(store, {
          threadId,
          effort: profile.reasoningEffort,
        });
      } catch {
        // Effort the routed model cannot honour: provider default.
      }
    }
    // The routed profile's matrix gates this thread's tool calls (#262).
    store.updateThread(threadId, { agentProfileId: profile.id });
  } catch (err) {
    store.save();
    const msg = err instanceof Error ? err.message : String(err);
    return `${head}; could not apply ${profile.name} (${msg}), kept ${thread.provider}`;
  }
  store.save();
  return `${head} → ${profile.name}`;
}

module.exports = {
  TIERS,
  classifyPrompt,
  normalizeRoute,
  normalizeModelRouting,
  applyRoute,
};
