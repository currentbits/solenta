"use strict";

// createIOSSimulatorService seam: crash-recovery helpers that `recover()`
// drives — staged temp path checks, recorder/helper process matching and
// signalling, device shutdown, journal quarantine (#1447 pass V2, seam 4).
// `recover()` itself stays in ios-simulator.js: it reads and writes `lease`,
// `recording` and `lastGeneration`. Convention: see the header of
// electron/runner-watchdogs.js; plan:
// docs/superpowers/specs/2026-10-05-ios-simulator-split.md.

const path = require("node:path");
const { recordingArgumentTail } = require("./ios-simulator-process.js");
const {
  adapterFailureText,
  helperArgumentTail,
  isTrustedHelperPrefix,
} = require("./ios-simulator-parse.js");

const RECOVERY_SIGNAL_GRACE_MS = 2_000;

// simctl reports an absent or already-shut-down device through these phrases.
// Recovery inherited from a failed boot intent must tolerate them instead of
// wedging the journal forever.
const DEVICE_ALREADY_OFF_RE =
  /current state:\s*Shutdown|already shut ?down|not booted|no devices are booted|invalid device|device not found/i;

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

/**
 * @param {object} ctx - createIOSSimulatorService context
 */
function createRecovery(ctx) {
  const {
    fsApi,
    stagingRoot,
    processAdapter,
    sandboxProfilePath,
    signalPid,
    delay,
    selectedDeveloperDirectory,
    quarantineJournal,
    writeJournal,
    recoverySummary,
  } = ctx;

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

  return {
    resolveRecoveryTempPath,
    stopRecoveredHelperProcess,
    stopRecoveredRecordingProcess,
    removeRecoveredTempFile,
    trustedRecoveryDeveloperDir,
    shutdownRecoveredDevice,
    quarantineSummary,
    retainJournalWithoutRecording,
  };
}

module.exports = { createRecovery };
