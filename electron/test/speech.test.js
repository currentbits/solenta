/**
 * Issue #845: main-process NeMo-Speech.cpp manager.
 * Run: node --experimental-strip-types --test electron/test/speech.test.js
 */
"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { IPC_HANDLERS } = require("../ipc.js");
const {
  MODEL_FILENAME,
  MODEL_BYTES,
  MODEL_SHA256,
  SPEECH_NO_SESSION,
  SPEECH_STALE_SESSION,
  SPEECH_BAD_PCM,
  SPEECH_OVERSIZE,
  serveDevice,
  bundledRuntimePath,
  allowSpeechMediaPermission,
  isSolentaMainFrame,
  installSpeechMediaPermissions,
  createSpeechManager,
} = require("../speech.js");

const PCM = Buffer.alloc(3200);

const MODEL = Buffer.from("nemo-model-bytes");
const MODEL_SHA = crypto.createHash("sha256").update(MODEL).digest("hex");

/** @type {string[]} */
let tmpDirs = [];

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-speech-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function seedRuntime(dir, name = "nemo-speech") {
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, "fake");
  return bin;
}

function seedModel(userData, buf = MODEL) {
  const dir = path.join(userData, "speech");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MODEL_FILENAME), buf);
}

function modelPath(userData) {
  return path.join(userData, "speech", MODEL_FILENAME);
}

function partialPath(userData) {
  return `${modelPath(userData)}.partial`;
}

function bytesFetch(buf, { hangAfter = -1 } = {}) {
  return async (_url, opts) => ({
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        if (hangAfter < 0) {
          yield buf;
          return;
        }
        yield buf.subarray(0, hangAfter);
        await new Promise((_resolve, reject) => {
          const signal = opts && opts.signal;
          const fail = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal && signal.aborted) {
            fail();
            return;
          }
          if (signal) signal.addEventListener("abort", fail, { once: true });
        });
      },
    },
  });
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.kill = (sig) => {
    child.killed = sig;
    child.exitCode = 0;
    child.emit("exit", 0, sig);
  };
  return child;
}

function fakeSpawnBox() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = fakeChild();
    calls.push({ cmd, args, opts, child });
    return child;
  };
  return { spawn, calls };
}

class FakeWs extends EventEmitter {
  constructor(url) {
    super();
    this.url = String(url);
    this.readyState = 0;
    this.sent = [];
    this.autoDelta = "Hi";
    this.autoTranscript = "Hi there";
    this.autoComplete = true;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
      this.emit("message", JSON.stringify({ type: "session.created" }));
    });
  }

  send(data) {
    this.sent.push(data);
    if (typeof data !== "string") return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === "session.update") {
      queueMicrotask(() =>
        this.emit("message", JSON.stringify({ type: "session.updated" })),
      );
    }
    if (msg.type === "input_audio_buffer.commit" && this.autoComplete) {
      queueMicrotask(() => {
        if (this.autoDelta) {
          this.emit(
            "message",
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.delta",
              delta: this.autoDelta,
            }),
          );
        }
        this.emit(
          "message",
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            transcript: this.autoTranscript,
          }),
        );
      });
    }
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close"));
  }
}

function harness(overrides = {}) {
  const userData = overrides.userData || tmp();
  const runtimeDir = tmp();
  const runtimePath =
    overrides.runtimePath === undefined
      ? seedRuntime(runtimeDir)
      : overrides.runtimePath;
  const sockets = [];
  const Ws = class extends FakeWs {
    constructor(url) {
      super(url);
      sockets.push(this);
    }
  };
  const { spawn, calls } = fakeSpawnBox();
  const pushes = [];
  const speech = createSpeechManager({
    userDataPath: userData,
    runtimePath,
    platform: overrides.platform || "darwin",
    arch: overrides.arch || "arm64",
    modelBytes: overrides.modelBytes || MODEL.length,
    modelSha256: overrides.modelSha256 || MODEL_SHA,
    modelUrl: overrides.modelUrl || "https://example.invalid/model.gguf",
    fetch: overrides.fetch || bytesFetch(MODEL),
    spawn: overrides.spawn || spawn,
    WebSocket: overrides.WebSocket || Ws,
    httpGet: overrides.httpGet || (async () => ({ status: 200 })),
    probeFreePort: overrides.probeFreePort || (async () => 18457),
    readyTimeoutMs: overrides.readyTimeoutMs || 200,
    readyPollMs: 1,
    sessionTimeoutMs: overrides.sessionTimeoutMs || 200,
    stopTimeoutMs: overrides.stopTimeoutMs || 200,
    wait: async () => {},
    onStatus: (s) => pushes.push(s),
    ...overrides.extra,
  });
  return {
    speech,
    userData,
    runtimePath,
    sockets,
    spawnCalls: calls,
    pushes,
  };
}

