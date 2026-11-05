const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createToolHandlers } = require("../orchServer.js");
const { pickAccountByQuota } = require("../providerUsage.js");
const { accountRefsByProvider } = require("../providerInstances.js");
const { parseProviderRef } = require("../providerInstances.js");
const { knownProviderIds } = require("../providers.js");

// #1857: thread_fork onto a named account, or the one with the most quota.

const INSTANCES = [
  { id: "claude", provider: "claude", name: "Base", configDir: null, env: {} },
  { id: "work", provider: "claude", name: "work", configDir: null, env: {} },
  { id: "team", provider: "claude", name: "team", configDir: null, env: {} },
  { id: "alt", provider: "codex", name: "alt", configDir: null, env: {} },
];

function win(label, usedPercent, resetsAt = null) {
  return { label, usedPercent, resetsAt, windowSeconds: 1 };
}

function row(provider, windows, status = "ok") {
  return { provider, status, windows, fetchedAt: 1 };
}

function makeDeps(usageRows = []) {
  const threads = [
    { id: "lead", provider: "claude", projectId: "p1", permissionMode: "default" },
  ];
  const messages = {};
  const usageCalls = [];
  const store = {
    getThreads: () => threads,
    getThread: (id) => threads.find((t) => t.id === id) || null,
    getProject: () => ({ id: "p1", path: "/tmp/p1" }),
    getMessages: (id) => messages[id] || [],
    appendMessage: (id, msg) => {
      (messages[id] ||= []).push(msg);
    },
    updateThread: (id, patch) => {
      const t = threads.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
      return t || null;
    },
    save: () => {},
    getSettings: () => ({
      providerInstances: INSTANCES,
      subagentPool: { defaultAlias: null, force: false, entries: [] },
    }),
  };
  const forks = [];
  return {
    store,
    messages,
    forks,
    usageCalls,
    runner: { startRun: async () => ({ runId: "r1" }) },
    // Same ref split as services.forkThread.
    forkThread: (s, input) => {
      forks.push(input);
      const { provider, instance } = parseProviderRef(input.provider || "claude");
      const fork = {
        id: `w${forks.length}`,
        projectId: "p1",
        provider,
        ...(instance ? { providerInstance: instance } : {}),
      };
      threads.push(fork);
      return fork;
    },
    getProvider: (id) => (knownProviderIds().includes(id) ? { id } : null),
    fetchProviderLimits: async (opts) => {
      usageCalls.push(opts);
      return usageRows;
    },
    userDataPath: "/tmp/solenta-test-userdata",
  };
}

const fork = (deps, provider) =>
  createToolHandlers(deps).thread_fork({
    threadId: "lead",
    projectId: "p1",
    prompt: "go",
    provider,
  });

describe("thread_fork account refs (#1857)", () => {
  it("forks onto a named account", async () => {
    const deps = makeDeps();
    await fork(deps, "claude:team");
    assert.equal(deps.forks[0].provider, "claude:team");
    assert.equal(deps.store.getThread("w1").providerInstance, "team");
    assert.equal(deps.usageCalls.length, 0);
  });

  it("rejects an unknown account and lists the valid refs", async () => {
    const deps = makeDeps();
    await assert.rejects(
      () => fork(deps, "claude:nope"),
      /Unknown account: claude:nope\. Valid claude refs: claude, claude:work, claude:team, claude:auto/,
    );
    assert.equal(deps.forks.length, 0);
  });

  it("still rejects an unknown base provider", async () => {
    await assert.rejects(() => fork(makeDeps(), "nope:team"), /Unknown provider: nope:team/);
  });

  it("auto picks the account with the most quota and says so first", async () => {
    const deps = makeDeps([
      row("claude", [win("5-hour", 40), win("weekly", 10)]),
      row("claude:work", [win("5-hour", 97), win("weekly", 1)]),
      row("claude:team", [win("5-hour", 12), win("weekly", 30)]),
    ]);
    await fork(deps, "claude:auto");
    assert.equal(deps.forks[0].provider, "claude:team");
    assert.equal(deps.messages.w1[0].role, "event");
    assert.equal(deps.messages.w1[0].text, "Picked claude:team, 30% of weekly used");
    // Only the claude rows are fetched, and the base overlay is not a probe.
    assert.equal(deps.usageCalls[0].only, "claude");
    assert.deepEqual(
      deps.usageCalls[0].instances.map((p) => p.ref),
      ["claude:work", "claude:team"],
    );
  });

  it("auto on a provider with no named accounts is rejected", async () => {
    await assert.rejects(() => fork(makeDeps(), "grok:auto"), /Unknown account: grok:auto\. Valid grok refs: grok$/);
  });
});

describe("pickAccountByQuota (#1857)", () => {
  const refs = ["claude", "claude:work", "claude:team"];

  it("skips an account at 95% in either window", () => {
    const out = pickAccountByQuota(refs, [
      row("claude", [win("5-hour", 95), win("weekly", 0)]),
      row("claude:work", [win("5-hour", 0), win("weekly", 99)]),
      row("claude:team", [win("5-hour", 80)]),
    ]);
    assert.deepEqual(out, { ref: "claude:team", note: "Picked claude:team, 80% of 5-hour used" });
  });

  it("breaks a tie with the soonest reset, unknown reset last", () => {
    const out = pickAccountByQuota(refs, [
      row("claude", [win("5-hour", 20)]),
      row("claude:work", [win("5-hour", 20, 5000)]),
      row("claude:team", [win("5-hour", 20, 2000)]),
    ]);
    assert.equal(out.ref, "claude:team");
  });

  it("falls back to the default account when no usage is known", () => {
    const out = pickAccountByQuota(refs, [
      row("claude", [], "error"),
      row("claude:work", [win("weekly (Opus)", 10)]),
    ]);
    assert.equal(out.ref, "claude");
    assert.match(out.note, /^Picked claude, no usage known/);
  });

  it("prefers an unknown account over exhausted ones", () => {
    const out = pickAccountByQuota(refs, [
      row("claude", [win("5-hour", 100)]),
      row("claude:work", [win("weekly", 96)]),
    ]);
    assert.equal(out.ref, "claude:team");
  });

  it("throws when every account is exhausted", () => {
    assert.throws(
      () =>
        pickAccountByQuota(["claude", "claude:work"], [
          row("claude", [win("5-hour", 100)]),
          row("claude:work", [win("weekly", 96)]),
        ]),
      /Every account is at least 95% used \(claude, claude:work\)/,
    );
  });
});

describe("accountRefsByProvider (#1857)", () => {
  it("groups named accounts by provider and leaves out base overlays", () => {
    const refs = accountRefsByProvider({ providerInstances: INSTANCES });
    assert.deepEqual([...refs], [
      ["claude", ["claude:work", "claude:team"]],
      ["codex", ["codex:alt"]],
    ]);
    assert.equal(accountRefsByProvider(null).size, 0);
  });
});

describe("fetchProviderLimits only (#1857)", () => {
  it("fetches just that provider's base row plus the given instances", async () => {
    const { fetchProviderLimits } = require("../providerUsage.js");
    const seen = [];
    const fetcher = async (opts) => {
      seen.push(opts.providerId);
      return row(opts.providerId, []);
    };
    const rows = await fetchProviderLimits({
      only: "claude",
      fetchers: Object.fromEntries(knownProviderIds().map((id) => [id, fetcher])),
      instances: [{ ref: "claude:team", provider: "claude", env: {} }],
    });
    assert.deepEqual(rows.map((r) => r.provider), ["claude", "claude:team"]);
    assert.deepEqual(seen, ["claude", "claude"]);
  });
});
