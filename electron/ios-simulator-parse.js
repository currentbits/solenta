"use strict";

// Module-level parsers, validators and the error type of the iOS Simulator
// service (#1447, pass V). Pure: no factory state, no I/O beyond what a caller
// passes in. ios-simulator.js and its `ios-simulator-<seam>.js` modules
// require this file; it requires neither of them.

const path = require("node:path");

const IOS_RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.iOS-";
const XCODE_VERSION_RE = /^\d+(?:\.\d+){0,2}$/;
const XCODE_BUILD_RE = /^[A-Za-z0-9]{1,32}$/;
const BUNDLE_ID_RE =
  /^(?=.{1,255}$)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const MAX_SIMULATOR_URL_LENGTH = 2048;
const BLOCKED_URL_SCHEMES = new Set(["file:", "javascript:", "data:", "about:"]);
const ASCII_CONTROL_RE = /[\x00-\x1f\x7f]/;

const LICENSE_HINT_RE =
  /license|first[- ]?launch|agreement|checkfirstlaunchstatus/i;

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

module.exports = {
  BUNDLE_ID_RE,
  IOSSimulatorError,
  iosError,
  remapToolchainError,
  parseXcodeVersion,
  parseSimulatorList,
  capabilitySnapshot,
  adapterFailureText,
  runActiveDeveloperDir,
  runXcodeVersion,
  runFirstLaunchStatus,
  runFindSimctl,
  runListDevices,
  validateUserDataPath,
  validateCandidateDeveloperDir,
  validatePersistedDeveloperDir,
  isWithin,
  invalidAppPath,
  invalidBundle,
  leaseStale,
  validateSimulatorUrl,
  parseLaunchPid,
  helperSpawnArgs,
  helperArgumentTail,
  isTrustedHelperPrefix,
  parseLeaseJournal,
  validateRelativeAppPath,
};