describe("serveDevice / bundledRuntimePath", () => {
  it("pins metal on macOS arm64 and cpu on linux/windows x64", () => {
    assert.equal(serveDevice("darwin", "arm64"), "metal");
    assert.equal(serveDevice("linux", "x64"), "cpu");
    assert.equal(serveDevice("win32", "x64"), "cpu");
    assert.equal(serveDevice("darwin", "x64"), null);
    assert.equal(serveDevice("linux", "arm64"), null);
  });

  it("resolves the bundled extraResource and never a PATH binary", () => {
    assert.equal(
      bundledRuntimePath({
        platform: "darwin",
        arch: "arm64",
        resourcesPath: "/app/Resources",
      }),
      path.join("/app/Resources", "speech", "bin", "nemo-speech"),
    );
    assert.equal(
      bundledRuntimePath({
        platform: "win32",
        arch: "x64",
        resourcesPath: "C:\\app\\resources",
      }),
      path.join("C:\\app\\resources", "speech", "bin", "nemo-speech.exe"),
    );
    assert.equal(
      bundledRuntimePath({
        platform: "darwin",
        arch: "x64",
        resourcesPath: "/app/Resources",
      }),
      null,
    );
  });
});

describe("allowSpeechMediaPermission", () => {
  const audio = {
    permission: "media",
    mediaType: "audio",
    isMainFrame: true,
    isGuest: false,
    isSolenta: true,
    recordingRequested: true,
  };

  it("grants audio media only while Composer has started a recording", () => {
    assert.equal(allowSpeechMediaPermission(audio), true);
    assert.equal(
      allowSpeechMediaPermission({ ...audio, recordingRequested: false }),
      false,
    );
  });

  it("denies video, guest webview, subframe, and non-Solenta frames", () => {
    assert.equal(allowSpeechMediaPermission({ ...audio, mediaType: "video" }), false);
    assert.equal(
      allowSpeechMediaPermission({ ...audio, mediaTypes: ["audio", "video"] }),
      false,
    );
    assert.equal(allowSpeechMediaPermission({ ...audio, isGuest: true }), false);
    assert.equal(
      allowSpeechMediaPermission({ ...audio, isMainFrame: false }),
      false,
    );
    assert.equal(allowSpeechMediaPermission({ ...audio, isSolenta: false }), false);
  });

  it("does not take over non-media permissions", () => {
    assert.equal(
      allowSpeechMediaPermission({
        permission: "notifications",
        isSolenta: false,
        recordingRequested: false,
      }),
      true,
    );
  });
});

describe("isSolentaMainFrame", () => {
  it("accepts the file: renderer and the vite dev server, not a webview", () => {
    assert.equal(
      isSolentaMainFrame(
        { getType: () => "window", getURL: () => "file:///app/dist/index.html" },
        { isMainFrame: true },
        { isDev: false },
      ),
      true,
    );
    assert.equal(
      isSolentaMainFrame(
        { getType: () => "window", getURL: () => "http://localhost:5173/" },
        { isMainFrame: true, requestingUrl: "http://localhost:5173/" },
        { isDev: true, devServerUrl: "http://localhost:5173" },
      ),
      true,
    );
    assert.equal(
      isSolentaMainFrame(
        { getType: () => "webview", getURL: () => "file:///app/dist/index.html" },
        { isMainFrame: true },
        { isDev: false },
      ),
      false,
    );
  });
});

