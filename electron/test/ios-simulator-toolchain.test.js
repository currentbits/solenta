"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");

const HELPER_NAME = "SolentaSimulatorHelper";
const DEV_DIR = "/Applications/Xcode.app/Contents/Developer";
const SHORT = { timeout: 10_000, maxBuffer: 256 * 1024 };

async function waitFor(predicate, label = "condition") {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const XCODE_VERSION_OUT = "Xcode 26.0\nBuild version 17A123\n";
const SDK_PATH_OUT = "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator.sdk\n";
const SWIFT_VERSION_OUT =
  "Apple Swift version 6.0 (swiftlang-6.0.0.1 clang-1600.0.1)\nTarget: arm64-apple-macosx14.0\n";
const CLANG_VERSION_OUT =
  "Apple clang version 16.0.0 (clang-1600.0.1)\nTarget: arm64-apple-macosx14.0\n";

/** @type {string[]} */
let tmpDirs = [];

function trackTmpDir(dir) {
  tmpDirs.push(dir);
  return dir;
}

function makeUserDataPath() {
  return trackTmpDir(
    fs.mkdtempSync(path.join(os.tmpdir(), "ios-helper-cache-")),
  );
}

function makeSourceRoot(files = {}) {
  const root = trackTmpDir(
    fs.mkdtempSync(path.join(os.tmpdir(), "ios-helper-src-")),
  );
  const defaults = {
    "protocol.json": `${JSON.stringify({
      version: 1,
      maxControlBytes: 65536,
      maxVideoBytes: 4194304,
      dropViewerBytes: 8388608,
      recoverViewerBytes: 2097152,
      videoMagic: "SLV1",
    })}\n`,
    "Package.swift": "// swift-tools-version: 6.0\n",
    "Resources/helper.sb": "(version 1)\n(deny default)\n",
    "Sources/SolentaSimulatorHelper/main.swift": "print(\"hi\")\n",
  };
  const all = { ...defaults, ...files };
  for (const [rel, body] of Object.entries(all)) {
    if (body === null) continue;
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  for (const [rel, body] of Object.entries(files)) {
    if (body !== null) continue;
    const abs = path.join(root, rel);
    fs.rmSync(abs, { force: true });
  }
  return root;
}

function assertOptions(overrides) {
  return { windowsHide: true, ...overrides };
}

function defaultProbeStdout(file, args) {
  if (file === "/usr/bin/xcodebuild" && args[0] === "-version") {
    return XCODE_VERSION_OUT;
  }
  if (
    file === "/usr/bin/xcrun" &&
    args[0] === "--sdk" &&
    args[1] === "iphonesimulator" &&
    args[2] === "--show-sdk-path"
  ) {
    return SDK_PATH_OUT;
  }
  if (file === "/usr/bin/xcrun" && args[0] === "swift" && args[1] === "--version") {
    return SWIFT_VERSION_OUT;
  }
  if (file === "/usr/bin/xcrun" && args[0] === "clang" && args[1] === "--version") {
    return CLANG_VERSION_OUT;
  }
  return "";
}

function makeExecFile(overrides = {}) {
  /** @type {Array<{ file: string, args: string[], options: object }>} */
  const calls = [];
  const execFile = (file, args, options, cb) => {
    calls.push({ file, args, options });
    if (overrides.handler) {
      return overrides.handler(file, args, options, cb, calls);
    }
    const err = overrides.errorFor?.(file, args, calls) || null;
    const stdout = overrides.stdoutFor
      ? overrides.stdoutFor(file, args, calls)
      : defaultProbeStdout(file, args);
    const stderr = overrides.stderrFor?.(file, args, calls) || "";
    queueMicrotask(() => cb(err, stdout, stderr));
  };
  return { execFile, calls };
}

function makeSpawn(overrides = {}) {
  /** @type {Array<{ file: string, args: string[], options: object, child: import("node:events").EventEmitter & { pid?: number, kill?: Function } }>} */
  const spawns = [];
  /** @type {Array<[string]>} */
  const signals = [];

  const signalGroup = (child, sig) => {
    signals.push([sig]);
    if (overrides.onSignal) overrides.onSignal(child, sig);
  };

  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = overrides.pid ?? 4242;
    child.kill = () => {};
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawns.push({ file, args, options, child });

    const finish = () => {
      if (overrides.writeHelper !== false) {
        const scratchIdx = args.indexOf("--scratch-path");
        const scratch = scratchIdx >= 0 ? args[scratchIdx + 1] : null;
        if (scratch) {
          const outDir = path.join(scratch, "release");
          fs.mkdirSync(outDir, { recursive: true });
          const exe = path.join(outDir, HELPER_NAME);
          fs.writeFileSync(exe, overrides.helperBytes ?? Buffer.from("MZ-helper"));
          fs.chmodSync(exe, 0o755);
        }
      }
      if (overrides.hang) return;
      queueMicrotask(() => {
        if (overrides.fail) {
          child.emit("close", 1, null);
        } else {
          child.emit("close", 0, null);
        }
      });
    };

    if (overrides.deferFinish) {
      child._testFinish = finish;
    } else {
      finish();
    }
    return child;
  };

  return { spawn, signalGroup, spawns, signals };
}

function expectedProbeCalls(devDir, baseEnv = { PATH: "/usr/bin" }) {
  const env = { ...baseEnv, DEVELOPER_DIR: devDir };
  return [
    {
      file: "/usr/bin/xcodebuild",
      args: ["-version"],
      options: assertOptions({ shell: false, ...SHORT, env }),
    },
    {
      file: "/usr/bin/xcrun",
      args: ["--sdk", "iphonesimulator", "--show-sdk-path"],
      options: assertOptions({ shell: false, ...SHORT, env }),
    },
    {
      file: "/usr/bin/xcrun",
      args: ["swift", "--version"],
      options: assertOptions({ shell: false, ...SHORT, env }),
    },
    {
      file: "/usr/bin/xcrun",
      args: ["clang", "--version"],
      options: assertOptions({ shell: false, ...SHORT, env }),
    },
  ];
}

function computeDigest({
  sourceRoot,
  protocolVersion,
  xcodeVersion,
  xcodeBuild,
  sdkPath,
  arch,
  swiftVersion,
  clangVersion,
}) {
  const hash = crypto.createHash("sha256");
  hash.update("solenta-ios-helper\0");
  /** @type {{ relativePath: string, absolutePath: string }[]} */
  const files = [];
  function walk(dir, relBase) {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) {
        if (name === ".build") continue;
        walk(abs, rel);
      } else if (st.isFile()) {
        files.push({ relativePath: rel.split(path.sep).join("/"), absolutePath: abs });
      }
    }
  }
  walk(sourceRoot, "");
  files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(file.absolutePath));
    hash.update("\0");
  }
  for (const value of [
    protocolVersion,
    xcodeVersion,
    xcodeBuild,
    sdkPath,
    arch,
    swiftVersion,
    clangVersion,
  ]) {
    hash.update(String(value));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function createToolchain(deps = {}) {
  const { createIOSSimulatorToolchain } = require("../ios-simulator-toolchain.js");
  const userDataPath = deps.userDataPath ?? makeUserDataPath();
  const sourceRoot = deps.sourceRoot ?? makeSourceRoot();
  const { execFile, calls } = makeExecFile(deps.execOverrides ?? {});
  const { spawn, signalGroup, spawns, signals } = makeSpawn(deps.spawnOverrides ?? {});
  /** @type {ReturnType<typeof setTimeout>[]} */
  const timers = [];
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    timers.push(t);
    return t;
  });
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  const toolchain = createIOSSimulatorToolchain({
    userDataPath,
    sourceRoot,
    platform: deps.platform ?? "darwin",
    fsApi: deps.fsApi ?? fs,
    execFile: deps.execFile ?? execFile,
    spawn: deps.spawn ?? spawn,
    signalGroup: deps.signalGroup ?? signalGroup,
    baseEnv: deps.baseEnv ?? { PATH: "/usr/bin" },
    randomUUID: deps.randomUUID ?? (() => "build-uuid"),
    arch: deps.arch ?? "arm64",
    setTimer,
    clearTimer,
    now: deps.now,
  });
  return {
    toolchain,
    userDataPath,
    sourceRoot,
    calls,
    spawns,
    signals,
    timers,
  };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("createIOSSimulatorToolchain probes", () => {
  it("runs zero subprocesses off macOS", async () => {
    const { toolchain, calls, spawns } = createToolchain({ platform: "linux" });
    await assert.rejects(
      () => toolchain.discoverToolchains(DEV_DIR),
      (err) => {
        assert.equal(err.code, "unsupported_platform");
        return true;
      },
    );
    await assert.rejects(
      () => toolchain.fingerprintToolchain(DEV_DIR),
      (err) => err.code === "unsupported_platform",
    );
    await assert.rejects(
      () => toolchain.ensureHelper(DEV_DIR),
      (err) => err.code === "unsupported_platform",
    );
    assert.equal(calls.length, 0);
    assert.equal(spawns.length, 0);
  });

  it("uses exact xcodebuild/SDK/swift/clang probe argv and DEVELOPER_DIR", async () => {
    const { toolchain, calls } = createToolchain();
    const info = await toolchain.discoverToolchains(DEV_DIR);
    assert.deepEqual(calls, expectedProbeCalls(DEV_DIR));
    assert.deepEqual(info, {
      developerDir: DEV_DIR,
      xcodeVersion: "26.0",
      xcodeBuild: "17A123",
      sdkPath: SDK_PATH_OUT.trim(),
      swiftVersion: SWIFT_VERSION_OUT.trim(),
      clangVersion: CLANG_VERSION_OUT.trim(),
    });
  });

  it("maps probe exec and parse failures to xcode_missing without leaking raw messages", async () => {
    const enoent = Object.assign(new Error("spawn /usr/bin/xcodebuild ENOENT"), {
      code: "ENOENT",
      path: "/usr/bin/xcodebuild",
    });
    const { toolchain: missing } = createToolchain({
      execOverrides: {
        errorFor: () => enoent,
      },
    });
    await assert.rejects(() => missing.discoverToolchains(DEV_DIR), (err) => {
      assert.equal(err.name, "IOSSimulatorError");
      assert.equal(err.code, "xcode_missing");
      assert.equal(err.message.includes("ENOENT"), false);
      assert.equal(err.message.includes("/usr/bin/xcodebuild"), false);
      assert.equal(err.message.includes("spawn"), false);
      return true;
    });

    const { toolchain: badVersion } = createToolchain({
      execOverrides: {
        stdoutFor: (file, args) => {
          if (file === "/usr/bin/xcodebuild" && args[0] === "-version") {
            return "not-an-xcode-version\n";
          }
          return defaultProbeStdout(file, args);
        },
      },
    });
    await assert.rejects(() => badVersion.discoverToolchains(DEV_DIR), (err) => {
      assert.equal(err.code, "xcode_missing");
      return true;
    });
  });
});

