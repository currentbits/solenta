"use strict";
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createCliUsageReader } = require("../cli-session-usage.js");
const { localDayKey } = require("../store-util.js");

let root, previous;
const stamp = () => new Date(Date.now() - 1000).toISOString();
const claude = (id, output = 20, over = {}) => ({ type: "assistant", timestamp: stamp(), message: {
  id, model: "sonnet", content: "PRIVATE PROMPT MUST NOT LEAVE THE SCANNER", usage: {
    input_tokens: 10, output_tokens: output, cache_read_input_tokens: 30, cache_creation_input_tokens: 5,
  }, ...over,
} });
function write(relative, rows) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}
const modelCell = (report, provider, model) => report.byDay[localDayKey(new Date())]?.[provider]?.[model];
const codexMeta = (id, extra = {}) => ({ type: "session_meta", payload: { id, ...extra } });
const turn = (id) => ({ type: "turn_context", payload: { turn_id: id, model: "gpt" } });
const usage = (total) => ({ type: "event_msg", timestamp: stamp(), payload: { type: "token_count", info: {
  last_token_usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 3 },
  total_token_usage: { input_tokens: total, cached_input_tokens: 4, cache_write_input_tokens: 1, output_tokens: total / 2 },
} } });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-cli-usage-"));
  previous = [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME];
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.CODEX_HOME = path.join(root, "codex");
});
afterEach(() => {
  ["CLAUDE_CONFIG_DIR", "CODEX_HOME"].forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("local CLI usage", () => {
  it("deduplicates Claude blocks, fork copies and mirrored subagents, with configured pricing only", async () => {
    write("claude/projects/project/root.jsonl", [claude("one", 10), claude("one", 20)]);
    write("claude/projects/project/fork.jsonl", [claude("one", 20), claude("two", 5)]);
    write("claude/projects/project/root/subagents/agent-a.jsonl", [claude("two", 5)]);
    const report = await createCliUsageReader().read({ prices: { sonnet: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 } } });
    const cell = modelCell(report, "claude", "sonnet");
    assert.equal(cell.turns, 2);
    assert.equal(cell.inputTokens, 20);
    assert.equal(cell.cachedInputTokens, 60);
    assert.equal(cell.cacheWriteTokens, 10);
    assert.equal(cell.outputTokens, 25);
    assert.equal(cell.costUsd, (40 + 12 + 25 + 200) / 1e6);
    assert.equal(report.cli.files, 3);
    assert.deepEqual(report.cli.unpricedModels, []);
    assert.equal(JSON.stringify(report).includes("PRIVATE"), false);
    assert.deepEqual(report.threadsByDay, {});
  });

  it("counts identical-sized Codex requests once each, deduplicates fork history, and skips ambiguous ancestry", async () => {
    write("codex/sessions/2026/11/12/root.jsonl", [codexMeta("root"), turn("turn-one"), usage(100), usage(100), usage(110)]);
    write("codex/archived_sessions/fork.jsonl", [codexMeta("fork", { forked_from_id: "root" }), turn("turn-one"), usage(100), usage(110), turn("turn-two"), usage(120)]);
    write("codex/sessions/2026/11/12/ambiguous.jsonl", [codexMeta("child", { parent_thread_id: "root" }), { type: "turn_context", payload: { model: "gpt" } }, usage(140)]);
    const report = await createCliUsageReader().read();
    const cell = modelCell(report, "codex", "gpt");
    assert.equal(cell.turns, 3);
    assert.equal(cell.inputTokens, 15);
    assert.equal(cell.cachedInputTokens, 12);
    assert.equal(cell.cacheWriteTokens, 3);
    assert.equal(cell.outputTokens, 15, "reasoning is already included in output");
    assert.equal(cell.costUsd, 0);
    assert.equal(report.cli.skippedRecords, 1);
    assert.deepEqual(report.cli.unpricedModels, ["gpt"]);
  });

  it("caches unchanged files, re-reads growing/rewritten files, and drops deleted files", async () => {
    const file = write("claude/projects/project/root.jsonl", [claude("one")]);
    const reader = createCliUsageReader();
    await reader.read();
    const open = fsp.open;
    let opens = 0;
    fsp.open = async (...args) => { opens++; return open(...args); };
    try { assert.equal(modelCell(await reader.read(), "claude", "sonnet").turns, 1); assert.equal(opens, 0); }
    finally { fsp.open = open; }
    const tail = JSON.stringify(claude("two"));
    fs.appendFileSync(file, tail.slice(0, -2));
    assert.equal((await reader.read()).cli.skippedRecords, 1);
    fs.appendFileSync(file, tail.slice(-2) + "\n");
    assert.equal(modelCell(await reader.read(), "claude", "sonnet").turns, 2);
    fs.writeFileSync(file, JSON.stringify(claude("replacement", 3)) + "\n");
    assert.equal(modelCell(await reader.read(), "claude", "sonnet").outputTokens, 3);
    fs.unlinkSync(file);
    assert.deepEqual({ ...(await reader.read()).byDay }, {});
  });

  it("deduplicates configured homes and ignores symlinked logs", async () => {
    const file = write("claude/projects/project/root.jsonl", [claude("one")]);
    const outside = write("outside/other.jsonl", [claude("outside", 999)]);
    fs.symlinkSync(outside, path.join(path.dirname(file), "link.jsonl"));
    const report = await createCliUsageReader().read({ instances: [{ provider: "claude", env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } }] });
    assert.equal(report.cli.files, 1);
    assert.equal(modelCell(report, "claude", "sonnet").outputTokens, 20);
  });

  it("reports malformed counters, unsafe models, long lines and unreadable files as incomplete", async () => {
    const file = write("claude/projects/project/root.jsonl", [claude("one"), claude("bad", 1, { model: "__proto__" }), claude("bad-count", 1, { usage: { input_tokens: -1, output_tokens: 1 } })]);
    fs.appendFileSync(file, "x".repeat(1024 * 1024 + 1) + "\n");
    const reader = createCliUsageReader();
    const report = await reader.read();
    assert.equal(report.cli.skippedRecords, 3);
    assert.equal(modelCell(report, "claude", "sonnet").turns, 1);
    const open = fsp.open;
    fsp.open = async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
    try { assert.equal((await createCliUsageReader().read()).cli.skippedFiles, 1); }
    finally { fsp.open = open; }
  });

  it("IPC CLI reads never access or mutate the Solenta usage/spend ledger", async () => {
    write("claude/projects/project/root.jsonl", [claude("one")]);
    const handler = require("../ipc-insights.js")["usage:byDay"];
    const store = { getSettings: () => ({ providerInstances: [], modelPrices: {} }), getUsageByDay: () => { throw new Error("ledger accessed"); } };
    const report = await handler({ store }, { scope: "cli" });
    assert.equal(modelCell(report, "claude", "sonnet").turns, 1);
    await assert.rejects(handler({ store }, { scope: "unsupported" }), /Invalid usage scope/);
  });
});

