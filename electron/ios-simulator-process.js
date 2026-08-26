"use strict";

const childProcess = require("node:child_process");
const proc = require("./proc.js");

const SHORT = { timeout: 10_000, maxBuffer: 256 * 1024 };
const NORMAL = { timeout: 30_000, maxBuffer: 256 * 1024 };
const LONG = { timeout: 120_000, maxBuffer: 256 * 1024 };
const PROCESS = { timeout: 5_000, maxBuffer: 1024 * 1024 };

/**
 * @param {typeof childProcess.execFile} execFile
 * @param {string} file
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileOptions} options
 * @returns {Promise<string>}
 */
function execFilePromise(execFile, file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        if (stdout !== undefined) err.stdout = stdout;
        if (stderr !== undefined) err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * @typedef {{ code: number | null, signal: NodeJS.Signals | null }} RecordingClose
 * @typedef {{ pid: number | undefined, closed: Promise<RecordingClose>, interrupt: () => void }} RecordingHandle
 */

const RECORD_VIDEO_EXECUTABLE = "/usr/bin/xcrun";

/**
 * The one place the recorder argv is spelled out. Recovery rebuilds the exact
 * command line from this so it can only ever signal a process whose `ps`
 * command matches the recorder Solenta spawned, byte for byte.
 *
 * @param {string} udid
 * @param {string} output
 * @returns {string[]}
 */
function recordVideoArgs(udid, output) {
  return ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", output];
}

/**
 * @param {string} udid
 * @param {string} output
 * @returns {string}
 */
function recordingCommandLine(udid, output) {
  return [RECORD_VIDEO_EXECUTABLE, ...recordVideoArgs(udid, output)].join(" ");
}

/**
 * Everything after the `simctl` executable. `ps` reports the recorder under
 * several executables depending on how `xcrun` resolved it, but the argument
 * tail is always this, which is what recovery matches against.
 *
 * @param {string} udid
 * @param {string} output
 * @returns {string}
 */
function recordingArgumentTail(udid, output) {
  return recordVideoArgs(udid, output).slice(1).join(" ");
}

/**
 * @param {typeof childProcess.spawn} spawn
 * @param {typeof proc.signalGroup} signalGroup
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {string | undefined} developerDir
 * @param {string} udid
 * @param {string} output
 * @returns {RecordingHandle}
 */
function spawnRecording(
  spawn,
  signalGroup,
  baseEnv,
  developerDir,
  udid,
  output,
) {
  const env = { ...baseEnv };
  if (developerDir) env.DEVELOPER_DIR = developerDir;
  const child = spawn(
    RECORD_VIDEO_EXECUTABLE,
    recordVideoArgs(udid, output),
    {
      shell: false,
      detached: true,
      stdio: "ignore",
      env,
      windowsHide: true,
    },
  );
  const pid = child.pid;
  let settled = false;
  /** @type {(value: RecordingClose) => void} */
  let resolveClosed;
  /** @type {(reason: Error) => void} */
  let rejectClosed;
  const closed = new Promise((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const settleOnce = (fn) => {
    if (settled) return;
    settled = true;
    fn();
  };
  child.on("error", (err) => {
    settleOnce(() => rejectClosed(err));
  });
  child.on("close", (code, signal) => {
    settleOnce(() => resolveClosed({ code, signal }));
  });
  // Do not child.unref(): shutdown and recording finalization own this process
  // and await closed before releasing the lease or exiting the app.
  return Object.freeze({
    pid,
    closed,
    interrupt() {
      signalGroup(child, "SIGINT");
    },
  });
}

/**
 * @param {object} [deps]
 * @param {typeof childProcess.execFile} [deps.execFile]
 * @param {typeof childProcess.spawn} [deps.spawn]
 * @param {NodeJS.ProcessEnv} [deps.baseEnv]
 * @param {typeof proc.signalGroup} [deps.signalGroup]
 */
function createIOSSimulatorProcess({
  execFile = childProcess.execFile,
  spawn = childProcess.spawn,
  baseEnv = process.env,
  signalGroup = proc.signalGroup,
} = {}) {
  const run = (file, args, developerDir, limits) => {
    const env = { ...baseEnv };
    if (developerDir) env.DEVELOPER_DIR = developerDir;
    return execFilePromise(execFile, file, args, {
      shell: false,
      timeout: limits.timeout,
      maxBuffer: limits.maxBuffer,
      env,
      windowsHide: true,
    });
  };

  return {
    activeDeveloperDir: () =>
      run("/usr/bin/xcode-select", ["-p"], undefined, SHORT),
    xcodeVersion: (developerDir) =>
      run("/usr/bin/xcodebuild", ["-version"], developerDir, SHORT),
    firstLaunchStatus: (developerDir) =>
      run(
        "/usr/bin/xcodebuild",
        ["-checkFirstLaunchStatus"],
        developerDir,
        SHORT,
      ),
    findSimctl: (developerDir) =>
      run("/usr/bin/xcrun", ["--find", "simctl"], developerDir, SHORT),
    listDevices: (developerDir) =>
      run("/usr/bin/xcrun", ["simctl", "list", "--json"], developerDir, SHORT),
    boot: (developerDir, udid) =>
      run("/usr/bin/xcrun", ["simctl", "boot", udid], developerDir, NORMAL),
    bootStatus: (developerDir, udid) =>
      run(
        "/usr/bin/xcrun",
        ["simctl", "bootstatus", udid, "-b"],
        developerDir,
        LONG,
      ),
    shutdown: (developerDir, udid) =>
      run("/usr/bin/xcrun", ["simctl", "shutdown", udid], developerDir, NORMAL),
    install: (developerDir, udid, appPath) =>
      run(
        "/usr/bin/xcrun",
        ["simctl", "install", udid, appPath],
        developerDir,
        LONG,
      ),
    launch: (developerDir, udid, bundleId) =>
      run(
        "/usr/bin/xcrun",
        ["simctl", "launch", udid, bundleId],
        developerDir,
        NORMAL,
      ),
    openUrl: (developerDir, udid, url) =>
      run(
        "/usr/bin/xcrun",
        ["simctl", "openurl", udid, url],
        developerDir,
        NORMAL,
      ),
    screenshot: (developerDir, udid, output) =>
      run(
        "/usr/bin/xcrun",
        ["simctl", "io", udid, "screenshot", output],
        developerDir,
        NORMAL,
      ),
    readBundleId: (developerDir, infoPlist) =>
      run(
        "/usr/bin/plutil",
        ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist],
        developerDir,
        SHORT,
      ),
    recordVideo: (developerDir, udid, output) =>
      spawnRecording(spawn, signalGroup, baseEnv, developerDir, udid, output),
    inspectProcess: (pid) =>
      run("/bin/ps", ["-p", String(pid), "-o", "command="], undefined, PROCESS),
  };
}

module.exports = {
  createIOSSimulatorProcess,
  recordingCommandLine,
  recordingArgumentTail,
};
