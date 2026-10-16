/**
 * #803: the runner's Seatbelt seam — wrap or refuse, audit every Seatbelt
 * decision (layer "seatbelt"), flag matrix-allow / Seatbelt-deny
 * disagreements, and (macOS) a real provider run confined end to end.
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
const { createSeatbelt } = require("../runner-seatbelt.js");
const { SANDBOX_EXEC } = require("../seatbelt.js");
const { stopSharedProxy } = require("../seatbeltProxy.js");
const {
  configureGovernanceAudit,
  appendAudit,
  listAudit,
  verifyAudit,
} = require("../governanceAudit.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

const CAN_WRAP = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);

function waitFor(predicate, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function setup(rules) {
  // Under $HOME, not tmp: tmp is writable inside the sandbox by design.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".sb-run-")));
  configureGovernanceAudit({ dir });
  const store = new Store(path.join(dir, "store.json"));
  const repo = path.join(dir, "app");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, { projectId: project.id, title: "SB" });
  store.setSettings({
    agentProfiles: [
      {
        id: "locked",
        name: "Locked",
        provider: "claude",
        model: null,
        reasoningEffort: null,
        permissionMode: "default",
        policy: { defaultAction: "ask", rules },
      },
    ],
  });
  services.applyAgentProfile(store, { threadId: thread.id, profileId: "locked" });
  return { dir, store, project, thread, repo };
}

describe("runner seatbelt seam (issue #803)", () => {
  let env;
  const events = [];
  afterEach(async () => {
    configureGovernanceAudit(null);
    stopSharedProxy();
    events.length = 0;
    if (env) await rmTree(env.dir);
    env = null;
  });

  function seam(platform) {
    return createSeatbelt(
      {
        store: env.store,
        appendMessage: (threadId, role, text) => events.push([threadId, role, text]),
        pushDetail() {},
      },
      { platform, log() {} },
    );
  }

  it("leaves threads without write/network rules alone", async () => {
    env = await setup([{ kind: "bash", match: "npm publish", action: "block" }]);
    const spawn = { binary: "/bin/cli", args: ["-p"], cwd: env.repo };
    const out = seam("darwin").confineSpawn(spawn, { threadId: env.thread.id, project: env.project });
    assert.equal(out, spawn);
  });

  it("a kernel denial is audited as layer seatbelt and noted in the transcript", async () => {
    env = await setup([{ kind: "write", match: "src/*", action: "deny" }]);
    seam("linux").onDenial({
      threadId: env.thread.id,
      process: "bash",
      pid: 1,
      op: "file-write-create",
      target: "/Users/x/Desktop/f",
    });
    const [row] = listAudit({ threadId: env.thread.id });
    assert.equal(row.layer, "seatbelt");
    assert.equal(row.decision, "deny");
    assert.equal(row.rule, "file-write-create");
    assert.equal(row.declared.path, "/Users/x/Desktop/f");
    assert.equal(row.profileId, "locked");
    assert.match(events.at(-1)[2], /^Seatbelt blocked bash file-write-create \/Users\/x\/Desktop\/f/);
    assert.deepEqual(verifyAudit(), { ok: true, entries: 1 });
  });

  it("flags a matrix-allow / Seatbelt-deny disagreement", async () => {
    env = await setup([{ kind: "write", match: "src/*", action: "deny" }]);
    const target = "/Users/x/outside.txt";
    const call = { tool: "write", command: null, path: target, hosts: [] };
    appendAudit({
      threadId: env.thread.id,
      profileId: "locked",
      provider: "claude",
      toolName: "Write",
      actionHash: "h",
      declared: call,
      executed: call,
      decision: "allow",
      layer: "profile.default",
      rule: null,
      reason: "allowed by user",
    });
    seam("linux").onDenial({
      threadId: env.thread.id,
      process: "claude",
      pid: 2,
      op: "file-write-create",
      target,
    });
    const [row] = listAudit({ threadId: env.thread.id });
    assert.equal(row.rule, "disagreement");
    assert.match(row.reason, /^matrix allowed \(profile\.default\), seatbelt denied: claude file-write-create/);
  });

  it("proxy decisions: deny audited every time, allow once per host", async () => {
    env = await setup([{ kind: "network", match: "*.evil.test", action: "block" }]);
    const sb = seam("linux");
    const id = env.thread.id;
    assert.equal(sb.decide(id, "api.anthropic.com").allow, true);
    const denied = sb.decide(id, "x.evil.test");
    assert.deepEqual(denied, { allow: false, rule: "network:*.evil.test", reason: "block by profile" });
    assert.equal(sb.decide("no-such-thread", "api.anthropic.com").allow, false);
    sb.onProxyDecision(id, "api.anthropic.com", sb.decide(id, "api.anthropic.com"));
    sb.onProxyDecision(id, "api.anthropic.com", sb.decide(id, "api.anthropic.com"));
    sb.onProxyDecision(id, "x.evil.test", denied);
    const rows = listAudit({ threadId: id });
    assert.deepEqual(
      rows.map((r) => [r.decision, r.declared.hosts[0]]),
      [
        ["deny", "x.evil.test"],
        ["allow", "api.anthropic.com"],
      ],
    );
    assert.ok(rows.every((r) => r.layer === "seatbelt"));
    assert.match(events.at(-1)[2], /Seatbelt proxy blocked x\.evil\.test/);
  });

  it("wraps in sandbox-exec, or refuses rather than run unconfined", { skip: !CAN_WRAP }, async () => {
    env = await setup([{ kind: "write", match: "src/*", action: "deny" }]);
    const sb = seam("darwin");
    const at = { threadId: env.thread.id, project: env.project };
    const out = sb.confineSpawn({ binary: "/bin/cli", args: ["-p"], cwd: env.repo }, at);
    assert.equal(out.binary, SANDBOX_EXEC);
    assert.equal(out.args[0], "-p");
    assert.match(out.args[1], /solenta:/);
    assert.deepEqual(out.args.slice(-2), ["/bin/cli", "-p"]);
    assert.match(out.seatbelt, /^[0-9a-f]{64}$/);

    const loop = path.join(env.dir, "loop");
    fs.symlinkSync(loop, loop);
    assert.throws(
      () => sb.confineSpawn({ binary: "/bin/cli", args: [], cwd: `${loop}/wt` }, at),
      /Seatbelt: .*refusing to run unconfined/,
    );
    const [row] = listAudit({ threadId: env.thread.id });
    assert.equal(row.layer, "seatbelt");
    assert.equal(row.rule, "seatbelt.compile");
  });

  it("refuses network confinement before the proxy is listening", { skip: !CAN_WRAP }, async () => {
    env = await setup([{ kind: "network", match: "evil.test", action: "deny" }]);
    stopSharedProxy();
    const sb = seam("darwin"); // starts the proxy, which cannot be listening yet
    assert.throws(
      () =>
        sb.confineSpawn(
          { binary: "/bin/cli", args: [], cwd: env.repo },
          { threadId: env.thread.id, project: env.project },
        ),
      /egress proxy is not running/,
    );
  });
});

describe("a real provider run is confined end to end (issue #803)", { skip: !CAN_WRAP }, () => {
  let env;
  let runner;
  const saved = {};
  const KEYS = ["CODER_CLAUDE_BIN", "CODER_SIMULATE", "CODER_AGENT_CMD", "SB_OUT", "SB_PROBE"];
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
  });
  afterEach(async () => {
    if (runner) runner.stopAll();
    configureGovernanceAudit(null);
    stopSharedProxy();
    if (env) await rmTree(env.dir);
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** Fake claude: tries to write SB_PROBE, records the outcome to SB_OUT (tmp). */
  function fakeClaude(dir) {
    return writeFakeBin(
      path.join(dir, "fake-claude"),
      `#!/usr/bin/env node
"use strict";
const fs = require("fs");
let outcome;
try { fs.writeFileSync(process.env.SB_PROBE, "x"); outcome = "wrote"; }
catch (e) { outcome = e.code; }
fs.writeFileSync(process.env.SB_OUT, outcome);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: "sess-sb", model: "m" });
emit({ type: "result", subtype: "success", result: outcome,
  usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0,
  num_turns: 1, session_id: "sess-sb" });
process.exit(0);
`,
    );
  }

  async function run(rules) {
    env = await setup(rules);
    process.env.CODER_CLAUDE_BIN = fakeClaude(env.dir);
    const out = path.join(fs.realpathSync(os.tmpdir()), `sb-out-${process.pid}-${Date.now()}`);
    process.env.SB_OUT = out;
    process.env.SB_PROBE = path.join(env.dir, "outside.txt");
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    runner = createRunner({ store: env.store, core, pushFn() {}, tickMs: 15, userDataPath: env.dir });
    await runner.startRun({ threadId: env.thread.id, prompt: "probe" });
    await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, "utf8") !== "");
    const outcome = fs.readFileSync(out, "utf8");
    fs.rmSync(out, { force: true });
    return outcome;
  }

  it("a governed thread cannot write outside its worktree", async () => {
    assert.equal(await run([{ kind: "write", match: "src/*", action: "deny" }]), "EPERM");
    assert.equal(fs.existsSync(process.env.SB_PROBE), false);
    assert.equal(services.listThreads(env.store)[0].sandbox.sandboxed, true);
  });

  it("an ungoverned thread is not wrapped (control)", async () => {
    assert.equal(await run([{ kind: "bash", match: "x", action: "deny" }]), "wrote");
  });
});
