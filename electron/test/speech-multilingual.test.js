"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createSpeechManager, MODEL_BYTES, MODEL_SHA256, MODEL_FILENAME } = require("../speech.js");
const { localSpeechConfig, localSpeechError, models, languages } = require("../speech-config.js");
const { normalizeSpeechSettings } = require("../store-normalize.js");
const { Store } = require("../store.js");
const { redactSettings } = require("../mcp.js");
const DATA = Buffer.from("fixture GGUF; not model weights");
const MULTI = { localModel: "nemotron-3.5", language: "nl-NL" };

function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speech-multilingual-"));
  let settings = { ...MULTI };
  const pushes = [];
  const speech = createSpeechManager({
    userDataPath: dir, runtimePath: process.execPath,
    // Exercise the published CPU geometry portably; no native model is loaded.
    platform: "linux", arch: "x64", getSpeechSettings: () => settings,
    modelBytes: DATA.length, modelSha256: crypto.createHash("sha256").update(DATA).digest("hex"),
    onStatus: (status) => pushes.push(status),
    readyTimeoutMs: 5000, sessionTimeoutMs: 3000, stopTimeoutMs: 3000,
    spawn: (command, args, opts) => spawn(command, [path.join(__dirname, "fixtures", "speech-multilingual-sidecar.cjs"), ...args], {
      ...opts, env: { ...opts.env, SOLENTA_SPEECH_FIXTURE_TRACE: path.join(dir, "trace.jsonl") },
    }),
    fetch: async () => ({ ok: true, body: (async function* () { yield DATA; })() }),
    ...extra,
  });
  t.after(async () => { await speech.teardown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const seed = (id) => {
    fs.mkdirSync(path.join(dir, "speech"), { recursive: true });
    fs.writeFileSync(path.join(dir, "speech", models[id].filename), DATA);
  };
  return { speech, dir, seed, pushes, settings: (next) => { settings = next; } };
}

it("pins the runtime-paired model, preserves English artifacts, and offers only usable locales", () => {
  assert.equal(models["nemotron-3.5"].bytes, 741548352);
  assert.equal(models["nemotron-3.5"].sha256, "a5c435f294eea8f88ce68dd27b8c3bfea7f777cb2fbba04fcd30eaa555f429ae");
  assert.match(models["nemotron-3.5"].url, /resolve\/1c8deaecc64b91f034d73e08dd8b64625eb3395d\//);
  assert.equal(models["nemotron-en"].bytes, MODEL_BYTES);
  assert.equal(models["nemotron-en"].sha256, MODEL_SHA256);
  assert.equal(models["nemotron-en"].filename, MODEL_FILENAME);
  assert.equal(Object.keys(languages).length, 33); // 32 locales + auto
  for (const code of ["el-GR", "he-IL", "th-TH", "nn-NO", "xx"]) assert.ok(!Object.hasOwn(languages, code));
  assert.deepEqual(localSpeechConfig(null), { localModel: "nemotron-en", language: "en-US" });
  assert.equal(localSpeechError(MULTI), "");
  assert.equal(localSpeechError({ ...MULTI, language: "auto" }), "");
  assert.match(localSpeechError({ ...MULTI, localModel: "nemotron-en" }), /English only/);
  assert.match(localSpeechError({ ...MULTI, language: "he-IL" }), /Unsupported/);
  assert.match(localSpeechError({ ...MULTI, localModel: "unknown" }), /Unknown/);
});

it("migrates legacy settings to English, persists explicit choices and never heals unknown choices to English", (t) => {
  const { dir } = setup(t);
  const file = path.join(dir, "store.json");
  const legacy = normalizeSpeechSettings({ provider: "openai", openaiApiKey: "secret" });
  assert.equal(legacy.localModel, "nemotron-en");
  assert.equal(legacy.language, "en-US");
  const store = new Store(file);
  store.setSettings({ speech: { provider: "local", ...MULTI } });
  store.saveNow();
  const reloaded = new Store(file);
  assert.deepEqual(localSpeechConfig(reloaded.getSettings().speech), MULTI);
  assert.deepEqual(localSpeechConfig(redactSettings(reloaded.getSettings()).speech), MULTI);
  reloaded.setSettings({ speech: { provider: "elevenlabs" } });
  assert.deepEqual(localSpeechConfig(reloaded.getSettings().speech), MULTI);
  assert.throws(() => reloaded.setSettings({ speech: { localModel: "nemotron-en" } }), /English only/);
  assert.throws(() => reloaded.setSettings({ speech: { language: "xx" } }), /Unsupported/);
  assert.throws(() => reloaded.setSettings({ speech: { language: null } }), /non-empty string/);
  assert.equal(normalizeSpeechSettings({ ...MULTI, language: "xx" }).language, "xx");
});

it("reports the exact selected download before fetching, rejects changed consent and keeps English installed", async (t) => {
  const urls = [];
  const { speech, dir, seed } = setup(t, { fetch: async (url) => {
    urls.push(url); return { ok: true, body: (async function* () { yield DATA; })() };
  } });
  seed("nemotron-en");
  assert.equal(speech.status().model.id, "nemotron-3.5");
  assert.equal(speech.status().modelReady, false);
  assert.equal(urls.length, 0);
  await assert.rejects(speech.download({ modelId: "nemotron-en" }), /changed/);
  await speech.download({ modelId: "nemotron-3.5" });
  assert.deepEqual(urls, [models["nemotron-3.5"].url]);
  assert.equal(fs.readFileSync(path.join(dir, "speech", MODEL_FILENAME)).equals(DATA), true);
  assert.equal(speech.status().modelReady, true);
  const production = createSpeechManager({ userDataPath: dir, runtimePath: process.execPath, platform: "linux", arch: "x64", getSpeechSettings: () => MULTI });
  t.after(() => production.teardown());
  assert.equal(production.status().model.bytes, 741548352);
});

it("blocks invalid language/model or unsupported platforms before any fetch/spawn/recording permission", async (t) => {
  const { speech, settings } = setup(t, { fetch: () => assert.fail("must not download"), spawn: () => assert.fail("must not spawn") });
  for (const config of [{ ...MULTI, localModel: "nemotron-en" }, { ...MULTI, language: "he-IL" }, { ...MULTI, localModel: "missing" }]) {
    settings(config);
    assert.equal(speech.status().state, "error");
    assert.ok(speech.status().localError);
    await assert.rejects(speech.download());
    await assert.rejects(speech.start());
    assert.equal(speech.isRecordingRequested(), false);
  }
  const unsupported = setup(t, { platform: "darwin", arch: "x64" }).speech;
  await assert.rejects(unsupported.download(), /unavailable on this platform/);
});

it("cancels a multilingual download without replacing either installed model or leaving partial files", async (t) => {
  let requestSignal;
  const { speech, dir, seed, settings } = setup(t, { fetch: async (_url, { signal }) => {
    requestSignal = signal;
    return { ok: true, body: (async function* () {
      yield DATA.subarray(0, 2);
      if (signal.aborted) throw new Error("aborted");
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    })() };
  } });
  seed("nemotron-en");
  const job = speech.download({ modelId: "nemotron-3.5" });
  // Attach a rejection observer before cancellation.
  const rejected = assert.rejects(job);
  await new Promise((resolve) => setImmediate(resolve));
  settings({ localModel: "nemotron-en", language: "en-US" });
  assert.equal(speech.status().model.id, "nemotron-3.5", "download remains pinned to its consent");
  await speech.teardown();
  await rejected;
  assert.equal(requestSignal.aborted, true);
  assert.equal(fs.existsSync(path.join(dir, "speech", models["nemotron-3.5"].filename)), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, "speech")), [MODEL_FILENAME]);
  assert.equal(speech.status().model.id, "nemotron-en");
});

