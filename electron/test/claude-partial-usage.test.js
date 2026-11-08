"use strict";
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
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

const measured = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 3, reasoning_tokens: 2 };
function assistant(id, usage = measured, model = "executor", extra = {}) {
  return { type: "assistant", message: { id, model, usage, content: [{ type: "text", text: id }] }, ...extra };
}
function result(usage, cost, modelUsage) {
  return { type: "result", subtype: "success", result: "ok", usage, total_cost_usd: cost, ...(modelUsage ? { modelUsage } : {}) };
}

describe("Claude partial and attributed usage (#1945)", () => {
  let dir, store, runner, thread, saved;
  beforeEach(async () => {
    saved = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith("CODER_")) delete process.env[key];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-claude-usage-"));
    const bin = path.join(dir, "bin"); fs.mkdirSync(bin); fs.symlinkSync(process.execPath, path.join(bin, "node"));
    Object.assign(process.env, { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, CODER_SEATBELT: "off", CODER_GROK_MCP_DISABLE: "1", CODER_CURSOR_MCP_DISABLE: "1", CODER_KIMI_MCP_PATH: path.join(dir, "mcp.json") });
    store = new Store(path.join(dir, "store.json"));
    const repo = path.join(dir, "repo"); fs.mkdirSync(repo); execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    thread = services.createThread(store, { projectId: project.id, title: "usage", provider: "claude" });
  });
  afterEach(async () => {
    runner?.stopAll();
    await rmTree(dir);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  async function start(turns) {
    process.env.CODER_CLAUDE_BIN = writeFakeBin(path.join(dir, "fake-claude"), `#!/usr/bin/env node
const turns = ${JSON.stringify(turns)}; let n=0, buf="";
const emit = x => process.stdout.write(JSON.stringify(x)+"\\n");
emit({type:"system",subtype:"init",model:"executor",session_id:"fixture"});
process.stdin.on("data", chunk => { buf+=chunk; let i; while((i=buf.indexOf("\\n"))>=0) { const line=buf.slice(0,i); buf=buf.slice(i+1); let x; try{x=JSON.parse(line)}catch{continue}; if(x.type!=="user")continue; const turn=turns[n++]; if(!turn)continue; for(const ev of turn.frames)emit(ev); if(turn.exit)setTimeout(()=>process.exit(1),30); }});
setInterval(()=>{},500);
`);
    const core = await import("../../core/dist/index.js");
    runner = createRunner({ store, core, userDataPath: dir, pushFn() {}, tickMs: 15 });
    await runner.startRun({ threadId: thread.id, prompt: "first" });
  }
  function cells() { return store.getUsageByDay()[localDayKey(new Date())]?.claude; }
  async function finished() { await waitFor(() => ["done", "failed"].includes(store.getThread(thread.id).status)); }

  it("retains measured segments on exit without a result, with unknown cost explicit", async () => {
    await start([{ frames: [assistant("a"), assistant("a", { output_tokens: 7 }), assistant("b", { input_tokens: 4, output_tokens: 1 }, null)], exit: true }]);
    await finished();
    assert.equal(store.getUsage(thread.id)?.inputTokens, 14);
    assert.equal(store.getUsage(thread.id).outputTokens, 8);
    assert.equal(cells().executor.cachedInputTokens, 20);
    assert.equal(cells().executor.cacheWriteTokens, 3);
    assert.equal(cells().unknown.inputTokens, 4, "unknown observed model must not become executor");
    assert.equal(store.getUsage(thread.id).accounting.status, "partial");
    assert.ok(store.getUsage(thread.id).accounting.unavailableFields.includes("costUsd"));
    assert.equal(store.getUsage(thread.id).accounting.sources[0].reasoningTokens, 2);
    store.saveNow();
    assert.deepEqual(new Store(path.join(dir, "store.json")).getUsage(thread.id), store.getUsage(thread.id));
  });

  it("flushes ordinary Stop once before terminal accounting", async () => {
    await start([{ frames: [assistant("a")] }]);
    await waitFor(() => store.getMessages(thread.id).some(m => m.role === "assistant"));
    await runner.stopRun({ threadId: thread.id });
    await runner.stopRun({ threadId: thread.id });
    assert.equal(store.getUsage(thread.id)?.inputTokens, 10);
    assert.equal(cells().executor.inputTokens, 10);
    assert.equal(store.getUsage(thread.id).turns, 1);
  });

  it("flushes measured usage on app quit and persists it once", async () => {
    await start([{ frames: [assistant("a")] }]);
    await waitFor(() => store.getMessages(thread.id).some(m => m.role === "assistant"));
    runner.stopAll();
    runner.stopAll();
    store.saveNow();
    assert.equal(new Store(path.join(dir, "store.json")).getUsage(thread.id)?.inputTokens, 10);
    assert.equal(store.getUsageThreadsByDay()[localDayKey(new Date())][thread.id].turns, 1);
  });

  it("retains earlier segments when a steer exits without its result", async () => {
    await start([{ frames: [assistant("a")] }, { frames: [assistant("b", { input_tokens: 4, output_tokens: 1 })], exit: true }]);
    await waitFor(() => store.getMessages(thread.id).some(m => m.role === "assistant"));
    await runner.steerRun({ threadId: thread.id, prompt: "steer" });
    await finished();
    assert.equal(store.getUsage(thread.id)?.inputTokens, 14);
  });

  it("uses process model totals without a model switch and preserves authoritative dollars", async () => {
    const mu = { executor: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 20, cacheCreationInputTokens: 3, costUSD: 0.01 }, advisor: { inputTokens: 4, outputTokens: 2, costUSD: 0.02 } };
    await start([{ frames: [assistant("a", { ...measured, iterations: [{ type: "advisor_message", model: "advisor", input_tokens: 4, output_tokens: 2 }] }), result({ input_tokens: 14, output_tokens: 7 }, 0.03, mu)] }]);
    await finished();
    assert.equal(cells().executor.inputTokens, 10);
    assert.equal(cells().advisor.inputTokens, 4);
    assert.equal(cells().advisor.costUsd, 0.02);
    assert.equal(store.getUsage(thread.id).costUsd, 0.03);
    assert.equal(Object.values(cells()).reduce((n, c) => n + c.costUsd, 0), 0.03);
  });

  it("deduplicates advisor iterations and child messages without a process model summary", async () => {
    const a = assistant("a", { ...measured, iterations: [{ type: "advisor_message", model: "advisor", input_tokens: 4, output_tokens: 2 }] });
    await start([{ frames: [a, a, assistant("child", { input_tokens: 2, output_tokens: 1 }, "child-model", { parent_tool_use_id: "task-1" })], exit: true }]);
    await finished();
    assert.equal(cells().executor.inputTokens, 10);
    assert.equal(cells().advisor.inputTokens, 4);
    assert.equal(cells()["child-model"].inputTokens, 2);
    assert.equal(store.getUsage(thread.id).accounting.sources.find(s => s.model === "child-model").parentToolUseId, "task-1");
  });

  it("never estimates model dollars on top of an authoritative process total", async () => {
    const a = assistant("a", { ...measured, iterations: [{ type: "advisor_message", model: "advisor", input_tokens: 4, output_tokens: 2 }] });
    await start([{ frames: [a, result({ input_tokens: 14, output_tokens: 7 }, 0.03)] }]);
    await finished();
    store.saveNow();
    const reloaded = new Store(path.join(dir, "store.json"));
    const { applyModelPrices } = require("../modelPrices.js");
    const report = applyModelPrices({ byDay: reloaded.getUsageByDay(), threadsByDay: reloaded.getUsageThreadsByDay() }, {
      executor: { input: 1000, output: 1000 }, advisor: { input: 1000, output: 1000 },
    });
    const day = localDayKey(new Date());
    assert.equal(report.threadsByDay[day][thread.id].costUsd, 0.03);
    assert.equal(Object.values(report.byDay[day].claude).reduce((sum, row) => sum + row.costUsd, 0), 0.03);
  });

  it("counts successful multi-segment messages once and differences warm model totals", async () => {
    const mu = n => ({ executor: { inputTokens: 14*n, outputTokens: 6*n, costUSD: 0.03*n } });
    const frames = n => [assistant(`a${n}`), assistant(`b${n}`, { input_tokens: 4, output_tokens: 1 }), result({ input_tokens: 14, output_tokens: 6 }, 0.03*n, mu(n))];
    await start([{ frames: frames(1) }, { frames: frames(2) }]);
    await finished();
    await runner.startRun({ threadId: thread.id, prompt: "second" });
    await waitFor(() => store.getUsage(thread.id)?.turns === 2);
    assert.equal(store.getUsage(thread.id).inputTokens, 28);
    assert.equal(cells().executor.inputTokens, 28);
    assert.equal(cells().executor.costUsd, 0.06);
    assert.equal(store.getUsage(thread.id).costUsd, 0.06);
  });
});
