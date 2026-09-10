/**
 * External MCP pairing tokens (#157).
 * Run: node --test electron/test/pairing.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pairing = require("../pairing.js");

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-pairing-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mint(over = {}) {
  return pairing.createPairing(tmp, {
    name: "Claude Desktop",
    ...over,
  });
}

describe("pairing store", () => {
  it("mints a token once, stores only the hash at 0600, and lists the public row", () => {
    const created = mint({ projectIds: ["p1"] });
    assert.equal(created.pairing.name, "Claude Desktop");
    assert.equal(created.token.length, 64);
    assert.equal(created.pairing.tokenPrefix, created.token.slice(0, 8));
    assert.equal(created.pairing.requireApproval, true);
    assert.equal(created.pairing.managedWorktree, true);
    assert.deepEqual(created.pairing.capabilities, ["read", "launch"]);
    assert.deepEqual(created.pairing.projectIds, ["p1"]);
    assert.equal(created.pairing.revokedAt, null);
    assert.ok(!JSON.stringify(created.pairing).includes(created.token));

    const file = path.join(tmp, pairing.FILE_NAME);
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
    assert.equal(disk.pairings.length, 1);
    assert.equal(disk.pairings[0].tokenHash, pairing.hashToken(created.token));
    assert.equal(JSON.stringify(disk).includes(created.token), false);

    const listed = pairing.listPairings(tmp);
    assert.equal(listed.pairings.length, 1);
    assert.equal(listed.pairings[0].id, created.pairing.id);
    assert.equal(listed.pairings[0].tokenPrefix, created.pairing.tokenPrefix);
  });

  it("builds copy-ready JSON and a pairing prompt when the orch port is known", () => {
    fs.writeFileSync(
      path.join(tmp, "orch-server.json"),
      JSON.stringify({ port: 7422, token: "session" }),
      { mode: 0o600 },
    );
    const created = mint();
    assert.equal(created.url, "http://127.0.0.1:7422/mcp");
    const parsed = JSON.parse(created.claudeDesktopJson);
    assert.deepEqual(parsed.mcpServers.solenta, {
      type: "http",
      url: "http://127.0.0.1:7422/mcp",
      headers: { Authorization: `Bearer ${created.token}` },
    });
    assert.match(created.pairingPrompt, /Authorization: Bearer /);
    assert.match(created.pairingPrompt, /managed git worktree/);
    assert.match(created.pairingPrompt, /approve them in the Solenta app/);
  });

  it("authorizes the raw token, rejects a wrong token, and dies after revoke or expiry", () => {
    const created = mint();
    const ok = pairing.authorizeToken(tmp, created.token);
    assert.equal(ok.ok, true);
    assert.equal(ok.pairing.id, created.pairing.id);

    assert.equal(pairing.authorizeToken(tmp, "nope").ok, false);
    assert.equal(pairing.authorizeToken(tmp, "").reason, "missing");

    pairing.revokePairing(tmp, created.pairing.id);
    const revoked = pairing.authorizeToken(tmp, created.token);
    assert.equal(revoked.ok, false);
    assert.equal(revoked.reason, "unknown");
    assert.equal(pairing.listPairings(tmp).pairings.length, 0);

    const short = mint({ ttlMs: 1, name: "short" });
    const expired = pairing.authorizeToken(tmp, short.token, { now: Date.now() + 10 });
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, "expired");
  });

  it("rate-limits launches per hour and reads per minute", () => {
    const created = mint({ launchesPerHour: 2, readsPerMinute: 2 });
    const now = 1_000_000;
    assert.equal(pairing.authorizeToken(tmp, created.token, { now, kind: "read" }).ok, true);
    assert.equal(pairing.authorizeToken(tmp, created.token, { now: now + 10, kind: "read" }).ok, true);
    const limited = pairing.authorizeToken(tmp, created.token, {
      now: now + 20,
      kind: "read",
    });
    assert.equal(limited.ok, false);
    assert.equal(limited.reason, "rate_limited");
    assert.equal(
      pairing.authorizeToken(tmp, created.token, { now: now + 61_000, kind: "read" }).ok,
      true,
    );

    assert.equal(
      pairing.authorizeToken(tmp, created.token, { now, kind: "launch" }).ok,
      true,
    );
    assert.equal(
      pairing.authorizeToken(tmp, created.token, { now: now + 10, kind: "launch" }).ok,
      true,
    );
    const launchLimited = pairing.authorizeToken(tmp, created.token, {
      now: now + 20,
      kind: "launch",
    });
    assert.equal(launchLimited.ok, false);
    assert.equal(launchLimited.reason, "rate_limited");
  });

  it("always includes read, rejects an empty project list, and caps active pairings", () => {
    const created = mint({ capabilities: ["launch"] });
    assert.deepEqual(created.pairing.capabilities, ["read", "launch"]);
    assert.throws(() => mint({ projectIds: [] }), /at least one project/i);
    for (let i = 0; i < pairing.MAX_PAIRINGS - 1; i++) {
      mint({ name: `p${i}` });
    }
    assert.throws(() => mint({ name: "overflow" }), /Revoke one first/);
  });
});

describe("external pairing handlers", () => {
  function makeStore() {
    const projects = {
      p1: { id: "p1", name: "Alpha", path: "/tmp/alpha" },
      p2: { id: "p2", name: "Beta", path: "/tmp/beta" },
    };
    const threads = [];
    const messages = {};
    return {
      getProjects: () => Object.values(projects),
      getProject: (id) => projects[id] || null,
      getThreads: () => threads,
      getThread: (id) => threads.find((t) => t.id === id) || null,
      getMessages: (id) => messages[id] || [],
      getSettings: () => ({ defaultProvider: "claude", defaultModel: null }),
      setThreads: (next) => {
        threads.length = 0;
        threads.push(...next);
      },
      setMessages: (id, msgs) => {
        messages[id] = msgs;
      },
      setWorkLog: () => {},
      updateThread: (id, patch) => {
        const t = threads.find((x) => x.id === id);
        if (!t) return null;
        Object.assign(t, patch);
        return t;
      },
      save: () => {},
      threads,
    };
  }

  it("launches into awaiting_approval with a worktree and refuses other projects", async () => {
    const created = mint({ projectIds: ["p1"] });
    const store = makeStore();
    const runs = [];
    const h = pairing.createExternalHandlers({
      store,
      runner: {
        startRun: async (input) => {
          runs.push(input);
          const t = store.getThread(input.threadId);
          if (t) t.status = "working";
          return { runId: "r1" };
        },
      },
      pairing: created.pairing,
      presentedToken: created.token,
      userDataPath: tmp,
      canHostWorktree: () => true,
      createThread: (s, input) => {
        const thread = {
          id: "t-ext",
          projectId: input.projectId,
          title: input.title,
          status: "idle",
          lastError: null,
        };
        s.threads.push(thread);
        return thread;
      },
    });

    const projects = await h.projects_list();
    assert.deepEqual(projects.map((p) => p.id), ["p1"]);

    const launched = await h.task_launch({
      projectId: "p1",
      prompt: "fix issue 123",
    });
    assert.equal(launched.threadId, "t-ext");
    assert.equal(launched.status, "awaiting_approval");
    assert.equal(launched.awaitingApproval, true);
    assert.equal(runs.length, 0);
    const row = store.getThread("t-ext");
    assert.equal(row.pendingWorktree, true);
    assert.equal(row.pairingId, created.pairing.id);
    assert.equal(row.pendingExternalPrompt, "fix issue 123");

    await assert.rejects(
      h.task_launch({ projectId: "p2", prompt: "nope" }),
      /cannot access/,
    );
  });

  it("starts immediately when approval is off, and hides launch without the capability", async () => {
    const created = mint({
      requireApproval: false,
      capabilities: ["read", "launch"],
    });
    const store = makeStore();
    const runs = [];
    const h = pairing.createExternalHandlers({
      store,
      runner: {
        startRun: async (input) => {
          runs.push(input);
          return { runId: "r1" };
        },
      },
      pairing: { ...created.pairing, requireApproval: false },
      presentedToken: created.token,
      userDataPath: tmp,
      canHostWorktree: () => true,
      createThread: (s, input) => {
        const thread = {
          id: "t-go",
          projectId: input.projectId,
          title: input.title,
          status: "idle",
          lastError: null,
        };
        s.threads.push(thread);
        return thread;
      },
    });
    const launched = await h.task_launch({
      projectId: "p1",
      prompt: "do the thing",
    });
    assert.equal(launched.awaitingApproval, false);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].prompt, "do the thing");

    const readOnly = mint({ name: "read", capabilities: ["read"] });
    const h2 = pairing.createExternalHandlers({
      store: makeStore(),
      runner: { startRun: async () => ({}) },
      pairing: readOnly.pairing,
      presentedToken: readOnly.token,
      userDataPath: tmp,
    });
    await assert.rejects(h2.task_launch({ projectId: "p1", prompt: "x" }), /launch/);
  });

  it("approve starts the stored prompt; reject archives without starting", async () => {
    const store = makeStore();
    const thread = {
      id: "t1",
      projectId: "p1",
      title: "External",
      status: "idle",
      pendingExternalApproval: true,
      pendingExternalPrompt: "fix it",
      pairingId: "pair-1",
    };
    store.threads.push(thread);
    const runs = [];
    await pairing.approveExternalRun(
      {
        store,
        runner: {
          startRun: async (input) => {
            runs.push(input);
            return { runId: "r1" };
          },
        },
      },
      "t1",
    );
    assert.deepEqual(runs, [{ threadId: "t1", prompt: "fix it" }]);
    assert.equal(store.getThread("t1").pendingExternalApproval, false);
    assert.equal(store.getThread("t1").pendingExternalPrompt, null);

    const t2 = {
      id: "t2",
      projectId: "p1",
      title: "No",
      status: "idle",
      pendingExternalApproval: true,
      pendingExternalPrompt: "secret",
      archived: false,
    };
    store.threads.push(t2);
    pairing.rejectExternalRun(
      {
        store,
        setArchived: (s, input) => {
          const t = s.getThread(input.threadId);
          t.archived = input.archived;
          return t;
        },
      },
      "t2",
    );
    assert.equal(store.getThread("t2").archived, true);
    assert.equal(store.getThread("t2").pendingExternalApproval, false);
    assert.equal(store.getThread("t2").pendingExternalPrompt, null);
  });
});
