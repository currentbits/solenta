"use strict";

// Characterization audit of main@24119d5f, not a regression contract for the gap.
// Run: node docs/audits/claude-idle-child-accounting.cjs
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

// Re-exec before importing app modules: no inherited credentials, CLI overrides,
// live settings, proxy agents, NODE_OPTIONS, or provider binaries reach the run.
if (process.env.SOLENTA_USAGE_AUDIT_ISOLATED !== "1") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-idle-audit-home-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  try {
    const result = spawnSync(process.execPath, ["--test", __filename], {
      stdio: "inherit",
      env: {
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
        TMPDIR: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        SOLENTA_USAGE_AUDIT_ISOLATED: "1", CODER_SEATBELT: "off",
        CODER_GROK_MCP_DISABLE: "1", CODER_CURSOR_MCP_DISABLE: "1",
        CODER_KIMI_MCP_PATH: path.join(home, "kimi.json"),
      },
    });
    process.exitCode = result.status ?? 1;
    if (result.error) throw result.error;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
} else {
  const { describe, it, beforeEach, afterEach } = require("node:test");
  const assert = require("node:assert/strict");
  const { Store, localDayKey } = require("../../electron/store.js");
  const services = require("../../electron/services.js");
  const { createRunner } = require("../../electron/runner.js");
  const { createClaudeUsage } = require("../../electron/claude-usage.js");
  const { writeFakeBin } = require("../../electron/test/support/fakeBin.js");
  const { waitFor } = require("../../electron/test/support/replay.js");
  const { rmTree } = require("../../electron/test/support/rmTree.js");

  const rootModel = "fixture-root";
  const childModel = "fixture-child";
  const task = "background-task";
  const usage = (input_tokens, output_tokens, cache_read_input_tokens = 0, cache_creation_input_tokens = 0) =>
    ({ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens });
  const rootOne = usage(10, 2);
  const rootTwo = usage(4, 1);
  const childUsage = usage(7, 3, 11, 2);
  const assistant = (id, model, measured, parent = null, content = [{ type: "text", text: id }]) =>
    ({ type: "assistant", parent_tool_use_id: parent, message: { id, model, usage: measured, content } });
  const summary = (u, costUSD) => ({ inputTokens: u.input_tokens, outputTokens: u.output_tokens,
    cacheReadInputTokens: u.cache_read_input_tokens, cacheCreationInputTokens: u.cache_creation_input_tokens, costUSD });
  const result = (u, total_cost_usd, modelUsage) => ({ type: "result", subtype: "success", result: "ok",
    usage: u, total_cost_usd, ...(modelUsage ? { modelUsage } : {}) });
  const childFrames = (model = childModel) => [
    { type: "stream_event", parent_tool_use_id: task, event: { type: "message_start",
      message: { id: "child-message", model, usage: { ...childUsage, output_tokens: 0 } } } },
    { type: "stream_event", parent_tool_use_id: task, event: { type: "message_delta", usage: { output_tokens: 3 } } },
    assistant("child-message", model, childUsage, task, [{ type: "tool_use", id: "read-child", name: "Read", input: { file_path: "fixture.txt" } }]),
    assistant("child-message", model, { output_tokens: 1 }, task),
  ];

  describe("Claude idle background-child characterization (#1959)", { concurrency: false }, () => {
    let dir, store, runner, thread, command, sequence;
    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-child-"));
      sequence = 0;
      command = path.join(dir, "command.json");
      const repo = path.join(dir, "repo");
      fs.mkdirSync(repo);
      execFileSync("git", ["init", "-q"], { cwd: repo });
      store = new Store(path.join(dir, "store.json"));
      const project = await services.addProject(store, repo);
      thread = services.createThread(store, { projectId: project.id, title: "idle fixture", provider: "claude" });
    });
    afterEach(async () => {
      runner?.stopAll();
      runner = null;
      await rmTree(dir);
    });

    async function boot(warmResult = result(rootTwo, 0.03), { activeChild = false, lateOnStop = false } = {}) {
      const launch = assistant("root-one", rootModel, rootOne, null, [
        { type: "tool_use", id: task, name: "Agent", input: { description: "fixture child", run_in_background: true } },
      ]);
      const first = [launch, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: task, content: "Async agent launched" }] } },
        ...(activeChild ? childFrames() : []), result(rootOne, 0.01, { [rootModel]: summary(rootOne, 0.01) })];
      process.env.CODER_CLAUDE_BIN = writeFakeBin(path.join(dir, "fake-claude"), `#!/usr/bin/env node
const fs = require("node:fs");
const command = ${JSON.stringify(command)};
const first = ${JSON.stringify(first)};
const warm = ${JSON.stringify([assistant("root-two", rootModel, rootTwo), warmResult].filter(Boolean))};
const emit = x => process.stdout.write(JSON.stringify(x)+"\\n");
let buffer="", turn=0, seq=0;
fs.appendFileSync(${JSON.stringify(path.join(dir, "spawns"))}, process.pid+"\\n");
emit({type:"system",subtype:"init",model:${JSON.stringify(rootModel)},session_id:"fixture-session"});
process.stdin.on("data", c => { buffer+=c; let i; while((i=buffer.indexOf("\\n"))>=0) {
  const line=buffer.slice(0,i); buffer=buffer.slice(i+1); let x; try{x=JSON.parse(line)}catch{continue};
  if(x.type==="control_response") fs.appendFileSync(${JSON.stringify(path.join(dir, "responses"))}, JSON.stringify(x)+"\\n");
  if(x.type!=="user")continue;
  for(const ev of turn++===0 ? first : warm) emit(ev);
}});
setInterval(() => {
  let x; try{x=JSON.parse(fs.readFileSync(command,"utf8"))}catch{return};
  if(x.seq<=seq)return; seq=x.seq;
  for(const ev of x.frames)emit(ev);
  emit({type:"system",subtype:"task_progress",tool_use_id:${JSON.stringify(task)},summary:"barrier-"+seq});
}, 10);
${lateOnStop ? `process.on("SIGTERM", () => { for(const ev of ${JSON.stringify([
        assistant("late-after-stop", childModel, usage(999, 999), task), result(usage(999, 999), 9),
      ])})emit(ev); process.stdout.write("",()=>{fs.writeFileSync(${JSON.stringify(path.join(dir, "late-sent"))},"done");setTimeout(()=>process.exit(0),50);}); });` : ""}
`);
      const core = await import("../../core/dist/index.js");
      runner = createRunner({ store, core, userDataPath: dir, pushFn() {}, tickMs: 15 });
      await runner.startRun({ threadId: thread.id, prompt: "first" });
      await waitFor(() => store.getThread(thread.id).status === "done");
      assert.equal(runner.isRunning(thread.id), false);
      assert.equal(store.getThread(thread.id).subagents.find(r => r.id === task).status, "running");
    }
    async function idle(frames = childFrames()) {
      assert.equal(runner.isRunning(thread.id), false);
      const seq = ++sequence;
      fs.writeFileSync(command + ".tmp", JSON.stringify({ seq, frames }));
      fs.renameSync(command + ".tmp", command);
      await waitFor(() => store.getThread(thread.id).subagents.find(r => r.id === task)?.activity?.text === `barrier-${seq}`);
    }
    async function warm() {
      await runner.startRun({ threadId: thread.id, prompt: "warm" });
      await waitFor(() => store.getUsage(thread.id)?.turns === 2);
      assert.equal(fs.readFileSync(path.join(dir, "spawns"), "utf8").trim().split("\n").length, 1, "must reuse one warm process");
    }
    const cells = () => store.getUsageByDay()[localDayKey(new Date())]?.claude;
    const near = (a, b) => assert.ok(Math.abs(a-b) < 1e-9, `${a} != ${b}`);
    function noChildSource() {
      assert.ok(!store.getUsage(thread.id).accounting.sources.some(s => s.parentToolUseId === task));
    }

    it("the existing observer accepts and deduplicates these child frames during an active query", async () => {
      await boot(undefined, { activeChild: true });
      assert.equal(cells()[childModel].inputTokens, 7);
      assert.equal(cells()[childModel].outputTokens, 3);
      assert.equal(cells()[childModel].cachedInputTokens, 11);
      assert.equal(store.getUsage(thread.id).accounting.sources.find(s => s.model === childModel).parentToolUseId, task);
    });

    it("idle child frames update progress but not accounting, including after quit/reload", async () => {
      await boot();
      const before = structuredClone(store.getUsage(thread.id));
      const messages = structuredClone(store.getMessages(thread.id));
      await idle();
      assert.deepEqual(store.getUsage(thread.id), before);
      assert.deepEqual(store.getMessages(thread.id), messages);
      assert.equal(cells()[childModel], undefined);
      assert.equal(store.getThread(thread.id).status, "done");
      assert.equal(runner.isRunning(thread.id), false);
      runner.stopAll();
      store.saveNow();
      assert.deepEqual(new Store(path.join(dir, "store.json")).getUsage(thread.id), before);
    });

    it("a warm native USD total recovers dollars without recovering omitted child tokens", async () => {
      await boot(result(rootTwo, 0.03));
      await idle();
      await warm();
      near(store.getUsage(thread.id).costUsd, 0.03);
      near(store.getSpendToday(), 0.03);
      assert.equal(store.getUsage(thread.id).inputTokens, 14);
      assert.equal(cells()[childModel], undefined);
      noChildSource();
    });

    it("an idle native result is ignored, then a later warm cumulative result recovers it", async () => {
      await boot(result(rootTwo, 0.03, {
        [rootModel]: summary(usage(14, 3), 0.02), [childModel]: summary(childUsage, 0.01),
      }));
      await idle([...childFrames(), result(childUsage, 0.02, {
        [rootModel]: summary(rootOne, 0.01), [childModel]: summary(childUsage, 0.01),
      })]);
      near(store.getUsage(thread.id).costUsd, 0.01);
      assert.equal(store.getThread(thread.id).status, "done");
      await warm();
      near(store.getUsage(thread.id).costUsd, 0.03);
      assert.equal(store.getUsage(thread.id).inputTokens, 21);
      noChildSource();
    });

    for (const sameModel of [false, true]) {
      it(`full cumulative modelUsage recovers totals, but loses child identity (${sameModel ? "same" : "distinct"} model)`, async () => {
        const combined = usage(21, 6, 11, 2);
        const modelUsage = sameModel
          ? { [rootModel]: summary(combined, 0.03) }
          : { [rootModel]: summary(usage(14, 3), 0.02), [childModel]: summary(childUsage, 0.01) };
        await boot(result(rootTwo, 0.03, modelUsage));
        await idle(childFrames(sameModel ? rootModel : childModel));
        await warm();
        assert.equal(store.getUsage(thread.id).inputTokens, 21);
        assert.equal(store.getUsage(thread.id).outputTokens, 6);
        assert.equal(store.getUsage(thread.id).cachedInputTokens, 11);
        assert.equal(store.getUsage(thread.id).cacheWriteTokens, 2);
        near(store.getUsage(thread.id).costUsd, 0.03);
        noChildSource();
        if (!sameModel) assert.equal(cells()[childModel].inputTokens, 7);
        store.saveNow();
        assert.deepEqual(new Store(path.join(dir, "store.json")).getUsage(thread.id), store.getUsage(thread.id));
      });
    }

    it("replaying an ignored idle child during the next query can recover its source once", async () => {
      await boot(null);
      await idle();
      await runner.startRun({ threadId: thread.id, prompt: "warm" });
      await waitFor(() => runner.isRunning(thread.id));
      const seq = ++sequence;
      fs.writeFileSync(command, JSON.stringify({ seq, frames: [...childFrames(), ...childFrames(), result(rootTwo, 0.03)] }));
      await waitFor(() => store.getUsage(thread.id)?.turns === 2);
      assert.equal(store.getUsage(thread.id).inputTokens, 21);
      assert.equal(cells()[childModel].inputTokens, 7);
      assert.equal(store.getUsage(thread.id).accounting.sources.filter(s => s.parentToolUseId === task).length, 1);
    });

    it("idle control requests keep the existing error response and do not open permission/question cards", async () => {
      await boot();
      const messages = structuredClone(store.getMessages(thread.id));
      await idle([{ type: "control_request", request_id: "idle-permission", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "fixture" } } }]);
      await waitFor(() => fs.existsSync(path.join(dir, "responses")));
      const response = JSON.parse(fs.readFileSync(path.join(dir, "responses"), "utf8").trim());
      assert.match(JSON.stringify(response), /No active turn in Solenta/);
      assert.equal(runner.getPendingPermission(thread.id), null);
      assert.deepEqual(store.getMessages(thread.id), messages);
      assert.equal(store.getThread(thread.id).awaitingInput, false);
    });

    it("late child/result frames after Stop cannot charge a stopped run", async () => {
      await boot(null, { lateOnStop: true });
      await idle();
      await runner.startRun({ threadId: thread.id, prompt: "warm" });
      await waitFor(() => store.getMessages(thread.id).some(m => m.text === "root-two"));
      await runner.stopRun({ threadId: thread.id });
      const before = structuredClone(store.getUsage(thread.id));
      await waitFor(() => fs.existsSync(path.join(dir, "late-sent")));
      // The SIGTERM handler flushes stdout before it exits; wait for the real
      // child's exit too, so both queued frames have crossed the runner.
      const pid = Number(fs.readFileSync(path.join(dir, "spawns"), "utf8").trim());
      await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
      assert.deepEqual(store.getUsage(thread.id), before);
      assert.equal(before.inputTokens, 14);
      assert.equal(cells()[childModel], undefined);
      assert.equal(runner.isRunning(thread.id), false);
    });

    it("late frames from a replaced idle process cannot charge its replacement", async () => {
      await boot(undefined, { lateOnStop: true });
      await idle();
      const pid = Number(fs.readFileSync(path.join(dir, "spawns"), "utf8").trim());
      store.updateThread(thread.id, { model: "fixture-new-model" });
      await runner.startRun({ threadId: thread.id, prompt: "replace" });
      await waitFor(() => store.getUsage(thread.id)?.turns === 2);
      await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
      assert.equal(store.getUsage(thread.id).inputTokens, 20);
      near(store.getUsage(thread.id).costUsd, 0.02);
      assert.equal(cells()[childModel], undefined);
      assert.equal(store.getThread(thread.id).status, "done");
      assert.equal(fs.readFileSync(path.join(dir, "spawns"), "utf8").trim().split("\n").length, 2);
    });
  });

  it("the committed captured 2.1.283 steer results use cumulative model/USD summaries", () => {
    const file = path.join(__dirname, "../../electron/test/fixtures/replay/claude-2.1.283-steer.ndjson");
    const frames = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line).emit).filter(Boolean);
    assert.equal(frames.filter(ev => ev.parent_tool_use_id).length, 0, "this capture does not prove idle-child emission");
    const handle = {};
    let tracker = createClaudeUsage();
    const batches = [];
    for (const ev of frames) {
      tracker.observe(ev, ev.type === "stream_event" ? ev.event : null);
      if (ev.type === "result") {
        batches.push(tracker.finish(ev, handle, null));
        tracker = createClaudeUsage();
      }
    }
    assert.equal(batches.length, 2);
    const last = frames.filter(ev => ev.type === "result").at(-1);
    assert.ok(Math.abs(batches.reduce((sum, b) => sum + b.costUsd, 0) - last.total_cost_usd) < 1e-9);
    assert.equal(batches.reduce((sum, b) => sum + b.inputTokens, 0), 20);
    assert.equal(batches.reduce((sum, b) => sum + b.outputTokens, 0), 2025);
  });

  it("moving observe before guard alone duplicates replayed snapshots across finish boundaries", () => {
    const tracker = createClaudeUsage();
    const handle = {};
    const frame = assistant("same-child", childModel, childUsage, task);
    tracker.observe(frame);
    const first = tracker.finish(null, handle, rootModel);
    tracker.observe(frame);
    const replay = tracker.finish(null, handle, rootModel);
    assert.equal(first.inputTokens + replay.inputTokens, 14, "one 7-token message becomes 14 without a session dedup watermark");
  });
}
