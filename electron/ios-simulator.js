"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const {
  createIOSSimulatorProcess,
  recordingArgumentTail,
} = require("./ios-simulator-process.js");
const { createIOSSimulatorToolchain } = require("./ios-simulator-toolchain.js");
const protocol = require("./ios-simulator-protocol.js");
const worktrees = require("./worktrees.js");

const IOS_RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.iOS-";
const XCODE_VERSION_RE = /^\d+(?:\.\d+){0,2}$/;
const XCODE_BUILD_RE = /^[A-Za-z0-9]{1,32}$/;
const BUNDLE_ID_RE =
  /^(?=.{1,255}$)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const BUNDLE_WALK_LIMIT = 20_000;
const MAX_SIMULATOR_URL_LENGTH = 2048;
const BLOCKED_URL_SCHEMES = new Set(["file:", "javascript:", "data:", "about:"]);
const ASCII_CONTROL_RE = /[\x00-\x1f\x7f]/;

const LICENSE_HINT_RE =
  /license|first[- ]?launch|agreement|checkfirstlaunchstatus/i;

const TAP_HOLD_MS = 50;
const SWIPE_MIN_DURATION_MS = 50;
const SWIPE_MAX_DURATION_MS = 2000;
const SWIPE_MAX_MOVES = 16;
const TYPE_TEXT_MAX_BYTES = 4096;
const HELPER_READY_TIMEOUT_MS = 5_000;
const HELPER_RPC_TIMEOUT_MS = 10_000;
const COORD_ABS_MAX = 1e6;
const HARDWARE_BUTTONS = new Set([
  "home",
  "lock",
  "volumeUp",
  "volumeDown",
  "action",
  "shake",
]);
const SIMULATOR_KEY_USAGE = Object.freeze({
  enter: 0x28,
  escape: 0x29,
  backspace: 0x2a,
  tab: 0x2b,
  space: 0x2c,
  delete: 0x4c,
  pageUp: 0x4b,
  pageDown: 0x4e,
  home: 0x4a,
  end: 0x4d,
  arrowRight: 0x4f,
  arrowLeft: 0x50,
  arrowDown: 0x51,
  arrowUp: 0x52,
});
const DEFAULT_SANDBOX_PROFILE = path.resolve(
  __dirname,
  "../native/ios-simulator-helper/Resources/helper.sb",
);

const MAX_RECORDING_BYTES = 250 * 1024 * 1024;
const RECORDING_POLL_INTERVAL_MS = 1_000;
const RECORDING_MAX_DURATION_MS = 5 * 60 * 1_000;
const RECORDING_FINALIZE_TIMEOUT_MS = 10_000;
const RECOVERY_SIGNAL_GRACE_MS = 2_000;
const QUARANTINE_MAX_ATTEMPTS = 8;
const ARTIFACT_STAGING_SEGMENTS = ["run-artifacts", ".staging"];
const DEVICE_UDID_RE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const MAX_JOURNAL_ID_LENGTH = 256;
const HELPER_NAME = "SolentaSimulatorHelper";
const LEASE_JOURNAL_KEYS = [
  "version",
  "state",
  "generation",
  "ownerThreadId",
  "ownerProjectId",
  "deviceUdid",
  "developerDir",
  "bootedBySolenta",
  "acquiredAt",
  "lastActivityAt",
  "helperPid",
  "protocolToken",
  "recording",
];
const RECORDING_JOURNAL_KEYS = [
  "stagingToken",
  "tempPath",
  "pid",
  "startedAt",
  "runId",
  "toolCallId",
];
// simctl reports an absent or already-shut-down device through these phrases.
// Recovery inherited from a failed boot intent must tolerate them instead of
// wedging the journal forever.
const DEVICE_ALREADY_OFF_RE =
  /current state:\s*Shutdown|already shut ?down|not booted|no devices are booted|invalid device|device not found/i;

class IOSSimulatorError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "IOSSimulatorError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function iosError(code, message, details) {
  return new IOSSimulatorError(code, message, details);
}

const SAFE_TOOLCHAIN_MESSAGES = new Set([
  "iOS Simulator requires macOS",
  "Full Xcode with Simulator is required",
  "Xcode version information is invalid",
  "Simulator helper build timed out",
  "Simulator helper build failed",
  "Simulator user data path is invalid",
]);

function defaultToolchainMessage(code) {
  switch (code) {
    case "unsupported_platform":
      return "iOS Simulator requires macOS";
    case "timeout":
      return "Simulator helper build timed out";
    case "helper_compile_failed":
      return "Simulator helper build failed";
    case "xcode_missing":
      return "Full Xcode with Simulator is required";
    default:
      return "Full Xcode with Simulator is required";
  }
}

function remapToolchainError(err) {
  if (err instanceof IOSSimulatorError) return err;
  if (err && err.name === "IOSSimulatorError" && typeof err.code === "string") {
    const message = SAFE_TOOLCHAIN_MESSAGES.has(err.message)
      ? err.message
      : defaultToolchainMessage(err.code);
    return iosError(err.code, message);
  }
  return iosError("xcode_missing", "Full Xcode with Simulator is required");
}

const KNOWN_DEVICE_STATES = new Set([
  "Shutdown",
  "Booted",
  "Booting",
  "Shutting Down",
]);

function normalizeDeviceState(state) {
  const normalized = String(state || "").trim();
  return KNOWN_DEVICE_STATES.has(normalized) ? normalized : "Unknown";
}

function parseXcodeVersion(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let version = "";
  let build = "";
  for (const line of lines) {
    const versionMatch = /^Xcode\s+(.+)$/i.exec(line);
    if (versionMatch) version = versionMatch[1].trim();
    const buildMatch = /^Build version\s+(.+)$/i.exec(line);
    if (buildMatch) build = buildMatch[1].trim();
  }
  if (!version || !XCODE_VERSION_RE.test(version)) {
    throw iosError("unexpected", "Xcode version information is invalid");
  }
  if (!build || !XCODE_BUILD_RE.test(build)) {
    throw iosError("unexpected", "Xcode version information is invalid");
  }
  return { version, build };
}

function isIosRuntimeIdentifier(identifier) {
  const id = String(identifier || "");
  return (
    id.startsWith(IOS_RUNTIME_PREFIX) && id.length > IOS_RUNTIME_PREFIX.length
  );
}

function parseSimulatorList(doc) {
  if (!doc || typeof doc !== "object") {
    return { runtimes: [], devices: [] };
  }
  const runtimeRows = Array.isArray(doc.runtimes) ? doc.runtimes : [];
  const deviceMap =
    doc.devices && typeof doc.devices === "object" ? doc.devices : {};
  const runtimes = [];
  const devices = [];

  for (const runtime of runtimeRows) {
    if (!runtime || runtime.isAvailable !== true) continue;
    const runtimeId = String(runtime.identifier || "").trim();
    if (!runtimeId || !isIosRuntimeIdentifier(runtimeId)) continue;
    const runtimeName = String(runtime.name || "").trim();
    const runtimeDevices = Array.isArray(deviceMap[runtimeId])
      ? deviceMap[runtimeId]
      : [];
    const included = [];

    for (const device of runtimeDevices) {
      if (!device || device.isAvailable === false) continue;
      const udid = String(device.udid || "").trim();
      if (!udid) continue;
      const entry = {
        udid,
        name: String(device.name || "").trim(),
        state: normalizeDeviceState(device.state),
        runtimeIdentifier: runtimeId,
        runtimeName,
      };
      included.push({
        udid: entry.udid,
        name: entry.name,
        state: entry.state,
      });
      devices.push(entry);
    }

    runtimes.push({
      identifier: runtimeId,
      name: runtimeName,
      devices: included,
    });
  }

  return { runtimes, devices };
}

function capabilitySnapshot(raw, helperCaps) {
  return {
    platform: "darwin",
    supported: true,
    developerDir: raw.developerDir,
    xcode: raw.xcode,
    licenseAccepted: true,
    runtimes: raw.runtimes,
    capabilities: {
      deviceLifecycle: true,
      screenshot: true,
      recording: true,
      stream: Boolean(helperCaps && helperCaps.stream),
      touch: Boolean(helperCaps && helperCaps.touch),
      keyboard: Boolean(helperCaps && helperCaps.keyboard),
      hardwareButtons: Boolean(helperCaps && helperCaps.hardwareButtons),
      accessibility: Boolean(helperCaps && helperCaps.accessibility),
    },
  };
}

function adapterFailureText(err) {
  const parts = [];
  if (err && err.message) parts.push(String(err.message));
  if (err && err.stderr) parts.push(String(err.stderr));
  return parts.join("\n");
}

function hasLicenseHint(err) {
  return LICENSE_HINT_RE.test(adapterFailureText(err));
}

function classifyLicenseAwareXcodeMissing(err) {
  if (hasLicenseHint(err)) {
    return iosError("license_required", "Complete Xcode first-launch setup");
  }
  return iosError("xcode_missing", "Full Xcode with Simulator is required");
}

async function runActiveDeveloperDir(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IOSSimulatorError) throw err;
    throw classifyLicenseAwareXcodeMissing(err);
  }
}

async function runXcodeVersion(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IOSSimulatorError) throw err;
    throw classifyLicenseAwareXcodeMissing(err);
  }
}

async function runFirstLaunchStatus(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IOSSimulatorError) throw err;
    throw iosError("license_required", "Complete Xcode first-launch setup");
  }
}

async function runFindSimctl(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IOSSimulatorError) throw err;
    throw classifyLicenseAwareXcodeMissing(err);
  }
}

async function runListDevices(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IOSSimulatorError) throw err;
    throw classifyLicenseAwareXcodeMissing(err);
  }
}

function validateUserDataPath(userDataPath) {
  if (typeof userDataPath !== "string") {
    throw iosError("unexpected", "Simulator user data path is invalid");
  }
  const trimmed = userDataPath.trim();
  if (!trimmed || trimmed.includes("\0") || !path.isAbsolute(trimmed)) {
    throw iosError("unexpected", "Simulator user data path is invalid");
  }
  return trimmed;
}

function validateCandidateDeveloperDir(developerDir) {
  const selected = String(developerDir ?? "").trim();
  if (!selected || selected.includes("\0")) {
    throw iosError(
      "xcode_missing",
      "Select an absolute Xcode developer directory",
    );
  }
  if (!path.isAbsolute(selected)) {
    throw iosError(
      "xcode_missing",
      "Select an absolute Xcode developer directory",
    );
  }
  return selected;
}

function validatePersistedDeveloperDir(developerDir) {
  const selected = String(developerDir ?? "").trim();
  if (!selected || selected.includes("\0") || !path.isAbsolute(selected)) {
    throw iosError("unexpected", "Simulator preferences are invalid");
  }
  return selected;
}

function isWithin(root, target) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  if (normalizedTarget === normalizedRoot) return true;
  return normalizedTarget.startsWith(normalizedRoot + path.sep);
}

function invalidAppPath() {
  return iosError(
    "invalid_app_path",
    "App path must be a relative .app inside the project",
  );
}

function invalidBundle() {
  return iosError("invalid_bundle", "App bundle is invalid");
}

function invalidUrl() {
  return iosError("invalid_url", "Simulator URL is invalid");
}

function leaseStale() {
  return iosError("lease_stale", "Simulator lease is no longer valid");
}

function validateSimulatorUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) throw invalidUrl();
  if (ASCII_CONTROL_RE.test(rawUrl)) throw invalidUrl();
  if (rawUrl.length > MAX_SIMULATOR_URL_LENGTH) throw invalidUrl();
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw invalidUrl();
  }
  if (BLOCKED_URL_SCHEMES.has(parsed.protocol)) throw invalidUrl();
  const href = parsed.href;
  if (href.length > MAX_SIMULATOR_URL_LENGTH) throw invalidUrl();
  return href;
}

