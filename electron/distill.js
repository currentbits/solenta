"use strict";

const { fmRun } = require("./fm.js");

/** Prompt body cap: same idea as fm-title.TITLE_PROMPT_LIMIT, a bit looser. */
const DISTILL_PROMPT_LIMIT = 6000;
const PHASE_NAME_MAX = 24;
const INSTRUCTION_MAX = 2000;
const WORKFLOW_NAME_MAX = 60;
const MIN_PHASES = 1;
const MAX_PHASES = 6;

/**
 * First non-empty user message: the prompt that started the work.
 * @param {Array<{ role?: string, text?: string }>} messages
 * @returns {string}
 */
function firstUserText(messages) {
  for (const m of messages || []) {
    if (!m || m.role !== "user") continue;
    const text = String(m.text || "").trim();
    if (text) return text;
  }
  return "";
}

/**
 * @param {unknown} raw
 * @param {number} max
 * @returns {string}
 */
function clip(raw, max) {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * @param {object} thread
 * @returns {{ provider: string, model: string | null }}
 */
function threadModel(thread) {
  const provider =
    thread && thread.provider != null && String(thread.provider).trim()
      ? String(thread.provider).trim()
      : "claude";
  const model =
    thread && thread.model != null && String(thread.model).trim() !== ""
      ? String(thread.model).trim()
      : null;
  return { provider, model };
}

/**
 * Deterministic draft when fm is missing or returns junk. One phase seeded
 * from the first user prompt, same provider/model as the thread.
 *
 * @param {object} thread
 * @param {Array<{ role?: string, text?: string }>} messages
 * @returns {{ name: string, phases: object[] }}
 */
function fallbackDistill(thread, messages) {
  const { provider, model } = threadModel(thread);
  const prompt = firstUserText(messages);
  const title = thread && thread.title != null ? String(thread.title).trim() : "";
  const name = clip(
    title && title !== "New Thread" ? title : prompt.split(/\r?\n/)[0] || "Repeat this thread",
    WORKFLOW_NAME_MAX,
  );
  const instruction = clip(
    prompt ? `Repeat this task:\n\n${prompt}` : "Repeat the work from this thread.",
    INSTRUCTION_MAX,
  );
  return {
    name,
    phases: [
      {
        name: "repeat",
        agentCount: 1,
        instruction,
        provider,
        model,
      },
    ],
  };
}

/**
 * Compact transcript for the local model. User/assistant text plus a tool
 * name list; event rows and empty bodies are dropped.
 *
 * @param {object} thread
 * @param {Array<{ role?: string, text?: string, tool?: { name?: string } }>} messages
 * @returns {string}
 */
function buildTranscript(thread, messages) {
  const title =
    thread && thread.title != null ? String(thread.title).trim() : "";
  const lines = [];
  if (title) {
    lines.push(`Title: ${title}`, "");
  }
  const tools = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === "tool") {
      const name = m.tool && m.tool.name ? String(m.tool.name) : String(m.text || "");
      if (name) tools.push(name.slice(0, 40));
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = String(m.text || "").trim();
    if (!text) continue;
    const label = m.role === "user" ? "User" : "Assistant";
    lines.push(`${label}:`, text, "");
  }
  if (tools.length) {
    const uniq = [...new Set(tools)].slice(0, 20);
    lines.push("Tools used:", uniq.join(", "));
  }
  const body = lines.join("\n").trim();
  return body.length <= DISTILL_PROMPT_LIMIT
    ? body
    : body.slice(0, DISTILL_PROMPT_LIMIT);
}

/**
 * @param {object} thread
 * @param {Array<{ role?: string, text?: string }>} messages
 * @returns {string}
 */
