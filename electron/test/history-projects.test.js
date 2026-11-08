"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  discoverHistoryProjects,
  discoverHistoryProjectsAsync,
  unflattenPath,
} = require("../recentRepos.js");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

describe("discoverHistoryProjects (#1858)", () => {
  let root;
  let home;
  let homes;
  let dirs;
  const DAY = 86_400_000;
  const NOW = Date.now();

  /** Write a session file and date it `daysAgo`. */
  function session(file, body, daysAgo) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    const t = new Date(NOW - daysAgo * DAY);
    fs.utimesSync(file, t, t);
  }
  const claude = (group, id, cwd, daysAgo) =>
    session(
      path.join(homes.claude, "projects", group, `${id}.jsonl`),
      `{"type":"summary"}\n{"type":"user","cwd":${JSON.stringify(cwd)}}\n`,
      daysAgo,
    );
  let codexN = 0;
  const codex = (id, cwd, daysAgo) => {
    codexN += 1;
    session(
      path.join(homes.codex, "sessions", "2026", "11", "0" + codexN, `rollout-2026-11-0${codexN}T10-00-00-${id}.jsonl`),
      `{"type":"session_meta","payload":{"id":"${id}","cwd":${JSON.stringify(cwd)}}}\n`,
      daysAgo,
    );
  };

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "history-projects-")));
    home = path.join(root, "home");
    const repo = (name) => {
      const dir = path.join(home, "code", name);
      fs.mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q");
      git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
      return dir;
    };
    dirs = {
      app: repo("app"),
      api: repo("api"),
      added: repo("added"),
      web: repo("web-site"),
      plain: path.join(home, "notes"),
      missing: path.join(home, "code", "deleted"),
      tmp: path.join(root, "tmp", "scratch"),
      solentaWt: path.join(root, "solenta", "worktrees", "t1"),
      orphanWt: path.join(home, "wt", "orphan"),
    };
    fs.mkdirSync(path.join(dirs.app, "src"));
    fs.mkdirSync(dirs.plain);
    fs.mkdirSync(dirs.tmp, { recursive: true });
    fs.mkdirSync(dirs.solentaWt, { recursive: true });
    fs.mkdirSync(dirs.orphanWt, { recursive: true });
    fs.writeFileSync(path.join(dirs.orphanWt, ".git"), `gitdir: ${path.join(home, "gone", ".git", "worktrees", "orphan")}\n`);
    dirs.apiWt = path.join(home, "wt", "api-feature");
    git(dirs.api, "worktree", "add", "-q", "-b", "feature", dirs.apiWt);
    fs.symlinkSync(dirs.app, path.join(home, "app-link"));

    homes = {
      claude: path.join(home, ".claude"),
      codex: path.join(home, ".codex"),
      grok: path.join(home, ".grok"),
      kimi: path.join(home, ".kimi"),
      opencode: path.join(home, "opencode"),
      cursor: path.join(home, ".cursor"),
      muse: path.join(home, "muse"),
    };
    // app: two Claude sessions, a Codex one from a subdir, one via a symlink.
    claude("-x-app", "aaaa0001", dirs.app, 3);
    claude("-x-app", "aaaa0002", dirs.app, 2);
    codex("cccc0001", path.join(dirs.app, "src"), 1);
    codex("cccc0002", path.join(home, "app-link"), 4);
    // api: only ever used from a linked worktree.
    codex("cccc0003", dirs.apiWt, 0.5);
    // plain folder, no git: kept.
    claude("-x-notes", "aaaa0003", dirs.plain, 5);
    // Left out: already added, gone, temp, home, Solenta worktree, orphan worktree.
    claude("-x-added", "aaaa0004", dirs.added + "/", 0.1);
    claude("-x-deleted", "aaaa0005", dirs.missing, 0.1);
    claude("-x-tmp", "aaaa0006", dirs.tmp, 0.1);
    claude("-x-home", "aaaa0007", home, 0.1);
    codex("cccc0004", dirs.solentaWt, 0.1);
    codex("cccc0005", dirs.orphanWt, 0.1);
    // Cursor: the dir name is the flattened path ("-" for "/" and "-").
    session(
      path.join(homes.cursor, "projects", dirs.web.replace(/[^A-Za-z0-9]/g, "-").replace(/^-/, ""), "agent-transcripts", "dddd0001", "dddd0001.jsonl"),
      "{}\n",
      6,
    );
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("lists each folder once, newest first, with CLIs, counts and recent sessions", () => {
    const rows = discoverHistoryProjects({
      homes,
      homeDir: home,
      existingPaths: [dirs.added + "/"],
      tmpRoots: [path.join(root, "tmp")],
      worktreeRoots: [path.join(root, "solenta", "worktrees")],
    });
    const shape = rows.map((r) => [
      path.relative(home, r.path),
      [...r.providers].sort().join("+"),
      r.sessions,
    ]);
    assert.deepEqual(shape, [
      ["code/api", "codex", 1],
      ["code/app", "claude+codex", 4],
      ["notes", "claude", 1],
      ["code/web-site", "cursor", 1],
    ]);
    const app = rows.find((r) => r.name === "app");
    assert.equal(Math.round((NOW - app.lastActiveAt) / DAY), 1, "newest session wins");
    assert.deepEqual(app.recentSessions, [
      { provider: "codex", sessionId: "cccc0001" },
      { provider: "claude", sessionId: "aaaa0002" },
      { provider: "claude", sessionId: "aaaa0001" },
    ]);
  });

  it("returns nothing when no CLI has sessions", () => {
    const empty = path.join(root, "empty");
    const rows = discoverHistoryProjects({
      homes: { claude: empty, codex: empty, grok: empty, kimi: empty, opencode: empty, cursor: empty, muse: empty },
      homeDir: home,
      tmpRoots: [],
    });
    assert.deepEqual(rows, []);
  });

  it("maps a symlink to a repository subdirectory back to its project", () => {
    const base = path.join(root, "linked-subdir");
    const linked = path.join(base, "source-link");
    const claudeHome = path.join(base, ".claude");
    fs.mkdirSync(base);
    fs.symlinkSync(path.join(dirs.app, "src"), linked);
    session(
      path.join(claudeHome, "projects", "-linked", "linked001.jsonl"),
      JSON.stringify({ type: "user", cwd: linked }) + "\n",
      1,
    );
    const opts = {
      homes: { ...homes, claude: claudeHome, codex: path.join(base, ".codex"), cursor: path.join(base, ".cursor") },
      homeDir: home,
      tmpRoots: [],
    };
    assert.deepEqual(discoverHistoryProjects(opts).map((r) => r.path), [dirs.app]);
    assert.deepEqual(discoverHistoryProjects({ ...opts, existingPaths: [dirs.app] }), []);
  });

  it("scans off the main thread: the event loop keeps ticking while it runs", async () => {
    // Enough history that a sync scan would hold the loop for a while.
    const big = path.join(root, "big");
    const bigHomes = { ...homes, claude: path.join(big, ".claude"), codex: path.join(big, ".codex") };
    for (let i = 0; i < 400; i++) {
      const dir = path.join(big, "work", `p${i}`);
      fs.mkdirSync(dir, { recursive: true });
      const line = `{"type":"user","cwd":${JSON.stringify(dir)}}\n`;
      for (let j = 0; j < 3; j++) {
        fs.mkdirSync(path.join(bigHomes.claude, "projects", `-p${i}`), { recursive: true });
        fs.writeFileSync(path.join(bigHomes.claude, "projects", `-p${i}`, `b${i}x${j}.jsonl`), line);
      }
      const day = path.join(bigHomes.codex, "sessions", "2026", "11", "05");
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(
        path.join(day, `rollout-2026-11-05T10-00-00-c${i}.jsonl`),
        `{"type":"session_meta","payload":{"cwd":${JSON.stringify(dir)}}}\n`,
      );
    }
    let ticks = 0;
    let done = false;
    const tick = () => {
      if (done) return;
      ticks += 1;
      setImmediate(tick);
    };
    setImmediate(tick);
    const rows = await discoverHistoryProjectsAsync({ homes: bigHomes, homeDir: big, tmpRoots: [] });
    done = true;
    assert.equal(rows.length, 200, "capped at 200");
    assert.equal(rows[0].sessions, 4, "3 Claude + 1 Codex");
    // A sync scan inside the promise would let at most one tick through.
    assert.ok(ticks > 5, `event loop ticked ${ticks} times during the scan`);
  });

  it("reuses the scan for a minute unless the project list changes", async () => {
    const opts = { homes, homeDir: home, tmpRoots: [path.join(root, "tmp")], existingPaths: [dirs.added] };
    const first = discoverHistoryProjectsAsync(opts);
    assert.equal(discoverHistoryProjectsAsync({ ...opts }), first, "same inputs: cached");
    assert.notEqual(
      discoverHistoryProjectsAsync({ ...opts, existingPaths: [dirs.added, dirs.app] }),
      first,
      "a newly added project rescans",
    );
    const names = (await first).map((r) => r.name);
    assert.ok(names.includes("app") && !names.includes("added"));
  });

  it("splits one Claude dir shared by my-app and my/app by each session's own cwd", () => {
    const base = path.join(root, "clash");
    const dash = path.join(base, "code", "my-app");
    const slash = path.join(base, "code", "my", "app");
    fs.mkdirSync(dash, { recursive: true });
    fs.mkdirSync(slash, { recursive: true });
    const clashHomes = { ...homes, claude: path.join(base, ".claude"), codex: path.join(base, ".codex"), cursor: path.join(base, ".cursor") };
    // Claude flattens both to the same dir name.
    const group = dash.replace(/[^A-Za-z0-9]/g, "-");
    assert.equal(group, slash.replace(/[^A-Za-z0-9]/g, "-"));
    const write = (id, cwd, daysAgo, pad = "") =>
      session(
        path.join(clashHomes.claude, "projects", group, `${id}.jsonl`),
        `{"type":"summary","pad":"${pad}"}\n{"type":"user","cwd":${JSON.stringify(cwd)}}\n`,
        daysAgo,
      );
    write("dash0001", dash, 1);
    write("dash0002", dash, 3);
    // Newest file in the dir is my/app, with its cwd past the first 64KB.
    write("slash001", slash, 0.5, "x".repeat(100 * 1024));
    const rows = discoverHistoryProjects({ homes: clashHomes, homeDir: base, tmpRoots: [] });
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
    assert.deepEqual(Object.keys(byPath).sort(), [slash, dash].sort());
    assert.equal(byPath[dash].sessions, 2);
    assert.equal(byPath[slash].sessions, 1);
    assert.deepEqual(byPath[dash].recentSessions.map((r) => r.sessionId), ["dash0001", "dash0002"]);
    assert.deepEqual(byPath[slash].recentSessions.map((r) => r.sessionId), ["slash001"]);
  });

  it("unflattens a Cursor dir name back to the existing folder", () => {
    const flat = dirs.web.replace(/[^A-Za-z0-9]/g, "-");
    assert.equal(unflattenPath(flat, new Map()), dirs.web);
    assert.equal(unflattenPath(flat + "-nope", new Map()), null);
  });
});
