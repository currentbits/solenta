"use strict";
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const commands = require("../projectCommands.js");
const servers = require("../devservers.js");
const { parseRepoConfig, effectiveCommands } = require("../repoConfig.js");
const { setArchived, clearSettledOnActivity } = require("../services-thread-state.js");
const temps = [];
afterEach(() => { commands.setRunCommandFn(null); servers.killAll(); for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "settle-process-")); temps.push(root);
  const project = { id: "p", path: root, ...options };
  const thread = { id: "t", projectId: "p", status: "idle", updatedAt: Date.now(), worktreePath: path.join(root, "worktree") };
  fs.mkdirSync(thread.worktreePath);
  const threads = [thread]; const messages = new Map();
  return { project, thread, threads, store: {
    getThread: (id) => threads.find((t) => t.id === id), getProject: () => project,
    getThreads: () => threads, getSettings: () => ({ autoSettleAfterDays: 3 }),
    getMessages: (id) => messages.get(id) || [], setMessages: (id, rows) => messages.set(id, rows),
    updateThread: (id, patch) => Object.assign(threads.find((t) => t.id === id), patch), save() {},
  } };
}
function startServer(id, root, platform) {
  const child = new EventEmitter(); child.pid = 0;
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
  servers.start(id, root, "dev", { platform, spawn: () => child });
  child.stdout.emit("data", "original output\n");
  return child;
}
test("config opt-ins are boolean, hashed and preserve explicit false in local overrides", () => {
  const base = { devServer: { stopOnSettle: true }, quickActions: [{ id: "dev", name: "Dev", command: "npm run dev", stopOnSettle: true }] };
  const shared = parseRepoConfig(base);
  const local = parseRepoConfig(base, { devServer: { stopOnSettle: false }, quickActions: [{ id: "dev", name: "Dev", command: "npm run dev", stopOnSettle: false }] });
  assert.equal(local.devServerStopOnSettle, false); assert.equal(local.quickActions[0].stopOnSettle, false);
  assert.notEqual(local.hash, shared.hash);
  assert.match(parseRepoConfig({ devServer: { stopOnSettle: "true" } }).error, /boolean/);
  assert.match(parseRepoConfig({ quickActions: [{ name: "Dev", command: "dev", stopOnSettle: 1 }] }).error, /boolean/);
  assert.equal(parseRepoConfig({ quickActions: [{ name: "Dev", command: "dev" }] }).quickActions[0].stopOnSettle, undefined);
  assert.equal(commands.normalizeQuickActions([{ name: "Dev", command: "dev", stopOnSettle: false }])[0].stopOnSettle, false);
});
test("managed action cancellation is opt in, preserves output, runs once and rearms with a new invocation", async () => {
  const f = fixture({ quickActions: [{ id: "dev", name: "Dev", command: "dev" }] });
  let aborts = 0; let finish;
  commands.setRunCommandFn(({ signal }) => new Promise((resolve) => {
    finish = () => resolve({ ok: false, log: "kept output", exitCode: null });
    signal.addEventListener("abort", () => { aborts++; finish(); });
  }));
  let run = commands.runCommand(f.store, { threadId: "t", actionId: "dev" });
  commands.stopManagedOnSettle(f.store, "t"); assert.equal(aborts, 0);
  f.project.stopOnSettle = true;
  commands.stopManagedOnSettle(f.store, "t"); commands.stopManagedOnSettle(f.store, "t");
  const result = await run; assert.equal(aborts, 1); assert.match(result.log, /kept output[\s\S]*stopped managed action/);
  Object.assign(f.thread, clearSettledOnActivity({ onSettleAt: 1, settledOverride: "settled" }));
  run = commands.runCommand(f.store, { threadId: "t", actionId: "dev" });
  commands.stopManagedOnSettle(f.store, "t"); await run; assert.equal(aborts, 2);
  f.project.quickActions[0].stopOnSettle = false;
  run = commands.runCommand(f.store, { threadId: "t", actionId: "dev" });
  commands.stopManagedOnSettle(f.store, "t"); assert.equal(aborts, 2); finish(); await run;
});
test("shared checkout action waits for other active project threads; worktree action does not", async () => {
  const f = fixture({ stopOnSettle: true, quickActions: [{ id: "dev", name: "Dev", command: "dev" }] });
  const ownWorktree = f.thread.worktreePath;
  f.thread.worktreePath = null; f.thread.archived = true;
  f.threads.push({ id: "other", projectId: "p", status: "idle", updatedAt: Date.now() });
  let aborts = 0;
  commands.setRunCommandFn(({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => { aborts++; resolve({ log: "shared" }); })));
  let run = commands.runCommand(f.store, { threadId: "t", actionId: "dev" });
  commands.sweepManagedOnSettle(f.store); assert.equal(aborts, 0);
  f.threads[1].archived = true; commands.sweepManagedOnSettle(f.store); await run; assert.equal(aborts, 1);
  f.thread.worktreePath = ownWorktree; f.threads[1].archived = false;
  run = commands.runCommand(f.store, { threadId: "t", actionId: "dev" });
  // Merge cleanup clears the mutable worktree field before the settle hook.
  f.thread.worktreePath = null;
  assert.equal(commands.sweepManagedOnSettle(f.store), 0); await run; assert.equal(aborts, 2);
});
test("archive and PR/explicit settle hook stop only managed resources and keep already-exited server logs", async () => {
  const f = fixture({ stopOnSettle: true, quickActions: [{ id: "dev", name: "Dev", command: "dev" }] });
  commands.setRunCommandFn(({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ log: "archive output" }))));
  const run = commands.runCommand(f.store, { threadId: "t", actionId: "dev" });
  setArchived(f.store, { threadId: "t", archived: true }); await run;
  startServer("t", f.thread.worktreePath, "win32");
  await commands.runOnSettle({ store: f.store, threadId: "t" });
  assert.deepEqual(servers.status("t").lastLines, ["original output"]);
  await commands.runOnSettle({ store: f.store, threadId: "t" });
  assert.deepEqual(servers.status("t").lastLines, ["original output"]);
});
test("repo server opt-in requires trust and project false survives repo true", () => {
  const f = fixture(); fs.writeFileSync(path.join(f.project.path, "solenta.json"), JSON.stringify({ devServer: { stopOnSettle: true } }));
  assert.equal(effectiveCommands(f.project).trusted, false);
  f.project.repoConfigTrust = parseRepoConfig({ devServer: { stopOnSettle: true } }).hash;
  assert.equal(effectiveCommands(f.project).trusted, true);
  f.project.stopOnSettle = false;
  assert.equal(commands.sweepManagedOnSettle(f.store), 0);
});
test("inactivity respects active runs, pin, override, open/linked PRs and merge setting", () => {
  const f = fixture(); const old = Date.now() - 4 * 86400000;
  f.thread.updatedAt = old; assert.equal(commands.managedOwnerSettled(f.store, f.thread), true);
  for (const patch of [{ status: "working" }, { pinnedAt: 1 }, { settledOverride: "active" }, { prState: "OPEN" }, { prLinks: [{ number: 1, state: "OPEN" }, { number: 2, state: "MERGED" }] }, { prState: "OPEN", prLinks: [{ number: 1, state: "UNKNOWN" }] }]) {
    assert.equal(commands.managedOwnerSettled(f.store, { ...f.thread, ...patch }), false);
  }
  f.store.getSettings = () => ({ autoSettleAfterDays: null, autoSettleOnMerge: false });
  assert.equal(commands.managedOwnerSettled(f.store, { ...f.thread, prState: "MERGED" }), false);
  assert.equal(commands.managedOwnerSettled(f.store, { ...f.thread, prState: "CLOSED" }), true);
});

