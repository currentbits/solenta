"use strict";

/**
 * User lifecycle hooks (#1724): `.solenta/hooks.json` in a project plus
 * `hooks.json` in userData, run on PreToolUse / PostToolUse /
 * UserPromptSubmit / Stop for every provider.
 *
 * A project file is code from the repo: it runs only once the user has
 * approved that exact content (sha256) in Settings, and any edit needs a
 * new approval. Invalid files are reported, never thrown, so a bad
 * hooks.json cannot block a run.
 *
 * At run start the runner writes the hooks a thread may run into
 * `user-hooks/threads/<id>.json`; native PreToolUse bridges (Claude
 * settings hooks, the Codex overlay hook) read it through
 * SOLENTA_USER_HOOKS, and the runner reads it for the other events.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const run = require("./user-hooks-run.js");

const EVENTS = Object.freeze([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
]);
const PROJECT_FILE = path.join(".solenta", "hooks.json");
const USER_FILE = "hooks.json";
const TRUST_FILE = path.join("user-hooks", "trust.json");
const RESULTS_FILE = path.join("user-hooks", "results.jsonl");
const RESULTS_COMPACT_BYTES = 256 * 1024;
// Providers whose CLI calls Solenta before a tool runs. The rest get
// PreToolUse from the transcript, after the fact.
const NATIVE_PRE_TOOL = Object.freeze(["claude", "codex"]);
const HOOK_KEYS = new Set(["event", "matcher", "command", "timeoutMs"]);

/**
 * Strict shape check. Returns the hooks or the first problem.
 * @param {string} text
 * @returns {{ hooks: Array<{ event: string, matcher?: string, command: string[], timeoutMs: number }>, error: string | null }}
 */
