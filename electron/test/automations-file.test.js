"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseAutomations,
  automationsHash,
  readAutomations,
  presentAutomationsFile,
  slugFromName,
  sharedId,
  MAX_SHARED_AUTOMATIONS,
  mergeAutomations,
  gcOrphanOverlays,
  canAutoFire,
} = require("../automations-file.js");
const { parseRepoConfig } = require("../repoConfig.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { dueAutomations } = require("../automations.js");

function tempRepo(automations) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
  fs.writeFileSync(
    path.join(dir, "solenta.json"),
    JSON.stringify({ automations }, null, 2),
  );
  return dir;
}

const ROW = {
  id: "pr-triage",
  name: "PR triage",
  prompt: "Triage the new pull request.",
  provider: "claude",
  model: null,
  preset: "hourly",
  hour: null,
  trigger: { type: "github", event: "pr_opened" },
  tier: null,
};

describe("parseAutomations", () => {
  it("accepts a valid row and hashes independently of commands", () => {
    const section = parseAutomations({ setup: "npm ci", automations: [ROW] });
    assert.equal(section.error, undefined);
    assert.equal(section.automations.length, 1);
    assert.equal(section.automations[0].id, "pr-triage");
    assert.match(section.hash, /^[0-9a-f]{64}$/);
    const commands = parseRepoConfig({ setup: "npm ci", automations: [ROW] });
    assert.notEqual(section.hash, commands.hash);
    const tweaked = parseAutomations({
      setup: "npm ci",
      automations: [{ ...ROW, prompt: "Different" }],
    });
    assert.notEqual(section.hash, tweaked.hash);
    const sameAuto = parseAutomations({
      setup: "evil",
      automations: [ROW],
    });
    assert.equal(section.hash, sameAuto.hash);
  });

  it("one bad row fails only the automations section", () => {
    const data = {
      setup: "npm ci",
      automations: [{ ...ROW, id: "BAD" }],
    };
    const section = parseAutomations(data);
    assert.match(section.error, /id/);
    assert.deepEqual(section.automations, []);
    const commands = parseRepoConfig(data);
    assert.equal(commands.setup, "npm ci");
    assert.equal(commands.error, undefined);
  });

  it("rejects a 17th row, a duplicate id, and a too-long prompt", () => {
    const many = Array.from({ length: MAX_SHARED_AUTOMATIONS + 1 }, (_, i) => ({
      ...ROW,
      id: `job-${i}`,
    }));
    assert.match(parseAutomations({ automations: many }).error, /16/);
    assert.match(
      parseAutomations({ automations: [ROW, { ...ROW, name: "Other" }] }).error,
      /duplicate/i,
    );
    assert.match(
      parseAutomations({ automations: [{ ...ROW, prompt: "x".repeat(4001) }] })
        .error,
      /4000/,
    );
  });

  it("an automations-only file still presents", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
    fs.writeFileSync(
      path.join(dir, "solenta.json"),
      JSON.stringify({ automations: [ROW] }),
    );
    assert.equal(parseRepoConfig({ automations: [ROW] }), null);
    const section = readAutomations(dir);
    assert.equal(section.automations[0].id, "pr-triage");
    const presented = presentAutomationsFile({ path: dir });
    assert.equal(presented.count, 1);
    assert.equal(presented.trusted, false);
    assert.equal(presentAutomationsFile({ remoteHost: "h", path: dir }), null);
  });
});

describe("slugFromName", () => {
  it("derives pr-triage and falls back to auto", () => {
    assert.equal(slugFromName("PR triage", []), "pr-triage");
    assert.equal(slugFromName("PR triage", ["pr-triage"]), "pr-triage-2");
    assert.equal(slugFromName("!!!", []), "auto");
    assert.equal(slugFromName("!!!", ["auto"]), "auto-2");
  });
});

describe("sharedId", () => {
  it("is shared:project:slug", () => {
    assert.equal(sharedId("p1", "pr-triage"), "shared:p1:pr-triage");
  });
});

