"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const proc = require("./proc.js");

const HELPER_NAME = "SolentaSimulatorHelper";
const CACHE_DIR_NAME = "ios-simulator-helper";
const DIGEST_PREFIX = "solenta-ios-helper\0";
const SHORT = { timeout: 10_000, maxBuffer: 256 * 1024 };
const BUILD_TIMEOUT_MS = 120_000;
const BUILD_MAX_BUFFER = 1024 * 1024;
const XCODE_VERSION_RE = /^\d+(?:\.\d+){0,2}$/;
const XCODE_BUILD_RE = /^[A-Za-z0-9]{1,32}$/;

class IOSSimulatorToolchainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "IOSSimulatorError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function toolchainError(code, message, details) {
  return new IOSSimulatorToolchainError(code, message, details);
}

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
    throw toolchainError("xcode_missing", "Xcode version information is invalid");
  }
  if (!build || !XCODE_BUILD_RE.test(build)) {
    throw toolchainError("xcode_missing", "Xcode version information is invalid");
  }
  return { version, build };
}

function normalizeRelativePath(relativePath) {
  return String(relativePath).split(path.sep).join("/");
}

/**
 * @param {object} deps
 * @param {string} deps.userDataPath
 * @param {string} [deps.sourceRoot]
 * @param {NodeJS.Platform} [deps.platform]
 * @param {typeof fs} [deps.fsApi]
 * @param {typeof childProcess.execFile} [deps.execFile]
 * @param {typeof childProcess.spawn} [deps.spawn]
 * @param {typeof proc.signalGroup} [deps.signalGroup]
 * @param {NodeJS.ProcessEnv} [deps.baseEnv]
 * @param {() => string} [deps.randomUUID]
 * @param {string} [deps.arch]
 * @param {typeof setTimeout} [deps.setTimer]
 * @param {typeof clearTimeout} [deps.clearTimer]
 */