describe("createIOSSimulatorToolchain fingerprint", () => {
  it("changes digest when source, profile, protocol, Xcode, compilers, or arch change", async () => {
    const sourceRoot = makeSourceRoot();
    const { toolchain } = createToolchain({ sourceRoot, arch: "arm64" });
    const base = await toolchain.fingerprintToolchain(DEV_DIR);

    fs.writeFileSync(
      path.join(sourceRoot, "Sources/SolentaSimulatorHelper/main.swift"),
      "print(\"changed\")\n",
    );
    const afterSource = await toolchain.fingerprintToolchain(DEV_DIR);
    assert.notEqual(afterSource, base);

    fs.writeFileSync(
      path.join(sourceRoot, "Resources/helper.sb"),
      "(version 1)\n(deny default)\n(allow file-read*)\n",
    );
    const afterProfile = await toolchain.fingerprintToolchain(DEV_DIR);
    assert.notEqual(afterProfile, afterSource);

    fs.writeFileSync(
      path.join(sourceRoot, "protocol.json"),
      `${JSON.stringify({
        version: 2,
        maxControlBytes: 65536,
        maxVideoBytes: 4194304,
        dropViewerBytes: 8388608,
        recoverViewerBytes: 2097152,
        videoMagic: "SLV1",
      })}\n`,
    );
    const afterProtocol = await toolchain.fingerprintToolchain(DEV_DIR);
    assert.notEqual(afterProtocol, afterProfile);

    const { toolchain: xcodeChanged } = createToolchain({
      sourceRoot,
      arch: "arm64",
      execOverrides: {
        stdoutFor(file, args) {
          if (file === "/usr/bin/xcodebuild") {
            return "Xcode 26.1\nBuild version 17B100\n";
          }
          return defaultProbeStdout(file, args);
        },
      },
    });
    const afterXcode = await xcodeChanged.fingerprintToolchain(DEV_DIR);
    assert.notEqual(afterXcode, afterProtocol);

    const { toolchain: swiftChanged } = createToolchain({
      sourceRoot,
      arch: "arm64",
      execOverrides: {
        stdoutFor(file, args) {
          if (file === "/usr/bin/xcrun" && args[0] === "swift") {
            return "Apple Swift version 6.1\n";
          }
          return defaultProbeStdout(file, args);
        },
      },
    });
    const afterSwift = await swiftChanged.fingerprintToolchain(DEV_DIR);
    assert.notEqual(afterSwift, afterXcode);

    const { toolchain: clangChanged } = createToolchain({
      sourceRoot,
      arch: "arm64",
      execOverrides: {
        stdoutFor(file, args) {
          if (file === "/usr/bin/xcrun" && args[0] === "clang") {
            return "Apple clang version 17.0.0\n";
          }
          return defaultProbeStdout(file, args);
        },
      },
    });
    const afterClang = await clangChanged.fingerprintToolchain(DEV_DIR);
    assert.notEqual(afterClang, afterSwift);

    const { toolchain: archChanged } = createToolchain({
      sourceRoot,
      arch: "x64",
    });
    const afterArch = await archChanged.fingerprintToolchain(DEV_DIR);
    assert.notEqual(afterArch, afterClang);
  });

  it("path ordering does not alter digest", async () => {
    const sourceRoot = makeSourceRoot({
      "a.txt": "A\n",
      "b.txt": "B\n",
      "c/d.txt": "D\n",
    });
    const expected = computeDigest({
      sourceRoot,
      protocolVersion: 1,
      xcodeVersion: "26.0",
      xcodeBuild: "17A123",
      sdkPath: SDK_PATH_OUT.trim(),
      arch: "arm64",
      swiftVersion: SWIFT_VERSION_OUT.trim(),
      clangVersion: CLANG_VERSION_OUT.trim(),
    });
    const { toolchain } = createToolchain({ sourceRoot, arch: "arm64" });
    const digest = await toolchain.fingerprintToolchain(DEV_DIR);
    assert.equal(digest, expected);

    // Recreate with files written in a different order; digest must match.
    const sourceRoot2 = makeSourceRoot({
      "c/d.txt": "D\n",
      "b.txt": "B\n",
      "a.txt": "A\n",
    });
    const { toolchain: toolchain2 } = createToolchain({
      sourceRoot: sourceRoot2,
      arch: "arm64",
    });
    assert.equal(await toolchain2.fingerprintToolchain(DEV_DIR), expected);
  });
});

