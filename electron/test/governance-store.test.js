/**
 * #262: policy + agentProfileId persistence, the fork rule, and manual picks
 * leaving the profile.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const threadHandlers = require("../ipc-threads.js");

const POLICY = {
  defaultAction: "allow",
  rules: [{ kind: "bash", match: "npm publish", action: "block" }],
};

function profile(extra = {}) {
  return {
    id: "scout",
    name: "Scout",
    provider: "claude",
    model: null,
    reasoningEffort: null,
    permissionMode: "acceptEdits",
    policy: POLICY,
    ...extra,
  };
}

describe("governance store + binding", () => {
  let dir;
  let file;
  let store;
  let thread;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-store-"));
    file = path.join(dir, "store.json");
    store = new Store(file);
    const repo = path.join(dir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    thread = services.createThread(store, { projectId: project.id, title: "T" });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a valid policy survives save + reload", () => {
    store.setSettings({ agentProfiles: [profile()] });
    store.saveNow();
    const again = new Store(file);
    assert.deepEqual(again.getSettings().agentProfiles[0].policy, POLICY);
  });

  it("settings:set rejects a junk policy", () => {
    assert.throws(
      () =>
        store.setSettings({
          agentProfiles: [profile({ policy: { defaultAction: "ask", rules: [{ kind: "x" }] } })],
        }),
      /policy/,
    );
  });

  it("junk policy on disk heals to absent, keeping the profile", () => {
    store.setSettings({ agentProfiles: [profile()] });
    store.saveNow();
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.settings.agentProfiles[0].policy = { defaultAction: "ask", rules: "nope" };
    fs.writeFileSync(file, JSON.stringify(raw));
    const healed = new Store(file).getSettings().agentProfiles;
    assert.equal(healed.length, 1);
    assert.equal("policy" in healed[0], false);
  });

  it("agentProfileId persists; junk heals away", () => {
    store.setSettings({ agentProfiles: [profile()] });
    services.applyAgentProfile(store, { threadId: thread.id, profileId: "scout" });
    store.saveNow();
    assert.equal(new Store(file).getThread(thread.id).agentProfileId, "scout");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const row = raw.threads.find((t) => t.id === thread.id);
    row.agentProfileId = 42;
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal("agentProfileId" in new Store(file).getThread(thread.id), false);
  });

  it("applyAgentProfile applies the whole profile snapshot", () => {
    store.setSettings({ agentProfiles: [profile()] });
    const out = services.applyAgentProfile(store, { threadId: thread.id, profileId: "scout" });
    assert.equal(out.agentProfileId, "scout");
    assert.equal(out.permissionMode, "acceptEdits");
    assert.equal(out.provider, "claude");
  });

  it("fork copies the id only on the profile's provider", () => {
    store.setSettings({ agentProfiles: [profile()] });
    services.applyAgentProfile(store, { threadId: thread.id, profileId: "scout" });
    const same = services.forkThread(store, { threadId: thread.id });
    assert.equal(same.agentProfileId, "scout");
    const other = services.forkThread(store, { threadId: thread.id, provider: "codex" });
    assert.notEqual(other.agentProfileId, "scout");
  });

  it("fork drops a deleted profile's id", () => {
    store.setSettings({ agentProfiles: [profile()] });
    services.applyAgentProfile(store, { threadId: thread.id, profileId: "scout" });
    store.setSettings({ agentProfiles: [] });
    const fork = services.forkThread(store, { threadId: thread.id });
    assert.notEqual(fork.agentProfileId, "scout");
  });

  it("manual provider / effort / permission picks leave the profile", async () => {
    store.setSettings({ agentProfiles: [profile()] });
    const ctx = { store, broadcast() {}, runner: {} };
    for (const [channel, input] of [
      ["threads:setPermissionMode", { threadId: thread.id, mode: "default" }],
      ["threads:setReasoningEffort", { threadId: thread.id, effort: null }],
      ["threads:setProvider", { threadId: thread.id, model: "claude-sonnet-5" }],
    ]) {
      await threadHandlers["threads:applyAgentProfile"](ctx, {
        threadId: thread.id,
        profileId: "scout",
      });
      assert.equal(store.getThread(thread.id).agentProfileId, "scout");
      const out = await threadHandlers[channel](ctx, input);
      assert.equal(out.agentProfileId, null, channel);
      assert.equal(store.getThread(thread.id).agentProfileId, null, channel);
    }
  });
});
