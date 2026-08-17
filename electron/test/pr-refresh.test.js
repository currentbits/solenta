"use strict";

/**
 * Round 47: PR-state freshness (background refresher).
 *
 * Structural gates this suite enforces:
 * - gh is async + strictly serialized (timestamps prove no overlap)
 * - terminal MERGED/CLOSED and archived threads never spawn gh
 * - zero qualifying threads → zero spawns
 * - change → one save + one threads:changed; no-change → neither
 * - per-thread failure/timeout is silent and does not block the next thread
 * - overlap latch: a second trigger during a pass is a no-op
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  setupWorktree,
  refreshPrStates,
  createPrStateRefresher,
  isPrRefreshCandidate,
  PR_REFRESH_TIMEOUT_MS,
} = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Fake gh for refresh tests. Looks up by PR number (refreshPrStates uses
 * `gh pr view <number>`). Optional delayMs + failNumbers for isolation tests.
 * Records startedAt/endedAt per call so serialization can be proven.
 * @param {string} dir
 * @returns {string}
 */
function writeRefreshFakeGh(dir) {
  const bin = path.join(dir, "fake-gh-refresh");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");

const statePath = process.env.CODER_FAKE_GH_STATE;
if (!statePath) {
  process.stderr.write("fake-gh-refresh: CODER_FAKE_GH_STATE not set\\n");
  process.exit(2);
}

function load() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}
function save(s) {
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2), "utf8");
}

const args = process.argv.slice(2);
const startedAt = Date.now();
const state = load();
state.calls = state.calls || [];
state.callLog = state.callLog || [];
state.calls.push(args.slice());
const callEntry = { args: args.slice(), startedAt, endedAt: null, pid: process.pid };
state.callLog.push(callEntry);
save(state);

const delayMs = Number(state.delayMs || 0);
if (delayMs > 0) {
  const end = Date.now() + delayMs;
  while (Date.now() < end) {
    /* deliberate busy-wait so timeout kill is observable */
  }
}

// Re-load after delay so mid-run state mutations (failNumbers) apply.
const live = load();
const scenario = live.scenario || "success";

function finish(code, stdout, stderr) {
  const s = load();
  s.callLog = s.callLog || [];
  // Match this process's open entry.
  for (let i = s.callLog.length - 1; i >= 0; i--) {
    if (s.callLog[i].pid === process.pid && s.callLog[i].endedAt == null) {
      s.callLog[i].endedAt = Date.now();
      break;
    }
  }
  save(s);
  if (stderr) process.stderr.write(stderr);
  if (stdout) process.stdout.write(stdout);
  process.exit(code);
}

if (scenario === "timeout") {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    /* hang until parent timeout kills us */
  }
  finish(0, "", "");
}

if (scenario === "enoent-like") {
  finish(127, "", "command not found\\n");
}

if (args[0] === "pr" && args[1] === "view") {
  const key = String(args[2] || "");
  const num = Number(key);
  const failSet = new Set((live.failNumbers || []).map(Number));
  if (failSet.has(num)) {
    finish(1, "", "HTTP 500: transient failure for PR " + key + "\\n");
  }
  // Prefer prsByNumber; fall back to scanning prs values.
  let pr = live.prsByNumber && live.prsByNumber[key];
  if (!pr && live.prs) {
    for (const v of Object.values(live.prs)) {
      if (v && Number(v.number) === num) {
        pr = v;
        break;
      }
    }
  }
  if (!pr) {
    finish(1, "", "no pull requests found for \\"" + key + "\\"\\n");
  }
  finish(
    0,
    JSON.stringify({
      number: pr.number,
      url: pr.url,
      state: pr.state || "OPEN",
    }) + "\\n",
    "",
  );
}