function validateHooksConfig(text) {
  const fail = (error) => ({ hooks: [], error });
  let doc;
  try {
    doc = JSON.parse(String(text).replace(/^﻿/, ""));
  } catch (err) {
    return fail(`Not valid JSON: ${err.message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return fail("Top level must be an object");
  }
  const extra = Object.keys(doc).filter((k) => k !== "hooks");
  if (extra.length) return fail(`Unknown key "${extra[0]}"`);
  if (!Array.isArray(doc.hooks)) return fail('"hooks" must be an array');
  const hooks = [];
  for (let i = 0; i < doc.hooks.length; i++) {
    const h = doc.hooks[i];
    const at = `hooks[${i}]`;
    if (!h || typeof h !== "object" || Array.isArray(h)) {
      return fail(`${at} must be an object`);
    }
    const bad = Object.keys(h).find((k) => !HOOK_KEYS.has(k));
    if (bad) return fail(`${at}: unknown key "${bad}"`);
    if (!EVENTS.includes(h.event)) {
      return fail(`${at}.event must be one of ${EVENTS.join(", ")}`);
    }
    if (h.matcher !== undefined) {
      if (!run.TOOL_EVENTS.has(h.event)) {
        return fail(`${at}.matcher only applies to PreToolUse and PostToolUse`);
      }
      if (typeof h.matcher !== "string") {
        return fail(`${at}.matcher must be a string`);
      }
      try {
        new RegExp(h.matcher === "*" ? "" : h.matcher);
      } catch {
        return fail(`${at}.matcher is not a valid regular expression`);
      }
    }
    if (
      !Array.isArray(h.command) ||
      h.command.length === 0 ||
      h.command.some((a) => typeof a !== "string") ||
      h.command[0].trim() === ""
    ) {
      return fail(`${at}.command must be a non-empty array of strings (argv, no shell)`);
    }
    let timeoutMs = run.DEFAULT_TIMEOUT_MS;
    if (h.timeoutMs !== undefined) {
      if (
        !Number.isInteger(h.timeoutMs) ||
        h.timeoutMs < 1 ||
        h.timeoutMs > run.MAX_TIMEOUT_MS
      ) {
        return fail(`${at}.timeoutMs must be an integer from 1 to ${run.MAX_TIMEOUT_MS}`);
      }
      timeoutMs = h.timeoutMs;
    }
    /** @type {{ event: string, matcher?: string, command: string[], timeoutMs: number }} */
    const hook = { event: h.event, command: h.command.slice(), timeoutMs };
    if (h.matcher !== undefined) hook.matcher = h.matcher;
    hooks.push(hook);
  }
  return { hooks, error: null };
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** True when `child` is strictly below `root` (both resolved). */
function isInside(root, child, p = path) {
  const rel = p.relative(root, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}

/**
 * #1737: argv elements that name a plain file inside the project, resolved
 * (symlinks followed) against the checkout. Flags and words that are not
 * files are skipped; a bare argv[0] is a PATH lookup on POSIX, not a file.
 * @param {string} root  project checkout
 * @param {string[]} command
 * `--flag=path` values count too (`node --require=./x.js`); `prefix` keeps
 * the `--flag=` part for the argv rewrite.
 * @returns {Array<{ index: number, prefix: string, path: string, abs: string, sha256: string }>}
 */
function scriptRefs(root, command) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return [];
  }
  const refs = [];
  command.forEach((arg, index) => {
    if (!arg) return;
    let prefix = "";
    let target = arg;
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      if (eq < 0) return;
      prefix = arg.slice(0, eq + 1);
      target = arg.slice(eq + 1);
      if (!target) return;
    }
    if (index === 0 && process.platform !== "win32" && path.basename(arg) === arg) return;
    try {
      const abs = fs.realpathSync(path.resolve(realRoot, target));
      if (!isInside(realRoot, abs) || !fs.statSync(abs).isFile()) return;
      const rel = path.relative(realRoot, abs).split(path.sep).join("/");
      refs.push({ index, prefix, path: rel, abs, sha256: sha256(fs.readFileSync(abs)) });
    } catch {
      // missing or unreadable: not a script reference
    }
  });
  return refs;
}

/** Every distinct script the project hooks reference, sorted by path. */
function allScripts(hooks) {
  const byPath = new Map();
  for (const h of hooks) for (const s of h.scripts || []) byPath.set(s.path, s);
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * @param {string} file
 * @param {"user" | "project"} source
 * @param {string} [root]  project checkout: hash the repo scripts too (#1737)
 */
function readSource(file, source, root) {
  /** @type {{ source: string, path: string, exists: boolean, hash: string | null, hooks: any[], error: string | null }} */
  const out = { source, path: file, exists: false, hash: null, hooks: [], error: null };
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (err) {
    if (err && err.code !== "ENOENT") out.error = String(err.message || err);
    return out;
  }
  out.exists = true;
  const v = validateHooksConfig(raw.toString("utf8"));
  out.hooks = v.hooks.map((h, i) => ({
    ...h,
    id: `${source}:${i}`,
    source,
    ...(root ? { scripts: scriptRefs(root, h.command) } : {}),
  }));
  out.error = v.error;
  // No scripts → plain sha256 of hooks.json, so approvals from before #1737 hold.
  const h = crypto.createHash("sha256").update(raw);
  for (const s of allScripts(out.hooks)) h.update(`\0${s.path}\0${s.sha256}`);
  out.hash = h.digest("hex");
  return out;
}

function readTrust(userDataPath) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(userDataPath, TRUST_FILE), "utf8"));
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function projectFile(projectPath) {
  return path.join(path.resolve(projectPath), PROJECT_FILE);
}

/**
 * Both files, validated, with the project file's trust state.
 * @param {{ userDataPath: string, projectPath?: string | null }} opts
 */
function loadHooks(opts) {
  const user = readSource(path.join(opts.userDataPath, USER_FILE), "user");
  const project = opts.projectPath
    ? readSource(projectFile(opts.projectPath), "project", opts.projectPath)
    : null;
  let trusted = false;
  if (project && project.hash) {
    trusted = readTrust(opts.userDataPath)[project.path] === project.hash;
  }
  return { user, project: project ? { ...project, trusted } : null };
}

/**
 * Hooks a run may execute: valid user hooks + approved project hooks.
 * Project script arguments point at the checkout copy, never the thread's
 * worktree, and carry every approved script hash so the runtime can refuse
 * to run once any of them changes (#1737).
 */
function effectiveHooks(opts) {
  const { user, project } = loadHooks(opts);
  const out = user.error ? [] : user.hooks.slice();
  if (project && project.trusted && !project.error) {
    const verify = allScripts(project.hooks).map(({ path: p, abs, sha256: s }) => ({
      path: p,
      abs,
      sha256: s,
    }));
    for (const { scripts, ...h } of project.hooks) {
      const command = h.command.slice();
      for (const s of scripts || []) command[s.index] = `${s.prefix || ""}${s.abs}`;
      out.push({ ...h, command, ...(verify.length ? { verify } : {}) });
    }
  }
  return out;
}

/**
 * Approve the project file — only if it still has the content the user saw.
 * @param {{ userDataPath: string, projectPath: string, hash: string }} opts
 */
function approveProjectHooks(opts) {
  const project = readSource(projectFile(opts.projectPath), "project", opts.projectPath);
  if (!project.hash) throw new Error("This project has no .solenta/hooks.json");
  if (project.hash !== opts.hash) {
    throw new Error(
      "hooks.json or a script it runs changed since you reviewed it. Review it again.",
    );
  }
  const trust = readTrust(opts.userDataPath);
  trust[project.path] = project.hash;
  const file = path.join(opts.userDataPath, TRUST_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(trust, null, 2) + "\n");
  return { hash: project.hash };
}

function resultsPath(userDataPath) {
  return path.join(userDataPath, RESULTS_FILE);
}

/**
 * Last run per hook id. Hook processes append; this read compacts the
 * log once it passes 256 KB.
 * @param {string} userDataPath
 * @returns {Record<string, object>}
 */
function lastResults(userDataPath) {
  const file = resultsPath(userDataPath);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  /** @type {Record<string, object>} */
  const last = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.id) last[r.id] = r;
    } catch {
      // torn line from a concurrent append
    }
  }
  if (text.length > RESULTS_COMPACT_BYTES) {
    try {
      fs.writeFileSync(
        file,
        Object.values(last).map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
    } catch {
      // next read retries
    }
  }
  return last;
}

/**
 * Settings view: every hook from both files with its last run.
 * @param {{ userDataPath: string, projectPath?: string | null }} opts
 */
function listHooks(opts) {
  const { user, project } = loadHooks(opts);
  const last = lastResults(opts.userDataPath);
  const describe = (src) =>
    src && {
      path: src.path,
      exists: src.exists,
      hash: src.hash,
      error: src.error,
      ...(src.source === "project" ? { trusted: src.trusted } : {}),
      hooks: src.hooks.map((h) => ({
        id: h.id,
        event: h.event,
        matcher: h.matcher ?? null,
        command: h.command,
        timeoutMs: h.timeoutMs,
        ...(src.source === "project"
          ? { scripts: (h.scripts || []).map((s) => ({ path: s.path, sha256: s.sha256 })) }
          : {}),
        lastRun: last[h.id] || null,
      })),
    };
  return {
    user: describe(user),
    project: describe(project),
    nativePreToolUse: NATIVE_PRE_TOOL.slice(),
  };
}

function threadHooksFile(userDataPath, threadId) {
  const safe = String(threadId).replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(userDataPath, "user-hooks", "threads", `${safe}.json`);
}

/**
 * Write (or clear) the thread's resolved hooks for this run.
 * @param {{ userDataPath: string, projectPath?: string | null, threadId: string, provider?: string, model?: string | null, cwd: string }} opts
 * @returns {{ file: string, hooks: any[] } | null}
 */
function prepareRunHooks(opts) {
  if (!opts.userDataPath || !opts.threadId) return null;
  const file = threadHooksFile(opts.userDataPath, opts.threadId);
  let hooks = [];
  try {
    hooks = effectiveHooks(opts);
  } catch {
    hooks = [];
  }
  if (!hooks.length) {
    fs.rmSync(file, { force: true });
    return null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      threadId: opts.threadId,
      provider: opts.provider || null,
      model: opts.model || null,
      cwd: opts.cwd,
      resultsPath: resultsPath(opts.userDataPath),
      hooks,
    }),
  );
  return { file, hooks };
}

/**
 * Runner-side events: run the thread's hooks for `event`.
 * @param {{ userDataPath: string, threadId: string, event: string, toolName?: string, payload?: object }} opts
 */
async function runThreadEvent(opts) {
  const file = threadHooksFile(opts.userDataPath, opts.threadId);
  const resolved = run.readResolved(file);
  if (!resolved || !resolved.hooks.some((h) => h.event === opts.event)) return null;
  return run.runHooks({
    hooks: resolved.hooks,
    event: opts.event,
    toolName: opts.toolName,
    cwd: resolved.cwd,
    payload: {
      event: opts.event,
      hook_event_name: opts.event,
      thread_id: resolved.threadId,
      provider: resolved.provider,
      model: resolved.model,
      cwd: resolved.cwd,
      ...(opts.payload || {}),
    },
    onResult: (r) => run.appendResult(resolved.resultsPath, r),
  });
}

/** A plausible payload per event, for the Settings "Test" button. */
function samplePayload(event, cwd) {
  const base = {
    event,
    hook_event_name: event,
    thread_id: "test",
    provider: "claude",
    model: null,
    cwd,
    test: true,
  };
  if (run.TOOL_EVENTS.has(event)) {
    return {
      ...base,
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      ...(event === "PostToolUse" ? { tool_response: "hello" } : {}),
    };
  }
  if (event === "UserPromptSubmit") return { ...base, prompt: "Test prompt" };
  return base;
}

/**
 * Run one hook by id with a sample payload. An untrusted project hook
 * may be tested: the user clicking Test is the approval for that run.
 * @param {{ userDataPath: string, projectPath?: string | null, id: string }} opts
 */
async function testHook(opts) {
  const { user, project } = loadHooks(opts);
  const all = [...user.hooks, ...(project ? project.hooks : [])];
  const hook = all.find((h) => h.id === opts.id);
  if (!hook) throw new Error(`No hook ${opts.id}`);
  const cwd = opts.projectPath ? path.resolve(opts.projectPath) : opts.userDataPath;
  const r = await run.runOne(hook, samplePayload(hook.event, cwd), cwd);
  run.appendResult(resultsPath(opts.userDataPath), r);
  return {
    id: r.id,
    event: r.event,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    timedOut: r.timedOut,
    error: r.error,
    output: r.output,
    at: r.at,
  };
}

/**
 * Claude `--settings` hooks block for native PreToolUse, or null when no
 * PreToolUse hook is configured.
 * @param {string} runtimeDir  copyGuardrailRuntime output
 * @param {any[]} hooks
 */
function claudeSettingsHooks(runtimeDir, hooks) {
  if (!hooks.some((h) => h.event === "PreToolUse")) return null;
  const script = path.join(runtimeDir, "user-hooks-run.js");
  return {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: `node ${JSON.stringify(script)} PreToolUse`,
            timeout: preToolBudgetSec(hooks),
          },
        ],
      },
    ],
  };
}

/** Seconds a native wrapper needs to run every PreToolUse hook in turn. */
function preToolBudgetSec(hooks) {
  const ms = hooks
    .filter((h) => h.event === "PreToolUse")
    .reduce((n, h) => n + (h.timeoutMs || run.DEFAULT_TIMEOUT_MS) + 1000, 0);
  return 10 + Math.ceil(ms / 1000);
}

module.exports = {
  EVENTS,
  NATIVE_PRE_TOOL,
  PROJECT_FILE,
  validateHooksConfig,
  isInside,
  scriptRefs,
  loadHooks,
  effectiveHooks,
  approveProjectHooks,
  lastResults,
  listHooks,
  threadHooksFile,
  prepareRunHooks,
  runThreadEvent,
  samplePayload,
  testHook,
  claudeSettingsHooks,
  preToolBudgetSec,
};
