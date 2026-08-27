/**
 * Model routing (#711): settings default provider/model, quota failover chain.
 * Run: npm run test:electron -- --test-name-pattern "model routing"
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store, normalizeSettings } = require("../store");
const services = require("../services");
const { nextQuotaFailover } = require("../quotaWait.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("model routing settings (#711)", () => {
  it("absent/junk defaultProvider, defaultModel, quotaFailover heal", () => {
    assert.equal(normalizeSettings({}).defaultProvider, null);
    assert.equal(normalizeSettings({}).defaultModel, null);
    assert.deepEqual(normalizeSettings({}).quotaFailover, []);
    assert.equal(normalizeSettings({ defaultProvider: 1 }).defaultProvider, null);
    assert.equal(normalizeSettings({ defaultProvider: "" }).defaultProvider, null);
    assert.equal(normalizeSettings({ defaultProvider: " grok " }).defaultProvider, "grok");
    assert.equal(normalizeSettings({ defaultModel: " x " }).defaultModel, "x");
    assert.deepEqual(
      normalizeSettings({ quotaFailover: ["grok", "grok", "", 1, "kimi"] }).quotaFailover,
      ["grok", "kimi"],
    );
    assert.deepEqual(normalizeSettings({ quotaFailover: "grok" }).quotaFailover, []);
  });

  it("setSettings validates and round-trips", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-routing-"));
    try {
      const store = new Store(path.join(dir, "store.json"));
      const next = services.setSettings(store, {
        defaultProvider: " grok ",
        defaultModel: " grok-4.6 ",
        quotaFailover: ["kimi", "kimi", "claude"],
      });
      assert.equal(next.defaultProvider, "grok");
      assert.equal(next.defaultModel, "grok-4.6");
      assert.deepEqual(next.quotaFailover, ["kimi", "claude"]);
      store.saveNow();
      const reloaded = new Store(path.join(dir, "store.json"));
      assert.equal(reloaded.getSettings().defaultProvider, "grok");
      assert.equal(reloaded.getSettings().defaultModel, "grok-4.6");
      assert.deepEqual(reloaded.getSettings().quotaFailover, ["kimi", "claude"]);
      assert.throws(
        () => services.setSettings(store, { defaultProvider: 1 }),
        /defaultProvider must be a string or null/,
      );
      assert.throws(
        () => services.setSettings(store, { quotaFailover: "grok" }),
        /quotaFailover must be an array/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createThread uses settings default provider/model", () => {
  let tmpDir;
  let store;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-routing-thr-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    project = await services.addProject(store, repo);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stays claude when the default is unset", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    assert.equal(thread.provider, "claude");
    assert.equal(thread.model, null);
  });

  it("uses settings.defaultProvider and defaultModel", () => {
    services.setSettings(store, {
      defaultProvider: "grok",
      defaultModel: "grok-4.6",
    });
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    assert.equal(thread.provider, "grok");
    assert.equal(thread.model, "grok-4.6");
  });

  it("explicit input.provider wins over settings", () => {
    services.setSettings(store, { defaultProvider: "grok", defaultModel: "grok-4.6" });
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
      provider: "kimi",
    });
    assert.equal(thread.provider, "kimi");
    assert.equal(thread.model, null, "settings model must not follow a different provider");
  });

  it("unknown settings.defaultProvider falls back to claude", () => {
    services.setSettings(store, { defaultProvider: "not-a-cli" });
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    assert.equal(thread.provider, "claude");
  });
});

describe("nextQuotaFailover", () => {
  const text = "account quota or balance is exhausted. Please top up.";

  it("empty chain or non-quota text → null", () => {
    assert.equal(
      nextQuotaFailover({
        text,
        thread: { provider: "claude" },
        settings: { quotaFailover: [] },
      }),
      null,
    );
    assert.equal(
      nextQuotaFailover({
        text: "Daily budget of $1.00 reached",
        thread: { provider: "claude" },
        settings: { quotaFailover: ["grok"] },
      }),
      null,
    );
  });

  it("skips the current provider and already-tried ids", () => {
    const hit = nextQuotaFailover({
      text,
      thread: { provider: "claude", quotaFailoverTried: ["grok"] },
      settings: { quotaFailover: ["claude", "grok", "kimi"] },
    });
    assert.deepEqual(hit, { provider: "kimi", tried: ["grok", "claude", "kimi"] });
  });

  it("returns null when the chain is exhausted", () => {
    assert.equal(
      nextQuotaFailover({
        text,
        thread: { provider: "kimi", quotaFailoverTried: ["claude", "grok"] },
        settings: { quotaFailover: ["grok", "kimi"] },
      }),
      null,
    );
  });
});
