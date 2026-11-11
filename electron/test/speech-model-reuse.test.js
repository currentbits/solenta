"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createSpeechManager } = require("../speech.js");
const { models } = require("../speech-config.js");
const { verifyModelFile } = require("../speech-model-location.js");
const { IPC_HANDLERS } = require("../ipc.js");

const DATA = Buffer.from("fixture model, no downloaded weights");
const SHA = crypto.createHash("sha256").update(DATA).digest("hex");
const ID = "nemotron-3.5";
const SPEC = { ...models[ID], bytes: DATA.length, sha256: SHA };

function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speech-reuse-"));
  const folder = path.join(dir, "selected");
  fs.mkdirSync(folder);
  const file = path.join(folder, SPEC.filename);
  fs.writeFileSync(file, DATA);
  let settings = { localModel: ID, language: "nl-NL" };
  const pushes = [];
  const managers = [];
  const make = () => {
    const speech = createSpeechManager({
      userDataPath: path.join(dir, "app"), runtimePath: process.execPath,
      platform: "linux", arch: "x64", modelBytes: DATA.length, modelSha256: SHA,
      getSpeechSettings: () => settings, onStatus: (s) => pushes.push(s),
      fetch: () => assert.fail("must reuse without fetching"),
      readyTimeoutMs: 5000, sessionTimeoutMs: 3000, stopTimeoutMs: 3000,
      spawn: (command, args, opts) => spawn(command, [path.join(__dirname, "fixtures", "speech-multilingual-sidecar.cjs"), ...args], {
        ...opts, env: { ...opts.env, SOLENTA_SPEECH_FIXTURE_TRACE: path.join(dir, "trace.jsonl") },
      }),
      ...extra,
    });
    managers.push(speech);
    return speech;
  };
  t.after(async () => { for (const speech of managers) await speech.teardown(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, folder, speech: make(), make, pushes, settings: (next) => { settings = next; } };
}

it("verifies only the exact catalog file in the selected folder, without copying or changing it", async (t) => {
  const { speech, dir, file, folder } = setup(t);
  const before = fs.statSync(file);
  await speech.useModelFolder({ modelId: ID }, folder);
  assert.equal(speech.status().modelReady, true);
  assert.equal(speech.status().modelLocation.filename, SPEC.filename);
  await speech.download({ modelId: ID });
  assert.deepEqual(fs.readdirSync(path.join(dir, "app", "speech")), ["model-locations.json"]);
  await speech.resetModelLocation({ modelId: ID });
  assert.equal(speech.status().modelLocation.source, "internal");
  assert.equal(speech.status().modelReady, false);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readFileSync(file), DATA);
});

it("rejects missing, nested, wrong-sized, corrupt, and directory candidates and retains the previous selection", async (t) => {
  const { speech, dir, folder, file } = setup(t);
  await speech.useModelFolder({ modelId: ID }, folder);
  const other = path.join(dir, "other"); fs.mkdirSync(other);
  const candidate = path.join(other, SPEC.filename);
  fs.mkdirSync(path.join(other, "nested")); fs.writeFileSync(path.join(other, "nested", SPEC.filename), DATA);
  await assert.rejects(speech.useModelFolder({ modelId: ID }, other), /folder containing/);
  fs.writeFileSync(candidate, "short");
  await assert.rejects(speech.useModelFolder({ modelId: ID }, other), /wrong size/);
  fs.writeFileSync(candidate, Buffer.alloc(DATA.length));
  await assert.rejects(speech.useModelFolder({ modelId: ID }, other), /SHA-256/);
  fs.rmSync(candidate); fs.mkdirSync(candidate);
  await assert.rejects(speech.useModelFolder({ modelId: ID }, other), /regular file|not readable|Could not read/);
  await assert.rejects(speech.useModelFolder({ modelId: "nemotron-en" }, folder), /changed/);
  assert.equal(speech.status().modelLocation.filename, SPEC.filename);
  assert.deepEqual(fs.readFileSync(file), DATA);
});

it("accepts intentional folder and model symlinks, pins the canonical target and rejects dangling links", async (t) => {
  const { speech, dir, folder, file } = setup(t);
  const actual = path.join(dir, "actual.gguf"); fs.renameSync(file, actual);
  try { fs.symlinkSync(actual, file); } catch (err) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "UNKNOWN"].includes(err.code)) {
      t.skip("Creating file symlinks requires Windows developer mode or privileges."); return;
    }
    throw err;
  }
  const alias = path.join(dir, "folder-alias"); fs.symlinkSync(folder, alias, "junction");
  await speech.useModelFolder({ modelId: ID }, alias);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "app", "speech", "model-locations.json"), "utf8"))[ID], await fs.promises.realpath(actual));
  fs.unlinkSync(file); fs.symlinkSync(path.join(dir, "missing"), file);
  await speech.download({ modelId: ID }); // Canonical target stays selected.
  await assert.rejects(speech.useModelFolder({ modelId: ID }, alias), /folder containing/);
  assert.deepEqual(fs.readFileSync(actual), DATA);
});

it("streams verification asynchronously and rejects same-size corruption after reuse and after restart", async (t) => {
  const { speech, file, folder, make } = setup(t);
  const large = Buffer.alloc(8 * 1024 * 1024, 7);
  const largeFile = path.join(folder, "large-fixture"); fs.writeFileSync(largeFile, large);
  let yielded = false;
  const checking = verifyModelFile(largeFile, { bytes: large.length, sha256: crypto.createHash("sha256").update(large).digest("hex") });
  setImmediate(() => { yielded = true; });
  await checking;
  assert.equal(yielded, true, "verification yields the event loop");
  await speech.useModelFolder({ modelId: ID }, folder);
  fs.writeFileSync(file, Buffer.alloc(DATA.length));
  assert.equal(speech.status().modelReady, false);
  await assert.rejects(speech.download({ modelId: ID }), /SHA-256/);
  assert.match(speech.status().localError, /default location/);
  const restarted = make();
  await assert.rejects(restarted.start(), /SHA-256/);
  assert.equal(restarted.isRecordingRequested(), false);
  assert.deepEqual(fs.readFileSync(file), Buffer.alloc(DATA.length));
});

