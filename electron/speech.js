"use strict";

/**
 * Main-process NeMo-Speech.cpp manager (#845).
 *
 * One sidecar, one recording session. The renderer never sees the loopback
 * port or the bearer token — both leaked on argv/`ps` during the spike.
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn: defaultSpawn } = require("node:child_process");
const { WebSocket: DefaultWebSocket } = require("ws");
const { models, localSpeechConfig, localSpeechError } = require("./speech-config.js");

const MODEL_BYTES = 699872960;
const MODEL_SHA256 =
  "d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d";
const MODEL_URL =
  "https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/resolve/main/nemotron-speech-streaming-en-0.6b.q8_0.gguf";
const MODEL_FILENAME = "nemotron-speech-streaming-en-0.6b.q8_0.gguf";

/** Packaging PR copies these next to Resources/speech/bin/. */
const RUNTIME_PINS = {
  "macos-aarch64-metal":
    "f1dff4f9dd9c96214f8cb78b982812459132df8a4ad1a42409fd94de4a366244",
  "linux-x86_64-cpu":
    "0f74131d631ad2c694cf0ec53490866bb6461147959589a69fb6fc231944065b",
  "windows-x86_64-cpu":
    "5e4ea81046012edcd77fd8848de8eefb5a4ba38cc26f52eb544ab184695a75d6",
};

const SPEECH_NOT_IMPLEMENTED = "Speech is not implemented yet.";
const SPEECH_NO_SESSION = "No active speech session.";
const SPEECH_STALE_SESSION = "Unknown speech session.";
const SPEECH_BAD_PCM = "Invalid speech audio chunk.";
const SPEECH_OVERSIZE = "Speech audio chunk is too large.";
const SPEECH_MAX_PCM_BYTES = 3200;
const SAMPLE_RATE = 16000;
const READ_WRITE_TIMEOUT_S = "600";
const WS_OPEN = 1;

