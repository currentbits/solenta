"use strict";

// cross-spawn, not child_process: on Windows the agent CLIs install as
// .cmd shims and Node refuses to exec those directly. cross-spawn routes
// them through cmd.exe with correct escaping, which matters because the
// prompt travels in argv (#442).
const spawn = require("cross-spawn");
const { getProvider, resolveBin, isBinAvailable } = require("./providers.js");
const {
  diff,
  assertNoOutboundSecrets,
  gitTryAsync,
  recordedBaseBranch,
  repoDefaultBranchAsync,
} = require("./worktrees.js");
const { readPrTemplate } = require("./prWorkspace.js");
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
    case "cursor": {
      // `-p` is boolean (prompt positional last), unlike grok's `-p <prompt>`.
      // `--mode ask` keeps print read-only; `--trust` skips the workspace prompt.
      const args = ["-p", "--output-format", "text", "--trust", "--mode", "ask"];
      if (model) args.push("--model", String(model));
      args.push(String(prompt));
      return args;
    }
    case "muse": {
      // One-shot print: never resume (--session-id omitted). Prompt last.
      const args = [
        "exec",
        "--json",
        "--trust-workspace",
        "--approval-mode",
        "never",
      ];
      if (model) args.push("--model", String(model));
      args.push(String(prompt));
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
  let text;
  if (providerId === "codex") text = extractCodexMessage(stdout);
  else if (providerId === "muse") text = require("./muse.js").extractStdoutText(stdout);
  else text = String(stdout);
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
  const d = await diff({ store, threadId });
  if (d.files.length === 0 && !d.patch.trim()) {
    throw new Error("No changes to describe");
  }
  const prompt = buildPrompt(d);

  // Prefer free on-device fm (#340). Any failure is invisible; fall through.
  // Tried BEFORE the provider is resolved: fm needs no CLI, no key and no
  // account, so a thread whose provider is missing or has no print mode still
  // gets a subject instead of an error.
  const fmOut = await fmRun(prompt, { env });
  if (fmOut) {
    const message = cleanSubject(fmOut);
    if (message) {
      assertNoOutboundSecrets(message, "commit message");
      return { message };
    }
  }

  const message = cleanSubject(await providerText(thread, prompt, env));
  if (!message) {
    throw new Error(`${providerLabel(thread)} returned an empty message`);
  }
  assertNoOutboundSecrets(message, "commit message");
  return { message };
}

/** @param {{ provider?: string }} thread */
function providerLabel(thread) {
  const entry = getProvider(thread.provider);
  return entry ? entry.name : String(thread.provider);
}

/**
 * Run the thread's provider CLI in print mode on one prompt and return the
 * model's raw reply text (codex/muse JSONL already unwrapped).
 *
 * @param {{ provider?: string, model?: string | null, worktreePath?: string | null }} thread
 * @param {string} prompt
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string>}
 */
async function providerText(thread, prompt, env) {
  const entry = getProvider(thread.provider);
  if (!entry) {
    throw new Error(`Provider has no print mode: ${thread.provider}`);
  }
  const args = buildSuggestArgs(entry.id, { model: thread.model, prompt });
  if (!args) {
    throw new Error(`Provider has no print mode: ${thread.provider}`);
  }
  const bin = resolveBin(entry, env);
  if (!isBinAvailable(bin, undefined, env)) {
    throw new Error(`${entry.name} CLI is not installed`);
  }
  const stdout = await runPrint(bin, args, thread.worktreePath || undefined, env);
  if (entry.id === "codex") return extractCodexMessage(stdout);
  if (entry.id === "muse") return require("./muse.js").extractStdoutText(stdout);
  return String(stdout);
}

/**
 * @param {{ commits: string, stat: string, template: string, baseBranch: string }} input
 * @returns {string}
 */
function buildPrPrompt(input) {
  const stat =
    input.stat.length > PROMPT_PATCH_LIMIT
      ? input.stat.slice(0, PROMPT_PATCH_LIMIT) + "\n... (truncated)"
      : input.stat;
  return [
    `Write a GitHub pull request title and description for this branch (base: ${input.baseBranch}).`,
    "Reply in exactly this shape, nothing else:",
    "line 1: the title (max 72 characters, no quotes, no trailing period)",
    "line 2: empty",
    "line 3 onward: the description in Markdown. Explain what changed and why; do not invent details the commits and diffstat do not show.",
    input.template.trim()
      ? "Fill in this pull request template for the description, keeping its headings:\n\n" +
        input.template.trim()
      : "",
    "",
    "Commits:",
    input.commits.trim() || "(none listed)",
    "",
    "Diffstat:",
    stat.trim() || "(none)",
  ].join("\n");
}

/**
 * Model reply -> { title, body }: first usable line is the title, the rest
 * (minus a wrapping code fence) is the body.
 *
 * @param {string} text
 * @returns {{ title: string, body: string }}
 */
function parsePrText(text) {
  const lines = String(text).replace(/\r\n/g, "\n").trim().split("\n");
  if (lines[0] && lines[0].trim().startsWith("```")) lines.shift();
  if (lines.length && lines[lines.length - 1].trim() === "```") lines.pop();
  const title = cleanSubject(lines.shift() || "").replace(/^title:\s*/i, "");
  return { title, body: lines.join("\n").trim() };
}

/**
 * Draft a PR title + body for the thread branch from its commit list, the
 * diffstat vs the base branch, and the repo's PR template, using the
 * thread's provider in print mode. Never opens the PR.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {Promise<{ title: string, body: string }>}
 */
async function suggestPrText(opts) {
  const { store, threadId } = opts;
  const env = opts.env || process.env;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const project = store.getProject(thread.projectId);
  const cwd = thread.worktreePath || (project && project.path);
  if (!cwd) {
    throw new Error("Thread has no checkout");
  }
  const baseBranch =
    recordedBaseBranch(thread) ||
    (await repoDefaultBranchAsync(project ? project.path : cwd));
  const [log, stat, tpl] = await Promise.all([
    gitTryAsync(cwd, ["log", "--format=- %s", `${baseBranch}..HEAD`]),
    gitTryAsync(cwd, ["diff", "--stat", `${baseBranch}...HEAD`]),
    readPrTemplate(project ? project.path : cwd),
  ]);
  const commits = log.ok ? log.stdout : "";
  if (!commits.trim()) {
    throw new Error(`Branch has no commits ahead of ${baseBranch}`);
  }
  const prompt = buildPrPrompt({
    commits,
    stat: stat.ok ? stat.stdout : "",
    template: tpl.ok ? tpl.body : "",
    baseBranch,
  });
  const out = parsePrText(await providerText(thread, prompt, env));
  if (!out.title) {
    throw new Error(`${providerLabel(thread)} returned an empty title`);
  }
  assertNoOutboundSecrets(`${out.title}\n${out.body}`, "PR");
  return out;
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
      reject(new Error("Text generation timed out"));
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
  suggestPrText,
  buildPrPrompt,
  parsePrText,
  buildSuggestArgs,
  buildPrompt,
  extractSubject,
  cleanSubject,
  extractCodexMessage,
  TIMEOUT_MS,
  PROMPT_PATCH_LIMIT,
};
