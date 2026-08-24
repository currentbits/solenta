"use strict";

/**
 * Pin Cursor Task / Agent subagents to the parent model (#686).
 *
 * cursor-agent has no --task-model inherit flag. Sol (and any parent) can
 * still pass Task.model = composer-2.5 / sonnet. A tiny Cursor plugin,
 * materialized onto a real filesystem path (asar cannot hold electron/
 * subdirs), rewrites those calls so the field is omitted and Cursor's
 * default inherit applies. Built-in explore/bash/browser/shell keep their
 * own model.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN_NAME = "solenta-pin-task-parent";
const USER_DATA_DIR = "cursor-pin-parent";
const TMP_DIR_NAME = "solenta-cursor-pin-parent";
const BUILTIN_SUBAGENTS = ["explore", "bash", "browser", "shell"];

/**
 * Dest dir for the plugin: userDataPath/cursor-pin-parent, else tmpdir.
 * @param {string} [userDataPath]
 * @returns {string}
 */
function cursorPinPluginDir(userDataPath) {
  const base = userDataPath == null ? "" : String(userDataPath).trim();
  if (base) return path.resolve(path.join(base, USER_DATA_DIR));
  return path.resolve(path.join(os.tmpdir(), TMP_DIR_NAME));
}

/**
 * True when `a` and `b` name the same Cursor model, loosely.
 * gpt-5.6-sol-high-fast matches gpt-5.6-sol; composer-2.5 does not match
 * composer-2 (next char must be '-' or end).
 * @param {unknown} a
 * @param {unknown} b
 */
function modelsMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length > right.length) {
    return left.startsWith(right) && left[right.length] === "-";
  }
  if (right.length > left.length) {
    return right.startsWith(left) && right[left.length] === "-";
  }
  return false;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function coerceSubagentType(value) {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) return keys[0].trim().toLowerCase();
  }
  return "";
}

/**
 * @param {object} payload
 * @returns {string}
 */
function subagentTypeOf(payload) {
  const input =
    payload.tool_input && typeof payload.tool_input === "object"
      ? payload.tool_input
      : {};
  const candidates = [
    payload.subagent_type,
    payload.subagentType,
    input.subagent_type,
    input.subagentType,
  ];
  for (const c of candidates) {
    const t = coerceSubagentType(c);
    if (t) return t;
  }
  return "";
}

/**
 * Decide the preToolUse response for a Cursor hook payload.
 * Self-contained so hookScriptSource can embed it via Function#toString.
 * @param {unknown} payload
 * @returns {{ permission: "allow", updated_input?: Record<string, unknown> }}
 */
function decidePinTaskParent(payload) {
  const allow = { permission: "allow" };
  try {
    if (!payload || typeof payload !== "object") return allow;
    const p = /** @type {Record<string, unknown>} */ (payload);
    const toolName = String(p.tool_name || "");
    if (toolName !== "Task" && toolName !== "Agent") return allow;

    const kind = subagentTypeOf(p);
    if (BUILTIN_SUBAGENTS.includes(kind)) return allow;

    const input = p.tool_input;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return allow;
    }
    const rec = /** @type {Record<string, unknown>} */ (input);
    if (typeof rec.model !== "string") return allow;
    const model = rec.model.trim();
    if (!model) return allow;
    if (model.toLowerCase() === "inherit") return allow;
    if (modelsMatch(model, p.model) || modelsMatch(model, p.model_id)) {
      return allow;
    }
    const updated = { ...rec };
    delete updated.model;
    return { permission: "allow", updated_input: updated };
  } catch {
    return allow;
  }
}

/**
 * Parse one hook payload. Cursor may send a single JSON object and leave
 * stdin open (#691); accept a complete object or the first JSON line.
 * @param {string} raw
 * @returns {unknown | null}
 */
function parseHookPayload(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const line = s.split(/\r?\n/).find((l) => l.trim());
    if (!line || line === s) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
}

