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

  it("shows rows adopted under the old name as SSH and command line", () => {
    fs.writeFileSync(
      path.join(tmp, FILE_NAME),
      JSON.stringify({
        server: { enabled: false, lan: false },
        devices: [{ id: "x", name: "Legacy device", tokenHash: hashToken("t"), createdAt: 1, lastSeenAt: null, legacy: true }],
      }),
    );
    assert.deepEqual(createWebDevices(tmp).list().map((d) => d.name), [LEGACY_NAME]);
    assert.equal(LEGACY_NAME, "SSH and command line");
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

describe("cloud device enrollment", () => {
  let tmp;
  let time;
  let devices;
  const cloud = { accountId: "owner-one", linkId: "link-one", generation: 1, jkt: "a".repeat(43) };
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-cloud-device-"));
    time = 1000;
    devices = createWebDevices(tmp, { now: () => time });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const input = (nonce, extra = {}) => ({ name: "Cloud desktop", scopes: ["read"], cloud, nonce, ...extra });

  it("a cloud grant needs its verified client binding and can be consumed once", () => {
    const enrollment = devices.createCloudEnrollment(input("unique-mint-nonce-one"));
    assert.throws(() => devices.redeemEnrollment({ grant: enrollment.grant }), /client proof/);
    assert.throws(() => devices.redeemCloudEnrollment({ grant: enrollment.grant, cloud: { ...cloud, jkt: "b".repeat(43) } }), /binding/);
    const session = devices.redeemCloudEnrollment({ grant: enrollment.grant, cloud });
    assert.deepEqual(session.device.scopes, ["read"]);
    assert.equal(session.expiresAt, 601000);
    assert.ok(devices.authorize(session.token));
    assert.throws(() => devices.redeemCloudEnrollment({ grant: enrollment.grant, cloud }), /invalid, expired or already used/);
    assert.throws(() => devices.createCloudEnrollment(input("unique-mint-nonce-one")), /already used/);
    const raw = fs.readFileSync(path.join(tmp, FILE_NAME), "utf8");
    assert.equal(raw.includes(session.token), false);
  });

  it("renewal rotates one device's credential without widening or duplicating its grant", () => {
    const first = devices.redeemCloudEnrollment({ grant: devices.createCloudEnrollment(input("unique-mint-nonce-one")).grant, cloud });
    time = 301000;
    assert.throws(() => devices.createCloudEnrollment(input("unique-mint-nonce-two", { deviceId: first.device.id, scopes: ["full"] })), /cannot grant that access/);
    const renew = devices.createCloudEnrollment(input("unique-mint-nonce-two", { deviceId: first.device.id }));
    const second = devices.redeemCloudEnrollment({ grant: renew.grant, cloud });
    assert.equal(second.device.id, first.device.id);
    assert.deepEqual(second.device.scopes, ["read"]);
    assert.equal(second.expiresAt, 901000);
    assert.equal(devices.list().length, 1);
    assert.equal(devices.authorize(first.token), null);
    assert.ok(createWebDevices(tmp, { now: () => time }).authorize(second.token));
    assert.throws(() => devices.createCloudEnrollment(input("unique-mint-nonce-three", { cloud: { ...cloud, accountId: "other" }, deviceId: first.device.id })), /binding/);
    time = 901000;
    assert.equal(devices.authorize(second.token), null);
  });

  it("competing renewals cannot invalidate the credential that already won", () => {
    const first = devices.redeemCloudEnrollment({ grant: devices.createCloudEnrollment(input("unique-mint-nonce-one")).grant, cloud });
    const one = devices.createCloudEnrollment(input("unique-mint-nonce-two", { deviceId: first.device.id }));
    const two = devices.createCloudEnrollment(input("unique-mint-nonce-three", { deviceId: first.device.id }));
    const winner = devices.redeemCloudEnrollment({ grant: one.grant, cloud });
    assert.throws(() => devices.redeemCloudEnrollment({ grant: two.grant, cloud }), /changed/);
    assert.ok(devices.authorize(winner.token));
  });

  it("cloud unlink removes its sessions and pending grants while preserving other access", () => {
    const direct = devices.add({ name: "Direct phone", scopes: ["full"] });
    const session = devices.redeemCloudEnrollment({ grant: devices.createCloudEnrollment(input("unique-mint-nonce-one")).grant, cloud });
    const pending = devices.createCloudEnrollment(input("unique-mint-nonce-two"));
    assert.deepEqual(devices.revokeCloud(cloud.linkId), [session.device.id]);
    assert.equal(devices.authorize(session.token), null);
    assert.ok(devices.authorize(direct.token));
    assert.throws(() => devices.redeemCloudEnrollment({ grant: pending.grant, cloud }), /invalid, expired or already used/);
  });
});

describe("one-time browser enrollment", () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-enrollment-")); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("stores hashes, atomically exchanges once, and keeps consumption and session across restart", async () => {
    const first = createWebDevices(tmp);
    const second = createWebDevices(tmp);
    const issued = first.createEnrollment({ name: "Phone", scopes: ["read", "steer"] });
    assert.doesNotMatch(fs.readFileSync(path.join(tmp, FILE_NAME), "utf8"), new RegExp(issued.grant));
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => Promise.resolve().then(() => (i % 2 ? first : second).redeemEnrollment({ grant: issued.grant })).then(value => ({ value }), error => ({ error }))));
    const successes = results.filter(r => r.value);
    assert.equal(successes.length, 1);
    assert.equal(results.filter(r => r.error).length, 7);
    const session = successes[0].value;
    assert.deepEqual(session.device.scopes, ["read", "steer"]);
    assert.ok(session.expiresAt > Date.now());
    const restarted = createWebDevices(tmp);
    assert.ok(restarted.authorize(session.token));
    assert.throws(() => restarted.redeemEnrollment({ grant: issued.grant }), /already used/);
    const stored = fs.readFileSync(path.join(tmp, FILE_NAME), "utf8");
    assert.ok(!stored.includes(issued.grant) && !stored.includes(session.token));
    assert.equal(restarted.list().length, 1);
    assert.equal(restarted.list()[0].expiresAt, session.expiresAt);
  });

  it("refuses scope expansion without consuming the grant and honors implied terminal observe", () => {
    const devices = createWebDevices(tmp);
    const issued = devices.createEnrollment({ name: "Viewer", scopes: ["read", "terminal:type"] });
    assert.throws(() => devices.redeemEnrollment({ grant: issued.grant, scopes: ["full"] }), /cannot grant/);
    assert.throws(() => devices.redeemEnrollment({ grant: issued.grant, scopes: ["unknown"] }), /invalid/);
    const session = devices.redeemEnrollment({ grant: issued.grant, scopes: ["read", "terminal:observe"] });
    assert.deepEqual(session.device.scopes, ["read", "terminal:observe"]);
  });

  it("expires enrollment and session exactly at their deadlines while preserving direct tokens", () => {
    let time = 1000;
    const devices = createWebDevices(tmp, { now: () => time, enrollmentTtlMs: 100, sessionTtlMs: 500 });
    const direct = devices.add({ name: "Direct computer", scopes: ["full"] });
    const expired = devices.createEnrollment({ name: "Too late" });
    time = expired.expiresAt;
    assert.throws(() => devices.redeemEnrollment({ grant: expired.grant }), /expired/);
    const issued = devices.createEnrollment({ name: "Browser" });
    const session = devices.redeemEnrollment({ grant: issued.grant });
    time = session.expiresAt - 1;
    assert.ok(devices.authorize(session.token));
    time += 1;
    assert.equal(devices.authorize(session.token), null);
    assert.ok(devices.authorize(direct.token));
    devices.revoke(session.device.id);
    assert.ok(devices.authorize(direct.token));
  });

  it("recovers a dead writer's lock without reviving a consumed grant", () => {
    const devices = createWebDevices(tmp);
    const issued = devices.createEnrollment({ name: "Browser" });
    const session = devices.redeemEnrollment({ grant: issued.grant });
    fs.writeFileSync(path.join(tmp, "web-access.lock"), "2147483647");
    const restarted = createWebDevices(tmp);
    assert.throws(() => restarted.redeemEnrollment({ grant: issued.grant }), /already used/);
    assert.ok(restarted.authorize(session.token));
  });
});

