/**
 * Issue #845: speech IPC — handlers, manager wiring, payload/session guards.
 * Run: node --experimental-strip-types --test electron/test/speech-ipc.test.js
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { EventEmitter } = require("node:events");
const { IPC_HANDLERS } = require("../ipc.js");
const {
  MODEL_FILENAME,
  SPEECH_NOT_IMPLEMENTED,
  SPEECH_NO_SESSION,
  SPEECH_STALE_SESSION,
  SPEECH_BAD_PCM,
  SPEECH_OVERSIZE,
  createSpeechManager,
} = require("../speech.js");

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
const MODEL = Buffer.from("nemo-model-bytes");
const MODEL_SHA = crypto.createHash("sha256").update(MODEL).digest("hex");

/** @type {string[]} */
let tmpDirs = [];
/** @type {Array<{ teardown: () => Promise<void> }>} */
let managers = [];

afterEach(async () => {
  for (const speech of managers) {
    try {
      await speech.teardown();
    } catch {
      // ignore
    }
  }
  managers = [];
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-speech-ipc-"));
  tmpDirs.push(dir);
  return dir;
}

class FakeWs extends EventEmitter {
  constructor(url) {
    super();
    this.url = String(url);
    this.readyState = 0;
    this.sent = [];
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
      this.emit("message", JSON.stringify({ type: "session.created" }));
    });
  }
  send(data) {
    this.sent.push(data);
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "session.update") {
          queueMicrotask(() =>
            this.emit("message", JSON.stringify({ type: "session.updated" })),
          );
        }
      } catch {
        // ignore
      }
    }
  }
  close() {
    this.readyState = 3;
  }
}

function managerCtx() {
  const userData = tmp();
  const runtimePath = path.join(tmp(), "nemo-speech");
  fs.writeFileSync(runtimePath, "fake");
  fs.mkdirSync(path.join(userData, "speech"), { recursive: true });
  fs.writeFileSync(path.join(userData, "speech", MODEL_FILENAME), MODEL);
  const child = new EventEmitter();
  child.kill = () => {
    child.emit("exit", 0);
  };
  const speech = createSpeechManager({
    userDataPath: userData,
    runtimePath,
    platform: "darwin",
    arch: "arm64",
    modelBytes: MODEL.length,
    modelSha256: MODEL_SHA,
    fetch: async () => ({ ok: false, status: 500, body: null }),
    spawn: () => child,
    WebSocket: FakeWs,
    httpGet: async () => ({ status: 200 }),
    probeFreePort: async () => 18457,
    wait: async () => {},
  });
  managers.push(speech);
  return { speech };
}

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
      { message: SPEECH_NOT_IMPLEMENTED },
    );
    await assert.rejects(
      () => IPC_HANDLERS["speech:start"](CTX),
      { message: SPEECH_NOT_IMPLEMENTED },
    );
  });

  it("write rejects the wrong payload type", async () => {
    const ctx = managerCtx();
    const { sessionId } = await IPC_HANDLERS["speech:start"](ctx);
    await assert.rejects(
      () =>
        IPC_HANDLERS["speech:write"](ctx, {
          sessionId,
          pcm: "not-bytes",
          seq: 0,
        }),
      /Invalid speech audio chunk/,
    );
    await assert.rejects(
      () =>
        IPC_HANDLERS["speech:write"](ctx, {
          sessionId,
          pcm: [1, 2, 3],
          seq: 0,
        }),
      /Invalid speech audio chunk/,
    );
    await assert.rejects(
      () =>
        IPC_HANDLERS["speech:write"](ctx, {
          sessionId,
          pcm: Buffer.alloc(1),
          seq: 0,
        }),
      /Invalid speech audio chunk/,
    );
    assert.equal(SPEECH_BAD_PCM, "Invalid speech audio chunk.");
  });

  it("write rejects an oversized PCM16 chunk", async () => {
    const ctx = managerCtx();
    const { sessionId } = await IPC_HANDLERS["speech:start"](ctx);
    await assert.rejects(
      () =>
        IPC_HANDLERS["speech:write"](ctx, {
          sessionId,
          pcm: Buffer.alloc(3202),
          seq: 0,
        }),
      { message: SPEECH_OVERSIZE },
    );
  });

  it("write rejects a stale session id", async () => {
    const ctx = managerCtx();
    await IPC_HANDLERS["speech:start"](ctx);
    await assert.rejects(
      () =>
        IPC_HANDLERS["speech:write"](ctx, {
          sessionId: "stale-session",
          pcm: PCM_OK,
          seq: 0,
        }),
      { message: SPEECH_STALE_SESSION },
    );
  });

  it("write without a session id rejects", async () => {
    const ctx = managerCtx();
    await IPC_HANDLERS["speech:start"](ctx);
    await assert.rejects(
      () => IPC_HANDLERS["speech:write"](ctx, { pcm: PCM_OK, seq: 0 }),
      { message: SPEECH_NO_SESSION },
    );
  });

  it("stop and cancel without a session reject", async () => {
    const ctx = managerCtx();
    await assert.rejects(
      () => IPC_HANDLERS["speech:stop"](ctx),
      { message: SPEECH_NO_SESSION },
    );
    await assert.rejects(
      () => IPC_HANDLERS["speech:cancel"](ctx, {}),
      { message: SPEECH_NO_SESSION },
    );
    await assert.rejects(
      () => IPC_HANDLERS["speech:stop"](ctx, { sessionId: "stale-session" }),
      { message: SPEECH_STALE_SESSION },
    );
    await assert.rejects(
      () => IPC_HANDLERS["speech:cancel"](ctx, { sessionId: "stale-session" }),
      { message: SPEECH_STALE_SESSION },
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
