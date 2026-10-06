"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { discoverRecentRepos } = require("../recentRepos.js");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/** Every file under `dir` with its bytes, to prove the scan wrote nothing. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

describe("discoverRecentRepos (#1501)", () => {
  let root;
  let homes;
  let repos;
  const DAY = 86_400_000;
  const NOW = Date.parse("2026-10-06T12:00:00Z");

  /** Write a session file and date it `daysAgo`. */
  function session(file, body, daysAgo) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    const t = new Date(NOW - daysAgo * DAY);
    fs.utimesSync(file, t, t);
  }

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "recent-repos-")));
    const repo = (name, remote) => {
      const dir = path.join(root, "code", name);
      fs.mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q");
      if (remote) git(dir, "remote", "add", "origin", remote);
      git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
      return dir;
    };
    repos = {
      shop: repo("shop", "git@github.com:acme/shop.git"),
      shopClone: repo("shop-clone", "https://github.com/acme/shop"),
      api: repo("api", "git@github.com:acme/api.git"),
      local: repo("local", null),
      added: repo("added", "git@github.com:acme/added.git"),
    };
    repos.apiWorktree = path.join(root, "wt", "api-feature");
    git(repos.api, "worktree", "add", "-q", "-b", "feature", repos.apiWorktree);
    const plain = path.join(root, "not-a-repo");
    fs.mkdirSync(plain);

    homes = {
      claude: path.join(root, "claude"),
      codex: path.join(root, "codex"),
      grok: path.join(root, "grok"),
      kimi: path.join(root, "kimi"),
      opencode: path.join(root, "opencode"),
    };
    // Claude: cwd on a later jsonl line.
    session(
      path.join(homes.claude, "projects", "-x-shop", "11111111-aaaa.jsonl"),
      `{"type":"summary"}\n{"type":"user","cwd":${JSON.stringify(repos.shop)}}\n`,
      1,
    );
    session(
      path.join(homes.claude, "projects", "-x-plain", "22222222-bbbb.jsonl"),
      `{"type":"user","cwd":${JSON.stringify(plain)}}\n`,
      0,
    );
    // Codex: session_meta cwd, from a linked worktree of api.
    session(
      path.join(homes.codex, "sessions", "2026", "10", "05", "rollout-2026-10-05T10-00-00-0199aaaa-bbbb.jsonl"),
      `{"type":"session_meta","payload":{"id":"x","cwd":${JSON.stringify(repos.apiWorktree)}}}\n`,
      0.5,
    );
    // Grok: the cwd is the URL-encoded group directory.
    session(
      path.join(homes.grok, "sessions", encodeURIComponent(repos.shopClone), "s1", "chat_history.jsonl"),
      "{}\n",
      3,
    );
    session(
      path.join(homes.grok, "sessions", encodeURIComponent(repos.added), "s2", "chat_history.jsonl"),
      "{}\n",
      0.1,
    );
    // Kimi: cwd in <session>/state.json.
    const kimiSession = path.join(homes.kimi, "sessions", "wd_local_abc", "session_1");
    session(path.join(kimiSession, "agents", "main", "wire.jsonl"), "{}\n", 30);
    fs.writeFileSync(path.join(kimiSession, "state.json"), JSON.stringify({ cwd: repos.local }));
    // OpenCode: the session table's directory column.
    const { DatabaseSync } = require("node:sqlite");
    fs.mkdirSync(homes.opencode, { recursive: true });
    const db = new DatabaseSync(path.join(homes.opencode, "opencode.db"));
    db.exec("CREATE TABLE session (id TEXT, directory TEXT, time_updated INTEGER)");
    db.prepare("INSERT INTO session VALUES (?, ?, ?)").run("ses_1", repos.api, NOW - 2 * DAY);
    db.close();
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("groups recent checkouts by remote, maps worktrees home, pre-selects the newest", async () => {
    const before = snapshot(root);
    const groups = await discoverRecentRepos({
      homes,
      existingPaths: [repos.added + "/"],
      now: NOW,
      tmpRoots: [],
    });
    assert.deepEqual(snapshot(root), before, "the scan is read-only");

    const shape = groups.map((g) => ({
      remote: g.remote,
      repos: g.repos.map((r) => [path.relative(root, r.path), r.providers.sort().join("+"), r.preselected]),
    }));
    assert.deepEqual(shape, [
      // The worktree session counts for api; codex 0.5d beats opencode 2d.
      { remote: "acme/api", repos: [["code/api", "codex+opencode", true]] },
      // Two clones of one remote share a group; only the newest is ticked.
      {
        remote: "acme/shop",
        repos: [
          ["code/shop", "claude", true],
          ["code/shop-clone", "grok", false],
        ],
      },
      // 30 days old: listed, not ticked. No remote: a group of its own.
      { remote: null, repos: [["code/local", "kimi", false]] },
    ]);
  });

  it("returns nothing when no CLI has sessions", async () => {
    const empty = path.join(root, "empty");
    const groups = await discoverRecentRepos({
      homes: { claude: empty, codex: empty, grok: empty, kimi: empty, opencode: empty },
      tmpRoots: [],
    });
    assert.deepEqual(groups, []);
    assert.equal(fs.existsSync(empty), false, "missing homes are not created");
  });
});
