"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { WebSocket } = require("ws");
const {
  limits,
  encodeVideoRecord,
} = require("../ios-simulator-protocol.js");

const DROP = limits.dropViewerBytes;
const RECOVER = limits.recoverViewerBytes;
const MAX_VIDEO = limits.maxVideoBytes;
const MIN_BITRATE = 500_000;

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function onceClose(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
  });
}

function onceBinary(ws) {
  return new Promise((resolve, reject) => {
    const onMsg = (data, isBinary) => {
      if (!isBinary && !Buffer.isBuffer(data)) return;
      cleanup();
      resolve(Buffer.isBuffer(data) ? data : Buffer.from(data));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before binary"));
    };
    const cleanup = () => {
      ws.off("message", onMsg);
      ws.off("close", onClose);
    };
    ws.on("message", onMsg);
    ws.on("close", onClose);
  });
}

function auth(ws, token, generation) {
  ws.send(JSON.stringify({ token, generation }));
}

function makeRecord(type, overrides = {}) {
  return encodeVideoRecord({
    type,
    generation: 1,
    sequence: 1,
    timestampUs: 1n,
    width: type === "avcC" ? 0 : 100,
    height: type === "avcC" ? 0 : 200,
    payload: Buffer.from([1, 2, 3]),
    ...overrides,
  });
}