/** Optional cloud speech-to-text (#1725). Local stays the default. */
const CLOUD_STT = {
  openai: {
    label: "OpenAI",
    url: "https://api.openai.com/v1/audio/transcriptions",
    model: ["model", "gpt-4o-mini-transcribe"],
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  elevenlabs: {
    label: "ElevenLabs",
    url: "https://api.elevenlabs.io/v1/speech-to-text",
    model: ["model_id", "scribe_v2"],
    headers: (key) => ({ "xi-api-key": key }),
  },
};
/** Both APIs cap uploads at 25 MB; 16 kHz mono s16 is ~13 minutes. */
const CLOUD_MAX_PCM_BYTES = 24 * 1024 * 1024;
const CLOUD_TIMEOUT_MS = 30_000;

/**
 * Cloud provider + key from settings.speech, or null for local.
 * @param {{ provider?: string, openaiApiKey?: string | null, elevenlabsApiKey?: string | null } | null | undefined} speech
 */
function cloudSpeechConfig(speech) {
  if (!speech || !Object.prototype.hasOwnProperty.call(CLOUD_STT, speech.provider)) {
    return null;
  }
  const apiKey =
    speech.provider === "openai" ? speech.openaiApiKey : speech.elevenlabsApiKey;
  return apiKey ? { provider: speech.provider, apiKey } : null;
}

/** 16 kHz mono signed 16-bit PCM → a WAV file. */
function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * One multipart POST of the whole recording. Throws a user-facing message.
 * @param {{ provider: string, apiKey: string, pcm: Buffer, fetch: Function, timeoutMs?: number }} opts
 * @returns {Promise<string>}
 */
async function cloudTranscribe({ provider, apiKey, pcm, fetch, timeoutMs }) {
  const spec = CLOUD_STT[provider];
  const form = new FormData();
  form.append(spec.model[0], spec.model[1]);
  form.append("file", new Blob([pcmToWav(pcm)], { type: "audio/wav" }), "speech.wav");
  let res;
  try {
    res = await fetch(spec.url, {
      method: "POST",
      headers: spec.headers(apiKey),
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs || CLOUD_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`${spec.label} transcription failed (network).`);
  }
  if (!res || !res.ok) {
    throw new Error(
      `${spec.label} transcription failed (HTTP ${(res && res.status) || "error"}).`,
    );
  }
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!body || typeof body.text !== "string") {
    throw new Error(`${spec.label} returned no transcript.`);
  }
  return body.text.trim();
}

function serveDevice(platform, arch) {
  if (platform === "darwin" && arch === "arm64") return "metal";
  if ((platform === "linux" || platform === "win32") && arch === "x64") {
    return "cpu";
  }
  return null;
}

function bundledRuntimePath({ platform, arch, resourcesPath }) {
  if (!resourcesPath) return null;
  if (!serveDevice(platform, arch)) return null;
  const exe = platform === "win32" ? "nemo-speech.exe" : "nemo-speech";
  return path.join(resourcesPath, "speech", "bin", exe);
}

function hashesEqual(got, want) {
  try {
    const a = Buffer.from(String(got), "hex");
    const b = Buffer.from(String(want), "hex");
    if (a.length !== 32 || b.length !== 32) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function pcmLength(pcm) {
  if (pcm instanceof ArrayBuffer) return pcm.byteLength;
  if (ArrayBuffer.isView(pcm)) return pcm.byteLength;
  return -1;
}

function pcmBuffer(pcm) {
  if (Buffer.isBuffer(pcm)) return pcm;
  if (pcm instanceof ArrayBuffer) return Buffer.from(pcm);
  if (ArrayBuffer.isView(pcm)) {
    return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  }
  return null;
}

function sessionIdOf(input) {
  const id = input && input.sessionId;
  return typeof id === "string" && id ? id : "";
}

function assertPcm(pcm) {
  const len = pcmLength(pcm);
  if (len < 0 || len % 2 !== 0) {
    throw new Error(SPEECH_BAD_PCM);
  }
  if (len > SPEECH_MAX_PCM_BYTES) {
    throw new Error(SPEECH_OVERSIZE);
  }
}

function parseWsMessage(raw) {
  try {
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Buffer.from(raw).toString("utf8");
    const msg = JSON.parse(text);
    return msg && typeof msg === "object" ? msg : null;
  } catch {
    return null;
  }
}

function atomicInstall(partial, dest) {
  try {
    fs.renameSync(partial, dest);
    return;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      fs.rmSync(dest, { force: true });
      fs.renameSync(partial, dest);
      return;
    }
    if (err && err.code === "EXDEV") {
      fs.copyFileSync(partial, dest);
      fs.rmSync(partial, { force: true });
      return;
    }
    throw err;
  }
}

function defaultHttpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error("ready probe timed out"));
    });
    req.on("error", reject);
  });
}

function defaultProbeFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = addr && addr.port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function* bodyChunks(body) {
  if (!body) return;
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield Buffer.from(value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      yield Buffer.from(chunk);
    }
  }
}

/**
 * Grant `media` only for the Solenta main frame, audio, while Composer has
 * asked to record. A handler that only special-cases media must still allow
 * every other permission — setting one replaces Electron's auto-approve.
 */
function allowSpeechMediaPermission({
  permission,
  mediaType,
  mediaTypes,
  isMainFrame,
  isGuest,
  isSolenta,
  recordingRequested,
}) {
  if (permission !== "media") return true;
  if (!isSolenta || isGuest || isMainFrame === false) return false;
  if (!recordingRequested) return false;
  if (mediaType === "video") return false;
  if (Array.isArray(mediaTypes) && mediaTypes.includes("video")) return false;
  if (mediaType === "audio") return true;
  if (
    Array.isArray(mediaTypes) &&
    mediaTypes.length === 1 &&
    mediaTypes[0] === "audio"
  ) {
    return true;
  }
  return false;
}

function isSolentaMainFrame(
  webContents,
  details,
  { isDev = false, devServerUrl = "" } = {},
) {
  if (
    !webContents ||
    (typeof webContents.isDestroyed === "function" && webContents.isDestroyed())
  ) {
    return false;
  }
  if (
    typeof webContents.getType === "function" &&
    webContents.getType() === "webview"
  ) {
    return false;
  }
  if (details && details.isMainFrame === false) return false;
  const url = String(
    (details && (details.requestingUrl || details.requestingOrigin)) ||
      (typeof webContents.getURL === "function" && webContents.getURL()) ||
      "",
  );
  if (isDev && devServerUrl && url.startsWith(devServerUrl)) return true;
  if (url.startsWith("file:")) return true;
  return false;
}