it("a failed durable session write does not consume the grant", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-enrollment-failure-"));
  const devices = createWebDevices(tmp);
  const issued = devices.createEnrollment({ name: "Browser" });
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error("injected persist failure"); };
    assert.throws(() => devices.redeemEnrollment({ grant: issued.grant }), /persist failure/);
    fs.renameSync = rename;
    assert.equal(createWebDevices(tmp).list().length, 0);
    assert.ok(devices.redeemEnrollment({ grant: issued.grant }).token);
  } finally { fs.renameSync = rename; fs.rmSync(tmp, { recursive: true, force: true }); }
});

describe("device lock recovery serialization", () => {
  let tmp;
  let devices;
  let issued;
  let lockFile;
  let recoveryFile;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-enrollment-lock-race-"));
    devices = createWebDevices(tmp);
    issued = devices.createEnrollment({ name: "Browser" });
    lockFile = path.join(tmp, "web-access.lock");
    recoveryFile = `${lockFile}.recovery`;
    fs.writeFileSync(lockFile, "2147483647");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("re-reads ownership under its recovery guard and never removes a new live owner's lock", () => {
    const link = fs.linkSync;
    let raced = false;
    let liveInode;
    try {
      fs.linkSync = (source, target, ...args) => {
        if (target === recoveryFile && !raced) {
          raced = true;
          // Another contender recovered the original stale lock and acquired
          // a live lock while this contender was waiting for recovery access.
          fs.unlinkSync(lockFile);
          fs.writeFileSync(lockFile, String(process.pid));
          liveInode = fs.statSync(lockFile).ino;
        }
        return link(source, target, ...args);
      };
      assert.throws(() => devices.redeemEnrollment({ grant: issued.grant }), /being changed/);
      assert.equal(raced, true);
      assert.equal(fs.readFileSync(lockFile, "utf8"), String(process.pid));
      assert.equal(fs.statSync(lockFile).ino, liveInode, "the new owner's inode must survive");
      assert.equal(fs.existsSync(recoveryFile), false);
      assert.equal(devices.list().length, 0, "a losing contender must not issue a session");
    } finally { fs.linkSync = link; }
    fs.unlinkSync(lockFile);
    assert.ok(devices.redeemEnrollment({ grant: issued.grant }).token, "the losing attempt left the grant unspent");
  });

  it("does not steal another recovery guard, even if its ownership is uncertain", () => {
    fs.writeFileSync(recoveryFile, "");
    assert.throws(() => devices.redeemEnrollment({ grant: issued.grant }), /stop Solenta before removing web-access.lock.recovery/);
    assert.equal(fs.readFileSync(lockFile, "utf8"), "2147483647");
    assert.equal(fs.readFileSync(recoveryFile, "utf8"), "");
    assert.equal(devices.list().length, 0);
  });

  it("serializes a second contender while the first inspects a stale lock", () => {
    const second = createWebDevices(tmp);
    const read = fs.readFileSync;
    let contended = false;
    try {
      fs.readFileSync = (file, ...args) => {
        if (file === lockFile && !contended) {
          contended = true;
          assert.ok(fs.existsSync(recoveryFile), "inspection requires exclusive recovery ownership");
          assert.throws(() => second.redeemEnrollment({ grant: issued.grant }), /recovery is already in progress/);
        }
        return read(file, ...args);
      };
      assert.ok(devices.redeemEnrollment({ grant: issued.grant }).token);
    } finally { fs.readFileSync = read; }
    assert.equal(contended, true);
    assert.equal(devices.list().length, 1);
    assert.throws(() => second.redeemEnrollment({ grant: issued.grant }), /already used/);
  });
});
