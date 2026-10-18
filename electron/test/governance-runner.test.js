/**
 * #262: the profile matrix at the Claude can_use_tool seam and on the card
 * answer. Same fake CLI shape as guardrails-runner.test.js.
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
  configureGovernanceAudit,
  listAudit,
  verifyAudit,
} = require("../governanceAudit.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function readJsonIfComplete(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** One can_use_tool from env, records the control_response, then exits. */
function writeFakeClaude(dir) {
  return writeFakeBin(
    path.join(dir, "fake-claude"),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: "sess-gov", model: "m" });
setTimeout(() => emit({
  type: "control_request",
  request_id: "req-gov-1",
  request: {
    subtype: "can_use_tool",
    tool_name: process.env.CODER_FAKE_CLAUDE_TOOL,
    input: JSON.parse(process.env.CODER_FAKE_CLAUDE_INPUT),
  },
}), 20);
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "control_response") continue;
    fs.writeFileSync(process.env.CODER_FAKE_CLAUDE_CTRL_FILE, JSON.stringify(msg));
    emit({ type: "result", subtype: "success", result: "done",
      usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0,
      num_turns: 1, session_id: "sess-gov" });
    process.exit(0);
  }
});
setTimeout(() => process.exit(1), 30000);
`,
  );
}

const ENV = [
  "CODER_SIMULATE",
  "CODER_AGENT_CMD",
  "CODER_CLAUDE_BIN",
  "CODER_FAKE_CLAUDE_TOOL",
  "CODER_FAKE_CLAUDE_INPUT",
  "CODER_FAKE_CLAUDE_CTRL_FILE",
  "CODER_GUARDRAILS",
  "CODER_GUARDRAILS_PATH",
  "CODER_GROK_MCP_DISABLE",
  "CODER_GROK_BIN",
];

describe("runner × governance matrix (issue #262)", () => {
  let tmpDir;
  let store;
  let runner;
  let ctrlFile;
  let thread;
  const saved = {};

  beforeEach(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_GUARDRAILS;
    delete process.env.CODER_GUARDRAILS_PATH;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok-not-a-real-binary";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-gov-run-"));
    process.env.CODER_CLAUDE_BIN = writeFakeClaude(tmpDir);
    ctrlFile = path.join(tmpDir, "ctrl.json");
    process.env.CODER_FAKE_CLAUDE_CTRL_FILE = ctrlFile;
    configureGovernanceAudit({ dir: tmpDir });

    store = new Store(path.join(tmpDir, "store.json"));
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({ store, core, pushFn() {}, tickMs: 15, userDataPath: tmpDir });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    thread = services.createThread(store, { projectId: project.id, title: "Gov" });
    store.setSettings({
      agentProfiles: [
        {
          id: "scout",
          name: "Scout",
          provider: "claude",
          model: null,
          reasoningEffort: null,
          permissionMode: "default",
          policy: {
            defaultAction: "ask",
            rules: [
              { kind: "bash", match: "npm publish", action: "block" },
              { kind: "bash", match: "git push", action: "ask" },
              { kind: "tool", match: "Read", action: "allow" },
            ],
          },
        },
      ],
    });
    services.applyAgentProfile(store, { threadId: thread.id, profileId: "scout" });
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    configureGovernanceAudit(null);
    await rmTree(tmpDir);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function tool(name, input) {
    process.env.CODER_FAKE_CLAUDE_TOOL = name;
    process.env.CODER_FAKE_CLAUDE_INPUT = JSON.stringify(input);
  }

  it("applyAgentProfile stamps the thread", () => {
    assert.equal(store.getThread(thread.id).agentProfileId, "scout");
    assert.throws(
      () => services.applyAgentProfile(store, { threadId: thread.id, profileId: "nope" }),
      /Unknown agent profile/,
    );
  });

  it("profile block auto-denies: no card, event + audit say profile.block", async () => {
    tool("Bash", { command: "FOO=1 npm publish --tag next" });
    await runner.startRun({ threadId: thread.id, prompt: "ship it" });
    let ctrl;
    await waitFor(() => (ctrl = readJsonIfComplete(ctrlFile)) !== undefined);

    assert.equal(runner.getPendingPermission(thread.id), null);
    assert.equal(ctrl.response.response.behavior, "deny");
    assert.match(ctrl.response.response.message, /profile\.block: bash:npm publish/);
    const msgs = store.getMessages(thread.id).map((m) => m.text);
    assert.ok(
      msgs.some((t) => /^Governance blocked Bash: profile\.block: bash:npm publish/.test(t)),
      JSON.stringify(msgs),
    );
    const [row] = listAudit({ threadId: thread.id });
    assert.equal(row.decision, "deny");
    assert.equal(row.layer, "profile.block");
    assert.equal(row.profileId, "scout");
    assert.equal(row.declared.command, "npm publish --tag next");
    assert.deepEqual(verifyAudit(), { ok: true, entries: 1 });
    await waitFor(() => store.getThread(thread.id).status === "done");
  });

  it("profile allow skips the card", async () => {
    tool("Read", { file_path: "README.md" });
    await runner.startRun({ threadId: thread.id, prompt: "read" });
    let ctrl;
    await waitFor(() => (ctrl = readJsonIfComplete(ctrlFile)) !== undefined);
    assert.equal(ctrl.response.response.behavior, "allow");
    assert.deepEqual(ctrl.response.response.updatedInput, { file_path: "README.md" });
    const [row] = listAudit({ threadId: thread.id });
    assert.equal(row.layer, "profile.allow");
    assert.deepEqual(row.executed, row.declared);
    await waitFor(() => store.getThread(thread.id).status === "done");
  });

  it("refuses an Allow whose edited command now matches a block", async () => {
    tool("Bash", { command: "npm test" });
    await runner.startRun({ threadId: thread.id, prompt: "test" });
    await waitFor(() => runner.getPendingPermission(thread.id) != null);
    const pending = runner.getPendingPermission(thread.id);
    assert.equal(pending.guardrail.layer, "profile.default");

    assert.throws(
      () =>
        runner.respondPermission({
          threadId: thread.id,
          requestId: pending.requestId,
          decision: "allow",
          updatedCommand: "npm publish",
        }),
      /Blocked by policy \(profile\.block\)/,
    );
    let ctrl;
    await waitFor(() => (ctrl = readJsonIfComplete(ctrlFile)) !== undefined);
    assert.equal(ctrl.response.response.behavior, "deny");
    assert.equal(runner.getPendingPermission(thread.id), null);
    await waitFor(() => store.getThread(thread.id).status === "done");
  });

  it("refuses an edit to a builtin deny even without a profile", async () => {
    store.updateThread(thread.id, { agentProfileId: null });
    tool("Bash", { command: "ls" });
    await runner.startRun({ threadId: thread.id, prompt: "ls" });
    await waitFor(() => runner.getPendingPermission(thread.id) != null);
    const pending = runner.getPendingPermission(thread.id);
    assert.equal(pending.guardrail, null);
    assert.throws(
      () =>
        runner.respondPermission({
          threadId: thread.id,
          requestId: pending.requestId,
          decision: "allow",
          updatedCommand: "sudo rm -rf /",
        }),
      /Blocked by policy \(builtin\)/,
    );
    await waitFor(() => store.getThread(thread.id).status === "done");
  });

  it("profile ask: Allow always grants nothing and sends no Claude session rule", async () => {
    tool("Bash", { command: "git push origin main" });
    await runner.startRun({ threadId: thread.id, prompt: "push" });
    await waitFor(() => runner.getPendingPermission(thread.id) != null);
    const pending = runner.getPendingPermission(thread.id);
    assert.equal(pending.guardrail.layer, "profile.ask");
    assert.equal(pending.guardrail.rule, "bash:git push");
    runner.respondPermission({
      threadId: thread.id,
      requestId: pending.requestId,
      decision: "allowAlways",
    });
    let ctrl;
    await waitFor(() => (ctrl = readJsonIfComplete(ctrlFile)) !== undefined);
    assert.equal(ctrl.response.response.behavior, "allow");
    // A Claude addRules would stop can_use_tool and bypass the matrix.
    assert.equal(ctrl.response.response.updatedPermissions, undefined);
    const rows = listAudit({ threadId: thread.id });
    assert.deepEqual(
      rows.map((r) => r.decision),
      ["allow", "ask"],
    );
    assert.equal(rows[0].executed.command, "git push origin main");
    await waitFor(() => store.getThread(thread.id).status === "done");
  });

  it("an ungoverned thread keeps today's Claude session rule on Allow always", async () => {
    store.updateThread(thread.id, { agentProfileId: null });
    tool("Bash", { command: "npm test" });
    await runner.startRun({ threadId: thread.id, prompt: "test" });
    await waitFor(() => runner.getPendingPermission(thread.id) != null);
    runner.respondPermission({
      threadId: thread.id,
      requestId: runner.getPendingPermission(thread.id).requestId,
      decision: "allowAlways",
    });
    let ctrl;
    await waitFor(() => (ctrl = readJsonIfComplete(ctrlFile)) !== undefined);
    assert.equal(ctrl.response.response.updatedPermissions[0].type, "addRules");
    await waitFor(() => store.getThread(thread.id).status === "done");
  });
});
