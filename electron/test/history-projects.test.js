"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { discoverHistoryProjects, unflattenPath } = require("../recentRepos.js");

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

  it("unflattens a Cursor dir name back to the existing folder", () => {
    const flat = dirs.web.replace(/[^A-Za-z0-9]/g, "-");
    assert.equal(unflattenPath(flat, new Map()), dirs.web);
    assert.equal(unflattenPath(flat + "-nope", new Map()), null);
  });
});
