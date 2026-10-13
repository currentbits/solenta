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

  it("issue_opened skips PRs but lets them move the baseline (#258)", () => {
    const rows = [
      { number: 9, title: "PR", pull_request: {} },
      { number: 8, title: "Crash on boot", user: { login: "a" }, labels: [{ name: "bug" }], body: "Steps:\n1. open" },
      { number: 7, title: "x", body: "y".repeat(2000) },
    ];
    const { all, matched } = matchRows({ event: "issue_opened" }, rows, remote);
    assert.deepEqual(all, [9, 8, 7]);
    assert.deepEqual(matched.map((m) => m.key), [8, 7]);
    assert.match(matched[0].text, /^Issue #8 opened by a: Crash on boot \[bug\] \(.*\)\n {2}> Steps:\n {2}> 1\. open$/);
    assert.ok(matched[1].text.length < 1700);
  });
});

describe("Linear and Sentry matchRows (#1588)", () => {
  it("linear_issue_created keys on createdAt and filters team case-insensitively", () => {
    const rows = [
      { identifier: "ENG-3", title: "c", url: "u3", createdAt: "2026-10-11T03:00:00Z", team: { key: "ENG" } },
      { identifier: "DOC-1", title: "d", url: "u1", createdAt: "2026-10-11T02:00:00Z", team: { key: "DOC" } },
      { identifier: "eng-2", title: "b", url: "u2", createdAt: "2026-10-11T01:00:00Z", team: { key: "eng" } },
    ];
    const { all, matched } = matchRows(
      { event: "linear_issue_created", team: "eng" },
      rows,
    );
    assert.deepEqual(all, [
      "2026-10-11T03:00:00Z",
      "2026-10-11T02:00:00Z",
      "2026-10-11T01:00:00Z",
    ]);
    assert.deepEqual(matched.map((m) => m.key), ["2026-10-11T03:00:00Z", "2026-10-11T01:00:00Z"]);
    assert.match(matched[0].text, /^ENG-3 created: c \(u3\)$/);
  });

  it("linear_status_changed skips the birth span and filters status + team", () => {
    const rows = [
      {
        identifier: "ENG-9",
        title: "Fix login",
        url: "u9",
        createdAt: "2026-10-11T00:00:00Z",
        team: { key: "ENG" },
        stateHistory: {
          nodes: [
            { startedAt: "2026-10-11T00:00:00Z", state: { name: "Todo" } },
            { startedAt: "2026-10-11T04:00:00Z", state: { name: "Done" } },
          ],
        },
      },
      {
        identifier: "DOC-1",
        title: "docs",
        url: "ud",
        createdAt: "2026-10-11T00:00:00Z",
        team: { key: "DOC" },
        stateHistory: { nodes: [{ startedAt: "2026-10-11T05:00:00Z", state: { name: "Done" } }] },
      },
    ];
    const { all, matched } = matchRows(
      { event: "linear_status_changed", team: "eng", status: "done" },
      rows,
    );
    assert.ok(all.includes("2026-10-11T00:00:00Z"));
    assert.ok(all.includes("2026-10-11T04:00:00Z"));
    assert.deepEqual(matched.map((m) => m.key), ["2026-10-11T04:00:00Z"]);
    assert.equal(matched[0].text, "ENG-9 moved to Done: Fix login (u9)");
  });

  it("sentry_issue keys on firstSeen and skips rows without it", () => {
    const rows = [
      { firstSeen: "2026-10-11T06:00:00Z", shortId: "PUMP-1", title: "boom", permalink: "p1" },
      { title: "no date" },
    ];
    const { all, matched } = matchRows({ event: "sentry_issue" }, rows);
    assert.deepEqual(all, ["2026-10-11T06:00:00Z"]);
    assert.equal(matched[0].text, "PUMP-1 first seen: boom (p1)");
  });
});

