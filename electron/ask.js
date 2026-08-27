"use strict";

/**
 * Read-only Ask mode (issue #392): cheap no-tools Q&A answered from the
 * shared code index (#377) and memory. Never a worktree, never a tool loop,
 * never the daily budget. fm (free, on-device) first; provider print-mode
 * as fallback; retrieval-only text if both are missing.
 *
 * Pure prompt + completion helpers. The runner owns the thread state
 * machine; services owns startAsk / stopAsk. Same split as orchcommands.js.
 */

const { spawn } = require("cross-spawn");
const { getProvider, resolveBin, isBinAvailable } = require("./providers.js");
const { fmRun } = require("./fm.js");

const ASK_TIMEOUT_MS = 90_000;
const ASK_MAX_OUTPUT = 256 * 1024;
const ASK_PROMPT_LIMIT = 80_000;
const MEMORY_HITS = 8;
const MEMORY_BODY = 800;
const DIGEST_MESSAGES = 12;

const ASK_NOTE =
  "\n\n[Ask mode] You are answering a question about this repo. " +
  "You have no tools: do not edit files, run commands, spawn a worktree, " +
  "or start other agents. Answer only from the code map, memory, and " +
  "conversation below. If the context does not contain the answer, say so. " +
  "This turn does not burn agent credits.";

/** CLI-only fallback when prefetching bootstrap fails (issue #710). */
const MEMORY_BOOTSTRAP_NUDGE =
  "\n\n[Memory] Call memory_bootstrap with project set to your working directory " +
  "and treat its conventions as standing instructions.";

const BOOTSTRAP_SECTION_CAP = 12;

/**
 * Standing note for a missed intercept (defense in depth). Empty when off.
 * @param {{ ask?: boolean } | null | undefined} thread
 * @returns {string}
 */
function askNoteFor(thread) {
  return thread && thread.ask === true ? ASK_NOTE : "";
}

/**
 * @param {unknown} entries
 * @returns {string}
 */