describe("createSpeechManager download", () => {
  it("streams SHA-256, pins length, and atomically installs", async () => {
    const { speech, userData, pushes } = harness();
    await speech.download();
    const dest = modelPath(userData);
    assert.equal(fs.readFileSync(dest).equals(MODEL), true);
    assert.equal(fs.existsSync(partialPath(userData)), false);
    assert.equal(speech.status().state, "ready");
    assert.equal(speech.status().modelReady, true);
    assert.ok(pushes.some((p) => p.state === "downloading" && p.download));
    assert.equal(pushes.at(-1).state, "ready");
  });

  it("deletes a truncated or mismatched partial and leaves dest alone", async () => {
    const userData = tmp();
    fs.mkdirSync(path.join(userData, "speech"), { recursive: true });
    fs.writeFileSync(modelPath(userData), "prior");
    const { speech } = harness({
      userData,
      fetch: bytesFetch(Buffer.from("nope-not-the-model")),
    });
    await assert.rejects(() => speech.download(), /digest mismatch|wrong size/);
    assert.equal(fs.readFileSync(modelPath(userData), "utf8"), "prior");
    assert.equal(fs.existsSync(partialPath(userData)), false);
    assert.equal(speech.status().modelReady, false);
  });

  it("teardown aborts an in-flight download and deletes the partial", async () => {
    const { speech, userData } = harness({
      fetch: bytesFetch(MODEL, { hangAfter: 4 }),
    });
    const job = speech.download();
    for (let i = 0; i < 30 && speech.status().state !== "downloading"; i++) {
      await new Promise((r) => setImmediate(r));
    }
    await speech.teardown();
    await assert.rejects(() => job, /cancel|abort/i);
    assert.equal(fs.existsSync(partialPath(userData)), false);
    assert.equal(fs.existsSync(modelPath(userData)), false);
  });
});