test("missing inactivity setting uses the application default", () => {
  const f = fixture(); f.store.getSettings = () => ({});
  assert.equal(commands.managedOwnerSettled(f.store, { ...f.thread, updatedAt: Date.now() - 8 * 86400000 }), true);
  assert.equal(commands.managedOwnerSettled(f.store, { ...f.thread, updatedAt: Date.now() - 6 * 86400000 }), false);
});

test("live server stop keeps logs, stops once, and uses captured launch ownership on Windows", (t) => {
  const f = fixture({ stopOnSettle: true });
  f.threads.push({ id: "other", projectId: "p", status: "working" });
  const signals = []; let alive = true;
  t.mock.method(process, "kill", (pid, signal) => {
    if (signal === 0) { if (!alive) throw new Error("gone"); return true; }
    signals.push([pid, signal]); alive = false; return true;
  });
  const child = new EventEmitter(); child.pid = 987654;
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
  servers.start("t", f.thread.worktreePath, "dev", { platform: "win32", spawn: () => child });
  child.stdout.emit("data", "server output\n");
  f.thread.worktreePath = null;
  commands.stopManagedOnSettle(f.store, "t"); child.emit("exit", 0);
  commands.stopManagedOnSettle(f.store, "t");
  assert.deepEqual(signals, [[987654, "SIGTERM"]]);
  assert.deepEqual(servers.status("t").lastLines, ["server output", "", "[settle] stopped managed dev server"]);
});

test("watch is lazy, unref'd, and removed as soon as the final opted-in action exits", async (t) => {
  const f = fixture({ quickActions: [{ id: "dev", name: "Dev", command: "dev" }] });
  let started = 0; let unref = 0; let cleared = 0; let finish;
  const timer = { unref: () => { unref++; } };
  t.mock.method(global, "setInterval", () => { started++; return timer; });
  t.mock.method(global, "clearInterval", (value) => { if (value === timer) cleared++; });
  commands.watchManagedOnSettle(f.store); assert.equal(started, 0);
  f.project.stopOnSettle = true;
  commands.setRunCommandFn(() => new Promise((resolve) => { finish = () => resolve({ log: "finished" }); }));
  const run = commands.runCommand(f.store, { threadId: "t", actionId: "dev" });
  assert.equal(started, 1); assert.equal(unref, 1);
  finish(); await run; assert.equal(cleared, 1);
  commands.watchManagedOnSettle(f.store); assert.equal(started, 1);
});

test("server policy needs repo trust, and explicit project false overrides repo true", (t) => {
  const f = fixture();
  fs.writeFileSync(path.join(f.project.path, "solenta.json"), JSON.stringify({ devServer: { stopOnSettle: true } }));
  let signals = 0;
  t.mock.method(process, "kill", (_pid, signal) => { if (signal !== 0) signals++; return true; });
  const child = new EventEmitter(); child.pid = 987655;
  servers.start("t", f.thread.worktreePath, "dev", { spawn: () => child });
  commands.stopManagedOnSettle(f.store, "t"); assert.equal(signals, 0);
  f.project.repoConfigTrust = parseRepoConfig({ devServer: { stopOnSettle: true } }).hash;
  f.project.stopOnSettle = false;
  commands.stopManagedOnSettle(f.store, "t"); assert.equal(signals, 0);
  delete f.project.stopOnSettle;
  commands.stopManagedOnSettle(f.store, "t"); assert.equal(signals, 1);
});
