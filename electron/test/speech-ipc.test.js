/**
 * Issue #845: speech IPC stub — handlers, status, payload/session guards.
 * Run: node --experimental-strip-types --test electron/test/speech-ipc.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { IPC_HANDLERS } = require("../ipc.js");

const CHANNELS = [
  "speech:status",
  "speech:download",
  "speech:start",
  "speech:write",
  "speech:stop",
  "speech:cancel",
];

const PCM_OK = Buffer.alloc(3200);
const CTX = {};

describe("speech IPC (#845)", () => {
  it("registers the speech namespace handlers", () => {
    for (const ch of CHANNELS) {
      assert.equal(typeof IPC_HANDLERS[ch], "function", ch);
    }
  });

  it("status reports missing and not ready (no sidecar)", async () => {
    const status = await IPC_HANDLERS["speech:status"](CTX);
    assert.equal(status.state, "missing");
    assert.equal(status.runtimeReady, false);
    assert.equal(status.modelReady, false);
  });

  it("download and start reject until the speech manager exists", async () => {
    await assert.rejects(
      () => IPC_HANDLERS["speech:download"](CTX),
      /Speech is not implemented yet/,
    );
    await assert.rejects(
      () => IPC_HANDLERS["speech:start"](CTX),
      /Speech is not implemented yet/,
    );
  });

  it("write rejects the wrong payload type", async () => {
    await assert.rejects(
      () =>
        IPC_HANDLERS["speech:write"](CTX, {
          sessionId: "s1",
          pcm: "not-bytes",
          seq: 0,
        }),
      /Invalid speech audio chunk/,
    );
    await assert.rejects(
      () =>
        IPC_HANDLERS["speech:write"](CTX, {
          sessionId: "s1",
          pcm: [1, 2, 3],
          seq: 0,
        }),
      /Invalid speech audio chunk/,
    );
    await assert.rejects(
      () =>
        IPC_HANDLERS["speech:write"](CTX, {
          sessionId: "s1",
          pcm: Buffer.alloc(1),
          seq: 0,
        }),
      /Invalid speech audio chunk/,
    );
  });

  it("write rejects an oversized PCM16 chunk", async () => {
    await assert.rejects(
      () =>
        IPC_HANDLERS["speech:write"](CTX, {
          sessionId: "s1",
          pcm: Buffer.alloc(3202),
          seq: 0,
        }),
      /Speech audio chunk is too large/,
    );
  });

  it("write rejects a stale session id", async () => {
    await assert.rejects(
      () =>
        IPC_HANDLERS["speech:write"](CTX, {
          sessionId: "stale-session",
          pcm: PCM_OK,
          seq: 0,
        }),
      /Unknown speech session/,
    );
  });

  it("write without a session id rejects", async () => {
    await assert.rejects(
      () => IPC_HANDLERS["speech:write"](CTX, { pcm: PCM_OK, seq: 0 }),
      /No active speech session/,
    );
  });

  it("stop and cancel without a session reject", async () => {
    await assert.rejects(
      () => IPC_HANDLERS["speech:stop"](CTX),
      /No active speech session/,
    );
    await assert.rejects(
      () => IPC_HANDLERS["speech:cancel"](CTX, {}),
      /No active speech session/,
    );
    await assert.rejects(
      () => IPC_HANDLERS["speech:stop"](CTX, { sessionId: "stale-session" }),
      /Unknown speech session/,
    );
    await assert.rejects(
      () => IPC_HANDLERS["speech:cancel"](CTX, { sessionId: "stale-session" }),
      /Unknown speech session/,
    );
  });

  it("speech:changed is desktop-only and must not ride the web wire", async () => {
    const { PUSH_CHANNELS } = await import(
      pathToFileURL(path.join(__dirname, "../../src/shared/ipcChannels.ts")).href
    );
    const { WIRE_PUSH_CHANNELS } = await import(
      pathToFileURL(path.join(__dirname, "../../src/shared/wire.ts")).href
    );
    assert.ok(
      PUSH_CHANNELS.includes("speech:changed"),
      "preload PUSH_CHANNELS must allow speech:changed",
    );
    assert.ok(
      !WIRE_PUSH_CHANNELS.includes("speech:changed"),
      "web WIRE_PUSH_CHANNELS must not carry speech:changed",
    );
  });
});