describe("mergeAutomations", () => {
  it("lists private store rows plus file rows with overlay defaults", () => {
    const dir = tempRepo([ROW]);
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    store.setAutomations([
      {
        id: "uuid-1",
        projectId: "p1",
        name: "Local",
        prompt: "x",
        provider: "claude",
        preset: "hourly",
        hour: null,
        enabled: true,
        scope: "private",
        lastRunAt: null,
        nextRunAt: 1,
        lastError: null,
      },
    ]);
    const listed = mergeAutomations(store, Date.now());
    assert.equal(listed.length, 2);
    const shared = listed.find((a) => a.scope === "project");
    assert.equal(shared.id, "shared:p1:pr-triage");
    assert.equal(shared.enabled, false);
    assert.equal(shared.prompt, ROW.prompt);
    assert.equal(shared.memory, "");
    assert.equal(shared.triggerCursor, null);
    assert.equal(canAutoFire(store, shared), false);
  });

  it("file definition wins; overlay keeps enabled/cursor/memory", () => {
    const dir = tempRepo([{ ...ROW, prompt: "From file" }]);
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir, automationsTrust: "dead".repeat(16) }]);
    store.setAutomations([
      {
        id: "shared:p1:pr-triage",
        projectId: "p1",
        scope: "project",
        name: "Stale",
        prompt: "Stale",
        provider: "claude",
        preset: "hourly",
        hour: null,
        enabled: true,
        memory: "keep me",
        triggerCursor: 9,
        lastRunAt: 1,
        nextRunAt: 2,
        lastError: null,
      },
    ]);
    const shared = mergeAutomations(store, Date.now()).find((a) => a.scope === "project");
    assert.equal(shared.prompt, "From file");
    assert.equal(shared.name, "PR triage");
    assert.equal(shared.enabled, true);
    assert.equal(shared.memory, "keep me");
    assert.equal(shared.triggerCursor, 9);
    assert.equal(canAutoFire(store, shared), false); // trust mismatch
  });

  it("gc drops overlays whose slug left the file", () => {
    const dir = tempRepo([]);
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    store.setAutomations([
      {
        id: "shared:p1:gone",
        projectId: "p1",
        scope: "project",
        name: "Gone",
        prompt: "x",
        provider: "claude",
        preset: "hourly",
        hour: null,
        enabled: true,
        lastRunAt: null,
        nextRunAt: 0,
        lastError: null,
      },
    ]);
    assert.equal(gcOrphanOverlays(store), true);
    assert.equal(store.getAutomations().length, 0);
  });

  it("keeps overlays when solenta.json is invalid; still GCs empty successful parse", () => {
    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
    fs.writeFileSync(path.join(brokenDir, "solenta.json"), "{ not json");
    const emptyDir = tempRepo([]);
    const store = new Store(path.join(emptyDir, "store.json"));
    store.setProjects([
      { id: "broken", name: "broken", path: brokenDir },
      { id: "empty", name: "empty", path: emptyDir },
    ]);
    store.setAutomations([
      {
        id: "shared:broken:keep-me",
        projectId: "broken",
        scope: "project",
        name: "Keep",
        prompt: "x",
        provider: "claude",
        preset: "hourly",
        hour: null,
        enabled: true,
        lastRunAt: null,
        nextRunAt: 0,
        lastError: null,
      },
      {
        id: "shared:empty:gone",
        projectId: "empty",
        scope: "project",
        name: "Gone",
        prompt: "x",
        provider: "claude",
        preset: "hourly",
        hour: null,
        enabled: true,
        lastRunAt: null,
        nextRunAt: 0,
        lastError: null,
      },
    ]);
    assert.equal(readAutomations(brokenDir).error != null, true);
    assert.equal(gcOrphanOverlays(store), true);
    const left = store.getAutomations();
    assert.equal(left.length, 1);
    assert.equal(left[0].id, "shared:broken:keep-me");
  });

  it("listAutomations returns the merge (same ids)", () => {
    const dir = tempRepo([ROW]);
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    store.setAutomations([
      {
        id: "uuid-1",
        projectId: "p1",
        name: "Local",
        prompt: "x",
        provider: "claude",
        preset: "hourly",
        hour: null,
        enabled: true,
        scope: "private",
        lastRunAt: null,
        nextRunAt: 1,
        lastError: null,
      },
    ]);
    const merged = mergeAutomations(store, Date.now());
    const listed = services.listAutomations(store);
    assert.deepEqual(
      listed.map((a) => a.id).sort(),
      merged.map((a) => a.id).sort(),
    );
  });
});

