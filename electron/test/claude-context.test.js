"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runClaude } = require("../claude.js");
const { claudeCompaction } = require("../claude-context.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

const summary = { maxTokens: 150000, autoCompactThreshold: 117000, isAutoCompactEnabled: true };

describe("Claude compaction policy", () => {
  it("keeps reported estimates distinct from the enforced trigger", () => {
    assert.deepEqual(claudeCompaction(summary), { kind: "threshold", tokens: 117000, source: "reported" });
    assert.deepEqual(claudeCompaction({ enabled: true, enforced: true, effective_window: 130000, threshold: 39000 }, true),
      { kind: "threshold", tokens: 39000, source: "enforced" });
    assert.deepEqual(claudeCompaction({ ...summary, isAutoCompactEnabled: false }), { kind: "disabled" });
    assert.deepEqual(claudeCompaction({ enabled: true, enforced: false }, true), { kind: "reactive" });
    assert.equal(claudeCompaction({ ...summary, autocompactSource: "auto" }), null);
  });

  it("rejects missing and malformed measurements without inventing a threshold", () => {
    for (const value of [null, [], {}, { ...summary, isAutoCompactEnabled: "true" },
      { ...summary, autoCompactThreshold: "117000" }, { ...summary, autoCompactThreshold: 0 },
      { ...summary, autoCompactThreshold: Infinity }, { ...summary, autoCompactThreshold: 150001 },
      { ...summary, maxTokens: NaN }, { isAutoCompactEnabled: true }]) {
      assert.equal(claudeCompaction(value), null);
    }
  });
});

async function fakeSession(t, { version = "2.1.318", response = summary, ignore = false,
  contextSummaryAllowed = true, exitOnRequest = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-context-"));
  const input = path.join(dir, "input.jsonl");
  const binary = writeFakeBin(path.join(dir, "claude.js"), `
const fs = require("node:fs");
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  fs.appendFileSync(${JSON.stringify(input)}, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.type === "user") {
    emit({ type: "system", subtype: "init", claude_code_version: ${JSON.stringify(version)} });
    emit({ type: "result", result: "ok" });
  } else if (msg.request?.subtype === "get_context_usage" && !${ignore}) {
    if (${exitOnRequest}) return process.exit(0);
    emit({ type: "control_response", response: {
      subtype: ${response === null ? '"error"' : '"success"'}, request_id: msg.request_id,
      response: ${JSON.stringify(response)}, error: "unsupported"
    } });
  }
});
`);
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const session = runClaude({ binary, args: [], cwd: dir, prompt: "existing turn", interactive: true,
    keepAlive: true, contextSummaryAllowed,
    onEvent: (ev) => { if (ev.type === "result") resolveResult(); }, onExit: resolveExit });
  t.after(async () => { session.kill(); await exited; await rmTree(dir); });
  await result;
  return { session, messages: () => fs.readFileSync(input, "utf8").trim().split("\n").map(JSON.parse) };
}

describe("Claude local context summary transport", () => {
  it("queries the existing process, correlates one concurrent request, and sends no user turn", async (t) => {
    const { session, messages } = await fakeSession(t);
    const first = session.getContextUsage();
    assert.equal(session.getContextUsage(), first);
    assert.deepEqual(await first, summary);
    assert.equal(messages().filter((m) => m.type === "user").length, 1);
    const request = messages().find((m) => m.type === "control_request");
    assert.deepEqual(request.request, { subtype: "get_context_usage", detail: "summary" });
  });

  it("does not invoke full token counting on an older or unknown CLI", async (t) => {
    for (const version of ["2.1.219", "2.1.283", "", "not-a-version"]) {
      const { session, messages } = await fakeSession(t, { version });
      assert.equal(await session.getContextUsage(), null);
      assert.equal(messages().length, 1);
    }
  });

  it("falls back after an unsupported response and does not retry every turn", async (t) => {
    const { session, messages } = await fakeSession(t, { response: null });
    assert.equal(await session.getContextUsage(), null);
    assert.equal(await session.getContextUsage(), null);
    assert.equal(messages().filter((m) => m.type === "control_request").length, 1);
  });

  it("skips summaries when a known override makes them unreliable", async (t) => {
    const { session, messages } = await fakeSession(t, { contextSummaryAllowed: false });
    assert.equal(await session.getContextUsage(), null);
    assert.equal(messages().length, 1);
  });

  it("retires pending measurements on a new turn, a model change and process exit", async (t) => {
    const { session } = await fakeSession(t, { ignore: true });
    const previousTurn = session.getContextUsage();
    assert.equal(session.send("next turn"), true);
    assert.equal(await previousTurn, null);
    const previousModel = session.getContextUsage();
    assert.equal(session.setModel("other-model"), true);
    assert.equal(await previousModel, null);
    const { session: exiting } = await fakeSession(t, { exitOnRequest: true });
    assert.equal(await exiting.getContextUsage(), null);
  });

  it("bounds an unanswered request and releases it on kill", async (t) => {
    const { session, messages } = await fakeSession(t, { ignore: true });
    assert.equal(await session.getContextUsage(), null);
    assert.equal(await session.getContextUsage(), null);
    assert.equal(messages().filter((m) => m.type === "control_request").length, 1);
    const { session: other } = await fakeSession(t, { ignore: true });
    const pending = other.getContextUsage();
    other.kill();
    assert.equal(await pending, null);
  });
});