/**
 * Stdin/stdout wrapper Cursor actually execs.
 * Reply as soon as one JSON object is parseable. Do not wait for EOF:
 * live cursor-agent may keep the hook pipe open, and waiting for `end`
 * stalls the next Task/Agent for the platform hook timeout (#691).
 * @returns {void}
 */
function runPinTaskParentHook() {
  function failOpen() {
    process.stdout.write(JSON.stringify({ permission: "allow" }) + "\n");
    process.exit(0);
  }

  let raw = "";
  let done = false;
  const timer = setTimeout(() => {
    if (!done) failOpen();
  }, 2000);
  if (typeof timer.unref === "function") timer.unref();

  function finish(payload) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      const out = decidePinTaskParent(payload);
      process.stdout.write(JSON.stringify(out) + "\n");
      process.exit(0);
    } catch {
      failOpen();
    }
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
    const payload = parseHookPayload(raw);
    if (payload != null) finish(payload);
  });
  process.stdin.on("error", failOpen);
  process.stdin.on("end", () => {
    if (done) return;
    const payload = parseHookPayload(raw);
    if (payload != null) finish(payload);
    else failOpen();
  });
}

/**
 * Standalone hook script Cursor runs (node, shebang).
 * @returns {string}
 */
function hookScriptSource() {
  return [
    "#!/usr/bin/env node",
    '"use strict";',
    "const BUILTIN_SUBAGENTS = " + JSON.stringify(BUILTIN_SUBAGENTS) + ";",
    modelsMatch.toString(),
    coerceSubagentType.toString(),
    subagentTypeOf.toString(),
    decidePinTaskParent.toString(),
    parseHookPayload.toString(),
    runPinTaskParentHook.toString(),
    "runPinTaskParentHook();",
    "",
  ].join("\n");
}

/**
 * Write a Cursor plugin Cursor can load via --plugin-dir.
 * Overwrites on every call so a Solenta rebuild picks up hook changes.
 *
 * @param {string} destDir plugin root (contains .cursor-plugin/)
 * @returns {string} absolute destDir
 */
function materializeCursorPinPlugin(destDir) {
  const dest = path.resolve(String(destDir || ""));
  if (!dest) throw new Error("materializeCursorPinPlugin: destDir required");

  const scriptRel = path.join("scripts", "pin-task-parent.js");
  const scriptPath = path.join(dest, scriptRel);
  fs.mkdirSync(path.join(dest, ".cursor-plugin"), { recursive: true });
  fs.mkdirSync(path.join(dest, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(dest, "scripts"), { recursive: true });

  fs.writeFileSync(
    path.join(dest, ".cursor-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: PLUGIN_NAME,
        version: "1.0.0",
        description:
          "Pin Cursor Task and Agent subagents to the parent model",
        hooks: "./hooks/hooks.json",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  // Absolute `node "<script>"` so Cursor's plugin cwd (often the project
  // root, not this directory) still finds the hook. Spaces in userDataPath
  // are quoted via JSON.stringify.
  const command = "node " + JSON.stringify(scriptPath);
  fs.writeFileSync(
    path.join(dest, "hooks", "hooks.json"),
    JSON.stringify(
      {
        version: 1,
        hooks: {
          preToolUse: [
            {
              command,
              matcher: "Task|Agent",
              timeout: 5,
            },
          ],
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  fs.writeFileSync(scriptPath, hookScriptSource(), { encoding: "utf8", mode: 0o755 });
  try {
    fs.chmodSync(scriptPath, 0o755);
  } catch {
    // win32
  }
  return dest;
}

module.exports = {
  PLUGIN_NAME,
  USER_DATA_DIR,
  TMP_DIR_NAME,
  BUILTIN_SUBAGENTS,
  cursorPinPluginDir,
  decidePinTaskParent,
  parseHookPayload,
  hookScriptSource,
  materializeCursorPinPlugin,
  modelsMatch,
};