describe("createIOSSimulatorToolchain ensureHelper", () => {
  it("builds with exact swift build argv, env, timeout, and detached group", async () => {
    const sourceRoot = makeSourceRoot();
    const userDataPath = makeUserDataPath();
    const { toolchain, spawns, calls } = createToolchain({
      sourceRoot,
      userDataPath,
      randomUUID: () => "build-uuid",
      arch: "arm64",
    });
    const helperPath = await toolchain.ensureHelper(DEV_DIR);
    const digest = await toolchain.fingerprintToolchain(DEV_DIR);

    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].file, "/usr/bin/xcrun");
    const scratchPath =
      spawns[0].args[spawns[0].args.indexOf("--scratch-path") + 1];
    assert.deepEqual(spawns[0].args, [
      "swift",
      "build",
      "--package-path",
      sourceRoot,
      "--configuration",
      "release",
      "--scratch-path",
      scratchPath,
    ]);
    assert.equal(spawns[0].options.shell, false);
    assert.equal(spawns[0].options.detached, true);
    assert.equal(spawns[0].options.windowsHide, true);
    assert.equal(spawns[0].options.env.DEVELOPER_DIR, DEV_DIR);
    assert.equal(spawns[0].options.env.PATH, "/usr/bin");
    assert.match(scratchPath, /\.build-build-uuid/);
    assert.equal(calls.length >= 4, true);

    assert.equal(
      helperPath,
      path.join(
        userDataPath,
        "native-cache",
        "ios-simulator-helper",
        digest,
        HELPER_NAME,
      ),
    );
    const st = fs.lstatSync(helperPath);
    assert.equal(st.isFile(), true);
    assert.equal((st.mode & 0o111) !== 0, true);
    assert.equal(
      fs.existsSync(
        path.join(
          userDataPath,
          "native-cache",
          "ios-simulator-helper",
          ".build-build-uuid",
        ),
      ),
      false,
    );
  });

  it("cache hit validates regular executable and returns path without rebuilding", async () => {
    const sourceRoot = makeSourceRoot();
    const userDataPath = makeUserDataPath();
    let uuid = 0;
    const { toolchain, spawns } = createToolchain({
      sourceRoot,
      userDataPath,
      randomUUID: () => `build-${(uuid += 1)}`,
      arch: "arm64",
    });
    const first = await toolchain.ensureHelper(DEV_DIR);
    assert.equal(spawns.length, 1);
    const second = await toolchain.ensureHelper(DEV_DIR);
    assert.equal(second, first);
    assert.equal(spawns.length, 1);
    const st = fs.lstatSync(second);
    assert.equal(st.isFile(), true);
    assert.equal((st.mode & 0o111) !== 0, true);
  });

  it("concurrent callers share one in-flight build promise", async () => {
    const sourceRoot = makeSourceRoot();
    const userDataPath = makeUserDataPath();
    /** @type {Array<{ file: string, args: string[], cb: Function }>} */
    const deferredProbes = [];
    let releaseProbes = false;
    const { toolchain, spawns, calls } = createToolchain({
      sourceRoot,
      userDataPath,
      randomUUID: () => "shared-build",
      arch: "arm64",
      spawnOverrides: { deferFinish: true },
      execOverrides: {
        handler: (file, args, _options, cb) => {
          const finish = () => cb(null, defaultProbeStdout(file, args), "");
          if (releaseProbes) {
            queueMicrotask(finish);
          } else {
            deferredProbes.push({ file, args, cb: finish });
          }
        },
      },
    });
    const p1 = toolchain.ensureHelper(DEV_DIR);
    const p2 = toolchain.ensureHelper(DEV_DIR);
    await waitFor(() => deferredProbes.length >= 1, "first probe deferred");
    // Sharing must begin before fingerprint awaits finish; otherwise probes double.
    assert.equal(calls.length, 1);
    assert.equal(deferredProbes.length, 1);
    releaseProbes = true;
    while (deferredProbes.length > 0) {
      const batch = deferredProbes.splice(0, deferredProbes.length);
      for (const probe of batch) probe.cb();
      await Promise.resolve();
    }
    await waitFor(() => spawns.length === 1, "shared spawn");
    assert.equal(spawns.length, 1);
    assert.equal(calls.length, 4);
    spawns[0].child._testFinish();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a, b);
    assert.equal(spawns.length, 1);
    assert.equal(calls.length, 4);
  });

  it("failed build removes temp output and leaves no cache hit", async () => {
    const sourceRoot = makeSourceRoot();
    const userDataPath = makeUserDataPath();
    const { toolchain, spawns } = createToolchain({
      sourceRoot,
      userDataPath,
      randomUUID: () => "fail-build",
      arch: "arm64",
      spawnOverrides: { fail: true, writeHelper: false },
    });
    await assert.rejects(() => toolchain.ensureHelper(DEV_DIR), (err) => {
      assert.equal(err.name, "IOSSimulatorError");
      assert.equal(err.code, "helper_compile_failed");
      return true;
    });
    assert.equal(spawns.length, 1);
    const cacheRoot = path.join(
      userDataPath,
      "native-cache",
      "ios-simulator-helper",
    );
    assert.equal(fs.existsSync(path.join(cacheRoot, ".build-fail-build")), false);
    const entries = fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : [];
    assert.deepEqual(
      entries.filter((name) => !name.startsWith(".")),
      [],
    );
  });

  it("compiler timeout kills the process group via signalGroup", async () => {
    const sourceRoot = makeSourceRoot();
    const userDataPath = makeUserDataPath();
    /** @type {Function[]} */
    const pending = [];
    const { toolchain, spawns, signals } = createToolchain({
      sourceRoot,
      userDataPath,
      randomUUID: () => "timeout-build",
      arch: "arm64",
      spawnOverrides: { hang: true },
      setTimer: (fn) => {
        pending.push(fn);
        return 1;
      },
      clearTimer: () => {},
    });
    const pendingPromise = toolchain.ensureHelper(DEV_DIR);
    await waitFor(
      () => spawns.length === 1 && pending.length === 1,
      "build spawn and timeout timer",
    );
    assert.equal(typeof pending[0], "function");
    pending[0]();
    await assert.rejects(() => pendingPromise, (err) => {
      assert.equal(err.code, "timeout");
      return true;
    });
    assert.deepEqual(signals, [["SIGKILL"]]);
    assert.equal(
      fs.existsSync(
        path.join(
          userDataPath,
          "native-cache",
          "ios-simulator-helper",
          ".build-timeout-build",
        ),
      ),
      false,
    );
  });
});