describe("createSpeechManager session", () => {
  it("starts a loopback sidecar with the API key in env, not argv", async () => {
    const { speech, userData, runtimePath, spawnCalls, sockets } = harness();
    seedModel(userData);
    const started = await speech.start();
    assert.equal(typeof started.sessionId, "string");
    assert.ok(started.sessionId);
    assert.equal(spawnCalls.length, 1);
    const { cmd, args, opts } = spawnCalls[0];
    assert.equal(cmd, runtimePath);
    assert.deepEqual(args.slice(0, 5), [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "18457",
    ]);
    assert.ok(args.includes("--no-ui"));
    assert.ok(args.includes("--device"));
    assert.equal(args[args.indexOf("--device") + 1], "metal");
    assert.equal(args[args.indexOf("--read-timeout") + 1], "600");
    assert.equal(args[args.indexOf("--write-timeout") + 1], "600");
    assert.ok(!args.includes("--api-key"));
    assert.ok(!args.some((a) => String(a).includes(opts.env.NEMO_SPEECH_HTTP_API_KEY)));
    assert.match(opts.env.NEMO_SPEECH_HTTP_API_KEY, /^[0-9a-f]{64}$/);
    assert.equal(opts.shell, false);
    assert.ok(sockets[0].url.includes("/v1/realtime?api_key="));
    const update = sockets[0].sent.find(
      (s) => typeof s === "string" && JSON.parse(s).type === "session.update",
    );
    assert.deepEqual(JSON.parse(update).session, {
      sample_rate: 16000,
      automatic_punctuation: true,
    });
    assert.equal(speech.status().state, "recording");
    assert.equal(speech.isRecordingRequested(), true);
  });

  it("spawns the Windows exe from bin/ so adjacent DLLs load", async () => {
    const runtimeDir = tmp();
    const binDir = path.join(runtimeDir, "bin");
    fs.mkdirSync(binDir);
    const runtimePath = seedRuntime(binDir, "nemo-speech.exe");
    const userData = tmp();
    seedModel(userData);
    const { speech, spawnCalls } = harness({
      userData,
      runtimePath,
      platform: "win32",
      arch: "x64",
    });
    await speech.start();
    assert.equal(spawnCalls[0].opts.cwd, binDir);
    assert.equal(
      spawnCalls[0].args[spawnCalls[0].args.indexOf("--device") + 1],
      "cpu",
    );
    await speech.teardown();
  });

  it("rejects malformed, oversized, stale, and out-of-order PCM", async () => {
    const { speech, userData } = harness();
    seedModel(userData);
    const { sessionId } = await speech.start();
    await assert.rejects(
      () => speech.write({ sessionId, pcm: "nope", seq: 0 }),
      { message: SPEECH_BAD_PCM },
    );
    await assert.rejects(
      () => speech.write({ sessionId, pcm: Buffer.alloc(1), seq: 0 }),
      { message: SPEECH_BAD_PCM },
    );
    await assert.rejects(
      () => speech.write({ sessionId, pcm: Buffer.alloc(3202), seq: 0 }),
      { message: SPEECH_OVERSIZE },
    );
    await assert.rejects(
      () => speech.write({ sessionId: "stale", pcm: PCM, seq: 0 }),
      { message: SPEECH_STALE_SESSION },
    );
    await assert.rejects(
      () => speech.write({ pcm: PCM, seq: 0 }),
      { message: SPEECH_NO_SESSION },
    );
    await assert.rejects(
      () => speech.write({ sessionId, pcm: PCM, seq: 1 }),
      { message: SPEECH_BAD_PCM },
    );
    await speech.write({ sessionId, pcm: PCM, seq: 0 });
    await speech.write({ sessionId, pcm: PCM, seq: 1 });
    await assert.rejects(
      () => speech.write({ sessionId, pcm: PCM, seq: 1 }),
      { message: SPEECH_BAD_PCM },
    );
  });

  it("concatenates delta suffixes and replaces on completed", async () => {
    const { speech, userData, sockets, pushes } = harness();
    seedModel(userData);
    const { sessionId } = await speech.start();
    const ws = sockets[0];
    ws.emit(
      "message",
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "Quick",
      }),
    );
    ws.emit(
      "message",
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "",
      }),
    );
    ws.emit(
      "message",
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        delta: " brown",
      }),
    );
    const deltas = pushes.filter((p) => typeof p.delta === "string");
    assert.deepEqual(
      deltas.map((p) => p.delta),
      ["Quick", " brown"],
    );
    await speech.stop({ sessionId });
    const finals = pushes.filter((p) => typeof p.transcript === "string");
    assert.equal(finals.at(-1).transcript, "Hi there");
    assert.equal(speech.status().state, "ready");
    assert.equal(speech.isRecordingRequested(), false);
  });

  it("cancel closes without a final transcript", async () => {
    const { speech, userData, sockets, pushes } = harness();
    seedModel(userData);
    const { sessionId } = await speech.start();
    const n = pushes.length;
    await speech.cancel({ sessionId });
    assert.ok(!pushes.slice(n).some((p) => p.transcript));
    assert.ok(
      sockets[0].sent.some(
        (s) =>
          typeof s === "string" &&
          JSON.parse(s).type === "input_audio_buffer.clear",
      ),
    );
    assert.equal(speech.status().state, "ready");
  });

  it("sidecar crash returns to ready and does not auto-retry", async () => {
    const { speech, userData, spawnCalls } = harness();
    seedModel(userData);
    const { sessionId } = await speech.start();
    assert.equal(spawnCalls.length, 1);
    spawnCalls[0].child.emit("exit", 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(speech.status().state, "ready");
    assert.equal(speech.isRecordingRequested(), false);
    assert.equal(spawnCalls.length, 1);
    await assert.rejects(
      () => speech.write({ sessionId, pcm: PCM, seq: 0 }),
      { message: SPEECH_STALE_SESSION },
    );
    const again = await speech.start();
    assert.notEqual(again.sessionId, sessionId);
    assert.equal(spawnCalls.length, 2);
    spawnCalls[0].child.emit("exit", 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(speech.status().state, "recording");
    await speech.teardown();
  });

  it("teardown is idempotent and never puts the token or port on the wire", async () => {
    const { speech, userData, spawnCalls, pushes } = harness();
    seedModel(userData);
    await speech.start();
    const key = spawnCalls[0].opts.env.NEMO_SPEECH_HTTP_API_KEY;
    const blob = JSON.stringify(pushes);
    assert.ok(!blob.includes(key));
    assert.ok(!blob.includes("18457"));
    assert.ok(!blob.includes("api_key"));
    await speech.teardown();
    await speech.teardown();
    assert.equal(speech.isRecordingRequested(), false);
  });

  it("status is missing without a model and start refuses", async () => {
    const { speech } = harness({ runtimePath: null });
    const st = speech.status();
    assert.equal(st.state, "missing");
    assert.equal(st.runtimeReady, false);
    assert.equal(st.modelReady, false);
    await assert.rejects(() => speech.start(), /not installed|not available/);
  });
});

describe("IPC handlers", () => {
  it("delegates into the manager and keeps the PR1 error strings", async () => {
    const { speech, userData } = harness();
    seedModel(userData);
    const ctx = { speech };
    const { sessionId } = await IPC_HANDLERS["speech:start"](ctx);
    await assert.rejects(
      () =>
        IPC_HANDLERS["speech:write"](ctx, {
          sessionId,
          pcm: Buffer.alloc(1),
          seq: 0,
        }),
      { message: SPEECH_BAD_PCM },
    );
    await assert.rejects(
      () => IPC_HANDLERS["speech:stop"](ctx, { sessionId: "stale" }),
      { message: SPEECH_STALE_SESSION },
    );
    await IPC_HANDLERS["speech:cancel"](ctx, { sessionId });
  });
});

