"use strict";

// Investigation assertions describe current behavior, including its defect.
// Point at an isolated, built latest-main checkout; never starts a provider CLI.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { test, after } = require("node:test");
const fixture = require("./fixtures.json");
const root = path.resolve(process.env.SOLENTA_AUDIT_ROOT || path.join(__dirname, "../.."));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-resume-audit-"));
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
fs.symlinkSync(process.execPath, path.join(bin, "node"));
// Replace the inherited environment BEFORE loading application modules.
// No provider executable, live home, app settings, or credential environment.
const env = {
  HOME: tmp, USERPROFILE: tmp, TMPDIR: tmp,
  PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  CODER_SEATBELT: "off", CODER_GROK_MCP_DISABLE: "1",
  CODER_CURSOR_MCP_DISABLE: "1", CODER_KIMI_MCP_PATH: path.join(tmp, "kimi.json"),
};
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
const { createClaudeUsage } = require(path.join(root, "electron/claude-usage.js"));
const { Store, localDayKey } = require(path.join(root, "electron/store.js"));
const { createRunner } = require(path.join(root, "electron/runner.js"));
const services = require(path.join(root, "electron/services.js"));
const { waitFor } = require(path.join(root, "electron/test/support/replay.js"));
const { writeFakeBin } = require(path.join(root, "electron/test/support/fakeBin.js"));
const { rmTree } = require(path.join(root, "electron/test/support/rmTree.js"));
after(() => rmTree(tmp));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const modelUsage = turns => {
  const models = {};
  for (const t of turns) {
    const row = models[t.model] ||= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
    for (const [field, wire] of Object.entries({ inputTokens: "input_tokens", outputTokens: "output_tokens", cacheReadInputTokens: "cache_read_input_tokens", cacheCreationInputTokens: "cache_creation_input_tokens" })) row[field] += t.usage[wire];
    row.costUSD += t.cost;
  }
  return models;
};
function frames(index, historyStart = 0) {
  const turn = fixture.turns[index];
  const history = fixture.turns.slice(historyStart, index + 1);
  return [
    { type: "assistant", message: { id: `msg-${index}`, model: turn.model, usage: turn.usage, content: [{ type: "text", text: `turn-${index}` }] } },
    { type: "result", subtype: "success", result: `turn-${index}`, session_id: fixture.sessionId,
      usage: turn.usage, total_cost_usd: history.reduce((sum, t) => sum + t.cost, 0), modelUsage: modelUsage(history) },
  ];
}
function account(index, handle, start = 0) {
  const tracker = createClaudeUsage();
  const [assistant, result] = frames(index, start);
  const reported = JSON.stringify(result);
  tracker.observe(assistant);
  const batch = tracker.finish(result, handle, "picker-alias-must-not-relabel-measurements");
  assert.equal(JSON.stringify(result), reported, "raw provider totals must remain unchanged");
  return batch;
}

test("control: completed turn and two warm follow-ups use deltas, retain wire model IDs", () => {
  const handle = {};
  const batches = [0, 1, 2].map(i => account(i, handle));
  close(batches.reduce((sum, b) => sum + b.costUsd, 0), 0.04);
  assert.deepEqual(batches.map(b => b.inputTokens), [10, 4, 2]);
  assert.deepEqual(batches[1].rows.map(r => r.model), ["fixture-model-b"]);
});

test("reproduced: new handle bills restored history, then warm follow-up returns to deltas", () => {
  const first = account(0, {});
  const restarted = {};
  const resumed = account(1, restarted);
  close(resumed.costUsd, 0.03); // should be 0.02 with a proven session baseline
  assert.equal(resumed.inputTokens, 14); // should be 4
  assert.equal(resumed.rows.find(r => r.model === "fixture-model-a").inputTokens, 10);
  const warm = account(2, restarted);
  close(warm.costUsd, 0.01);
  assert.equal(warm.inputTokens, 2);
  close(first.costUsd + resumed.costUsd + warm.costUsd, 0.05); // session reported 0.04
});

test("control: older/reset resume totals must retain process-local semantics", () => {
  const first = account(0, {});
  const restarted = {};
  const resumed = account(1, restarted, 1);
  const warm = account(2, restarted, 1);
  close(first.costUsd + resumed.costUsd + warm.costUsd, 0.04);
  assert.equal(resumed.inputTokens, 4);
  // Blindly restoring the old handle would undercount the reset protocol.
  const oldHandle = {};
  account(0, oldHandle);
  close(account(1, oldHandle, 1).costUsd, 0.01);
});