describe("project-scope writes", () => {
  it("add writes solenta.json, trusts, and enables", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "PR triage",
      prompt: "Triage",
      provider: "claude",
      preset: "hourly",
      scope: "project",
    });
    assert.equal(created.scope, "project");
    assert.equal(created.id, "shared:p1:pr-triage");
    assert.equal(created.enabled, true);
    const file = JSON.parse(fs.readFileSync(path.join(dir, "solenta.json"), "utf8"));
    assert.equal(file.automations[0].id, "pr-triage");
    assert.equal(file.automations[0].enabled, undefined);
    const hash = parseAutomations(file).hash;
    assert.equal(store.getProject("p1").automationsTrust, hash);
    assert.equal(canAutoFire(store, created), true);
  });

  it("teammate overlay defaults disabled; memory update does not rewrite prompt", () => {
    const dir = tempRepo([ROW]);
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    const listed = services.listAutomations(store).find((a) => a.scope === "project");
    assert.equal(listed.enabled, false);
    services.updateAutomation(store, { id: listed.id, memory: "notes" });
    const file = JSON.parse(fs.readFileSync(path.join(dir, "solenta.json"), "utf8"));
    assert.equal(file.automations[0].prompt, ROW.prompt);
    assert.equal(services.listAutomations(store)[0].memory, "notes");
  });

  it("remove drops the slug; invalid JSON is not clobbered; remote is rejected", () => {
    const dir = tempRepo([ROW]);
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    const id = "shared:p1:pr-triage";
    services.removeAutomation(store, { id });
    const file = JSON.parse(fs.readFileSync(path.join(dir, "solenta.json"), "utf8"));
    assert.deepEqual(file.automations, []);

    fs.writeFileSync(path.join(dir, "solenta.json"), "{ nope");
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    assert.throws(
      () =>
        services.addAutomation(store, {
          projectId: "p1",
          name: "X",
          prompt: "x",
          provider: "claude",
          preset: "hourly",
          scope: "project",
        }),
      /not valid JSON/,
    );
    assert.equal(fs.readFileSync(path.join(dir, "solenta.json"), "utf8"), "{ nope");

    store.setProjects([{ id: "r1", name: "r", path: dir, remoteHost: "h" }]);
    assert.throws(
      () =>
        services.addAutomation(store, {
          projectId: "r1",
          name: "X",
          prompt: "x",
          provider: "claude",
          preset: "hourly",
          scope: "project",
        }),
      /remote/i,
    );
  });

  it("rejects changing scope and a private id that starts with shared:", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    const priv = services.addAutomation(store, {
      projectId: "p1",
      name: "Local",
      prompt: "x",
      provider: "claude",
      preset: "hourly",
    });
    assert.equal(priv.scope, "private");
    assert.throws(
      () => services.updateAutomation(store, { id: priv.id, scope: "project" }),
      /scope/,
    );
    assert.throws(
      () =>
        services.addAutomation(store, {
          projectId: "p1",
          name: "Local",
          prompt: "x",
          provider: "claude",
          preset: "hourly",
          id: "shared:nope",
        }),
      /shared:/,
    );
  });

  it("preserves unknown solenta.json keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
    fs.writeFileSync(
      path.join(dir, "solenta.json"),
      JSON.stringify({ setup: "npm ci", extra: true }),
    );
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    services.addAutomation(store, {
      projectId: "p1",
      name: "PR triage",
      prompt: "Triage",
      provider: "claude",
      preset: "hourly",
      scope: "project",
    });
    const file = JSON.parse(fs.readFileSync(path.join(dir, "solenta.json"), "utf8"));
    assert.equal(file.setup, "npm ci");
    assert.equal(file.extra, true);
    assert.equal(file.automations[0].id, "pr-triage");
  });
});

describe("fire gates", () => {
  it("untrusted shared is never due", () => {
    const now = Date.now();
    const auto = {
      id: "shared:p1:pr-triage",
      scope: "project",
      enabled: true,
      nextRunAt: now - 1,
    };
    assert.equal(dueAutomations([auto], now).length, 1);

    const dir = tempRepo([ROW]);
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([
      { id: "p1", name: "p", path: dir, automationsTrust: "dead".repeat(16) },
    ]);
    store.setAutomations([
      {
        id: "shared:p1:pr-triage",
        projectId: "p1",
        scope: "project",
        name: "PR triage",
        prompt: ROW.prompt,
        provider: "claude",
        preset: "hourly",
        hour: null,
        enabled: true,
        lastRunAt: null,
        nextRunAt: now - 1,
        lastError: null,
      },
    ]);
    const shared = mergeAutomations(store, now).find((a) => a.scope === "project");
    assert.equal(canAutoFire(store, shared), false);
  });

  it("trustFile persists a matching hash and rejects a stale one", () => {
    const dir = tempRepo([ROW]);
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    const hash = readAutomations(dir).hash;
    assert.throws(
      () => services.trustFile(store, { projectId: "p1", hash: "a".repeat(64) }),
      /hash/,
    );
    services.trustFile(store, { projectId: "p1", hash });
    assert.equal(store.getProject("p1").automationsTrust, hash);
  });
});