it("reverifies persisted references, uses selected path in real subprocess argv, and pins it through capture", async (t) => {
  const { speech, make, folder, dir, file, settings } = setup(t);
  await speech.useModelFolder({ modelId: ID }, folder);
  const restarted = make();
  const session = await restarted.start();
  settings({ localModel: "nemotron-en", language: "en-US" });
  assert.equal(restarted.status().modelLocation.filename, SPEC.filename);
  await assert.rejects(restarted.resetModelLocation({ modelId: ID }), /Finish dictation/);
  await restarted.write({ ...session, pcm: Buffer.alloc(3200), seq: 0 });
  await restarted.stop(session);
  const rows = fs.readFileSync(path.join(dir, "trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].args[rows[0].args.indexOf("--asr-model") + 1], await fs.promises.realpath(file));
  assert.equal(restarted.status().model.id, "nemotron-en");
  assert.equal(restarted.status().modelLocation.source, "internal");
});

it("pins external download consent during verification and preserves the internal download", async (t) => {
  const { speech, folder, file, dir, settings } = setup(t);
  const internal = path.join(dir, "app", "speech", SPEC.filename);
  fs.mkdirSync(path.dirname(internal), { recursive: true }); fs.writeFileSync(internal, DATA);
  await speech.useModelFolder({ modelId: ID }, folder);
  // A timestamp change invalidates the cache, even though contents are unchanged.
  fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
  const job = speech.download({ modelId: ID });
  settings({ localModel: "nemotron-en", language: "en-US" });
  assert.equal(speech.status().model.id, ID);
  await job;
  assert.equal(speech.status().model.id, "nemotron-en");
  assert.deepEqual(fs.readFileSync(internal), DATA);
  settings({ localModel: ID, language: "nl-NL" });
  await speech.resetModelLocation({ modelId: ID });
  assert.equal(speech.status().modelReady, true, "existing Solenta download remains available");
});

it("keeps successful cloud capture independent of a missing selected external model", async (t) => {
  const { speech, folder, file, settings, pushes } = setup(t, {
    fetch: async () => ({ ok: true, json: async () => ({ text: "Cloud transcript" }) }),
    spawn: () => assert.fail("successful cloud dictation must not start the local runtime"),
  });
  await speech.useModelFolder({ modelId: ID }, folder);
  fs.unlinkSync(file);
  settings({ provider: "openai", openaiApiKey: "fixture", localModel: ID, language: "nl-NL" });
  assert.equal(speech.status().state, "ready");
  assert.equal(speech.status().modelLocation.verifying, false);
  const session = await speech.start();
  await speech.write({ ...session, pcm: Buffer.alloc(3200), seq: 0 });
  await speech.stop(session);
  assert.ok(pushes.some((s) => s.transcript === "Cloud transcript"));
});

it("pins the external fallback across a failed cloud upload and later settings changes", async (t) => {
  const { speech, folder, file, dir, settings, pushes } = setup(t, { fetch: async () => { throw new Error("offline"); } });
  await speech.useModelFolder({ modelId: ID }, folder);
  settings({ provider: "openai", openaiApiKey: "fixture", localModel: ID, language: "nl-NL" });
  const session = await speech.start();
  await speech.write({ ...session, pcm: Buffer.alloc(3200), seq: 0 });
  settings({ localModel: "nemotron-en", language: "en-US" });
  await speech.stop(session);
  const rows = fs.readFileSync(path.join(dir, "trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].args[rows[0].args.indexOf("--asr-model") + 1], await fs.promises.realpath(file));
  assert.ok(pushes.some((s) => s.transcript && s.note));
  assert.equal(speech.status().modelLocation.source, "internal");
});

it("guards the desktop picker and reset, ignores supplied paths, handles cancellation, and keeps paths private in status and pushes", async (t) => {
  const { speech, folder, file, pushes } = setup(t);
  const choose = IPC_HANDLERS["speech:chooseModelFolder"];
  const reset = IPC_HANDLERS["speech:resetModelLocation"];
  const ctx = { speech, transport: "web", dialog: { showOpenDialog: () => assert.fail("web must not open picker") } };
  await assert.rejects(choose(ctx, { modelId: ID, folder }), /desktop app/);
  await assert.rejects(reset(ctx, { modelId: ID }), /desktop app/);
  ctx.transport = "desktop";
  ctx.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  assert.equal(await choose(ctx, { modelId: ID }), null);
  assert.equal(speech.status().modelLocation.source, "internal");
  ctx.dialog.showOpenDialog = async (options) => { assert.deepEqual(options.properties, ["openDirectory"]); return { canceled: false, filePaths: [folder] }; };
  await choose(ctx, { modelId: ID, folder: "/ignored/arbitrary/path" });
  assert.equal((await IPC_HANDLERS["speech:status"](ctx)).modelLocation.filename, SPEC.filename);
  assert.equal((await IPC_HANDLERS["speech:status"]({ ...ctx, transport: "web" })).modelLocation.path, undefined);
  assert.ok(!JSON.stringify(pushes).includes(fs.realpathSync(file)));
  await reset(ctx, { modelId: ID });
  assert.ok(fs.existsSync(file));
});
