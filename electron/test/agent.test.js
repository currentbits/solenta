const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { runAgent } = require("../agent.js");

function waitFor(predicate, { timeoutMs = 10000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("runAgent", () => {
  it("streams stdout chunks (throttled) and calls onDone with exit 0", async () => {
    const chunks = [];
    let doneArgs = null;

    // Minified -e script: print two pieces with a delay, then exit 0.
    // No spaces so CODER_AGENT_CMD whitespace-split stays valid if reused.
    const script =
      "process.stdout.write('Hello');setTimeout(()=>{process.stdout.write(' World');setTimeout(()=>process.exit(0),30)},40)";

    const handle = runAgent({
      command: process.execPath,
      args: ["-e", script],
      prompt: "unused-prompt",
      cwd: process.cwd(),
      onChunk: (text) => {
        chunks.push(text);
      },
      onDone: (exitCode, fullText) => {
        doneArgs = { exitCode, fullText };
      },
      onError: (err) => {
        throw err;
      },
    });

    await waitFor(() => doneArgs !== null);
    assert.equal(doneArgs.exitCode, 0);
    assert.equal(doneArgs.fullText, "Hello World");
    assert.ok(chunks.length >= 1, "expected at least one onChunk");
    assert.equal(chunks[chunks.length - 1], "Hello World");
    assert.ok(typeof handle.kill === "function");
  });

  it("nonzero exit captures stderr for the error path", async () => {
    let doneArgs = null;
    const script =
      "process.stderr.write('boom-line-1\\nbad stuff');process.exit(3)";

    runAgent({
      command: process.execPath,
      args: ["-e", script],
      prompt: "p",
      cwd: process.cwd(),
      onChunk: () => {},
      onDone: (exitCode, fullText, stderrText) => {
        doneArgs = { exitCode, fullText, stderrText };
      },
      onError: () => {},
    });

    await waitFor(() => doneArgs !== null);
    assert.equal(doneArgs.exitCode, 3);
    assert.match(doneArgs.stderrText || "", /boom-line-1/);
  });

  it("appends prompt as the final argument", async () => {
    let doneArgs = null;
    // Print process.argv last element (the prompt).
    const script =
      "process.stdout.write(process.argv[process.argv.length-1]);process.exit(0)";

    runAgent({
      command: process.execPath,
      args: ["-e", script],
      prompt: "PROMPT_TOKEN_XYZ",
      cwd: process.cwd(),
      onChunk: () => {},
      onDone: (exitCode, fullText) => {
        doneArgs = { exitCode, fullText };
      },
      onError: (err) => {
        throw err;
      },
    });

    await waitFor(() => doneArgs !== null);
    assert.equal(doneArgs.exitCode, 0);
    assert.equal(doneArgs.fullText, "PROMPT_TOKEN_XYZ");
  });

  it("kill sends SIGTERM (process exits)", async () => {
    let doneArgs = null;
    // Long-running agent that exits cleanly on SIGTERM (default).
    const script =
      "setInterval(()=>{},1000);setTimeout(()=>process.exit(0),30000)";

    const handle = runAgent({
      command: process.execPath,
      args: ["-e", script],
      prompt: "p",
      cwd: process.cwd(),
      onChunk: () => {},
      onDone: (exitCode, fullText) => {
        doneArgs = { exitCode, fullText };
      },
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));
    handle.kill();
    await waitFor(() => doneArgs !== null, { timeoutMs: 5000 });
    // Killed process should not report success as a normal finish; just that it ended.
    assert.ok(doneArgs !== null);
  });
});