function installSpeechMediaPermissions({
  session,
  speech,
  isSolentaFrame,
}) {
  if (!session) return;
  const decide = (webContents, permission, details) =>
    allowSpeechMediaPermission({
      permission,
      mediaType: details && details.mediaType,
      mediaTypes: details && details.mediaTypes,
      isMainFrame: details && details.isMainFrame,
      isGuest:
        webContents &&
        typeof webContents.getType === "function" &&
        webContents.getType() === "webview",
      isSolenta: isSolentaFrame
        ? isSolentaFrame(webContents, details)
        : false,
      recordingRequested: !!(speech && speech.isRecordingRequested()),
    });
  if (typeof session.setPermissionRequestHandler === "function") {
    session.setPermissionRequestHandler(
      (webContents, permission, callback, details) => {
        callback(decide(webContents, permission, details || {}));
      },
    );
  }
  if (typeof session.setPermissionCheckHandler === "function") {
    session.setPermissionCheckHandler(
      (webContents, permission, _origin, details) =>
        decide(webContents, permission, details || {}),
    );
  }
}

/**
 * @param {object} deps
 * @param {string} deps.userDataPath
 * @param {string} [deps.runtimePath] tests pass an explicit binary; production
 *   uses the bundled extraResource and never searches PATH
 * @param {string} [deps.resourcesPath]
 * @param {NodeJS.Platform} [deps.platform]
 * @param {string} [deps.arch]
 * @param {(status: object) => void} [deps.onStatus]
 * @param {typeof fetch} [deps.fetch]
 * @param {typeof defaultSpawn} [deps.spawn]
 * @param {typeof DefaultWebSocket} [deps.WebSocket]
 * @param {(url: string) => Promise<{ status: number }>} [deps.httpGet]
 * @param {() => Promise<number>} [deps.probeFreePort]
 * @param {number} [deps.modelBytes]
 * @param {string} [deps.modelSha256]
 * @param {string} [deps.modelUrl]
 */
