"use strict";

/**
 * #1716: plan on a separate model, implement on the thread's model in the
 * same session. Turn model selection, the switch on plan approval and on a
 * manual mode change, unsupported providers, profile validation, and usage
 * attributed to the model actually used.
 *
 * Run: node --test electron/test/plan-model.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const {
  getProvider,
  turnModelFor,
  planActSwitchNote,
  listProviders,
} = require("../providers.js");
const { validateAgentProfiles, normalizeSettings } = require("../store-normalize.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

const PLAN = "claude-opus-5-5";
const ACT = "claude-sonnet-5-5";

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/**
 * Kept-alive fake claude. Logs argv per spawn and every stdin line. In plan
 * mode it asks ExitPlanMode; once answered, its result reports the two
 * models a mid-turn set_model would leave in modelUsage.
 */
function writeFakeClaude(dir) {
  return writeFakeBin(
    path.join(dir, "fake-claude"),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log((process.env.FAKE_VERSION || "2.1.283") + " (Claude Code)");
  process.exit(0);
}
fs.appendFileSync(process.env.FAKE_ARGS, JSON.stringify(argv) + "\\n");
const model = argv[argv.indexOf("--model") + 1];
const plan = argv[argv.indexOf("--permission-mode") + 1] === "plan";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: "sess-pm", model });
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    fs.appendFileSync(process.env.FAKE_STDIN, line + "\\n");
    const msg = JSON.parse(line);
    if (msg.type === "user" && plan && process.env.FAKE_ASK_PLAN === "1") {
      emit({
        type: "control_request",
        request_id: "req-plan",
        request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "1. do it" } },
      });
      continue;
    }
    if (msg.type === "control_response") {
      emit({
        type: "result", subtype: "success", result: "done",
        usage: { input_tokens: 30, output_tokens: 7 },
        total_cost_usd: 0.07, session_id: "sess-pm",
        modelUsage: {
          "${PLAN}": { inputTokens: 10, outputTokens: 2, costUSD: 0.02 },
          "${ACT}": { inputTokens: 20, outputTokens: 5, costUSD: 0.05 },
        },
      });
      continue;
    }
    if (msg.type !== "user") continue;
    emit({ type: "assistant", message: { model, content: [{ type: "text", text: "ok" }] } });
    emit({
      type: "result", subtype: "success", result: "ok",
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0.01, session_id: "sess-pm",
      modelUsage: { [model]: { inputTokens: 1, outputTokens: 1, costUSD: 0.01 } },
    });
  }
});
setInterval(() => {}, 500);
`,
  );
}

describe("turn model selection (#1716)", () => {
  const thread = {
    permissionMode: "plan",
    model: ACT,
    reasoningEffort: "medium",
    planModel: PLAN,
    planReasoningEffort: "high",
  };

  it("plans on the plan model and acts on the thread model for claude and codex", () => {
    for (const id of ["claude", "codex"]) {
      const entry = getProvider(id);
      assert.deepEqual(turnModelFor(entry, thread), { model: PLAN, reasoningEffort: "high" });
      assert.deepEqual(
        turnModelFor(entry, { ...thread, permissionMode: "default" }),
        { model: ACT, reasoningEffort: "medium" },
      );
    }
    // No plan effort keeps the act effort.
    assert.deepEqual(
      turnModelFor(getProvider("claude"), { ...thread, planReasoningEffort: null }),
      { model: PLAN, reasoningEffort: "medium" },
    );
  });

  it("never switches models on providers that cannot resume across them", () => {
    for (const id of ["grok", "cursor", "opencode", "kimi"]) {
      const entry = getProvider(id);
      assert.deepEqual(turnModelFor(entry, thread), { model: ACT, reasoningEffort: "medium" });
      assert.equal(planActSwitchNote(entry, thread), null);
    }
  });

  it("only advertises supportsPlanModel for claude and codex", () => {
    const ids = listProviders({ which: () => null })
      .filter((p) => p.supportsPlanModel)
      .map((p) => p.id);
    assert.deepEqual(ids.sort(), ["claude", "codex"]);
  });

  it("names the act model in the switch note", () => {
    assert.equal(
      planActSwitchNote(getProvider("claude"), thread),
      "Switched to Sonnet 5.5 for implementation",
    );
    assert.equal(
      planActSwitchNote(getProvider("claude"), { ...thread, model: null }),
      "Switched to the default model for implementation",
    );
    assert.equal(planActSwitchNote(getProvider("claude"), { ...thread, planModel: ACT }), null);
  });
});

describe("agent profile plan model (#1716)", () => {
  const base = {
    id: "p1",
    name: "Planner",
    provider: "claude",
    model: ACT,
    reasoningEffort: null,
    permissionMode: "plan",
  };

  it("keeps a valid plan model and effort, and leaves absent fields absent", () => {
    assert.deepEqual(validateAgentProfiles([base]), [base]);
    const [p] = validateAgentProfiles([
      { ...base, planModel: ` ${PLAN} `, planReasoningEffort: "high" },
    ]);
    assert.equal(p.planModel, PLAN);
    assert.equal(p.planReasoningEffort, "high");
  });

  it("rejects a plan model on an unsupported provider and a bad plan effort", () => {
    assert.throws(
      () => validateAgentProfiles([{ ...base, provider: "grok", model: null, planModel: "grok-4.7" }]),
      /planModel is not supported by Grok/i,
    );
    assert.throws(
      () => validateAgentProfiles([{ ...base, planModel: PLAN, planReasoningEffort: "bogus" }]),
      /planReasoningEffort/,
    );
    assert.throws(() => validateAgentProfiles([{ ...base, planModel: 7 }]), /planModel/);
    // Disk reads drop the bad row instead of throwing.
    assert.deepEqual(
      normalizeSettings({ agentProfiles: [base, { ...base, id: "p2", provider: "grok", planModel: "x" }] })
        .agentProfiles,
      [base],
    );
  });
});

describe("plan model on threads (#1716)", () => {
  let tmpDir;
  let store;
  let runner;
  let project;
  const saved = {};
  const ENV = ["CODER_SIMULATE", "CODER_AGENT_CMD", "CODER_CLAUDE_BIN", "FAKE_ARGS", "FAKE_STDIN", "FAKE_ASK_PLAN", "FAKE_VERSION"];

  beforeEach(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.FAKE_ASK_PLAN;
    delete process.env.FAKE_VERSION;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-plan-model-"));
    process.env.CODER_CLAUDE_BIN = writeFakeClaude(tmpDir);
    process.env.FAKE_ARGS = path.join(tmpDir, "args");
    process.env.FAKE_STDIN = path.join(tmpDir, "stdin");
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    runner = null;
    await rmTree(tmpDir);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function startRunner() {
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({ store, core, pushFn() {}, tickMs: 15, userDataPath: tmpDir });
  }

  function planThread(provider = "claude") {
    const t = services.createThread(store, { projectId: project.id, title: "t", provider });
    store.updateThread(t.id, { model: ACT, permissionMode: "plan" });
    services.setPlanModel(store, { threadId: t.id, model: PLAN, effort: "high" });
    store.saveNow();
    return t.id;
  }

  const spawns = () =>
    fs.readFileSync(process.env.FAKE_ARGS, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const flag = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const events = (id) => store.getMessages(id).filter((m) => m.role === "event").map((m) => m.text);

  it("validates setPlanModel and clears it on a provider switch", () => {
    const id = planThread();
    assert.equal(store.getThread(id).planModel, PLAN);
    assert.equal(store.getThread(id).planReasoningEffort, "high");
    assert.throws(
      () => services.setPlanModel(store, { threadId: id, model: PLAN, effort: "bogus" }),
      /reasoning effort/,
    );
    services.setPlanModel(store, { threadId: id, model: null });
    assert.equal(store.getThread(id).planModel, null);
    assert.equal(store.getThread(id).planReasoningEffort, null);

    services.setPlanModel(store, { threadId: id, model: PLAN });
    services.setProvider(store, { threadId: id, provider: "grok" });
    assert.equal(store.getThread(id).planModel, null);
    const grok = services.createThread(store, { projectId: project.id, title: "g", provider: "grok" });
    assert.throws(
      () => services.setPlanModel(store, { threadId: grok.id, model: "grok-4.7" }),
      /cannot plan on a separate model/,
    );
  });

  it("applies a profile's plan model and clears it for a profile without one", () => {
    const t = services.createThread(store, { projectId: project.id, title: "t" });
    const profile = {
      id: "p1", name: "Planner", provider: "claude", model: ACT,
      reasoningEffort: null, permissionMode: "plan", planModel: PLAN, planReasoningEffort: "high",
    };
    store.setSettings({ ...store.getSettings(), agentProfiles: [profile, { ...profile, id: "p2", planModel: undefined, planReasoningEffort: undefined }] });
    services.applyAgentProfile(store, { threadId: t.id, profileId: "p1" });
    assert.equal(store.getThread(t.id).planModel, PLAN);
    assert.equal(store.getThread(t.id).planReasoningEffort, "high");
    services.applyAgentProfile(store, { threadId: t.id, profileId: "p2" });
    assert.equal(store.getThread(t.id).planModel, null);
  });

  it("runs plan turns on the plan model and resumes the same session on the act model after a mode switch", async () => {
    await startRunner();
    const id = planThread();

    await runner.startRun({ threadId: id, prompt: "plan it" });
    await waitFor(() => store.getThread(id).status === "done" && store.getUsage(id)?.turns === 1);
    assert.equal(flag(spawns()[0], "--model"), PLAN);
    assert.equal(flag(spawns()[0], "--effort"), "high");
    assert.equal(store.getUsage(id).model, PLAN);

    services.setPermissionMode(store, { threadId: id, mode: "default" });
    assert.ok(!events(id).includes("Switched to Sonnet 5.5 for implementation"),
      "a mode picker change has not dispatched the implementation model yet");

    await runner.startRun({ threadId: id, prompt: "go" });
    await waitFor(() => store.getThread(id).status === "done" && store.getUsage(id)?.turns === 2);
    const second = spawns()[1];
    assert.ok(second, "a model change respawns the CLI");
    assert.equal(flag(second, "--model"), ACT);
    assert.equal(flag(second, "--resume"), "sess-pm", "same session, no fork");
    assert.equal(flag(second, "--effort"), null, "act effort is the thread's (none)");
    assert.equal(store.getUsage(id).model, ACT);
    assert.deepEqual(store.getMessages(id).filter((m) => m.role === "event" && m.runConfiguration)
      .map((m) => m.runConfiguration), [
        { provider: "claude", model: PLAN, reasoningEffort: "high" },
        { provider: "claude", model: ACT, reasoningEffort: null },
      ]);
    assert.equal(store.getThreads().length, 1, "no new thread");
  });

  it("records the launched Ultracode effort and its change back to ordinary effort", async () => {
    await startRunner();
    const t = services.createThread(store, { projectId: project.id, title: "ultracode", provider: "claude" });
    store.updateThread(t.id, { model: PLAN, reasoningEffort: "low" });
    services.setUltracode(store, { threadId: t.id, ultracode: true });
    await runner.startRun({ threadId: t.id, prompt: "first" });
    await waitFor(() => store.getThread(t.id).status === "done");
    assert.equal(flag(spawns()[0], "--model"), PLAN);
    assert.equal(flag(spawns()[0], "--effort"), "xhigh");
    assert.equal(store.getThread(t.id).reasoningEffort, "low", "ordinary picker preference remains independent");

    services.setUltracode(store, { threadId: t.id, ultracode: false });
    await runner.startRun({ threadId: t.id, prompt: "second" });
    await waitFor(() => store.getThread(t.id).status === "done" && store.getUsage(t.id)?.turns === 2);
    assert.equal(flag(spawns()[1], "--model"), PLAN);
    assert.equal(flag(spawns()[1], "--effort"), "low");
    const configurations = store.getMessages(t.id).filter((m) => m.role === "event" && m.runConfiguration);
    assert.deepEqual(configurations.map((m) => m.runConfiguration), [
      { provider: "claude", model: PLAN, reasoningEffort: "xhigh" },
      { provider: "claude", model: PLAN, reasoningEffort: "low" },
    ]);
    assert.match(configurations[0].text, /xhigh effort/);
    assert.match(configurations[1].text, /low effort/);
    assert.deepEqual(store.getMessages(t.id).filter((m) => m.role === "assistant")
      .map((m) => m.runConfiguration.reasoningEffort), ["xhigh", "low"]);
    store.saveNow();
    assert.deepEqual(new Store(path.join(tmpDir, "store.json")).getMessages(t.id)
      .filter((m) => m.role === "event" && m.runConfiguration), configurations);
  });

  it("records no model boundary when the installed Claude version cannot launch Ultracode", async () => {
    process.env.FAKE_VERSION = "2.1.218";
    await startRunner();
    const t = services.createThread(store, { projectId: project.id, title: "old CLI", provider: "claude" });
    store.updateThread(t.id, { model: PLAN, reasoningEffort: "low" });
    services.setUltracode(store, { threadId: t.id, ultracode: true });
    await assert.rejects(runner.startRun({ threadId: t.id, prompt: "work" }), /2\.1\.219 or newer/);
    assert.equal(store.getMessages(t.id).filter((m) => m.runConfiguration).length, 0);
    assert.equal(fs.existsSync(process.env.FAKE_ARGS), false, "version check never launches an agent");
  });

  it("switches the live process with set_model on plan approval and bills each model its share", async () => {
    process.env.FAKE_ASK_PLAN = "1";
    const rows = [];
    const recordUsage = store.recordUsage.bind(store);
    store.recordUsage = (row) => {
      rows.push(row);
      return recordUsage(row);
    };
    await startRunner();
    const id = planThread();

    await runner.startRun({ threadId: id, prompt: "plan it" });
    await waitFor(() => runner.getPendingPermission(id) != null);
    runner.respondPermission({
      threadId: id,
      requestId: runner.getPendingPermission(id).requestId,
      decision: "allow",
    });
    await waitFor(() => store.getThread(id).status === "done" && store.getUsage(id)?.turns === 1);

    const lines = fs.readFileSync(process.env.FAKE_STDIN, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const setModel = lines.findIndex((m) => m.type === "control_request" && m.request.subtype === "set_model");
    const allow = lines.findIndex((m) => m.type === "control_response");
    assert.ok(setModel >= 0 && setModel < allow, "set_model goes ahead of the allow");
    assert.equal(lines[setModel].request.model, ACT);
    assert.equal(spawns().length, 1, "same live process");

    assert.deepEqual(
      rows.map((r) => [r.model, r.costUsd, r.inputTokens, r.outputTokens]),
      [[PLAN, 0.02, 10, 2], [ACT, 0.05, 20, 5]],
    );
    assert.equal(store.getUsage(id).model, ACT);
    assert.equal(store.getThread(id).permissionMode, "default");
    assert.deepEqual(store.getMessages(id).filter((m) => m.role === "event" && m.runConfiguration)
      .map((m) => m.runConfiguration), [
        { provider: "claude", model: PLAN, reasoningEffort: "high" },
        { provider: "claude", model: ACT, reasoningEffort: "high" },
      ], "a live set_model boundary preserves the effort that the process is actually using");
    const ev = events(id);
    assert.ok(ev.indexOf("Switched to Sonnet 5.5 for implementation") > ev.indexOf("Plan approved"));
  });

  it("keeps one model and no note when the thread has no plan model", async () => {
    process.env.FAKE_ASK_PLAN = "1";
    await startRunner();
    const t = services.createThread(store, { projectId: project.id, title: "t" });
    store.updateThread(t.id, { model: ACT, permissionMode: "plan" });
    store.saveNow();

    await runner.startRun({ threadId: t.id, prompt: "plan it" });
    await waitFor(() => runner.getPendingPermission(t.id) != null);
    runner.respondPermission({
      threadId: t.id,
      requestId: runner.getPendingPermission(t.id).requestId,
      decision: "allow",
    });
    await waitFor(() => store.getThread(t.id).status === "done");
    assert.equal(flag(spawns()[0], "--model"), ACT);
    const lines = fs.readFileSync(process.env.FAKE_STDIN, "utf8");
    assert.doesNotMatch(lines, /set_model/);
    assert.ok(!events(t.id).some((e) => e.startsWith("Switched to")));
  });
});
