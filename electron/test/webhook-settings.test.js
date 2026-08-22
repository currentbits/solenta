/**
 * Issue #167: outbound webhook URL + per-event toggles on settings.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, normalizeSettings } = require("../store.js");

const EMPTY_WEBHOOK = {
  url: null,
  onDone: true,
  onFailed: true,
  onWaiting: true,
};

describe("normalizeSettings webhook", () => {
  it("absent/junk heals to off with every event on", () => {
    assert.deepEqual(normalizeSettings({}).webhook, EMPTY_WEBHOOK);
    assert.deepEqual(normalizeSettings(null).webhook, EMPTY_WEBHOOK);
    assert.deepEqual(normalizeSettings({ webhook: "nope" }).webhook, EMPTY_WEBHOOK);
    assert.deepEqual(
      normalizeSettings({ webhook: { url: "ftp://x", onDone: 1 } }).webhook,
      EMPTY_WEBHOOK,
    );
  });

  it("keeps an http(s) URL and only an explicit false turns an event off", () => {
    assert.deepEqual(
      normalizeSettings({
        webhook: {
          url: "https://hooks.slack.com/services/T/B/X",
          onDone: false,
        },
      }).webhook,
      {
        url: "https://hooks.slack.com/services/T/B/X",
        onDone: false,
        onFailed: true,
        onWaiting: true,
      },
    );
    assert.equal(
      normalizeSettings({ webhook: { url: "  https://ntfy.sh/solenta  " } })
        .webhook.url,
      "https://ntfy.sh/solenta",
    );
  });
});

describe("setSettings webhook", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-webhook-"));
    store = new Store(path.join(tmpDir, "store.json"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips a URL and event toggles; empty string clears the URL", () => {
    const set = store.setSettings({
      webhook: { url: "https://example.com/hook", onWaiting: false },
    });
    assert.deepEqual(set.webhook, {
      url: "https://example.com/hook",
      onDone: true,
      onFailed: true,
      onWaiting: false,
    });
    assert.equal(
      store.setSettings({ webhook: { url: "" } }).webhook.url,
      null,
    );
    assert.equal(store.getSettings().webhook.onWaiting, false);
  });

  it("rejects a non-http URL and a non-object patch", () => {
    assert.throws(
      () => store.setSettings({ webhook: { url: "javascript:alert(1)" } }),
      /http\(s\)/,
    );
    assert.throws(
      () => store.setSettings({ webhook: "https://example.com/hook" }),
      /webhook must be an object/,
    );
    assert.throws(
      () => store.setSettings({ webhook: { url: null, onDone: "yes" } }),
      /onDone must be a boolean/,
    );
    assert.deepEqual(store.getSettings().webhook, EMPTY_WEBHOOK);
  });

  it("survives save + reload", () => {
    store.setSettings({
      webhook: { url: "https://discord.com/api/webhooks/1/tok", onFailed: false },
    });
    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.deepEqual(reloaded.getSettings().webhook, {
      url: "https://discord.com/api/webhooks/1/tok",
      onDone: true,
      onFailed: false,
      onWaiting: true,
    });
  });
});
