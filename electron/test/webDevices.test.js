"use strict";

/** Solenta Web per-device tokens (#1512 I2): hashed store, legacy adoption. */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWebDevices, hashToken, FILE_NAME, LEGACY_NAME } = require("../webDevices.js");

describe("webDevices", () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-web-devices-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("add shows the token once and stores only its sha256 at 0600", () => {
    const devices = createWebDevices(tmp);
    const { device, token } = devices.add({ name: "Phone" });
    assert.equal(device.name, "Phone");
    assert.ok(token.length >= 40);
    const raw = fs.readFileSync(path.join(tmp, FILE_NAME), "utf8");
    assert.ok(!raw.includes(token), "raw token must never reach disk");
    assert.ok(raw.includes(hashToken(token)));
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(tmp, FILE_NAME)).mode & 0o777, 0o600);
    }
    assert.ok(!("token" in devices.list()[0]) && !("tokenHash" in devices.list()[0]));
  });

  it("authorize matches the right device and stamps lastSeenAt", () => {
    let t = 1000;
    const devices = createWebDevices(tmp, { now: () => t });
    const a = devices.add({ name: "A" });
    const b = devices.add({ name: "B" });
    t = 5000;
    assert.deepEqual(devices.authorize(b.token), { id: b.device.id, name: "B", scopes: ["read"] });
    assert.equal(devices.authorize("wrong"), null);
    assert.equal(devices.authorize(""), null);
    assert.equal(devices.authorize(undefined), null);
    const seen = Object.fromEntries(devices.list().map((d) => [d.name, d.lastSeenAt]));
    assert.deepEqual(seen, { A: null, B: 5000 });
    assert.ok(devices.authorize(a.token));
  });

  it("revoked tokens stop authorizing and the change survives a reload", () => {
    const devices = createWebDevices(tmp);
    const { device, token } = devices.add({ name: "Tablet" });
    devices.revoke(device.id);
    assert.equal(devices.authorize(token), null);
    assert.equal(createWebDevices(tmp).authorize(token), null);
    assert.throws(() => devices.revoke(device.id), /Unknown device/);
  });

  it("validates names", () => {
    const devices = createWebDevices(tmp);
    assert.throws(() => devices.add({ name: "  " }), /Name the device/);
    assert.throws(() => devices.add({ name: "x".repeat(61) }), /at most 60/);
  });

  it("adopts the single web-token as Legacy device, once", () => {
    fs.writeFileSync(path.join(tmp, "web-token"), "old-token\n");
    const devices = createWebDevices(tmp);
    assert.deepEqual(
      devices.list().map((d) => [d.name, d.legacy]),
      [[LEGACY_NAME, true]],
    );
    assert.ok(devices.authorize("old-token"));
    assert.equal(createWebDevices(tmp).list().length, 1, "no duplicate on reload");
  });

  it("revoking Legacy device deletes the web-token file", () => {
    fs.writeFileSync(path.join(tmp, "web-token"), "old-token");
    const devices = createWebDevices(tmp);
    devices.revoke(devices.list()[0].id);
    assert.ok(!fs.existsSync(path.join(tmp, "web-token")));
    assert.equal(createWebDevices(tmp).list().length, 0);
  });

  it("persists the server toggle, off and loopback-only by default", () => {
    const devices = createWebDevices(tmp);
    assert.deepEqual(devices.server(), { enabled: false, lan: false });
    devices.setServer({ enabled: true });
    assert.deepEqual(createWebDevices(tmp).server(), { enabled: true, lan: false });
  });
});