describe("createIOSSimulatorStreamBroker", () => {
  /** @type {ReturnType<typeof import("../ios-simulator-stream.js").createIOSSimulatorStreamBroker> | null} */
  let broker = null;
  /** @type {string[]} */
  let logs = [];

  beforeEach(() => {
    logs = [];
  });

  afterEach(async () => {
    if (broker) {
      await broker.close();
      broker = null;
    }
  });

  async function startBroker(overrides = {}) {
    const { createIOSSimulatorStreamBroker } = require("../ios-simulator-stream.js");
    broker = createIOSSimulatorStreamBroker({
      log: (msg) => logs.push(String(msg)),
      ...overrides,
    });
    const addr = await broker.listen();
    return { broker, addr };
  }

  async function openSession(opts = {}) {
    const keyframeCalls = [];
    const bitrateCalls = [];
    const session = broker.createSession({
      generation: opts.generation ?? 7,
      requestKeyframe: () => keyframeCalls.push(Date.now()),
      setBitrate: (bps) => bitrateCalls.push(bps),
      ...opts,
    });
    return { session, keyframeCalls, bitrateCalls };
  }

  async function waitUntil(predicate, label, ms = 2000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  async function authedPair(session) {
    const helper = await connect(session.url);
    const viewer = await connect(session.url);
    auth(helper, session.helperToken, session.generation);
    auth(viewer, session.viewerToken, session.generation);
    await waitUntil(() => {
      const snap = broker.status();
      const row = snap.sessions.find((s) => s.generation === session.generation);
      return row && row.helperConnected && row.viewerConnected;
    }, "helper+viewer auth");
    return { helper, viewer };
  }

  it("listens on 127.0.0.1 only (ephemeral port)", async () => {
    const { addr } = await startBroker();
    assert.equal(addr.address, "127.0.0.1");
    assert.equal(addr.family, "IPv4");
    assert.ok(Number.isInteger(addr.port) && addr.port > 0);
    // listen is idempotent: second call returns the same binding
    const again = await broker.listen();
    assert.deepEqual(again, addr);
  });

  it("createSession returns distinct helper/viewer tokens and a loopback url", async () => {
    const tokens = [
      Buffer.alloc(32, 1),
      Buffer.alloc(32, 2),
    ];
    let i = 0;
    await startBroker({
      randomBytes: (n) => {
        const next = tokens[i++];
        assert.ok(next);
        assert.equal(next.length, n);
        return Buffer.from(next);
      },
    });
    const { session } = await openSession({ generation: 3 });
    assert.equal(session.generation, 3);
    assert.match(session.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(session.helperToken, Buffer.alloc(32, 1).toString("base64url"));
    assert.equal(session.viewerToken, Buffer.alloc(32, 2).toString("base64url"));
    assert.notEqual(session.helperToken, session.viewerToken);
  });

  it("rejects wrong token, wrong generation, and binary-before-auth", async () => {
    await startBroker();
    const { session } = await openSession({ generation: 9 });

    const wrongToken = await connect(session.url);
    const wrongTokenClosed = onceClose(wrongToken);
    auth(wrongToken, "nope", session.generation);
    await wrongTokenClosed;

    const wrongGen = await connect(session.url);
    const wrongGenClosed = onceClose(wrongGen);
    auth(wrongGen, session.helperToken, session.generation + 1);
    await wrongGenClosed;

    const earlyBinary = await connect(session.url);
    const earlyClosed = onceClose(earlyBinary);
    earlyBinary.send(makeRecord("key"));
    await earlyClosed;
  });

  it("rejects later text messages after auth", async () => {
    await startBroker();
    const { session } = await openSession();
    const { helper } = await authedPair(session);
    const closed = onceClose(helper);
    helper.send(JSON.stringify({ token: session.helperToken, generation: session.generation }));
    await closed;
  });

  it("forwards avcC, key, and jpeg to the viewer", async () => {
    await startBroker();
    const { session } = await openSession();
    const { helper, viewer } = await authedPair(session);

    for (const type of ["avcC", "key", "jpeg"]) {
      const record = makeRecord(type, { sequence: type === "avcC" ? 1 : type === "key" ? 2 : 3 });
      const got = onceBinary(viewer);
      helper.send(record);
      assert.deepEqual(await got, record);
    }

    helper.close();
    viewer.close();
  });

  it("drops delta when viewer bufferedAmount exceeds dropViewerBytes", async () => {
    let amount = 0;
    await startBroker({
      getBufferedAmount: () => amount,
    });
    const { session, keyframeCalls } = await openSession({ generation: 11 });
    const { helper, viewer } = await authedPair(session);

    const key = makeRecord("key", { sequence: 1 });
    const gotKey = onceBinary(viewer);
    helper.send(key);
    assert.deepEqual(await gotKey, key);

    amount = DROP + 1;
    let gotDelta = false;
    viewer.on("message", () => {
      gotDelta = true;
    });
    helper.send(makeRecord("delta", { sequence: 2 }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(gotDelta, false);
    assert.equal(keyframeCalls.length, 0);

    // Non-delta still forwards under backpressure.
    const jpeg = makeRecord("jpeg", { sequence: 3 });
    const gotJpeg = onceBinary(viewer);
    helper.send(jpeg);
    assert.deepEqual(await gotJpeg, jpeg);

    helper.close();
    viewer.close();
  });

  it("requests one keyframe after recovery below recoverViewerBytes", async () => {
    let amount = DROP + 1;
    await startBroker({
      getBufferedAmount: () => amount,
    });
    const { session, keyframeCalls, bitrateCalls } = await openSession({ generation: 12 });
    const { helper, viewer } = await authedPair(session);

    // Enter drop cycle.
    helper.send(makeRecord("delta", { sequence: 1 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(keyframeCalls.length, 0);
    assert.ok(bitrateCalls.length >= 1);
    assert.ok(bitrateCalls.every((b) => b >= MIN_BITRATE));

    // Recover: next delta sees amount below recover and requests IDR once.
    amount = RECOVER - 1;
    helper.send(makeRecord("delta", { sequence: 2 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(keyframeCalls.length, 1);

    // Still recovered: further deltas do not request another IDR this cycle.
    helper.send(makeRecord("delta", { sequence: 3 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(keyframeCalls.length, 1);

    // New drop cycle, then recover again → second IDR request.
    amount = DROP + 1;
    helper.send(makeRecord("delta", { sequence: 4 }));
    await new Promise((r) => setTimeout(r, 20));
    amount = RECOVER - 1;
    helper.send(makeRecord("delta", { sequence: 5 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(keyframeCalls.length, 2);

    helper.close();
    viewer.close();
  });

  it("never asks setBitrate below 500_000", async () => {
    let amount = DROP + 1;
    await startBroker({
      getBufferedAmount: () => amount,
    });
    const { session, bitrateCalls } = await openSession({ generation: 13 });
    const { helper, viewer } = await authedPair(session);

    // Repeated drop entries should floor at 500 Kbps.
    for (let i = 0; i < 8; i++) {
      amount = DROP + 1;
      helper.send(makeRecord("delta", { sequence: i + 1 }));
      await new Promise((r) => setTimeout(r, 10));
      amount = RECOVER - 1;
      helper.send(makeRecord("key", { sequence: 100 + i }));
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(bitrateCalls.length >= 1);
    assert.ok(bitrateCalls.every((b) => b >= MIN_BITRATE));
    assert.equal(Math.min(...bitrateCalls), MIN_BITRATE);

    helper.close();
    viewer.close();
  });

  it("rejects binary over maxVideoBytes and malformed records", async () => {
    await startBroker();
    const { session } = await openSession({ generation: 14 });

    const helperOversize = await connect(session.url);
    auth(helperOversize, session.helperToken, session.generation);
    await new Promise((r) => setImmediate(r));
    const overClosed = onceClose(helperOversize);
    helperOversize.send(Buffer.alloc(MAX_VIDEO + 33, 7));
    await overClosed;

    const helperBad = await connect(session.url);
    auth(helperBad, session.helperToken, session.generation);
    await new Promise((r) => setImmediate(r));
    const badClosed = onceClose(helperBad);
    helperBad.send(Buffer.from("not-a-video-record"));
    await badClosed;
  });

  it("closeSession and close terminate sockets; logs omit tokens", async () => {
    await startBroker();
    const { session } = await openSession({ generation: 15 });
    const { helper, viewer } = await authedPair(session);
    const helperClosed = onceClose(helper);
    const viewerClosed = onceClose(viewer);

    broker.closeSession(session.generation);
    await Promise.all([helperClosed, viewerClosed]);

    for (const line of logs) {
      assert.equal(line.includes(session.helperToken), false, `log leaked helper token: ${line}`);
      assert.equal(line.includes(session.viewerToken), false, `log leaked viewer token: ${line}`);
    }

    const status = broker.status();
    const blob = JSON.stringify(status);
    assert.equal(blob.includes(session.helperToken), false);
    assert.equal(blob.includes(session.viewerToken), false);
    assert.equal(status.listening, true);

    await broker.close();
    broker = null;
    // After close, a new broker can listen again (covered by afterEach + other tests).
  });
});
