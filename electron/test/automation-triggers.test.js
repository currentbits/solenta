"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  startScheduler,
  extractMemory,
  settleAutomationRuns,
  MAX_MEMORY_CHARS,
} = require("../automations.js");
const { matchRows, normalizeTrigger, parseTriggerInput } = require("../automation-triggers.js");

const remote = { host: "github.com", owner: "acme", repo: "app" };

describe("normalizeTrigger / matchRows", () => {
  it("drops unknown events and filters that do not apply", () => {
    assert.equal(normalizeTrigger({ event: "nope" }), null);
    assert.equal(normalizeTrigger(null), null);
    assert.deepEqual(normalizeTrigger({ event: "pr_opened", label: "x", branch: "main" }), {
      type: "github",
      event: "pr_opened",
      branch: null,
      label: null,
      conclusion: null,
      team: null,
      status: null,
      org: null,
      project: null,
      environment: null,
    });
    assert.equal(normalizeTrigger({ event: "ci_completed", conclusion: "bogus" }).conclusion, null);
  });

  it("normalizes Linear and Sentry events and drops filters that do not apply", () => {
    assert.deepEqual(
      normalizeTrigger({
        event: "linear_issue_created",
        team: "eng",
        status: "Done",
        org: "acme",
        branch: "main",
      }),
      {
        type: "linear",
        event: "linear_issue_created",
        branch: null,
        label: null,
        conclusion: null,
        team: "eng",
        status: null,
        org: null,
        project: null,
        environment: null,
      },
    );
    assert.deepEqual(
      normalizeTrigger({
        event: "linear_status_changed",
        team: "ENG",
        status: "Done",
      }),
      {
        type: "linear",
        event: "linear_status_changed",
        branch: null,
        label: null,
        conclusion: null,
        team: "ENG",
        status: "Done",
        org: null,
        project: null,
        environment: null,
      },
    );
    assert.deepEqual(
      normalizeTrigger({
        event: "sentry_issue",
        org: "acme",
        project: "pump",
        environment: "prod",
        team: "ENG",
      }),
      {
        type: "sentry",
        event: "sentry_issue",
        branch: null,
        label: null,
        conclusion: null,
        team: null,
        status: null,
        org: "acme",
        project: "pump",
        environment: "prod",
      },
    );
    assert.equal(normalizeTrigger({ event: "pr_opened" }).type, "github");
    assert.equal(normalizeTrigger({ event: "nope" }), null);
  });

  it("parseTriggerInput rejects sentry_issue without org or project", () => {
    assert.throws(
      () => parseTriggerInput({ event: "sentry_issue", org: "acme" }),
      /Sentry trigger requires org and project/,
    );
    assert.throws(
      () => parseTriggerInput({ event: "sentry_issue", project: "pump" }),
      /Sentry trigger requires org and project/,
    );
    assert.deepEqual(
      parseTriggerInput({ event: "sentry_issue", org: "acme", project: "pump" }).event,
      "sentry_issue",
    );
  });

  it("labeled matches the label name case-insensitively, issues and PRs", () => {
    const rows = [
      { id: 3, event: "labeled", label: { name: "Bug" }, issue: { number: 7, title: "t", pull_request: {} } },
      { id: 2, event: "labeled", label: { name: "docs" }, issue: { number: 6, title: "u" } },
      { id: 1, event: "merged", issue: { number: 5, title: "m" } },
    ];
    const { all, matched } = matchRows({ event: "pr_labeled", label: "bug" }, rows, remote);
    assert.deepEqual(all, [3, 2, 1]);
    assert.equal(matched.length, 1);
    assert.match(matched[0].text, /^PR #7 labeled "Bug"/);
    const merged = matchRows({ event: "pr_merged" }, rows, remote).matched;
    assert.deepEqual(merged.map((m) => m.key), [1]);
  });

  it("ci_completed keys on updated_at and filters branch + conclusion", () => {
    const rows = [
      { updated_at: "2026-10-11T10:00:02Z", head_branch: "main", conclusion: "failure", name: "CI" },
      { updated_at: "2026-10-11T10:00:01Z", head_branch: "feat", conclusion: "failure" },
      { updated_at: "2026-10-11T10:00:00Z", head_branch: "main", conclusion: "success" },
    ];
    const { matched } = matchRows({ event: "ci_completed", branch: "main", conclusion: "failure" }, rows, remote);
    assert.deepEqual(matched.map((m) => m.key), ["2026-10-11T10:00:02Z"]);
  });

  it("push and review read the activity events API", () => {
    const rows = [
      { id: 20, type: "PushEvent", actor: { login: "a" }, payload: { ref: "refs/heads/main", head: "abcdef123" } },
      { id: 19, type: "PullRequestReviewEvent", actor: { login: "b" }, payload: { pull_request: { number: 4 }, review: { state: "approved" } } },
      { id: 18, type: "PushEvent", payload: { ref: "refs/heads/dev" } },
    ];
    assert.deepEqual(matchRows({ event: "push", branch: "main" }, rows, remote).matched.map((m) => m.key), [20]);
    const rev = matchRows({ event: "review_submitted" }, rows, remote).matched;
    assert.equal(rev.length, 1);
    assert.match(rev[0].text, /Review approved on PR #4 by b/);
  });
});

describe("extractMemory", () => {
  it("takes the last block, trims and caps it, null when absent", () => {
    assert.equal(extractMemory("no tag"), null);
    assert.equal(extractMemory(null), null);
    assert.equal(
      extractMemory("<automation-memory>old</automation-memory> then <automation-memory>\n new \n</automation-memory>"),
      "new",
    );
    const big = extractMemory(`<automation-memory>${"x".repeat(MAX_MEMORY_CHARS + 50)}</automation-memory>`);
    assert.equal(big.length, MAX_MEMORY_CHARS);
  });
});

describe("event-triggered automations", () => {
  let tmpDir;
  let store;
  /** @type {any[]} */
  let rows;
  let fetches;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-trig-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([{ id: "p1", slug: "acme/app", name: "app", path: tmpDir }]);
    store.saveNow();
    rows = [];
    fetches = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function scheduler(started) {
    return startScheduler({
      store,
      runner: {
        startRun: async (input) => {
          started.push(input);
          return { runId: "r" };
        },
      },
      intervalMs: 60 * 60 * 1000,
      triggerDeps: {
        remoteFor: async () => remote,
        token: async () => "tok",
        rest: async () => {
          fetches++;
          return rows;
        },
      },
    });
  }

  function addPrOpened(extra = {}) {
    return services.addAutomation(store, {
      projectId: "p1",
      name: "PR reviewer",
      prompt: "review new PRs",
      provider: "claude",
      preset: "hourly",
      trigger: { event: "pr_opened" },
      ...extra,
    });
  }

  it("baselines on the first poll, then batches new PRs into one run", async () => {
    const auto = addPrOpened();
    assert.equal(auto.trigger.event, "pr_opened");
    // Schedule must not fire an event automation even when nextRunAt is due.
    store.setAutomations([{ ...store.getAutomation(auto.id), nextRunAt: 0 }]);
    rows = [{ number: 10, title: "old", user: { login: "x" } }];
    const started = [];
    const sched = scheduler(started);
    try {
      await sched.tick();
      assert.equal(started.length, 0, "history must not fire");
      assert.equal(store.getAutomation(auto.id).triggerCursor, 10);

      rows = [
        { number: 12, title: "second", user: { login: "y" } },
        { number: 11, title: "first", user: { login: "x" } },
        { number: 10, title: "old", user: { login: "x" } },
      ];
      await sched.tick();
      assert.equal(started.length, 1);
      const p = started[0].prompt;
      assert.match(p, /^review new PRs/);
      assert.match(p, /\[Trigger\] GitHub pr_opened on acme\/app \(2 new events\)/);
      assert.ok(p.indexOf("PR #11") < p.indexOf("PR #12"), "oldest first");
      assert.doesNotMatch(p, /PR #10/);
      assert.equal(store.getAutomation(auto.id).triggerCursor, 12);

      // Still working: not polled, cursor holds, no second run.
      rows = [{ number: 13, title: "third" }, ...rows];
      const threadId = store.getAutomation(auto.id).pendingRunThreadId;
      store.setThreads(store.getThreads().map((t) => (t.id === threadId ? { ...t, status: "working" } : t)));
      await sched.tick();
      assert.equal(started.length, 1);
      assert.equal(store.getAutomation(auto.id).triggerCursor, 12);
    } finally {
      sched.stop();
    }
  });

  it("shares one fetch per repo+source per tick", async () => {
    addPrOpened({ name: "a" });
    addPrOpened({ name: "b" });
    const sched = scheduler([]);
    try {
      await sched.tick();
    } finally {
      sched.stop();
    }
    assert.equal(fetches, 1);
  });

  it("records a poll error without tripping the breaker, clears it on recovery", async () => {
    const auto = addPrOpened();
    const sched = startScheduler({
      store,
      runner: { startRun: async () => ({}) },
      intervalMs: 60 * 60 * 1000,
      triggerDeps: { remoteFor: async () => remote, token: async () => null, rest: async () => [] },
    });
    try {
      await sched.tick();
    } finally {
      sched.stop();
    }
    const after = store.getAutomation(auto.id);
    assert.match(after.lastError, /^GitHub trigger: no token/);
    assert.equal(after.consecutiveFailures, 0);
    assert.equal(after.enabled, true);

    const ok = scheduler([]);
    try {
      await ok.tick();
    } finally {
      ok.stop();
    }
    assert.equal(store.getAutomation(auto.id).lastError, null);
  });

  it("changing the trigger re-baselines; clearing it returns to schedule mode", () => {
    const auto = addPrOpened();
    store.setAutomations([{ ...store.getAutomation(auto.id), triggerCursor: 40 }]);
    const same = services.updateAutomation(store, { id: auto.id, name: "renamed" });
    assert.equal(same.triggerCursor, 40);
    const moved = services.updateAutomation(store, { id: auto.id, trigger: { event: "pr_merged" } });
    assert.equal(moved.triggerCursor, null);
    const sched = services.updateAutomation(store, { id: auto.id, trigger: null });
    assert.equal(sched.trigger, null);
    assert.throws(() => services.updateAutomation(store, { id: auto.id, trigger: { event: "x" } }), /Unknown trigger event/);
  });

  it("settling a run stores its memory block and the next run gets it back", async () => {
    const auto = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "sweep",
      provider: "claude",
      preset: "hourly",
    });
    const started = [];
    const sched = scheduler(started);
    try {
      await sched.runNow(auto.id);
      const threadId = store.getAutomation(auto.id).pendingRunThreadId;
      store.setThreads(store.getThreads().map((t) => (t.id === threadId ? { ...t, status: "done" } : t)));
      store.appendMessage(threadId, {
        role: "assistant",
        text: "done.\n<automation-memory>skip vendor/</automation-memory>",
      });
      assert.equal(settleAutomationRuns({ store }), true);
      assert.equal(store.getAutomation(auto.id).memory, "skip vendor/");

      await sched.runNow(auto.id);
      assert.match(started[1].prompt, /Notes this automation kept from earlier runs:\nskip vendor\//);
    } finally {
      sched.stop();
    }
  });
});
