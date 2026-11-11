"use strict";
// #1961: fresh-process resume accounting. Synthetic protocol frames only
// (from the #1960 investigation): no provider CLI, credentials or paid turns.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createClaudeUsage, normalizeClaudeCheckpoint, claudeCheckpointFromHandle } = require("../claude-usage.js");

const SESSION = "synthetic-resume-session";
const SCOPE = JSON.stringify({ provider: "claude" });
const TURNS = [
  { model: "fixture-model-a", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 }, cost: 0.01 },
  { model: "fixture-model-b", usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 }, cost: 0.02 },
  { model: "fixture-model-b", usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 }, cost: 0.01 },
];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const WIRE = { inputTokens: "input_tokens", outputTokens: "output_tokens", cacheReadInputTokens: "cache_read_input_tokens", cacheCreationInputTokens: "cache_creation_input_tokens" };
function modelUsage(turns) {
  const models = {};
  for (const t of turns) {
    const row = models[t.model] ||= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
    for (const [field, wire] of Object.entries(WIRE)) row[field] += t.usage[wire];
    row.costUSD += t.cost;
  }
  return models;
}
/** Turn `index`; the provider's cumulative totals start at `historyStart`. */
function frames(index, historyStart = 0) {
  const turn = TURNS[index];
  const history = TURNS.slice(historyStart, index + 1);
  return [
    { type: "assistant", message: { id: `msg-${index}`, model: turn.model, usage: turn.usage, content: [{ type: "text", text: `turn-${index}` }] } },
    { type: "result", subtype: "success", result: `turn-${index}`, session_id: SESSION, usage: turn.usage,
      total_cost_usd: history.reduce((sum, t) => sum + t.cost, 0), modelUsage: modelUsage(history) },
  ];
}
function account(index, handle, historyStart = 0) {
  const tracker = createClaudeUsage();
  const [assistant, result] = frames(index, historyStart);
  const raw = JSON.stringify(result);
  tracker.observe(assistant);
  const batch = tracker.finish(result, handle, "picker-alias-must-not-relabel-measurements");
  assert.equal(JSON.stringify(result), raw, "raw provider payload stays intact");
  return batch;
}
/** A new process handle hydrated the way the runner does after a reload. */
function resumedHandle(previous, version = "2.1.283") {
  const saved = claudeCheckpointFromHandle(previous, SCOPE, SESSION);
  return { claudeResume: { checkpoint: normalizeClaudeCheckpoint(JSON.parse(JSON.stringify(saved))), version } };
}
const sum = (batches, field) => batches.reduce((s, b) => s + b[field], 0);