function createSpeechManager(deps) {
  const userDataPath = deps && deps.userDataPath;
  if (!userDataPath) throw new Error("speech userDataPath is required");
  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;
  const device = serveDevice(platform, arch);
  const runtimePath =
    deps.runtimePath !== undefined
      ? deps.runtimePath
      : bundledRuntimePath({
          platform,
          arch,
          resourcesPath: deps.resourcesPath || process.resourcesPath,
        });
  const modelDir = path.join(userDataPath, "speech");
  let selectedModel;
  let localLanguage = "en-US";
  let compatibilityError = "";
  let modelBytes;
  let modelSha256;
  let modelUrl;
  let modelPath;
  let partialPath;
  let starting = false;
  const onStatus = typeof deps.onStatus === "function" ? deps.onStatus : null;
  const doFetch = deps.fetch || globalThis.fetch;
  const spawn = deps.spawn || defaultSpawn;
  const WebSocket = deps.WebSocket || DefaultWebSocket;
  const httpGet = deps.httpGet || defaultHttpGet;
  const probeFreePort = deps.probeFreePort || defaultProbeFreePort;
  const readyTimeoutMs = deps.readyTimeoutMs || 60_000;
  const readyPollMs = deps.readyPollMs || 100;
  const sessionTimeoutMs = deps.sessionTimeoutMs || 15_000;
  const stopTimeoutMs = deps.stopTimeoutMs || 15_000;
  const wait = deps.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const getSpeechSettings =
    typeof deps.getSpeechSettings === "function" ? deps.getSpeechSettings : () => null;
  const cloudTimeoutMs = deps.cloudTimeoutMs || CLOUD_TIMEOUT_MS;

  /** @type {"missing"|"downloading"|"ready"|"recording"|"stopping"|"error"} */
  let state = "missing";
  let lastError = "";
  let downloadProgress = null;
  let downloadJob = null;
  let aborted = false;
  /** @type {AbortController | null} */
  let downloadAbort = null;
  let recordingRequested = false;
  /** @type {{ child: import("node:child_process").ChildProcess, port: number, apiKey: string } | null} */
  let sidecar = null;
  /** @type {{ id: string, gen: number, seq: number, socket: object } | null} */
  let active = null;
  let wsGen = 0;
  /** @type {{ resolve: () => void, reject: (err: Error) => void } | null} */
  let startWait = null;
  /** @type {{ resolve: () => void, reject: (err: Error) => void, timer: ReturnType<typeof setTimeout> } | null} */
  let stopWait = null;
  /** Cloud recording (#1725): PCM buffered until stop, no sidecar. */
  /** @type {{ id: string, seq: number, chunks: Buffer[], bytes: number, provider: string, apiKey: string } | null} */
  let cloudActive = null;
  /** Shown with the next transcript after a cloud→local fallback. */
  let fallbackNote = "";

  function cloudConfig() {
    try {
      return cloudSpeechConfig(getSpeechSettings());
    } catch {
      return null;
    }
  }

  function syncModel() {
    // A recording/download keeps its original model and language even if
    // another window saves settings while it is in flight.
    if (starting || active || cloudActive || downloadJob) return;
    const settings = getSpeechSettings();
    const config = localSpeechConfig(settings);
    compatibilityError = localSpeechError(settings);
    localLanguage = config.language;
    const spec = Object.hasOwn(models, config.localModel) ? models[config.localModel] : null;
    selectedModel = spec ? { id: config.localModel, ...spec } : null;
    modelBytes = deps.modelBytes ?? spec?.bytes;
    modelSha256 = deps.modelSha256 ?? spec?.sha256;
    modelUrl = deps.modelUrl ?? spec?.url;
    modelPath = spec ? path.join(modelDir, spec.filename) : null;
    partialPath = modelPath ? `${modelPath}.partial` : null;
  }

  function runtimeIsReady() {
    return !!(runtimePath && device && fs.existsSync(runtimePath));
  }

  function modelIsReady() {
    try {
      return !compatibilityError && !!modelPath && fs.statSync(modelPath).size === modelBytes;
    } catch {
      return false;
    }
  }

  function deriveState() {
    if (state === "downloading") return "downloading";
    if ((state === "recording" || state === "stopping") && (active || cloudActive)) {
      return state;
    }
    const usable = (runtimeIsReady() && modelIsReady()) || cloudConfig() != null;
    if (compatibilityError && !cloudConfig()) return "error";
    if (state === "error" && !usable) return "error";
    return usable ? "ready" : "missing";
  }

  function snapshot(extra) {
    syncModel();
    state = deriveState();
    const out = {
      state,
      runtimeReady: runtimeIsReady(),
      modelReady: modelIsReady(),
      ...(selectedModel ? { model: { id: selectedModel.id, label: selectedModel.label, bytes: modelBytes } } : {}),
      language: localLanguage,
      ...(compatibilityError ? { localError: compatibilityError } : {}),
    };
    if (state === "downloading" && downloadProgress) {
      out.download = {
        bytesReceived: downloadProgress.bytesReceived,
        bytesTotal: downloadProgress.bytesTotal,
      };
    }
    if (extra && typeof extra.delta === "string") out.delta = extra.delta;
    if (extra && typeof extra.transcript === "string") {
      out.transcript = extra.transcript;
      if (fallbackNote) {
        out.note = fallbackNote;
        fallbackNote = "";
      }
    }
    if (extra && typeof extra.error === "string") out.error = extra.error;
    else if (state === "error" && (compatibilityError || lastError)) out.error = compatibilityError || lastError;
    if (active) out.sessionId = active.id;
    else if (cloudActive) out.sessionId = cloudActive.id;
    return out;
  }

  function emit(extra) {
    if (!onStatus) return;
    try {
      onStatus(snapshot(extra));
    } catch {
      // a renderer listener must not take down the sidecar
    }
  }

  function status() {
    return snapshot();
  }

  function isRecordingRequested() {
    return recordingRequested === true;
  }

  function clearStopWait(err) {
    if (!stopWait) return;
    const pending = stopWait;
    stopWait = null;
    clearTimeout(pending.timer);
    if (err) pending.reject(err);
    else pending.resolve();
  }

  function clearStartWait(err) {
    if (!startWait) return;
    const pending = startWait;
    startWait = null;
    if (err) pending.reject(err);
    else pending.resolve();
  }

  function closeSocket() {
    wsGen += 1;
    if (!active || !active.socket) {
      active = null;
      return;
    }
    const socket = active.socket;
    active = null;
    try {
      if (typeof socket.close === "function") socket.close();
    } catch {
      // ignore
    }
  }

  function killSidecar() {
    const current = sidecar;
    sidecar = null;
    if (!current || !current.child) return;
    try {
      current.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    const killer = setTimeout(() => {
      try {
        current.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 1000);
    if (typeof killer.unref === "function") killer.unref();
  }

  function endRecording(extra) {
    recordingRequested = false;
    closeSocket();
    const err = extra && extra.error;
    clearStartWait(new Error(err || "Speech session ended."));
    if (err) lastError = err;
    emit(extra || {});
    clearStopWait(err ? new Error(err) : undefined);
  }

  function onSidecarDead() {
    if (!sidecar) return;
    sidecar = null;
    if (state === "recording" || state === "stopping" || active) {
      endRecording({ error: "Speech sidecar exited." });
    }
  }

  function attachSocket(socket, gen) {
    socket.on("message", (data) => {
      if (gen !== wsGen || !active || active.gen !== gen) return;
      const msg = parseWsMessage(data);
      if (!msg) return;
      if (msg.type === "session.created") {
        try {
          socket.send(
            JSON.stringify({
              type: "session.update",
              session: {
                sample_rate: SAMPLE_RATE,
                automatic_punctuation: true,
                ...(selectedModel?.id === "nemotron-3.5" ? { language: localLanguage } : {}),
              },
            }),
          );
        } catch (err) {
          clearStartWait(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      if (msg.type === "error") {
        // Runtime capability/language errors must reach the user immediately.
        endRecording({ error: typeof msg.error?.message === "string" ? msg.error.message : "Local transcription failed." });
        return;
      }
      if (msg.type === "session.updated") {
        clearStartWait();
        return;
      }
      if (msg.type === "conversation.item.input_audio_transcription.delta") {
        const suffix = typeof msg.delta === "string" ? msg.delta : "";
        if (suffix) emit({ delta: suffix });
        return;
      }
      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        const text = typeof msg.transcript === "string" ? msg.transcript : "";
        if (!stopWait) {
          emit({ transcript: text });
          return;
        }
        recordingRequested = false;
        const pending = stopWait;
        stopWait = null;
        clearTimeout(pending.timer);
        closeSocket();
        emit({ transcript: text });
        pending.resolve();
      }
    });
    socket.on("close", () => {
      if (gen !== wsGen) return;
      if (state === "recording" || state === "stopping") {
        endRecording({ error: "Speech sidecar closed." });
      } else {
        clearStartWait(new Error("Speech sidecar closed."));
      }
    });
    socket.on("error", () => {
      // close follows; avoid double-end
    });
  }

  async function ensureSidecar() {
    if (sidecar && sidecar.child && sidecar.child.exitCode == null) {
      if (sidecar.modelPath === modelPath) return sidecar;
      killSidecar();
    }
    if (!runtimeIsReady()) {
      throw new Error("Speech runtime is not available.");
    }
    if (!modelIsReady()) {
      throw new Error("Speech model is not installed.");
    }
    const port = await probeFreePort();
    const apiKey = crypto.randomBytes(32).toString("hex");
    const args = [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-ui",
      "--asr-model",
      modelPath,
      "--device",
      device,
      "--read-timeout",
      READ_WRITE_TIMEOUT_S,
      "--write-timeout",
      READ_WRITE_TIMEOUT_S,
    ];
    const env = { ...process.env, NEMO_SPEECH_HTTP_API_KEY: apiKey };
    const opts = {
      shell: false,
      stdio: "ignore",
      env,
      windowsHide: platform === "win32",
    };
    // Adjacent ggml/MSVC DLLs load from the exe directory on Windows.
    if (platform === "win32") opts.cwd = path.dirname(runtimePath);
    const child = spawn(runtimePath, args, opts);
    sidecar = { child, port, apiKey, modelPath };
    child.on("exit", () => {
      if (!sidecar || sidecar.child !== child) return;
      onSidecarDead();
    });
    child.on("error", () => {
      if (!sidecar || sidecar.child !== child) return;
      onSidecarDead();
    });
    const deadline = Date.now() + readyTimeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      if (!sidecar || sidecar.child !== child) {
        throw new Error("Speech sidecar exited.");
      }
      try {
        const res = await httpGet(`http://127.0.0.1:${port}/ready`);
        if (res && res.status === 200) return sidecar;
      } catch (err) {
        lastErr = err;
      }
      await wait(readyPollMs);
    }
    killSidecar();
    throw lastErr instanceof Error
      ? lastErr
      : new Error("Speech sidecar is not ready.");
  }

  async function openSession() {
    const current = sidecar;
    if (!current) throw new Error("Speech sidecar is not ready.");
    const gen = ++wsGen;
    const sessionId = crypto.randomUUID();
    const url = `ws://127.0.0.1:${current.port}/v1/realtime?api_key=${encodeURIComponent(current.apiKey)}`;
    const socket = new WebSocket(url);
    active = { id: sessionId, gen, seq: 0, socket };
    attachSocket(socket, gen);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        startWait = null;
        reject(new Error("Speech session timed out."));
      }, sessionTimeoutMs);
      startWait = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      if (typeof socket.readyState === "number" && socket.readyState === WS_OPEN) {
        // already open; session.created may still be in flight
      }
    });
    return sessionId;
  }

  async function download(input) {
    syncModel();
    if (compatibilityError) throw new Error(compatibilityError);
    if (input?.modelId !== undefined && input.modelId !== selectedModel.id) {
      throw new Error("Speech model changed. Review the download again.");
    }
    if (!runtimeIsReady()) throw new Error("Local speech is unavailable on this platform or its bundled runtime is missing.");
    if (starting || active || cloudActive) throw new Error("Finish dictation before downloading a speech model.");
    if (downloadJob) return downloadJob;
    if (modelIsReady()) {
      lastError = "";
      emit();
      return;
    }
    downloadJob = (async () => {
      aborted = false;
      lastError = "";
      state = "downloading";
      downloadProgress = { bytesReceived: 0, bytesTotal: modelBytes };
      emit();
      fs.mkdirSync(modelDir, { recursive: true });
      try {
        fs.rmSync(partialPath, { force: true });
      } catch {
        // ignore
      }
      downloadAbort = new AbortController();
      let installed = false;
      const hash = crypto.createHash("sha256");
      let received = 0;
      const out = fs.createWriteStream(partialPath);
      const closeOut = () =>
        new Promise((resolve) => {
          if (out.destroyed || out.closed) return resolve();
          out.once("close", resolve);
          out.destroy();
        });
      try {
        const res = await doFetch(modelUrl, { signal: downloadAbort.signal });
        if (!res || !res.ok) {
          const status = res && res.status;
          throw new Error(
            status
              ? `Speech model download failed (HTTP ${status}).`
              : "Speech model download failed.",
          );
        }
        for await (const chunk of bodyChunks(res.body)) {
          if (aborted || (downloadAbort && downloadAbort.signal.aborted)) {
            throw new Error("Speech model download cancelled.");
          }
          received += chunk.length;
          if (received > modelBytes) {
            throw new Error("Speech model download is the wrong size.");
          }
          hash.update(chunk);
          downloadProgress = { bytesReceived: received, bytesTotal: modelBytes };
          emit();
          await new Promise((resolve, reject) => {
            out.write(chunk, (err) => (err ? reject(err) : resolve()));
          });
        }
        await new Promise((resolve, reject) => {
          out.end((err) => (err ? reject(err) : resolve()));
        });
        if (received !== modelBytes) {
          throw new Error("Speech model download is the wrong size.");
        }
        const got = hash.digest("hex");
        if (!hashesEqual(got, modelSha256)) {
          throw new Error("Speech model digest mismatch.");
        }
        atomicInstall(partialPath, modelPath);
        installed = true;
        lastError = "";
        state = "ready";
        downloadProgress = null;
        emit();
      } catch (err) {
        await closeOut();
        if (!installed) {
          try {
            fs.rmSync(partialPath, { force: true });
          } catch {
            // ignore
          }
        }
        const message =
          aborted || (err && err.name === "AbortError")
            ? "Speech model download cancelled."
            : err && err.message
              ? String(err.message).split("\n", 1)[0]
              : "Speech model download failed.";
        lastError = message;
        if (!modelIsReady()) state = "error";
        downloadProgress = null;
        emit({ error: message });
        throw err instanceof Error ? err : new Error(message);
      } finally {
        downloadAbort = null;
      }
    })().finally(() => {
      downloadJob = null;
      emit();
    });
    return downloadJob;
  }

  async function start() {
    syncModel();
    if (starting || state === "recording" || state === "stopping" || active || cloudActive) {
      throw new Error("Speech session already active.");
    }
    const cloud = cloudConfig();
    if (cloud) {
      cloudActive = { id: crypto.randomUUID(), seq: 0, chunks: [], bytes: 0, ...cloud };
      recordingRequested = true;
      lastError = "";
      state = "recording";
      emit();
      return { sessionId: cloudActive.id };
    }
    if (compatibilityError) throw new Error(compatibilityError);
    if (state === "downloading") {
      throw new Error("Speech model is downloading.");
    }
    if (!modelIsReady()) {
      throw new Error("Speech model is not installed.");
    }
    if (!runtimeIsReady()) {
      throw new Error("Speech runtime is not available.");
    }
    recordingRequested = true;
    starting = true;
    lastError = "";
    try {
      await ensureSidecar();
      const sessionId = await openSession();
      state = "recording";
      emit();
      return { sessionId };
    } catch (err) {
      recordingRequested = false;
      closeSocket();
      lastError = err && err.message ? String(err.message).split("\n", 1)[0] : "Speech failed to start.";
      emit({ error: lastError });
      throw err instanceof Error ? err : new Error(lastError);
    } finally {
      starting = false;
    }
  }

  async function write(input) {
    assertPcm(input && input.pcm);
    const sessionId = sessionIdOf(input);
    if (!sessionId) throw new Error(SPEECH_NO_SESSION);
    if (cloudActive && cloudActive.id === sessionId) return writeCloud(input);
    if (!active || active.id !== sessionId) throw new Error(SPEECH_STALE_SESSION);
    if (state !== "recording") throw new Error(SPEECH_NO_SESSION);
    const seq = input && input.seq;
    if (!Number.isInteger(seq) || seq !== active.seq) {
      throw new Error(SPEECH_BAD_PCM);
    }
    const buf = pcmBuffer(input.pcm);
    const socket = active.socket;
    if (!buf || !socket || socket.readyState !== WS_OPEN) {
      throw new Error(SPEECH_NO_SESSION);
    }
    socket.send(buf);
    active.seq += 1;
  }

  function writeCloud(input) {
    if (state !== "recording") throw new Error(SPEECH_NO_SESSION);
    if (!Number.isInteger(input.seq) || input.seq !== cloudActive.seq) {
      throw new Error(SPEECH_BAD_PCM);
    }
    const buf = pcmBuffer(input.pcm);
    if (!buf) throw new Error(SPEECH_BAD_PCM);
    if (cloudActive.bytes + buf.length > CLOUD_MAX_PCM_BYTES) {
      throw new Error("Recording is too long for cloud transcription.");
    }
    cloudActive.chunks.push(Buffer.from(buf));
    cloudActive.bytes += buf.length;
    cloudActive.seq += 1;
  }

  /**
   * Upload the buffered recording. On a cloud error, replay the same audio
   * through the local model when it is installed, with a visible note.
   */
  async function stopCloud() {
    const session = cloudActive;
    state = "stopping";
    emit();
    let text;
    try {
      text = await cloudTranscribe({
        provider: session.provider,
        apiKey: session.apiKey,
        pcm: Buffer.concat(session.chunks),
        fetch: doFetch,
        timeoutMs: cloudTimeoutMs,
      });
    } catch (err) {
      if (cloudActive !== session) return; // cancelled meanwhile
      const why = err && err.message ? String(err.message) : "Cloud transcription failed.";
      cloudActive = null;
      syncModel();
      if (compatibilityError || !modelIsReady() || !runtimeIsReady()) {
        recordingRequested = false;
        lastError = compatibilityError ? `${why} ${compatibilityError}` : `${why} Install the local speech model to fall back.`;
        emit({ error: lastError });
        throw new Error(lastError);
      }
      fallbackNote = `${why} Used the local model instead.`;
      starting = true;
      try {
        await ensureSidecar();
        const id = await openSession();
        state = "recording";
        for (const chunk of session.chunks) active.socket.send(chunk);
        await stop({ sessionId: id });
      } catch (localErr) {
        fallbackNote = "";
        recordingRequested = false;
        closeSocket();
        lastError = localErr && localErr.message ? String(localErr.message) : why;
        emit({ error: lastError });
        throw localErr instanceof Error ? localErr : new Error(lastError);
      } finally {
        starting = false;
      }
      return;
    }
    if (cloudActive !== session) return;
    cloudActive = null;
    recordingRequested = false;
    emit({ transcript: text });
  }

  function sendJson(type) {
    if (!active || !active.socket || active.socket.readyState !== WS_OPEN) return;
    try {
      active.socket.send(JSON.stringify({ type }));
    } catch {
      // ignore
    }
  }

  async function stop(input) {
    const sessionId = sessionIdOf(input);
    if (!sessionId) throw new Error(SPEECH_NO_SESSION);
    if (cloudActive && cloudActive.id === sessionId) {
      if (state !== "recording") throw new Error(SPEECH_NO_SESSION);
      return stopCloud();
    }
    if (!active || active.id !== sessionId) throw new Error(SPEECH_STALE_SESSION);
    if (state !== "recording") throw new Error(SPEECH_NO_SESSION);
    state = "stopping";
    emit();
    sendJson("input_audio_buffer.commit");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stopWait = null;
        recordingRequested = false;
        closeSocket();
        lastError = "Speech stop timed out.";
        emit({ error: lastError });
        reject(new Error(lastError));
      }, stopTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      stopWait = { resolve, reject, timer };
    });
  }

  async function cancel(input) {
    const sessionId = sessionIdOf(input);
    if (!sessionId) throw new Error(SPEECH_NO_SESSION);
    if (cloudActive && cloudActive.id === sessionId) {
      cloudActive = null;
      recordingRequested = false;
      emit();
      return;
    }
    if (!active || active.id !== sessionId) throw new Error(SPEECH_STALE_SESSION);
    sendJson("input_audio_buffer.clear");
    sendJson("response.cancel");
    recordingRequested = false;
    closeSocket();
    clearStopWait();
    emit();
  }

  async function teardown() {
    aborted = true;
    if (downloadAbort) {
      try {
        downloadAbort.abort();
      } catch {
        // ignore
      }
    }
    recordingRequested = false;
    cloudActive = null;
    fallbackNote = "";
    closeSocket();
    clearStartWait(new Error("Speech stopped."));
    clearStopWait(new Error("Speech stopped."));
    killSidecar();
    downloadProgress = null;
    lastError = "";
    try {
      fs.rmSync(partialPath, { force: true });
    } catch {
      // ignore
    }
    emit();
  }

  syncModel();
  state = modelIsReady() ? "ready" : "missing";

  return {
    status,
    /** Re-broadcast after the speech provider setting changes. */
    refresh: () => emit(),
    download,
    start,
    write,
    stop,
    cancel,
    teardown,
    isRecordingRequested,
  };
}

module.exports = {
  MODEL_BYTES,
  MODEL_SHA256,
  MODEL_URL,
  MODEL_FILENAME,
  RUNTIME_PINS,
  SPEECH_NOT_IMPLEMENTED,
  SPEECH_NO_SESSION,
  SPEECH_STALE_SESSION,
  SPEECH_BAD_PCM,
  SPEECH_OVERSIZE,
  SPEECH_MAX_PCM_BYTES,
  serveDevice,
  bundledRuntimePath,
  cloudSpeechConfig,
  pcmToWav,
  allowSpeechMediaPermission,
  isSolentaMainFrame,
  installSpeechMediaPermissions,
  createSpeechManager,
};
