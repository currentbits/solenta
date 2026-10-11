/**
 * Model routing (#246): classify, project tier → profile map, first-turn apply.
 * Run: npm run test:electron -- --test-name-pattern "model routing tiers"
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store");
const services = require("../services");
const { classifyPrompt, applyRoute, normalizeModelRouting } = require("../routing.js");

describe("model routing tiers (#246)", () => {
  let tmpDir;
  let store;
  let project;
  let savedBin;

  beforeEach(async () => {
    savedBin = process.env.CODER_GROK_BIN;
    process.env.CODER_GROK_BIN = process.execPath;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-routing-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
    store.setSettings({
      agentProfiles: [
        {
          id: "scout",
          name: "Scout",
          provider: "grok",
          model: "grok-fast",
          reasoningEffort: null,
          permissionMode: "default",
        },
      ],
    });
  });

  afterEach(() => {
    if (savedBin === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = savedBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("classifies by keywords and length", () => {
    assert.equal(classifyPrompt("fix the typo in README").tier, "fast");
    assert.equal(classifyPrompt("refactor the store into modules").tier, "strong");
    assert.equal(classifyPrompt("add a button to settings").tier, "balanced");
    assert.equal(classifyPrompt("x".repeat(2000)).tier, "strong");
    // A light keyword in a long prompt is not a light task.
    assert.equal(classifyPrompt(`rename ${"y".repeat(600)}`).tier, "balanced");
    assert.equal(normalizeModelRouting({ auto: "yes", fast: " " }), null);
  });

  it("Auto project stamps new threads; the first turn applies the tier's profile once", () => {
    services.updateProject(store, project.id, {
      modelRouting: { auto: true, fast: "scout" },
    });
    const t = services.createThread(store, { projectId: project.id, title: "T" });
    assert.equal(t.route, "auto");
    // Forks and explicit providers do not inherit the project opt-in.
    assert.equal(
      services.createThread(store, { projectId: project.id, title: "F", projectDefaults: false }).route,
      undefined,
    );

    const text = applyRoute(store, t.id, "fix the typo in README");
    assert.match(text, /fast .*→ Scout/);
    const after = store.getThread(t.id);
    assert.equal(after.provider, "grok");
    assert.equal(after.model, "grok-fast");
    assert.equal(after.route, null);
    assert.equal(applyRoute(store, t.id, "fix the typo"), null);
  });

  it("a declared tier with no profile keeps the current provider and says so", () => {
    const t = services.createThread(store, { projectId: project.id, title: "T", route: "strong" });
    const text = applyRoute(store, t.id, "anything");
    assert.match(text, /strong \(declared by the caller\); no profile set for strong/);
    assert.equal(store.getThread(t.id).provider, t.provider);
  });

  it("setRoute validates and refuses a thread that already ran", () => {
    const t = services.createThread(store, { projectId: project.id, title: "T" });
    assert.throws(() => services.setRoute(store, { threadId: t.id, route: "turbo" }), /Invalid route/);
    assert.equal(services.setRoute(store, { threadId: t.id, route: "fast" }).route, "fast");
    store.updateThread(t.id, { sessionId: "s1", route: null });
    assert.throws(
      () => services.setRoute(store, { threadId: t.id, route: "auto" }),
      /before a thread's first turn/,
    );
  });

  it("automations accept a tier and reject junk", () => {
    const base = { projectId: project.id, name: "A", prompt: "p", provider: "claude", preset: "hourly" };
    assert.equal(services.addAutomation(store, { ...base, tier: "fast" }).tier, "fast");
    assert.equal(services.addAutomation(store, base).tier, null);
    assert.throws(() => services.addAutomation(store, { ...base, tier: "max" }), /Invalid tier/);
  });
});