describe("Claude resume accounting checkpoint (#1961)", () => {
  it("restored session totals bill only the new turn, then warm deltas", () => {
    const first = {};
    const one = account(0, first);
    const handle = resumedHandle(first);
    const two = account(1, handle);
    close(two.costUsd, 0.02);
    assert.equal(two.inputTokens, 4);
    assert.deepEqual(two.rows.map(r => r.model), ["fixture-model-b"], "no old-model growth on the resumed day");
    assert.equal(handle.claudeEpoch, "restored");
    close(one.costUsd + two.costUsd, 0.03);
    assert.equal(one.inputTokens + two.inputTokens, 14);
    const three = account(2, handle);
    close(sum([one, two, three], "costUsd"), 0.04);
    assert.equal(sum([one, two, three], "inputTokens"), 16);
    assert.equal(sum([one, two, three], "cachedInputTokens"), 26);
  });

  it("checkpoints survive repeated restarts (two app lifetimes and a model respawn)", () => {
    const first = {};
    const one = account(0, first);
    const second = resumedHandle(first);
    const two = account(1, second);
    const third = resumedHandle(second);
    const three = account(2, third);
    assert.equal(third.claudeEpoch, "restored");
    close(sum([one, two, three], "costUsd"), 0.04);
    assert.equal(sum([one, two, three], "inputTokens"), 16);
    const saved = claudeCheckpointFromHandle(third, SCOPE, SESSION);
    close(saved.reported.totalCostUsd, 0.04);
    assert.deepEqual(Object.keys(saved.reported.modelUsage).sort(), ["fixture-model-a", "fixture-model-b"]);
  });

  it("a replayed result on the same handle charges nothing more", () => {
    const first = {};
    account(0, first);
    const handle = resumedHandle(first);
    account(1, handle);
    const replay = account(1, handle);
    assert.equal(replay.costUsd, 0);
    assert.equal(replay.rows.reduce((s, r) => s + (r.costUsd || 0), 0), 0);
  });

  it("legacy reset totals keep process-local semantics, below and above the old total", () => {
    for (const version of ["2.1.276", "2.0.9"]) {
      const first = {};
      const one = account(0, first);
      const handle = resumedHandle(first, version);
      const two = account(1, handle, 1); // reset: totals start at this turn
      assert.equal(handle.claudeEpoch, "reset");
      close(two.costUsd, 0.02); // above the old $0.01 total
      const three = account(2, handle, 1);
      close(sum([one, two, three], "costUsd"), 0.04);
    }
    // Below the old total: reset proven by exact zero-start counters.
    const big = {};
    createClaudeUsage().finish({ type: "result", usage: { input_tokens: 50 }, total_cost_usd: 0.5, modelUsage: { m: { inputTokens: 50, costUSD: 0.5 } } }, big, "m");
    const handle = resumedHandle(big, "2.1.300");
    const tracker = createClaudeUsage();
    tracker.observe({ type: "assistant", message: { id: "x", model: "m", usage: { input_tokens: 3 } } });
    const batch = tracker.finish({ type: "result", usage: { input_tokens: 3 }, total_cost_usd: 0.01, modelUsage: { m: { inputTokens: 3, costUSD: 0.01 } } }, handle, "m");
    assert.equal(handle.claudeEpoch, "reset");
    close(batch.costUsd, 0.01);
  });

  it("a modern reset without saved cost-state is proven by counters, not version", () => {
    const first = {};
    account(0, first);
    const handle = resumedHandle(first, "2.1.318");
    const two = account(1, handle, 1);
    assert.equal(handle.claudeEpoch, "reset");
    close(two.costUsd, 0.02);
    assert.equal(two.inputTokens, 4);
  });

  it("restored history without a checkpoint marks the turn's cost unavailable, then warm deltas resume", () => {
    // Old store, fork, unknown version or account/target mismatch: no checkpoint.
    for (const version of ["2.1.283", null]) {
      const handle = { claudeResume: { checkpoint: null, version } };
      const two = account(1, handle);
      assert.equal(handle.claudeEpoch, "unknown");
      assert.equal(two.costUsd, 0, "unknown cost is reported unavailable, not as a charge");
      assert.ok(two.accounting.unavailableFields.includes("costUsd"));
      assert.ok(two.rows.every(r => !r.costReported));
      assert.equal(two.inputTokens, 4, "directly observed turn tokens still count");
      assert.deepEqual(two.rows.map(r => r.model), ["fixture-model-b"]);
      const three = account(2, handle);
      close(three.costUsd, 0.01);
      assert.equal(three.inputTokens, 2);
    }
  });

  it("an ambiguous snapshot is not classified by magnitude", () => {
    const first = {};
    account(0, first);
    const handle = resumedHandle(first);
    // Model A grew without a matching observation: neither restore nor reset is exact.
    const tracker = createClaudeUsage();
    tracker.observe({ type: "assistant", message: { id: "y", model: "fixture-model-a", usage: { input_tokens: 4 } } });
    const batch = tracker.finish({ type: "result", usage: { input_tokens: 4 }, total_cost_usd: 0.5,
      modelUsage: { "fixture-model-a": { inputTokens: 99, costUSD: 0.5 } } }, handle, null);
    assert.equal(handle.claudeEpoch, "unknown");
    assert.ok(batch.accounting.unavailableFields.includes("costUsd"));
    assert.equal(batch.inputTokens, 4);
  });

  it("already-accounted partial observations since spawn are part of the baseline", () => {
    const first = {};
    account(0, first);
    const handle = resumedHandle(first);
    // An interrupted turn on the new process: measured, no result yet.
    const partial = createClaudeUsage();
    partial.observe({ type: "assistant", message: { id: "p", model: "fixture-model-b", usage: TURNS[1].usage } });
    assert.equal(partial.finish(null, handle, null).inputTokens, 4);
    assert.ok(handle.claudeResume, "partial flush does not settle the epoch");
    assert.equal(claudeCheckpointFromHandle(handle, SCOPE, SESSION), null, "unsettled epoch writes no checkpoint");
    const next = account(2, handle);
    assert.equal(handle.claudeEpoch, "restored");
    assert.equal(next.inputTokens, 2);
    close(next.costUsd, 0.03, "the partial turn's dollars were never reported before");
  });

  it("unattributed checkpoint measurements block restoration rather than being renamed", () => {
    const first = {};
    account(0, first);
    const saved = claudeCheckpointFromHandle(first, SCOPE, SESSION);
    saved.unattributed = { inputTokens: 5 };
    const handle = { claudeResume: { checkpoint: normalizeClaudeCheckpoint(saved), version: "2.1.283" } };
    account(1, handle);
    assert.equal(handle.claudeEpoch, "unknown");
  });

  it("normalizes malformed and sparse checkpoints on load", () => {
    for (const bad of [null, 1, "x", [], {}, { version: 2, scope: "s", sessionId: "x" }, { version: 1, scope: "s" }, { version: 1, sessionId: "x" }]) {
      assert.equal(normalizeClaudeCheckpoint(bad), null);
    }
    assert.deepEqual(normalizeClaudeCheckpoint({
      version: 1, scope: "s", sessionId: "x", totalCostUsd: -1,
      modelUsage: { "<synthetic>": { inputTokens: 1 }, a: { inputTokens: 2, outputTokens: NaN, costUSD: "1" }, b: [] , c: { junk: 1 } },
      unattributed: { inputTokens: 0, outputTokens: 3, costUSD: Infinity },
      reported: { totalCostUsd: 0.2, modelUsage: { a: { costUSD: 0.2 } } },
    }), {
      version: 1, scope: "s", sessionId: "x", totalCostUsd: 0,
      modelUsage: { a: { inputTokens: 2 } }, unattributed: { outputTokens: 3 },
      reported: { totalCostUsd: 0.2, modelUsage: { a: { costUSD: 0.2 } } },
    });
  });

  it("a new session handle never inherits a checkpoint", () => {
    const first = {};
    account(0, first);
    const fresh = {}; // runner sets claudeResume only for --resume spawns
    const batch = account(0, fresh);
    close(batch.costUsd, 0.01);
    assert.equal(fresh.claudeEpoch, undefined);
  });
});

