"use strict";

const {
  getProvider,
  resolveBin,
  isBinAvailable,
} = require("./providers.js");

/**
 * Deterministic non-negative int seed from threadId + runId.
 * @param {string} threadId
 * @param {string} runId
 */
function hashSeed(threadId, runId) {
  const s = `${threadId}${runId}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) >>> 0;
}

/**
 * Capitalize first letter for work log labels.
 * @param {string} name
 */
function capitalize(name) {
  if (!name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Truncate a string to max chars.
 * @param {unknown} s
 * @param {number} max
 */
function truncate(s, max) {
  const str = String(s ?? "");
  return str.length <= max ? str : str.slice(0, max);
}

/**
 * Display model label for an agent in the workflow view.
 * @param {{ model?: string | null, provider: string }} phase
 */
function agentModelLabel(phase) {
  if (phase.model != null && phase.model !== "") {
    return String(phase.model);
  }
  const entry = getProvider(phase.provider);
  if (entry && Array.isArray(entry.models) && entry.models.length > 0) {
    return entry.models[0];
  }
  return "default";
}

/**
 * Build the initial WorkflowView from a resolved template.
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.name
 * @param {object} opts.template
 */
function buildWorkflowView({ runId, name, template }) {
  const phases = (template.phases || []).map((phase, phaseIndex) => {
    const count = Math.max(1, Math.min(4, Number(phase.agentCount) || 1));
    const model = agentModelLabel(phase);
    /** @type {object[]} */
    const agents = [];
    for (let i = 0; i < count; i++) {
      agents.push({
        id: `${phaseIndex}:${phase.name}:${i}`,
        model,
        status: "pending",
        tokensUsed: 0,
        // Per-slot CLI session. Must not be written to thread.sessionId
        // (a later interactive turn would resume it).
        sessionId: null,
      });
    }
    return {
      name: phase.name,
      pipelined: false,
      agents,
      // Internal: keep phase provider/model for spawn
      __provider: phase.provider,
      __model: phase.model != null && phase.model !== "" ? phase.model : null,
      __instruction: phase.instruction || "",
      __agentCount: count,
    };
  });
  return recomputeView({
    __orchestrated: true,
    id: runId,
    name,
    phases,
  });
}

/**
 * Recompute settled/total/tokensTotal/complete from agent statuses.
 * @param {object} view
 */
function recomputeView(view) {
  let settled = 0;
  let total = 0;
  let tokensTotal = 0;
  for (const phase of view.phases) {
    for (const agent of phase.agents) {
      total += 1;
      tokensTotal += Number(agent.tokensUsed) || 0;
      if (agent.status === "settled" || agent.status === "failed") {
        settled += 1;
      }
    }
  }
  view.settled = settled;
  view.total = total;
  view.tokensTotal = tokensTotal;
  view.complete =
    total > 0 &&
    settled === total &&
    view.phases.every((p) =>
      p.agents.every((a) => a.status === "settled"),
    );
  return view;
}

/**
 * Public WorkflowView strip (no internal flags).
 * @param {object} view
 */
function toPublicView(view) {
  if (!view) return null;
  recomputeView(view);
  return {
    id: view.id,
    name: view.name,
    phases: view.phases.map((phase) => ({
      name: phase.name,
      pipelined: Boolean(phase.pipelined),
      agents: phase.agents.map((agent) => ({
        id: agent.id,
        model: agent.model,
        status: agent.status,
        tokensUsed: agent.tokensUsed,
        sessionId: agent.sessionId || null,
      })),
    })),
    settled: view.settled,
    total: view.total,
    tokensTotal: view.tokensTotal,
    complete: view.complete,
  };
}

/**
 * @param {object} view
 * @param {string} agentId
 */
function findAgent(view, agentId) {
  for (const phase of view.phases) {
    for (const agent of phase.agents) {
      if (agent.id === agentId) return agent;
    }
  }
  return null;
}

/**
 * Parse `phaseIndex:phaseName:agentIndex` (phase names may contain ':').
 * @param {string} agentId
 * @returns {{ phaseIndex: number, phaseName: string, agentIndex: number } | null}
 */
function parseAgentId(agentId) {
  const str = String(agentId || "");
  const first = str.indexOf(":");
  const last = str.lastIndexOf(":");
  if (first < 0 || last <= first) return null;
  const phaseIndex = Number(str.slice(0, first));
  const agentIndex = Number(str.slice(last + 1));
  const phaseName = str.slice(first + 1, last);
  if (!Number.isInteger(phaseIndex) || !Number.isInteger(agentIndex)) {
    return null;
  }
  return { phaseIndex, phaseName, agentIndex };
}

/**
 * Prior-phase outputs for prompt chaining, from settled agent text.
 * @param {object} view
 * @param {number} beforePhaseIndex
 */
function collectPriorOutputs(view, beforePhaseIndex) {
  /** @type {{ phaseName: string, agentIndex: number, text: string }[]} */
  const out = [];
  for (let i = 0; i < beforePhaseIndex; i++) {
    const phase = view.phases[i];
    if (!phase) continue;
    phase.agents.forEach((agent, agentIndex) => {
      out.push({
        phaseName: phase.name,
        agentIndex,
        text: agent.status === "settled" ? String(agent.__text || "") : "",
      });
    });
  }
  return out;
}

/**
 * @param {object} phase
 */
function phaseSpecFromView(phase) {
  return {
    name: phase.name,
    provider: phase.__provider,
    model: phase.__model,
    instruction: phase.__instruction || "",
    agentCount: phase.__agentCount || phase.agents.length,
  };
}

/**
 * Build the per-agent prompt for a phase.
 * @param {object} opts
 * @param {string} opts.userPrompt
 * @param {string} opts.instruction
 * @param {number} opts.agentIndex - 0-based within phase
 * @param {number} opts.agentCount
 * @param {{ phaseName: string, agentIndex: number, text: string }[]} opts.priorOutputs
 */
function buildAgentPrompt(opts) {
  const {
    userPrompt,
    instruction,
    agentIndex,
    agentCount,
    priorOutputs = [],
  } = opts;

  const parts = [];
  parts.push(`Original task:\n${userPrompt}`);

  if (priorOutputs.length > 0) {
    const blocks = priorOutputs.map(
      (o) =>
        `--- ${o.phaseName} agent ${o.agentIndex + 1} ---\n${o.text || "(unavailable)"}`,
    );
    parts.push(`Previous phase outputs:\n${blocks.join("\n\n")}`);
  }

  parts.push(String(instruction || ""));

  if (agentCount > 1) {
    parts.push(
      `You are agent ${agentIndex + 1} of ${agentCount}; take a distinct angle from the other agents.`,
    );
  }

  return parts.join("\n\n");
}

/**
 * Assert every phase provider binary is available. Throws naming the binary.
 * @param {object} template
 */
function assertTemplateProvidersAvailable(template) {
  for (const phase of template.phases || []) {
    const entry = getProvider(phase.provider);
    if (!entry || entry.kind === "simulate") {
      throw new Error(
        `Unknown provider for phase "${phase.name}": ${phase.provider}`,
      );
    }
    const bin = resolveBin(entry);
    if (!isBinAvailable(bin)) {
      throw new Error(
        `Provider binary not found: ${bin}. Install it or set ${entry.binEnv || "the provider binary env var"}.`,
      );
    }
  }
}

/**
 * Kickoff event text from a template.
 * @param {object} template
 */
function kickoffText(template) {
  let total = 0;
  const lines = [];
  for (const phase of template.phases || []) {
    const n = Number(phase.agentCount) || 1;
    total += n;
    lines.push(`${phase.name} ${n}`);
  }
  const from = template.source ? ` from ${template.source}` : "";
  return [`Kicked off ${total} subagents${from}`, ...lines].join("\n");
}

module.exports = {
  hashSeed,
  capitalize,
  truncate,
  agentModelLabel,
  buildWorkflowView,
  recomputeView,
  toPublicView,
  findAgent,
  parseAgentId,
  collectPriorOutputs,
  phaseSpecFromView,
  buildAgentPrompt,
  assertTemplateProvidersAvailable,
  kickoffText,
};
