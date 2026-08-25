const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const ssh = require("../ssh.js");
const doctor = require("../doctor.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("services", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-svc-"));
    store = new Store(path.join(tmpDir, "store.json"));
  });

  afterEach(() => {
    ssh.setExecFileSync(null);
    ssh.setExecFile(null);
    doctor.setPlatform(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("addProject creates a missing path (mkdir + git init) (#609)", async () => {
    const missing = path.join(tmpDir, "brand-new");
    const project = await services.addProject(store, missing);
    assert.equal(project.path, path.resolve(missing));
    assert.ok(fs.statSync(missing).isDirectory());
    const inside = String(
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: missing,
        encoding: "utf8",
      }),
    ).trim();
    assert.equal(inside, "true");
  });

  it("addProject returns the existing project instead of duplicating it", async () => {
    const repo = path.join(tmpDir, "already");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const first = await services.addProject(store, repo);
    const second = await services.addProject(store, repo + "/");
    assert.equal(second.id, first.id);
    assert.equal(store.getProjects().length, 1);
  });

  it("addProject rejects a path that is a file, not a directory", async () => {
    const file = path.join(tmpDir, "file.txt");
    fs.writeFileSync(file, "x");
    await assert.rejects(
      () => services.addProject(store, file),
      /not a directory/i,
    );
  });

  it("addProject git-inits a directory that is not a git repo", async () => {
    const dir = path.join(tmpDir, "plain");
    fs.mkdirSync(dir);
    const project = await services.addProject(store, dir);
    assert.equal(project.slug, "plain");
    assert.equal(project.name, "plain");
    assert.equal(project.path, path.resolve(dir));
    const inside = String(
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: dir,
        encoding: "utf8",
      }),
    ).trim();
    assert.equal(inside, "true", "plain folder must become a git work tree");
    assert.equal(store.getProjects().length, 1);
  });

  it("addProject accepts a git repo and uses folder name when no remote", async () => {
    const repo = path.join(tmpDir, "my-app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    // git may need identity for later ops; status/remote should work without commits
    const project = await services.addProject(store, repo);
    assert.equal(project.slug, "my-app");
    assert.equal(project.name, "my-app");
    assert.equal(project.path, path.resolve(repo));
    assert.ok(project.id);
    assert.equal(store.getProjects().length, 1);
  });

  it("addProject derives slug from origin remote as owner/repo", async () => {
    const repo = path.join(tmpDir, "fixture-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, [
      "remote",
      "add",
      "origin",
      "https://github.com/pingdotgg/t3code.git",
    ]);
    const project = await services.addProject(store, repo);
    assert.equal(project.slug, "pingdotgg/t3code");
    assert.equal(project.name, "t3code");
  });

  it("addProject stores remotes without a local checkout", async () => {
    const project = await services.addProject(store, "", {
      remoteHost: "dev@box",
      remotePath: "/srv/my app",
    });
    assert.equal(project.remoteHost, "dev@box");
    assert.equal(project.remotePath, "/srv/my app");
    assert.equal(project.path, "/srv/my app");
    assert.equal(project.slug, "my app");
    assert.equal(project.name, "my app");
    assert.equal(store.getProjects().length, 1);
  });

  it("addProject rejects remotes without an absolute remotePath", async () => {
    await assert.rejects(
      () =>
        services.addProject(store, "", {
          remoteHost: "dev@box",
        }),
      /remote path is required/i,
    );
    await assert.rejects(
      () =>
        services.addProject(store, "", {
          remoteHost: "dev@box",
          remotePath: "relative/path",
        }),
      /absolute/i,
    );
  });

  it("addProject does not attach a doctor off win32", async () => {
    const repo = path.join(tmpDir, "mac-app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    assert.equal(project.windowsDoctor, undefined);
    assert.equal(store.getProjects()[0].windowsDoctor, undefined);
  });

  it("addProject stays advisory when every Windows doctor check is red", async () => {
    const repo = path.join(tmpDir, "win-app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    doctor.setPlatform("win32");
    ssh.setExecFile((bin, args, opts, cb) => {
      if (bin === "git" && args[0] === "config") return cb(null, "false\n");
      if (bin === "bash") return cb(new Error("bash: not found"));
      if (bin === "node") return cb(null, "v18.20.0\n");
      execFile(bin, args, opts, cb);
    });
    const project = await services.addProject(store, repo);
    assert.ok(project.id);
    assert.equal(store.getProjects().length, 1);
    assert.equal(
      store.getProjects()[0].windowsDoctor,
      undefined,
      "doctor report must not be persisted",
    );
    const failed = (project.windowsDoctor && project.windowsDoctor.checks) || [];
    assert.ok(
      failed.filter((c) => !c.ok).length >= 3,
      "longpaths, gitBash and node22 should all be red",
    );
  });

  it("addProject git-init leaves existing files in place", async () => {
    const dir = path.join(tmpDir, "acme-pivot");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
    const project = await services.addProject(store, dir);
    assert.equal(project.name, "acme-pivot");
    assert.equal(project.path, path.resolve(dir));
    assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "hello\n");
    const inside = String(
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: dir,
        encoding: "utf8",
      }),
    ).trim();
    assert.equal(inside, "true");
  });

  it("addProject surfaces git-init failure instead of claiming the path is not a repo", async () => {
    const dir = path.join(tmpDir, "still-local");
    fs.mkdirSync(dir);
    ssh.setExecFile((bin, args, opts, cb) => {
      if (bin === "git" && args[0] === "init") {
        const err = new Error("git: not found");
        return cb(err);
      }
      execFile(bin, args, opts, cb);
    });
    await assert.rejects(
      () => services.addProject(store, dir),
      /could not initialize a git repository/i,
    );
    assert.equal(store.getProjects().length, 0, "failed init must not add the project");
  });

  it("addProject derives slug from ssh origin", async () => {
    const repo = path.join(tmpDir, "ssh-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    const project = await services.addProject(store, repo);
    assert.equal(project.slug, "acme/widgets");
    assert.equal(project.name, "widgets");
  });

  it("createThread and listThreads", async () => {
    const project = await services.addProject(
      store,
      (() => {
        const repo = path.join(tmpDir, "t-repo");
        fs.mkdirSync(repo);
        git(repo, ["init"]);
        return repo;
      })(),
    );
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });
    assert.equal(thread.projectId, project.id);
    assert.equal(thread.title, "New Thread");
    assert.equal(thread.status, "idle");
    assert.equal(thread.branch, null);
    assert.equal(thread.prNumber, null);
    assert.equal(thread.prUrl, null);
    assert.equal(thread.provider, "claude");
    assert.equal(thread.sessionId, null);
    assert.equal(thread.permissionMode, "default");
    assert.equal(thread.reasoningEffort, null);
    assert.equal(thread.worktreePath, null);
    assert.equal(thread.runStartedAt, null);
    assert.equal(thread.settledOverride, null);
    assert.equal(thread.settledAt, null);
    assert.equal(thread.prState, null);
    assert.equal(thread.pinnedAt, null);
    assert.equal(thread.snoozedUntil, null);
    assert.equal(thread.snoozedAt, null);
    assert.ok(typeof thread.createdAt === "number");
    const listed = services.listThreads(store);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, thread.id);
  });

  it("setPermissionMode validates and updates", async () => {
    const repo = path.join(tmpDir, "pm-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    const updated = services.setPermissionMode(store, {
      threadId: thread.id,
      mode: "acceptEdits",
    });
    assert.equal(updated.permissionMode, "acceptEdits");
    assert.equal(updated.sandbox.sandboxed, false);
    assert.match(updated.sandbox.reason, /--permission-mode acceptEdits/);
    assert.equal(store.getThread(thread.id).sandbox, undefined);
    assert.throws(
      () =>
        services.setPermissionMode(store, {
          threadId: thread.id,
          mode: "nope",
        }),
      /Invalid permission mode/i,
    );
  });

  it("setPermissionMode leaving plan dismisses a pending plan card (#707)", async () => {
    const repo = path.join(tmpDir, "pm-plan-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    store.updateThread(thread.id, {
      permissionMode: "plan",
      awaitingInput: true,
      pendingPlan: {
        id: "p1",
        plan: "## Steps\n\n1. Ship it",
        askedAt: 1,
      },
    });
    const updated = services.setPermissionMode(store, {
      threadId: thread.id,
      mode: "default",
    });
    assert.equal(updated.permissionMode, "default");
    assert.equal(updated.pendingPlan, null);
    assert.equal(updated.awaitingInput, false);
    assert.equal(store.getThread(thread.id).plan, undefined);
  });

  it("setPermissionMode leaves updatedAt unchanged", async () => {
    const repo = path.join(tmpDir, "pm-at-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    // Freeze updatedAt to a past stamp so any accidental bump is obvious.
    store.updateThread(thread.id, { updatedAt: 1_700_000_000_000 });
    // updateThread without touch must not rewrite updatedAt from the freeze.
    const frozen = store.getThread(thread.id);
    assert.equal(frozen.updatedAt, 1_700_000_000_000);

    const updated = services.setPermissionMode(store, {
      threadId: thread.id,
      mode: "plan",
    });
    assert.equal(updated.permissionMode, "plan");
    assert.equal(updated.updatedAt, 1_700_000_000_000);
    assert.equal(store.getThread(thread.id).updatedAt, 1_700_000_000_000);
  });

  it("createThread includes archived false", async () => {
    const repo = path.join(tmpDir, "arch-create-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    assert.equal(thread.archived, false);
    assert.equal(store.getThread(thread.id).archived, false);
  });

  it("setArchived flips without changing updatedAt", async () => {
    const repo = path.join(tmpDir, "arch-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    store.updateThread(thread.id, { updatedAt: 1_700_000_000_000 });
    assert.equal(store.getThread(thread.id).archived, false);

    const archived = services.setArchived(store, {
      threadId: thread.id,
      archived: true,
    });
    assert.equal(archived.archived, true);
    assert.equal(archived.updatedAt, 1_700_000_000_000);
    assert.equal(store.getThread(thread.id).archived, true);
    assert.equal(store.getThread(thread.id).updatedAt, 1_700_000_000_000);

    const unarchived = services.setArchived(store, {
      threadId: thread.id,
      archived: false,
    });
    assert.equal(unarchived.archived, false);
    assert.equal(unarchived.updatedAt, 1_700_000_000_000);
  });

  it("setArchived rejects unknown thread", () => {
    assert.throws(
      () =>
        services.setArchived(store, {
          threadId: "missing",
          archived: true,
        }),
      /Unknown thread/i,
    );
  });

  async function makeThread(title = "T") {
    const repo = path.join(tmpDir, `settle-${title}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    return services.createThread(store, {
      projectId: project.id,
      title,
    });
  }

  it("setSettled accepts settled, active, and null; stamps settledAt only when non-null", async () => {
    const thread = await makeThread("settle-accept");
    store.updateThread(thread.id, { updatedAt: 1_700_000_000_000 });
    const before = Date.now();

    const settled = services.setSettled(store, {
      threadId: thread.id,
      override: "settled",
    });
    assert.equal(settled.settledOverride, "settled");
    assert.ok(
      typeof settled.settledAt === "number" && settled.settledAt >= before,
      "settledAt must be stamped when override is non-null",
    );
    assert.equal(settled.updatedAt, 1_700_000_000_000);
    assert.equal(store.getThread(thread.id).updatedAt, 1_700_000_000_000);

    const active = services.setSettled(store, {
      threadId: thread.id,
      override: "active",
    });
    assert.equal(active.settledOverride, "active");
    assert.ok(typeof active.settledAt === "number");
    assert.equal(active.updatedAt, 1_700_000_000_000);

    const cleared = services.setSettled(store, {
      threadId: thread.id,
      override: null,
    });
    assert.equal(cleared.settledOverride, null);
    assert.equal(cleared.settledAt, null);
    assert.equal(cleared.updatedAt, 1_700_000_000_000);
    assert.equal(store.getThread(thread.id).settledOverride, null);
    assert.equal(store.getThread(thread.id).settledAt, null);
  });

  it("setSettled('settled') clears pin; setPinned(true) clears settled (mutual exclusion)", async () => {
    const thread = await makeThread("settle-pin-mutex");
    store.updateThread(thread.id, { updatedAt: 1_700_000_000_000 });

    // Pin first, then settle — settle must clear pin.
    const pinned = services.setPinned(store, {
      threadId: thread.id,
      pinned: true,
    });
    assert.ok(typeof pinned.pinnedAt === "number" && pinned.pinnedAt > 0);
    assert.equal(pinned.settledOverride, null);

    const settled = services.setSettled(store, {
      threadId: thread.id,
      override: "settled",
    });
    assert.equal(settled.settledOverride, "settled");
    assert.ok(settled.settledAt != null);
    assert.equal(settled.pinnedAt, null);
    assert.equal(store.getThread(thread.id).pinnedAt, null);
    assert.equal(store.getThread(thread.id).settledOverride, "settled");
    assert.equal(settled.updatedAt, 1_700_000_000_000);
    assert.equal(settled.snoozedUntil, null);
    assert.equal(settled.snoozedAt, null);

    // Pin again — must clear settled override + settledAt.
    const repin = services.setPinned(store, {
      threadId: thread.id,
      pinned: true,
    });
    assert.ok(typeof repin.pinnedAt === "number" && repin.pinnedAt > 0);
    assert.equal(repin.settledOverride, null);
    assert.equal(repin.settledAt, null);
    assert.equal(store.getThread(thread.id).settledOverride, null);
    assert.equal(store.getThread(thread.id).settledAt, null);
    assert.equal(repin.updatedAt, 1_700_000_000_000);

    // Unpin leaves settle fields alone (already null).
    const unpinned = services.setPinned(store, {
      threadId: thread.id,
      pinned: false,
    });
    assert.equal(unpinned.pinnedAt, null);
    assert.equal(unpinned.updatedAt, 1_700_000_000_000);
  });

  it("setPinned rejects unknown thread naming it", () => {
    assert.throws(
      () => services.setPinned(store, { threadId: "missing", pinned: true }),
      /Unknown thread: missing/,
    );
  });

  it("setQueued appends on a second call, clears on prompt null, does not bump updatedAt", async () => {
    const thread = await makeThread("queued-append");
    store.updateThread(thread.id, { updatedAt: 1_700_000_000_000 });

    const first = services.setQueued(store, {
      threadId: thread.id,
      prompt: "first thought",
      attachments: [{ kind: "folder", path: "/tmp/a", name: "a" }],
    });
    assert.deepEqual(first.queued, {
      prompt: "first thought",
      attachments: [{ kind: "folder", path: "/tmp/a", name: "a" }],
    });
    assert.equal(first.updatedAt, 1_700_000_000_000);
    assert.equal(store.getThread(thread.id).updatedAt, 1_700_000_000_000);

    const second = services.setQueued(store, {
      threadId: thread.id,
      prompt: "second thought",
      attachments: [{ kind: "image", path: "/tmp/b.png", name: "b.png" }],
    });
    assert.deepEqual(second.queued, {
      prompt: "first thought\n\nsecond thought",
      attachments: [
        { kind: "folder", path: "/tmp/a", name: "a" },
        { kind: "image", path: "/tmp/b.png", name: "b.png" },
      ],
    });
    assert.equal(second.updatedAt, 1_700_000_000_000);

    const cleared = services.setQueued(store, {
      threadId: thread.id,
      prompt: null,
    });
    assert.equal(cleared.queued, null);
    assert.equal(cleared.updatedAt, 1_700_000_000_000);
    assert.equal(store.getThread(thread.id).queued, null);
  });

  it("setQueued rejects unknown thread naming it", () => {
    assert.throws(
      () =>
        services.setQueued(store, { threadId: "missing", prompt: "hello" }),
      /Unknown thread: missing/,
    );
  });

  it("setQueued with replace overwrites the blob instead of appending", async () => {
    const thread = await makeThread("queued-replace");
    store.updateThread(thread.id, { updatedAt: 1_700_000_000_000 });
    services.setQueued(store, {
      threadId: thread.id,
      prompt: "first thought",
      attachments: [{ kind: "folder", path: "/tmp/a", name: "a" }],
    });

    const replaced = services.setQueued(store, {
      threadId: thread.id,
      prompt: "rewritten",
      attachments: [{ kind: "image", path: "/tmp/b.png", name: "b.png" }],
      replace: true,
    });
    assert.deepEqual(replaced.queued, {
      prompt: "rewritten",
      attachments: [{ kind: "image", path: "/tmp/b.png", name: "b.png" }],
    });
    assert.equal(replaced.updatedAt, 1_700_000_000_000);

    // Replace without attachments drops them: it is a full overwrite.
    const bare = services.setQueued(store, {
      threadId: thread.id,
      prompt: "text only",
      replace: true,
    });
    assert.deepEqual(bare.queued, { prompt: "text only" });
    assert.equal(store.getThread(thread.id).updatedAt, 1_700_000_000_000);
  });

  it("setQueued drops a previous delivery error", async () => {
    const thread = await makeThread("queued-error");
    store.updateThread(thread.id, {
      queued: { prompt: "old", error: "A run is already active" },
    });
    const next = services.setQueued(store, {
      threadId: thread.id,
      prompt: "retry this",
    });
    assert.equal(next.queued.prompt, "old\n\nretry this");
    assert.equal(next.queued.error, undefined);
  });

  it("takeQueued reads and clears without bumping updatedAt", async () => {
    const thread = await makeThread("take-queued");
    store.updateThread(thread.id, { updatedAt: 1_700_000_000_000 });
    services.setQueued(store, {
      threadId: thread.id,
      prompt: "hold this",
      attachments: [{ kind: "folder", path: "/tmp/a", name: "a" }],
    });
    const taken = services.takeQueued(store, { threadId: thread.id });
    assert.deepEqual(taken, {
      prompt: "hold this",
      attachments: [{ kind: "folder", path: "/tmp/a", name: "a" }],
    });
    assert.equal(store.getThread(thread.id).queued, null);
    assert.equal(store.getThread(thread.id).updatedAt, 1_700_000_000_000);
    assert.equal(services.takeQueued(store, { threadId: thread.id }), null);
  });

  it("setSnoozed validation table: past, now-exact, future, null clears both", async () => {
    const thread = await makeThread("snooze-table");
    store.updateThread(thread.id, { updatedAt: 1_700_000_000_000 });
    const fixedUpdated = 1_700_000_000_000;

    const past = Date.now() - 60_000;
    assert.throws(
      () =>
        services.setSnoozed(store, { threadId: thread.id, until: past }),
      (err) => {
        assert.match(String(err.message), /Snooze time .* is not in the future/);
        assert.ok(String(err.message).includes(String(past)));
        return true;
      },
    );

    const exactNow = Date.now();
    assert.throws(
      () =>
        services.setSnoozed(store, {
          threadId: thread.id,
          until: exactNow,
        }),
      /Snooze time .* is not in the future/,
    );

    const future = Date.now() + 3_600_000;
    const before = Date.now();
    const snoozed = services.setSnoozed(store, {
      threadId: thread.id,
      until: future,
    });
    assert.equal(snoozed.snoozedUntil, future);
    assert.ok(
      typeof snoozed.snoozedAt === "number" && snoozed.snoozedAt >= before,
    );
    assert.equal(snoozed.updatedAt, fixedUpdated);
    assert.equal(store.getThread(thread.id).updatedAt, fixedUpdated);

    // Working thread is still snoozable (visibility only).
    store.updateThread(thread.id, { status: "working" });
    const reSnooze = services.setSnoozed(store, {
      threadId: thread.id,
      until: Date.now() + 7_200_000,
    });
    assert.ok(reSnooze.snoozedUntil > Date.now());
    assert.equal(store.getThread(thread.id).status, "working");

    const cleared = services.setSnoozed(store, {
      threadId: thread.id,
      until: null,
    });
    assert.equal(cleared.snoozedUntil, null);
    assert.equal(cleared.snoozedAt, null);
    assert.equal(store.getThread(thread.id).snoozedUntil, null);
    assert.equal(store.getThread(thread.id).snoozedAt, null);
    assert.equal(cleared.updatedAt, fixedUpdated);
  });

  it("setSnoozed rejects unknown thread", () => {
    assert.throws(
      () =>
        services.setSnoozed(store, {
          threadId: "gone",
          until: Date.now() + 1000,
        }),
      /Unknown thread: gone/,
    );
  });

  it("pin and snooze persist across save/reload", async () => {
    const thread = await makeThread("pin-snooze-disk");
    const until = Date.now() + 86_400_000;
    services.setPinned(store, { threadId: thread.id, pinned: true });
    services.setSnoozed(store, { threadId: thread.id, until });
    const pinnedAt = store.getThread(thread.id).pinnedAt;
    const snoozedAt = store.getThread(thread.id).snoozedAt;
    assert.ok(pinnedAt != null);
    assert.ok(snoozedAt != null);

    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    const t = reloaded.getThread(thread.id);
    assert.equal(t.pinnedAt, pinnedAt);
    assert.equal(t.snoozedUntil, until);
    assert.equal(t.snoozedAt, snoozedAt);
  });

  it("setSettled('settled') unsnoozes immediately", async () => {
    const thread = await makeThread("settle-clears-snooze");
    store.updateThread(thread.id, { updatedAt: 1_700_000_000_000 });
    const until = Date.now() + 86_400_000;
    services.setSnoozed(store, { threadId: thread.id, until });
    assert.equal(store.getThread(thread.id).snoozedUntil, until);

    const settled = services.setSettled(store, {
      threadId: thread.id,
      override: "settled",
    });
    assert.equal(settled.settledOverride, "settled");
    assert.equal(settled.snoozedUntil, null);
    assert.equal(settled.snoozedAt, null);
    assert.equal(store.getThread(thread.id).snoozedUntil, null);
    assert.equal(settled.updatedAt, 1_700_000_000_000);
  });

  it("setSettled rejects settling a working thread", async () => {
    const thread = await makeThread("settle-working");
    store.updateThread(thread.id, { status: "working" });
    assert.throws(
      () =>
        services.setSettled(store, {
          threadId: thread.id,
          override: "settled",
        }),
      (err) => {
        assert.equal(
          err.message,
          "Cannot settle a thread while a run is active",
        );
        return true;
      },
    );
    // active and null stay allowed on a working thread.
    const pinned = services.setSettled(store, {
      threadId: thread.id,
      override: "active",
    });
    assert.equal(pinned.settledOverride, "active");
    const cleared = services.setSettled(store, {
      threadId: thread.id,
      override: null,
    });
    assert.equal(cleared.settledOverride, null);
  });

  it("setSettled rejects unknown override values, naming the value", async () => {
    const thread = await makeThread("settle-bad");
    assert.throws(
      () =>
        services.setSettled(store, {
          threadId: thread.id,
          override: "maybe",
        }),
      /Invalid settle override: "maybe"/,
    );
    assert.throws(
      () =>
        services.setSettled(store, {
          threadId: thread.id,
          override: undefined,
        }),
      /Invalid settle override/,
    );
  });

  it("setSettled rejects unknown thread", () => {
    assert.throws(
      () =>
        services.setSettled(store, {
          threadId: "missing",
          override: "settled",
        }),
      /Unknown thread/i,
    );
  });

  it("clearSettledOnActivity clears only a settled override (not pin/snooze fields)", () => {
    assert.deepEqual(
      services.clearSettledOnActivity({ settledOverride: "settled" }),
      { settledOverride: null, settledAt: null },
    );
    assert.deepEqual(
      services.clearSettledOnActivity({ settledOverride: "active" }),
      {},
    );
    assert.deepEqual(
      services.clearSettledOnActivity({ settledOverride: null }),
      {},
    );
    assert.deepEqual(services.clearSettledOnActivity(null), {});
    // Must not return pin/snooze wipes even when those fields are present.
    const withPinSnooze = services.clearSettledOnActivity({
      settledOverride: "settled",
      pinnedAt: 99,
      snoozedUntil: 100,
      snoozedAt: 50,
    });
    assert.deepEqual(withPinSnooze, {
      settledOverride: null,
      settledAt: null,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(withPinSnooze, "pinnedAt"), false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(withPinSnooze, "snoozedUntil"),
      false,
    );
  });

  it("deleteThread removes thread, messages, and work log", async () => {
    const repo = path.join(tmpDir, "del-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    store.appendMessage(thread.id, {
      id: "m1",
      role: "user",
      text: "hi",
      createdAt: Date.now(),
    });
    store.appendWorkLog(thread.id, {
      id: "w1",
      runId: "r1",
      label: "Step",
      done: true,
      timestamp: Date.now(),
    });

    services.deleteThread(store, { threadId: thread.id });

    assert.equal(store.getThread(thread.id), null);
    assert.deepEqual(store.getMessages(thread.id), []);
    assert.deepEqual(store.getWorkLog(thread.id), []);
    assert.equal(store.getThreads().length, 0);
  });

  it("deleteThread rejects while a run is active", async () => {
    const repo = path.join(tmpDir, "del-run-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });

    assert.throws(
      () =>
        services.deleteThread(
          store,
          { threadId: thread.id },
          { isRunning: () => true },
        ),
      /run|active|running/i,
    );
    assert.ok(store.getThread(thread.id), "thread must remain");
  });

  it("deleteThread rejects when worktreePath is set", async () => {
    const repo = path.join(tmpDir, "del-wt-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    store.updateThread(thread.id, {
      worktreePath: path.join(tmpDir, "some-worktree"),
    });

    assert.throws(
      () => services.deleteThread(store, { threadId: thread.id }),
      /Thread still has a worktree\. Merge or delete it in the Git tab first\./,
    );
    assert.ok(store.getThread(thread.id), "thread must remain");
  });

  it("createThread includes runStartedAt null", async () => {
    const repo = path.join(tmpDir, "rs-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    assert.equal(thread.runStartedAt, null);
  });

  it("getThreadDetail returns empty messages, work log, usage null", async () => {
    const repo = path.join(tmpDir, "d-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    const detail = services.getThreadDetail(store, thread.id);
    assert.equal(detail.thread.id, thread.id);
    assert.deepEqual(detail.messages, []);
    assert.deepEqual(detail.workLog, []);
    assert.equal(detail.workflow, null);
    assert.equal(detail.usage, null);
    // #436: computed on the way out, never written back to the store row.
    assert.equal(detail.thread.sandbox.sandboxed, false);
    assert.match(detail.thread.sandbox.reason, /Claude --permission-mode default/);
    assert.equal(store.getThread(thread.id).sandbox, undefined);
  });

  it("gitStatus reports branch and dirty flag", async () => {
    const repo = path.join(tmpDir, "g-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["checkout", "-b", "feature-x"]);
    // empty tree is clean
    let status = await services.gitStatus(repo);
    assert.equal(status.isRepo, true);
    assert.equal(status.branch, "feature-x");
    assert.equal(status.dirty, false);

    fs.writeFileSync(path.join(repo, "dirty.txt"), "x");
    status = await services.gitStatus(repo);
    assert.equal(status.dirty, true);
  });

  it("gitStatus uses ssh when project.remoteHost is set", async () => {
    const calls = [];
    let syncCalls = 0;
    ssh.setExecFileSync(() => {
      syncCalls += 1;
      return "";
    });
    ssh.setExecFile((bin, args, _opts, cb) => {
      calls.push({ bin, args: args.slice() });
      const remote = String(args[args.length - 1] || "");
      if (remote.includes("rev-parse")) return cb(null, "true\n");
      if (remote.includes("branch")) return cb(null, "main\n");
      if (remote.includes("status")) return cb(null, " M src/a.ts\n");
      return cb(null, "");
    });
    const status = await services.gitStatus({
      path: "/unused-local",
      remoteHost: "dev@box",
      remotePath: "/srv/app",
    });
    assert.equal(status.isRepo, true);
    assert.equal(status.branch, "main");
    assert.equal(status.dirty, true);
    assert.equal(syncCalls, 0, "gitStatus must not call execFileSync");
    assert.ok(calls.length >= 1, "ssh must be spawned");
    assert.ok(calls.every((c) => c.bin === "ssh"));
    assert.ok(calls[0].args.includes("dev@box"));
    assert.ok(calls[0].args.includes("BatchMode=yes"));
    assert.ok(calls[0].args.includes("ConnectTimeout=10"));
    assert.ok(
      calls.some((c) => /cd '\/srv\/app' && 'git'/.test(c.args[c.args.length - 1])),
      "remote command must cd then run git",
    );
  });

  it("gitFetch uses the network timeout and does not call execFileSync", async () => {
    const calls = [];
    let syncCalls = 0;
    ssh.setExecFileSync(() => {
      syncCalls += 1;
      return "";
    });
    ssh.setExecFile((bin, args, opts, cb) => {
      calls.push({ bin, args: args.slice(), opts });
      cb(null, "");
    });
    await services.gitFetch("/tmp/some-repo");
    assert.equal(syncCalls, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["fetch"]);
    assert.equal(calls[0].opts.timeout, 60_000);
  });

  it("gitFetch preserves the short error shape", async () => {
    ssh.setExecFile((_bin, _args, _opts, cb) => {
      cb(new Error("Command failed: git fetch\nfatal: unable to access"));
    });
    await assert.rejects(
      () => services.gitFetch("/tmp/some-repo"),
      (err) => {
        assert.match(err.message, /^git fetch failed: Command failed: git fetch$/);
        return true;
      },
    );
  });

  it("gitPull maps a failed pull without calling execFileSync", async () => {
    let syncCalls = 0;
    ssh.setExecFileSync(() => {
      syncCalls += 1;
      return "";
    });
    ssh.setExecFile((_bin, args, opts, cb) => {
      if (args.includes("rev-parse")) return cb(null, "true\n");
      if (args.includes("pull")) {
        assert.equal(opts.timeout, 60_000);
        return cb(
          new Error(
            "Command failed: git pull --ff-only\n" +
              "fatal: Not possible to fast-forward, aborting.",
          ),
        );
      }
      return cb(null, "");
    });
    const res = await services.gitPull("/tmp/some-repo");
    assert.equal(syncCalls, 0);
    assert.deepEqual(res, {
      ok: false,
      reason: "Branch has diverged from upstream",
    });
  });

  describe("workflow templates", () => {
    const validPhase = (over = {}) => ({
      name: "seed",
      agentCount: 1,
      instruction: "Do the thing carefully.",
      provider: "claude",
      model: null,
      ...over,
    });

    it("listTemplates returns builtin standard", () => {
      const list = services.listTemplates(store);
      assert.ok(list.some((t) => t.id === "standard" && t.builtin));
    });

    it("saveTemplate creates and validates phases", () => {
      const saved = services.saveTemplate(store, {
        name: "Mixed",
        phases: [
          validPhase({ name: "plan", provider: "claude" }),
          validPhase({ name: "code", provider: "codex", agentCount: 2 }),
        ],
      });
      assert.ok(saved.id);
      assert.equal(saved.builtin, false);
      assert.equal(saved.phases.length, 2);
    });

    it("saveTemplate rejects empty name and bad phase counts", () => {
      assert.throws(
        () =>
          services.saveTemplate(store, {
            name: "  ",
            phases: [validPhase()],
          }),
        /name is required/i,
      );
      assert.throws(
        () =>
          services.saveTemplate(store, {
            name: "X",
            phases: [],
          }),
        /1 and 6 phases/i,
      );
      assert.throws(
        () =>
          services.saveTemplate(store, {
            name: "X",
            phases: Array.from({ length: 7 }, (_, i) =>
              validPhase({ name: `p${i}` }),
            ),
          }),
        /1 and 6 phases/i,
      );
    });

    it("saveTemplate rejects invalid phase fields", () => {
      assert.throws(
        () =>
          services.saveTemplate(store, {
            name: "X",
            phases: [validPhase({ name: "" })],
          }),
        /name is required/i,
      );
      assert.throws(
        () =>
          services.saveTemplate(store, {
            name: "X",
            phases: [validPhase({ name: "a".repeat(25) })],
          }),
        /24 characters/i,
      );
      assert.throws(
        () =>
          services.saveTemplate(store, {
            name: "X",
            phases: [validPhase({ agentCount: 0 })],
          }),
        /agentCount/i,
      );
      assert.throws(
        () =>
          services.saveTemplate(store, {
            name: "X",
            phases: [validPhase({ agentCount: 1.5 })],
          }),
        /agentCount/i,
      );
      assert.throws(
        () =>
          services.saveTemplate(store, {
            name: "X",
            phases: [validPhase({ agentCount: 5 })],
          }),
        /agentCount/i,
      );
      assert.throws(
        () =>
          services.saveTemplate(store, {
            name: "X",
            phases: [validPhase({ instruction: "" })],
          }),
        /instruction is required/i,
      );
      assert.throws(
        () =>
          services.saveTemplate(store, {
            name: "X",
            phases: [validPhase({ instruction: "x".repeat(2001) })],
          }),
        /2000 characters/i,
      );
      assert.throws(
        () =>
          services.saveTemplate(store, {
            name: "X",
            phases: [validPhase({ provider: "nope" })],
          }),
        /unknown provider/i,
      );
      // A phase model now goes through the same rule as setProvider, so an
      // unlisted id is accepted. What is still refused is a malformed one.
      assert.throws(
        () =>
          services.saveTemplate(store, {
            name: "X",
            phases: [validPhase({ model: "x".repeat(101) })],
          }),
        /100 characters/i,
      );
    });

    it("saveTemplate STORES the normalized model, not the raw string", () => {
      // The validator normalized and threw the result away, so a padded id was
      // stored padded and " " + 100 chars + " " passed the length guard and
      // then stored 102 characters, defeating the guard it had just passed.
      const padded = services.saveTemplate(store, {
        name: "Padded model",
        phases: [
          validPhase({ name: "c", provider: "codex", model: "  gpt-5.5  " }),
        ],
      });
      assert.equal(padded.phases[0].model, "gpt-5.5");

      const long = services.saveTemplate(store, {
        name: "Long model",
        phases: [
          validPhase({
            name: "c",
            provider: "codex",
            model: " " + "m".repeat(100) + " ",
          }),
        ],
      });
      assert.equal(
        long.phases[0].model.length,
        100,
        "the stored id must respect the limit it was validated against",
      );
    });

    it("saveTemplate accepts listed AND custom codex models", () => {
      // Templates share setProvider's rule. Before this they diverged: filling
      // codex's model list made phases stricter than main while setProvider got
      // looser, so a template saved with a custom id threw on a no-op re-save.
      const saved = services.saveTemplate(store, {
        name: "Codex listed model",
        phases: [
          validPhase({ name: "c", provider: "codex", model: "gpt-5.5" }),
        ],
      });
      assert.equal(saved.phases[0].model, "gpt-5.5");

      const custom = services.saveTemplate(store, {
        name: "Codex custom model",
        phases: [
          validPhase({ name: "c", provider: "codex", model: "gpt-6-preview" }),
        ],
      });
      assert.equal(
        custom.phases[0].model,
        "gpt-6-preview",
        "a phase must accept an id the published list does not know",
      );
    });

    it("saveTemplate of builtin creates copy; remove rejects builtin", () => {
      const copy = services.saveTemplate(store, {
        id: "standard",
        name: "Plan and Verify",
        phases: [validPhase()],
      });
      assert.notEqual(copy.id, "standard");
      assert.equal(copy.name, "Plan and Verify (copy)");
      assert.throws(
        () => services.removeTemplate(store, { id: "standard" }),
        /Cannot remove builtin/i,
      );
      services.removeTemplate(store, { id: copy.id });
      assert.equal(
        services.listTemplates(store).find((t) => t.id === copy.id),
        undefined,
      );
    });
  });
});

describe("forkWorkerThread", () => {
  let tmpDir;
  let store;
  let repo;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-forkworker-"));
    store = new Store(path.join(tmpDir, "store.json"));
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    // addProject requires a real work tree (`git rev-parse`), not just a
    // `.git` directory. canHostWorktree still keys off `.git` existing.
    git(repo, ["init"]);
    project = await services.addProject(store, repo);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("marks the fork an orchWorker isolated in its own worktree", () => {
    const source = services.createThread(store, {
      projectId: project.id,
      title: "Orchestrator",
    });
    const worker = services.forkWorkerThread(store, { threadId: source.id });
    const stored = store.getThread(worker.id);
    assert.equal(stored.orchWorker, true);
    assert.equal(stored.pendingWorktree, true);
    assert.equal(stored.handoffFrom, source.id);
    // The source is never modified.
    assert.equal(store.getThread(source.id).orchWorker, undefined);
  });

  it("shares the checkout when the caller opts out or the project cannot host one", () => {
    const source = services.createThread(store, {
      projectId: project.id,
      title: "Orchestrator",
    });
    const optedOut = services.forkWorkerThread(store, {
      threadId: source.id,
      worktree: false,
    });
    assert.equal(store.getThread(optedOut.id).pendingWorktree, undefined);

    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    const nonRepo = services.forkWorkerThread(store, { threadId: source.id });
    assert.equal(store.getThread(nonRepo.id).pendingWorktree, undefined);
  });

  it("applies the pool default when no provider is given", () => {
    services.setSettings(store, {
      subagentPool: {
        defaultAlias: "fast",
        force: false,
        entries: [
          {
            alias: "fast",
            provider: "kimi",
            model: "kimi-for-coding-highspeed",
            description: "Fast and cheap. Good for small edits.",
          },
        ],
      },
    });
    const source = services.createThread(store, {
      projectId: project.id,
      title: "Orchestrator",
    });
    const worker = services.forkWorkerThread(store, { threadId: source.id });
    const stored = store.getThread(worker.id);
    assert.equal(stored.provider, "kimi");
    assert.equal(stored.model, "kimi-for-coding-highspeed");
    // The source (user-facing) thread is not rerouted.
    assert.equal(store.getThread(source.id).provider, source.provider);
  });

  it("force pins the default even when the lead names a provider", () => {
    services.setSettings(store, {
      subagentPool: {
        defaultAlias: "fast",
        force: true,
        entries: [
          {
            alias: "fast",
            provider: "kimi",
            model: "kimi-for-coding-highspeed",
            description: "Fast and cheap. Good for small edits.",
          },
        ],
      },
    });
    const source = services.createThread(store, {
      projectId: project.id,
      title: "Orchestrator",
    });
    const worker = services.forkWorkerThread(store, {
      threadId: source.id,
      provider: "codex",
    });
    const stored = store.getThread(worker.id);
    assert.equal(stored.provider, "kimi");
    assert.equal(stored.model, "kimi-for-coding-highspeed");
  });

  it("canHostWorktree rejects remote projects and non-repos", () => {
    assert.equal(services.canHostWorktree({ path: repo }), true);
    assert.equal(
      services.canHostWorktree({ path: repo, remoteHost: "box" }),
      false,
    );
    assert.equal(services.canHostWorktree({ path: "/nope/nowhere" }), false);
    assert.equal(services.canHostWorktree(null), false);
  });
});

describe("recordSuggestion", () => {
  let tmpDir;
  let store;
  let threadId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-suggest-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([
      { id: "p1", name: "Alpha", path: tmpDir, createdAt: 1, updatedAt: 1 },
    ]);
    const thread = services.createThread(store, {
      projectId: "p1",
      title: "Source",
    });
    threadId = thread.id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends a trimmed open entry", () => {
    const entry = services.recordSuggestion(store, {
      threadId,
      title: "  fix the flaky test  ",
      prompt: "  rewrite the race in runner.js  ",
    });
    assert.equal(entry.title, "fix the flaky test");
    assert.equal(entry.prompt, "rewrite the race in runner.js");
    assert.equal(entry.status, "open");
    assert.ok(typeof entry.id === "string" && entry.id.length > 0);
    assert.ok(typeof entry.at === "number" && entry.at > 0);
    const thread = store.getThread(threadId);
    assert.equal(thread.suggestions.length, 1);
    assert.deepEqual(thread.suggestions[0], entry);
  });

  it("truncates title and prompt to the contract caps", () => {
    const entry = services.recordSuggestion(store, {
      threadId,
      title: "t".repeat(services.SUGGESTION_TITLE_MAX + 20),
      prompt: "p".repeat(services.SUGGESTION_PROMPT_MAX + 20),
    });
    assert.equal(entry.title.length, services.SUGGESTION_TITLE_MAX);
    assert.equal(entry.prompt.length, services.SUGGESTION_PROMPT_MAX);
  });

  it("caps the list at 20 and drops the oldest", () => {
    for (let i = 0; i < services.SUGGESTIONS_MAX + 3; i++) {
      services.recordSuggestion(store, {
        threadId,
        title: `chip-${i}`,
        prompt: `do ${i}`,
      });
    }
    const suggestions = store.getThread(threadId).suggestions;
    assert.equal(suggestions.length, services.SUGGESTIONS_MAX);
    assert.equal(suggestions[0].title, "chip-3");
    assert.equal(
      suggestions[suggestions.length - 1].title,
      `chip-${services.SUGGESTIONS_MAX + 2}`,
    );
  });

  it("dedupes an open chip by lower-cased title", () => {
    const first = services.recordSuggestion(store, {
      threadId,
      title: "Fix the flaky test",
      prompt: "first prompt",
    });
    const again = services.recordSuggestion(store, {
      threadId,
      title: "fix the flaky test",
      prompt: "different prompt",
    });
    assert.equal(again.id, first.id);
    assert.equal(again.prompt, "first prompt");
    assert.equal(store.getThread(threadId).suggestions.length, 1);
  });

  it("rejects an unknown thread and a blank title or prompt", () => {
    assert.throws(
      () =>
        services.recordSuggestion(store, {
          threadId: "ghost",
          title: "x",
          prompt: "y",
        }),
      /Unknown thread: ghost/,
    );
    assert.throws(
      () =>
        services.recordSuggestion(store, {
          threadId,
          title: "   ",
          prompt: "y",
        }),
      /title must not be empty/,
    );
    assert.throws(
      () =>
        services.recordSuggestion(store, {
          threadId,
          title: "x",
          prompt: "   ",
        }),
      /prompt must not be empty/,
    );
  });
});

describe("resolveSuggestion", () => {
  let tmpDir;
  let store;
  let threadId;
  let suggestionId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-resolve-sug-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([
      { id: "p1", name: "Alpha", path: tmpDir, createdAt: 1, updatedAt: 1 },
    ]);
    const thread = services.createThread(store, {
      projectId: "p1",
      title: "Source",
    });
    threadId = thread.id;
    const entry = services.recordSuggestion(store, {
      threadId,
      title: "chip",
      prompt: "do the thing",
    });
    suggestionId = entry.id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stamps started with startedThreadId", () => {
    const updated = services.resolveSuggestion(store, {
      threadId,
      suggestionId,
      status: "started",
      startedThreadId: "fork-9",
    });
    const chip = updated.suggestions[0];
    assert.equal(chip.status, "started");
    assert.equal(chip.startedThreadId, "fork-9");
  });

  it("stamps filed with issueNumber", () => {
    const updated = services.resolveSuggestion(store, {
      threadId,
      suggestionId,
      status: "filed",
      issueNumber: 550,
    });
    const chip = updated.suggestions[0];
    assert.equal(chip.status, "filed");
    assert.equal(chip.issueNumber, 550);
  });

  it("dismisses without extra stamps", () => {
    const updated = services.resolveSuggestion(store, {
      threadId,
      suggestionId,
      status: "dismissed",
    });
    const chip = updated.suggestions[0];
    assert.equal(chip.status, "dismissed");
    assert.equal(chip.startedThreadId, undefined);
    assert.equal(chip.issueNumber, undefined);
  });

  it("rejects open, an unknown id, and an unknown thread", () => {
    assert.throws(
      () =>
        services.resolveSuggestion(store, {
          threadId,
          suggestionId,
          status: "open",
        }),
      /started, filed, dismissed/,
    );
    assert.throws(
      () =>
        services.resolveSuggestion(store, {
          threadId,
          suggestionId: "nope",
          status: "dismissed",
        }),
      /Unknown suggestion: nope/,
    );
    assert.throws(
      () =>
        services.resolveSuggestion(store, {
          threadId: "ghost",
          suggestionId,
          status: "dismissed",
        }),
      /Unknown thread: ghost/,
    );
  });
});

describe("forkThread worktree", () => {
  let tmpDir;
  let store;
  let repo;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-fork-wt-"));
    store = new Store(path.join(tmpDir, "store.json"));
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    project = await services.addProject(store, repo);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets pendingWorktree when worktree is true and the project can host one", () => {
    const source = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    const fork = services.forkThread(store, {
      threadId: source.id,
      worktree: true,
    });
    assert.equal(store.getThread(fork.id).pendingWorktree, true);
    assert.equal(
      services.forkThread(store, { threadId: source.id }).pendingWorktree,
      undefined,
    );
  });

  it("does not arm a worktree on an Ask thread or a project that cannot host one", () => {
    const source = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    services.startAsk(store, { threadId: source.id });
    const askFork = services.forkThread(store, {
      threadId: source.id,
      worktree: true,
    });
    assert.equal(askFork.ask, true);
    assert.notEqual(store.getThread(askFork.id).pendingWorktree, true);

    const other = services.createThread(store, {
      projectId: project.id,
      title: "Other",
    });
    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    const nonRepo = services.forkThread(store, {
      threadId: other.id,
      worktree: true,
    });
    assert.equal(store.getThread(nonRepo.id).pendingWorktree, undefined);
  });
});

describe("suggestedWorkNoteFor", () => {
  const {
    registerMcpServer,
    unregisterMcpServer,
  } = require("../memory-sup.js");

  afterEach(() => {
    unregisterMcpServer("coder-threads");
  });

  it("returns empty unless coder-threads is registered", () => {
    assert.equal(services.suggestedWorkNoteFor(), "");
    assert.equal(
      registerMcpServer({
        name: "coder-threads",
        port: 1234,
        token: "tok",
        userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), "suggest-note-")),
      }),
      true,
    );
    const note = services.suggestedWorkNoteFor();
    assert.match(note, /work_suggest/);
    assert.match(note, /OUT OF SCOPE/);
    unregisterMcpServer("coder-threads");
    assert.equal(services.suggestedWorkNoteFor(), "");
  });
});

