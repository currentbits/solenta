"use strict";

const { spawn } = require("node:child_process");
const { getProvider, resolveBin, isBinAvailable } = require("./providers.js");
const { diff } = require("./worktrees.js");
const { fmRun } = require("./fm.js");

const TIMEOUT_MS = 60000;
/** Diff body is truncated well under the IPC 100k cap; models need the shape, not every hunk. */
const PROMPT_PATCH_LIMIT = 20000;
const MAX_OUTPUT = 256 * 1024;

/**
 * Print-mode argv per provider: plain text (or parseable JSONL for codex) on
 * stdout, one prompt, no session. Deliberately NOT providers.buildArgs, which
 * is tuned for interactive streaming runs (claude emits --output-format
 * stream-json there; grok requests streaming-messages-json).
 *
 * @param {string} providerId
 * @param {{ model?: string | null, prompt: string }} opts
 * @returns {string[] | null} null for providers with no print mode
 */
function buildSuggestArgs(providerId, opts) {
  const { model, prompt } = opts;
  switch (providerId) {
    case "claude": {
      // -p prints plain text by default (stream-json is opt-in).
      const args = ["-p"];
      if (model) args.push("--model", String(model));
      args.push(String(prompt));
      return args;
    }
    case "grok": {
      // Headless default output is text; -p takes the prompt as its value.
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
      // -p prints text by default (stream-json is opt-in).
      const args = [];
      if (model) args.push("-m", String(model));
      args.push("-p", String(prompt));
      return args;
    }
    default:
      return null;
  }
}

/**
 * Last agent_message text from codex --json JSONL. Mirrors the shapes
 * electron/codex.js handles (item.completed with item.type agent_message,
 * msg variants, bare {type:"agent_message", message}).
 *
 * @param {string} stdout
 * @returns {string}
 */
function extractCodexMessage(stdout) {
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
      const itemType = item.type;
      if (itemType === "agent_message" || itemType === "message") {
        if (typeof item.text === "string") last = item.text;
        else if (typeof item.message === "string") last = item.message;
        continue;
      }
    }
    const msg = ev.msg;
    if (msg && typeof msg === "object") {
      if (
        (msg.type === "agent_message" ||
          msg.type === "agent_message_content_delta") &&
        typeof msg.message === "string"
      ) {
        last = msg.message;
        continue;
      }
    }
    if (ev.type === "agent_message" && typeof ev.message === "string") {
      last = ev.message;
    }
  }
  return last;
}

/**
 * Raw model output -> commit subject: drop code fences, take the first
 * non-empty line, strip wrapping quotes/backticks.
 *
 * @param {string} text
 * @returns {string} empty when nothing usable came back
 */
function cleanSubject(text) {
  for (const raw of String(text).split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("```")) continue;
    line = line.replace(/^["'`]+|["'`]+$/g, "").trim();
    if (line) return line;
  }
  return "";
}

/**
 * Pull the commit subject out of a provider's raw stdout.
 * @param {string} providerId
 * @param {string} stdout
 * @returns {string}
 */
function extractSubject(providerId, stdout) {
  const text =
    providerId === "codex" ? extractCodexMessage(stdout) : String(stdout);
  return cleanSubject(text);
}

/**
 * @param {string} prompt
 * @param {{ files: Array<{path: string, status: string, additions: number, deletions: number}>, patch: string }} d
 * @returns {string}
 */
function buildPrompt(d) {
  const fileLines = d.files
    .slice(0, 50)
    .map((f) => `${f.status} ${f.path} (+${f.additions}/-${f.deletions})`)
    .join("\n");
  const patch =
    d.patch.length > PROMPT_PATCH_LIMIT
      ? d.patch.slice(0, PROMPT_PATCH_LIMIT) + "\n... (diff truncated)"
      : d.patch;
  return [
    "Write a single-line git commit message (conventional commits style) for these changes.",
    "Reply with ONLY the message: no explanation, no quotes, no backticks, no trailing period, max 72 characters.",
    "",
    "Files changed:",
    fileLines || "(none listed)",
    "",
    "Diff:",
    patch || "(no patch body)",
  ].join("\n");
}

/**
 * Generate a commit message for the thread's uncommitted changes using the
 * thread's own provider CLI in print mode. Never commits.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {NodeJS.ProcessEnv} [opts.env] - test hook for CODER_*_BIN overrides
 * @returns {Promise<{ message: string }>}
 */
async function suggestCommitMessage(opts) {
  const { store, threadId } = opts;
  const env = opts.env || process.env;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const entry = getProvider(thread.provider);
  if (!entry) {
    throw new Error(`Provider has no print mode: ${thread.provider}`);
  }
  const args = buildSuggestArgs(entry.id, {
    model: thread.model,
    prompt: "", // placeholder; real prompt below
  });
  if (!args) {
    throw new Error(`Provider has no print mode: ${thread.provider}`);
  }
  const bin = resolveBin(entry, env);
  if (!isBinAvailable(bin, undefined, env)) {
    throw new Error(`${entry.name} CLI is not installed`);
  }

  const d = await diff({ store, threadId });
  if (d.files.length === 0 && !d.patch.trim()) {
    throw new Error("No changes to describe");
  }
  const prompt = buildPrompt(d);
  // The prompt is the trailing argv element for every provider above.
  args[args.length - 1] = prompt;

  // Prefer free on-device fm (#340). Any failure is invisible; fall through.
  const fmOut = await fmRun(prompt, { env });
  if (fmOut) {
    const message = cleanSubject(fmOut);
    if (message) return { message };
  }

  const stdout = await runPrint(bin, args, thread.worktreePath || undefined, env);
  const message = extractSubject(entry.id, stdout);
  if (!message) {
    throw new Error(`${entry.name} returned an empty message`);
  }
  return { message };
}

/**
 * Spawn a print-mode CLI and resolve with stdout. Kills on timeout.
 * @param {string} bin
 * @param {string[]} args
 * @param {string} [cwd]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>}
 */
function runPrint(bin, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Commit message generation timed out"));
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      if (out.length < MAX_OUTPUT) out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (err.length < MAX_OUTPUT) err += chunk;
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(out);
      } else {
        const tail = err.trim().split("\n").slice(-3).join("\n");
        reject(
          new Error(tail || `Message generator exited with code ${code}`),
        );
      }
    });
  });
}

module.exports = {
  suggestCommitMessage,
  buildSuggestArgs,
  buildPrompt,
  extractSubject,
  cleanSubject,
  extractCodexMessage,
  TIMEOUT_MS,
  PROMPT_PATCH_LIMIT,
};