describe("installSpeechMediaPermissions", () => {
  it("grants audio for the Solenta frame only while recording", async () => {
    const { speech, userData } = harness();
    seedModel(userData);
    const granted = [];
    const fakeSession = {
      setPermissionRequestHandler(fn) {
        this.request = fn;
      },
      setPermissionCheckHandler(fn) {
        this.check = fn;
      },
    };
    const wc = { getType: () => "window", getURL: () => "file:///app/index.html" };
    installSpeechMediaPermissions({
      session: fakeSession,
      speech,
      isSolentaFrame: () => true,
    });
    fakeSession.request(
      wc,
      "media",
      (ok) => granted.push(ok),
      { mediaType: "audio", isMainFrame: true },
    );
    assert.equal(granted[0], false);
    await speech.start();
    fakeSession.request(
      wc,
      "media",
      (ok) => granted.push(ok),
      { mediaType: "audio", isMainFrame: true },
    );
    assert.equal(granted[1], true);
    assert.equal(
      fakeSession.check(wc, "media", "file://", {
        mediaType: "video",
        isMainFrame: true,
      }),
      false,
    );
    assert.equal(fakeSession.check(wc, "notifications", "file://", {}), true);
    await speech.teardown();
  });
});

describe("pinned production constants", () => {
  it("keeps the measured GGUF size and digest", () => {
    assert.equal(MODEL_BYTES, 699872960);
    assert.equal(
      MODEL_SHA256,
      "d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d",
    );
  });
});

describe("cloud speech provider (#1725)", () => {
  /** Records calls; never reaches the network. */
  function cloudFetch(respond) {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return respond(String(url), init);
    };
    return { fetch, calls };
  }
  const ok = (text) => async () => ({ ok: true, status: 200, json: async () => ({ text }) });
  const cloudHarness = (speechSettings, fetch, extra = {}) =>
    harness({ fetch, extra: { getSpeechSettings: () => speechSettings, ...extra } });
  async function record(speech) {
    const { sessionId } = await speech.start();
    await speech.write({ sessionId, pcm: PCM, seq: 0 });
    await speech.write({ sessionId, pcm: PCM, seq: 1 });
    await speech.stop({ sessionId });
  }

  it("local stays the default: no key, or provider local, never fetches", async () => {
    for (const settings of [
      null,
      { provider: "local", openaiApiKey: "sk-x", elevenlabsApiKey: null },
      { provider: "openai", openaiApiKey: null, elevenlabsApiKey: null },
    ]) {
      const { fetch, calls } = cloudFetch(ok("cloud"));
      const { speech, userData, spawnCalls, pushes } = cloudHarness(settings, fetch);
      assert.equal(speech.status().state, "missing", "no model, no cloud → missing");
      seedModel(userData);
      await record(speech);
      assert.equal(calls.length, 0);
      assert.equal(spawnCalls.length, 1, "the local sidecar ran");
      assert.equal(pushes.filter((p) => p.transcript).at(-1).transcript, "Hi there");
    }
  });

  it("OpenAI: one multipart WAV upload with a bearer key, no sidecar", async () => {
    const { fetch, calls } = cloudFetch(ok(" hello world "));
    const { speech, spawnCalls, pushes } = cloudHarness(
      { provider: "openai", openaiApiKey: "sk-test", elevenlabsApiKey: null },
      fetch,
    );
    assert.equal(speech.status().state, "ready", "usable without the local model");
    await record(speech);
    assert.equal(spawnCalls.length, 0);
    assert.equal(calls.length, 1);
    const [{ url, init }] = calls;
    assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer sk-test");
    assert.equal(init.body.get("model"), "gpt-4o-mini-transcribe");
    const wav = Buffer.from(await init.body.get("file").arrayBuffer());
    assert.equal(wav.subarray(0, 4).toString(), "RIFF");
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.length, 44 + PCM.length * 2);
    const last = pushes.at(-1);
    assert.equal(last.transcript, "hello world");
    assert.equal(last.note, undefined);
    assert.equal(speech.status().state, "ready");
    assert.equal(speech.isRecordingRequested(), false);
  });

  it("ElevenLabs: xi-api-key header and scribe_v2", async () => {
    const { fetch, calls } = cloudFetch(ok("hi"));
    const { speech } = cloudHarness(
      { provider: "elevenlabs", openaiApiKey: "sk-unused", elevenlabsApiKey: "el-key" },
      fetch,
    );
    await record(speech);
    assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/speech-to-text");
    assert.equal(calls[0].init.headers["xi-api-key"], "el-key");
    assert.equal(calls[0].init.body.get("model_id"), "scribe_v2");
  });

  it("a cloud error falls back to the local model with a visible note", async () => {
    const { fetch } = cloudFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const { speech, userData, sockets, pushes } = cloudHarness(
      { provider: "openai", openaiApiKey: "sk-bad", elevenlabsApiKey: null },
      fetch,
    );
    seedModel(userData);
    await record(speech);
    const audio = sockets[0].sent.filter((d) => typeof d !== "string");
    assert.equal(audio.length, 2, "the buffered audio replayed locally");
    const last = pushes.filter((p) => p.transcript !== undefined).at(-1);
    assert.equal(last.transcript, "Hi there");
    assert.equal(
      last.note,
      "OpenAI transcription failed (HTTP 401). Used the local model instead.",
    );
    assert.equal(speech.status().state, "ready");
  });

  it("a cloud error with no local model rejects stop with the reason", async () => {
    const { fetch } = cloudFetch(async () => {
      throw new Error("ECONNRESET");
    });
    const { speech } = cloudHarness(
      { provider: "openai", openaiApiKey: "sk", elevenlabsApiKey: null },
      fetch,
    );
    const { sessionId } = await speech.start();
    await speech.write({ sessionId, pcm: PCM, seq: 0 });
    await assert.rejects(
      () => speech.stop({ sessionId }),
      /OpenAI transcription failed \(network\)\. Install the local speech model/,
    );
    assert.equal(speech.isRecordingRequested(), false);
  });

  it("rejects out-of-order cloud PCM and cancel drops the buffer", async () => {
    const { fetch, calls } = cloudFetch(ok("x"));
    const { speech } = cloudHarness(
      { provider: "openai", openaiApiKey: "sk", elevenlabsApiKey: null },
      fetch,
    );
    const { sessionId } = await speech.start();
    await assert.rejects(() => speech.write({ sessionId, pcm: PCM, seq: 3 }), {
      message: SPEECH_BAD_PCM,
    });
    await speech.cancel({ sessionId });
    assert.equal(calls.length, 0);
    assert.equal(speech.isRecordingRequested(), false);
    await assert.rejects(() => speech.stop({ sessionId }), { message: SPEECH_STALE_SESSION });
  });
});