describe("Claude resume accounting through the runner and Store reload (#1961)", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { Store, localDayKey } = require("../store.js");
  const services = require("../services.js");
  const { createRunner } = require("../runner.js");
  const { writeFakeBin } = require("./support/fakeBin.js");
  const { rmTree } = require("./support/rmTree.js");
  const { waitFor } = require("./support/replay.js");

  async function harness(t) {
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith("CODER_")) delete process.env[key];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-claude-resume-"));
    const bin = path.join(dir, "bin"); fs.mkdirSync(bin); fs.symlinkSync(process.execPath, path.join(bin, "node"));
    Object.assign(process.env, { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, CODER_SEATBELT: "off", CODER_GROK_MCP_DISABLE: "1", CODER_CURSOR_MCP_DISABLE: "1", CODER_KIMI_MCP_PATH: path.join(dir, "mcp.json") });
    // Every process restores the full session history (modern saved cost-state).
    const counter = path.join(dir, "turn");
    const spawns = path.join(dir, "spawns");
    process.env.CODER_CLAUDE_BIN = writeFakeBin(path.join(dir, "fake-claude"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(spawns)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + "\\n");
const turns = ${JSON.stringify([frames(0), frames(1), frames(2)])};
const emit = e => process.stdout.write(JSON.stringify(e) + "\\n");
emit({ type: "system", subtype: "init", claude_code_version: "2.1.283", model: "fixture-model-a", session_id: ${JSON.stringify(SESSION)} });
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  if (JSON.parse(line).type !== "user") return;
  const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;
  fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
  for (const frame of turns[n]) emit(frame);
});
setInterval(() => {}, 500);
`);
    const core = await import("../../core/dist/index.js");
    const file = path.join(dir, "store.json");
    const h = { dir, file, store: new Store(file), runner: null };
    const repo = path.join(dir, "repo"); fs.mkdirSync(repo); execFileSync("git", ["init", "-q"], { cwd: repo });
    const project = await services.addProject(h.store, repo);
    h.thread = services.createThread(h.store, { projectId: project.id, title: "resume", provider: "claude" });
    h.boot = () => { h.runner = createRunner({ store: h.store, core, pushFn() {}, tickMs: 15, userDataPath: dir }); };
    h.send = async prompt => {
      const before = h.store.getUsage(h.thread.id)?.turns || 0;
      await h.runner.startRun({ threadId: h.thread.id, prompt });
      await waitFor(() => h.store.getThread(h.thread.id).status === "done" && h.store.getUsage(h.thread.id)?.turns > before);
    };
    h.spawns = () => fs.readFileSync(spawns, "utf8").trim().split("\n").map(JSON.parse);
    /** Kill the app: stop the CLI, wait for it to die, flush and reload the Store. */
    h.restartApp = async (mutate) => {
      h.runner.stopAll();
      const pid = h.spawns().at(-1).pid;
      await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
      await h.store.flushPending(); h.store.saveNow();
      if (mutate) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        mutate(raw.threads.find(x => x.id === h.thread.id));
        fs.writeFileSync(file, JSON.stringify(raw));
      }
      h.store = new Store(file);
      h.boot();
    };
    h.cells = () => h.store.getUsageByDay()[localDayKey(new Date())].claude;
    t.after(async () => {
      h.runner?.stopAll();
      await h.store.flushPending();
      await rmTree(dir);
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    });
    h.boot();
    return h;
  }

  it("restored totals across two app lifetimes record $0.03/14 then $0.04/16 everywhere", async (t) => {
    const h = await harness(t);
    await h.send("one");
    close(h.store.getUsage(h.thread.id).costUsd, 0.01);
    await h.restartApp();
    const cp = h.store.getThread(h.thread.id).claudeAccounting;
    assert.equal(cp.sessionId, SESSION);
    close(cp.reported.totalCostUsd, 0.01);
    await h.send("two");
    close(h.store.getUsage(h.thread.id).costUsd, 0.03);
    assert.equal(h.store.getUsage(h.thread.id).inputTokens, 14);
    await h.send("three"); // warm follow-up on the second process
    close(h.store.getUsage(h.thread.id).costUsd, 0.04);
    assert.equal(h.store.getUsage(h.thread.id).inputTokens, 16);
    close(h.store.getSpendToday(), 0.04);
    const cells = h.cells();
    assert.equal(cells["fixture-model-a"].inputTokens, 10, "no old-model growth on the resumed day");
    close(cells["fixture-model-a"].costUsd, 0.01);
    assert.equal(cells["fixture-model-b"].inputTokens, 6);
    close(cells["fixture-model-b"].costUsd, 0.03);
    const spawns = h.spawns();
    assert.equal(spawns.length, 2);
    assert.ok(spawns[1].argv.includes("--resume") && spawns[1].argv.includes(SESSION));
    // A third lifetime reloads the checkpoint written by the warm turn.
    await h.restartApp();
    close(h.store.getThread(h.thread.id).claudeAccounting.totalCostUsd, 0.04);
    close(h.store.getUsage(h.thread.id).costUsd, 0.04);
  });

  it("a model change respawn uses the same checkpoint rule", async (t) => {
    const h = await harness(t);
    await h.send("one");
    h.store.updateThread(h.thread.id, { model: "some-picker-alias" });
    await h.send("two");
    assert.equal(h.spawns().length, 2, "the model change replaced the process");
    close(h.store.getUsage(h.thread.id).costUsd, 0.03);
    assert.equal(h.store.getUsage(h.thread.id).inputTokens, 14);
    assert.ok(h.cells()["fixture-model-b"], "exact wire model ID, not the picker alias");
    assert.equal(h.cells()["some-picker-alias"], undefined);
  });

  it("an old Store without a checkpoint keeps history and marks the resumed turn's cost unavailable", async (t) => {
    const h = await harness(t);
    await h.send("one");
    await h.restartApp(thread => { delete thread.claudeAccounting; });
    assert.equal(h.store.getThread(h.thread.id).claudeAccounting, undefined);
    await h.send("two");
    const usage = h.store.getUsage(h.thread.id);
    close(usage.costUsd, 0.01);
    assert.equal(usage.inputTokens, 14, "directly observed turn tokens count");
    assert.ok(usage.accounting.unavailableFields.includes("costUsd"));
    assert.equal(h.cells()["fixture-model-a"].inputTokens, 10);
    await h.send("three");
    close(h.store.getUsage(h.thread.id).costUsd, 0.02, "later warm deltas are known again");
    assert.equal(h.store.getUsage(h.thread.id).inputTokens, 16);
  });

  it("a malformed checkpoint or a different account scope is ignored, never trusted", async (t) => {
    const h = await harness(t);
    await h.send("one");
    await h.restartApp(thread => { thread.claudeAccounting = { ...thread.claudeAccounting, scope: JSON.stringify({ provider: "claude:other" }) }; });
    await h.send("two");
    close(h.store.getUsage(h.thread.id).costUsd, 0.01);
    assert.ok(h.store.getUsage(h.thread.id).accounting.unavailableFields.includes("costUsd"));
  });
});

it("captured 2.1.283 resume after a result-less run classifies as a reset by exact counters", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const events = fs.readFileSync(path.join(__dirname, "fixtures/replay/claude-2.1.283-restart-resumed.ndjson"), "utf8")
    .trim().split("\n").map(JSON.parse).map(x => x.emit).filter(Boolean);
  const tracker = createClaudeUsage();
  const handle = { claudeResume: { checkpoint: null, version: "2.1.283" } };
  let result;
  for (const ev of events) {
    if (ev.type === "stream_event") tracker.observe(ev, ev.event);
    else if (ev.type === "assistant") tracker.observe(ev);
    else if (ev.type === "result") result = ev;
  }
  const batch = tracker.finish(result, handle, null);
  assert.equal(handle.claudeEpoch, "reset");
  close(batch.costUsd, result.total_cost_usd);
  assert.equal(batch.rows[0].model, "claude-haiku-4-5-20251001");
  assert.equal(batch.inputTokens, 10);
});
