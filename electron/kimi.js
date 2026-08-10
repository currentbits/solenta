"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SIGKILL_AFTER_MS = 3000;
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

/** Kimi home dir; KIMI_CODE_HOME is kimi's own override, which tests also use. */
function kimiConfigPath() {
  const home =
    process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
  return path.join(home, "config.toml");
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
 * turn runs on the user's default rather than Coder inventing a section in a
 * file it does not own.
 *
 * ponytail: concurrent kimi turns race the flip window (last writer wins for
 * a few ms); serialize flips or use a per-invocation flag when kimi ships one.
 *
 * @param {string | null | undefined} effort
 * @returns {() => void} restore
 */
function flipKimiEffort(effort) {
  const noop = () => {};
  const configPath = kimiConfigPath();
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
            : b && typeof b === "object" && typeof b.text === "string"
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
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
      if (parts.length > 0) return parts.join("");
    }
  }

  return null;
}

/**
 * @typedef {{ id: string, name: string, input: string, output: string | null, phase: "start" | "end" | "single", isError: boolean }} ToolEvent
 */

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
    const content = obj.content;
    return [
      {
        id: String(obj.tool_call_id || obj.id || ""),
        // Results carry no name; the runner pairs by id to the start message.
        name: "tool",
        input: "",
        output: truncate(
          typeof content === "string" ? content : JSON.stringify(content ?? ""),
          OUTPUT_TRUNCATE,
        ),
        phase: "end",
        isError: Boolean(obj.is_error || obj.error),
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
  if (hasOutput) {
    const o =
      obj.output != null
        ? obj.output
        : obj.result != null
          ? obj.result
          : obj.content != null
            ? obj.content
            : obj.tool.output;
    output = truncate(
      typeof o === "string" ? o : (() => {
        try {
          return JSON.stringify(o);
        } catch {
          return String(o);
        }
      })(),
      OUTPUT_TRUNCATE,
    );
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
  };
}

/**
 * Usage-ish fields: input_tokens/output_tokens or prompt_tokens/completion_tokens
 * at top level or under usage. Cost when the provider reports it.
 * @param {object} obj
 * @returns {{ inputTokens: number, outputTokens: number, costUsd: number } | null}
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

  const hasField =
    usage.input_tokens != null ||
    usage.output_tokens != null ||
    usage.prompt_tokens != null ||
    usage.completion_tokens != null ||
    usage.inputTokens != null ||
    usage.outputTokens != null;

  if (!hasField) return null;

  const inputTokens =
    Number(
      usage.input_tokens ??
        usage.inputTokens ??
        usage.prompt_tokens ??
        0,
    ) || 0;
  const outputTokens =
    Number(
      usage.output_tokens ??
        usage.outputTokens ??
        usage.completion_tokens ??
        0,
    ) || 0;

  const costRaw =
    usage.total_cost_usd ??
    usage.cost_usd ??
    usage.costUsd ??
    obj.total_cost_usd ??
    obj.cost_usd;
  const costUsd = costRaw != null ? Number(costRaw) || 0 : 0;

  /** @type {{ inputTokens: number, outputTokens: number, costUsd?: number }} */
  const out = { inputTokens, outputTokens };
  if (costRaw != null) {
    out.costUsd = costUsd;
  }
  return out;
}

/**
 * Spawn the Kimi CLI with stream-json (or plain-text fallback) output.
 *
 * @param {object} opts
 * @param {string} [opts.binary]
 * @param {string[]} opts.args
 * @param {string} opts.cwd
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
    onEvent,
    onExit,
    onError,
  } = opts;

  let stderrText = "";
  let fullStdout = "";
  let lineBuf = "";
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
    if (typeof onEvent === "function") {
      try {
        onEvent(obj);
      } catch {
        // defensive: never crash the parser
      }
    }
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
  const restoreEffort = flipKimiEffort(reasoningEffort);

  let child;
  try {
    child = spawn(binary, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    stderrText += chunk;
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
      try {
        child.kill("SIGTERM");
      } catch {
        // already dead
      }
      killTimer = setTimeout(() => {
        killTimer = null;
        try {
          if (!finished) child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, SIGKILL_AFTER_MS);
    },
  };
}

/**
 * Real session id from the meta resume hint, or null.
 * {"role":"meta","type":"session.resume_hint","session_id":"session_..."}
 * Kimi DOES have per-session resume (-S <id>, verified live); the old
 * per-cwd "-c" design predates knowing that.
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
  extractAssistantText,
  extractToolEvent,
  extractToolEvents,
  extractSessionId,
  extractUsage,
  truncate,
  INPUT_TRUNCATE,
  OUTPUT_TRUNCATE,
  SIGKILL_AFTER_MS,
};
