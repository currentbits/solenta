"use strict";

// cross-spawn, not child_process: on Windows the agent CLIs install as
// .cmd shims and Node refuses to exec those directly. cross-spawn routes
// them through cmd.exe with correct escaping, which matters because the
// prompt travels in argv (#442).
const spawn = require("cross-spawn");
const { killTree, agentSpawnOptions } = require("./proc.js");
const { harvestToolResult } = require("./tool-images.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { posixQuote } = require("./ssh.js");
const { guardrailsEnabled } = require("./guardrails.js");
const {
  injectKimiGuardrailHook,
  kimiGuardrailHookCommand,
} = require("./kimi-guardrail-hook.js");
const {
  remoteOverlayDest,
  probeRemoteHome,
  writeRemoteOverlay,
} = require("./remote-overlay.js");

const SIGKILL_AFTER_MS = 3000;
// Max stderr retained per child process (tail), for error reporting.
const STDERR_TAIL_CHARS = 64 * 1024;
const INPUT_TRUNCATE = 2000;
const OUTPUT_TRUNCATE = 4000;

/**
 * @param {string} s
 * @param {number} max
 */
function truncate(s, max) {
  const str = String(s ?? "");
  return str.length <= max ? str : str.slice(0, max);
}

/**
 * Kimi home dir. KIMI_CODE_HOME is kimi's own override (tests, and Solenta's
 * per-run overlay so one project cannot inherit another's MCP/workspaces).
 * @param {NodeJS.ProcessEnv} [env]
 */
function kimiConfigPath(env = process.env) {
  const home = env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
  return path.join(home, "config.toml");
}

/**
 * Auth/session files that a per-run home must share with the user's real
 * kimi home so `-S` resume and login still work. mcp.json, workspaces.json,
 * AGENTS.md and workspace-trust stay OUT — those are the contamination.
 * @type {string[]}
 */
const KIMI_HOME_LINKS = [
  "credentials",
  "oauth",
  "sessions",
  "cache",
  "plugins",
  "updates",
  "device_id",
  "session_index.jsonl",
];

/**
 * Stable-enough workspace id for an isolated workspaces.json. Kimi's own
 * ids look like `wd_<name>_<12 hex>`; we only need uniqueness per cwd.
 * @param {string} root
 */
function workspaceId(root) {
  const base =
    path
      .basename(root)
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 24) || "ws";
  let h = 0;
  const s = String(root);
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return `wd_${base}_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function linkOrSkip(src, dst) {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return;
  try {
    fs.symlinkSync(src, dst);
  } catch {
    // Windows without symlink privilege: isolation still holds; resume/auth
    // just will not share with the user's real home.
  }
}

/**
 * Per-run KIMI_CODE_HOME overlay (issue #671).
 *
 * Kimi has no `--mcp-config`. User-global `~/.kimi-code/mcp.json` and
 * `workspaces.json` mix every MCP server and every directory the CLI has
 * ever opened, so a Solenta kimi turn in project A can call another
 * project's tools and read its tree. Overlay: copy config.toml (effort
 * flip stays local), symlink credentials/sessions, write a fresh mcp.json
 * and a workspaces.json that contains ONLY this cwd. Never copy AGENTS.md.
 *
 * @param {object} opts
 * @param {string} opts.dest
 * @param {string} opts.sourceHome
 * @param {string} [opts.cwd]
 * @param {Record<string, unknown>} [opts.mcpServers]
 * @returns {string} dest
 */
function materializeKimiHome(opts) {
  const dest = String(opts.dest || "");
  const sourceHome = String(opts.sourceHome || "");
  if (!dest) throw new Error("materializeKimiHome: dest required");
  fs.mkdirSync(dest, { recursive: true });

  if (sourceHome && fs.existsSync(sourceHome)) {
    for (const name of KIMI_HOME_LINKS) {
      linkOrSkip(path.join(sourceHome, name), path.join(dest, name));
    }
    const cfgSrc = path.join(sourceHome, "config.toml");
    if (fs.existsSync(cfgSrc)) {
      fs.copyFileSync(cfgSrc, path.join(dest, "config.toml"));
    }
  }

  const mcpPath = path.join(dest, "mcp.json");
  fs.writeFileSync(
    mcpPath,
    JSON.stringify({ mcpServers: opts.mcpServers || {} }, null, 2) + "\n",
    { mode: 0o600, encoding: "utf8" },
  );
  try {
    fs.chmodSync(mcpPath, 0o600);
  } catch {
    // ignore
  }

  /** @type {Record<string, { root: string, name: string, created_at: string, last_opened_at: string }>} */
  const workspaces = {};
  const cwd = opts.cwd ? String(opts.cwd) : "";
  if (cwd) {
    const now = new Date().toISOString();
    workspaces[workspaceId(cwd)] = {
      root: cwd,
      name: path.basename(cwd),
      created_at: now,
      last_opened_at: now,
    };
  }
  fs.writeFileSync(
    path.join(dest, "workspaces.json"),
    JSON.stringify(
      { version: 1, workspaces, deleted_workspace_ids: [] },
      null,
      2,
    ) + "\n",
  );

  const leftoverAgents = path.join(dest, "AGENTS.md");
  try {
    if (fs.existsSync(leftoverAgents)) fs.unlinkSync(leftoverAgents);
  } catch {
    // ignore
  }
  return dest;
}

/**
 * Deploy the PreToolUse overlay onto an ssh/WSL host (#834 / #836).
 * Returns the remote KIMI_CODE_HOME path, or null when skipped.
 *
 * Official kimi docs: [[hooks]] event = "PreToolUse" in config.toml,
 * relocated by KIMI_CODE_HOME. Hook command uses remote `node`.
 *
 * @param {object} opts
 * @param {{ remoteHost?: string, path?: string } | null} opts.project
 * @param {string} opts.threadId
 * @returns {string | null}
 */
function deployKimiGuardrailOverlay(opts) {
  const project = opts && opts.project;
  const threadId = opts && opts.threadId;
  if (!project || !threadId) return null;
  if (!guardrailsEnabled()) return null;
  const dest = remoteOverlayDest(
    probeRemoteHome(project),
    threadId,
    "kimi-homes",
  );
  if (!dest) throw new Error("remote KIMI_CODE_HOME dest unusable");
  const hookDest = `${dest}/kimi-guardrail-hook.js`;
  const command = kimiGuardrailHookCommand({
    nodePath: "node",
    hookPath: hookDest,
  });
  const toml = injectKimiGuardrailHook("", command, 15);
  writeRemoteOverlay(
    project,
    dest,
    {
      "kimi-guardrail-hook.js": fs.readFileSync(
        path.join(__dirname, "kimi-guardrail-hook.js"),
        "utf8",
      ),
      "guardrails.js": fs.readFileSync(
        path.join(__dirname, "guardrails.js"),
        "utf8",
      ),
      "guardrail-hook-core.js": fs.readFileSync(
        path.join(__dirname, "guardrail-hook-core.js"),
        "utf8",
      ),
      "config.toml": toml,
    },
    [
      `for f in credentials oauth sessions cache plugins updates device_id session_index.jsonl; do src="$HOME/.kimi-code/$f"; dst=${posixQuote(dest)}/"$f"; if [ -e "$src" ] && [ ! -e "$dst" ]; then ln -s "$src" "$dst"; fi; done`,
    ],
  );
  return dest;
}

/**
 * True when the overlay must stay on disk: a kimi child may still be
 * reading it. Matches worktree GC's live-thread skip.
 * @param {object | null | undefined} store
 * @param {string} threadId
 */
function isLiveKimiThread(store, threadId) {
  if (!store || typeof store.getThread !== "function") return false;
  const thread = store.getThread(threadId);
  if (!thread) return false;
  return thread.status === "working" || thread.status === "quota-wait";
}

/**
 * Remove `target` without following symlinks. Unlink a symlink (even one
 * pointing at a directory) instead of descending into the target — the
 * overlay's credentials/sessions/cache links go into ~/.kimi-code.
 * @param {string} target
 */
function rmWithoutFollowing(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  for (const ent of entries) {
    const child = path.join(target, ent.name);
    // isSymbolicLink first: a junction/link-to-dir can also report as a
    // directory on Windows, and following it would wipe ~/.kimi-code.
    if (ent.isSymbolicLink() || !ent.isDirectory()) {
      try {
        fs.unlinkSync(child);
      } catch {
        // best-effort
      }
    } else {
      rmWithoutFollowing(child);
    }
  }
  fs.rmdirSync(target);
}

/**
 * Reclaim stale KIMI_CODE_HOME overlays (#675).
 *
 * One dir per thread that has ever run kimi, under
 * `<userDataPath>/kimi-homes/<threadId>/`. They are tiny (symlinks plus
 * three files) but nothing else deletes them. Called from scheduleRetention
 * so boot / archive / merge / the 6h sweeper pick them up — not a new
 * timer. Skips a thread that is currently working or in quota-wait.
 *
 * @param {object} opts
 * @param {string} [opts.userDataPath]
 * @param {{ getThread?: (id: string) => { status?: string } | null }} [opts.store]
 * @returns {{ removed: string[], skipped: string[] }}
 */
function reclaimKimiHomes(opts) {
  const userDataPath = String((opts && opts.userDataPath) || "");
  if (!userDataPath) return { removed: [], skipped: [] };
  const store = opts && opts.store;
  // Without a store we cannot tell a live kimi turn from a stale overlay.
  // Refuse rather than risk deleting an in-use home.
  if (!store || typeof store.getThread !== "function") {
    return { removed: [], skipped: [] };
  }
  const base = path.join(userDataPath, "kimi-homes");
  let baseStat;
  try {
    baseStat = fs.lstatSync(base);
  } catch (err) {
    if (err && err.code === "ENOENT") return { removed: [], skipped: [] };
    throw err;
  }
  // A symlinked kimi-homes/ would make readdir walk the target. Refuse.
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    return { removed: [], skipped: [] };
  }

  const removed = [];
  const skipped = [];
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return { removed, skipped };
  }
  for (const name of names) {
    // path.basename guard: readdir cannot return ".." on POSIX, but a
    // crafted name with a separator must never walk outside kimi-homes.
    if (!name || name !== path.basename(name)) continue;
    const dest = path.join(base, name);
    if (isLiveKimiThread(store, name)) {
      skipped.push(dest);
      continue;
    }
    try {
      rmWithoutFollowing(dest);
      removed.push(dest);
    } catch {
      // housekeeping; a busy overlay is retried on the next pass
    }
  }
  return { removed, skipped };
}

/**
 * Set [thinking].effort in kimi's config.toml and return a restore function.
 *
 * kimi 0.31.1 has no per-invocation effort mechanism: no CLI flag (probed
 * --effort/--thinking-effort/--reasoning-effort/--thinking, all rejected) and
 * no env var. The value lives only in config.toml and is read once at process
 * start, so the flip only needs to hold until the child produces output.
 *
 * Restore is idempotent and crash-safe: the original file is kept in a
 * .coder-effort-backup sidecar, and a leftover sidecar (previous crash) is
 * restored before reading, so the user's real config is never lost.
 *
 * If the [thinking] effort line is missing, or the config cannot be read, the
 * turn runs on the user's default rather than Solenta inventing a section in a
 * file it does not own.
 *
 * ponytail: concurrent kimi turns that share one config.toml race the flip
 * window. Solenta-spawned turns use a per-run KIMI_CODE_HOME (#671) so the
 * flip is local to that overlay; this path is the no-isolation fallback.
 *
 * @param {string | null | undefined} effort
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {() => void} restore
 */
function flipKimiEffort(effort, env = process.env) {
  const noop = () => {};
  const configPath = kimiConfigPath(env);
  const backupPath = `${configPath}.coder-effort-backup`;
  try {
    // Crash recovery runs on EVERY kimi turn, including effortless ones: a
    // leftover backup means a previous flip never restored, and the backup is
    // the user's real config. Behind the !effort return it was dead code for
    // the default case, leaving the user on the wrong effort indefinitely.
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, configPath);
      fs.unlinkSync(backupPath);
    }
  } catch {
    return noop;
  }
  if (!effort) return noop;
  try {
    const original = fs.readFileSync(configPath, "utf8");
    const flipped = original.replace(
      // The effort line inside the [thinking] section only: ^ anchors the
      // header so "[thinking]" inside a quoted value cannot match, and [^[]*?
      // stops the match from crossing into the next TOML section.
      /(^\[thinking\][^[]*?^[ \t]*effort[ \t]*=[ \t]*")[^"]*(")/m,
      `$1${effort}$2`,
    );
    if (flipped === original) return noop;
    fs.writeFileSync(backupPath, original);
    fs.writeFileSync(configPath, flipped);
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      try {
        fs.writeFileSync(configPath, original);
        fs.unlinkSync(backupPath);
      } catch {
        // Backup stays; the next flip's crash recovery reinstates it.
      }
    };
  } catch {
    return noop; // no config at all: kimi runs on its own defaults
  }
}

/**
 * Extract assistant text from defensive kimi stream-json shapes.
 * First match wins: type text|message|assistant with text|content|delta,
 * or nested message.content (string or text-block array).
 * @param {object} obj
 * @returns {string | null}
 */
function extractAssistantText(obj) {
  if (!obj || typeof obj !== "object") return null;
  // Real kimi stream-json (0.31.1, recorded live): role-shaped lines.
  //   {"role":"assistant","content":"..."}          -> assistant text
  //   {"role":"assistant","tool_calls":[...]}        -> extractToolEvents
  //   {"role":"tool","content":"..."}                -> tool RESULT, not text
  //   {"role":"meta","type":"session.resume_hint"}   -> has a content string
  //                                                     that must NOT render
  // Any role-shaped line that is not assistant text returns null here rather
  // than falling through to the legacy matcher, which would happily surface
  // the meta hint's content as an assistant message.
  if (obj.role != null) {
    if (obj.role !== "assistant") return null;
    if (typeof obj.content === "string") return obj.content;
    // Only strings were recorded live, but a block array here would silently
    // reproduce this round's exact symptom (gotJson true blocks the
    // plain-text fallback), so join text-ish parts as cheap insurance.
    if (Array.isArray(obj.content)) {
      const parts = obj.content
        .map((b) =>
          typeof b === "string"
            ? b
            : b &&
                typeof b === "object" &&
                typeof b.text === "string" &&
                b.type !== "thinking" &&
                b.type !== "redacted_thinking"
              ? b.text
              : "",
        )
        .filter(Boolean);
      if (parts.length > 0) return parts.join("");
    }
    return null;
  }
  const type = String(obj.type || "");
  if (type !== "text" && type !== "message" && type !== "assistant") {
    return null;
  }

  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.delta === "string") return obj.delta;

  if (obj.message && typeof obj.message === "object") {
    const c = obj.message.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const parts = [];
      for (const block of c) {
        if (!block || typeof block !== "object") continue;
        if (
          block.type === "text" &&
          typeof block.text === "string" &&
          block.type !== "thinking"
        ) {
          parts.push(block.text);
        }
      }
      if (parts.length > 0) return parts.join("");
    }
  }

  return null;
}

/**
 * Reasoning text from a kimi stream-json line (issue #751 / #752).
 * Official 0.31.1 stream-json omits thinking from JSONL; this still accepts
 * API-shaped reasoning_content / thinking blocks so a live Thinking card
 * can appear when the CLI (or a future version) emits them. Also accepts
 * type/role thinking lines and deltas used by older or defensive shapes.
 * @param {object} obj
 * @returns {string | null}
 */
function extractThinking(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (
    typeof obj.reasoning_content === "string" &&
    obj.reasoning_content.trim()
  ) {
    return obj.reasoning_content;
  }
  if (typeof obj.reasoning === "string" && obj.reasoning.trim()) {
    return obj.reasoning;
  }
  if (obj.type === "thinking" || obj.role === "thinking") {
    if (typeof obj.text === "string" && obj.text) return obj.text;
    if (typeof obj.thinking === "string" && obj.thinking) return obj.thinking;
    if (typeof obj.delta === "string" && obj.delta) return obj.delta;
    if (typeof obj.content === "string" && obj.content) return obj.content;
  }
  if (
    obj.role !== "tool" &&
    typeof obj.thinking === "string" &&
    obj.thinking.trim()
  ) {
    return obj.thinking;
  }
  const blocks = Array.isArray(obj.content)
    ? obj.content
    : obj.message && Array.isArray(obj.message.content)
      ? obj.message.content
      : null;
  if (blocks) {
    const parts = [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      const t = String(b.type || "");
      if (t !== "thinking" && t !== "reasoning" && t !== "redacted_thinking") {
        continue;
      }
      if (typeof b.thinking === "string" && b.thinking) parts.push(b.thinking);
      else if (typeof b.text === "string" && b.text) parts.push(b.text);
      else if (typeof b.reasoning === "string" && b.reasoning) {
        parts.push(b.reasoning);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  if (obj.type === "thinking" || obj.type === "reasoning") {
    if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
    if (typeof obj.content === "string" && obj.content.trim()) return obj.content;
  }
  return null;
}

/**
 * Incremental parser for kimi print-mode stderr thinking.
 *
 * Recorded contract (PromptTranscriptWriter + docs): thinking is a `• `
 * block on stderr. Official 0.39.1 PromptBlockWriter wrap-indents by one
 * space (0.31.1 used two). Tool progress, resume notices, errors, and
 * "See log:" are raw lines with no bullet and must not become thinking
 * (issue #753).
 *
 * Live 0.39.1 `--output-format stream-json` still drops thinking
 * (`PromptJsonWriter.writeThinkingDelta` is a no-op); this only fires
 * when the CLI actually writes the recorded print-mode shape.
 * @returns {{ push: (line: string) => string | null }}
 */
function createStderrThinkingParser() {
  let inBlock = false;
  return {
    /**
     * @param {string} line
     * @returns {string | null}
     */
    push(line) {
      const raw = String(line ?? "").replace(/\r$/, "");
      if (raw.startsWith("• ")) {
        inBlock = true;
        const text = raw.slice(2);
        return text.trim() ? text : null;
      }
      if (inBlock && /^ {1,2}\S/.test(raw)) {
        // Leading newline so startKimiRun's += does not smash wraps.
        return `\n${raw.replace(/^ {1,2}/, "")}`;
      }
      inBlock = false;
      return null;
    },
  };
}

/**
 * @typedef {{ id: string, name: string, input: string, output: string | null, phase: "start" | "end" | "single", isError: boolean, images?: { mediaType: string, data: string }[] }} ToolEvent
 */

/**
 * Transcript text plus any screenshot blobs, harvested before truncate so
 * base64 never occupies the 4000-char output window.
 * @param {unknown} value
 * @returns {{ output: string, images: { mediaType: string, data: string }[] }}
 */
function outputAndImages(value) {
  const harvested = harvestToolResult(value);
  const redacted = harvested.redacted;
  let text = "";
  if (typeof redacted === "string") {
    text = redacted;
  } else {
    try {
      text = JSON.stringify(redacted ?? "");
    } catch {
      text = String(redacted);
    }
  }
  return { output: truncate(text, OUTPUT_TRUNCATE), images: harvested.images };
}

/**
 * All tool events carried by one stream line.
 *
 * Real kimi packs CALLS as an array on an assistant line and results as
 * separate role:"tool" lines, so one line can carry several starts:
 *   {"role":"assistant","tool_calls":[{id,function:{name,arguments}}]}
 *   {"role":"tool","tool_call_id":"...","content":"..."}
 * Legacy type-based shapes still parse (one event) for older streams.
 * @param {object} obj
 * @returns {ToolEvent[]}
 */
function extractToolEvents(obj) {
  if (!obj || typeof obj !== "object") return [];
  if (obj.role === "assistant" && Array.isArray(obj.tool_calls)) {
    /** @type {ToolEvent[]} */
    const out = [];
    for (const tc of obj.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      const fn = tc.function && typeof tc.function === "object" ? tc.function : null;
      const name =
        (fn && typeof fn.name === "string" && fn.name) ||
        (typeof tc.name === "string" && tc.name) ||
        "";
      if (!name) continue;
      const rawArgs = fn && fn.arguments != null ? fn.arguments : tc.arguments;
      let input = "";
      if (rawArgs != null) {
        try {
          input =
            typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
        } catch {
          input = String(rawArgs);
        }
      }
      out.push({
        id: String(tc.id || ""),
        name,
        input: truncate(input, INPUT_TRUNCATE),
        output: null,
        phase: "start",
        isError: false,
      });
    }
    return out;
  }
  if (obj.role === "tool") {
    const harvested = outputAndImages(obj.content);
    return [
      {
        id: String(obj.tool_call_id || obj.id || ""),
        // Results carry no name; the runner pairs by id to the start message.
        name: "tool",
        input: "",
        output: harvested.output,
        phase: "end",
        isError: Boolean(obj.is_error || obj.error),
        ...(harvested.images.length ? { images: harvested.images } : {}),
      },
    ];
  }
  if (obj.role != null) return []; // other role-shaped lines carry no tools
  const legacy = extractToolEvent(obj);
  return legacy ? [legacy] : [];
}

/**
 * Legacy type-based tool events: type containing "tool" with a name field.
 * Best-effort start/end pairing by id when present.
 * @param {object} obj
 * @returns {ToolEvent | null}
 */
function extractToolEvent(obj) {
  if (!obj || typeof obj !== "object") return null;
  const type = String(obj.type || "");
  if (!/tool/i.test(type)) return null;

  const name =
    typeof obj.name === "string" && obj.name
      ? obj.name
      : obj.tool && typeof obj.tool === "object" && typeof obj.tool.name === "string"
        ? obj.tool.name
        : null;
  if (!name) return null;

  const id = String(
    obj.id ||
      obj.tool_call_id ||
      obj.tool_use_id ||
      (obj.tool && obj.tool.id) ||
      "",
  );

  let inputRaw =
    obj.input != null
      ? obj.input
      : obj.arguments != null
        ? obj.arguments
        : obj.args != null
          ? obj.args
          : obj.tool && obj.tool.input != null
            ? obj.tool.input
            : null;
  let inputStr = "";
  if (inputRaw != null) {
    try {
      inputStr =
        typeof inputRaw === "string"
          ? inputRaw
          : JSON.stringify(inputRaw, null, 2);
    } catch {
      inputStr = String(inputRaw);
    }
  }
  inputStr = truncate(inputStr, INPUT_TRUNCATE);

  const hasOutput =
    obj.output != null ||
    obj.result != null ||
    obj.content != null ||
    (obj.tool && obj.tool.output != null);
  let output = null;
  /** @type {{ mediaType: string, data: string }[]} */
  let images = [];
  if (hasOutput) {
    const o =
      obj.output != null
        ? obj.output
        : obj.result != null
          ? obj.result
          : obj.content != null
            ? obj.content
            : obj.tool.output;
    const harvested = outputAndImages(o);
    output = harvested.output;
    images = harvested.images;
  }

  const isError = Boolean(obj.is_error || obj.isError || obj.error);
  const typeLower = type.toLowerCase();
  const looksResult =
    /result|output|end|complete|response/i.test(typeLower) || hasOutput;
  const looksStart =
    /call|use|start|begin|request/i.test(typeLower) && !looksResult;

  let phase = "single";
  if (looksStart && !hasOutput) phase = "start";
  else if (looksResult && id) phase = "end";
  else if (!hasOutput && id) phase = "start";
  else phase = hasOutput && !looksStart ? "end" : "single";

  return {
    id: id || `tool-${name}`,
    name,
    input: inputStr,
    output,
    phase,
    isError,
    ...(images.length ? { images } : {}),
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function tokenNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Usage from a stream line or a wire.jsonl record.
 *
 * Live `-p --output-format stream-json` (kimi 0.39) still emits no usage
 * (assistant / tool / session.resume_hint only). The on-disk session wire
 * does: `type: "usage.record"` with Moonshot TokenUsage
 * `{ inputOther, output, inputCacheRead, inputCacheCreation }` and no USD
 * (issue #696). Legacy `input_tokens` / `prompt_tokens` stay parseable so
 * fixtures and older CLIs keep working. Billable in/out alone is not a
 * full prompt (#317) — contextTokens is set only when the four-bucket
 * Moonshot shape is present.
 *
 * @param {object} obj
 * @returns {{ inputTokens: number, outputTokens: number, costUsd?: number, cachedInputTokens?: number, cacheWriteTokens?: number, contextTokens?: number } | null}
 */
function extractUsage(obj) {
  if (!obj || typeof obj !== "object") return null;

  /** @type {Record<string, unknown> | null} */
  let usage = null;
  if (obj.usage && typeof obj.usage === "object") {
    usage = /** @type {Record<string, unknown>} */ (obj.usage);
  } else if (
    obj.input_tokens != null ||
    obj.output_tokens != null ||
    obj.prompt_tokens != null ||
    obj.completion_tokens != null
  ) {
    usage = /** @type {Record<string, unknown>} */ (obj);
  }

  if (!usage) return null;

  const moonshot =
    obj.type === "usage.record" ||
    usage.inputOther != null ||
    usage.inputCacheRead != null ||
    usage.inputCacheCreation != null;

  const hasField =
    moonshot ||
    usage.input_tokens != null ||
    usage.output_tokens != null ||
    usage.prompt_tokens != null ||
    usage.completion_tokens != null ||
    usage.inputTokens != null ||
    usage.outputTokens != null;

  if (!hasField) return null;

  const inputTokens = tokenNum(
    usage.inputOther ??
      usage.input_tokens ??
      usage.inputTokens ??
      usage.prompt_tokens,
  );
  const outputTokens = tokenNum(
    moonshot
      ? usage.output
      : (usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens),
  );
  const cachedRaw =
    usage.inputCacheRead ??
    usage.cache_read_input_tokens ??
    usage.cachedInputTokens;
  const writeRaw =
    usage.inputCacheCreation ??
    usage.cache_creation_input_tokens ??
    usage.cacheWriteTokens;

  const costRaw =
    usage.total_cost_usd ??
    usage.cost_usd ??
    usage.costUsd ??
    obj.total_cost_usd ??
    obj.cost_usd;

  /** @type {{ inputTokens: number, outputTokens: number, costUsd?: number, cachedInputTokens?: number, cacheWriteTokens?: number, contextTokens?: number }} */
  const out = { inputTokens, outputTokens };
  if (costRaw != null) out.costUsd = tokenNum(costRaw);
  if (moonshot || cachedRaw != null) out.cachedInputTokens = tokenNum(cachedRaw);
  if (moonshot || writeRaw != null) out.cacheWriteTokens = tokenNum(writeRaw);
  if (moonshot) {
    const ctx =
      inputTokens + outputTokens + tokenNum(cachedRaw) + tokenNum(writeRaw);
    if (ctx > 0) out.contextTokens = ctx;
  }
  return out;
}

/**
 * Session wire.jsonl paths for one kimi session id.
 * Layout: `<home>/sessions/<wd>/<sessionId>/agents/<agent>/wire.jsonl`.
 * @param {string} home
 * @param {string} sessionId
 * @returns {{ agent: string, path: string }[]}
 */
function findKimiSessionWires(home, sessionId) {
  const id = String(sessionId || "");
  const sessionsDir = path.join(String(home || ""), "sessions");
  if (!id || !home) return [];
  let wds;
  try {
    wds = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {{ agent: string, path: string }[]} */
  const out = [];
  for (const wd of wds) {
    if (!wd.isDirectory() && !wd.isSymbolicLink()) continue;
    const agentsDir = path.join(sessionsDir, wd.name, id, "agents");
    let agents;
    try {
      agents = fs.readdirSync(agentsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const agent of agents) {
      if (!agent.isDirectory() && !agent.isSymbolicLink()) continue;
      const wire = path.join(agentsDir, agent.name, "wire.jsonl");
      try {
        if (fs.statSync(wire).isFile()) {
          out.push({ agent: agent.name, path: wire });
        }
      } catch {
        // skip
      }
    }
  }
  return out;
}

/**
 * Sum `usage.record` lines from a session's wire.jsonl files.
 * Tokens from every agent; contextTokens from the last main-agent record
 * so the ring tracks the user conversation, not a subagent.
 *
 * @param {string} home KIMI_CODE_HOME (overlay dest is fine; sessions is linked)
 * @param {string} sessionId e.g. "session_abc"
 * @param {{ sinceMs?: number }} [opts] drop records with time < sinceMs
 * @returns {{ inputTokens: number, outputTokens: number, cachedInputTokens: number, cacheWriteTokens: number, contextTokens?: number } | null}
 */
function harvestKimiSessionUsage(home, sessionId, opts = {}) {
  const sinceMs =
    opts && opts.sinceMs != null ? Number(opts.sinceMs) : NaN;
  const wires = findKimiSessionWires(home, sessionId);
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  /** @type {number | undefined} */
  let lastMainContext;
  let saw = false;
  for (const w of wires) {
    let text;
    try {
      text = fs.readFileSync(w.path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (
        Number.isFinite(sinceMs) &&
        ev &&
        typeof ev.time === "number" &&
        ev.time < sinceMs
      ) {
        continue;
      }
      const u = extractUsage(ev);
      if (!u) continue;
      saw = true;
      inputTokens += u.inputTokens || 0;
      outputTokens += u.outputTokens || 0;
      cachedInputTokens += u.cachedInputTokens || 0;
      cacheWriteTokens += u.cacheWriteTokens || 0;
      if (w.agent === "main" && u.contextTokens != null) {
        lastMainContext = u.contextTokens;
      }
    }
  }
  if (!saw) return null;
  /** @type {{ inputTokens: number, outputTokens: number, cachedInputTokens: number, cacheWriteTokens: number, contextTokens?: number }} */
  const out = {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
  };
  if (lastMainContext != null) out.contextTokens = lastMainContext;
  return out;
}

/**
 * Spawn the Kimi CLI with stream-json (or plain-text fallback) output.
 *
 * @param {object} opts
 * @param {string} [opts.binary]
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {NodeJS.ProcessEnv} [opts.env] - merged over process.env; used for
 *   KIMI_CODE_HOME overlays (#671)
 * @param {(ev: object) => void} opts.onEvent - raw parsed NDJSON object
 * @param {(info: { code: number | null, stderr: string, fullStdout: string, gotJson: boolean }) => void} opts.onExit
 * @param {(err: Error) => void} [opts.onError]
 * @returns {{ kill: () => void }}
 */
function runKimi(opts) {
  const {
    binary = process.env.CODER_KIMI_BIN || "kimi",
    args = [],
    cwd,
    reasoningEffort = null,
    env: envOverride,
    onEvent,
    onExit,
    onError,
  } = opts;
  const childEnv = envOverride
    ? { ...process.env, ...envOverride }
    : undefined;

  let stderrText = "";
  let fullStdout = "";
  let lineBuf = "";
  let stderrLineBuf = "";
  const stderrThink = createStderrThinkingParser();
  let finished = false;
  let killTimer = null;
  let killed = false;
  let gotJson = false;

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!obj || typeof obj !== "object") return;
    gotJson = true;
    emitEvent(obj);
  }

  /**
   * @param {object} obj
   */
  function emitEvent(obj) {
    if (typeof onEvent !== "function") return;
    try {
      onEvent(obj);
    } catch {
      // defensive: never crash the parser
    }
  }

  /**
   * @param {string} line
   */
  function emitStderrThinking(line) {
    const thinking = stderrThink.push(line);
    if (!thinking) return;
    // Same shape startKimiRun already upserts from JSON reasoning_content.
    emitEvent({ reasoning_content: thinking });
  }

  function finish(code) {
    if (finished) return;
    finished = true;
    restoreEffort();
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (lineBuf.trim()) {
      handleLine(lineBuf);
      lineBuf = "";
    }
    if (stderrLineBuf.trim()) {
      emitStderrThinking(stderrLineBuf);
      stderrLineBuf = "";
    }
    if (typeof onExit === "function") {
      onExit({
        code,
        stderr: stderrText,
        fullStdout,
        gotJson,
      });
    }
  }

  // Kimi reads config.toml once at startup; the flip holds until first
  // output (proof the child is past startup), with finish() as the backstop.
  const restoreEffort = flipKimiEffort(reasoningEffort, childEnv || process.env);

  let child;
  try {
    child = spawn(
      binary,
      args,
      agentSpawnOptions({
        cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (err) {
    restoreEffort();
    const error = err instanceof Error ? err : new Error(String(err));
    if (typeof onError === "function") onError(error);
    if (typeof onExit === "function") {
      onExit({
        code: 1,
        stderr: error.message,
        fullStdout: "",
        gotJson: false,
      });
    }
    return { kill() {} };
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    restoreEffort();
    const str = String(chunk);
    fullStdout += str;
    lineBuf += str;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      handleLine(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    restoreEffort();
    // Tail-keep: stderr feeds error reporting, and a noisy CLI would
    // otherwise grow this buffer for the life of a long-lived process.
    const str = String(chunk);
    stderrText = (stderrText + str).slice(-STDERR_TAIL_CHARS);
    stderrLineBuf += str;
    let nl;
    while ((nl = stderrLineBuf.indexOf("\n")) >= 0) {
      const line = stderrLineBuf.slice(0, nl);
      stderrLineBuf = stderrLineBuf.slice(nl + 1);
      emitStderrThinking(line);
    }
  });

  child.on("error", (err) => {
    if (typeof onError === "function") onError(err);
    finish(1);
  });

  child.on("close", (code) => {
    finish(code);
  });

  return {
    kill() {
      if (killed || finished) return;
      killed = true;
      killTimer = killTree(child, SIGKILL_AFTER_MS);
    },
  };
}

/**
 * Real session id from the meta resume hint, or null.
 * {"role":"meta","type":"session.resume_hint","session_id":"session_..."}
 * Kimi DOES have per-session resume (-S <id>, verified live). Do not
 * invent a per-cwd sentinel when this is null (issue #220).
 * @param {object} obj
 * @returns {string | null}
 */
function extractSessionId(obj) {
  if (!obj || typeof obj !== "object") return null;
  return obj.role === "meta" &&
    typeof obj.session_id === "string" &&
    obj.session_id
    ? obj.session_id
    : null;
}

module.exports = {
  runKimi,
  flipKimiEffort,
  kimiConfigPath,
  materializeKimiHome,
  deployKimiGuardrailOverlay,
  reclaimKimiHomes,
  workspaceId,
  extractAssistantText,
  extractThinking,
  createStderrThinkingParser,
  extractToolEvent,
  extractToolEvents,
  extractSessionId,
  extractUsage,
  harvestKimiSessionUsage,
  findKimiSessionWires,
  truncate,
  INPUT_TRUNCATE,
  OUTPUT_TRUNCATE,
  SIGKILL_AFTER_MS,
};