function buildDistillPrompt(thread, messages) {
  return [
    "Distill this finished agent thread into a reusable workflow template.",
    "Reply with ONLY JSON (no markdown fences, no explanation) matching:",
    '{"name":"short name","phases":[{"name":"phase","agentCount":1,"instruction":"..."}]}',
    "",
    "Rules:",
    "- 2 to 4 phases describing the work the agent actually did",
    "- each name at most 24 characters",
    "- each instruction is generic enough to re-run on a similar task (no one-off SHAs or absolute paths unless essential)",
    "- agentCount is an integer from 1 to 4",
    "- do not include provider or model",
    "",
    buildTranscript(thread, messages) || "(empty thread)",
  ].join("\n");
}

/**
 * Pull a JSON object out of fm stdout. Fences and leading prose are junk
 * wrappers, not a reason to fall back, if a parseable object is inside.
 *
 * @param {string | null} raw
 * @returns {object | null}
 */
function extractJsonObject(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const tryParse = (s) => {
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // not JSON
    }
    return null;
  };
  const direct = tryParse(candidate);
  if (direct) return direct;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(candidate.slice(start, end + 1));
  return null;
}

/**
 * @param {unknown} n
 * @returns {number}
 */
function clampAgentCount(n) {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 1;
  const i = Math.round(x);
  if (i < 1) return 1;
  if (i > 4) return 4;
  return i;
}

/**
 * Turn an fm payload into a save-ready DistilledWorkflow, or null when it
 * cannot be made valid. Provider/model always come from the thread.
 *
 * @param {string | null} raw
 * @param {object} thread
 * @returns {{ name: string, phases: object[] } | null}
 */
function parseDistilled(raw, thread) {
  const obj = extractJsonObject(raw);
  if (!obj) return null;
  const { provider, model } = threadModel(thread);
  const phasesIn = Array.isArray(obj.phases) ? obj.phases : null;
  if (!phasesIn) return null;

  const phases = [];
  for (const phase of phasesIn) {
    if (!phase || typeof phase !== "object") continue;
    const name = clip(phase.name, PHASE_NAME_MAX);
    const instruction = clip(phase.instruction, INSTRUCTION_MAX);
    if (!name || !instruction) continue;
    phases.push({
      name,
      agentCount: clampAgentCount(phase.agentCount),
      instruction,
      provider,
      model,
    });
    if (phases.length >= MAX_PHASES) break;
  }
  if (phases.length < MIN_PHASES) return null;

  const title = thread && thread.title != null ? String(thread.title).trim() : "";
  const name = clip(
    obj.name || title || "Distilled workflow",
    WORKFLOW_NAME_MAX,
  );
  if (!name) return null;
  return { name, phases };
}

/**
 * Distill a finished thread into a workflow draft. Nothing is persisted.
 * fm is best-effort: unavailable or junk output falls back to a single
 * phase seeded from the first user prompt. Never rejects for a missing
 * local model.
 *
 * @param {object} store
 * @param {string} threadId
 * @param {{ env?: NodeJS.ProcessEnv, fmRun?: (prompt: string, opts?: object) => Promise<string | null> }} [opts]
 * @returns {Promise<{ name: string, phases: object[] }>}
 */
async function distillThread(store, threadId, opts = {}) {
  const id = threadId != null ? String(threadId) : "";
  const thread = store.getThread(id);
  if (!thread) {
    throw new Error(`Unknown thread: ${id}`);
  }
  const messages = store.getMessages(id) || [];
  const fallback = fallbackDistill(thread, messages);

  try {
    const run = opts.fmRun || fmRun;
    const raw = await run(buildDistillPrompt(thread, messages), {
      env: opts.env,
    });
    const parsed = parseDistilled(raw, thread);
    if (parsed) return parsed;
  } catch {
    // Missing fm, timeout, or a thrown parser: same as junk.
  }
  return fallback;
}

module.exports = {
  DISTILL_PROMPT_LIMIT,
  PHASE_NAME_MAX,
  INSTRUCTION_MAX,
  distillThread,
  fallbackDistill,
  buildDistillPrompt,
  parseDistilled,
};
