"use strict";

const { spawn } = require("node:child_process");

const CHUNK_THROTTLE_MS = 250;
const SIGKILL_AFTER_MS = 3000;

/**
 * Spawn a real agent CLI as a child process.
 *
 * Prompt is appended as the final argument. stdout is utf8 and delivered
 * via onChunk as accumulated text, at most every 250ms. onDone(exitCode,
 * fullText, stderrText) fires when the process exits. kill() sends SIGTERM,
 * then SIGKILL after 3s if still alive.
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} [opts.args]
 * @param {string} opts.prompt
 * @param {string} opts.cwd
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
    cwd,
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

  let child;
  try {
    child = spawn(command, [...args, String(prompt ?? "")], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
  parseAgentCommand,
  CHUNK_THROTTLE_MS,
  SIGKILL_AFTER_MS,
};