finish(2, "", "fake-gh-refresh: unhandled argv " + JSON.stringify(args) + "\\n");
`;
  fs.writeFileSync(bin, body, { mode: 0o755 });
  return bin;
}

/**
 * One project + worktree + github origin + fake gh env.
 * @returns {{
 *   tmpDir: string,
 *   store: import('../store').Store,
 *   project: object,
 *   thread: object,
 *   worktreePath: string,
 *   branch: string,
 *   statePath: string,
 *   fakeGh: string,
 * }}
 */
async function makeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-pr-refresh-"));
  const store = new Store(path.join(tmpDir, "store.json"));
  const worktreeBase = path.join(tmpDir, "worktrees");

  const repo = path.join(tmpDir, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  try {
    git(repo, ["checkout", "-b", "main"]);
  } catch {
    // already on main
  }

  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, {
    projectId: project.id,
    title: "PR freshness thread",
  });
  const setup = setupWorktree({
    store,
    threadId: thread.id,
    worktreeBase,
    broadcast: () => {},
  });
  fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "feat\n");
  git(setup.worktreePath, ["add", "feature.txt"]);
  git(setup.worktreePath, ["commit", "-m", "feature"]);

  const bare = path.join(tmpDir, "remote.git");
  git(tmpDir, ["init", "--bare", bare]);
  git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
  git(repo, ["remote", "set-url", "--push", "origin", bare]);

  const fakeDir = path.join(tmpDir, "fake-bin");
  fs.mkdirSync(fakeDir, { recursive: true });
  const fakeGh = writeRefreshFakeGh(fakeDir);
  const statePath = path.join(tmpDir, "gh-state.json");
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      scenario: "success",
      prsByNumber: {},
      calls: [],
      callLog: [],
      delayMs: 0,
      failNumbers: [],
    }),
    "utf8",
  );
  process.env.CODER_GH_BIN = fakeGh;
  process.env.CODER_FAKE_GH_STATE = statePath;

  return {
    tmpDir,
    store,
    project,
    thread: store.getThread(thread.id),
    worktreePath: setup.worktreePath,
    branch: setup.branch,
    statePath,
    fakeGh,
  };
}

/**
 * Second thread in the same store/repo (separate worktree).
 */
function addSecondThread(fx, title) {
  const thread = services.createThread(fx.store, {
    projectId: fx.project.id,
    title: title || "Second",
  });
  const worktreeBase = path.join(fx.tmpDir, "worktrees");
  const setup = setupWorktree({
    store: fx.store,
    threadId: thread.id,
    worktreeBase,
    broadcast: () => {},
  });
  fs.writeFileSync(path.join(setup.worktreePath, "b.txt"), "b\n");
  git(setup.worktreePath, ["add", "b.txt"]);
  git(setup.worktreePath, ["commit", "-m", "b"]);
  return storeThread(fx.store, thread.id);
}

function storeThread(store, id) {
  return store.getThread(id);
}

function seedOpenPr(fx, threadId, number, state) {
  const st = state || "OPEN";
  const url = `https://github.com/acme/demo/pull/${number}`;
  fx.store.updateThread(threadId, {
    prNumber: number,
    prUrl: url,
    prState: st === "null" ? null : st,
  });
  fx.store.saveNow();
  const gh = JSON.parse(fs.readFileSync(fx.statePath, "utf8"));
  gh.prsByNumber = gh.prsByNumber || {};
  gh.prsByNumber[String(number)] = { number, url, state: st === "null" ? "OPEN" : st };
  fs.writeFileSync(fx.statePath, JSON.stringify(gh, null, 2), "utf8");
  return { number, url, state: st === "null" ? "OPEN" : st };
}

function readGhState(fx) {
  return JSON.parse(fs.readFileSync(fx.statePath, "utf8"));
}

function setGhState(fx, patch) {
  const gh = readGhState(fx);
  Object.assign(gh, patch);
  fs.writeFileSync(fx.statePath, JSON.stringify(gh, null, 2), "utf8");
}