function formatMemoryHits(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  const lines = ["[Memory]"];
  for (const raw of entries.slice(0, MEMORY_HITS)) {
    if (!raw || typeof raw !== "object") continue;
    const title = String(raw.title || "").trim();
    const body = String(raw.body || "").trim().slice(0, MEMORY_BODY);
    if (!title && !body) continue;
    lines.push(`- ${title || "(untitled)"}${body ? `: ${body}` : ""}`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

/**
 * Compact standing-memory pack for the CLI prompt. Empty when bootstrap
 * returned nothing usable. Truncation counts are surfaced so overflow is
 * not silent (issue #710).
 * @param {unknown} boot
 * @returns {string}
 */
function formatBootstrapNote(boot) {
  if (!boot || typeof boot !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (boot);
  const lines = ["[Memory bootstrap] Standing instructions for this project."];
  const section = (heading, rows, bodyKey) => {
    if (!Array.isArray(rows) || rows.length === 0) return;
    lines.push(`## ${heading}`);
    for (const raw of rows.slice(0, BOOTSTRAP_SECTION_CAP)) {
      if (!raw || typeof raw !== "object") continue;
      const title = String(raw.title || "").trim() || "(untitled)";
      const body = String(raw[bodyKey] || raw.body || raw.excerpt || "")
        .trim()
        .slice(0, MEMORY_BODY);
      lines.push(`- ${title}${body ? `: ${body}` : ""}`);
    }
  };
  section("Conventions", o.conventions, "body");
  section("Strategies", o.strategies, "body");
  section("Knowledge", o.knowledge, "excerpt");
  section("Active tasks", o.tasks, "body");
  const truncated =
    o.truncated && typeof o.truncated === "object" ? o.truncated : null;
  if (truncated) {
    const bits = [];
    for (const key of ["conventions", "strategies", "knowledge", "tasks"]) {
      const n = Number(truncated[key]) || 0;
      if (n > 0) bits.push(`${n} ${key}`);
    }
    if (bits.length) {
      lines.push(`(truncated: ${bits.join(", ")})`);
    }
  }
  return lines.length > 1 ? "\n\n" + lines.join("\n") : "";
}

/**
 * Prefetch memory_bootstrap for the CLI prompt (issue #710). Fail-open:
 * a down server becomes a one-line nudge instead of blocking the run.
 * Follow-up turns (live sessionId) skip the pack — it already rode turn one.
 *
 * @param {object} opts
 * @param {string} [opts.userDataPath]
 * @param {string} [opts.projectPath]
 * @param {boolean} [opts.firstTurn]
 * @param {(projectPath: string) => Promise<object>} [opts.bootstrapMemory]
 * @returns {Promise<string>}
 */
async function prefetchBootstrapNote(opts) {
  const firstTurn = !opts || opts.firstTurn !== false;
  if (!firstTurn) return "";
  const projectPath = opts && opts.projectPath ? String(opts.projectPath) : "";
  try {
    let boot;
    if (opts && typeof opts.bootstrapMemory === "function") {
      boot = await opts.bootstrapMemory(projectPath);
    } else {
      const userDataPath = opts && opts.userDataPath;
      if (!userDataPath) return "";
      const { createMemoryProxy } = require("./memory-proxy.js");
      const proxy = createMemoryProxy({ userDataPath });
      boot = await proxy.bootstrap({
        project: projectPath || undefined,
      });
    }
    return formatBootstrapNote(boot) || MEMORY_BOOTSTRAP_NUDGE;
  } catch {
    // Server down: fail-open silent. A nudge to call a missing tool is noise.
    return "";
  }
}

/**
 * Recent user/assistant turns, oldest first. Events and tools stay out.
 * @param {unknown} messages
 * @returns {string}
 */
function formatThreadDigest(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const kept = [];
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = String(m.text || "").trim();
    if (!text) continue;
    kept.push(m);
  }
  const slice = kept.slice(-DIGEST_MESSAGES);
  if (slice.length === 0) return "";
  const lines = ["[Conversation]"];
  for (const m of slice) {
    const who = m.role === "user" ? "User" : "Assistant";
    const text = String(m.text || "").trim().slice(0, 1200);
    lines.push(`${who}: ${text}`);
  }
  return lines.join("\n");
}

/**
 * Files whose path or symbols overlap the question tokens. Used by the
 * retrieval-only fallback — the full map still rides via codeIndexNoteFor.
 * @param {import('./codeindex.js').CodeIndex | null | undefined} index
 * @param {string} question
 * @returns {string}
 */
function formatMatchingFiles(index, question) {
  if (!index || !Array.isArray(index.files)) return "";
  const tokens = tokenize(question);
  if (tokens.length === 0) return "";
  /** @type {{ path: string, symbols: string[], score: number }[]} */
  const hits = [];
  for (const file of index.files) {
    if (!file || !file.path) continue;
    const symbols = Array.isArray(file.symbols) ? file.symbols : [];
    const hay = `${file.path} ${symbols.join(" ")}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (hay.includes(t)) score += 1;
    }
    if (score > 0) hits.push({ path: file.path, symbols, score });
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (hits.length === 0) return "";
  const lines = ["[Matching files]"];
  for (const h of hits.slice(0, 12)) {
    const sym = h.symbols.slice(0, 8).join(", ");
    lines.push(sym ? `- ${h.path} — ${sym}` : `- ${h.path}`);
  }
  return lines.join("\n");
}

/**
 * @param {string} question
 * @returns {string[]}
 */
function tokenize(question) {
  return String(question || "")
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((t) => t.length >= 2);
}

/**
 * @param {object} opts
 * @param {string} opts.question
 * @param {string} [opts.indexNote]
 * @param {string} [opts.memoryNote]
 * @param {string} [opts.digestNote]
 * @param {string} [opts.matchNote]
 * @returns {string}
 */
function buildAskPrompt(opts) {
  const question = String((opts && opts.question) || "").trim();
  const parts = [
    "You are answering a question about this repository.",
    "You have no tools. Do not edit files, run commands, spawn a worktree, or start other agents.",
    "Answer only from the code map, memory, and conversation below. If the context does not contain the answer, say so.",
    "",
    "Question:",
    question || "(empty)",
  ];
  const extras = [
    opts && opts.digestNote,
    opts && opts.memoryNote,
    opts && opts.matchNote,
    opts && opts.indexNote,
  ];
  for (const extra of extras) {
    const text = String(extra || "").trim();
    if (text) {
      parts.push("");
      parts.push(text);
    }
  }
  const prompt = parts.join("\n");
  if (prompt.length <= ASK_PROMPT_LIMIT) return prompt;
  return prompt.slice(0, ASK_PROMPT_LIMIT) + "\n… (context truncated)";
}

/**
 * When fm and print-mode are both unavailable: still answer from the pack.
 * @param {object} opts
 * @param {string} opts.question
 * @param {string} [opts.indexNote]
 * @param {string} [opts.memoryNote]
 * @param {string} [opts.matchNote]
 * @returns {string}
 */
function retrievalFallback(opts) {
  const question = String((opts && opts.question) || "").trim();
  const matchNote = String((opts && opts.matchNote) || "").trim();
  const memoryNote = String((opts && opts.memoryNote) || "").trim();
  const indexNote = String((opts && opts.indexNote) || "").trim();
  const chunks = [
    `I don't have a model on this machine, so this is what the repo map and memory have for “${question || "that"}”.`,
  ];
  if (matchNote) chunks.push(matchNote);
  if (memoryNote) chunks.push(memoryNote);
  if (!matchNote && !memoryNote && indexNote) {
    chunks.push(indexNote);
  }
  if (!matchNote && !memoryNote && !indexNote) {
    chunks.push(
      "The code map and memory are empty for this question. Start a regular thread to inspect the checkout.",
    );
  }
  return chunks.join("\n\n");
}

/**
 * Print-mode argv: one shot, no session, no MCP. Claude is capped at one
 * turn so a missed "no tools" instruction cannot start a tool loop.
 * Cursor uses `-p --mode ask` (read-only Q&A; `-p` is boolean).
 *
 * @param {string} providerId
 * @param {{ model?: string | null, prompt: string }} opts
 * @returns {string[] | null}
 */
function buildAskArgs(providerId, opts) {
  const { model, prompt } = opts;
  switch (providerId) {
    case "claude": {
      const args = ["-p", "--max-turns", "1"];
      if (model) args.push("--model", String(model));
      args.push(String(prompt));
      return args;
    }
    case "grok": {
      const args = [];
      if (model) args.push("-m", String(model));
      args.push("-p", String(prompt));
      return args;
    }
    case "codex": {
      const args = ["exec", "--json", "--skip-git-repo-check"];
      if (model) args.push("-m", String(model));
      args.push(String(prompt));
      return args;
    }
    case "opencode": {
      const args = ["run"];
      if (model) args.push("-m", String(model));
      args.push(String(prompt));
      return args;
    }
    case "kimi": {
      const args = [];
      if (model) args.push("-m", String(model));
      args.push("-p", String(prompt));
      return args;
    }
    case "cursor": {
      // `-p` is boolean (prompt last). `--mode ask` is the analog of Claude
      // `--max-turns 1` (read-only Q&A). `--trust` skips the workspace prompt.
      const args = ["-p", "--output-format", "text", "--trust", "--mode", "ask"];
      if (model) args.push("--model", String(model));
      args.push(String(prompt));
      return args;
    }
    default:
      return null;
  }
}

/**
 * Last agent_message from codex --json JSONL. Same shapes as commitmsg.js.
 * @param {string} stdout
 * @returns {string}
 */
function extractCodexText(stdout) {
  let last = "";
  for (const line of String(stdout).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    const item = ev.item;
    if (item && typeof item === "object") {
      if (typeof item.text === "string" && item.text) last = item.text;
      else if (typeof item.message === "string" && item.message) {
        last = item.message;
      }
      continue;
    }
    const msg = ev.msg;
    if (msg && typeof msg === "object" && typeof msg.message === "string") {
      last = msg.message;
      continue;
    }
    if (ev.type === "agent_message" && typeof ev.message === "string") {
      last = ev.message;
    }
  }
  return last;
}

/**
 * @param {string} providerId
 * @param {string} stdout
 * @returns {string}
 */
function extractAskText(providerId, stdout) {
  const raw =
    providerId === "codex" ? extractCodexText(stdout) : String(stdout || "");
  return raw.trim();
}

/**
 * Spawn print-mode. Resolves stdout on 0; rejects otherwise.
 * @param {string} bin
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ onHandle?: (h: { kill: () => void }) => void, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
function runAskPrint(bin, args, env, opts) {
  const timeoutMs =
    opts && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : ASK_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: undefined,
      env: env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        reject(new Error("Ask timed out"));
      });
    }, timeoutMs);
    if (opts && typeof opts.onHandle === "function") {
      opts.onHandle({
        kill() {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        },
      });
    }
    child.stdout.on("data", (chunk) => {
      if (out.length < ASK_MAX_OUTPUT) out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (err.length < ASK_MAX_OUTPUT) err += chunk;
    });
    child.on("error", (e) => {
      finish(() => reject(e));
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve(out);
        } else {
          const tail = err.trim().split("\n").slice(-3).join("\n");
          reject(new Error(tail || `Ask helper exited with code ${code}`));
        }
      });
    });
  });
}

/**
 * fm first (free), then the thread's provider in print-mode. Returns null
 * when neither produced text so the caller can fall back to retrieval.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.provider]
 * @param {string | null} [opts.model]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(prompt: string, o?: object) => Promise<string | null>} [opts.fmRun]
 * @param {(bin: string, args: string[], env?: NodeJS.ProcessEnv, o?: object) => Promise<string>} [opts.runPrint]
 * @param {(h: { kill: () => void }) => void} [opts.onHandle]
 * @returns {Promise<{ text: string, source: "fm" | "print" } | null>}
 */
async function completeAsk(opts) {
  const prompt = String((opts && opts.prompt) || "").trim();
  if (!prompt) return null;
  const env = (opts && opts.env) || process.env;
  const runFm = (opts && opts.fmRun) || fmRun;

  try {
    const fmOut = await runFm(prompt, { env, timeoutMs: ASK_TIMEOUT_MS });
    if (fmOut && String(fmOut).trim()) {
      return { text: String(fmOut).trim(), source: "fm" };
    }
  } catch {
    /* fall through */
  }

  const providerId = String((opts && opts.provider) || "");
  const entry = getProvider(providerId);
  if (!entry) return null;
  const args = buildAskArgs(entry.id, {
    model: opts && opts.model,
    prompt,
  });
  if (!args) return null;
  const bin = resolveBin(entry, env);
  if (!isBinAvailable(bin, undefined, env)) return null;

  const runPrint = (opts && opts.runPrint) || runAskPrint;
  try {
    const stdout = await runPrint(bin, args, env, {
      onHandle: opts && opts.onHandle,
    });
    const text = extractAskText(entry.id, stdout);
    if (!text) return null;
    return { text, source: "print" };
  } catch {
    return null;
  }
}

module.exports = {
  ASK_NOTE,
  MEMORY_BOOTSTRAP_NUDGE,
  ASK_TIMEOUT_MS,
  ASK_PROMPT_LIMIT,
  MEMORY_HITS,
  askNoteFor,
  formatMemoryHits,
  formatBootstrapNote,
  prefetchBootstrapNote,
  formatThreadDigest,
  formatMatchingFiles,
  buildAskPrompt,
  retrievalFallback,
  buildAskArgs,
  extractAskText,
  extractCodexText,
  runAskPrint,
  completeAsk,
};