it("rejects a corrupt multilingual download and removes its partial", async (t) => {
  const { speech, dir } = setup(t, { modelSha256: "0".repeat(64) });
  await assert.rejects(speech.download({ modelId: "nemotron-3.5" }), /digest mismatch/);
  assert.deepEqual(fs.readdirSync(path.join(dir, "speech")), []);
  assert.equal(speech.status().modelReady, false);
});

it("runs a real subprocess with selected GGUF argv and language handshake, preserves Unicode output, restarts on model switch", async (t) => {
  const { speech, seed, dir, pushes, settings } = setup(t);
  seed("nemotron-3.5"); seed("nemotron-en");
  const { sessionId } = await speech.start();
  await speech.write({ sessionId, pcm: Buffer.alloc(3200), seq: 0 });
  // Saving settings mid-session must not change the language already negotiated.
  settings({ localModel: "nemotron-en", language: "en-US" });
  await speech.stop({ sessionId });
  assert.equal(pushes.find((s) => s.transcript)?.transcript, "Goedemorgen wereld. 日本語");
  const rows = fs.readFileSync(path.join(dir, "trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].args[rows[0].args.indexOf("--asr-model") + 1], path.join(dir, "speech", models["nemotron-3.5"].filename));
  assert.equal(rows[0].hasKey, true);
  assert.equal(rows.find((r) => r.type === "session.update").session.language, "nl-NL");
  const again = await speech.start();
  await speech.cancel(again);
  const starts = fs.readFileSync(path.join(dir, "trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.args);
  assert.equal(starts.length, 2);
  assert.equal(starts[1].args[starts[1].args.indexOf("--asr-model") + 1], path.join(dir, "speech", MODEL_FILENAME));
  assert.equal(speech.isRecordingRequested(), false);
});

it("surfaces runtime capability errors immediately and drops cancelled audio", async (t) => {
  const { speech, seed, pushes, settings } = setup(t);
  seed("nemotron-3.5");
  settings({ ...MULTI, language: "ja-JP" });
  await assert.rejects(speech.start(), /unsupported language capability/);
  assert.ok(pushes.some((s) => s.error?.includes("unsupported language capability")));
  assert.equal(speech.isRecordingRequested(), false);
  settings(MULTI);
  const session = await speech.start();
  await speech.cancel(session);
  await assert.rejects(speech.write({ ...session, pcm: Buffer.alloc(3200), seq: 0 }), /Unknown speech session/);
  assert.ok(!pushes.some((s) => s.transcript));
});

it("does not fall back from a cloud error to an incompatible English model", async (t) => {
  const { speech, settings, seed, pushes } = setup(t, { fetch: async () => { throw new Error("offline"); }, spawn: () => assert.fail("must not spawn incompatible English model") });
  settings({ provider: "openai", openaiApiKey: "test-key", localModel: "nemotron-en", language: "nl-NL" });
  seed("nemotron-en");
  assert.equal(speech.status().state, "ready");
  const session = await speech.start();
  await speech.write({ ...session, pcm: Buffer.alloc(3200), seq: 0 });
  await assert.rejects(speech.stop(session), /English only/);
  assert.equal(speech.isRecordingRequested(), false);
  assert.ok(!pushes.some((s) => s.transcript));
});