describe("refreshPrStates (round 47)", () => {
  const prevGhBin = process.env.CODER_GH_BIN;
  const prevGhState = process.env.CODER_FAKE_GH_STATE;
  /** @type {ReturnType<typeof makeFixture> | null} */
  let fx = null;

  afterEach(() => {
    if (prevGhBin === undefined) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGhBin;
    if (prevGhState === undefined) delete process.env.CODER_FAKE_GH_STATE;
    else process.env.CODER_FAKE_GH_STATE = prevGhState;
    if (fx) {
      try {
        fs.rmSync(fx.tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      fx = null;
    }
  });

  it("isPrRefreshCandidate: archived and terminal states excluded", () => {
    assert.equal(
      isPrRefreshCandidate({
        archived: false,
        prNumber: 1,
        prState: "OPEN",
      }),
      true,
    );
    assert.equal(
      isPrRefreshCandidate({
        archived: false,
        prNumber: 1,
        prState: null,
      }),
      true,
    );
    assert.equal(
      isPrRefreshCandidate({
        archived: true,
        prNumber: 1,
        prState: "OPEN",
      }),
      false,
    );
    assert.equal(
      isPrRefreshCandidate({
        archived: false,
        prNumber: 1,
        prState: "MERGED",
      }),
      false,
    );
    assert.equal(
      isPrRefreshCandidate({
        archived: false,
        prNumber: 1,
        prState: "CLOSED",
      }),
      false,
    );
    assert.equal(
      isPrRefreshCandidate({
        archived: false,
        prNumber: null,
        prState: "OPEN",
      }),
      false,
    );
  });

  it("zero qualifying threads → zero spawns", async () => {
    fx = await makeFixture();
    // thread has no prNumber
    const broadcasts = [];
    const saveCount = wrapSaveCounter(fx.store);
    const result = await refreshPrStates(fx.store, {
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });
    assert.equal(result.examined, 0);
    assert.equal(result.spawned, 0);
    assert.equal(result.changed, 0);
    assert.equal(readGhState(fx).calls.length, 0);
    assert.equal(broadcasts.length, 0);
    assert.equal(saveCount.n, 0, "zero-qualifying pass must not call store.save");
  });

  it("terminal MERGED → zero spawns", async () => {
    fx = await makeFixture();
    seedOpenPr(fx, fx.thread.id, 7, "MERGED");
    const result = await refreshPrStates(fx.store, { broadcast: () => {} });
    assert.equal(result.examined, 0);
    assert.equal(result.spawned, 0);
    assert.equal(readGhState(fx).calls.length, 0);
  });

  it("archived thread is skipped even with OPEN pr", async () => {
    fx = await makeFixture();
    seedOpenPr(fx, fx.thread.id, 8, "OPEN");
    fx.store.updateThread(fx.thread.id, { archived: true });
    fx.store.saveNow();
    const result = await refreshPrStates(fx.store, { broadcast: () => {} });
    assert.equal(result.examined, 0);
    assert.equal(result.spawned, 0);
    assert.equal(readGhState(fx).calls.length, 0);
  });

  it("change → persist + save once + push once", async () => {
    fx = await makeFixture();
    seedOpenPr(fx, fx.thread.id, 42, "OPEN");
    setGhState(fx, {
      prsByNumber: {
        "42": {
          number: 42,
          url: "https://github.com/acme/demo/pull/42",
          state: "MERGED",
        },
      },
    });

    const broadcasts = [];
    const saveCount = wrapSaveCounter(fx.store);

    const result = await refreshPrStates(fx.store, {
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.equal(result.spawned, 1);
    assert.equal(result.changed, 1);
    assert.equal(saveCount.n, 1, "exactly one store.saveNow()");
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].ch, "threads:changed");
    const row = broadcasts[0].payload.find((t) => t.id === fx.thread.id);
    assert.ok(row);
    assert.equal(row.prState, "MERGED");
    assert.equal(fx.store.getThread(fx.thread.id).prState, "MERGED");
    assert.equal(
      fx.store.getThread(fx.thread.id).prUrl,
      "https://github.com/acme/demo/pull/42",
    );
  });

  it("B1: two threads both change → still ONE save and ONE push", async () => {
    // Spec headline: ONE store.save + ONE threads:changed per pass even when
    // multiple threads mutate. A single-thread change test cannot kill a
    // per-thread save/push mutant; this one can.
    fx = await makeFixture();
    const t2 = addSecondThread(fx, "Second change");
    seedOpenPr(fx, fx.thread.id, 61, "OPEN");
    seedOpenPr(fx, t2.id, 62, "OPEN");
    setGhState(fx, {
      prsByNumber: {
        "61": {
          number: 61,
          url: "https://github.com/acme/demo/pull/61",
          state: "MERGED",
        },
        "62": {
          number: 62,
          url: "https://github.com/acme/demo/pull/62",
          state: "CLOSED",
        },
      },
    });

    const broadcasts = [];
    const saveCount = wrapSaveCounter(fx.store);

    const result = await refreshPrStates(fx.store, {
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.equal(result.spawned, 2, "both threads must be queried");
    assert.equal(result.changed, 2, "both threads must report a change");
    assert.equal(
      saveCount.n,
      1,
      "exactly ONE store.save for the whole pass (not per-thread)",
    );
    assert.equal(
      broadcasts.length,
      1,
      "exactly ONE threads:changed for the whole pass",
    );
    assert.equal(broadcasts[0].ch, "threads:changed");
    assert.equal(fx.store.getThread(fx.thread.id).prState, "MERGED");
    assert.equal(fx.store.getThread(t2.id).prState, "CLOSED");
    const payload = broadcasts[0].payload;
    assert.equal(payload.find((t) => t.id === fx.thread.id).prState, "MERGED");
    assert.equal(payload.find((t) => t.id === t2.id).prState, "CLOSED");
  });

  it("no-change → no save no push", async () => {
    fx = await makeFixture();
    seedOpenPr(fx, fx.thread.id, 42, "OPEN");
    // gh returns the same OPEN state/url already on the thread
    const broadcasts = [];
    const saveCount = wrapSaveCounter(fx.store);

    const result = await refreshPrStates(fx.store, {
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.equal(result.spawned, 1);
    assert.equal(result.changed, 0);
    assert.equal(saveCount.n, 0, "must not save when nothing changed");
    assert.equal(broadcasts.length, 0);
    assert.equal(fx.store.getThread(fx.thread.id).prState, "OPEN");
  });

  it("strict serialization: no overlapping gh processes", async () => {
    fx = await makeFixture();
    const t2 = addSecondThread(fx, "Second PR");
    seedOpenPr(fx, fx.thread.id, 10, "OPEN");
    seedOpenPr(fx, t2.id, 11, "OPEN");
    setGhState(fx, { delayMs: 80 });

    const result = await refreshPrStates(fx.store, { broadcast: () => {} });
    assert.equal(result.spawned, 2);

    const log = readGhState(fx).callLog || [];
    assert.ok(log.length >= 2, `expected >=2 callLog entries, got ${log.length}`);
    // Every call must have ended; no pair may overlap.
    for (const c of log) {
      assert.ok(c.startedAt != null && c.endedAt != null, "call must finish");
      assert.ok(c.endedAt >= c.startedAt);
    }
    for (let i = 0; i < log.length; i++) {
      for (let j = i + 1; j < log.length; j++) {
        const a = log[i];
        const b = log[j];
        const overlap = a.startedAt < b.endedAt && b.startedAt < a.endedAt;
        assert.equal(
          overlap,
          false,
          `calls ${i} and ${j} overlapped: ${JSON.stringify({ a, b })}`,
        );
      }
    }
    // Stronger: second starts at or after first ends (serialized order).
    const ordered = log.slice().sort((x, y) => x.startedAt - y.startedAt);
    for (let i = 1; i < ordered.length; i++) {
      assert.ok(
        ordered[i].startedAt >= ordered[i - 1].endedAt,
        "next gh must start only after previous ends",
      );
    }
  });

  it("failure isolation: thread 1 fails, thread 2 still refreshes", async () => {
    fx = await makeFixture();
    const t2 = addSecondThread(fx, "Second PR");
    seedOpenPr(fx, fx.thread.id, 21, "OPEN");
    seedOpenPr(fx, t2.id, 22, "OPEN");
    setGhState(fx, {
      failNumbers: [21],
      prsByNumber: {
        "21": {
          number: 21,
          url: "https://github.com/acme/demo/pull/21",
          state: "OPEN",
        },
        "22": {
          number: 22,
          url: "https://github.com/acme/demo/pull/22",
          state: "MERGED",
        },
      },
    });

    const broadcasts = [];
    const result = await refreshPrStates(fx.store, {
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.equal(result.spawned, 2);
    assert.equal(result.changed, 1);
    assert.equal(fx.store.getThread(fx.thread.id).prState, "OPEN", "failed thread unchanged");
    assert.equal(fx.store.getThread(t2.id).prState, "MERGED", "success path still lands");
    assert.equal(broadcasts.length, 1);
  });

  it("timeout kill: timed-out thread is skipped; loop continues to next", async () => {
    fx = await makeFixture();
    const t2 = addSecondThread(fx, "After timeout");
    seedOpenPr(fx, fx.thread.id, 31, "OPEN");
    seedOpenPr(fx, t2.id, 32, "OPEN");

    // Pure inject: PR 31 times out; PR 32 returns CLOSED. No real child races.
    const seen = [];
    const ghTryAsyncFn = async (_cwd, args) => {
      const num = String(args[2]);
      seen.push(num);
      if (num === "31") {
        return {
          ok: false,
          enoent: false,
          timedOut: true,
          stdout: "",
          stderr: "",
          combined: "timed out",
        };
      }
      if (num === "32") {
        return {
          ok: true,
          stdout: JSON.stringify({
            number: 32,
            url: "https://github.com/acme/demo/pull/32",
            state: "CLOSED",
          }),
          stderr: "",
          combined: "",
        };
      }
      return {
        ok: false,
        enoent: false,
        timedOut: false,
        stdout: "",
        stderr: "unexpected",
        combined: "unexpected",
      };
    };

    const result = await refreshPrStates(fx.store, {
      broadcast: () => {},
      ghTryAsyncFn,
      timeoutMs: 200,
    });

    assert.equal(result.spawned, 2);
    assert.deepEqual(seen.sort(), ["31", "32"]);
    assert.equal(
      fx.store.getThread(fx.thread.id).prState,
      "OPEN",
      "timed-out PR must not be written",
    );
    assert.equal(
      fx.store.getThread(t2.id).prState,
      "CLOSED",
      "later thread still refreshes after a timeout",
    );
  });

  it("timeout kill (real child): hanging fake is killed under short timeout", async () => {
    fx = await makeFixture();
    seedOpenPr(fx, fx.thread.id, 99, "OPEN");
    setGhState(fx, { scenario: "timeout", delayMs: 0 });

    const started = Date.now();
    const result = await refreshPrStates(fx.store, {
      broadcast: () => {},
      timeoutMs: 400,
    });
    const elapsed = Date.now() - started;

    assert.equal(result.spawned, 1);
    assert.equal(result.changed, 0);
    assert.equal(fx.store.getThread(fx.thread.id).prState, "OPEN");
    // Must not wait anywhere near the fake's 120s hang.
    assert.ok(
      elapsed < 5000,
      `timeout kill too slow: ${elapsed}ms (expected <5s with 400ms timeout)`,
    );
  });

  it("non-GitHub origin skips silently (no error surface, no persist)", async () => {
    fx = await makeFixture();
    seedOpenPr(fx, fx.thread.id, 55, "OPEN");
    // Point origin at gitlab on the thread cwd (worktree) — refresh must skip
    // without throwing or saving change (ISSUES.md permanent-error regression).
    const cwd =
      fx.store.getThread(fx.thread.id).worktreePath ||
      fx.store.getProject(fx.thread.projectId).path;
    git(cwd, [
      "remote",
      "set-url",
      "origin",
      "https://gitlab.com/acme/demo.git",
    ]);

    const broadcasts = [];
    const result = await refreshPrStates(fx.store, {
      broadcast: (ch, p) => broadcasts.push({ ch, p }),
    });
    assert.equal(result.spawned, 0);
    assert.equal(result.changed, 0);
    assert.equal(broadcasts.length, 0);
    assert.equal(fx.store.getThread(fx.thread.id).prState, "OPEN");
    assert.equal(readGhState(fx).calls.length, 0);
  });

  it("overlap latch: second trigger during a pass is a no-op", async () => {
    fx = await makeFixture();
    seedOpenPr(fx, fx.thread.id, 77, "OPEN");

    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let entered = 0;

    const refresher = createPrStateRefresher({
      store: fx.store,
      broadcast: () => {},
      // Never auto-start timers in this unit test.
      intervalMs: 60_000,
      startupDelayMs: 60_000,
      refreshFn: async () => {
        entered += 1;
        await gate;
        return { examined: 1, changed: 0, spawned: 1 };
      },
    });

    const first = refresher.trigger();
    // Yield so first enters running=true.
    await new Promise((r) => setImmediate(r));
    assert.equal(refresher.isRunning(), true);
    const second = await refresher.trigger();
    assert.equal(second.ran, false, "latched pass must no-op the second trigger");
    assert.equal(entered, 1);

    release();
    const firstResult = await first;
    assert.equal(firstResult.ran, true);
    assert.equal(entered, 1);

    // After completion, a new trigger runs.
    const third = await refresher.trigger();
    assert.equal(third.ran, true);
    assert.equal(entered, 2);

    refresher.stop();
  });

  it("B2: latch clears after a throwing pass (round-34 wedge guard)", async () => {
    // Success-only latch clear wedges shut forever after the first throw.
    // The pass itself must REJECT (not a per-thread soft failure).
    fx = await makeFixture();
    let passes = 0;
    const refresher = createPrStateRefresher({
      store: fx.store,
      broadcast: () => {},
      intervalMs: 60_000,
      startupDelayMs: 60_000,
      refreshFn: async () => {
        passes += 1;
        throw new Error("forced refresh pass failure");
      },
    });

    const first = await refresher.trigger();
    assert.equal(first.ran, true, "throwing pass still resolves the trigger");
    assert.equal(
      first.result,
      null,
      "catch path returns result:null after a throw",
    );
    assert.equal(
      refresher.isRunning(),
      false,
      "latch must clear in finally even when refreshFn throws",
    );
    assert.equal(passes, 1);

    const second = await refresher.trigger();
    assert.equal(
      second.ran,
      true,
      "next trigger must actually run a pass (not stay latched)",
    );
    assert.equal(passes, 2, "spawn/pass counter proves the second pass ran");
    assert.equal(refresher.isRunning(), false);

    refresher.stop();
  });

  it("enoent-like gh failure skips silently (no persist, no throw)", async () => {
    // Exercises the fake's "enoent-like" scenario so it is not dead code.
    fx = await makeFixture();
    seedOpenPr(fx, fx.thread.id, 88, "OPEN");
    setGhState(fx, { scenario: "enoent-like" });

    const broadcasts = [];
    const saveCount = wrapSaveCounter(fx.store);
    const result = await refreshPrStates(fx.store, {
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.equal(result.spawned, 1);
    assert.equal(result.changed, 0);
    assert.equal(saveCount.n, 0);
    assert.equal(broadcasts.length, 0);
    assert.equal(fx.store.getThread(fx.thread.id).prState, "OPEN");
    assert.ok(readGhState(fx).calls.length >= 1, "gh was actually spawned");
  });

  it("createPrStateRefresher.start schedules startup + interval (injectable timers)", async () => {
    fx = await makeFixture();
    const timeouts = [];
    const intervals = [];
    let triggers = 0;

    const refresher = createPrStateRefresher({
      store: fx.store,
      broadcast: () => {},
      intervalMs: 5000,
      startupDelayMs: 300,
      setTimeoutFn: (fn, ms) => {
        timeouts.push({ fn, ms });
        return { unref() {} };
      },
      setIntervalFn: (fn, ms) => {
        intervals.push({ fn, ms });
        return { unref() {} };
      },
      clearTimeoutFn: () => {},
      clearIntervalFn: () => {},
      refreshFn: async () => {
        triggers += 1;
        return { examined: 0, changed: 0, spawned: 0 };
      },
    });

    refresher.start();
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].ms, 300);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 5000);

    await timeouts[0].fn();
    assert.equal(triggers, 1);
    await intervals[0].fn();
    assert.equal(triggers, 2);

    refresher.stop();
  });

  it("PR_REFRESH_TIMEOUT_MS is ~8s", () => {
    assert.equal(PR_REFRESH_TIMEOUT_MS, 8_000);
  });
});

/**
 * Wrap store.save so callers can assert exact invocation counts.
 * Always returns a live counter (never the vacuous 0===0 fallback).
 * @param {import('../store').Store} store
 * @returns {{ n: number }}
 */
function wrapSaveCounter(store) {
  const counter = { n: 0 };
  const origSave = store.save.bind(store);
  store.save = () => {
    counter.n += 1;
    return origSave();
  };
  return counter;
}