describe("formatTriggerNote (#1588)", () => {
  const { formatTriggerNote } = require("../automation-triggers.js");
  it("uses the title string and the same 20-event cap", () => {
    const items = [{ text: "a" }, { text: "b" }];
    assert.equal(
      formatTriggerNote("Linear issue created", items),
      "[Trigger] Linear issue created (2 new events):\n- a\n- b",
    );
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

  it("does not fire an enabled untrusted shared trigger", async () => {
    const row = {
      id: "pr-triage",
      name: "PR triage",
      prompt: "review new PRs",
      provider: "claude",
      model: null,
      preset: "hourly",
      hour: null,
      trigger: { type: "github", event: "pr_opened" },
    };
    fs.writeFileSync(
      path.join(tmpDir, "solenta.json"),
      JSON.stringify({ automations: [row] }, null, 2),
    );
    store.setAutomations([
      {
        id: "shared:p1:pr-triage",
        projectId: "p1",
        scope: "project",
        name: row.name,
        prompt: row.prompt,
        provider: "claude",
        preset: "hourly",
        hour: null,
        trigger: { event: "pr_opened" },
        enabled: true,
        triggerCursor: 10,
        lastRunAt: null,
        nextRunAt: Date.now() + 99 * 86_400_000,
        lastError: null,
      },
    ]);
    rows = [
      { number: 12, title: "second", user: { login: "y" } },
      { number: 10, title: "old", user: { login: "x" } },
    ];
    const started = [];
    const sched = scheduler(started);
    try {
      await sched.tick();
      assert.equal(started.length, 0);
    } finally {
      sched.stop();
    }
  });

  it("fires a trusted shared trigger with the merged file prompt, not the overlay", async () => {
    const {
      presentAutomationsFile,
      automationsHash,
      readAutomations,
    } = require("../automations-file.js");
    const row = {
      id: "pr-triage",
      name: "PR triage",
      prompt: "From file",
      provider: "claude",
      model: null,
      preset: "hourly",
      hour: null,
      trigger: { type: "github", event: "pr_opened" },
    };
    fs.writeFileSync(
      path.join(tmpDir, "solenta.json"),
      JSON.stringify({ automations: [row] }, null, 2),
    );
    store.setAutomations([
      {
        id: "shared:p1:pr-triage",
        projectId: "p1",
        scope: "project",
        name: row.name,
        prompt: "Stale",
        provider: "claude",
        preset: "hourly",
        hour: null,
        trigger: { event: "pr_opened" },
        enabled: true,
        triggerCursor: 10,
        lastRunAt: null,
        nextRunAt: Date.now() + 99 * 86_400_000,
        lastError: null,
      },
    ]);
    const section = readAutomations(tmpDir);
    const hash = automationsHash(section.automations);
    const project = store.getProject("p1");
    store.setProjects([{ ...project, automationsTrust: hash }]);
    assert.equal(presentAutomationsFile(store.getProject("p1")).trusted, true);
    rows = [
      { number: 12, title: "second", user: { login: "y" } },
      { number: 10, title: "old", user: { login: "x" } },
    ];
    const started = [];
    const sched = scheduler(started);
    try {
      await sched.tick();
      assert.equal(started.length, 1);
      assert.match(started[0].prompt, /^From file/);
      assert.equal(store.getAutomation("shared:p1:pr-triage").prompt, "Stale");
    } finally {
      sched.stop();
    }
  });
});

describe("Linear and Sentry pollTriggers (#1588)", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-trig-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([{ id: "p1", slug: "acme/app", name: "app", path: tmpDir }]);
    store.saveNow();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("baselines Linear created, then batches, and records a missing-key error without the breaker", async () => {
    const auto = services.addAutomation(store, {
      projectId: "p1",
      name: "Lin",
      prompt: "triage",
      provider: "claude",
      preset: "hourly",
      trigger: { event: "linear_issue_created" },
    });
    let nodes = [{ identifier: "ENG-1", title: "old", url: "u1", createdAt: "2026-10-11T01:00:00Z", team: { key: "ENG" } }];
    const started = [];
    const sched = startScheduler({
      store,
      runner: { startRun: async (input) => { started.push(input); return { runId: "r" }; } },
      intervalMs: 60 * 60 * 1000,
      triggerDeps: {
        linearGraphql: async () => nodes,
      },
    });
    store.setSettings({ linearApiKey: "k" });
    try {
      await sched.tick();
      assert.equal(started.length, 0);
      assert.equal(store.getAutomation(auto.id).triggerCursor, "2026-10-11T01:00:00Z");
      nodes = [
        { identifier: "ENG-3", title: "c", url: "u3", createdAt: "2026-10-11T03:00:00Z", team: { key: "ENG" } },
        { identifier: "ENG-2", title: "b", url: "u2", createdAt: "2026-10-11T02:00:00Z", team: { key: "ENG" } },
        nodes[0],
      ];
      await sched.tick();
      assert.equal(started.length, 1);
      assert.match(started[0].prompt, /\[Trigger\] Linear issue created \(2 new events\)/);
      assert.ok(started[0].prompt.indexOf("ENG-2") < started[0].prompt.indexOf("ENG-3"));
      assert.equal(store.getAutomation(auto.id).triggerCursor, "2026-10-11T03:00:00Z");
    } finally {
      sched.stop();
    }

    const missing = services.addAutomation(store, {
      projectId: "p1",
      name: "Lin2",
      prompt: "x",
      provider: "claude",
      preset: "hourly",
      trigger: { event: "linear_issue_created" },
    });
    store.setSettings({ linearApiKey: null });
    const prev = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    const errSched = startScheduler({
      store,
      runner: { startRun: async () => ({}) },
      intervalMs: 60 * 60 * 1000,
      triggerDeps: { linearGraphql: async () => { throw new Error("should not fetch"); } },
    });
    try {
      await errSched.tick();
    } finally {
      errSched.stop();
      if (prev != null) process.env.LINEAR_API_KEY = prev;
    }
    const after = store.getAutomation(missing.id);
    assert.match(after.lastError, /^Linear trigger: no api key/);
    assert.equal(after.consecutiveFailures, 0);
    assert.equal(after.enabled, true);
  });

  it("Sentry missing token is a poll error; happy path notes org/project", async () => {
    const auto = services.addAutomation(store, {
      projectId: "p1",
      name: "Sen",
      prompt: "fix",
      provider: "claude",
      preset: "hourly",
      trigger: { event: "sentry_issue", org: "acme", project: "pump" },
    });
    const errSched = startScheduler({
      store,
      runner: { startRun: async () => ({}) },
      intervalMs: 60 * 60 * 1000,
      triggerDeps: { sentryIssues: async () => [] },
    });
    try {
      await errSched.tick();
    } finally {
      errSched.stop();
    }
    assert.match(store.getAutomation(auto.id).lastError, /^Sentry trigger: no auth token/);
    assert.equal(store.getAutomation(auto.id).enabled, true);

    const prevSentry = process.env.SENTRY_AUTH_TOKEN;
    process.env.SENTRY_AUTH_TOKEN = "st";
    let rows = [{ firstSeen: "2026-10-11T01:00:00Z", shortId: "P-1", title: "old", permalink: "p" }];
    const started = [];
    const ok = startScheduler({
      store,
      runner: { startRun: async (input) => { started.push(input); return { runId: "r" }; } },
      intervalMs: 60 * 60 * 1000,
      triggerDeps: { sentryIssues: async () => rows },
    });
    try {
      await ok.tick();
      assert.equal(started.length, 0);
      rows = [
        { firstSeen: "2026-10-11T02:00:00Z", shortId: "P-2", title: "new", permalink: "p2" },
        rows[0],
      ];
      await ok.tick();
      assert.equal(started.length, 1);
      assert.match(started[0].prompt, /\[Trigger\] Sentry issue on acme\/pump \(1 new event\)/);
    } finally {
      ok.stop();
      if (prevSentry == null) delete process.env.SENTRY_AUTH_TOKEN;
      else process.env.SENTRY_AUTH_TOKEN = prevSentry;
    }
  });
});
