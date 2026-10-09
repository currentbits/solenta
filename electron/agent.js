"use strict";

// cross-spawn, not child_process: on Windows the agent CLIs install as
// .cmd shims and Node refuses to exec those directly. cross-spawn routes
// them through cmd.exe with correct escaping, which matters because the
// prompt travels in argv (#442).
const spawn = require("cross-spawn");
const { killTree, agentSpawnOptions } = require("./proc.js");

const CHUNK_THROTTLE_MS = 250;
const SIGKILL_AFTER_MS = 3000;
// Max stderr retained per child process (tail), for error reporting.
const STDERR_TAIL_CHARS = 64 * 1024;

/**
 * Spawn a real agent CLI as a child process.
 *
 * By default the prompt is appended as the final argument. Pass
 * appendPrompt: false when args already include the prompt (registry
 * text providers). stdout is utf8 and delivered via onChunk as
 * accumulated text, at most every 250ms. onDone(exitCode, fullText,
 * stderrText) fires when the process exits. kill() sends SIGTERM, then
 * SIGKILL after 3s if the group is still alive.
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} [opts.args]
 * @param {string} [opts.prompt]
 * @param {boolean} [opts.appendPrompt=true]
 * @param {string} opts.cwd
 * @param {NodeJS.ProcessEnv} [opts.env] - full child env; undefined inherits
 * @param {(text: string) => void} opts.onChunk
 * @param {(exitCode: number | null, fullText: string, stderrText: string) => void} opts.onDone
 * @param {(err: Error) => void} [opts.onError]
 * @returns {{ kill: () => void }}
 */
function runAgent(opts) {
  const {
    command,
    args = [],
    prompt,
    appendPrompt = true,
    cwd,
    env,
    onChunk,
    onDone,
    onError,
  } = opts;

  let fullText = "";
  let stderrText = "";
  let lastNotifyAt = 0;
  let throttleTimer = null;
  let finished = false;
  let killTimer = null;
  let killed = false;

  function flushChunk() {
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    lastNotifyAt = Date.now();
    if (typeof onChunk === "function") {
      onChunk(fullText);
    }
  }

  function scheduleChunk() {
    const now = Date.now();
    const elapsed = now - lastNotifyAt;
    if (lastNotifyAt === 0 || elapsed >= CHUNK_THROTTLE_MS) {
      flushChunk();
      return;
    }
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      flushChunk();
    }, CHUNK_THROTTLE_MS - elapsed);
  }

  function finish(code) {
    if (finished) return;
    finished = true;
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    // Final chunk so consumers see the complete text even if under throttle.
    if (fullText.length > 0 && typeof onChunk === "function") {
      onChunk(fullText);
    }
    if (typeof onDone === "function") {
      onDone(code, fullText, stderrText);
    }
  }

  const spawnArgs = appendPrompt
    ? [...args, String(prompt ?? "")]
    : [...args];

  let child;
  try {
    child = spawn(
      command,
      spawnArgs,
      agentSpawnOptions({
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (typeof onError === "function") onError(error);
    // Still surface a synthetic done so callers can mark failed.
    if (typeof onDone === "function") {
      onDone(1, fullText, stderrText || error.message);
    }
    return {
      kill() {},
    };
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    fullText += chunk;
    scheduleChunk();
  });

  child.stderr.on("data", (chunk) => {
    // Tail-keep: stderr feeds error reporting, and a noisy CLI would
    // otherwise grow this buffer for the life of a long-lived process.
    stderrText = (stderrText + chunk).slice(-STDERR_TAIL_CHARS);
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
 * Spawn a CLI that writes one JSON object per stdout line (NDJSON / JSONL).
 * Shared plumbing for the stream-json provider adapters.
 *
 * Non-JSON and non-object lines are skipped. onEvent throwing never breaks
 * the parser. On exit (or spawn/runtime error) the trailing partial line is
 * flushed, the SIGKILL escalation timer is cleared and onExit fires exactly
 * once with { code, stderr, fullStdout, gotJson }. Adapters map that to
 * their own payload. kill() sends SIGTERM to the tree, then SIGKILL after
 * SIGKILL_AFTER_MS.
 *
 * @param {object} opts
 * @param {string} opts.binary
 * @param {string[]} [opts.args]
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} [opts.env] - full child env; undefined inherits
 * @param {"ignore" | "pipe"} [opts.stdin="ignore"]
 * @param {boolean} [opts.keepStdout=false] - accumulate fullStdout (one-shot
 *   runs only; a long-lived child would grow it without bound)
 * @param {(obj: object) => void} [opts.onEvent]
 * @param {(info: { code: number | null, stderr: string, fullStdout: string, gotJson: boolean }) => void} [opts.onExit]
 * @param {(err: Error) => void} [opts.onError]
 * @returns {{ child: import("node:child_process").ChildProcess | null, kill: () => void, getStderr: () => string, isFinished: () => boolean }}
 *   child is null when spawn threw (onExit already fired with code 1)
 */
function runJsonLines(opts) {
  const {
    binary,
    args = [],
    cwd,
    env,
    stdin = "ignore",
    keepStdout = false,
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
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (lineBuf.trim()) {
      handleLine(lineBuf);
      lineBuf = "";
    }
    if (typeof onExit === "function") {
      onExit({ code, stderr: stderrText, fullStdout, gotJson });
    }
  }

  let child;
  try {
    child = spawn(
      binary,
      args,
      agentSpawnOptions({ cwd, env, stdio: [stdin, "pipe", "pipe"] }),
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (typeof onError === "function") onError(error);
    if (typeof onExit === "function") {
      onExit({ code: 1, stderr: error.message, fullStdout: "", gotJson: false });
    }
    return {
      child: null,
      kill() {},
      getStderr: () => "",
      isFinished: () => true,
    };
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    if (keepStdout) fullStdout += chunk;
    lineBuf += chunk;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      handleLine(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    // Tail-keep: stderr feeds error reporting, and a noisy CLI would
    // otherwise grow this buffer for the life of a long-lived process.
    stderrText = (stderrText + chunk).slice(-STDERR_TAIL_CHARS);
  });

  child.on("error", (err) => {
    if (typeof onError === "function") onError(err);
    finish(1);
  });

  child.on("close", (code) => {
    finish(code);
  });

  return {
    child,
    kill() {
      if (killed || finished) return;
      killed = true;
      killTimer = killTree(child, SIGKILL_AFTER_MS);
    },
    getStderr: () => stderrText,
    isFinished: () => finished,
  };
}

/**
 * Parse CODER_AGENT_CMD style string: first token = binary, rest = leading args.
 * @param {string} [cmd]
 * @returns {{ command: string, args: string[] }}
 */
function parseAgentCommand(cmd) {
  const raw = (cmd && String(cmd).trim()) || "claude -p";
  const parts = raw.split(/\s+/).filter(Boolean);
  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

module.exports = {
  runAgent,
  runJsonLines,
  parseAgentCommand,
  CHUNK_THROTTLE_MS,
  SIGKILL_AFTER_MS,
};