function parseLaunchPid(bundleId, output) {
  const escaped = String(bundleId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lineRe = new RegExp(`^${escaped}:\\s*(\\d+)\\s*$`);
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = lineRe.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function isJournalId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_JOURNAL_ID_LENGTH &&
    !value.includes("\0")
  );
}

function isJournalTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isJournalPid(value) {
  return value === null || (Number.isSafeInteger(value) && value > 0);
}

function isJournalProtocolToken(value) {
  return value === null || isJournalId(value);
}

function helperSpawnArgs(sandboxProfile, developerDir) {
  return [
    "--sandbox-profile",
    sandboxProfile,
    "--developer-dir",
    developerDir,
    "--control-in-fd",
    "3",
    "--control-out-fd",
    "4",
  ];
}

function helperArgumentTail(sandboxProfile, developerDir) {
  return helperSpawnArgs(sandboxProfile, developerDir).join(" ");
}

function isTrustedHelperPrefix(prefix) {
  if (!prefix.startsWith("/")) return false;
  if (prefix.includes(" ")) return false;
  if (prefix.includes("\0")) return false;
  if (prefix.includes("/../")) return false;
  return prefix.endsWith(`/${HELPER_NAME}`);
}

function hasExactKeys(value, keys) {
  const own = Object.keys(value);
  if (own.length !== keys.length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function parseJournalRecording(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (!hasExactKeys(raw, RECORDING_JOURNAL_KEYS)) return undefined;
  if (!isJournalId(raw.stagingToken)) return undefined;
  if (typeof raw.tempPath !== "string" || !raw.tempPath) return undefined;
  if (!isJournalPid(raw.pid)) return undefined;
  if (!isJournalTimestamp(raw.startedAt)) return undefined;
  if (raw.runId !== null && !isJournalId(raw.runId)) return undefined;
  if (raw.toolCallId !== null && !isJournalId(raw.toolCallId)) return undefined;
  return {
    stagingToken: raw.stagingToken,
    tempPath: raw.tempPath,
    pid: raw.pid,
    startedAt: raw.startedAt,
    runId: raw.runId,
    toolCallId: raw.toolCallId,
  };
}

// Strict schema gate for the crash-recovery journal. Anything unexpected —
// unknown keys, wrong types, a non-UDID device, a relative developer
// directory — is treated as tampering and returns null so the caller
// quarantines the file without inspecting or signaling anything.
function parseLeaseJournal(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!hasExactKeys(parsed, LEASE_JOURNAL_KEYS)) return null;
  if (parsed.version !== 1) return null;
  if (parsed.state !== "active" && parsed.state !== "releasing") return null;
  if (!Number.isSafeInteger(parsed.generation) || parsed.generation < 1) {
    return null;
  }
  if (!isJournalId(parsed.ownerThreadId)) return null;
  if (!isJournalId(parsed.ownerProjectId)) return null;
  if (
    typeof parsed.deviceUdid !== "string" ||
    !DEVICE_UDID_RE.test(parsed.deviceUdid)
  ) {
    return null;
  }
  if (
    typeof parsed.developerDir !== "string" ||
    parsed.developerDir.includes("\0") ||
    !path.isAbsolute(parsed.developerDir)
  ) {
    return null;
  }
  if (typeof parsed.bootedBySolenta !== "boolean") return null;
  if (!isJournalTimestamp(parsed.acquiredAt)) return null;
  if (!isJournalTimestamp(parsed.lastActivityAt)) return null;
  if (!isJournalPid(parsed.helperPid)) return null;
  if (!isJournalProtocolToken(parsed.protocolToken)) return null;
  if ((parsed.helperPid === null) !== (parsed.protocolToken === null)) {
    return null;
  }
  const recording = parseJournalRecording(parsed.recording);
  if (recording === undefined) return null;
  return {
    version: 1,
    state: parsed.state,
    generation: parsed.generation,
    ownerThreadId: parsed.ownerThreadId,
    ownerProjectId: parsed.ownerProjectId,
    deviceUdid: parsed.deviceUdid,
    developerDir: parsed.developerDir,
    bootedBySolenta: parsed.bootedBySolenta,
    acquiredAt: parsed.acquiredAt,
    lastActivityAt: parsed.lastActivityAt,
    helperPid: parsed.helperPid,
    protocolToken: parsed.protocolToken,
    recording,
  };
}

function validateRelativeAppPath(relativeAppPath) {
  if (typeof relativeAppPath !== "string") throw invalidAppPath();
  if (!relativeAppPath || relativeAppPath.includes("\0")) throw invalidAppPath();
  if (path.isAbsolute(relativeAppPath)) throw invalidAppPath();
  if (relativeAppPath.split(/[/\\]/).some((segment) => segment === "..")) {
    throw invalidAppPath();
  }
  if (!relativeAppPath.endsWith(".app")) throw invalidAppPath();
}

function createIOSSimulatorService({
  store,
  userDataPath,
  worktreeBase,
  platform = process.platform,
  processAdapter = createIOSSimulatorProcess(),
  artifactStore = null,
  prepareThreadWorktree = worktrees.prepareThreadWorktree,
  fsApi = fs,
  randomUUID = crypto.randomUUID,
  now = Date.now,
  logger = null,
  broadcast = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  // The only place this service may signal a PID. Live recordings are signaled
  // through the adapter handle; recovery signals a journalled PID only after
  // `inspectProcess` proves the command line is ours.
  signalPid = (pid, signal) => {
    process.kill(pid, signal);
  },
  recordingStagingRoot = null,
  toolchain = null,
  streamBroker = null,
  getStreamBroker = null,
  spawnHelper = (file, args, options) =>
    childProcess.spawn(file, args, options),
  sandboxProfilePath = DEFAULT_SANDBOX_PROFILE,
}) {
  const resolvedUserDataPath = validateUserDataPath(userDataPath);
  const resolvedWorktreeBase =
    worktreeBase ?? path.join(resolvedUserDataPath, "worktrees");
  const preferencesFile = path.join(
    resolvedUserDataPath,
    "ios-simulator-preferences.json",
  );
  const leaseJournalFile = path.join(
    resolvedUserDataPath,
    "ios-simulator-lease.json",
  );
  const stagingRoot = path.resolve(
    recordingStagingRoot ??
      path.join(resolvedUserDataPath, ...ARTIFACT_STAGING_SEGMENTS),
  );
  const resolvedToolchain =
    toolchain ??
    createIOSSimulatorToolchain({
      userDataPath: resolvedUserDataPath,
      fsApi,
      platform,
      randomUUID,
      setTimer,
      clearTimer,
    });
  let lease = null;
  let lastGeneration = 0;
  let mutationTail = Promise.resolve();
  /** @type {ReturnType<typeof createRecordingContext> | null} */
  let recording = null;
  /** @type {ReturnType<typeof createRecordingContext> | null} */
  let finishedRecording = null;
  /**
   * Shared by every `shutdown()` caller so app teardown runs exactly once.
   * @type {Promise<object> | null}
   */
  let shutdownPromise = null;
  /** @type {object | null} */
  let helper = null;

  function cloneLease(value) {
    return value ? { ...value } : null;
  }

  function leaseSnapshot(value) {
    return Object.freeze({
      generation: value.generation,
      deviceUdid: value.deviceUdid,
      bootedBySolenta: value.bootedBySolenta,
    });
  }

  function leasePresent() {
    return lease !== null;
  }

  function isActiveLease() {
    return lease && lease.state === "active";
  }

  function logJournalWarning(message) {
    if (logger && typeof logger.warn === "function") {
      logger.warn(message);
    }
  }

  async function touchLeaseActivityBestEffort() {
    // A lifecycle release can revoke the lease between a caller's last
    // ownership check and this touch; spreading `null` would resurrect it as a
    // journal record that means nothing.
    if (!lease) return;
    lease = { ...lease, lastActivityAt: now() };
    try {
      await writeJournal(lease);
    } catch {
      logJournalWarning("Simulator lease activity journal write failed");
    }
  }

  function mutate(fn) {
    const next = mutationTail.then(fn, fn);
    mutationTail = next.catch(() => {});
    return next;
  }

  function resolveThread(threadId) {
    if (threadId == null) {
      throw iosError("unexpected", "Unknown thread");
    }
    const normalizedThreadId = String(threadId);
    let thread;
    try {
      thread = store.getThread(normalizedThreadId);
    } catch {
      throw iosError("unexpected", `Unknown thread: ${normalizedThreadId}`);
    }
    if (!thread) {
      throw iosError("unexpected", `Unknown thread: ${normalizedThreadId}`);
    }
    let project;
    try {
      project = store.getProject(thread.projectId);
    } catch {
      throw iosError("unexpected", `Unknown project: ${thread.projectId}`);
    }
    if (!project) {
      throw iosError("unexpected", `Unknown project: ${thread.projectId}`);
    }
    if (platform !== "darwin") {
      throw iosError("unsupported_platform", "iOS Simulator requires macOS");
    }
    if (project.remoteHost) {
      throw iosError(
        "remote_project",
        "iOS Simulator requires a local project",
      );
    }
    return { thread, project, threadId: normalizedThreadId };
  }

  async function readPreferences(file) {
    try {
      const stat = await fsApi.promises.lstat(file);
      if (!stat.isFile()) {
        throw iosError("unexpected", "Simulator preferences are invalid");
      }
      const parsed = JSON.parse(await fsApi.promises.readFile(file, "utf8"));
      if (!parsed || parsed.version !== 1) {
        throw iosError("unexpected", "Simulator preferences are invalid");
      }
      const developerDir = validatePersistedDeveloperDir(parsed.developerDir);
      return { version: 1, developerDir };
    } catch (error) {
      if (error instanceof IOSSimulatorError) throw error;
      if (error && error.code === "ENOENT") return null;
      throw iosError("unexpected", "Simulator preferences are invalid");
    }
  }

  async function syncParentDirectory(file) {
    try {
      const parent = path.dirname(file);
      const handle = await fsApi.promises.open(parent, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // fsync parent directory is best-effort.
    }
  }

  async function atomicWriteJson(file, value, failureMessage) {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const temp = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        await fsApi.promises.mkdir(path.dirname(file), { recursive: true });
        handle = await fsApi.promises.open(temp, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await fsApi.promises.rename(temp, file);
        await syncParentDirectory(file);
        return;
      } catch (error) {
        if (handle) {
          try {
            await handle.close();
          } catch {
            // best-effort
          }
        }
        await fsApi.promises.unlink(temp).catch(() => {});
        if (error instanceof IOSSimulatorError) throw error;
        if (attempt + 1 >= maxAttempts) {
          throw iosError("unexpected", failureMessage);
        }
      }
    }
  }

  async function writePreferences(file, value) {
    return atomicWriteJson(file, value, "Simulator preferences are invalid");
  }

  // Journal mutations run one at a time in call order. Takeover invalidates the
  // lease synchronously and then writes outside the `mutate` queue, so without
  // this an in-flight write from the superseded generation could win the rename
  // race and put the old owner back on disk. Ordering by call gives the newest
  // record the last rename, which is what makes the identity checks in
  // `clearRecordingJournalBestEffort` and the intent rollback sufficient.
  let journalTail = Promise.resolve();

  function enqueueJournalOp(op) {
    const run = journalTail.then(op, op);
    journalTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function writeJournal(value) {
    return enqueueJournalOp(() =>
      atomicWriteJson(
        leaseJournalFile,
        value,
        "Simulator lease journal is invalid",
      ),
    );
  }

  async function removeJournal() {
    try {
      await enqueueJournalOp(() => fsApi.promises.unlink(leaseJournalFile));
    } catch {
      // Best-effort: an in-memory lease release still succeeds if the
      // journal file cannot be removed; a corrupt/absent journal is
      // handled by future crash recovery, never by re-erasing a device.
    }
  }

  async function selectedDeveloperDirectory() {
    const saved = await readPreferences(preferencesFile);
    if (saved) {
      return saved.developerDir;
    }
    return String(
      await runActiveDeveloperDir(() => processAdapter.activeDeveloperDir()),
    ).trim();
  }

  async function discoverRaw(developerDir) {
    const dir = developerDir ?? (await selectedDeveloperDirectory());
    const versionText = String(
      await runXcodeVersion(() => processAdapter.xcodeVersion(dir)),
    ).trim();
    await runFirstLaunchStatus(() => processAdapter.firstLaunchStatus(dir));
    await runFindSimctl(() => processAdapter.findSimctl(dir));
    let doc;
    try {
      const listText = await runListDevices(() => processAdapter.listDevices(dir));
      doc = JSON.parse(listText);
    } catch (err) {
      if (err instanceof IOSSimulatorError) throw err;
      throw iosError("unexpected", "Simulator device list is invalid");
    }
    return {
      developerDir: dir,
      xcode: parseXcodeVersion(versionText),
      ...parseSimulatorList(doc),
    };
  }

  async function discoverDevices() {
    return (await discoverRaw()).devices;
  }

  async function discoverCapabilities() {
    const raw = await discoverRaw();
    return capabilitySnapshot(raw, helperCapsForSnapshot());
  }

  async function validateDeveloperDirectory(developerDir) {
    const selected = validateCandidateDeveloperDir(developerDir);
    return discoverRaw(selected);
  }

  async function validateAndPersistDeveloperDirectory(developerDir) {
    const raw = await validateDeveloperDirectory(developerDir);
    await writePreferences(preferencesFile, {
      version: 1,
      developerDir: raw.developerDir,
    });
    return capabilitySnapshot(raw);
  }

  async function getCapabilities(input) {
    const threadId = input && input.threadId;
    resolveThread(threadId);
    return discoverCapabilities();
  }

  async function selectDeveloperDirectory(input) {
    const threadId = input && input.threadId;
    const developerDir = input && input.developerDir;
    resolveThread(threadId);
    return validateAndPersistDeveloperDirectory(developerDir);
  }

  async function listDevices(input) {
    const threadId = input && input.threadId;
    resolveThread(threadId);
    return discoverDevices();
  }

  async function discoverToolchains(input) {
    resolveThread(input && input.threadId);
    const developerDir = await selectedDeveloperDirectory();
    try {
      return await resolvedToolchain.discoverToolchains(developerDir);
    } catch (err) {
      throw remapToolchainError(err);
    }
  }

  async function fingerprintToolchain(input) {
    resolveThread(input && input.threadId);
    const developerDir = await selectedDeveloperDirectory();
    try {
      return await resolvedToolchain.fingerprintToolchain(developerDir);
    } catch (err) {
      throw remapToolchainError(err);
    }
  }

  async function ensureHelper(input) {
    resolveThread(input && input.threadId);
    const developerDir = await selectedDeveloperDirectory();
    try {
      return await resolvedToolchain.ensureHelper(developerDir);
    } catch (err) {
      throw remapToolchainError(err);
    }
  }

  async function resolveExecutionRoot(inputThreadId) {
    let { thread, project, threadId } = resolveThread(inputThreadId);
    const isolated = Boolean(thread.pendingWorktree || thread.worktreePath);
    if (isolated) {
      await prepareThreadWorktree({
        store,
        threadId,
        worktreeBase: resolvedWorktreeBase,
        broadcast,
      });
      thread = store.getThread(threadId);
      if (!thread || !thread.worktreePath) {
        throw iosError("worktree_missing", "Thread worktree is unavailable");
      }
    }
    const root = isolated ? thread.worktreePath : project.path;
    let canonical;
    try {
      canonical = await fsApi.promises.realpath(root);
    } catch {
      if (isolated) {
        throw iosError("worktree_missing", "Thread worktree is unavailable");
      }
      throw iosError("unexpected", "Project path is unavailable");
    }
    return { thread, project, root: canonical, threadId };
  }

  async function validateBundleWithinRoot(root, bundlePath) {
    const infoPlistPath = path.join(bundlePath, "Info.plist");
    let infoStat;
    try {
      infoStat = await fsApi.promises.lstat(infoPlistPath);
    } catch {
      throw invalidBundle();
    }
    if (!infoStat.isFile() || infoStat.isSymbolicLink()) {
      throw invalidBundle();
    }

    const queue = [bundlePath];
    let entries = 0;
    while (queue.length > 0) {
      const current = queue.shift();
      let names;
      try {
        names = await fsApi.promises.readdir(current);
      } catch {
        throw invalidBundle();
      }
      for (const name of names) {
        entries += 1;
        if (entries > BUNDLE_WALK_LIMIT) throw invalidBundle();
        const entryPath = path.join(current, name);
        let stat;
        try {
          stat = await fsApi.promises.lstat(entryPath);
        } catch {
          throw invalidBundle();
        }
        if (stat.isSymbolicLink()) {
          let target;
          try {
            target = await fsApi.promises.realpath(entryPath);
          } catch {
            throw invalidBundle();
          }
          if (!isWithin(root, target)) throw invalidBundle();
          let targetStat;
          try {
            targetStat = await fsApi.promises.lstat(target);
          } catch {
            throw invalidBundle();
          }
          if (targetStat.isDirectory()) {
            throw invalidBundle();
          }
          continue;
        }
        if (stat.isDirectory()) {
          queue.push(entryPath);
        }
      }
    }
  }

  async function prepareAppBundle(input) {
    const threadId = input && input.threadId;
    const relativeAppPath = input && input.relativeAppPath;
    validateRelativeAppPath(relativeAppPath);
    const { root } = await resolveExecutionRoot(threadId);
    const candidate = path.resolve(root, relativeAppPath);
    if (!isWithin(root, candidate)) throw invalidAppPath();
    let canonical;
    try {
      canonical = await fsApi.promises.realpath(candidate);
    } catch {
      throw invalidAppPath();
    }
    if (!isWithin(root, canonical)) throw invalidAppPath();
    if (!canonical.endsWith(".app")) throw invalidAppPath();
    let bundleStat;
    try {
      bundleStat = await fsApi.promises.lstat(canonical);
    } catch {
      throw invalidAppPath();
    }
    if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) {
      throw invalidAppPath();
    }
    await validateBundleWithinRoot(root, canonical);
    const developerDir = await selectedDeveloperDirectory();
    let bundleIdText;
    try {
      bundleIdText = String(
        await processAdapter.readBundleId(
          developerDir,
          path.join(canonical, "Info.plist"),
        ),
      ).trim();
    } catch {
      throw invalidBundle();
    }
    if (!BUNDLE_ID_RE.test(bundleIdText)) throw invalidBundle();
    return Object.freeze({ bundleId: bundleIdText, appPath: canonical });
  }

  function currentLeaseSnapshot() {
    if (!lease) return null;
    return leaseSnapshot(lease);
  }

  function assertOwnedLease(threadId, generation) {
    const { threadId: normalizedThreadId } = resolveThread(threadId);
    if (!lease || lease.state !== "active") throw leaseStale();
    if (lease.ownerThreadId !== normalizedThreadId) throw leaseStale();
    if (lease.generation !== generation) throw leaseStale();
    return normalizedThreadId;
  }

  // Re-validates immediately before and after `fn`, so a takeover's
  // synchronous invalidation (see `takeover`) is always observed even if
  // it happens while `fn`'s process call is in flight. Reads `lease` only
  // inside this wrapper after assertion.
  async function withOwnedLease(threadId, generation, fn) {
    assertOwnedLease(threadId, generation);
    const result = await fn();
    assertOwnedLease(threadId, generation);
    return result;
  }

  async function callProcess(fn, failureMessage) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof IOSSimulatorError) throw err;
      throw iosError("unexpected", failureMessage);
    }
  }

  function nextGeneration() {
    const generation = lastGeneration + 1;
    lastGeneration = generation;
    return generation;
  }

  function currentStreamBroker() {
    if (typeof getStreamBroker === "function") return getStreamBroker();
    return streamBroker;
  }

  function disconnectedHelperState() {
    return {
      stream: "disconnected",
      input: "disconnected",
      accessibility: "disconnected",
    };
  }

  function helperConnectionState() {
    if (!helper) return disconnectedHelperState();
    return {
      stream: helper.stream,
      input: helper.input,
      accessibility: helper.accessibility,
    };
  }

  function helperCapsForSnapshot() {
    if (!helper || helper.stream !== "connected") return null;
    return helper.helperCaps;
  }

  function publishSimulatorChanged() {
    const conn = helperConnectionState();
    const payload = lease
      ? {
          attached: true,
          state: lease.state,
          generation: lease.generation,
          deviceUdid: lease.deviceUdid,
          bootedBySolenta: lease.bootedBySolenta,
          ownerThreadId: lease.ownerThreadId,
          isOwner: false,
          ...conn,
        }
      : {
          attached: false,
          state: null,
          generation: null,
          deviceUdid: null,
          bootedBySolenta: null,
          ownerThreadId: null,
          isOwner: false,
          ...conn,
        };
    try {
      broadcast("simulator:changed", payload);
    } catch {
      // broadcast is best-effort
    }
  }

  function mapHelperError(code) {
    if (code === "generation_mismatch" || code === "token_mismatch") {
      return leaseStale();
    }
    if (code === "capability_unavailable" || code === "unknown_method") {
      return iosError(
        "capability_unavailable",
        "Simulator capability is unavailable",
      );
    }
    if (code === "device_missing") {
      return iosError("device_missing", "Simulator device was not found");
    }
    if (code === "stream_disconnected") {
      return iosError(
        "stream_disconnected",
        "Simulator helper is disconnected",
      );
    }
    return iosError("unexpected", "Simulator helper request failed");
  }

  function onHelperControl(session, value) {
    if (value && value.kind === "ready") {
      session.ready = true;
      if (typeof session.readyResolve === "function") {
        const resolve = session.readyResolve;
        session.readyResolve = null;
        session.readyReject = null;
        resolve();
      }
      return;
    }
    const id = value && value.id;
    const pending = session.pending.get(id);
    if (!pending) return;
    session.pending.delete(id);
    if (value.ok === false) {
      pending.reject(mapHelperError(value.error));
    } else {
      pending.resolve(value.result);
    }
  }

  function helperDisconnected() {
    return iosError(
      "stream_disconnected",
      "Simulator helper is disconnected",
    );
  }

  function failHelperWaiters(session, err) {
    session.exited = true;
    if (typeof session.readyReject === "function") {
      const reject = session.readyReject;
      session.readyResolve = null;
      session.readyReject = null;
      reject(err);
    }
    for (const pending of session.pending.values()) {
      pending.reject(err);
    }
    session.pending.clear();
  }

  function disconnectHelperSession(session) {
    session.stream = "disconnected";
    session.input = "disconnected";
    session.accessibility = "disconnected";
    const broker = currentStreamBroker();
    if (session.streamInfo && broker && typeof broker.closeSession === "function") {
      try {
        broker.closeSession(session.streamInfo.generation);
      } catch {
        // ignore
      }
      session.streamInfo = null;
    }
  }

  function helperSessionWritable(session) {
    return (
      helper === session &&
      lease != null &&
      lease.state === "active" &&
      lease.generation === session.generation
    );
  }

  function assertHelperSession(threadId, generation, session = helper) {
    assertOwnedLease(threadId, generation);
    if (!session || helper !== session || session.stream === "disconnected") {
      throw helperDisconnected();
    }
    if (!helperSessionWritable(session)) throw leaseStale();
  }

  async function persistHelperIdentity(session) {
    if (helper !== session) return;
    if (!isActiveLease() || lease.generation !== session.generation) return;
    const pid = session.child && session.child.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    const next = {
      ...lease,
      helperPid: pid,
      protocolToken: session.controlToken,
    };
    lease = next;
    await writeJournal(next);
  }

  async function clearHelperIdentityBestEffort(session) {
    if (!lease) return;
    const pid = session.child && session.child.pid;
    if (lease.helperPid !== pid) return;
    const next = { ...lease, helperPid: null, protocolToken: null };
    lease = next;
    try {
      await writeJournal(next);
    } catch {
      logJournalWarning("Simulator helper journal clear failed");
    }
  }

  function onHelperExit(session) {
    failHelperWaiters(session, helperDisconnected());
    if (helper !== session) return;
    disconnectHelperSession(session);
    publishSimulatorChanged();
    void clearHelperIdentityBestEffort(session);
  }

  function stopHelper() {
    const session = helper;
    helper = null;
    if (!session) return;
    failHelperWaiters(session, helperDisconnected());
    disconnectHelperSession(session);
    void clearHelperIdentityBestEffort(session);
    if (session.child && !session.child.killed) {
      try {
        session.child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  function waitForHelperReady(session) {
    if (session.ready) return Promise.resolve();
    if (session.exited) return Promise.reject(helperDisconnected());
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        session.readyResolve = null;
        session.readyReject = null;
        reject(iosError("timeout", "Simulator helper did not become ready"));
      }, HELPER_READY_TIMEOUT_MS);
      session.readyResolve = () => {
        clearTimer(timer);
        resolve();
      };
      session.readyReject = (err) => {
        clearTimer(timer);
        reject(err);
      };
      if (session.exited) {
        session.readyReject(helperDisconnected());
      }
    });
  }

  function helperRpcWithSession(session, method, payload) {
    if (!session || !session.child) {
      return Promise.reject(helperDisconnected());
    }
    const controlIn = session.child.stdio && session.child.stdio[3];
    if (!controlIn || typeof controlIn.write !== "function") {
      return Promise.reject(helperDisconnected());
    }
    if (!helperSessionWritable(session)) {
      return Promise.reject(leaseStale());
    }
    const id = session.nextId;
    session.nextId += 1;
    const frame = {
      id,
      method,
      generation: session.generation,
      token: session.controlToken,
      ...(payload && typeof payload === "object" ? payload : {}),
    };
    if (payload && typeof payload === "object") {
      frame.payload = payload;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        session.pending.delete(id);
        reject(iosError("timeout", "Simulator helper did not respond"));
      }, HELPER_RPC_TIMEOUT_MS);
      session.pending.set(id, {
        resolve(result) {
          clearTimer(timer);
          resolve(result);
        },
        reject(err) {
          clearTimer(timer);
          reject(err);
        },
      });
      try {
        if (!helperSessionWritable(session)) {
          session.pending.delete(id);
          clearTimer(timer);
          reject(leaseStale());
          return;
        }
        controlIn.write(protocol.encodeControl(frame));
      } catch (err) {
        session.pending.delete(id);
        clearTimer(timer);
        reject(helperDisconnected());
      }
    });
  }

  async function withHelper(threadId, generation, fn) {
    assertHelperSession(threadId, generation);
    const session = helper;
    const result = await fn(session);
    assertHelperSession(threadId, generation, session);
    return result;
  }

  async function startHelper() {
    const current = lease;
    if (!current || current.state !== "active") return;
    const broker = currentStreamBroker();
    if (!broker || typeof broker.createSession !== "function") return;
    const executable = await resolvedToolchain.ensureHelper(current.developerDir);
    if (lease !== current) return;
    const profile = path.resolve(String(sandboxProfilePath || ""));
    if (!path.isAbsolute(profile)) {
      throw iosError("unexpected", "Simulator helper sandbox profile is invalid");
    }
    const child = spawnHelper(
      executable,
      helperSpawnArgs(profile, current.developerDir),
      {
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
        env: { ...process.env, DEVELOPER_DIR: current.developerDir },
        windowsHide: true,
      },
    );
    const session = {
      child,
      generation: current.generation,
      controlToken: crypto.randomBytes(32).toString("base64url"),
      nextId: 1,
      pending: new Map(),
      ready: false,
      readyResolve: null,
      readyReject: null,
      exited: false,
      streamInfo: null,
      helperCaps: null,
      stream: "disconnected",
      input: "disconnected",
      accessibility: "disconnected",
    };
    helper = session;
    const controlOut = child.stdio && child.stdio[4];
    if (!controlOut || typeof controlOut.on !== "function") {
      throw iosError("unexpected", "Simulator helper control pipe is unavailable");
    }
    const decoder = protocol.createControlDecoder((value) => {
      onHelperControl(session, value);
    });
    controlOut.on("data", (chunk) => {
      try {
        decoder(chunk);
      } catch {
        onHelperExit(session);
      }
    });
    child.on("exit", () => onHelperExit(session));
    child.on("error", () => onHelperExit(session));
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", () => {});
    }
    await persistHelperIdentity(session);
    if (!helperSessionWritable(session)) return;
    await waitForHelperReady(session);
    if (!helperSessionWritable(session)) return;
    const handshake = await helperRpcWithSession(session, "handshake", {
      udid: current.deviceUdid,
    });
    const caps =
      handshake && handshake.capabilities && typeof handshake.capabilities === "object"
        ? handshake.capabilities
        : {};
    session.helperCaps = caps;
    session.input = caps.touch ? "connected" : "disconnected";
    session.accessibility = caps.accessibility ? "connected" : "disconnected";
    if (!helperSessionWritable(session)) return;
    if (typeof broker.listen === "function") {
      await broker.listen();
    }
    if (!helperSessionWritable(session)) return;
    const created = broker.createSession({
      generation: current.generation,
      requestKeyframe: () => {
        void helperRpcWithSession(session, "requestKeyframe", {}).catch(() => {});
      },
      setBitrate: (bps) => {
        void helperRpcWithSession(session, "setBitrate", { bps }).catch(() => {});
      },
    });
    session.streamInfo = {
      url: created.url,
      helperToken: created.helperToken,
      viewerToken: created.viewerToken,
      generation: created.generation,
    };
    await helperRpcWithSession(session, "startStream", {
      url: created.url,
      helperToken: created.helperToken,
      generation: created.generation,
    });
    if (!helperSessionWritable(session)) return;
    session.stream = "connected";
    if (caps.touch) session.input = "connected";
    if (caps.accessibility) session.accessibility = "connected";
    publishSimulatorChanged();
  }

  async function startHelperBestEffort() {
    try {
      await startHelper();
    } catch (err) {
      if (helper && helper.stream !== "connected") {
        stopHelper();
      }
      logJournalWarning("Simulator helper failed to start");
      void err;
    }
  }

  function requireCoord(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw iosError("unexpected", `Simulator ${label} is invalid`);
    }
    if (Math.abs(value) > COORD_ABS_MAX) {
      throw iosError("unexpected", `Simulator ${label} is invalid`);
    }
    return value;
  }

  function viewerStreamInfoFromSession(session) {
    if (!session || !session.streamInfo) {
      throw iosError(
        "stream_disconnected",
        "Simulator helper is disconnected",
      );
    }
    return Object.freeze({
      url: session.streamInfo.url,
      token: session.streamInfo.viewerToken,
      generation: session.streamInfo.generation,
      protocolVersion: 1,
      maxMessageBytes: protocol.limits.maxVideoBytes,
    });
  }

  async function getStatus(input) {
    const threadId = input && input.threadId;
    const { threadId: normalizedThreadId } = resolveThread(threadId);
    if (!lease) {
      return Object.freeze({
        attached: false,
        state: null,
        isOwner: false,
        generation: null,
        deviceUdid: null,
        bootedBySolenta: null,
        ...disconnectedHelperState(),
      });
    }
    return Object.freeze({
      attached: true,
      state: lease.state,
      isOwner: lease.ownerThreadId === normalizedThreadId,
      generation: lease.generation,
      deviceUdid: lease.deviceUdid,
      bootedBySolenta: lease.bootedBySolenta,
      ...helperConnectionState(),
    });
  }

  async function attach(input) {
    const threadId = input && input.threadId;
    const deviceUdid = String((input && input.deviceUdid) ?? "").trim();
    const { project, threadId: normalizedThreadId } = resolveThread(threadId);
    if (!deviceUdid) {
      throw iosError("device_missing", "Simulator device was not found");
    }
    if (leasePresent()) {
      if (
        isActiveLease() &&
        lease.ownerThreadId === normalizedThreadId &&
        lease.deviceUdid === deviceUdid
      ) {
        return currentLeaseSnapshot();
      }
      throw iosError("device_busy", "Simulator is controlled by another thread");
    }
    const raw = await discoverRaw();
    const device = raw.devices.find((entry) => entry.udid === deviceUdid);
    if (!device) {
      throw iosError("device_missing", "Simulator device was not found");
    }
    return mutate(async () => {
      if (leasePresent()) {
        if (
          isActiveLease() &&
          lease.ownerThreadId === normalizedThreadId &&
          lease.deviceUdid === deviceUdid
        ) {
          return currentLeaseSnapshot();
        }
        throw iosError(
          "device_busy",
          "Simulator is controlled by another thread",
        );
      }
      const timestamp = now();
      const generation = nextGeneration();
      const newLease = {
        version: 1,
        state: "active",
        generation,
        ownerThreadId: normalizedThreadId,
        ownerProjectId: project.id,
        deviceUdid,
        developerDir: raw.developerDir,
        bootedBySolenta: false,
        acquiredAt: timestamp,
        lastActivityAt: timestamp,
        helperPid: null,
        protocolToken: null,
        recording: null,
      };
      try {
        await writeJournal(newLease);
      } catch (err) {
        if (err instanceof IOSSimulatorError) throw err;
        throw iosError("unexpected", "Simulator lease journal is invalid");
      }
      lease = newLease;
      await startHelperBestEffort();
      publishSimulatorChanged();
      return currentLeaseSnapshot();
    });
  }

  async function takeover(input) {
    const threadId = input && input.threadId;
    const deviceUdid = input && input.deviceUdid;
    const confirmed = input && input.confirmed;
    const { project, threadId: normalizedThreadId } = resolveThread(threadId);
    if (confirmed !== true) {
      throw iosError(
        "takeover_required",
        "Takeover requires explicit confirmation",
      );
    }
    if (!isActiveLease()) throw leaseStale();
    if (
      deviceUdid !== undefined &&
      deviceUdid !== null &&
      String(deviceUdid) !== lease.deviceUdid
    ) {
      throw iosError(
        "device_busy",
        "Simulator is attached to a different device",
      );
    }
    const prior = cloneLease(lease);
    const timestamp = now();
    const generation = nextGeneration();
    const releasingLease = {
      ...lease,
      state: "releasing",
      generation,
      ownerThreadId: normalizedThreadId,
      ownerProjectId: project.id,
      acquiredAt: timestamp,
      lastActivityAt: timestamp,
    };
    // Synchronous invalidation before the first await so in-flight mutations
    // observe the bumped generation on post-await re-validation.
    lease = releasingLease;
    try {
      await writeJournal(releasingLease);
    } catch (err) {
      lease = prior;
      if (err instanceof IOSSimulatorError) throw err;
      throw iosError("unexpected", "Simulator lease journal is invalid");
    }
    // The releasing record still carries the outgoing recording so a crash
    // during handoff stays recoverable; only the published active record
    // clears it.
    await finalizeRecordingForOwnershipChange();
    releaseFinishedRecording();
    stopHelper();
    const activeLease = {
      ...releasingLease,
      state: "active",
      recording: null,
      helperPid: null,
      protocolToken: null,
    };
    const resultSnapshot = leaseSnapshot(activeLease);
    try {
      await writeJournal(activeLease);
      lease = activeLease;
      await startHelperBestEffort();
      publishSimulatorChanged();
      return resultSnapshot;
    } catch (err) {
      try {
        await writeJournal(prior);
        lease = prior;
      } catch {
        lease = releasingLease;
        throw iosError("unexpected", "Simulator lease journal is invalid");
      }
      if (err instanceof IOSSimulatorError) throw err;
      throw iosError("unexpected", "Simulator lease journal is invalid");
    }
  }

  async function restoreBootIntentIfCurrent(intentLease, priorBootLease) {
    if (lease !== intentLease) return;
    lease = priorBootLease;
    try {
      await writeJournal(priorBootLease);
    } catch {
      logJournalWarning("Simulator boot intent rollback journal write failed");
    }
  }

  async function boot(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    return mutate(async () => {
      assertOwnedLease(threadId, generation);
      const raw = await withOwnedLease(threadId, generation, async () => {
        const current = lease;
        return discoverRaw(current.developerDir);
      });
      const deviceUdid = lease.deviceUdid;
      const device = raw.devices.find((entry) => entry.udid === deviceUdid);
      if (!device) {
        throw iosError("device_missing", "Simulator device was not found");
      }
      if (device.state === "Booted") {
        await touchLeaseActivityBestEffort();
        return currentLeaseSnapshot();
      }
      const priorBootLease = cloneLease(lease);
      const intentLease = {
        ...lease,
        bootedBySolenta: true,
        lastActivityAt: now(),
      };
      lease = intentLease;
      try {
        await writeJournal(intentLease);
      } catch (err) {
        if (lease === intentLease) {
          lease = priorBootLease;
        }
        if (err instanceof IOSSimulatorError) throw err;
        throw iosError("unexpected", "Simulator lease journal is invalid");
      }
      try {
        await withOwnedLease(threadId, generation, async () => {
          const current = lease;
          await callProcess(
            () => processAdapter.boot(current.developerDir, current.deviceUdid),
            "Failed to boot the simulator device",
          );
        });
      } catch (err) {
        await restoreBootIntentIfCurrent(intentLease, priorBootLease);
        throw err;
      }
      await withOwnedLease(threadId, generation, async () => {
        const current = lease;
        await callProcess(
          () =>
            processAdapter.bootStatus(current.developerDir, current.deviceUdid),
          "Failed to wait for the simulator device to boot",
        );
      });
      return currentLeaseSnapshot();
    });
  }

  async function detach(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    return mutate(async () => {
      assertOwnedLease(threadId, generation);
      await finalizeRecordingForOwnershipChange();
      assertOwnedLease(threadId, generation);
      const bootedBySolenta = lease.bootedBySolenta;
      const developerDir = lease.developerDir;
      const deviceUdid = lease.deviceUdid;
      if (bootedBySolenta) {
        await withOwnedLease(threadId, generation, async () => {
          await callProcess(
            () => processAdapter.shutdown(developerDir, deviceUdid),
            "Failed to shut down the simulator device",
          );
        });
      }
      assertOwnedLease(threadId, generation);
      stopHelper();
      lease = null;
      releaseFinishedRecording();
      await removeJournal();
      publishSimulatorChanged();
      return Object.freeze({ detached: true });
    });
  }

  function releaseSummary(fields = {}) {
    return Object.freeze({
      released: fields.released === true,
      stoppedRecording: fields.stoppedRecording === true,
      shutDownDevice: fields.shutDownDevice === true,
      journalCleared: fields.journalCleared === true,
    });
  }

  /**
   * Revoke ownership of a lease this app can no longer justify holding, then
   * clean up what that lease owned.
   *
   * `matches` and the revocation run synchronously, before the first await, so
   * every in-flight call re-validating ownership afterwards sees `lease` gone
   * and cannot resurrect the device, the recording, or the journal. The cleanup
   * below then works off the captured record only — a stale caller has nothing
   * left to reverse it with.
   *
   * @param {(lease: object) => boolean} matches
   */
  function revokeAndRelease(matches) {
    const current = lease;
    if (!current || !matches(current)) {
      return Promise.resolve(releaseSummary());
    }
    const captured = {
      developerDir: current.developerDir,
      deviceUdid: current.deviceUdid,
      bootedBySolenta: current.bootedBySolenta,
    };
    stopHelper();
    lease = null;
    releaseFinishedRecording();
    // Memoizing the finalization here is part of the synchronous revocation:
    // the recorder is stopped and its outcome fixed before anything can ask
    // for a different one.
    const context = recording;
    const finalization = context
      ? beginFinalization(context, "ownership")
      : null;
    return finishRelease(captured, finalization);
  }

  async function finishRelease(captured, finalization) {
    let cleanupFailed = false;
    if (finalization) {
      try {
        await finalization;
      } catch {
        // A recording that could not be committed is already discarded; the
        // device release must not depend on it.
        logJournalWarning(
          "Simulator recording finalization failed during release",
        );
      }
      // The finalization re-registers its own outcome for a same-owner replay;
      // that owner is gone, so drop it and the child handle with it.
      releaseFinishedRecording();
    }
    let shutDownDevice = false;
    // Only a device this app booted is shut down, and no path here erases one.
    if (captured.bootedBySolenta) {
      try {
        await callProcess(
          () =>
            processAdapter.shutdown(captured.developerDir, captured.deviceUdid),
          "Failed to shut down the simulator device",
        );
        shutDownDevice = true;
      } catch {
        cleanupFailed = true;
        logJournalWarning("Simulator device shutdown failed during release");
      }
    }
    // Clear the journal only when it can still only describe what was just
    // cleaned up: a failed shutdown has to stay recoverable, and a lease
    // acquired while this cleanup ran owns the file now.
    let journalCleared = false;
    if (!cleanupFailed && lease === null) {
      journalCleared = await removeJournalStrict();
    }
    return releaseSummary({
      released: true,
      stoppedRecording: finalization !== null,
      shutDownDevice,
      journalCleared,
    });
  }

  /**
   * Thread lifecycle release (archive, delete). Best-effort by contract: the
   * caller has already made the deletion durable and must not be told it
   * failed. Never rejects.
   * @param {{ threadId?: string }} input
   */
  async function releaseThread(input) {
    const raw = input && input.threadId;
    const threadId = raw == null || raw === "" ? null : String(raw);
    if (threadId === null) return releaseSummary();
    return revokeAndRelease((current) => current.ownerThreadId === threadId);
  }

  /**
   * Project lifecycle release (project removed). Covers every thread of that
   * project, including one whose store row is already gone.
   * @param {{ projectId?: string }} input
   */
  async function releaseProject(input) {
    const raw = input && input.projectId;
    const projectId = raw == null || raw === "" ? null : String(raw);
    if (projectId === null) return releaseSummary();
    return revokeAndRelease((current) => current.ownerProjectId === projectId);
  }

  /**
   * A run reached a terminal status. Retire only the recording that run
   * started: a manual recording (no run id) and another run's recording both
   * outlive it, and the lease is never released — the thread keeps the device
   * across runs.
   *
   * Revocation is synchronous so a terminal that arrives while the next run is
   * already starting cannot stop the new run's recording. Never rejects.
   *
   * @param {{ threadId?: string, runId?: string | null, status?: string }} input
   * @returns {Promise<{ stopped: boolean }>}
   */
  function onRunTerminal(input) {
    const rawThreadId = input && input.threadId;
    const rawRunId = input && input.runId;
    const threadId =
      rawThreadId == null || rawThreadId === "" ? null : String(rawThreadId);
    const runId = rawRunId == null || rawRunId === "" ? null : String(rawRunId);
    const context = recording;
    if (
      threadId === null ||
      runId === null ||
      !context ||
      context.runId === null ||
      context.runId !== runId ||
      context.threadId !== threadId
    ) {
      return Promise.resolve(Object.freeze({ stopped: false }));
    }
    const finalization = beginFinalization(context, "run_terminal");
    // The artifacts (or the failure) belong to whoever asked for the recording;
    // a terminal notification only has to guarantee it stopped.
    return finalization.then(
      () => Object.freeze({ stopped: true }),
      () => Object.freeze({ stopped: true }),
    );
  }

  /**
   * App teardown. Finalizes a live recording and releases device ownership
   * whoever holds it, then clears the journal so the next launch has nothing
   * to recover. Idempotent: every caller shares the first call's promise.
   */
  function shutdown() {
    // Not an async function: the revocation inside revokeAndRelease has to run
    // on the caller's tick, not on the first microtask after it.
    if (!shutdownPromise) shutdownPromise = revokeAndRelease(() => true);
    return shutdownPromise;
  }

  async function install(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const relativeAppPath = input && input.relativeAppPath;
    assertOwnedLease(threadId, generation);
    let descriptor;
    try {
      descriptor = await prepareAppBundle({ threadId, relativeAppPath });
    } catch (err) {
      if (err instanceof IOSSimulatorError) throw err;
      throw iosError("unexpected", "Failed to prepare the app bundle");
    }
    assertOwnedLease(threadId, generation);
    return mutate(async () => {
      assertOwnedLease(threadId, generation);
      await withOwnedLease(threadId, generation, async () => {
        const current = lease;
        await callProcess(
          () =>
            processAdapter.install(
              current.developerDir,
              current.deviceUdid,
              descriptor.appPath,
            ),
          "Failed to install the app bundle",
        );
      });
      await touchLeaseActivityBestEffort();
      return Object.freeze({ bundleId: descriptor.bundleId });
    });
  }

  async function launch(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const bundleId = String((input && input.bundleId) ?? "").trim();
    if (!BUNDLE_ID_RE.test(bundleId)) throw invalidBundle();
    return mutate(async () => {
      const output = await withOwnedLease(threadId, generation, async () => {
        const current = lease;
        return callProcess(
          () =>
            processAdapter.launch(
              current.developerDir,
              current.deviceUdid,
              bundleId,
            ),
          "Failed to launch the app",
        );
      });
      await touchLeaseActivityBestEffort();
      return Object.freeze({ pid: parseLaunchPid(bundleId, output) });
    });
  }

  async function openUrl(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const url = validateSimulatorUrl(input && input.url);
    return mutate(async () => {
      await withOwnedLease(threadId, generation, async () => {
        const current = lease;
        await callProcess(
          () =>
            processAdapter.openUrl(
              current.developerDir,
              current.deviceUdid,
              url,
            ),
          "Failed to open the URL",
        );
      });
      await touchLeaseActivityBestEffort();
      return Object.freeze({ opened: true });
    });
  }

  function normalizeRunId(rawRunId) {
    if (rawRunId == null || rawRunId === "") return null;
    return String(rawRunId);
  }

  async function discardStagedArtifactBestEffort(token) {
    if (!artifactStore || typeof artifactStore.discard !== "function") return;
    try {
      await artifactStore.discard(token);
    } catch {
      // best-effort
    }
  }

  async function captureScreenshot(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const runId = normalizeRunId(input && input.runId);
    const toolCallId = input && input.toolCallId;
    if (!artifactStore) {
      throw iosError("unexpected", "Simulator screenshot storage is unavailable");
    }
    assertOwnedLease(threadId, generation);
    const { threadId: normalizedThreadId } = resolveThread(threadId);
    return mutate(async () => {
      assertOwnedLease(threadId, generation);
      let stagingToken = null;
      try {
        const staged = await artifactStore.stage({
          kind: "image",
          mimeType: "image/png",
        });
        stagingToken = staged.token;
        await withOwnedLease(threadId, generation, async () => {
          const current = lease;
          await callProcess(
            () =>
              processAdapter.screenshot(
                current.developerDir,
                current.deviceUdid,
                staged.path,
              ),
            "Failed to capture the simulator screenshot",
          );
        });
        assertOwnedLease(threadId, generation);
        const batch = {
          threadId: normalizedThreadId,
          runId,
          source: "simulator",
          items: [
            {
              key: "screenshot",
              stagingToken: staged.token,
              kind: "image",
              mimeType: "image/png",
              name: "Simulator screenshot.png",
            },
          ],
        };
        if (toolCallId != null && toolCallId !== "") {
          batch.toolCallId = String(toolCallId);
        }
        const infos = await artifactStore.commitBatch(batch);
        await touchLeaseActivityBestEffort();
        return infos[0];
      } catch (err) {
        if (stagingToken != null) {
          await discardStagedArtifactBestEffort(stagingToken);
        }
        if (err && err.name === "RunArtifactError") throw err;
        if (err instanceof IOSSimulatorError) throw err;
        throw iosError(
          "unexpected",
          "Failed to capture the simulator screenshot",
        );
      }
    });
  }

  function recordingFailed() {
    return iosError(
      "recording_failed",
      "Failed to start the simulator recording",
    );
  }

  function recordingFinalizeFailed() {
    return iosError(
      "recording_finalize_failed",
      "Failed to finalize the simulator recording",
    );
  }

  function noActiveRecording() {
    return iosError("recording_failed", "No simulator recording is active");
  }

  function createRecordingContext(fields) {
    return {
      id: fields.id,
      threadId: fields.threadId,
      generation: fields.generation,
      runId: fields.runId,
      toolCallId: fields.toolCallId,
      developerDir: fields.developerDir,
      deviceUdid: fields.deviceUdid,
      videoToken: fields.videoToken,
      videoPath: fields.videoPath,
      handle: fields.handle,
      closed: fields.closed,
      pid: fields.pid,
      startedAt: fields.startedAt,
      reason: null,
      finalization: null,
      interrupted: false,
      killed: false,
      timersCleared: false,
      startSettled: false,
      closeObserved: null,
      pollTimer: null,
      autoStopTimer: null,
    };
  }

  // An unexpected recorder exit must retire the recording slot and the journal
  // now rather than at the five-minute auto-stop. The reaction waits for the
  // start to settle so a start that ultimately failed can never publish an
  // artifact its caller was never told about.
  // The adapter maps every child outcome onto a resolved value, but a rejection
  // handler is attached anyway so a future adapter change can never turn an
  // early exit into an unhandled rejection that skips the teardown.
  function observeRecordingClose(context) {
    context.closed.then(
      (result) => {
        context.closeObserved = result;
        finalizeIfRecorderClosed(context);
      },
      () => {
        context.closeObserved = { finalized: false, failed: true };
        finalizeIfRecorderClosed(context);
      },
    );
  }

  function finalizeIfRecorderClosed(context) {
    if (!context.startSettled) return;
    if (context.closeObserved === null) return;
    if (recording !== context) return;
    if (context.finalization) return;
    beginFinalization(context, "closed");
  }

  // Ownership changes end the same-owner stop replay contract, so drop the
  // retained result and its child-process handle instead of holding them for a
  // generation that can never ask again.
  function releaseFinishedRecording() {
    if (!finishedRecording) return;
    finishedRecording.handle = null;
    finishedRecording = null;
  }

  function clearRecordingTimers(context) {
    if (context.timersCleared) return;
    context.timersCleared = true;
    if (context.pollTimer != null) {
      clearTimer(context.pollTimer);
      context.pollTimer = null;
    }
    if (context.autoStopTimer != null) {
      clearTimer(context.autoStopTimer);
      context.autoStopTimer = null;
    }
  }

  function scheduleRecordingPoll(context) {
    if (context.timersCleared || context.finalization) return;
    context.pollTimer = setTimer(() => {
      context.pollTimer = null;
      void pollRecordingSize(context);
    }, RECORDING_POLL_INTERVAL_MS);
  }

  // Missing, unreadable, and empty all read as zero bytes: nothing worth
  // committing.
  async function recordedVideoSize(context) {
    try {
      const stat = await fsApi.promises.stat(context.videoPath);
      if (stat && typeof stat.size === "number") return stat.size;
    } catch {
      // The recorder may not have created the file yet, or it vanished.
    }
    return 0;
  }

  async function pollRecordingSize(context) {
    if (context.timersCleared || context.finalization) return;
    let size = null;
    try {
      const stat = await fsApi.promises.stat(context.videoPath);
      if (stat && typeof stat.size === "number") size = stat.size;
    } catch {
      // The recorder may not have created the file yet, or it vanished; the
      // next poll or the finalize path handles both.
    }
    if (size !== null && size > MAX_RECORDING_BYTES) {
      beginFinalization(context, "limit");
      return;
    }
    scheduleRecordingPoll(context);
  }

  function interruptRecording(context) {
    if (context.interrupted) return;
    context.interrupted = true;
    // A recorder already seen exiting is never signalled again: there is
    // nothing to interrupt and its pid may already belong to someone else.
    if (context.closeObserved !== null) return;
    if (!context.handle) return;
    try {
      context.handle.interrupt();
    } catch {
      // Already gone; the bounded close wait decides whether to escalate.
    }
  }

  // `recordVideo` spawns the recorder detached, so it leads its own process
  // group and `simctl` may have children of its own. A live forced stop targets
  // that whole group; only post-restart recovery, which has no handle and only
  // a pid it has verified, falls back to signalling the pid directly.
  function killRecording(context) {
    if (context.killed) return;
    context.killed = true;
    if (!Number.isSafeInteger(context.pid) || context.pid <= 0) return;
    try {
      signalPid(-context.pid, "SIGKILL");
      return;
    } catch {
      // The recorder is not a group leader (or the group is already gone).
    }
    try {
      signalPid(context.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }

  async function waitForRecordingClose(context) {
    let timerHandle = null;
    const expired = new Promise((resolve) => {
      timerHandle = setTimer(
        () => resolve({ finalized: false, failed: false }),
        RECORDING_FINALIZE_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([context.closed, expired]);
    } finally {
      if (timerHandle != null) clearTimer(timerHandle);
    }
  }

  // Writes `recording: null` only while this context still owns the journal.
  // After a takeover the new owner's record already carries `recording: null`,
  // so an old finalization must not resurrect the previous owner.
  async function clearRecordingJournalBestEffort(context) {
    if (!lease) return;
    if (lease.generation !== context.generation) return;
    if (lease.ownerThreadId !== context.threadId) return;
    if (!lease.recording) return;
    const next = { ...lease, recording: null, lastActivityAt: now() };
    lease = next;
    try {
      await writeJournal(next);
    } catch {
      logJournalWarning("Simulator recording journal clear failed");
    }
  }

  async function runRecordingFinalization(context) {
    clearRecordingTimers(context);
    let videoToken = context.videoToken;
    let posterToken = null;
    try {
      interruptRecording(context);
      const closed = await waitForRecordingClose(context);
      if (!closed.finalized) killRecording(context);
      // The size cap is the terminal outcome even when the recorder had to be
      // forced: the caller asked for a recording that is not allowed to exist.
      if (context.reason === "limit") {
        throw iosError(
          "artifact_limit",
          "Simulator recording exceeded its size limit",
        );
      }
      // A start that never returned must not leave an artifact behind.
      if (context.reason === "aborted") throw recordingFailed();
      if (!closed.finalized) throw recordingFinalizeFailed();
      if (closed.failed) throw recordingFinalizeFailed();
      // A recorder that exited without producing any bytes failed to record;
      // reporting the media layer's size complaint instead would read as if the
      // recording had been too large.
      if ((await recordedVideoSize(context)) <= 0) {
        throw iosError(
          "recording_failed",
          "The simulator recording produced no video",
        );
      }
      const poster = await artifactStore.stage({
        kind: "image",
        mimeType: "image/png",
      });
      posterToken = poster.token;
      await callProcess(
        () =>
          processAdapter.screenshot(
            context.developerDir,
            context.deviceUdid,
            poster.path,
          ),
        "Failed to finalize the simulator recording",
      );
      const batch = {
        threadId: context.threadId,
        runId: context.runId,
        source: "simulator",
        items: [
          {
            key: "video",
            stagingToken: videoToken,
            kind: "video",
            mimeType: "video/mp4",
            name: "Simulator recording.mp4",
            posterKey: "poster",
          },
          {
            key: "poster",
            stagingToken: posterToken,
            kind: "image",
            mimeType: "image/png",
            name: "Simulator recording poster.png",
          },
        ],
      };
      if (context.toolCallId != null) batch.toolCallId = context.toolCallId;
      const [video, poster2] = await artifactStore.commitBatch(batch);
      videoToken = null;
      posterToken = null;
      await clearRecordingJournalBestEffort(context);
      return Object.freeze({
        video: Object.freeze({ ...video }),
        poster: Object.freeze({ ...poster2 }),
      });
    } catch (err) {
      if (videoToken != null) {
        await discardStagedArtifactBestEffort(videoToken);
      }
      if (posterToken != null) {
        await discardStagedArtifactBestEffort(posterToken);
      }
      await clearRecordingJournalBestEffort(context);
      if (err && err.name === "RunArtifactError") throw err;
      if (err instanceof IOSSimulatorError) throw err;
      throw recordingFinalizeFailed();
    }
  }

  async function finalizeRecording(context) {
    try {
      return await runRecordingFinalization(context);
    } finally {
      // Retire synchronously as the finalization settles so a queued
      // `startRecording` never observes a half-torn-down recording. A start
      // that failed after spawning has no result to replay, so a later stop
      // reports no active recording instead of its teardown error.
      if (recording === context) {
        recording = null;
        finishedRecording = context.reason === "aborted" ? null : context;
      }
      // The child is gone by now, so stop holding its handle alive.
      context.handle = null;
    }
  }

  function beginFinalization(context, reason) {
    if (!context.finalization) {
      context.reason = reason;
      context.finalization = finalizeRecording(context);
      // Timer- and handoff-driven finalizations have no awaiting caller.
      context.finalization.catch(() => {});
    }
    return context.finalization;
  }

  // Used by takeover and detach: stop and finalize the outgoing recording
  // without letting its failure block the ownership change.
  async function finalizeRecordingForOwnershipChange() {
    const context = recording;
    if (!context) return;
    try {
      await beginFinalization(context, "ownership");
    } catch {
      logJournalWarning(
        "Simulator recording finalization failed during ownership change",
      );
    }
  }

  async function startRecording(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const runId = normalizeRunId(input && input.runId);
    const rawToolCallId = input && input.toolCallId;
    const toolCallId =
      rawToolCallId == null || rawToolCallId === ""
        ? null
        : String(rawToolCallId);
    if (!artifactStore) {
      throw iosError(
        "recording_failed",
        "Simulator recording storage is unavailable",
      );
    }
    const normalizedThreadId = assertOwnedLease(threadId, generation);
    return mutate(async () => {
      assertOwnedLease(threadId, generation);
      if (recording) {
        throw iosError(
          "recording_failed",
          "A simulator recording is already running",
        );
      }
      // A new start attempt supersedes the previous recording's shared stop
      // result, so a stop after a failed start reports no active recording
      // instead of replaying stale artifacts.
      finishedRecording = null;
      let stagingToken = null;
      let installedLease = null;
      let context = null;
      const priorLease = lease;
      try {
        const staged = await artifactStore.stage({
          kind: "video",
          mimeType: "video/mp4",
        });
        stagingToken = staged.token;
        assertOwnedLease(threadId, generation);
        const startedAt = now();
        const recordingId = String(randomUUID());
        const intent = {
          stagingToken: staged.token,
          tempPath: staged.path,
          pid: null,
          startedAt,
          runId,
          toolCallId,
        };
        installedLease = {
          ...lease,
          recording: intent,
          lastActivityAt: startedAt,
        };
        lease = installedLease;
        await writeJournal(installedLease);
        assertOwnedLease(threadId, generation);
        const owner = lease;
        const handle = processAdapter.recordVideo(
          owner.developerDir,
          owner.deviceUdid,
          staged.path,
        );
        const rawPid = handle && handle.pid;
        const closed =
          handle && handle.closed && typeof handle.closed.then === "function"
            ? handle.closed.then(
                () => ({ finalized: true, failed: false }),
                () => ({ finalized: true, failed: true }),
              )
            : Promise.resolve({ finalized: true, failed: true });
        context = createRecordingContext({
          id: recordingId,
          threadId: normalizedThreadId,
          generation,
          runId,
          toolCallId,
          developerDir: owner.developerDir,
          deviceUdid: owner.deviceUdid,
          videoToken: staged.token,
          videoPath: staged.path,
          handle,
          closed,
          pid: Number.isSafeInteger(rawPid) && rawPid > 0 ? rawPid : null,
          startedAt,
        });
        if (context.pid === null) throw recordingFailed();
        // The recorder is live from here on, so register it and arm the size
        // cap and auto-stop before the next await. A takeover landing during
        // the pid journal write then finds this recording, shares its
        // finalization, and cannot publish the transfer until the superseded
        // recorder is stopped and discarded.
        recording = context;
        observeRecordingClose(context);
        scheduleRecordingPoll(context);
        context.autoStopTimer = setTimer(() => {
          context.autoStopTimer = null;
          beginFinalization(context, "timeout");
        }, RECORDING_MAX_DURATION_MS);
        installedLease = {
          ...lease,
          recording: { ...intent, pid: context.pid },
        };
        lease = installedLease;
        await writeJournal(installedLease);
        assertOwnedLease(threadId, generation);
        context.startSettled = true;
        finalizeIfRecorderClosed(context);
        return Object.freeze({ recordingId, startedAt });
      } catch (err) {
        if (context) {
          // Share the memoized finalization instead of tearing down in
          // parallel, so a concurrent takeover or detach waits for the same
          // stop-and-discard this failed start needs.
          context.startSettled = true;
          await beginFinalization(context, "aborted").catch(() => {});
        } else if (stagingToken != null) {
          await discardStagedArtifactBestEffort(stagingToken);
        }
        if (installedLease !== null && lease === installedLease) {
          lease = priorLease;
          try {
            await writeJournal(priorLease);
          } catch {
            logJournalWarning(
              "Simulator recording intent rollback journal write failed",
            );
          }
        }
        if (err && err.name === "RunArtifactError") throw err;
        if (err instanceof IOSSimulatorError) throw err;
        throw recordingFailed();
      }
    });
  }

  async function stopRecording(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const rawRecordingId = input && input.recordingId;
    const requestedId =
      rawRecordingId == null || rawRecordingId === ""
        ? null
        : String(rawRecordingId);
    const normalizedThreadId = assertOwnedLease(threadId, generation);
    const active = recording;
    if (active) {
      if (requestedId !== null && requestedId !== active.id) {
        throw noActiveRecording();
      }
      if (
        active.threadId !== normalizedThreadId ||
        active.generation !== generation
      ) {
        throw noActiveRecording();
      }
      return beginFinalization(active, "explicit");
    }
    const finished = finishedRecording;
    if (
      finished &&
      finished.threadId === normalizedThreadId &&
      finished.generation === generation &&
      (requestedId === null || requestedId === finished.id)
    ) {
      return finished.finalization;
    }
    throw noActiveRecording();
  }

  async function readLeaseJournalRecord() {
    let stat;
    try {
      stat = await fsApi.promises.lstat(leaseJournalFile);
    } catch (err) {
      if (err && err.code === "ENOENT") return { status: "absent" };
      return { status: "unreadable" };
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: "invalid" };
    let text;
    try {
      text = await fsApi.promises.readFile(leaseJournalFile, "utf8");
    } catch {
      return { status: "unreadable" };
    }
    const record = parseLeaseJournal(text);
    if (!record) return { status: "invalid" };
    return { status: "valid", record };
  }

  // Reserves each quarantine name exclusively before moving the journal onto
  // it, so a second corrupt journal in the same millisecond can never destroy
  // the evidence from the first. Runs inside the journal queue so the
  // reserve-then-rename pair cannot interleave with another journal write.
  async function quarantineJournalLocked() {
    for (let attempt = 0; attempt < QUARANTINE_MAX_ATTEMPTS; attempt += 1) {
      const suffix = attempt === 0 ? "" : `-${attempt}`;
      const target = `${leaseJournalFile}.corrupt-${now()}-${String(
        randomUUID(),
      )}${suffix}`;
      let reserved;
      try {
        reserved = await fsApi.promises.open(target, "wx", 0o600);
      } catch (err) {
        if (err && err.code === "EEXIST") continue;
        return false;
      }
      try {
        await reserved.close();
      } catch {
        // The reservation still holds the name.
      }
      try {
        await fsApi.promises.rename(leaseJournalFile, target);
        return true;
      } catch {
        await fsApi.promises.unlink(target).catch(() => {});
        return false;
      }
    }
    return false;
  }

  async function quarantineJournal() {
    return enqueueJournalOp(() => quarantineJournalLocked());
  }

  async function removeJournalStrict() {
    return enqueueJournalOp(async () => {
      try {
        await fsApi.promises.unlink(leaseJournalFile);
        return true;
      } catch (err) {
        return Boolean(err && err.code === "ENOENT");
      }
    });
  }

  // Only a regular file directly inside this app's staging root may be touched
  // by recovery. Traversal, NUL, symlinks, and symlinked ancestors are treated
  // as tampering so the caller quarantines instead of deleting or signaling.
  async function resolveRecoveryTempPath(tempPath) {
    if (typeof tempPath !== "string" || !tempPath) return null;
    if (tempPath.includes("\0")) return null;
    if (!path.isAbsolute(tempPath)) return null;
    const resolved = path.resolve(tempPath);
    if (resolved === stagingRoot) return null;
    if (!resolved.startsWith(stagingRoot + path.sep)) return null;
    if (path.dirname(resolved) !== stagingRoot) return null;
    let stat;
    try {
      stat = await fsApi.promises.lstat(resolved);
    } catch (err) {
      if (err && err.code === "ENOENT") return resolved;
      return null;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    let realRoot;
    let realParent;
    try {
      realRoot = await fsApi.promises.realpath(stagingRoot);
      realParent = await fsApi.promises.realpath(path.dirname(resolved));
    } catch {
      return null;
    }
    if (realRoot !== realParent) return null;
    return resolved;
  }

  // `xcrun` resolves `simctl` through a chain, so `ps -o command=` reports the
  // live recorder under one of a few executables: `/usr/bin/xcrun simctl`, a
  // `/bin/bash` wrapper in front of the developer-dir `simctl`, or the
  // CoreSimulator `simctl` binary itself. Only those shapes are trusted.
  function isTrustedSimctlPath(candidate) {
    if (!candidate.startsWith("/")) return false;
    if (candidate.includes(" ")) return false;
    if (candidate.includes("/../")) return false;
    if (candidate.endsWith("/usr/bin/simctl")) return true;
    if (!candidate.endsWith("/bin/simctl")) return false;
    return candidate.includes("CoreSimulator");
  }

  function isTrustedRecorderPrefix(prefix) {
    if (prefix === "/usr/bin/xcrun simctl") return true;
    const wrapper = "/bin/bash ";
    const executable = prefix.startsWith(wrapper)
      ? prefix.slice(wrapper.length)
      : prefix;
    return isTrustedSimctlPath(executable);
  }

  // Only a process whose `ps` command line is a trusted recorder executable
  // followed by exactly the argv tail Solenta spawns may be signalled. Anchoring
  // the whole tail rather than searching for substrings rejects pid reuse by a
  // neighbouring device (`UDID-suffix`), a neighbouring staged file
  // (`path.extra`), extra trailing arguments, an `echo`/`sh -c` of the same
  // words, and anything unrelated — and because the staged path terminates the
  // command, it stays exact for paths containing spaces, which `ps` renders
  // unquoted.
  async function recoveredProcessMatches(pid, deviceUdid, tempPath) {
    let output;
    try {
      output = String(await processAdapter.inspectProcess(pid));
    } catch {
      return false;
    }
    const command = output.trim();
    if (!command) return false;
    const tail = ` ${recordingArgumentTail(deviceUdid, tempPath)}`;
    if (!command.endsWith(tail)) return false;
    const prefix = command.slice(0, command.length - tail.length);
    return isTrustedRecorderPrefix(prefix);
  }

  async function recoveredHelperProcessMatches(pid, developerDir) {
    let output;
    try {
      output = String(await processAdapter.inspectProcess(pid));
    } catch {
      return false;
    }
    const command = output.trim();
    if (!command) return false;
    const profile = path.resolve(String(sandboxProfilePath || ""));
    if (!path.isAbsolute(profile)) return false;
    const tail = ` ${helperArgumentTail(profile, developerDir)}`;
    if (!command.endsWith(tail)) return false;
    const prefix = command.slice(0, command.length - tail.length);
    return isTrustedHelperPrefix(prefix);
  }

  async function stopRecoveredHelperProcess(record) {
    const pid = record.helperPid;
    if (pid == null) return "gone";
    const matches = () => recoveredHelperProcessMatches(pid, record.developerDir);
    if (!(await matches())) return "gone";
    if (!signalRecoveredPid(pid, "SIGTERM")) {
      return (await matches()) ? "alive" : "gone";
    }
    await delay(RECOVERY_SIGNAL_GRACE_MS);
    if (!(await matches())) return "gone";
    signalRecoveredPid(pid, "SIGKILL");
    await delay(RECOVERY_SIGNAL_GRACE_MS);
    return (await matches()) ? "alive" : "gone";
  }

  function signalRecoveredPid(pid, signal) {
    try {
      signalPid(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  function delay(ms) {
    return new Promise((resolve) => {
      setTimer(() => resolve(undefined), ms);
    });
  }

  // Returns "gone" when no matching recorder is left to worry about, or "alive"
  // when one survived every signal. A survivor is still writing to the staged
  // file, so the caller must leave both the file and the journal alone.
  async function stopRecoveredRecordingProcess(record, tempPath) {
    const pid = record.recording.pid;
    if (pid == null) return "gone";
    const matches = () =>
      recoveredProcessMatches(pid, record.deviceUdid, tempPath);
    if (!(await matches())) return "gone";
    if (!signalRecoveredPid(pid, "SIGINT")) {
      return (await matches()) ? "alive" : "gone";
    }
    await delay(RECOVERY_SIGNAL_GRACE_MS);
    if (!(await matches())) return "gone";
    signalRecoveredPid(pid, "SIGKILL");
    await delay(RECOVERY_SIGNAL_GRACE_MS);
    return (await matches()) ? "alive" : "gone";
  }

  async function removeRecoveredTempFile(tempPath) {
    try {
      await fsApi.promises.unlink(tempPath);
      return true;
    } catch (err) {
      return Boolean(err && err.code === "ENOENT");
    }
  }

  // The journal is attacker-writable in the threat model, so its developer
  // directory is never handed to `xcrun`. Recovery instead resolves the
  // directory the app currently trusts — a persisted custom Xcode selection or
  // the active `xcode-select` one — and requires the journalled value to name
  // exactly that. A journalled directory is never passed to `xcrun` on its own.
  async function trustedRecoveryDeveloperDir(record) {
    let trusted;
    try {
      trusted = await selectedDeveloperDirectory();
    } catch {
      return { status: "unresolved" };
    }
    if (typeof trusted !== "string" || !trusted) {
      return { status: "unresolved" };
    }
    if (
      typeof record.developerDir !== "string" ||
      record.developerDir === "" ||
      path.resolve(record.developerDir) !== path.resolve(trusted)
    ) {
      return { status: "untrusted" };
    }
    return { status: "trusted", developerDir: trusted };
  }

  async function shutdownRecoveredDevice(record, developerDir) {
    try {
      await processAdapter.shutdown(developerDir, record.deviceUdid);
      return "shutdown";
    } catch (err) {
      if (DEVICE_ALREADY_OFF_RE.test(adapterFailureText(err))) {
        return "already-off";
      }
      return "failed";
    }
  }

  // A journal we could not move aside is still on disk, so the next launch
  // sees it again.
  async function quarantineSummary() {
    const quarantined = await quarantineJournal();
    return recoverySummary({ quarantined, journalRetained: !quarantined });
  }

  // Keeps boot ownership for a later retry while durably dropping the recording
  // work this launch already finished, so a repeat recovery never re-signals a
  // pid that has since been reused.
  async function retainJournalWithoutRecording(record) {
    try {
      await writeJournal({ ...record, recording: null });
    } catch {
      // The unchanged journal is still retryable; recovery tolerates a
      // recording entry whose process and file are already gone.
    }
  }

  function recoverySummary(fields = {}) {
    return Object.freeze({
      recovered: fields.recovered === true,
      quarantined: fields.quarantined === true,
      cleanedRecording: fields.cleanedRecording === true,
      shutDownDevice: fields.shutDownDevice === true,
      journalRetained: fields.journalRetained === true,
    });
  }

  async function recover() {
    return mutate(async () => {
      try {
        if (lease !== null || recording !== null) return recoverySummary();
        releaseFinishedRecording();
        const read = await readLeaseJournalRecord();
        if (read.status === "absent") return recoverySummary();
        if (read.status === "unreadable") {
          return recoverySummary({ journalRetained: true });
        }
        if (read.status === "invalid") return quarantineSummary();
        const record = read.record;
        // Burn the persisted generation as soon as the record parses, before
        // any tamper check can bail out, so a fresh attach can never reuse a
        // generation an old async operation might still be carrying.
        if (record.generation > lastGeneration) {
          lastGeneration = record.generation;
        }
        let tempPath = null;
        if (record.recording) {
          tempPath = await resolveRecoveryTempPath(record.recording.tempPath);
          if (tempPath === null) return quarantineSummary();
        }
        // Retiring a stale recorder needs no developer directory, so it runs
        // before the Xcode trust check: the recorder is stopped even when this
        // launch can no longer agree with the journal about which Xcode booted
        // the device.
        let cleanupFailed = false;
        let cleanedRecording = false;
        if (record.recording && tempPath !== null) {
          const survivor = await stopRecoveredRecordingProcess(record, tempPath);
          if (survivor === "alive") {
            // A recorder that outlived SIGKILL is still writing to the staged
            // file, so neither the file nor the journal describing it may go.
            await stopRecoveredHelperProcess(record);
            return recoverySummary({ recovered: true, journalRetained: true });
          }
          cleanedRecording = await removeRecoveredTempFile(tempPath);
          if (!cleanedRecording) cleanupFailed = true;
        }
        if (record.helperPid != null) {
          const helperSurvivor = await stopRecoveredHelperProcess(record);
          if (helperSurvivor === "alive") {
            return recoverySummary({
              recovered: true,
              cleanedRecording,
              journalRetained: true,
            });
          }
        }
        let developerDir = null;
        if (record.bootedBySolenta) {
          const trust = await trustedRecoveryDeveloperDir(record);
          if (trust.status !== "trusted") {
            // A developer directory that cannot be resolved, or that the user
            // has since switched away from, is a configuration change rather
            // than corruption: run no `simctl`, quarantine nothing, and keep a
            // retryable journal minus the recording already dealt with.
            if (cleanedRecording) await retainJournalWithoutRecording(record);
            return recoverySummary({
              recovered: true,
              cleanedRecording,
              journalRetained: true,
            });
          }
          developerDir = trust.developerDir;
        }
        let shutDownDevice = false;
        if (developerDir !== null) {
          const result = await shutdownRecoveredDevice(record, developerDir);
          if (result === "failed") cleanupFailed = true;
          shutDownDevice = result === "shutdown";
        }
        if (cleanupFailed) {
          return recoverySummary({
            recovered: true,
            cleanedRecording,
            shutDownDevice,
            journalRetained: true,
          });
        }
        const removed = await removeJournalStrict();
        return recoverySummary({
          recovered: true,
          cleanedRecording,
          shutDownDevice,
          journalRetained: !removed,
        });
      } catch {
        // Recovery runs before the service is exposed; it must never reject and
        // strand app startup. A retained journal is retried next launch.
        logJournalWarning("Simulator lease recovery failed");
        return recoverySummary({ journalRetained: true });
      }
    });
  }

  async function streamInfo(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    assertOwnedLease(threadId, generation);
    return viewerStreamInfoFromSession(helper);
  }

  async function retryStream(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    return mutate(async () => {
      assertOwnedLease(threadId, generation);
      stopHelper();
      await startHelperBestEffort();
      assertOwnedLease(threadId, generation);
      return viewerStreamInfoFromSession(helper);
    });
  }

  async function tap(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const x = requireCoord(input && input.x, "x");
    const y = requireCoord(input && input.y, "y");
    return mutate(async () => {
      await withHelper(threadId, generation, async (session) => {
        await helperRpcWithSession(session, "touch", {
          phase: "down",
          x,
          y,
          pointerId: 1,
        });
        await delay(TAP_HOLD_MS);
        assertHelperSession(threadId, generation, session);
        await helperRpcWithSession(session, "touch", {
          phase: "up",
          x,
          y,
          pointerId: 1,
        });
      });
      await touchLeaseActivityBestEffort();
      return Object.freeze({ ok: true });
    });
  }

  async function swipe(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const x1 = requireCoord(input && input.x1, "x1");
    const y1 = requireCoord(input && input.y1, "y1");
    const x2 = requireCoord(input && input.x2, "x2");
    const y2 = requireCoord(input && input.y2, "y2");
    let durationMs = input && input.durationMs;
    if (durationMs == null) durationMs = 200;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
      throw iosError("unexpected", "Simulator swipe duration is invalid");
    }
    durationMs = Math.min(
      SWIPE_MAX_DURATION_MS,
      Math.max(SWIPE_MIN_DURATION_MS, durationMs),
    );
    const moves = Math.min(
      SWIPE_MAX_MOVES,
      Math.max(1, Math.round(durationMs / 40)),
    );
    return mutate(async () => {
      await withHelper(threadId, generation, async (session) => {
        await helperRpcWithSession(session, "touch", {
          phase: "down",
          x: x1,
          y: y1,
          pointerId: 1,
        });
        for (let i = 1; i <= moves; i += 1) {
          const t = i / (moves + 1);
          assertHelperSession(threadId, generation, session);
          await helperRpcWithSession(session, "touch", {
            phase: "move",
            x: x1 + (x2 - x1) * t,
            y: y1 + (y2 - y1) * t,
            pointerId: 1,
          });
        }
        assertHelperSession(threadId, generation, session);
        await helperRpcWithSession(session, "touch", {
          phase: "up",
          x: x2,
          y: y2,
          pointerId: 1,
        });
      });
      await touchLeaseActivityBestEffort();
      return Object.freeze({ ok: true });
    });
  }

  async function typeText(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const text = input && input.text;
    if (typeof text !== "string") {
      throw iosError("unexpected", "Simulator text is invalid");
    }
    if (Buffer.byteLength(text, "utf8") > TYPE_TEXT_MAX_BYTES) {
      throw iosError("unexpected", "Simulator text is too long");
    }
    return mutate(async () => {
      await withHelper(threadId, generation, async (session) => {
        await helperRpcWithSession(session, "text", { text });
      });
      await touchLeaseActivityBestEffort();
      return Object.freeze({ ok: true });
    });
  }

  async function pressButton(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const button = input && input.button;
    if (!HARDWARE_BUTTONS.has(button)) {
      throw iosError("unexpected", "Simulator hardware button is invalid");
    }
    return mutate(async () => {
      await withHelper(threadId, generation, async (session) => {
        await helperRpcWithSession(session, "pressButton", { button });
      });
      await touchLeaseActivityBestEffort();
      return Object.freeze({ ok: true });
    });
  }

  async function sendInput(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const event = input && input.input;
    if (!event || typeof event !== "object") {
      throw iosError("unexpected", "Simulator input is invalid");
    }
    if (event.kind === "touch") {
      const x = requireCoord(event.x, "x");
      const y = requireCoord(event.y, "y");
      if (event.phase !== "down" && event.phase !== "move" && event.phase !== "up") {
        throw iosError("unexpected", "Simulator input is invalid");
      }
      if (typeof event.pointerId !== "number" || !Number.isFinite(event.pointerId)) {
        throw iosError("unexpected", "Simulator input is invalid");
      }
      return mutate(async () => {
        await withHelper(threadId, generation, async (session) => {
          await helperRpcWithSession(session, "touch", {
            phase: event.phase,
            x,
            y,
            pointerId: event.pointerId,
          });
        });
        await touchLeaseActivityBestEffort();
        return Object.freeze({ ok: true });
      });
    }
    if (event.kind === "text") {
      return typeText({ threadId, generation, text: event.text });
    }
    if (event.kind === "key") {
      const usage = SIMULATOR_KEY_USAGE[event.key];
      if (usage == null) {
        throw iosError("unexpected", "Simulator key is invalid");
      }
      if (event.phase !== "down" && event.phase !== "up") {
        throw iosError("unexpected", "Simulator input is invalid");
      }
      return mutate(async () => {
        await withHelper(threadId, generation, async (session) => {
          await helperRpcWithSession(session, "key", {
            usage,
            down: event.phase === "down",
            modifiers: 0,
          });
        });
        await touchLeaseActivityBestEffort();
        return Object.freeze({ ok: true });
      });
    }
    if (event.kind === "button") {
      return pressButton({ threadId, generation, button: event.button });
    }
    throw iosError("unexpected", "Simulator input is invalid");
  }

  async function accessibility(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const maxDepth = input && input.maxDepth;
    return mutate(async () => {
      const result = await withHelper(threadId, generation, async (session) => {
        return helperRpcWithSession(session, "accessibility", {
          maxDepth: maxDepth == null ? 8 : maxDepth,
        });
      });
      await touchLeaseActivityBestEffort();
      return result;
    });
  }

  async function scrollTo(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const x = requireCoord(input && input.x, "x");
    const y = requireCoord(input && input.y, "y");
    const dx = input && input.dx != null ? requireCoord(input.dx, "dx") : 0;
    const dy = input && input.dy != null ? requireCoord(input.dy, "dy") : 0;
    return mutate(async () => {
      await withHelper(threadId, generation, async (session) => {
        await helperRpcWithSession(session, "scrollTo", { x, y, dx, dy });
      });
      await touchLeaseActivityBestEffort();
      return Object.freeze({ ok: true });
    });
  }

  return {
    getCapabilities,
    selectDeveloperDirectory,
    listDevices,
    discoverToolchains,
    fingerprintToolchain,
    ensureHelper,
    prepareAppBundle,
    getStatus,
    attach,
    takeover,
    boot,
    detach,
    install,
    launch,
    openUrl,
    captureScreenshot,
    startRecording,
    stopRecording,
    streamInfo,
    retryStream,
    sendInput,
    tap,
    swipe,
    typeText,
    pressButton,
    accessibility,
    scrollTo,
    recover,
    releaseThread,
    releaseProject,
    onRunTerminal,
    shutdown,
  };
}

module.exports = {
  IOSSimulatorError,
  createIOSSimulatorService,
  parseXcodeVersion,
  parseSimulatorList,
  capabilitySnapshot,
  parseLaunchPid,
};
