/**
 * Anonymous usage ping: payload shape and opt-outs.
 * Run: npm run test:electron
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const telemetry = require("../telemetry.js");

const DAY = 24 * 60 * 60 * 1000;

describe("telemetry", () => {
  it("pings a stable install id, OS and recent providers only", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-tel-"));
    const now = 100 * DAY;
    const threads = [
      { provider: "claude", updatedAt: now - DAY },
      { provider: "codex:work", updatedAt: now - 2 * DAY },
      { provider: "claude", updatedAt: now },
      { provider: "grok", updatedAt: now - 40 * DAY },
      { updatedAt: now },
    ];
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    };
    const opts = { userData, version: "1.2.3", getThreads: () => threads, fetch, now: () => now };
    await telemetry.sendPing(opts);
    await telemetry.sendPing(opts);

    assert.equal(calls[0].url, telemetry.ENDPOINT);
    const body = calls[0].body;
    assert.deepEqual(Object.keys(body).sort(), ["arch", "installId", "platform", "providers", "version"]);
    assert.deepEqual(body.providers, ["claude", "codex"]);
    assert.equal(body.platform, process.platform);
    assert.match(body.installId, /^[0-9a-f-]{36}$/);
    assert.equal(calls[1].body.installId, body.installId, "id persists across pings");
  });

  it("honours DO_NOT_TRACK and SOLENTA_TELEMETRY=0", () => {
    assert.equal(telemetry.telemetryDisabled({}), false);
    assert.equal(telemetry.telemetryDisabled({ DO_NOT_TRACK: "1" }), true);
    assert.equal(telemetry.telemetryDisabled({ SOLENTA_TELEMETRY: "0" }), true);
  });
});