describe("speech API keys at rest and on the wire (#1725)", () => {
  const { Store } = require("../store.js");
  const { createSecrets } = require("../secrets.js");
  const { redactSettings } = require("../mcp.js");

  it("seals both keys on disk, keeps memory plaintext, and redacts for the renderer", () => {
    const dir = tmp();
    const filePath = path.join(dir, "coder-store.json");
    const secrets = createSecrets({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(`sealed:${s}`).map((b) => b ^ 0x5a),
        decryptString: (b) => Buffer.from(b).map((x) => x ^ 0x5a).toString().slice(7),
      },
      inElectron: true,
      log: () => {},
      auditPath: path.join(dir, "audit.jsonl"),
    });
    const store = new Store(filePath, { secrets });
    store.setSettings({
      speech: { provider: "openai", openaiApiKey: "sk-speech-unique", elevenlabsApiKey: "el-speech-unique" },
    });
    store.saveNow();
    const disk = fs.readFileSync(filePath, "utf8");
    assert.ok(!disk.includes("sk-speech-unique") && !disk.includes("el-speech-unique"));
    assert.ok(JSON.parse(disk).settings.speech.openaiApiKey.startsWith("enc:v1:"));
    assert.equal(store.getSettings().speech.openaiApiKey, "sk-speech-unique");

    const reloaded = new Store(filePath, { secrets });
    assert.equal(reloaded.getSettings().speech.elevenlabsApiKey, "el-speech-unique");

    const pub = redactSettings(reloaded.getSettings());
    assert.deepEqual(pub.speech, { provider: "openai", localModel: "nemotron-en", language: "en-US", hasOpenaiKey: true, hasElevenlabsKey: true });
    assert.ok(!JSON.stringify(pub).includes("speech-unique"));

    // Switching provider without resending keys keeps them.
    reloaded.setSettings({ speech: { provider: "elevenlabs" } });
    assert.equal(reloaded.getSettings().speech.openaiApiKey, "sk-speech-unique");
    reloaded.setSettings({ speech: { openaiApiKey: null } });
    assert.equal(reloaded.getSettings().speech.openaiApiKey, null);
    assert.throws(() => reloaded.setSettings({ speech: { provider: "whisper" } }), /speech.provider/);
  });
});