test("captured control: interrupted 2.1.283 fixture has no prior completed result", () => {
  const load = suffix => fs.readFileSync(path.join(root, `electron/test/fixtures/replay/claude-2.1.283-${suffix}.ndjson`), "utf8").trim().split("\n").map(JSON.parse).map(x => x.emit).filter(Boolean);
  assert.equal(load("restart-before").filter(e => e.type === "result").length, 0);
  const ev = load("restart-resumed").find(e => e.type === "result");
  const batch = createClaudeUsage().finish(ev, {}, null);
  close(batch.costUsd, ev.total_cost_usd);
  assert.equal(batch.rows[0].model, "claude-haiku-4-5-20251001");
  assert.equal(batch.inputTokens, 10);
});

test("real runner + Store reload: synthetic restored session duplicates spend and old-model tokens", async () => {
  const dir = path.join(tmp, "runner"); fs.mkdirSync(dir);
  const script = `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(path.join(dir, "spawns"))}, JSON.stringify({pid:process.pid,argv:process.argv.slice(2)})+'\\n');
let turn = process.argv.includes('--resume') ? 1 : 0;
const turns = ${JSON.stringify([frames(0), frames(1), frames(2)])};
const emit = e => process.stdout.write(JSON.stringify(e)+'\\n');
emit({type:'system',subtype:'init',claude_code_version:'2.1.283',model:'fixture-model-a',session_id:${JSON.stringify(fixture.sessionId)}});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const e = JSON.parse(line); if(e.type !== 'user') return;
  for(const frame of turns[turn++]) emit(frame);
});
setInterval(()=>{},500);
`;
  process.env.CODER_CLAUDE_BIN = writeFakeBin(path.join(dir, "fake-claude"), script);
  const core = await import(pathToFileURL(path.join(root, "core/dist/index.js")).href);
  const file = path.join(dir, "store.json");
  let store = new Store(file);
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, { projectId: project.id, title: "synthetic resume", provider: "claude" });
  const makeRunner = () => createRunner({ store, core, pushFn() {}, tickMs: 15, userDataPath: dir });
  let runner = makeRunner();
  async function send(prompt) {
    const before = store.getUsage(thread.id)?.turns || 0;
    await runner.startRun({ threadId: thread.id, prompt });
    await waitFor(() => store.getThread(thread.id).status === "done" && store.getUsage(thread.id)?.turns > before);
  }
  try {
    await send("one");
    close(store.getUsage(thread.id).costUsd, 0.01);
    runner.stopAll();
    const firstPid = JSON.parse(fs.readFileSync(path.join(dir, "spawns"), "utf8").trim()).pid;
    await waitFor(() => { try { process.kill(firstPid, 0); return false; } catch { return true; } });
    await store.flushPending(); store.saveNow();
    store = new Store(file);
    assert.equal(store.getThread(thread.id).sessionId, fixture.sessionId);
    close(store.getUsage(thread.id).costUsd, 0.01);
    runner = makeRunner();
    await send("two");
    close(store.getUsage(thread.id).costUsd, 0.04); // should be 0.03
    assert.equal(store.getUsage(thread.id).inputTokens, 24); // should be 14
    await send("three");
    close(store.getUsage(thread.id).costUsd, 0.05); // should be 0.04
    close(store.getSpendToday(), 0.05);
    const cells = store.getUsageByDay()[localDayKey(new Date())].claude;
    assert.equal(cells["fixture-model-a"].inputTokens, 20, "restored old-model tokens were recorded twice");
    close(cells["fixture-model-a"].costUsd, 0.02);
    assert.equal(cells["fixture-model-b"].inputTokens, 6);
    close(cells["fixture-model-b"].costUsd, 0.03);
    const spawns = fs.readFileSync(path.join(dir, "spawns"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(spawns.length, 2, "the follow-up uses the second warm process");
    assert.notEqual(spawns[0].pid, spawns[1].pid);
    assert.ok(spawns[1].argv.includes("--resume"));
    assert.ok(spawns[1].argv.includes(fixture.sessionId));
    console.log(JSON.stringify({ evidence: "synthetic runner reproduction", costUsd: store.getUsage(thread.id).costUsd, spendToday: store.getSpendToday(), inputTokens: store.getUsage(thread.id).inputTokens, processCount: spawns.length }));
  } finally {
    runner.stopAll();
    await store.flushPending();
  }
});
