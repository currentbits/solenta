/**
 * Issue #177: permission modes are a per-provider capability, like effort.
 *
 * A stored mode that would never reach the CLI cannot be offered, stored, or
 * silently remapped in the UI. buildArgs still has a compatibility fallback
 * so a legacy grok/kimi/cursor thread on "default" does not die mid-run.
 *
 * Run: node --test electron/test/permission-modes.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  PROVIDERS,
  getProvider,
  listProviders,
  honouredPermissionModes,
  snapPermissionMode,
} = require("../providers.js");
const { Store } = require("../store.js");
const services = require("../services.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

const ALL = ["default", "acceptEdits", "plan", "bypassPermissions"];

function sandboxOf(args) {
  const i = args.indexOf("--sandbox");
  return i >= 0 ? args[i + 1] : null;
}

function permissionModeOf(args) {
  const i = args.indexOf("--permission-mode");
  return i >= 0 ? args[i + 1] : null;
}

describe("permission modes: registry + listProviders", () => {
  it("every provider lists the modes its adapter actually honours", () => {
    const expected = {
      claude: ALL,
      codex: ALL,
      grok: ["plan", "bypassPermissions"],
      opencode: ["default", "bypassPermissions"],
      kimi: ["bypassPermissions"],
      cursor: ["plan", "bypassPermissions"],
      muse: ["default", "bypassPermissions"],
    };
    for (const [id, modes] of Object.entries(expected)) {
      const entry = getProvider(id);
      assert.ok(entry, id);
      assert.deepEqual(entry.permissionModes, modes, id);
      assert.deepEqual(honouredPermissionModes(entry), modes, id);
    }
  });

  it("listProviders copies permissionModes onto ProviderInfo", () => {
    const list = listProviders({ which: () => null, includeSimulate: true });
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    assert.deepEqual(byId.claude.permissionModes, ALL);
    assert.deepEqual(byId.codex.permissionModes, ALL);
    assert.deepEqual(byId.grok.permissionModes, ["plan", "bypassPermissions"]);
    assert.deepEqual(byId.opencode.permissionModes, [
      "default",
      "bypassPermissions",
    ]);
    assert.deepEqual(byId.kimi.permissionModes, ["bypassPermissions"]);
    assert.deepEqual(byId.cursor.permissionModes, [
      "plan",
      "bypassPermissions",
    ]);
    assert.deepEqual(byId.simulate.permissionModes, ALL);
  });

  it("snapPermissionMode keeps honoured modes and maps the rest honestly", () => {
    const grok = getProvider("grok");
    assert.equal(snapPermissionMode(grok, "plan"), "plan");
    assert.equal(snapPermissionMode(grok, "bypassPermissions"), "bypassPermissions");
    assert.equal(snapPermissionMode(grok, "default"), "bypassPermissions");
    assert.equal(snapPermissionMode(grok, "acceptEdits"), "bypassPermissions");

    const kimi = getProvider("kimi");
    assert.equal(snapPermissionMode(kimi, "default"), "bypassPermissions");
    assert.equal(snapPermissionMode(kimi, "plan"), "bypassPermissions");
    assert.equal(snapPermissionMode(kimi, "bypassPermissions"), "bypassPermissions");

    const opencode = getProvider("opencode");
    assert.equal(snapPermissionMode(opencode, "default"), "default");
    assert.equal(snapPermissionMode(opencode, "bypassPermissions"), "bypassPermissions");
    assert.equal(snapPermissionMode(opencode, "acceptEdits"), "bypassPermissions");
    assert.equal(snapPermissionMode(opencode, "plan"), "default");

    const muse = getProvider("muse");
    assert.equal(snapPermissionMode(muse, "plan"), "default");
    assert.equal(snapPermissionMode(muse, "acceptEdits"), "bypassPermissions");

    const cursor = getProvider("cursor");
    assert.equal(snapPermissionMode(cursor, "plan"), "plan");
    assert.equal(snapPermissionMode(cursor, "default"), "bypassPermissions");

    const claude = getProvider("claude");
    for (const mode of ALL) {
      assert.equal(snapPermissionMode(claude, mode), mode);
    }
  });
});

describe("permission modes: buildArgs per provider", () => {
  it("claude still emits --permission-mode for every listed mode", () => {
    const entry = getProvider("claude");
    for (const mode of ALL) {
      const args = entry.buildArgs({ prompt: "p", permissionMode: mode });
      assert.equal(permissionModeOf(args), mode, mode);
      assert.ok(args.includes("--permission-prompt-tool"));
    }
  });

  it("codex maps modes onto --sandbox (issue #170)", () => {
    const entry = getProvider("codex");
    assert.equal(
      sandboxOf(entry.buildArgs({ prompt: "p", permissionMode: "plan" })),
      "read-only",
    );
    assert.equal(
      sandboxOf(entry.buildArgs({ prompt: "p", permissionMode: "default" })),
      "workspace-write",
    );
    assert.equal(
      sandboxOf(
        entry.buildArgs({ prompt: "p", permissionMode: "acceptEdits" }),
      ),
      "workspace-write",
    );
    assert.equal(
      sandboxOf(
        entry.buildArgs({ prompt: "p", permissionMode: "bypassPermissions" }),
      ),
      "danger-full-access",
    );
    const args = entry.buildArgs({ prompt: "PROMPT_SANDBOX", permissionMode: "default" });
    assert.equal(args[args.length - 1], "PROMPT_SANDBOX");
  });

  it("grok: asking modes still remap so a legacy thread does not die", () => {
    const entry = getProvider("grok");
    const asking = entry.buildArgs({ prompt: "p", permissionMode: "default" });
    assert.equal(permissionModeOf(asking), "bypassPermissions");
    assert.ok(asking.includes("--always-approve"));

    const plan = entry.buildArgs({ prompt: "p", permissionMode: "plan" });
    assert.equal(permissionModeOf(plan), "plan");
    assert.ok(!plan.includes("--always-approve"));

    const bypass = entry.buildArgs({
      prompt: "p",
      permissionMode: "bypassPermissions",
    });
    assert.equal(permissionModeOf(bypass), "bypassPermissions");
    assert.ok(!bypass.includes("--always-approve"));
  });

  it("opencode: --auto only for full access (and leftover acceptEdits)", () => {
    const entry = getProvider("opencode");
    const def = entry.buildArgs({ prompt: "hello", permissionMode: "default" });
    assert.deepEqual(def, ["run", "--format", "json", "--thinking", "hello"]);
    assert.ok(!def.includes("--auto"));

    const bypass = entry.buildArgs({
      prompt: "hello",
      permissionMode: "bypassPermissions",
    });
    assert.ok(bypass.includes("--auto"));
    assert.equal(bypass[bypass.length - 1], "hello");

    const accept = entry.buildArgs({
      prompt: "hello",
      permissionMode: "acceptEdits",
    });
    assert.ok(accept.includes("--auto"));

    const plan = entry.buildArgs({ prompt: "hello", permissionMode: "plan" });
    assert.ok(!plan.includes("--auto"));
  });

  it("kimi still emits no permission flags for any stored mode", () => {
    const entry = getProvider("kimi");
    for (const permissionMode of ALL) {
      const argv = entry.buildArgs({ prompt: "p", permissionMode });
      assert.ok(!argv.includes("-y"), permissionMode);
      assert.ok(!argv.includes("--auto"), permissionMode);
      assert.ok(!argv.includes("--plan"), permissionMode);
      assert.ok(!argv.includes("--yolo"), permissionMode);
    }
  });

  it("cursor: only plan is distinct; other modes keep --force", () => {
    const entry = getProvider("cursor");
    const plan = entry.buildArgs({ prompt: "p", permissionMode: "plan" });
    assert.equal(plan[plan.indexOf("--mode") + 1], "plan");
    assert.ok(!plan.includes("--force"));

    for (const mode of ["default", "acceptEdits", "bypassPermissions"]) {
      const args = entry.buildArgs({ prompt: "p", permissionMode: mode });
      assert.ok(args.includes("--force"), mode);
      assert.ok(!args.includes("--mode"), mode);
    }
  });

  it("muse: exec --json, trust-workspace, never vs disable-approval, prompt last", () => {
    const entry = getProvider("muse");
    const def = entry.buildArgs({ prompt: "HELLO", permissionMode: "default" });
    assert.equal(def[0], "exec");
    assert.ok(def.includes("--json"));
    assert.ok(def.includes("--trust-workspace"));
    assert.equal(def[def.indexOf("--approval-mode") + 1], "never");
    assert.ok(!def.includes("--yolo"));
    assert.ok(!def.includes("--worktree"));
    assert.ok(!def.includes("--workspace"));
    assert.equal(def[def.length - 1], "HELLO");

    const bypass = entry.buildArgs({
      prompt: "HELLO",
      permissionMode: "bypassPermissions",
    });
    assert.ok(bypass.includes("--disable-approval"));
    assert.ok(!bypass.includes("--yolo"));
    assert.ok(!bypass.includes("never"));

    const resume = entry.buildArgs({
      prompt: "MORE",
      sessionId: "11111111-1111-1111-1111-111111111111",
      model: "muse-spark-1.3",
      reasoningEffort: "high",
      permissionMode: "default",
    });
    assert.equal(resume[resume.indexOf("--session-id") + 1], "11111111-1111-1111-1111-111111111111");
    assert.equal(resume[resume.indexOf("--model") + 1], "muse-spark-1.3");
    assert.equal(resume[resume.indexOf("--reasoning-effort") + 1], "high");
    assert.equal(resume[resume.length - 1], "MORE");

    const noNone = entry.buildArgs({
      prompt: "p",
      reasoningEffort: "none",
      permissionMode: "default",
    });
    assert.ok(!noNone.includes("none"));
  });

  it("registry permissionModes stay in lockstep with PROVIDERS", () => {
    for (const entry of PROVIDERS) {
      assert.ok(
        Array.isArray(entry.permissionModes),
        `${entry.id} permissionModes`,
      );
      for (const mode of entry.permissionModes) {
        assert.ok(ALL.includes(mode), `${entry.id} unknown mode ${mode}`);
      }
    }
  });
});

describe("permission modes: setPermissionMode + setProvider", () => {
  let tmpDir;
  let store;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-perm-svc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    project = await services.addProject(store, repo);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("claude still accepts every mode", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    for (const mode of ALL) {
      const updated = services.setPermissionMode(store, {
        threadId: thread.id,
        mode,
      });
      assert.equal(updated.permissionMode, mode);
    }
  });

  it("rejects a mode the provider cannot honour, naming the provider", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    services.setProvider(store, { threadId: thread.id, provider: "grok" });
    assert.throws(
      () =>
        services.setPermissionMode(store, {
          threadId: thread.id,
          mode: "default",
        }),
      (err) => {
        assert.match(err.message, /Grok/i);
        assert.match(err.message, /default/);
        return true;
      },
    );
    assert.equal(store.getThread(thread.id).permissionMode, "bypassPermissions");
  });

  it("setProvider snaps an unhonoured mode onto the nearest honoured one", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    assert.equal(thread.permissionMode, "default");

    const grok = services.setProvider(store, {
      threadId: thread.id,
      provider: "grok",
    });
    assert.equal(grok.permissionMode, "bypassPermissions");

    services.setProvider(store, { threadId: thread.id, provider: "claude" });
    services.setPermissionMode(store, {
      threadId: thread.id,
      mode: "plan",
    });
    const stillPlan = services.setProvider(store, {
      threadId: thread.id,
      provider: "grok",
    });
    assert.equal(stillPlan.permissionMode, "plan");

    const kimi = services.setProvider(store, {
      threadId: thread.id,
      provider: "kimi",
    });
    assert.equal(kimi.permissionMode, "bypassPermissions");
  });

  it("setProvider claude plan → opencode lands on default, not --auto", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    services.setPermissionMode(store, {
      threadId: thread.id,
      mode: "plan",
    });
    const updated = services.setProvider(store, {
      threadId: thread.id,
      provider: "opencode",
    });
    assert.equal(updated.permissionMode, "default");
  });

  it("grok accepts plan and bypassPermissions", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    services.setProvider(store, { threadId: thread.id, provider: "grok" });
    const plan = services.setPermissionMode(store, {
      threadId: thread.id,
      mode: "plan",
    });
    assert.equal(plan.permissionMode, "plan");
    const bypass = services.setPermissionMode(store, {
      threadId: thread.id,
      mode: "bypassPermissions",
    });
    assert.equal(bypass.permissionMode, "bypassPermissions");
  });

  it("forkThread snaps an unhonoured source mode onto the new provider", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    assert.equal(thread.permissionMode, "default");

    const grok = services.forkThread(store, {
      threadId: thread.id,
      provider: "grok",
    });
    assert.equal(grok.permissionMode, "bypassPermissions");

    services.setPermissionMode(store, {
      threadId: thread.id,
      mode: "plan",
    });
    const grokPlan = services.forkThread(store, {
      threadId: thread.id,
      provider: "grok",
    });
    assert.equal(grokPlan.permissionMode, "plan");

    const opencode = services.forkThread(store, {
      threadId: thread.id,
      provider: "opencode",
    });
    assert.equal(opencode.permissionMode, "default");
  });
});