describe("createIOSSimulatorService toolchain wiring", () => {
  it("rejects remote/non-darwin before toolchain work and uses selected developer dir", async () => {
    const {
      createIOSSimulatorService,
    } = require("../ios-simulator.js");

    const userDataPath = makeUserDataPath();
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(
      path.join(userDataPath, "ios-simulator-preferences.json"),
      `${JSON.stringify({ version: 1, developerDir: DEV_DIR })}\n`,
    );

    /** @type {string[]} */
    const seen = [];
    const fakeToolchain = {
      async discoverToolchains(developerDir) {
        seen.push(`discover:${developerDir}`);
        return { developerDir, xcodeVersion: "26.0" };
      },
      async fingerprintToolchain(developerDir) {
        seen.push(`fingerprint:${developerDir}`);
        return "abc";
      },
      async ensureHelper(developerDir) {
        seen.push(`ensure:${developerDir}`);
        return "/tmp/helper";
      },
    };

    const store = {
      getThread: () => ({ id: "t1", projectId: "p1" }),
      getProject: () => ({
        id: "p1",
        path: "/tmp/proj",
        remoteHost: null,
      }),
    };

    const service = createIOSSimulatorService({
      store,
      userDataPath,
      platform: "darwin",
      processAdapter: {
        activeDeveloperDir: async () => {
          throw new Error("should not probe active dir");
        },
      },
      toolchain: fakeToolchain,
    });

    await service.discoverToolchains({ threadId: "t1" });
    await service.fingerprintToolchain({ threadId: "t1" });
    await service.ensureHelper({ threadId: "t1" });
    assert.deepEqual(seen, [
      `discover:${DEV_DIR}`,
      `fingerprint:${DEV_DIR}`,
      `ensure:${DEV_DIR}`,
    ]);

    const remoteService = createIOSSimulatorService({
      store: {
        getThread: () => ({ id: "t1", projectId: "p1" }),
        getProject: () => ({
          id: "p1",
          path: "/tmp/proj",
          remoteHost: "dev@box",
        }),
      },
      userDataPath,
      platform: "darwin",
      toolchain: fakeToolchain,
    });
    const before = seen.length;
    await assert.rejects(
      () => remoteService.ensureHelper({ threadId: "t1" }),
      (err) => err.code === "remote_project",
    );
    assert.equal(seen.length, before);

    const linuxService = createIOSSimulatorService({
      store,
      userDataPath,
      platform: "linux",
      toolchain: fakeToolchain,
    });
    await assert.rejects(
      () => linuxService.ensureHelper({ threadId: "t1" }),
      (err) => err.code === "unsupported_platform",
    );
    assert.equal(seen.length, before);
  });

  it("rethrows toolchain failures as instanceof IOSSimulatorError without leaking raw exec messages", async () => {
    const {
      createIOSSimulatorService,
      IOSSimulatorError,
    } = require("../ios-simulator.js");

    const userDataPath = makeUserDataPath();
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(
      path.join(userDataPath, "ios-simulator-preferences.json"),
      `${JSON.stringify({ version: 1, developerDir: DEV_DIR })}\n`,
    );

    const store = {
      getThread: () => ({ id: "t1", projectId: "p1" }),
      getProject: () => ({
        id: "p1",
        path: "/tmp/proj",
        remoteHost: null,
      }),
    };

    function serviceWithToolchain(toolchain) {
      return createIOSSimulatorService({
        store,
        userDataPath,
        platform: "darwin",
        processAdapter: {
          activeDeveloperDir: async () => {
            throw new Error("should not probe active dir");
          },
        },
        toolchain,
      });
    }

    const typed = serviceWithToolchain({
      async discoverToolchains() {
        const err = new Error("Simulator helper build failed");
        err.name = "IOSSimulatorError";
        err.code = "helper_compile_failed";
        throw err;
      },
      async fingerprintToolchain() {
        const err = new Error("Simulator helper build timed out");
        err.name = "IOSSimulatorError";
        err.code = "timeout";
        throw err;
      },
      async ensureHelper() {
        const err = new Error("Full Xcode with Simulator is required");
        err.name = "IOSSimulatorError";
        err.code = "xcode_missing";
        throw err;
      },
    });

    await assert.rejects(() => typed.discoverToolchains({ threadId: "t1" }), (err) => {
      assert.equal(err instanceof IOSSimulatorError, true);
      assert.equal(err.code, "helper_compile_failed");
      return true;
    });
    await assert.rejects(() => typed.fingerprintToolchain({ threadId: "t1" }), (err) => {
      assert.equal(err instanceof IOSSimulatorError, true);
      assert.equal(err.code, "timeout");
      return true;
    });
    await assert.rejects(() => typed.ensureHelper({ threadId: "t1" }), (err) => {
      assert.equal(err instanceof IOSSimulatorError, true);
      assert.equal(err.code, "xcode_missing");
      return true;
    });

    const raw = serviceWithToolchain({
      async discoverToolchains() {
        throw Object.assign(new Error("spawn /secret/xcodebuild ENOENT"), {
          code: "ENOENT",
          path: "/secret/xcodebuild",
        });
      },
      async fingerprintToolchain() {
        throw Object.assign(new Error("Command failed: /secret/xcrun"), {
          status: 1,
          stderr: "/secret/token",
        });
      },
      async ensureHelper() {
        throw Object.assign(new Error("spawn /secret/xcrun ETIMEDOUT"), {
          code: "ETIMEDOUT",
        });
      },
    });

    await assert.rejects(() => raw.discoverToolchains({ threadId: "t1" }), (err) => {
      assert.equal(err instanceof IOSSimulatorError, true);
      assert.equal(err.code, "xcode_missing");
      assert.equal(err.message.includes("/secret"), false);
      assert.equal(err.message.includes("ENOENT"), false);
      return true;
    });
    await assert.rejects(() => raw.fingerprintToolchain({ threadId: "t1" }), (err) => {
      assert.equal(err instanceof IOSSimulatorError, true);
      assert.equal(err.code, "xcode_missing");
      assert.equal(err.message.includes("/secret"), false);
      assert.equal(err.message.includes("token"), false);
      return true;
    });
    await assert.rejects(() => raw.ensureHelper({ threadId: "t1" }), (err) => {
      assert.equal(err instanceof IOSSimulatorError, true);
      assert.equal(err.code, "xcode_missing");
      assert.equal(err.message.includes("/secret"), false);
      assert.equal(err.message.includes("ETIMEDOUT"), false);
      return true;
    });
  });
});
