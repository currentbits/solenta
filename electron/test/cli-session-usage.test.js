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
    const ledger = () => { throw new Error("ledger accessed"); };
    const store = { getThreads: () => [], getSettings: () => ({ providerInstances: [], modelPrices: {} }),
      getUsageByDay: ledger, getUsageThreadsByDay: ledger, recordSpend: ledger, recordUsage: ledger, updateThread: ledger, save: ledger };
    for (const scope of ["cli", "external"]) {
      const report = await handler({ store }, { scope });
      assert.equal(modelCell(report, "claude", "sonnet").turns, 1);
    }
    await assert.rejects(handler({ store }, { scope: "external", homes: "claude" }), /Invalid usage homes/);
    await assert.rejects(handler({ store }, { scope: "unsupported" }), /Invalid usage scope/);
  });

  it("IPC CLI reads include isolated-home instances under userData", async () => {
    const userDataPath = path.join(root, "userdata");
    write("userdata/provider-homes/work/claude/projects/project/root.jsonl", [claude("isolated-one")]);
    const handler = require("../ipc-insights.js")["usage:byDay"];
    const store = { getThreads: () => [], getSettings: () => ({
      providerInstances: [{ id: "work", provider: "claude", name: "Work", isolatedHome: true }], modelPrices: {},
    }) };
    const report = await handler({ store, userDataPath }, { scope: "cli" });
    assert.equal(modelCell(report, "claude", "sonnet").turns, 1);
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

  it("discards a file truncated during a scan, but reads one that grows", async () => {
    const file = write("claude/projects/project/root.jsonl", [claude("one"), claude("two")]);
    const open = fsp.open;
    let mutate = () => fs.truncateSync(file, 10);
    fsp.open = async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      let calls = 0;
      handle.stat = async () => {
        if (++calls === 2) mutate();
        return stat();
      };
      return handle;
    };
    const reader = createCliUsageReader();
    try {
      assert.equal((await reader.read()).cli.skippedFiles, 1);
      write("claude/projects/project/root.jsonl", [claude("one")]);
      mutate = () => fs.appendFileSync(file, JSON.stringify(claude("late")) + "\n");
      const report = await reader.read();
      assert.equal(report.cli.skippedFiles, 0);
      assert.equal(modelCell(report, "claude", "sonnet").turns, 1, "bytes after the snapshot wait for the next scan");
    } finally { fsp.open = open; }
    assert.equal(modelCell(await reader.read(), "claude", "sonnet").turns, 2);
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

const totalTurns = (report) => Object.values(report.byDay).flatMap((p) => Object.values(p)).flatMap((m) => Object.values(m)).reduce((n, c) => n + c.turns, 0);
const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const usageHandler = () => require("../ipc-insights.js")["usage:byDay"];
const storeWith = (threads, settings = {}) => ({ getThreads: () => threads, getSettings: () => ({ providerInstances: [], modelPrices: {}, ...settings }) });

describe("usage outside Solenta", () => {
  it("drops Claude responses Solenta ran, across resumes, forks and subagents, but keeps imported history", async () => {
    const created = Date.now() - 10 * 60_000;
    const row = (session, id, msAgo = 1000) => ({ ...claude(id), sessionId: session, timestamp: at(msAgo) });
    // Imported at `created`: the earlier "cli-history" response ran in Terminal.
    write("claude/projects/p/sol.jsonl", [row("sol", "cli-history", 20 * 60_000), row("sol", "solenta-1"), row("sol", "solenta-1")]);
    write("claude/projects/p/sol/subagents/agent-a.jsonl", [row("sol", "solenta-sub")]);
    write("claude/projects/p/fork.jsonl", [row("fork", "cli-history", 20 * 60_000), row("fork", "solenta-1"), row("fork", "fork-new")]);
    write("claude/projects/p/terminal.jsonl", [row("terminal", "terminal-1")]);
    const store = storeWith([{ id: "t", provider: "claude", sessionId: "sol", createdAt: created }]);
    const external = await usageHandler()({ store }, { scope: "external" });
    assert.equal(totalTurns(external), 3, "cli-history + fork-new + terminal-1");
    assert.equal(external.cli.solentaResponses, 2);
    assert.equal(external.cli.scope, "external");
    const all = await usageHandler()({ store }, { scope: "cli" });
    assert.equal(totalTurns(all), 5);
    assert.equal(all.cli.solentaResponses, 0);
  });

  it("drops Codex turns from Solenta sessions and their spawned subagents, not from CLI forks", async () => {
    write("codex/sessions/sol.jsonl", [codexMeta("csol"), turn("t1"), usage(100)]);
    write("codex/sessions/sub.jsonl", [codexMeta("sub", { source: { subagent: { thread_spawn: { parent_thread_id: "csol" } } } }), turn("t2"), usage(50)]);
    write("codex/sessions/fork.jsonl", [codexMeta("cfork", { forked_from_id: "csol" }), turn("t1"), usage(100), turn("t3"), usage(110)]);
    const store = storeWith([{ id: "t", provider: "codex", sessionId: "csol", createdAt: 0 }]);
    const external = await usageHandler()({ store }, { scope: "external" });
    assert.equal(totalTurns(external), 1, "only the fork's new turn ran outside Solenta");
    assert.equal(external.cli.solentaResponses, 2);
  });

  it("drops nested Codex subagents of a Solenta session at any depth", async () => {
    const spawn = (parent) => ({ source: { subagent: { thread_spawn: { parent_thread_id: parent } } } });
    write("codex/sessions/sol.jsonl", [codexMeta("csol"), turn("t1"), usage(100)]);
    write("codex/sessions/child.jsonl", [codexMeta("child", spawn("csol")), turn("t2"), usage(50)]);
    write("codex/sessions/grandchild.jsonl", [codexMeta("grand", spawn("child")), turn("t3"), usage(30)]);
    const store = storeWith([{ id: "t", provider: "codex", sessionId: "csol", createdAt: 0 }]);
    const external = await usageHandler()({ store }, { scope: "external" });
    assert.equal(totalTurns(external), 0);
    assert.equal(external.cli.solentaResponses, 3);
  });

  it("re-reads a same-size in-place rewrite whose head and tail are unchanged", async () => {
    const pad = (id) => claude(id, 1, { content: "x".repeat(5000) });
    const file = write("claude/projects/p/s.jsonl", [pad("head"), claude("mid", 1), pad("tail")]);
    const reader = createCliUsageReader();
    assert.equal(modelCell(await reader.read(), "claude", "sonnet").outputTokens, 3);
    const before = fs.statSync(file);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"id":"mid","model":"sonnet","content":"PRIVATE PROMPT MUST NOT LEAVE THE SCANNER","usage":{"input_tokens":10,"output_tokens":1', '"id":"mid","model":"sonnet","content":"PRIVATE PROMPT MUST NOT LEAVE THE SCANNER","usage":{"input_tokens":10,"output_tokens":9'));
    fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2000));
    assert.equal(fs.statSync(file).size, before.size);
    assert.equal(modelCell(await reader.read(), "claude", "sonnet").outputTokens, 11);
  });

  it("reads only appended bytes, and re-reads a file rewritten in place", async () => {
    const file = write("claude/projects/p/s.jsonl", [claude("one")]);
    const reader = createCliUsageReader();
    await reader.read();
    const size = fs.statSync(file).size;
    const open = fsp.open;
    const starts = [];
    fsp.open = async (...args) => {
      const handle = await open(...args);
      const stream = handle.createReadStream.bind(handle);
      handle.createReadStream = (opts) => { starts.push(opts.start); return stream(opts); };
      return handle;
    };
    try {
      fs.appendFileSync(file, JSON.stringify(claude("two")) + "\n");
      const grown = await reader.read();
      assert.deepEqual(starts, [size]);
      assert.equal(modelCell(grown, "claude", "sonnet").turns, 2);
      assert.equal(grown.cli.rereadFiles, 0);
      // Same inode, longer content, different bytes: not an append.
      fs.writeFileSync(file, [claude("x", 1), claude("y", 1), claude("z", 1)].map((r) => JSON.stringify(r)).join("\n") + "\n");
      const rewritten = await reader.read();
      assert.equal(starts.at(-1), 0);
      assert.equal(rewritten.cli.rereadFiles, 1);
      assert.equal(modelCell(rewritten, "claude", "sonnet").turns, 3);
      assert.equal(modelCell(rewritten, "claude", "sonnet").outputTokens, 3);
    } finally { fsp.open = open; }
  });

  it("continues Codex parse state across appends and reports vanished logs as missing", async () => {
    const file = write("codex/sessions/s.jsonl", [codexMeta("s"), turn("t1"), usage(100)]);
    const reader = createCliUsageReader();
    assert.equal(modelCell(await reader.read(), "codex", "gpt").turns, 1);
    fs.appendFileSync(file, [usage(100), usage(120)].map((r) => JSON.stringify(r)).join("\n") + "\n");
    assert.equal(modelCell(await reader.read(), "codex", "gpt").turns, 2, "the repeated snapshot is not a new request");
    fs.unlinkSync(file);
    const gone = await reader.read();
    assert.equal(gone.cli.missingFiles, 1);
    assert.deepEqual({ ...gone.byDay }, {});
  });

  it("scans only the selected homes, each isolated", async () => {
    const userDataPath = path.join(root, "userdata");
    write("claude/projects/p/default.jsonl", [claude("default-1")]);
    write("userdata/provider-homes/work/claude/projects/p/work.jsonl", [claude("work-1"), claude("work-2")]);
    const store = storeWith([], { providerInstances: [{ id: "work", provider: "claude", name: "Work", isolatedHome: true }] });
    const work = await usageHandler()({ store, userDataPath }, { scope: "external", homes: ["instance:claude:work"] });
    assert.equal(totalTurns(work), 2);
    assert.deepEqual(work.cli.homes.map((h) => [h.id, h.label, h.selected]), [
      ["claude", "Claude Code", false], ["codex", "Codex", false], ["instance:claude:work", "Work", true],
    ]);
    assert.equal(totalTurns(await usageHandler()({ store, userDataPath }, { scope: "external", homes: ["claude"] })), 1);
    assert.equal(totalTurns(await usageHandler()({ store, userDataPath }, { scope: "external", homes: [] })), 0);
  });

  it("separates CLI-reported cost from API-rate estimates and keeps unpriced tokens unpriced", async () => {
    write("claude/projects/p/s.jsonl", [
      { ...claude("reported"), costUSD: 0.5 },
      claude("estimated"),
      { ...claude("other"), message: { ...claude("other").message, model: "mystery" } },
      // Cumulative session totals (restored on resume, #1961) are not per-response costs.
      { type: "cost-state", sessionId: "s", totalCostUSD: 99, modelUsage: { sonnet: { costUSD: 99 } } },
    ]);
    const report = await createCliUsageReader().read({ prices: { sonnet: { input: 1, output: 1 } } });
    assert.equal(report.cli.reportedCostUsd, 0.5);
    assert.ok(Math.abs(report.cli.estimatedCostUsd - (10 + 30 + 5 + 20) / 1e6) < 1e-12);
    assert.deepEqual(report.cli.unpricedModels, ["mystery"]);
    const mystery = modelCell(report, "claude", "mystery");
    assert.equal(mystery.costUsd, 0);
    assert.equal(mystery.unpricedTokens.outputTokens, 20);
  });

  it("skips an overlong line split across appends exactly once", async () => {
    const file = write("claude/projects/p/s.jsonl", [claude("one")]);
    fs.appendFileSync(file, "x".repeat(1024 * 1024 + 10));
    const reader = createCliUsageReader();
    assert.equal((await reader.read()).cli.skippedRecords, 1, "unterminated tail is incomplete");
    fs.appendFileSync(file, "tail-of-long-line\n" + JSON.stringify(claude("two")) + "\n");
    const report = await reader.read();
    assert.equal(report.cli.skippedRecords, 1);
    assert.equal(modelCell(report, "claude", "sonnet").turns, 2);
  });
});
