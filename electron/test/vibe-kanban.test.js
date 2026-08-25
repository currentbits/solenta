"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { Store } = require("../store.js");
const vibe = require("../vibeKanban.js");

function uuidBuf(hex) {
  return Buffer.from(hex.replace(/-/g, ""), "hex");
}

const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const A1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
}

function writeLegacyDb(dbPath, { repoPath, worktreePath }) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE projects (
      id BLOB PRIMARY KEY,
      name TEXT NOT NULL,
      git_repo_path TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE tasks (
      id BLOB PRIMARY KEY,
      project_id BLOB NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE task_attempts (
      id BLOB PRIMARY KEY,
      task_id BLOB NOT NULL,
      worktree_path TEXT,
      branch TEXT,
      executor TEXT,
      pr_url TEXT,
      pr_number INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(
    "INSERT INTO projects (id, name, git_repo_path) VALUES (?, ?, ?)",
  ).run(uuidBuf(P1), "demo-app", repoPath);
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidBuf(T1),
    uuidBuf(P1),
    "Add rate limiting",
    "Cap the public API at 100 req/min.",
    "inprogress",
    "2026-01-02 03:04:05.000",
    "2026-01-03 03:04:05.000",
  );
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidBuf(T2),
    uuidBuf(P1),
    "Ship the landing page",
    null,
    "done",
    "2026-01-01 00:00:00.000",
    "2026-01-04 00:00:00.000",
  );
  db.prepare(
    `INSERT INTO task_attempts
      (id, task_id, worktree_path, branch, executor, pr_url, pr_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidBuf(A1),
    uuidBuf(T1),
    worktreePath,
    "vk/rate-limit",
    "CLAUDE_CODE",
    "https://github.com/acme/demo/pull/7",
    7,
    "2026-01-02 04:00:00.000",
  );
  db.close();
}

function writeV2Db(dbPath, { repoPath }) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE projects (
      id BLOB PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE repos (
      id BLOB PRIMARY KEY,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL
    );
    CREATE TABLE project_repos (
      id BLOB PRIMARY KEY,
      project_id BLOB NOT NULL,
      repo_id BLOB NOT NULL
    );
    CREATE TABLE tasks (
      id BLOB PRIMARY KEY,
      project_id BLOB NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE task_attempts (
      id BLOB PRIMARY KEY,
      task_id BLOB NOT NULL,
      container_ref TEXT,
      branch TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const repoId = uuidBuf("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(
    uuidBuf(P1),
    "v2-app",
  );
  db.prepare(
    "INSERT INTO repos (id, path, name, display_name) VALUES (?, ?, ?, ?)",
  ).run(repoId, repoPath, "v2-app", "v2-app");
  db.prepare(
    "INSERT INTO project_repos (id, project_id, repo_id) VALUES (?, ?, ?)",
  ).run(uuidBuf("ffffffff-ffff-4fff-8fff-ffffffffffff"), uuidBuf(P1), repoId);
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidBuf(T1),
    uuidBuf(P1),
    "Fix the login",
    "Users cannot sign in.",
    "todo",
    "2026-02-01 00:00:00.000",
    "2026-02-01 00:00:00.000",
  );
  db.prepare(
    `INSERT INTO task_attempts (id, task_id, container_ref, branch, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    uuidBuf(A1),
    uuidBuf(T1),
    "/tmp/does-not-exist-vk-wt",
    "vk/login",
    "2026-02-01 01:00:00.000",
  );
  db.close();
}

describe("vibeKanban helpers", () => {
  it("formats a 16-byte blob as a uuid", () => {
    assert.equal(vibe.uuidFromBlob(uuidBuf(T1)), T1);
    assert.equal(vibe.uuidFromBlob(T1.toUpperCase()), T1);
    assert.equal(
      vibe.uuidFromBlob("bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb"),
      T1,
    );
  });

  it("parses VK datetime strings as UTC", () => {
    assert.equal(vibe.parseVkTime("2026-01-02 03:04:05.000"), Date.parse("2026-01-02T03:04:05.000Z"));
  });

  it("normalizes card status spellings", () => {
    assert.equal(vibe.normalizeStatus("in progress"), "inprogress");
    assert.equal(vibe.normalizeStatus("IN_REVIEW"), "inreview");
    assert.equal(vibe.normalizeStatus("canceled"), "cancelled");
    assert.equal(vibe.normalizeStatus("todo"), "todo");
  });

  it("maps executors onto Solenta providers", () => {
    assert.equal(vibe.providerFromExecutor("CLAUDE_CODE"), "claude");
    assert.equal(vibe.providerFromExecutor("codex"), "codex");
    assert.equal(vibe.providerFromExecutor("CURSOR"), "cursor");
    assert.equal(vibe.providerFromExecutor("cursor"), "cursor");
    assert.equal(vibe.providerFromExecutor("unknown"), null);
  });
});

describe("vibeKanban detect + import", () => {
  let tmp;
  let repo;
  let worktree;
  let store;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-vk-"));
    repo = path.join(tmp, "demo-app");
    worktree = path.join(tmp, "wt-rate-limit");
    gitInit(repo);
    fs.mkdirSync(worktree);
    store = new Store(path.join(tmp, "store.json"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("finds db.v2.sqlite in a data dir, then db.sqlite", () => {
    const dir = path.join(tmp, "vk");
    fs.mkdirSync(dir);
    assert.equal(vibe.findDatabase(dir), null);
    fs.writeFileSync(path.join(dir, "db.sqlite"), "x");
    assert.equal(vibe.findDatabase(dir), path.join(dir, "db.sqlite"));
    fs.writeFileSync(path.join(dir, "db.v2.sqlite"), "x");
    assert.equal(vibe.findDatabase(dir), path.join(dir, "db.v2.sqlite"));
    assert.equal(
      vibe.findDatabase(path.join(dir, "db.v2.sqlite")),
      path.join(dir, "db.v2.sqlite"),
    );
  });

  it("previews a legacy db and imports cards as threads", async () => {
    const dataDir = path.join(tmp, "vk");
    fs.mkdirSync(dataDir);
    writeLegacyDb(path.join(dataDir, "db.sqlite"), {
      repoPath: repo,
      worktreePath: worktree,
    });

    const prev = vibe.preview(store, { dataDir });
    assert.equal(prev.found, true);
    assert.equal(prev.taskCount, 2);
    assert.equal(prev.worktreeCount, 1);
    assert.equal(prev.projects[0].name, "demo-app");
    assert.equal(prev.projects[0].exists, true);
    assert.equal(prev.alreadyImported, 0);

    const result = await vibe.importFrom(store, { dataDir });
    assert.equal(result.projectsAdded, 1);
    assert.equal(result.threadsCreated, 2);
    assert.equal(result.worktreesMapped, 1);
    assert.equal(result.threadsSkipped, 0);

    const projects = store.getProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, "demo-app");
    assert.equal(projects[0].path, path.resolve(repo));
    assert.equal(projects[0].vibeKanbanProjectId, P1);

    const threads = store.getThreads();
    const live = threads.find((t) => t.vibeKanbanTaskId === T1);
    const done = threads.find((t) => t.vibeKanbanTaskId === T2);
    assert.ok(live, "in-progress card becomes a thread");
    assert.equal(live.title, "Add rate limiting");
    assert.equal(live.branch, "vk/rate-limit");
    assert.equal(live.worktreePath, path.resolve(worktree));
    assert.equal(live.prNumber, 7);
    assert.equal(live.provider, "claude");
    assert.equal(live.settledOverride, null);
    assert.match(live.notes, /Imported from Vibe Kanban/);
    assert.equal(store.getMessages(live.id)[0].text, "Cap the public API at 100 req/min.");
    assert.equal(live.createdAt, Date.parse("2026-01-02T03:04:05.000Z"));

    assert.ok(done);
    assert.equal(done.settledOverride, "settled");
    assert.equal(done.archived, false);
    assert.equal(done.worktreePath, null);

    const again = await vibe.importFrom(store, { dataDir });
    assert.equal(again.projectsAdded, 0);
    assert.equal(again.projectsReused, 1);
    assert.equal(again.threadsCreated, 0);
    assert.equal(again.threadsSkipped, 2);
    assert.equal(store.getThreads().length, 2);
  });

  it("skips a project whose checkout is gone", async () => {
    const dataDir = path.join(tmp, "vk");
    fs.mkdirSync(dataDir);
    writeLegacyDb(path.join(dataDir, "db.sqlite"), {
      repoPath: path.join(tmp, "missing-repo"),
      worktreePath: worktree,
    });
    const result = await vibe.importFrom(store, { dataDir });
    assert.equal(result.projectsAdded, 0);
    assert.equal(result.threadsCreated, 0);
    assert.ok(result.skipped.some((s) => /no longer exists/i.test(s.reason)));
  });

  it("reads the v2 repos + container_ref schema", async () => {
    const dataDir = path.join(tmp, "vk");
    fs.mkdirSync(dataDir);
    writeV2Db(path.join(dataDir, "db.v2.sqlite"), { repoPath: repo });
    const result = await vibe.importFrom(store, { dataDir });
    assert.equal(result.projectsAdded, 1);
    assert.equal(result.threadsCreated, 1);
    assert.equal(result.worktreesMapped, 0, "missing container_ref is not mapped");
    const thread = store.getThreads()[0];
    assert.equal(thread.title, "Fix the login");
    assert.equal(thread.branch, "vk/login");
    assert.equal(thread.worktreePath, null);
    assert.equal(store.getProjects()[0].name, "v2-app");
  });

  it("reuses an already-added project by path", async () => {
    const { addProject } = require("../services.js");
    const existing = await addProject(store, repo);
    const dataDir = path.join(tmp, "vk");
    fs.mkdirSync(dataDir);
    writeLegacyDb(path.join(dataDir, "db.sqlite"), {
      repoPath: repo,
      worktreePath: worktree,
    });
    const result = await vibe.importFrom(store, { dataDir });
    assert.equal(result.projectsAdded, 0);
    assert.equal(result.projectsReused, 1);
    assert.equal(store.getProjects()[0].id, existing.id);
    assert.equal(store.getProjects()[0].vibeKanbanProjectId, P1);
  });

  it("exports projects and threads without settings", async () => {
    const dataDir = path.join(tmp, "vk");
    fs.mkdirSync(dataDir);
    writeLegacyDb(path.join(dataDir, "db.sqlite"), {
      repoPath: repo,
      worktreePath: worktree,
    });
    await vibe.importFrom(store, { dataDir });
    const dump = vibe.buildExport(store);
    assert.equal(dump.format, "solenta-export");
    assert.equal(dump.version, 1);
    assert.equal(dump.projects.length, 1);
    assert.equal(dump.threads.length, 2);
    assert.ok(dump.threads[0].messages.length >= 1);
    assert.equal(dump.settings, undefined);
  });

  it("preview reports not-found when the folder is empty", () => {
    const prev = vibe.preview(store, { dataDir: path.join(tmp, "empty") });
    assert.equal(prev.found, false);
    assert.equal(prev.dbPath, null);
  });
});
