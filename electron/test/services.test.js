const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");

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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("addProject rejects a path that is not a directory", () => {
    const missing = path.join(tmpDir, "nope");
    assert.throws(
      () => services.addProject(store, missing),
      /not a directory|does not exist|directory/i,
    );
  });

  it("addProject rejects a directory that is not a git repo", () => {
    const dir = path.join(tmpDir, "plain");
    fs.mkdirSync(dir);
    assert.throws(
      () => services.addProject(store, dir),
      /git|repo|work.tree|not a git/i,
    );
  });

  it("addProject accepts a git repo and uses folder name when no remote", () => {
    const repo = path.join(tmpDir, "my-app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    // git may need identity for later ops; status/remote should work without commits
    const project = services.addProject(store, repo);
    assert.equal(project.slug, "my-app");
    assert.equal(project.name, "my-app");
    assert.equal(project.path, path.resolve(repo));
    assert.ok(project.id);
    assert.equal(store.getProjects().length, 1);
  });

  it("addProject derives slug from origin remote as owner/repo", () => {
    const repo = path.join(tmpDir, "fixture-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, [
      "remote",
      "add",
      "origin",
      "https://github.com/pingdotgg/t3code.git",
    ]);
    const project = services.addProject(store, repo);
    assert.equal(project.slug, "pingdotgg/t3code");
    assert.equal(project.name, "t3code");
  });

  it("addProject derives slug from ssh origin", () => {
    const repo = path.join(tmpDir, "ssh-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    const project = services.addProject(store, repo);
    assert.equal(project.slug, "acme/widgets");
    assert.equal(project.name, "widgets");
  });

  it("createThread and listThreads", () => {
    const project = services.addProject(
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
    assert.ok(typeof thread.createdAt === "number");
    const listed = services.listThreads(store);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, thread.id);
  });

  it("setPermissionMode validates and updates", () => {
    const repo = path.join(tmpDir, "pm-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    const updated = services.setPermissionMode(store, {
      threadId: thread.id,
      mode: "acceptEdits",
    });
    assert.equal(updated.permissionMode, "acceptEdits");
    assert.throws(
      () =>
        services.setPermissionMode(store, {
          threadId: thread.id,
          mode: "nope",
        }),
      /Invalid permission mode/i,
    );
  });

  it("setPermissionMode leaves updatedAt unchanged", () => {
    const repo = path.join(tmpDir, "pm-at-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
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

  it("createThread includes archived false", () => {
    const repo = path.join(tmpDir, "arch-create-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    assert.equal(thread.archived, false);
    assert.equal(store.getThread(thread.id).archived, false);
  });

  it("setArchived flips without changing updatedAt", () => {
    const repo = path.join(tmpDir, "arch-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
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

  it("deleteThread removes thread, messages, and work log", () => {
    const repo = path.join(tmpDir, "del-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
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

  it("deleteThread rejects while a run is active", () => {
    const repo = path.join(tmpDir, "del-run-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
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

  it("deleteThread rejects when worktreePath is set", () => {
    const repo = path.join(tmpDir, "del-wt-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
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

  it("createThread includes runStartedAt null", () => {
    const repo = path.join(tmpDir, "rs-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    assert.equal(thread.runStartedAt, null);
  });

  it("getThreadDetail returns empty messages, work log, usage null", () => {
    const repo = path.join(tmpDir, "d-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
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
  });

  it("gitStatus reports branch and dirty flag", () => {
    const repo = path.join(tmpDir, "g-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["checkout", "-b", "feature-x"]);
    // empty tree is clean
    let status = services.gitStatus(repo);
    assert.equal(status.isRepo, true);
    assert.equal(status.branch, "feature-x");
    assert.equal(status.dirty, false);

    fs.writeFileSync(path.join(repo, "dirty.txt"), "x");
    status = services.gitStatus(repo);
    assert.equal(status.dirty, true);
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
