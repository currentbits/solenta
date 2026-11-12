"use strict";
const { it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const { createSecrets } = require("../secrets.js");
const { createProposal, resolveProposal, publicProposal, TTL_MS } = require("../mcpProposals.js");
const services = require("../services.js");
const { scopeForChannel } = require("../webScopes.js");

let store, dir, ctx, previousEnv;
const base = { threadId: "t1", projectId: "p1", action: "add" };
const local = { name: "test-tools", transport: "stdio", command: "npx", args: ["-y", "example-mcp"], cwd: "/tmp/project", envNames: ["API_KEY"] };
const remote = { name: "remote-tools", transport: "http", url: "https://tools.example/mcp", headerNames: ["Authorization"] };
const propose = (config = local, over = {}) => createProposal(store, { ...base, config, ...over });
const approve = (proposal, over = {}) => resolveProposal(ctx, {
  threadId: "t1", proposalId: proposal.id, reviewToken: proposal.reviewToken, resolution: "approved", trustLocal: true,
  secrets: { "env:API_KEY": "local-secret", "header:Authorization": "Bearer header-secret" }, ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-mcp-proposals-"));
  const overrides = { CODER_GROK_MCP_DISABLE: "1", CODER_CURSOR_MCP_DISABLE: "1", CODER_KIMI_MCP_PATH: path.join(dir, "kimi.json") };
  previousEnv = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const secrets = createSecrets({ inElectron: true, log() {}, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain).map((b) => b ^ 77),
    decryptString: (bytes) => Buffer.from(bytes).map((b) => b ^ 77).toString(),
  } });
  store = new Store(path.join(dir, "store.json"), { secrets });
  store.setProjects([{ id: "p1", name: "Project", path: dir }]);
  store.setThreads([{ id: "t1", projectId: "p1", provider: "claude", permissionMode: "default" }]);
  ctx = { store, transport: "desktop", userDataPath: dir };
});
afterEach(() => {
  require("../memory-sup.js").resetMemorySupForTests();
  store.saveNow(); fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

it("creates inert, persistent, bounded proposals and strips private fingerprints from detail/list rows", () => {
  const proposal = propose();
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.base, undefined);
  assert.equal(proposal.id, propose().id, "duplicate request is idempotent");
  assert.deepEqual(store.getSettings().mcpServers, []);
  store.saveNow();
  const restored = new Store(path.join(dir, "store.json"));
  assert.equal(restored.getThread("t1").mcpProposals[0].id, proposal.id);
  assert.equal(services.getThreadDetail(store, "t1").thread.mcpProposals[0].base, undefined);
  assert.equal(services.listThreads(store)[0].mcpProposals, undefined);
  assert.equal(store.getThread("t1").mcpProposals[0].base.length, 64);
});

it("requires explicit local trust and locally entered credentials before registering", () => {
  const proposal = propose();
  assert.throws(() => approve(proposal, { trustLocal: false }), /trust/);
  assert.throws(() => approve(proposal, { secrets: {} }), /credential/);
  assert.throws(() => approve(proposal, { secrets: { "env:API_KEY": "bad\nvalue" } }), /CR|LF/);
  assert.deepEqual(store.getSettings().mcpServers, []);
  const result = approve(proposal);
  assert.equal(result.status, "approved");
  assert.equal(store.getSettings().mcpServers[0].env.API_KEY, "local-secret");
  assert.equal(store.getSettings().mcpServers[0].trusted, true);
  assert.equal(store.getSettings().mcpServers[0].enabled, true);
  assert.ok(!JSON.stringify(result).includes("local-secret"));
  assert.ok(!JSON.stringify(services.getThreadDetail(store, "t1")).includes("local-secret"));
  store.saveNow();
  assert.ok(!fs.readFileSync(path.join(dir, "store.json"), "utf8").includes("local-secret"));
  assert.throws(() => approve(proposal), /already resolved/);
});

it("adds HTTP headers through the existing registry validation without storing them on the proposal", () => {
  const proposal = propose(remote);
  approve(proposal);
  assert.equal(store.getSettings().mcpServers[0].headers.Authorization, "Bearer header-secret");
  assert.ok(!JSON.stringify(store.getThread("t1").mcpProposals).includes("header-secret"));
});

it("dismisses without changing settings and removes only after review", () => {
  const rejected = propose();
  resolveProposal(ctx, { threadId: "t1", proposalId: rejected.id, resolution: "dismissed" });
  assert.deepEqual(store.getSettings().mcpServers, []);
  approve(propose(remote));
  const removal = propose({ name: remote.name }, { action: "remove" });
  assert.equal(store.getSettings().mcpServers.length, 1);
  approve(removal);
  assert.deepEqual(store.getSettings().mcpServers, []);
});

it("rejects web/full-access clients and missing identities", () => {
  const proposal = propose();
  ctx.transport = "web";
  assert.throws(() => approve(proposal), /desktop.*owning/);
  assert.throws(() => resolveProposal(ctx, { threadId: "t1", proposalId: proposal.id, resolution: "dismissed" }), /desktop/);
  ctx.transport = undefined;
  assert.throws(() => approve(proposal), /desktop/);
  assert.equal(scopeForChannel("mcp:resolveProposal"), "full");
  ctx.transport = "desktop";
  assert.throws(() => approve(proposal, { threadId: "other" }), /missing/);
  assert.equal(store.getThread("t1").mcpProposals[0].status, "pending");
});

it("rejects approval after credentials, enabled flags or the registry changed", () => {
  for (const change of [
    { token: "updated" }, { enabled: false }, { url: "https://changed.example/mcp" },
  ]) {
    store.setSettings({ mcpServers: [{ name: "existing", transport: "http", url: "https://existing.example/mcp", token: "old" }] }, { replaceMcpServers: true });
    const proposal = propose({name: "existing"}, {action: "remove"});
    const old = store.getSettings().mcpServers[0];
    store.setSettings({ mcpServers: [{ ...old, ...change }] }, { replaceMcpServers: true });
    assert.throws(() => approve(proposal), /changed/);
    assert.equal(store.getSettings().mcpServers.length, 1);
    assert.equal(store.getThread("t1").mcpProposals.find((p) => p.id === proposal.id).status, "stale");
  }
});

it("rejects changed proposal content, expiration and moved/remote owning projects", () => {
  const proposal = propose();
  const raw = store.getThread("t1").mcpProposals[0];
  store.updateThread("t1", { mcpProposals: [{ ...raw, config: { ...raw.config, command: "different" } }] });
  assert.throws(() => approve(proposal), /changed after review/);
  const updated = publicProposal(store.getThread("t1").mcpProposals[0]);
  store.setProjects([{ id: "p1", name: "Project", path: dir + "/moved" }]);
  assert.throws(() => approve(updated), /owning project/);
  store.setProjects([{ id: "p1", path: dir }]);
  const expiring = propose();
  store.updateThread("t1", { mcpProposals: store.getThread("t1").mcpProposals.map((p) => p.id === expiring.id ? { ...p, at: Date.now() - TTL_MS - 1 } : p) });
  assert.throws(() => approve(expiring), /age changed/);
  const moving = propose();
  store.setProjects([{ id: "p1", path: dir, remoteHost: "owner@remote", remotePath: "/repo" }]);
  assert.throws(() => approve(moving), /owning project/);
  assert.throws(() => propose(), /this computer/);
});

it("does not accept inline credential maps, unsafe commands/keys, reserved names or collisions", () => {
  for (const config of [
    { ...local, token: "secret" }, { ...local, env: { API_KEY: "secret" } },
    { ...remote, headers: { Authorization: "secret" } },
    { ...local, envNames: ["NODE_OPTIONS"] }, { ...local, envNames: ["__proto__"] },
    { ...local, command: "npx\nmalicious" }, { ...local, cwd: "relative" },
    { ...local, name: "coder-threads" }, { ...local, name: "constructor", envNames: ["constructor"] },
    { ...remote, url: "https://user:secret@tools.example" },
    { ...remote, url: "https://tools.example?api_key=secret" },
    { ...local, headerNames: ["Authorization"] }, { ...remote, envNames: ["KEY"] },
    { ...local, envNames: ["DUP", "DUP"] }, { ...local, args: ["x".repeat(8000), "x".repeat(8000), "x".repeat(8000)] },
    { ...remote, headerNames: ["Authorization", "authorization"] },
  ]) assert.throws(() => propose(config));
  assert.throws(() => propose(local, { projectId: "foreign" }), /does not match/);
  assert.throws(() => propose({ name: "missing" }, { action: "remove" }), /does not exist/);
  approve(propose(remote));
  assert.throws(() => propose(remote), /already exists/);
});

it("caps pending proposals without evicting a proposal being reviewed", () => {
  const first = propose({ ...remote, name: "http-0" });
  for (let i = 1; i < 10; i++) propose({ ...remote, name: `http-${i}` });
  assert.throws(() => propose({ ...remote, name: "http-10" }), /pending/);
  assert.equal(store.getThread("t1").mcpProposals[0].id, first.id);
  resolveProposal(ctx, { threadId: "t1", proposalId: first.id, resolution: "dismissed" });
  propose({ ...remote, name: "http-10" });
  assert.equal(store.getThread("t1").mcpProposals.length, 10);
});

it("does not resolve an invalid action or a missing review token", () => {
  const proposal = propose();
  assert.throws(() => approve(proposal, { resolution: "yes" }), /Invalid/);
  assert.throws(() => approve(proposal, { reviewToken: undefined }), /review/);
  assert.deepEqual(store.getSettings().mcpServers, []);
  store.updateThread("t1", { trashedAt: Date.now() });
  assert.throws(() => approve(proposal), /missing/);
  assert.throws(() => propose(), /does not match/);
});

it("retains approval identity across a store restart with encrypted existing credentials", () => {
  store.setSettings({ mcpServers: [{name: "existing", transport: "http", url: "https://existing.example/mcp", token: "unchanged-token"}] });
  const proposal = propose();
  store.saveNow();
  const restored = new Store(store.filePath, { secrets: store._secrets });
  const result = resolveProposal({ ...ctx, store: restored }, { threadId: "t1", proposalId: proposal.id,
    reviewToken: proposal.reviewToken, resolution: "approved", trustLocal: true, secrets: {"env:API_KEY":"new-secret"} });
  assert.equal(result.status, "approved");
  assert.equal(restored.getSettings().mcpServers.length, 2);
  restored.saveNow();
});

it("preserves unrelated registry changes when approving several different proposals", () => {
  const first = propose(local);
  const second = propose(remote);
  approve(first);
  approve(second);
  assert.deepEqual(store.getSettings().mcpServers.map((s) => s.name), [local.name, remote.name]);
  const collision = propose({ ...remote, name: "future-tools" });
  store.setSettings({mcpServers: [...store.getSettings().mcpServers,
    {name:"future-tools",transport:"http",url:"https://different.example/mcp"}]}, {replaceMcpServers:true});
  assert.throws(() => approve(collision), /changed/);
});

it("desktop IPC applies once, refreshes the detail and rejects remote transport before mutation", async () => {
  const handlers = require("../ipc-mcp.js");
  const proposal = propose(remote);
  const input = { threadId: "t1", proposalId: proposal.id, reviewToken: proposal.reviewToken,
    resolution: "approved", secrets: { "header:Authorization": "Bearer ipc-secret" } };
  const refreshed = [];
  ctx.runner = { refreshDetail: (id) => refreshed.push(id) };
  await assert.rejects(handlers["mcp:resolveProposal"]({ ...ctx, transport: "web" }, input), /desktop/);
  assert.deepEqual(store.getSettings().mcpServers, []);
  const result = await handlers["mcp:resolveProposal"](ctx, input);
  assert.equal(result.status, "approved");
  assert.ok(!JSON.stringify(result).includes("ipc-secret"));
  assert.ok(refreshed.includes("t1"));
  require("../memory-sup.js").resetMemorySupForTests();
});