function createIOSSimulatorToolchain({
  userDataPath,
  sourceRoot = path.join(__dirname, "../native/ios-simulator-helper"),
  platform = process.platform,
  fsApi = fs,
  execFile = childProcess.execFile,
  spawn = childProcess.spawn,
  signalGroup = proc.signalGroup,
  baseEnv = process.env,
  randomUUID = crypto.randomUUID,
  arch = process.arch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof userDataPath !== "string" || !userDataPath) {
    throw toolchainError("unexpected", "Simulator user data path is invalid");
  }

  const cacheRoot = path.join(userDataPath, "native-cache", CACHE_DIR_NAME);
  /** @type {Map<string, Promise<string>>} */
  const inFlightBuilds = new Map();

  function assertDarwin() {
    if (platform !== "darwin") {
      throw toolchainError(
        "unsupported_platform",
        "iOS Simulator requires macOS",
      );
    }
  }

  function runProbe(file, args, developerDir) {
    const env = { ...baseEnv, DEVELOPER_DIR: developerDir };
    return execFilePromise(execFile, file, args, {
      shell: false,
      timeout: SHORT.timeout,
      maxBuffer: SHORT.maxBuffer,
      env,
      windowsHide: true,
    }).catch(() => {
      throw toolchainError(
        "xcode_missing",
        "Full Xcode with Simulator is required",
      );
    });
  }

  async function discoverToolchains(developerDir) {
    assertDarwin();
    const dir = String(developerDir || "").trim();
    if (!dir) {
      throw toolchainError(
        "xcode_missing",
        "Full Xcode with Simulator is required",
      );
    }
    const versionText = String(
      await runProbe("/usr/bin/xcodebuild", ["-version"], dir),
    );
    const { version: xcodeVersion, build: xcodeBuild } =
      parseXcodeVersion(versionText);
    const sdkPath = String(
      await runProbe(
        "/usr/bin/xcrun",
        ["--sdk", "iphonesimulator", "--show-sdk-path"],
        dir,
      ),
    ).trim();
    const swiftVersion = String(
      await runProbe("/usr/bin/xcrun", ["swift", "--version"], dir),
    ).trim();
    const clangVersion = String(
      await runProbe("/usr/bin/xcrun", ["clang", "--version"], dir),
    ).trim();
    if (!sdkPath || !swiftVersion || !clangVersion) {
      throw toolchainError(
        "xcode_missing",
        "Xcode version information is invalid",
      );
    }
    return {
      developerDir: dir,
      xcodeVersion,
      xcodeBuild,
      sdkPath,
      swiftVersion,
      clangVersion,
    };
  }

  async function listSourceFiles(root) {
    /** @type {{ relativePath: string, absolutePath: string }[]} */
    const files = [];
    async function walk(dir, relBase) {
      let names;
      try {
        names = await fsApi.promises.readdir(dir);
      } catch (err) {
        if (err && err.code === "ENOENT") return;
        throw err;
      }
      names.sort();
      for (const name of names) {
        const abs = path.join(dir, name);
        const rel = relBase ? `${relBase}/${name}` : name;
        let st;
        try {
          st = await fsApi.promises.lstat(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (name === ".build") continue;
          await walk(abs, rel);
        } else if (st.isFile()) {
          files.push({
            relativePath: normalizeRelativePath(rel),
            absolutePath: abs,
          });
        }
      }
    }
    await walk(root, "");
    files.sort((a, b) =>
      a.relativePath < b.relativePath
        ? -1
        : a.relativePath > b.relativePath
          ? 1
          : 0,
    );
    return files;
  }

  async function readProtocolVersion(root) {
    try {
      const raw = await fsApi.promises.readFile(
        path.join(root, "protocol.json"),
        "utf8",
      );
      const parsed = JSON.parse(raw);
      return parsed && parsed.version !== undefined ? parsed.version : "";
    } catch {
      return "";
    }
  }

  async function digestSources(toolchain) {
    const hash = crypto.createHash("sha256");
    hash.update(DIGEST_PREFIX);
    const sourceFiles = await listSourceFiles(sourceRoot);
    for (const file of sourceFiles) {
      hash.update(file.relativePath);
      hash.update("\0");
      hash.update(await fsApi.promises.readFile(file.absolutePath));
      hash.update("\0");
    }
    const protocolVersion = await readProtocolVersion(sourceRoot);
    for (const value of [
      protocolVersion,
      toolchain.xcodeVersion,
      toolchain.xcodeBuild,
      toolchain.sdkPath,
      arch,
      toolchain.swiftVersion,
      toolchain.clangVersion,
    ]) {
      hash.update(String(value));
      hash.update("\0");
    }
    return hash.digest("hex");
  }

  async function fingerprintToolchain(developerDir) {
    assertDarwin();
    const toolchain = await discoverToolchains(developerDir);
    return digestSources(toolchain);
  }

  function helperPathForDigest(digest) {
    return path.join(cacheRoot, digest, HELPER_NAME);
  }

  async function isRegularExecutable(filePath) {
    try {
      const st = await fsApi.promises.lstat(filePath);
      if (!st.isFile() || st.isSymbolicLink()) return false;
      return (st.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  }

  async function removePathBestEffort(target) {
    try {
      await fsApi.promises.rm(target, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  function runSwiftBuild({ developerDir, scratchPath, buildTemp }) {
    const env = { ...baseEnv, DEVELOPER_DIR: developerDir };
    const args = [
      "swift",
      "build",
      "--package-path",
      sourceRoot,
      "--configuration",
      "release",
      "--scratch-path",
      scratchPath,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/xcrun", args, {
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        windowsHide: true,
      });

      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      let timedOut = false;
      let stdoutOverflow = false;
      let stderrOverflow = false;

      const settle = (fn) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        fn();
      };

      const timer = setTimer(() => {
        timedOut = true;
        signalGroup(child, "SIGKILL");
        settle(() => {
          reject(
            toolchainError("timeout", "Simulator helper build timed out"),
          );
        });
      }, BUILD_TIMEOUT_MS);

      const onChunk = (streamName) => (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (streamName === "stdout") {
          if (stdout.length + buf.length > BUILD_MAX_BUFFER) {
            stdoutOverflow = true;
            signalGroup(child, "SIGKILL");
            return;
          }
          stdout = Buffer.concat([stdout, buf]);
        } else {
          if (stderr.length + buf.length > BUILD_MAX_BUFFER) {
            stderrOverflow = true;
            signalGroup(child, "SIGKILL");
            return;
          }
          stderr = Buffer.concat([stderr, buf]);
        }
      };

      if (child.stdout) child.stdout.on("data", onChunk("stdout"));
      if (child.stderr) child.stderr.on("data", onChunk("stderr"));

      child.on("error", () => {
        settle(() => {
          reject(
            toolchainError(
              "helper_compile_failed",
              "Simulator helper build failed",
            ),
          );
        });
      });

      child.on("close", (code) => {
        settle(() => {
          if (timedOut) {
            reject(
              toolchainError("timeout", "Simulator helper build timed out"),
            );
            return;
          }
          if (stdoutOverflow || stderrOverflow || code !== 0) {
            reject(
              toolchainError(
                "helper_compile_failed",
                "Simulator helper build failed",
              ),
            );
            return;
          }
          resolve({ stdout, stderr, buildTemp, scratchPath });
        });
      });
    });
  }

  async function findBuiltHelper(scratchPath) {
    const candidates = [
      path.join(scratchPath, "release", HELPER_NAME),
      path.join(scratchPath, `${arch}-apple-macosx`, "release", HELPER_NAME),
    ];
    for (const candidate of candidates) {
      if (await isRegularExecutable(candidate)) return candidate;
    }
    // Fall back to a shallow search under scratch for the product name.
    async function search(dir, depth) {
      if (depth > 6) return null;
      let names;
      try {
        names = await fsApi.promises.readdir(dir);
      } catch {
        return null;
      }
      for (const name of names) {
        const abs = path.join(dir, name);
        let st;
        try {
          st = await fsApi.promises.lstat(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          const found = await search(abs, depth + 1);
          if (found) return found;
        } else if (name === HELPER_NAME && (await isRegularExecutable(abs))) {
          return abs;
        }
      }
      return null;
    }
    return search(scratchPath, 0);
  }

  async function installHelperFromBuild(builtPath, digest) {
    const stagingDir = path.join(cacheRoot, `.staging-${randomUUID()}`);
    const finalDir = path.join(cacheRoot, digest);
    const stagingHelper = path.join(stagingDir, HELPER_NAME);
    try {
      await fsApi.promises.mkdir(cacheRoot, { recursive: true });
      await fsApi.promises.mkdir(stagingDir, { recursive: true });
      await fsApi.promises.copyFile(builtPath, stagingHelper);
      await fsApi.promises.chmod(stagingHelper, 0o755);
      if (!(await isRegularExecutable(stagingHelper))) {
        throw toolchainError(
          "helper_compile_failed",
          "Simulator helper build failed",
        );
      }
      await removePathBestEffort(finalDir);
      await fsApi.promises.rename(stagingDir, finalDir);
      return path.join(finalDir, HELPER_NAME);
    } catch (err) {
      await removePathBestEffort(stagingDir);
      throw err;
    }
  }

  async function buildHelper(developerDir, digest) {
    const buildId = randomUUID();
    const buildTemp = path.join(cacheRoot, `.build-${buildId}`);
    const scratchPath = path.join(buildTemp, "scratch");
    try {
      await fsApi.promises.mkdir(scratchPath, { recursive: true });
      await runSwiftBuild({ developerDir, scratchPath, buildTemp });
      const builtPath = await findBuiltHelper(scratchPath);
      if (!builtPath) {
        throw toolchainError(
          "helper_compile_failed",
          "Simulator helper build failed",
        );
      }
      const helperPath = await installHelperFromBuild(builtPath, digest);
      await removePathBestEffort(buildTemp);
      return helperPath;
    } catch (err) {
      await removePathBestEffort(buildTemp);
      if (err instanceof IOSSimulatorToolchainError) throw err;
      if (err && (err.code === "ETIMEDOUT" || err.killed)) {
        throw toolchainError("timeout", "Simulator helper build timed out");
      }
      throw toolchainError(
        "helper_compile_failed",
        "Simulator helper build failed",
      );
    }
  }

  async function ensureHelper(developerDir) {
    assertDarwin();
    const dir = String(developerDir || "").trim();
    const existing = inFlightBuilds.get(dir);
    if (existing) return existing;

    const pending = (async () => {
      const digest = await fingerprintToolchain(dir);
      const cached = helperPathForDigest(digest);
      if (await isRegularExecutable(cached)) {
        return cached;
      }
      return buildHelper(dir, digest);
    })().finally(() => {
      inFlightBuilds.delete(dir);
    });
    inFlightBuilds.set(dir, pending);
    return pending;
  }

  return {
    discoverToolchains,
    fingerprintToolchain,
    ensureHelper,
  };
}

module.exports = {
  createIOSSimulatorToolchain,
  HELPER_NAME,
};
