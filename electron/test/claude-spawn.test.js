"use strict";

/**
 * Direct spawn contract for claude.js / codex.js + writeFakeBin.
 * Smoke pass C/D on windows-latest is the Electron proof (#480); these
 * tests lock the same parse/exit behaviour under plain node so a
 * regression does not wait for the smoke job.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runClaude } = require("../claude.js");
const { runCodex } = require("../codex.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coder-claude-spawn-"));
}

function runToExit(start, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`spawn did not exit in ${timeoutMs}ms`)),
      timeoutMs,
    );
    let settled = false;
    const finish = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      fn(arg);
    };
    start({
      resolve: finish(resolve),
      reject: finish(reject),
    });
  });
}

describe("runClaude + writeFakeBin (#480)", () => {
  it("parses stream-json including the result line from a .cmd-safe fake", async () => {
    const dir = tmpDir();
    try {
      const bin = writeFakeBin(
        path.join(dir, "fake-claude"),
        `"use strict";
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "system", subtype: "init", session_id: "spawn-sess", model: "m" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
emit({
  type: "result",
  subtype: "success",
  result: "ok",
  session_id: "spawn-sess",
  usage: { input_tokens: 3, output_tokens: 2 },
});
process.exit(0);
`,
      );
      const events = [];
      const info = await runToExit(({ resolve, reject }) => {
        runClaude({
          binary: bin,
          args: ["-p"],
          prompt: "hi",
          cwd: dir,
          interactive: true,
          keepAlive: true,
          onEvent: (ev) => events.push(ev),
          onExit: resolve,
          onError: reject,
        });
      });
      assert.equal(info.code, 0, info.stderr);
      assert.equal(info.gotResult, true);
      assert.ok(
        events.some((e) => e.type === "result" && e.session_id === "spawn-sess"),
        `expected result event, got ${JSON.stringify(events)}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still reports gotResult false when the fake omits the result line", async () => {
    const dir = tmpDir();
    try {
      const bin = writeFakeBin(
        path.join(dir, "fake-claude-no-result"),
        `"use strict";
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "system", subtype: "init", session_id: "no-result", model: "m" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
process.exit(0);
`,
      );
      const events = [];
      const info = await runToExit(({ resolve, reject }) => {
        runClaude({
          binary: bin,
          args: ["-p"],
          prompt: "hi",
          cwd: dir,
          interactive: true,
          keepAlive: true,
          onEvent: (ev) => events.push(ev),
          onExit: resolve,
          onError: reject,
        });
      });
      assert.equal(info.code, 0, info.stderr);
      assert.equal(info.gotResult, false);
      assert.ok(
        events.some((e) => e.type === "assistant"),
        `expected parsed assistant event so this is not a silent miss, got ${JSON.stringify(events)}`,
      );
      assert.equal(
        events.some((e) => e.type === "result"),
        false,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not report silent exit 0 when CODER_CLAUDE_BIN points at a missing file", async () => {
    const dir = tmpDir();
    try {
      const missing = path.join(dir, "no-such-claude.cmd");
      assert.equal(fs.existsSync(missing), false);
      let error;
      const info = await runToExit(({ resolve, reject }) => {
        runClaude({
          binary: missing,
          args: ["-p"],
          prompt: "hi",
          cwd: dir,
          interactive: true,
          keepAlive: true,
          onEvent: () => {},
          onExit: resolve,
          onError: (err) => {
            error = err;
            // onError + onExit(1) both fire; wait for onExit so we can
            // assert the code. reject() would hide a silent 0.
          },
        });
      });
      assert.notEqual(
        info.code,
        0,
        `missing binary must not look like a clean run (stderr=${info.stderr})`,
      );
      assert.equal(info.gotResult, false);
      assert.ok(
        error || info.code === 1 || /not found|ENOENT|EINVAL/i.test(String(info.stderr)),
        `expected spawn error or nonzero, got code=${info.code} stderr=${info.stderr}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runCodex + writeFakeBin (#480 pass D)", () => {
  it("parses JSONL including turn.completed from a .cmd-safe fake", async () => {
    const dir = tmpDir();
    try {
      const bin = writeFakeBin(
        path.join(dir, "fake-codex"),
        `"use strict";
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "thread.started", thread_id: "spawn-codex" });
emit({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } });
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
process.exit(0);
`,
      );
      const events = [];
      const info = await runToExit(({ resolve, reject }) => {
        runCodex({
          binary: bin,
          args: [],
          cwd: dir,
          onEvent: (ev) => events.push(ev),
          onExit: resolve,
          onError: reject,
        });
      });
      assert.equal(info.code, 0, info.stderr);
      assert.ok(
        events.some((e) => e.type === "turn.completed"),
        `expected turn.completed, got ${JSON.stringify(events)}`,
      );
      assert.ok(
        events.some((e) => e.type === "thread.started" && e.thread_id === "spawn-codex"),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