describe("CLI scan boundaries", () => {
  it("marks the byte limit as partial without opening an oversized session", async () => {
    const file = write("claude/projects/project/large.jsonl", []);
    fs.truncateSync(file, 512 * 1024 * 1024 + 1);
    const report = await createCliUsageReader().read();
    assert.equal(report.cli.partial, true);
    assert.equal(report.cli.files, 0);
    assert.deepEqual({ ...report.byDay }, {});
  });

  it("discards files changed during a scan instead of caching a mixed snapshot", async () => {
    const file = write("claude/projects/project/root.jsonl", [claude("one")]);
    const open = fsp.open;
    fsp.open = async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      let calls = 0;
      handle.stat = async () => {
        if (++calls === 2) fs.appendFileSync(file, "\n");
        return stat();
      };
      return handle;
    };
    const reader = createCliUsageReader();
    try { assert.equal((await reader.read()).cli.skippedFiles, 1); }
    finally { fsp.open = open; }
    assert.equal(modelCell(await reader.read(), "claude", "sonnet").turns, 1);
  });
});

describe("CLI history attribution", () => {
  it("keeps a retimed Codex fork copy on its original day", async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    write("codex/sessions/root.jsonl", [codexMeta("root"), turn("old-turn"), { ...usage(100), timestamp: yesterday }]);
    write("codex/archived_sessions/fork.jsonl", [codexMeta("fork", { forked_from_id: "root" }), turn("old-turn"), usage(100), turn("new-turn"), usage(110)]);
    const report = await createCliUsageReader().read();
    assert.equal(report.byDay[localDayKey(new Date(yesterday))].codex.gpt.turns, 1);
    assert.equal(modelCell(report, "codex", "gpt").turns, 1);
    assert.equal(report.cli.skippedRecords, 0);
  });

  it("exposes missing ancestry rather than treating retimed historical copies as today's usage", async () => {
    write("codex/sessions/fork.jsonl", [codexMeta("fork", { forked_from_id: "missing-parent" }), turn("unknown-old-turn"), usage(100), turn("fresh-turn"), usage(110)]);
    const report = await createCliUsageReader().read();
    assert.deepEqual({ ...report.byDay }, {});
    assert.equal(report.cli.skippedRecords, 2);
  });
});
