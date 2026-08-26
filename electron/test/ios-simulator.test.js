"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const SIMCTL_LIST = {
  runtimes: [
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
      name: "iOS 26.0",
      isAvailable: true,
    },
  ],
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      {
        udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        name: "iPhone 17",
        state: "Shutdown",
        isAvailable: true,
      },
    ],
  },
};

const SIMCTL_LIST_WITH_UNAVAILABLE = {
  runtimes: [
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
      name: "iOS 26.0",
      isAvailable: true,
    },
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-25-0",
      name: "iOS 25.0",
      isAvailable: false,
    },
  ],
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      {
        udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        name: "iPhone 17",
        state: "Shutdown",
        isAvailable: true,
      },
      {
        udid: "BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        name: "iPhone 16",
        state: "Booted",
        isAvailable: false,
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-25-0": [
      {
        udid: "CCCCCCCC-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        name: "Old Phone",
        state: "Shutdown",
        isAvailable: true,
      },
    ],
  },
};

const SIMCTL_LIST_MIXED_PLATFORMS = {
  runtimes: [
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
      name: "iOS 26.0",
      isAvailable: true,
    },
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.tvOS-26-0",
      name: "tvOS 26.0",
      isAvailable: true,
    },
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-26-0",
      name: "watchOS 26.0",
      isAvailable: true,
    },
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.xrOS-26-0",
      name: "visionOS 26.0",
      isAvailable: true,
    },
  ],
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      {
        udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        name: "iPhone 17",
        state: "Shutdown",
        isAvailable: true,
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.tvOS-26-0": [
      {
        udid: "DDDDDDDD-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        name: "Apple TV",
        state: "Shutdown",
        isAvailable: true,
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [
      {
        udid: "EEEEEEEE-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        name: "Apple Watch",
        state: "Shutdown",
        isAvailable: true,
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.xrOS-26-0": [
      {
        udid: "FFFFFFFF-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        name: "Vision Pro",
        state: "Shutdown",
        isAvailable: true,
      },
    ],
  },
};

const DEFAULT_DEV_DIR = "/Applications/Xcode.app/Contents/Developer";
const ALT_DEV_DIR = "/Applications/Xcode-beta.app/Contents/Developer";
const BAD_DEV_DIR = "/Applications/Missing.app/Contents/Developer";

/** @type {string[]} */
let tmpDirs = [];

function trackTmpDir(dir) {
  tmpDirs.push(dir);
  return dir;
}

function makeUserDataPath() {
  return trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "ios-sim-")));
}

function makeStore({ remoteHost = null } = {}) {
  const project = {
    id: "p1",
    slug: "owner/repo",
    name: "repo",
    path: "/tmp/repo",
    remoteHost,
  };
  const thread = {
    id: "t1",
    projectId: "p1",
    title: "Test",
  };
  return {
    getThread(id) {
      return id === "t1" ? thread : null;
    },
    getProject(id) {
      return id === "p1" ? project : null;
    },
  };
}

function adapterError(message, stderr) {
  const err = new Error(message);
  if (stderr) err.stderr = stderr;
  return err;
}

function makeProcessAdapter(overrides = {}) {
  /** @type {Array<string | [string, string] | [string, string, string]>} */
  const calls = [];
  const adapter = {
    activeDeveloperDir: async () => {
      calls.push("activeDeveloperDir");
      if (overrides.activeDeveloperDirError) {
        throw overrides.activeDeveloperDirError;
      }
      return overrides.activeDeveloperDir ?? `${DEFAULT_DEV_DIR}\n`;
    },
    xcodeVersion: async (developerDir) => {
      calls.push(["xcodeVersion", developerDir]);
      if (overrides.xcodeVersionError) throw overrides.xcodeVersionError;
      if (developerDir === BAD_DEV_DIR) {
        throw adapterError(
          "xcodebuild: error: unable to find utility",
          "xcode-select: error: invalid developer directory",
        );
      }
      return overrides.xcodeVersion ?? "Xcode 26.0\nBuild version 17A123\n";
    },
    firstLaunchStatus: async (developerDir) => {
      calls.push(["firstLaunchStatus", developerDir]);
      if (overrides.firstLaunchFails) {
        if (overrides.firstLaunchFails instanceof Error) {
          throw overrides.firstLaunchFails;
        }
        throw adapterError(
          "check failed",
          "You have not agreed to the Xcode license agreements",
        );
      }
      return "";
    },
    findSimctl: async (developerDir) => {
      calls.push(["findSimctl", developerDir]);
      if (overrides.missingSimctl) {
        throw adapterError("simctl not found", "unable to find utility simctl");
      }
      return "/usr/bin/simctl";
    },
    listDevices: async (developerDir) => {
      calls.push(["listDevices", developerDir]);
      if (overrides.listDevicesMalformed) return "not-json";
      return JSON.stringify(overrides.simctlList ?? SIMCTL_LIST);
    },
    readBundleId: async (developerDir, infoPlist) => {
      calls.push(["readBundleId", developerDir, infoPlist]);
      if (overrides.readBundleIdError) throw overrides.readBundleIdError;
      return overrides.readBundleId ?? "com.example.App\n";
    },
    install: async (developerDir, udid, appPath) => {
      calls.push(["install", developerDir, udid, appPath]);
      if (overrides.installError) throw overrides.installError;
      if (overrides.installGate) await overrides.installGate;
      return overrides.install ?? "";
    },
    boot: async (developerDir, udid) => {
      calls.push(["boot", developerDir, udid]);
      if (overrides.bootError) throw overrides.bootError;
      if (overrides.bootGate) await overrides.bootGate;
      return overrides.boot ?? "";
    },
    bootStatus: async (developerDir, udid) => {
      calls.push(["bootStatus", developerDir, udid]);
      if (overrides.bootStatusError) throw overrides.bootStatusError;
      if (overrides.bootStatusGate) await overrides.bootStatusGate;
      return overrides.bootStatus ?? "";
    },
    shutdown: async (developerDir, udid) => {
      calls.push(["shutdown", developerDir, udid]);
      if (overrides.shutdownError) throw overrides.shutdownError;
      return overrides.shutdown ?? "";
    },
    launch: async (developerDir, udid, bundleId) => {
      calls.push(["launch", developerDir, udid, bundleId]);
      if (overrides.launchError) throw overrides.launchError;
      if (overrides.launchGate) await overrides.launchGate;
      if (overrides.launchOutput !== undefined) return overrides.launchOutput;
      return `${bundleId}: 4321\n`;
    },
    openUrl: async (developerDir, udid, url) => {
      calls.push(["openUrl", developerDir, udid, url]);
      if (overrides.openUrlError) throw overrides.openUrlError;
      return overrides.openUrl ?? "";
    },
    screenshot: async (developerDir, udid, output) => {
      calls.push(["screenshot", developerDir, udid, output]);
      if (overrides.screenshotError) throw overrides.screenshotError;
      if (overrides.screenshotGate) await overrides.screenshotGate;
      if (overrides.screenshotWritesPng !== false) {
        const png =
          overrides.screenshotPng ??
          pngFixture(overrides.screenshotWidth ?? 2, overrides.screenshotHeight ?? 3);
        await fs.promises.writeFile(output, png);
      }
      return overrides.screenshot ?? "";
    },
    recordVideo: (developerDir, udid, output) => {
      calls.push(["recordVideo", developerDir, udid, output]);
      if (overrides.recordVideoThrows) throw overrides.recordVideoThrows;
      if (typeof overrides.recordVideo === "function") {
        return overrides.recordVideo(developerDir, udid, output);
      }
      return Object.freeze({
        pid: 4242,
        closed: new Promise(() => {}),
        interrupt() {},
      });
    },
    inspectProcess: async (pid) => {
      calls.push(["inspectProcess", pid]);
      if (overrides.inspectProcessError) throw overrides.inspectProcessError;
      if (typeof overrides.inspectProcess === "function") {
        return overrides.inspectProcess(pid);
      }
      return overrides.inspectProcess ?? "";
    },
  };
  return { adapter, calls };
}

function box(type, body) {
  const buf = Buffer.alloc(8 + body.length);
  buf.writeUInt32BE(8 + body.length, 0);
  buf.write(type, 4, 4);
  body.copy(buf, 8);
  return buf;
}

function mp4Fixture(durationMs = 2000, timescale = 1000) {
  const ftypBody = Buffer.alloc(12);
  ftypBody.write("isom", 0, 4);
  ftypBody.writeUInt32BE(0, 4);
  ftypBody.write("isom", 8, 4);
  const ftyp = box("ftyp", ftypBody);
  const mvhdBody = Buffer.alloc(96);
  mvhdBody[0] = 0;
  mvhdBody.writeUInt32BE(timescale, 12);
  mvhdBody.writeUInt32BE(durationMs, 16);
  mvhdBody.writeUInt32BE(0x00010000, 20);
  mvhdBody.writeUInt16BE(0x0100, 24);
  const mvhd = box("mvhd", mvhdBody);
  const moov = box("moov", mvhd);
  return Buffer.concat([ftyp, moov]);
}

function pngFixture(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdrType = Buffer.from("IHDR");
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13);
  const crc = Buffer.alloc(4);
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crc]);
}

function makeArtifactStore(deps = {}) {
  const { Store } = require("../store.js");
  const { createRunArtifactStore } = require("../run-artifact-store.js");
  const tmpDir =
    deps.userDataPath ??
    trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "ios-sim-artifacts-")));
  const store = new Store(path.join(tmpDir, "store.json"));
  const thread = {
    id: "t1",
    projectId: "p1",
    title: "Test",
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    lastError: null,
    createdAt: 1,
    updatedAt: 2,
    runStartedAt: null,
    stoppedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    prState: null,
    prMergeable: null,
    quotaWaitUntil: null,
    quotaWaitResumed: false,
    quotaWaitAutoResume: null,
    lastVisitedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    webSearch: false,
    worktreePath: null,
    handoffFrom: null,
    feltEstimate: null,
    replayContext: false,
    muted: false,
    notes: "",
    queued: null,
    verifyCommand: null,
    verify: null,
    issueNumber: null,
    postMergeVerify: null,
    reviewAcceptedHunks: [],
  };
  store.setThreads([thread]);
  const artifactStore = createRunArtifactStore({
    userDataPath: tmpDir,
    store,
    now: () => Date.parse("2026-08-25T12:00:00.000Z"),
    limits: deps.limits,
  });
  return {
    artifactStore,
    artifactRoot: path.join(tmpDir, "run-artifacts"),
    store,
    thread,
    tmpDir,
  };
}

function makeFakeArtifactStore() {
  const tmpDir = trackTmpDir(
    fs.mkdtempSync(path.join(os.tmpdir(), "ios-sim-fake-art-")),
  );
  const stagingPath = path.join(tmpDir, "screenshot.bin");
  const stageCalls = [];
  const discardCalls = [];
  const commitCalls = [];
  const artifactStore = {
    stageCalls,
    discardCalls,
    commitCalls,
    async stage(opts) {
      stageCalls.push(opts);
      return { token: "stage-token", path: stagingPath };
    },
    async commitBatch(batch) {
      commitCalls.push(batch);
      return [
        {
          id: "artifact-1",
          threadId: batch.threadId,
          runId: batch.runId ?? null,
          toolCallId: batch.toolCallId,
          source: batch.source,
          kind: "image",
          mimeType: "image/png",
          name: "Simulator screenshot.png",
          size: 42,
          createdAt: "2026-08-25T12:00:00.000Z",
        },
      ];
    },
    async discard(token) {
      discardCalls.push(token);
    },
  };
  return artifactStore;
}

function makeLeaseStore({ projectId = "p1", remoteHost = null } = {}) {
  const project = {
    id: projectId,
    slug: "owner/repo",
    name: "repo",
    path: "/tmp/repo",
    remoteHost,
  };
  const threads = {
    t1: { id: "t1", projectId, title: "Thread One" },
    t2: { id: "t2", projectId, title: "Thread Two" },
    t3: { id: "t3", projectId, title: "Thread Three" },
  };
  return {
    getThread(id) {
      return threads[id] ?? null;
    },
    getProject(id) {
      return id === projectId ? project : null;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for condition");
}

function makeMutableStore({
  projectPath,
  remoteHost = null,
  threadOverrides = {},
} = {}) {
  let thread = {
    id: "t1",
    projectId: "p1",
    title: "Test",
    ...threadOverrides,
  };
  const project = {
    id: "p1",
    slug: "owner/repo",
    name: "repo",
    path: projectPath,
    remoteHost,
  };
  const store = {
    getThread(id) {
      return id === "t1" ? thread : null;
    },
    getProject(id) {
      return id === "p1" ? project : null;
    },
    updateThread(id, patch) {
      if (id === "t1") thread = { ...thread, ...patch };
    },
  };
  return { store, getThread: () => thread, project };
}

function makeProjectRoot() {
  const root = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "ios-sim-root-")));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function writeAppBundle(root, relativePath, { bundleId = "com.example.App" } = {}) {
  const appDir = path.join(root, relativePath);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "Info.plist"), `bundle:${bundleId}\n`);
  return appDir;
}

function makeService(deps = {}) {
  const {
    parseXcodeVersion,
    parseSimulatorList,
    capabilitySnapshot,
    createIOSSimulatorService,
  } = require("../ios-simulator.js");
  const userDataPath = deps.userDataPath ?? makeUserDataPath();
  const { adapter, calls } = makeProcessAdapter(deps.processOverrides ?? {});
  const service = createIOSSimulatorService({
    store: deps.store ?? makeStore(),
    userDataPath,
    worktreeBase: deps.worktreeBase ?? path.join(userDataPath, "worktrees"),
    platform: deps.platform ?? "darwin",
    processAdapter: deps.processAdapter ?? adapter,
    fsApi: deps.fsApi ?? fs,
    randomUUID: deps.randomUUID ?? (() => "test-uuid"),
    now: deps.now,
    logger: deps.logger,
    prepareThreadWorktree: deps.prepareThreadWorktree,
    broadcast: deps.broadcast ?? (() => {}),
    artifactStore: deps.artifactStore,
    signalPid: deps.signalPid,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    recordingStagingRoot: deps.recordingStagingRoot,
    ...deps.serviceOverrides,
  });
  return {
    service,
    userDataPath,
    calls,
    parseXcodeVersion,
    parseSimulatorList,
    capabilitySnapshot,
  };
}

function writePrefs(userDataPath, value) {
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(
    path.join(userDataPath, "ios-simulator-preferences.json"),
    `${JSON.stringify(value)}\n`,
    { mode: 0o600 },
  );
}

async function assertRejects(promise, code, messageCheck) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.name, "IOSSimulatorError");
    assert.equal(err.code, code);
    if (messageCheck) messageCheck(err);
    return true;
  });
}

function assertSanitizedError(err) {
  assert.equal(err.details, undefined);
  assert.match(
    err.message,
    /^(Complete Xcode first-launch setup|Full Xcode with Simulator is required|Select an absolute Xcode developer directory|Simulator preferences are invalid|Simulator user data path is invalid|Simulator device list is invalid|Xcode version information is invalid|iOS Simulator requires macOS|iOS Simulator requires a local project|Unknown thread|Unknown project)/,
  );
  assert.equal(err.message.includes("/Applications"), false);
  assert.equal(err.message.includes("xcodebuild"), false);
  assert.equal(err.message.includes("stderr"), false);
  assert.equal(err.message.includes("EACCES"), false);
}

function assertPrepareAppBundleSanitized(err, code, forbidden = []) {
  assert.equal(err.details, undefined);
  const allowed = {
    invalid_app_path: "App path must be a relative .app inside the project",
    invalid_bundle: "App bundle is invalid",
    worktree_missing: "Thread worktree is unavailable",
    unexpected: "Project path is unavailable",
  };
  assert.equal(err.message, allowed[code]);
  for (const fragment of forbidden) {
    assert.equal(err.message.includes(fragment), false);
  }
  assert.equal(err.message.includes("plutil"), false);
  assert.equal(err.message.includes("stderr"), false);
  assert.equal(err.message.includes("EACCES"), false);
  assert.equal(err.message.includes("ENOENT"), false);
}

function assertFrozenDescriptor(result) {
  assert.deepEqual(Object.keys(result).sort(), ["appPath", "bundleId"]);
  assert.equal(Object.isFrozen(result), true);
}

function makeBundleWalkFsApi(bundlePath, entryCount) {
  const names = Array.from({ length: entryCount }, (_, index) => `entry-${index}`);
  const root = path.resolve(bundlePath);
  const dirStat = {
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
  const fileStat = {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
  const isBundlePath = (target) => path.resolve(target) === root;
  const isBundleEntry = (target) => {
    const normalized = path.resolve(target);
    return normalized.startsWith(root + path.sep);
  };
  return {
    promises: {
      realpath: fs.promises.realpath.bind(fs.promises),
      lstat: async (target) => {
        if (isBundlePath(target)) return dirStat;
        if (path.resolve(target) === path.join(root, "Info.plist")) return fileStat;
        if (isBundleEntry(target)) return fileStat;
        return fs.promises.lstat(target);
      },
      readdir: async (target) => {
        if (isBundlePath(target)) return names;
        return fs.promises.readdir(target);
      },
    },
  };
}

describe("createIOSSimulatorService discovery", () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("rejects unsupported platform before any process call", async () => {
    const { service, calls } = makeService({ platform: "linux" });
    await assertRejects(
      service.getCapabilities({ threadId: "t1" }),
      "unsupported_platform",
    );
    assert.equal(calls.length, 0);
  });

  it("rejects remote project before any process call", async () => {
    const { service, calls } = makeService({
      store: makeStore({ remoteHost: "dev@box" }),
    });
    await assertRejects(
      service.getCapabilities({ threadId: "t1" }),
      "remote_project",
    );
    assert.equal(calls.length, 0);
  });

  it("falls back to active xcode-select developer directory", async () => {
    const { service, calls } = makeService();
    const caps = await service.getCapabilities({ threadId: "t1" });
    assert.equal(calls[0], "activeDeveloperDir");
    assert.equal(caps.developerDir, DEFAULT_DEV_DIR);
    assert.equal(caps.platform, "darwin");
    assert.equal(caps.supported, true);
    assert.deepEqual(caps.xcode, { version: "26.0", build: "17A123" });
    assert.equal(caps.licenseAccepted, true);
  });

  it("uses trimmed persisted developer directory", async () => {
    const userDataPath = makeUserDataPath();
    writePrefs(userDataPath, {
      version: 1,
      developerDir: `  ${ALT_DEV_DIR}  `,
    });
    const { adapter, calls } = makeProcessAdapter();
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    const service = createIOSSimulatorService({
      store: makeStore(),
      userDataPath,
      platform: "darwin",
      processAdapter: adapter,
      randomUUID: () => "test-uuid",
    });
    const caps = await service.getCapabilities({ threadId: "t1" });
    assert.equal(caps.developerDir, ALT_DEV_DIR);
    assert.ok(
      calls.some(
        (c) => Array.isArray(c) && c[0] === "xcodeVersion" && c[1] === ALT_DEV_DIR,
      ),
    );
  });

  it("reports xcode_missing when simctl is unavailable", async () => {
    const { service } = makeService({
      processOverrides: { missingSimctl: true },
    });
    await assertRejects(
      service.getCapabilities({ threadId: "t1" }),
      "xcode_missing",
      assertSanitizedError,
    );
  });

  it("classifies bare firstLaunchStatus failure as license_required", async () => {
    const { service } = makeService({
      processOverrides: { firstLaunchFails: new Error("Command failed") },
    });
    await assertRejects(
      service.getCapabilities({ threadId: "t1" }),
      "license_required",
      assertSanitizedError,
    );
  });

  it("classifies bare activeDeveloperDir failure as xcode_missing", async () => {
    const { service } = makeService({
      processOverrides: { activeDeveloperDirError: new Error("Command failed") },
    });
    await assertRejects(
      service.getCapabilities({ threadId: "t1" }),
      "xcode_missing",
      assertSanitizedError,
    );
  });

  it("classifies command line tools xcodeVersion failure as xcode_missing", async () => {
    const { service } = makeService({
      processOverrides: {
        xcodeVersionError: adapterError(
          "xcodebuild: error: tool 'xcodebuild' requires Xcode",
          "xcode-select: error: tool 'xcodebuild' requires Xcode, but was found at Command Line Tools",
        ),
      },
    });
    await assertRejects(
      service.getCapabilities({ threadId: "t1" }),
      "xcode_missing",
      assertSanitizedError,
    );
  });

  it("classifies license hints in xcodeVersion failure as license_required", async () => {
    const { service } = makeService({
      processOverrides: {
        xcodeVersionError: adapterError(
          "license check failed",
          "You have not agreed to the Xcode license agreements",
        ),
      },
    });
    await assertRejects(
      service.getCapabilities({ threadId: "t1" }),
      "license_required",
      assertSanitizedError,
    );
  });

  it("classifies wrong developer directory selection as xcode_missing", async () => {
    const { service } = makeService();
    await assertRejects(
      service.selectDeveloperDirectory({
        threadId: "t1",
        developerDir: BAD_DEV_DIR,
      }),
      "xcode_missing",
      assertSanitizedError,
    );
  });

  it("parses Xcode version from xcodebuild output", () => {
    const { parseXcodeVersion } = makeService();
    assert.deepEqual(
      parseXcodeVersion("Xcode 26.0\nBuild version 17A123\n"),
      { version: "26.0", build: "17A123" },
    );
    assert.throws(
      () => parseXcodeVersion("garbage"),
      (err) => {
        assert.equal(err.name, "IOSSimulatorError");
        assert.equal(err.code, "unexpected");
        assert.equal(err.message, "Xcode version information is invalid");
        return true;
      },
    );
  });

  it("rejects noisy xcodebuild output during discovery", async () => {
    const { service } = makeService({
      processOverrides: { xcodeVersion: "not a version\nmore noise\n" },
    });
    await assertRejects(
      service.getCapabilities({ threadId: "t1" }),
      "unexpected",
      (err) => {
        assert.equal(err.message, "Xcode version information is invalid");
      },
    );
  });

  it("rejects malformed simctl list json", async () => {
    const { service } = makeService({
      processOverrides: { listDevicesMalformed: true },
    });
    await assertRejects(
      service.listDevices({ threadId: "t1" }),
      "unexpected",
      (err) => {
        assert.equal(err.message, "Simulator device list is invalid");
        assert.equal(err.details, undefined);
      },
    );
  });

  it("excludes unavailable runtimes and devices from device listing", async () => {
    const { service } = makeService({
      processOverrides: { simctlList: SIMCTL_LIST_WITH_UNAVAILABLE },
    });
    const devices = await service.listDevices({ threadId: "t1" });
    assert.equal(devices.length, 1);
    assert.equal(devices[0].udid, "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
    assert.equal(devices[0].name, "iPhone 17");
    assert.equal(devices[0].state, "Shutdown");
    assert.equal(
      devices[0].runtimeIdentifier,
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
    );
  });

  it("includes only iOS runtimes and devices from mixed platform listings", async () => {
    const { service } = makeService({
      processOverrides: { simctlList: SIMCTL_LIST_MIXED_PLATFORMS },
    });
    const devices = await service.listDevices({ threadId: "t1" });
    const caps = await service.getCapabilities({ threadId: "t1" });
    assert.equal(devices.length, 1);
    assert.equal(devices[0].udid, "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
    assert.equal(caps.runtimes.length, 1);
    assert.equal(
      caps.runtimes[0].identifier,
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
    );
  });

  it("selectDeveloperDirectory validates, persists preferences, and returns capabilities", async () => {
    const userDataPath = makeUserDataPath();
    const { adapter } = makeProcessAdapter();
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    const service = createIOSSimulatorService({
      store: makeStore(),
      userDataPath,
      platform: "darwin",
      processAdapter: adapter,
      randomUUID: () => "persist-uuid",
    });
    const caps = await service.selectDeveloperDirectory({
      threadId: "t1",
      developerDir: ALT_DEV_DIR,
    });
    assert.equal(caps.developerDir, ALT_DEV_DIR);
    const prefPath = path.join(userDataPath, "ios-simulator-preferences.json");
    assert.equal(fs.existsSync(prefPath), true);
    const stat = fs.statSync(prefPath);
    assert.equal(stat.mode & 0o777, 0o600);
    const saved = JSON.parse(fs.readFileSync(prefPath, "utf8"));
    assert.deepEqual(saved, { version: 1, developerDir: ALT_DEV_DIR });
  });

  it("rejects relative candidate paths before adapter calls", async () => {
    const { service, calls } = makeService();
    await assertRejects(
      service.selectDeveloperDirectory({
        threadId: "t1",
        developerDir: "Developer",
      }),
      "xcode_missing",
      assertSanitizedError,
    );
    assert.equal(calls.length, 0);
  });

  it("rejects NUL candidate paths before adapter calls", async () => {
    const { service, calls } = makeService();
    await assertRejects(
      service.selectDeveloperDirectory({
        threadId: "t1",
        developerDir: `/Applications/Xcode.app\0/Contents/Developer`,
      }),
      "xcode_missing",
      assertSanitizedError,
    );
    assert.equal(calls.length, 0);
  });

  it("rejects relative persisted developerDir without adapter calls", async () => {
    const userDataPath = makeUserDataPath();
    writePrefs(userDataPath, {
      version: 1,
      developerDir: "Developer",
    });
    const { adapter, calls } = makeProcessAdapter();
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    const service = createIOSSimulatorService({
      store: makeStore(),
      userDataPath,
      platform: "darwin",
      processAdapter: adapter,
    });
    await assertRejects(
      service.getCapabilities({ threadId: "t1" }),
      "unexpected",
      (err) => {
        assert.equal(err.message, "Simulator preferences are invalid");
        assert.equal(err.details, undefined);
      },
    );
    assert.equal(calls.length, 0);
  });

  it("rejects NUL persisted developerDir without adapter calls", async () => {
    const userDataPath = makeUserDataPath();
    writePrefs(userDataPath, {
      version: 1,
      developerDir: `${DEFAULT_DEV_DIR}\0`,
    });
    const { adapter, calls } = makeProcessAdapter();
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    const service = createIOSSimulatorService({
      store: makeStore(),
      userDataPath,
      platform: "darwin",
      processAdapter: adapter,
    });
    await assertRejects(service.getCapabilities({ threadId: "t1" }), "unexpected");
    assert.equal(calls.length, 0);
  });

  it("rejects non-regular preferences file without adapter calls", async () => {
    const userDataPath = makeUserDataPath();
    const prefPath = path.join(userDataPath, "ios-simulator-preferences.json");
    fs.mkdirSync(prefPath);
    const { adapter, calls } = makeProcessAdapter();
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    const service = createIOSSimulatorService({
      store: makeStore(),
      userDataPath,
      platform: "darwin",
      processAdapter: adapter,
    });
    await assertRejects(service.getCapabilities({ threadId: "t1" }), "unexpected");
    assert.equal(calls.length, 0);
  });

  it("leaves preferences unchanged when selection fails on license", async () => {
    const userDataPath = makeUserDataPath();
    writePrefs(userDataPath, { version: 1, developerDir: DEFAULT_DEV_DIR });
    const { adapter } = makeProcessAdapter({ firstLaunchFails: true });
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    const service = createIOSSimulatorService({
      store: makeStore(),
      userDataPath,
      platform: "darwin",
      processAdapter: adapter,
      randomUUID: () => "license-fail-uuid",
    });
    await assertRejects(
      service.selectDeveloperDirectory({
        threadId: "t1",
        developerDir: ALT_DEV_DIR,
      }),
      "license_required",
    );
    const saved = JSON.parse(
      fs.readFileSync(
        path.join(userDataPath, "ios-simulator-preferences.json"),
        "utf8",
      ),
    );
    assert.deepEqual(saved, { version: 1, developerDir: DEFAULT_DEV_DIR });
  });

  it("leaves preferences unchanged when selection fails on malformed device list", async () => {
    const userDataPath = makeUserDataPath();
    writePrefs(userDataPath, { version: 1, developerDir: DEFAULT_DEV_DIR });
    const { adapter } = makeProcessAdapter({ listDevicesMalformed: true });
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    const service = createIOSSimulatorService({
      store: makeStore(),
      userDataPath,
      platform: "darwin",
      processAdapter: adapter,
      randomUUID: () => "list-fail-uuid",
    });
    await assertRejects(
      service.selectDeveloperDirectory({
        threadId: "t1",
        developerDir: ALT_DEV_DIR,
      }),
      "unexpected",
    );
    const saved = JSON.parse(
      fs.readFileSync(
        path.join(userDataPath, "ios-simulator-preferences.json"),
        "utf8",
      ),
    );
    assert.deepEqual(saved, { version: 1, developerDir: DEFAULT_DEV_DIR });
  });

  it("retries preference write after sync failure using a new temp name", async () => {
    const userDataPath = makeUserDataPath();
    const uuids = ["fail-uuid", "ok-uuid"];
    let tempSyncCalls = 0;
    const fsApi = {
      promises: {
        mkdir: fs.promises.mkdir,
        rename: fs.promises.rename,
        unlink: fs.promises.unlink,
        lstat: fs.promises.lstat,
        readFile: fs.promises.readFile,
        open: async (filePath, flags, mode) => {
          const handle = await fs.promises.open(filePath, flags, mode);
          const isTempPref = String(filePath).includes(".tmp");
          return {
            writeFile: handle.writeFile.bind(handle),
            sync: async () => {
              if (isTempPref) {
                tempSyncCalls += 1;
                if (tempSyncCalls === 1) {
                  throw new Error("sync failed");
                }
              }
              return handle.sync();
            },
            close: handle.close.bind(handle),
          };
        },
      },
    };
    const { adapter } = makeProcessAdapter();
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    const service = createIOSSimulatorService({
      store: makeStore(),
      userDataPath,
      platform: "darwin",
      processAdapter: adapter,
      fsApi,
      randomUUID: () => uuids.shift() || "extra-uuid",
    });
    const caps = await service.selectDeveloperDirectory({
      threadId: "t1",
      developerDir: ALT_DEV_DIR,
    });
    assert.equal(caps.developerDir, ALT_DEV_DIR);
    assert.equal(tempSyncCalls, 2);
    assert.equal(
      fs.existsSync(path.join(userDataPath, "ios-simulator-preferences.json.fail-uuid.tmp")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(userDataPath, "ios-simulator-preferences.json")),
      true,
    );
  });

  it("capability snapshot exposes runtimes without unavailable devices", async () => {
    const { service } = makeService({
      processOverrides: { simctlList: SIMCTL_LIST_WITH_UNAVAILABLE },
    });
    const caps = await service.getCapabilities({ threadId: "t1" });
    assert.equal(caps.runtimes.length, 1);
    assert.equal(
      caps.runtimes[0].identifier,
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
    );
    assert.equal(caps.runtimes[0].devices.length, 1);
    assert.deepEqual(caps.capabilities, {
      deviceLifecycle: true,
      screenshot: true,
      recording: true,
      stream: false,
      touch: false,
      keyboard: false,
      hardwareButtons: false,
      accessibility: false,
    });
  });

  it("normalizes unknown device states to Unknown", async () => {
    const list = {
      runtimes: [
        {
          identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
          name: "iOS 26.0",
          isAvailable: true,
        },
      ],
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
          {
            udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
            name: "iPhone 17",
            state: "Creating",
            isAvailable: true,
          },
        ],
      },
    };
    const { service } = makeService({ processOverrides: { simctlList: list } });
    const devices = await service.listDevices({ threadId: "t1" });
    assert.equal(devices[0].state, "Unknown");
  });

  it("rejects preference mkdir EACCES with sanitized typed error", async () => {
    const userDataPath = makeUserDataPath();
    const deniedPath = path.join(userDataPath, "denied", "nested");
    const fsApi = {
      promises: {
        mkdir: async () => {
          const err = new Error(`mkdir '${deniedPath}' EACCES`);
          err.code = "EACCES";
          throw err;
        },
        unlink: fs.promises.unlink,
        lstat: fs.promises.lstat,
        readFile: fs.promises.readFile,
        open: fs.promises.open,
        rename: fs.promises.rename,
      },
    };
    const { adapter } = makeProcessAdapter();
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    const service = createIOSSimulatorService({
      store: makeStore(),
      userDataPath: deniedPath,
      platform: "darwin",
      processAdapter: adapter,
      fsApi,
      randomUUID: () => "eacces-uuid",
    });
    await assertRejects(
      service.selectDeveloperDirectory({
        threadId: "t1",
        developerDir: ALT_DEV_DIR,
      }),
      "unexpected",
      (err) => {
        assert.equal(err.message, "Simulator preferences are invalid");
        assert.equal(err.message.includes(deniedPath), false);
        assert.equal(err.message.includes("EACCES"), false);
        assert.equal(err.details, undefined);
      },
    );
  });

  it("sanitizes store getter failures at public boundaries", async () => {
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    const service = createIOSSimulatorService({
      store: {
        getThread() {
          throw new Error("store exploded");
        },
        getProject() {
          return null;
        },
      },
      userDataPath: makeUserDataPath(),
      platform: "darwin",
      processAdapter: makeProcessAdapter().adapter,
    });
    await assertRejects(
      service.getCapabilities({ threadId: "t1" }),
      "unexpected",
      (err) => {
        assert.equal(err.message, "Unknown thread: t1");
        assert.equal(err.message.includes("store exploded"), false);
      },
    );
  });

  it("rejects missing threadId without destructuring TypeError", async () => {
    const { service } = makeService();
    await assertRejects(service.getCapabilities({}), "unexpected", (err) => {
      assert.equal(err.message, "Unknown thread");
    });
    await assertRejects(service.listDevices(undefined), "unexpected", (err) => {
      assert.equal(err.message, "Unknown thread");
    });
  });

  it("rejects empty userDataPath at construction", () => {
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    assert.throws(
      () =>
        createIOSSimulatorService({
          store: makeStore(),
          userDataPath: "",
        }),
      (err) => {
        assert.equal(err.name, "IOSSimulatorError");
        assert.equal(err.code, "unexpected");
        assert.equal(err.message, "Simulator user data path is invalid");
        return true;
      },
    );
  });

  it("rejects relative userDataPath at construction", () => {
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    assert.throws(
      () =>
        createIOSSimulatorService({
          store: makeStore(),
          userDataPath: "relative/user",
        }),
      (err) => {
        assert.equal(err.name, "IOSSimulatorError");
        assert.equal(err.code, "unexpected");
        assert.equal(err.message, "Simulator user data path is invalid");
        return true;
      },
    );
  });

  it("rejects NUL userDataPath at construction", () => {
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    assert.throws(
      () =>
        createIOSSimulatorService({
          store: makeStore(),
          userDataPath: `/tmp/user\0data`,
        }),
      (err) => {
        assert.equal(err.name, "IOSSimulatorError");
        assert.equal(err.code, "unexpected");
        assert.equal(err.message, "Simulator user data path is invalid");
        return true;
      },
    );
  });

  it("rejects undefined userDataPath at construction", () => {
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    assert.throws(
      () =>
        createIOSSimulatorService({
          store: makeStore(),
          userDataPath: undefined,
        }),
      (err) => {
        assert.equal(err.name, "IOSSimulatorError");
        assert.equal(err.code, "unexpected");
        assert.equal(err.message, "Simulator user data path is invalid");
        return true;
      },
    );
  });

  it("rejects non-string userDataPath at construction", () => {
    const { createIOSSimulatorService } = require("../ios-simulator.js");
    assert.throws(
      () =>
        createIOSSimulatorService({
          store: makeStore(),
          userDataPath: 42,
        }),
      (err) => {
        assert.equal(err.name, "IOSSimulatorError");
        assert.equal(err.code, "unexpected");
        assert.equal(err.message, "Simulator user data path is invalid");
        return true;
      },
    );
  });
});

describe("createIOSSimulatorService prepareAppBundle", () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("uses the plain project checkout when no worktree is configured", async () => {
    const projectPath = makeProjectRoot();
    writeAppBundle(projectPath, "build/Products/App.app");
    const { store } = makeMutableStore({ projectPath });
    const prepareCalls = [];
    const { service, calls } = makeService({
      store,
      prepareThreadWorktree: async (opts) => {
        prepareCalls.push(opts);
      },
    });
    const result = await service.prepareAppBundle({
      threadId: "t1",
      relativeAppPath: "build/Products/App.app",
    });
    assertFrozenDescriptor(result);
    assert.equal(result.bundleId, "com.example.App");
    assert.equal(result.appPath.endsWith("build/Products/App.app"), true);
    assert.equal(result.appPath.endsWith(".app"), true);
    assert.equal(prepareCalls.length, 0);
    assert.ok(calls.some((c) => Array.isArray(c) && c[0] === "readBundleId"));
    assert.equal(calls.includes("install"), false);
  });

  it("materializes a pending worktree before resolving the app bundle", async () => {
    const projectPath = makeProjectRoot();
    const userDataPath = makeUserDataPath();
    const worktreeBase = path.join(userDataPath, "worktrees");
    const { store } = makeMutableStore({
      projectPath,
      threadOverrides: { pendingWorktree: true },
    });
    const prepareCalls = [];
    const { service } = makeService({
      store,
      userDataPath,
      worktreeBase,
      prepareThreadWorktree: async (opts) => {
        prepareCalls.push(opts);
        const wtPath = path.join(worktreeBase, "t1");
        fs.mkdirSync(wtPath, { recursive: true });
        writeAppBundle(wtPath, "build/Products/App.app");
        store.updateThread("t1", {
          worktreePath: wtPath,
          pendingWorktree: false,
        });
      },
    });
    const result = await service.prepareAppBundle({
      threadId: "t1",
      relativeAppPath: "build/Products/App.app",
    });
    assert.equal(result.bundleId, "com.example.App");
    assert.equal(prepareCalls.length, 1);
    assert.equal(prepareCalls[0].threadId, "t1");
    assert.equal(prepareCalls[0].worktreeBase, worktreeBase);
    assert.equal(result.appPath.endsWith("build/Products/App.app"), true);
    assert.equal(
      result.appPath.includes(`${path.sep}worktrees${path.sep}t1${path.sep}`),
      true,
    );
  });

  it("rematerializes when an existing worktree path disappeared", async () => {
    const projectPath = makeProjectRoot();
    const userDataPath = makeUserDataPath();
    const worktreeBase = path.join(userDataPath, "worktrees");
    const stalePath = path.join(worktreeBase, "t1");
    const { store } = makeMutableStore({
      projectPath,
      threadOverrides: { worktreePath: stalePath },
    });
    const prepareCalls = [];
    const { service } = makeService({
      store,
      userDataPath,
      worktreeBase,
      prepareThreadWorktree: async (opts) => {
        prepareCalls.push(opts);
        fs.mkdirSync(stalePath, { recursive: true });
        writeAppBundle(stalePath, "build/Products/App.app");
        store.updateThread("t1", { worktreePath: stalePath });
      },
    });
    const result = await service.prepareAppBundle({
      threadId: "t1",
      relativeAppPath: "build/Products/App.app",
    });
    assert.equal(prepareCalls.length, 1);
    assert.equal(result.appPath.endsWith("build/Products/App.app"), true);
    assert.equal(
      result.appPath.includes(`${path.sep}worktrees${path.sep}t1${path.sep}`),
      true,
    );
  });

  it("rejects unavailable worktrees without falling back to the project checkout", async () => {
    const projectPath = makeProjectRoot();
    writeAppBundle(projectPath, "build/Products/App.app");
    const { store } = makeMutableStore({
      projectPath,
      threadOverrides: { pendingWorktree: true },
    });
    const { service, calls } = makeService({
      store,
      prepareThreadWorktree: async () => {
        store.updateThread("t1", { pendingWorktree: false });
      },
    });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.app",
      }),
      "worktree_missing",
      (err) => assertPrepareAppBundleSanitized(err, "worktree_missing"),
    );
    assert.equal(
      calls.some((c) => Array.isArray(c) && c[0] === "readBundleId"),
      false,
    );
    assert.equal(calls.includes("install"), false);
  });

  it("propagates worktree materialization failures without adapter calls", async () => {
    const projectPath = makeProjectRoot();
    writeAppBundle(projectPath, "build/Products/App.app");
    const { store } = makeMutableStore({
      projectPath,
      threadOverrides: { pendingWorktree: true },
    });
    const { service, calls } = makeService({
      store,
      prepareThreadWorktree: async () => {
        throw new Error("worktree setup failed");
      },
    });
    await assert.rejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.app",
      }),
      /worktree setup failed/,
    );
    assert.equal(
      calls.some((c) => Array.isArray(c) && c[0] === "readBundleId"),
      false,
    );
    assert.equal(calls.includes("install"), false);
  });

  it("rejects absolute app paths", async () => {
    const projectPath = makeProjectRoot();
    writeAppBundle(projectPath, "build/Products/App.app");
    const { store } = makeMutableStore({ projectPath });
    const { service, calls } = makeService({ store });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: path.join(projectPath, "build/Products/App.app"),
      }),
      "invalid_app_path",
      (err) => assertPrepareAppBundleSanitized(err, "invalid_app_path", [projectPath]),
    );
    assert.equal(
      calls.some((c) => Array.isArray(c) && c[0] === "readBundleId"),
      false,
    );
  });

  it("rejects NUL app paths", async () => {
    const projectPath = makeProjectRoot();
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({ store });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build\0/App.app",
      }),
      "invalid_app_path",
    );
  });

  it("rejects parent traversal in app paths", async () => {
    const projectPath = makeProjectRoot();
    writeAppBundle(projectPath, "build/Products/App.app");
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({ store });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "../outside/App.app",
      }),
      "invalid_app_path",
    );
  });

  it("rejects non-.app extensions", async () => {
    const projectPath = makeProjectRoot();
    const bundleDir = path.join(projectPath, "build/Products/App.ipa");
    fs.mkdirSync(bundleDir, { recursive: true });
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({ store });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.ipa",
      }),
      "invalid_app_path",
    );
  });

  it("rejects missing app bundles", async () => {
    const projectPath = makeProjectRoot();
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({ store });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/Missing.app",
      }),
      "invalid_app_path",
    );
  });

  it("rejects non-directory app bundles", async () => {
    const projectPath = makeProjectRoot();
    const fileBundle = path.join(projectPath, "build/Products/App.app");
    fs.mkdirSync(path.dirname(fileBundle), { recursive: true });
    fs.writeFileSync(fileBundle, "not a bundle");
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({ store });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.app",
      }),
      "invalid_app_path",
    );
  });

  it("rejects top-level symlink bundles that escape the root", async () => {
    const projectPath = makeProjectRoot();
    const outside = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "ios-out-")));
    writeAppBundle(outside, "Outside.app");
    fs.symlinkSync(
      path.join(outside, "Outside.app"),
      path.join(projectPath, "Escape.app"),
    );
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({ store });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "Escape.app",
      }),
      "invalid_app_path",
    );
  });

  it("rejects nested symlink escapes inside the bundle", async () => {
    const projectPath = makeProjectRoot();
    const outside = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "ios-out-")));
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
    const appDir = writeAppBundle(projectPath, "build/Products/App.app");
    fs.symlinkSync(outside, path.join(appDir, "Frameworks"));
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({ store });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.app",
      }),
      "invalid_bundle",
      (err) => assertPrepareAppBundleSanitized(err, "invalid_bundle", [outside, projectPath]),
    );
  });

  it("rejects transitive leaks through in-root staging directories", async () => {
    const projectPath = makeProjectRoot();
    const stagingDir = path.join(projectPath, "staging");
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.symlinkSync("/etc/passwd", path.join(stagingDir, "leak"));
    const appDir = writeAppBundle(projectPath, "build/Products/App.app");
    fs.symlinkSync(stagingDir, path.join(appDir, "Frameworks"));
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({ store });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.app",
      }),
      "invalid_bundle",
      (err) =>
        assertPrepareAppBundleSanitized(err, "invalid_bundle", [
          projectPath,
          "/etc/passwd",
        ]),
    );
  });

  it("allows in-root symlinked regular files inside the bundle", async () => {
    const projectPath = makeProjectRoot();
    const sharedDir = path.join(projectPath, "shared");
    fs.mkdirSync(sharedDir, { recursive: true });
    const payload = path.join(sharedDir, "payload.dat");
    fs.writeFileSync(payload, "payload");
    const appDir = writeAppBundle(projectPath, "build/Products/App.app");
    fs.symlinkSync(payload, path.join(appDir, "Payload.dat"));
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({ store });
    const result = await service.prepareAppBundle({
      threadId: "t1",
      relativeAppPath: "build/Products/App.app",
    });
    assertFrozenDescriptor(result);
    assert.equal(result.bundleId, "com.example.App");
  });

  it("rejects symlinked Info.plist files", async () => {
    const projectPath = makeProjectRoot();
    const appDir = writeAppBundle(projectPath, "build/Products/App.app");
    fs.unlinkSync(path.join(appDir, "Info.plist"));
    fs.symlinkSync(
      path.join(projectPath, "build/Products/real.plist"),
      path.join(appDir, "Info.plist"),
    );
    fs.writeFileSync(path.join(projectPath, "build/Products/real.plist"), "plist");
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({ store });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.app",
      }),
      "invalid_bundle",
    );
  });

  it("rejects missing Info.plist files", async () => {
    const projectPath = makeProjectRoot();
    const appDir = writeAppBundle(projectPath, "build/Products/App.app");
    fs.unlinkSync(path.join(appDir, "Info.plist"));
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({ store });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.app",
      }),
      "invalid_bundle",
    );
  });

  it("rejects malformed bundle identifiers", async () => {
    const projectPath = makeProjectRoot();
    writeAppBundle(projectPath, "build/Products/App.app");
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({
      store,
      processOverrides: { readBundleId: "not-a-bundle-id\n" },
    });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.app",
      }),
      "invalid_bundle",
      (err) => assertPrepareAppBundleSanitized(err, "invalid_bundle"),
    );
  });

  it("rejects bundle aliases that resolve to non-.app directories", async () => {
    const projectPath = makeProjectRoot();
    const realDir = path.join(projectPath, "build", "Products", "RealBundle");
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, "Info.plist"), "bundle:com.example.App\n");
    fs.symlinkSync(realDir, path.join(projectPath, "build", "Products", "Alias.app"));
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({ store });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/Alias.app",
      }),
      "invalid_app_path",
      (err) => assertPrepareAppBundleSanitized(err, "invalid_app_path", [realDir]),
    );
  });

  it("sanitizes readBundleId failures as invalid_bundle", async () => {
    const projectPath = makeProjectRoot();
    writeAppBundle(projectPath, "build/Products/App.app");
    const infoPlist = path.join(projectPath, "build/Products/App.app/Info.plist");
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({
      store,
      processOverrides: {
        readBundleIdError: new Error(`plutil failed for ${infoPlist}\nstderr: bad`),
      },
    });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.app",
      }),
      "invalid_bundle",
      (err) =>
        assertPrepareAppBundleSanitized(err, "invalid_bundle", [infoPlist, "plutil"]),
    );
  });

  it("sanitizes missing project roots as unexpected without host paths", async () => {
    const missingPath = path.join(os.tmpdir(), `ios-missing-${Date.now()}`);
    const { store } = makeMutableStore({ projectPath: missingPath });
    const { service } = makeService({ store });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.app",
      }),
      "unexpected",
      (err) => assertPrepareAppBundleSanitized(err, "unexpected", [missingPath]),
    );
  });

  it("sanitizes project root realpath EACCES as unexpected", async () => {
    const projectPath = makeProjectRoot();
    writeAppBundle(projectPath, "build/Products/App.app");
    const { store } = makeMutableStore({ projectPath });
    const fsApi = {
      promises: {
        realpath: async (target) => {
          if (target === projectPath) {
            const err = new Error(`realpath '${target}' EACCES`);
            err.code = "EACCES";
            throw err;
          }
          return fs.promises.realpath(target);
        },
        lstat: fs.promises.lstat.bind(fs.promises),
        readdir: fs.promises.readdir.bind(fs.promises),
      },
    };
    const { service } = makeService({ store, fsApi });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.app",
      }),
      "unexpected",
      (err) => assertPrepareAppBundleSanitized(err, "unexpected", [projectPath]),
    );
  });

  it("sanitizes missing worktree roots as worktree_missing", async () => {
    const projectPath = makeProjectRoot();
    const missingWorktree = path.join(os.tmpdir(), `ios-wt-missing-${Date.now()}`);
    const { store } = makeMutableStore({
      projectPath,
      threadOverrides: { worktreePath: missingWorktree },
    });
    const { service } = makeService({
      store,
      prepareThreadWorktree: async ({ threadId }) => {
        store.updateThread(threadId, { worktreePath: missingWorktree });
      },
    });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.app",
      }),
      "worktree_missing",
      (err) =>
        assertPrepareAppBundleSanitized(err, "worktree_missing", [missingWorktree]),
    );
  });

  it("accepts bundles with exactly 20000 walked entries", async () => {
    const projectPath = makeProjectRoot();
    const appDir = writeAppBundle(projectPath, "build/Products/App.app");
    const bundlePath = await fs.promises.realpath(appDir);
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({
      store,
      fsApi: makeBundleWalkFsApi(bundlePath, 20_000),
    });
    const result = await service.prepareAppBundle({
      threadId: "t1",
      relativeAppPath: "build/Products/App.app",
    });
    assertFrozenDescriptor(result);
    assert.equal(result.bundleId, "com.example.App");
  });

  it("rejects bundles with more than 20000 walked entries", async () => {
    const projectPath = makeProjectRoot();
    const appDir = writeAppBundle(projectPath, "build/Products/App.app");
    const bundlePath = await fs.promises.realpath(appDir);
    const { store } = makeMutableStore({ projectPath });
    const { service } = makeService({
      store,
      fsApi: makeBundleWalkFsApi(bundlePath, 20_001),
    });
    await assertRejects(
      service.prepareAppBundle({
        threadId: "t1",
        relativeAppPath: "build/Products/App.app",
      }),
      "invalid_bundle",
      (err) => assertPrepareAppBundleSanitized(err, "invalid_bundle"),
    );
  });
});

const DEVICE_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const DEVICE_UDID_2 = "BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

function dualDeviceSimctlList(state1 = "Shutdown", state2 = "Shutdown") {
  return {
    runtimes: [
      {
        identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        name: "iOS 26.0",
        isAvailable: true,
      },
    ],
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
        {
          udid: DEVICE_UDID,
          name: "iPhone 17",
          state: state1,
          isAvailable: true,
        },
        {
          udid: DEVICE_UDID_2,
          name: "iPhone 16",
          state: state2,
          isAvailable: true,
        },
      ],
    },
  };
}

function bootedSimctlList(state) {
  return {
    runtimes: [
      {
        identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        name: "iOS 26.0",
        isAvailable: true,
      },
    ],
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
        {
          udid: DEVICE_UDID,
          name: "iPhone 17",
          state,
          isAvailable: true,
        },
      ],
    },
  };
}

function journalPath(userDataPath) {
  return path.join(userDataPath, "ios-simulator-lease.json");
}

function readJournal(userDataPath) {
  return JSON.parse(fs.readFileSync(journalPath(userDataPath), "utf8"));
}

function makeLeaseJournalFsApi({
  gateJournalWrite = null,
  gateJournalWriteOnAttempt = null,
  failJournalSync = false,
  failJournalSyncOnAttempt = null,
  failJournalSyncFromAttempt = null,
  failJournalSyncTimes = 0,
} = {}) {
  let journalWriteAttempts = 0;
  let journalSyncAttempts = 0;
  let journalSyncFailuresRemaining = failJournalSyncTimes;
  return {
    promises: {
      ...fs.promises,
      mkdir: fs.promises.mkdir,
      rename: fs.promises.rename,
      unlink: fs.promises.unlink,
      lstat: fs.promises.lstat,
      readFile: fs.promises.readFile,
      open: async (filePath, flags, mode) => {
        const handle = await fs.promises.open(filePath, flags, mode);
        const isLeaseJournal = String(filePath).includes("ios-simulator-lease.json");
        return {
          writeFile: async (data, encoding) => {
            if (isLeaseJournal) {
              journalWriteAttempts += 1;
              if (
                gateJournalWrite &&
                gateJournalWriteOnAttempt === journalWriteAttempts
              ) {
                await gateJournalWrite;
              }
            }
            return handle.writeFile(data, encoding);
          },
          sync: async () => {
            if (isLeaseJournal) {
              journalSyncAttempts += 1;
              if (journalSyncFailuresRemaining > 0) {
                journalSyncFailuresRemaining -= 1;
                throw new Error("journal sync failed");
              }
              if (failJournalSync) {
                if (
                  failJournalSyncOnAttempt === null ||
                  failJournalSyncOnAttempt === journalSyncAttempts
                ) {
                  throw new Error("journal sync failed");
                }
              }
              if (
                failJournalSyncFromAttempt !== null &&
                journalSyncAttempts >= failJournalSyncFromAttempt
              ) {
                throw new Error("journal sync failed");
              }
            }
            return handle.sync();
          },
          close: handle.close.bind(handle),
        };
      },
    },
  };
}

function assertLeaseProcessSanitized(err, message) {
  assert.equal(err.name, "IOSSimulatorError");
  assert.equal(err.code, "unexpected");
  assert.equal(err.message, message);
  assert.equal(err.details, undefined);
  assert.match(err.message, /^[A-Za-z].+/);
  assert.ok(!err.message.includes("/secret"));
  assert.ok(!err.message.includes("simctl"));
}

describe("parseLaunchPid", () => {
  const { parseLaunchPid } = require("../ios-simulator.js");

  it("parses an exact bundleId line from multiline output with warnings", () => {
    const output =
      "Warning: something\ncom.example.App: 4321\ncom.other.App: 99\n";
    assert.equal(parseLaunchPid("com.example.App", output), 4321);
  });

  it("returns null for unrelated successful output", () => {
    assert.equal(parseLaunchPid("com.example.App", "Launched\n"), null);
  });

  it("returns null when another bundleId line matches but not the requested one", () => {
    assert.equal(parseLaunchPid("com.example.App", "com.other.App: 99\n"), null);
  });

  it("returns null for error lines that resemble pid output", () => {
    assert.equal(
      parseLaunchPid("com.example.App", "com.example.App: not-a-pid\n"),
      null,
    );
  });
});

describe("createIOSSimulatorService lease", () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("first attach journals generation 1 with bootedBySolenta false", async () => {
    const userDataPath = makeUserDataPath();
    const { service } = makeService({
      userDataPath,
      store: makeLeaseStore(),
    });
    const result = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    assert.equal(result.generation, 1);
    assert.equal(result.deviceUdid, DEVICE_UDID);
    assert.equal(result.bootedBySolenta, false);
    const journal = readJournal(userDataPath);
    assert.equal(journal.version, 1);
    assert.equal(journal.state, "active");
    assert.equal(journal.generation, 1);
    assert.equal(journal.ownerThreadId, "t1");
    assert.equal(journal.ownerProjectId, "p1");
    assert.equal(journal.deviceUdid, DEVICE_UDID);
    assert.equal(journal.bootedBySolenta, false);
    assert.equal(journal.recording, null);
  });

  it("is idempotent for the same owner and device with no extra process calls", async () => {
    const { service, calls } = makeService({ store: makeLeaseStore() });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    const callsAfterFirst = calls.length;
    const second = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    assert.equal(second.generation, 1);
    assert.equal(calls.length, callsAfterFirst);
  });

  it("rejects attach from a different thread with device_busy", async () => {
    const { service, calls } = makeService({ store: makeLeaseStore() });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    const callsAfterFirst = calls.length;
    await assertRejects(
      service.attach({ threadId: "t2", deviceUdid: DEVICE_UDID }),
      "device_busy",
    );
    assert.equal(calls.length, callsAfterFirst);
  });

  it("rejects attach for an unknown device udid", async () => {
    const { service } = makeService({ store: makeLeaseStore() });
    await assertRejects(
      service.attach({ threadId: "t1", deviceUdid: "not-a-real-udid" }),
      "device_missing",
    );
  });

  it("boot on an already-booted device succeeds without booting and leaves bootedBySolenta false", async () => {
    const { service, calls } = makeService({
      store: makeLeaseStore(),
      processOverrides: { simctlList: bootedSimctlList("Booted") },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const result = await service.boot({
      threadId: "t1",
      generation: attached.generation,
    });
    assert.equal(result.bootedBySolenta, false);
    assert.equal(
      calls.some((c) => Array.isArray(c) && c[0] === "boot"),
      false,
    );
    assert.equal(
      calls.some((c) => Array.isArray(c) && c[0] === "bootStatus"),
      false,
    );
  });

  it("boot on a shutdown device boots, waits for bootstatus, and sets bootedBySolenta true", async () => {
    const userDataPath = makeUserDataPath();
    const { service, calls } = makeService({
      userDataPath,
      store: makeLeaseStore(),
      processOverrides: { simctlList: bootedSimctlList("Shutdown") },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const result = await service.boot({
      threadId: "t1",
      generation: attached.generation,
    });
    assert.equal(result.bootedBySolenta, true);
    const bootIndex = calls.findIndex(
      (c) => Array.isArray(c) && c[0] === "boot",
    );
    const bootStatusIndex = calls.findIndex(
      (c) => Array.isArray(c) && c[0] === "bootStatus",
    );
    assert.ok(bootIndex >= 0);
    assert.ok(bootStatusIndex > bootIndex);
    assert.deepEqual(calls[bootIndex], [
      "boot",
      DEFAULT_DEV_DIR,
      DEVICE_UDID,
    ]);
    const journal = readJournal(userDataPath);
    assert.equal(journal.bootedBySolenta, true);
  });

  it("rejects a stale generation before any process call", async () => {
    const { service, calls } = makeService({
      store: makeLeaseStore(),
      processOverrides: { simctlList: bootedSimctlList("Shutdown") },
    });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    const callsAfterAttach = calls.length;
    await assertRejects(
      service.boot({ threadId: "t1", generation: 0 }),
      "lease_stale",
    );
    assert.equal(calls.length, callsAfterAttach);
  });

  it("rejects mutating calls from a thread that never held the lease", async () => {
    const { service } = makeService({ store: makeLeaseStore() });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    await assertRejects(
      service.boot({ threadId: "t2", generation: 1 }),
      "lease_stale",
    );
  });

  it("takeover requires confirmed:true", async () => {
    const { service } = makeService({ store: makeLeaseStore() });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    await assertRejects(
      service.takeover({ threadId: "t2", deviceUdid: DEVICE_UDID }),
      "takeover_required",
    );
    await assertRejects(
      service.takeover({
        threadId: "t2",
        deviceUdid: DEVICE_UDID,
        confirmed: false,
      }),
      "takeover_required",
    );
  });

  it("takeover increments generation and transfers ownership", async () => {
    const userDataPath = makeUserDataPath();
    const { service } = makeService({
      userDataPath,
      store: makeLeaseStore(),
    });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    const result = await service.takeover({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
      confirmed: true,
    });
    assert.equal(result.generation, 2);
    const status = await service.getStatus({ threadId: "t2" });
    assert.equal(status.isOwner, true);
    assert.equal(status.generation, 2);
    const journal = readJournal(userDataPath);
    assert.equal(journal.state, "active");
    assert.equal(journal.generation, 2);
    assert.equal(journal.ownerThreadId, "t2");
  });

  it("synchronously invalidates the old generation before awaiting takeover cleanup, so a deferred old-owner action cannot mutate", async () => {
    const launchGate = deferred();
    const { service, calls } = makeService({
      store: makeLeaseStore(),
      processOverrides: { launchGate: launchGate.promise },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });

    const stalePromise = service.launch({
      threadId: "t1",
      generation: attached.generation,
      bundleId: "com.example.App",
    });
    // Mark as handled immediately; the real assertion happens below once
    // the gate is released. Without this, Node reports the eventual
    // rejection as unhandled during the awaited gap above.
    stalePromise.catch(() => {});

    // Let the queued mutation actually start and reach the process call
    // (where it suspends on launchGate) before takeover runs, so this test
    // proves a genuinely in-flight action is invalidated, not one that
    // never started.
    await flushMicrotasks();
    assert.ok(
      calls.some((c) => Array.isArray(c) && c[0] === "launch"),
      "expected the launch process call to have started",
    );

    // The old owner's launch call is now paused inside the adapter's
    // process call. Takeover must be able to complete without waiting for
    // it, proving the generation bump happens synchronously.
    const takeoverResult = await service.takeover({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
      confirmed: true,
    });
    assert.equal(takeoverResult.generation, 2);

    launchGate.resolve();
    await assertRejects(stalePromise, "lease_stale");

    const status = await service.getStatus({ threadId: "t2" });
    assert.equal(status.generation, 2);
    assert.equal(status.isOwner, true);
    assert.equal(
      calls.filter((c) => Array.isArray(c) && c[0] === "launch").length,
      1,
    );
  });

  it("rejects takeover against a different device", async () => {
    const { service } = makeService({ store: makeLeaseStore() });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    await assertRejects(
      service.takeover({
        threadId: "t2",
        deviceUdid: "other-device",
        confirmed: true,
      }),
      "device_busy",
    );
  });

  it("detach does not shut down a device Solenta did not boot", async () => {
    const userDataPath = makeUserDataPath();
    const { service, calls } = makeService({
      userDataPath,
      store: makeLeaseStore(),
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await service.detach({
      threadId: "t1",
      generation: attached.generation,
    });
    assert.equal(
      calls.some((c) => Array.isArray(c) && c[0] === "shutdown"),
      false,
    );
    assert.equal(fs.existsSync(journalPath(userDataPath)), false);
    const status = await service.getStatus({ threadId: "t1" });
    assert.equal(status.attached, false);
  });

  it("detach shuts down a device Solenta booted", async () => {
    const { service, calls } = makeService({
      store: makeLeaseStore(),
      processOverrides: { simctlList: bootedSimctlList("Shutdown") },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await service.boot({ threadId: "t1", generation: attached.generation });
    await service.detach({
      threadId: "t1",
      generation: attached.generation,
    });
    assert.deepEqual(
      calls.filter((c) => Array.isArray(c) && c[0] === "shutdown"),
      [["shutdown", DEFAULT_DEV_DIR, DEVICE_UDID]],
    );
  });

  it("install validates the lease, prepares the bundle, and returns only bundleId", async () => {
    const projectPath = makeProjectRoot();
    writeAppBundle(projectPath, "build/Products/App.app");
    const { store } = makeMutableStore({ projectPath });
    const { service, calls } = makeService({ store });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const result = await service.install({
      threadId: "t1",
      generation: attached.generation,
      relativeAppPath: "build/Products/App.app",
    });
    assert.deepEqual(Object.keys(result), ["bundleId"]);
    assert.equal(result.bundleId, "com.example.App");
    assert.equal(Object.isFrozen(result), true);
    const installCall = calls.find(
      (c) => Array.isArray(c) && c[0] === "install",
    );
    assert.ok(installCall);
    assert.equal(installCall[2], DEVICE_UDID);
  });

  it("rejects install for a stale generation before calling prepareAppBundle or the process adapter", async () => {
    const projectPath = makeProjectRoot();
    writeAppBundle(projectPath, "build/Products/App.app");
    const { store } = makeMutableStore({ projectPath });
    const { service, calls } = makeService({ store });
    await assertRejects(
      service.install({
        threadId: "t1",
        generation: 1,
        relativeAppPath: "build/Products/App.app",
      }),
      "lease_stale",
    );
    assert.equal(
      calls.some((c) => Array.isArray(c) && c[0] === "readBundleId"),
      false,
    );
    assert.equal(
      calls.some((c) => Array.isArray(c) && c[0] === "install"),
      false,
    );
  });

  it("parses the PID from simctl launch output", async () => {
    const { service } = makeService({
      store: makeLeaseStore(),
      processOverrides: { launchOutput: "com.example.App: 4321\n" },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const result = await service.launch({
      threadId: "t1",
      generation: attached.generation,
      bundleId: "com.example.App",
    });
    assert.equal(result.pid, 4321);
  });

  it("fails safe with pid:null for unknown-but-successful launch output", async () => {
    const { service } = makeService({
      store: makeLeaseStore(),
      processOverrides: { launchOutput: "Launched\n" },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const result = await service.launch({
      threadId: "t1",
      generation: attached.generation,
      bundleId: "com.example.App",
    });
    assert.equal(result.pid, null);
  });

  it("accepts a URL at exactly the 2048 character limit", async () => {
    const { service, calls } = makeService({ store: makeLeaseStore() });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const padding = "a".repeat(2048 - "https://example.com/?q=".length);
    const url = `https://example.com/?q=${padding}`;
    assert.equal(url.length, 2048);
    const result = await service.openUrl({
      threadId: "t1",
      generation: attached.generation,
      url,
    });
    assert.equal(result.opened, true);
    assert.ok(
      calls.some((c) => Array.isArray(c) && c[0] === "openUrl" && c[3] === url),
    );
  });

  it("rejects a URL over the 2048 character limit before any process call", async () => {
    const { service, calls } = makeService({ store: makeLeaseStore() });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const callsAfterAttach = calls.length;
    const padding = "a".repeat(2049 - "https://example.com/?q=".length);
    const url = `https://example.com/?q=${padding}`;
    assert.equal(url.length, 2049);
    await assertRejects(
      service.openUrl({
        threadId: "t1",
        generation: attached.generation,
        url,
      }),
      "invalid_url",
    );
    assert.equal(calls.length, callsAfterAttach);
  });

  for (const scheme of ["file", "javascript", "data", "about"]) {
    it(`rejects the blocked ${scheme}: URL scheme before any process call`, async () => {
      const { service, calls } = makeService({ store: makeLeaseStore() });
      const attached = await service.attach({
        threadId: "t1",
        deviceUdid: DEVICE_UDID,
      });
      const callsAfterAttach = calls.length;
      await assertRejects(
        service.openUrl({
          threadId: "t1",
          generation: attached.generation,
          url: `${scheme}:///something`,
        }),
        "invalid_url",
      );
      assert.equal(calls.length, callsAfterAttach);
    });
  }

  it("rejects a malformed URL", async () => {
    const { service } = makeService({ store: makeLeaseStore() });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await assertRejects(
      service.openUrl({
        threadId: "t1",
        generation: attached.generation,
        url: "not a url",
      }),
      "invalid_url",
    );
  });

  it("getStatus reports non-owner attachment without leaking process calls", async () => {
    const { service, calls } = makeService({ store: makeLeaseStore() });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    const callsAfterAttach = calls.length;
    const status = await service.getStatus({ threadId: "t2" });
    assert.equal(status.attached, true);
    assert.equal(status.state, "active");
    assert.equal(status.isOwner, false);
    assert.equal(calls.length, callsAfterAttach);
  });

  it("getStatus reports releasing transfer state while attached", async () => {
    const journalGate = deferred();
    const { service } = makeService({
      store: makeLeaseStore(),
      fsApi: makeLeaseJournalFsApi({
        gateJournalWrite: journalGate.promise,
        gateJournalWriteOnAttempt: 3,
      }),
    });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    const takeoverPromise = service.takeover({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
      confirmed: true,
    });
    await flushMicrotasks();
    const status = await service.getStatus({ threadId: "t2" });
    assert.equal(status.attached, true);
    assert.equal(status.state, "releasing");
    assert.equal(status.isOwner, true);
    journalGate.resolve();
    await takeoverPromise;
    const activeStatus = await service.getStatus({ threadId: "t2" });
    assert.equal(activeStatus.state, "active");
  });

  it("rejects attach while a transfer is in progress", async () => {
    const journalGate = deferred();
    const { service } = makeService({
      store: makeLeaseStore(),
      fsApi: makeLeaseJournalFsApi({
        gateJournalWrite: journalGate.promise,
        gateJournalWriteOnAttempt: 3,
      }),
    });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    const takeoverPromise = service.takeover({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
      confirmed: true,
    });
    await flushMicrotasks();
    await assertRejects(
      service.attach({ threadId: "t3", deviceUdid: DEVICE_UDID }),
      "device_busy",
    );
    journalGate.resolve();
    await takeoverPromise;
  });

  it("does not set in-memory lease before attach journal write succeeds", async () => {
    const attachGate = deferred();
    const { service } = makeService({
      store: makeLeaseStore(),
      fsApi: makeLeaseJournalFsApi({
        gateJournalWrite: attachGate.promise,
        gateJournalWriteOnAttempt: 1,
      }),
    });
    const attachPromise = service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await flushMicrotasks();
    await assertRejects(
      service.takeover({
        threadId: "t2",
        deviceUdid: DEVICE_UDID,
        confirmed: true,
      }),
      "lease_stale",
    );
    attachGate.resolve();
    await attachPromise;
  });

  it("takeover returns the fixed snapshot while the active journal write is delayed", async () => {
    const journalGate = deferred();
    const { service } = makeService({
      store: makeLeaseStore(),
      fsApi: makeLeaseJournalFsApi({
        gateJournalWrite: journalGate.promise,
        gateJournalWriteOnAttempt: 3,
      }),
    });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    const takeoverPromise = service.takeover({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
      confirmed: true,
    });
    await flushMicrotasks();
    const status = await service.getStatus({ threadId: "t2" });
    assert.equal(status.state, "releasing");
    journalGate.resolve();
    const result = await takeoverPromise;
    assert.equal(result.generation, 2);
    assert.equal(result.deviceUdid, DEVICE_UDID);
    assert.equal(result.bootedBySolenta, false);
  });

  it("never reuses a generation after detach and re-attach", async () => {
    const userDataPath = makeUserDataPath();
    const { service } = makeService({
      userDataPath,
      store: makeLeaseStore(),
    });
    const first = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    assert.equal(first.generation, 1);
    await service.detach({
      threadId: "t1",
      generation: first.generation,
    });
    const second = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    assert.equal(second.generation, 2);
    const journal = readJournal(userDataPath);
    assert.equal(journal.generation, 2);
  });

  it("burns a new generation on failed attach journal write without leaving an unjournaled lease", async () => {
    const userDataPath = makeUserDataPath();
    const { service } = makeService({
      userDataPath,
      store: makeLeaseStore(),
      fsApi: makeLeaseJournalFsApi({ failJournalSyncTimes: 5 }),
    });
    await assertRejects(
      service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID }),
      "unexpected",
      (err) => assert.equal(err.message, "Simulator lease journal is invalid"),
    );
    const status = await service.getStatus({ threadId: "t1" });
    assert.equal(status.attached, false);
    assert.equal(fs.existsSync(journalPath(userDataPath)), false);
    const second = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    assert.equal(second.generation, 2);
  });

  it("restores prior lease when takeover first journal write fails", async () => {
    const userDataPath = makeUserDataPath();
    const { service } = makeService({
      userDataPath,
      store: makeLeaseStore(),
      fsApi: makeLeaseJournalFsApi({ failJournalSyncFromAttempt: 2 }),
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await assertRejects(
      service.takeover({
        threadId: "t2",
        deviceUdid: DEVICE_UDID,
        confirmed: true,
      }),
      "unexpected",
    );
    const status = await service.getStatus({ threadId: "t1" });
    assert.equal(status.attached, true);
    assert.equal(status.state, "active");
    assert.equal(status.generation, attached.generation);
    const journal = readJournal(userDataPath);
    assert.equal(journal.ownerThreadId, "t1");
    assert.equal(journal.generation, 1);
  });

  it("keeps conservative releasing state when takeover rollback journal write fails", async () => {
    const userDataPath = makeUserDataPath();
    const { service } = makeService({
      userDataPath,
      store: makeLeaseStore(),
      fsApi: makeLeaseJournalFsApi({
        failJournalSyncFromAttempt: 3,
      }),
    });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    await assertRejects(
      service.takeover({
        threadId: "t2",
        deviceUdid: DEVICE_UDID,
        confirmed: true,
      }),
      "unexpected",
    );
    const status = await service.getStatus({ threadId: "t2" });
    assert.equal(status.attached, true);
    assert.equal(status.state, "releasing");
    assert.equal(status.generation, 2);
    const journal = readJournal(userDataPath);
    assert.equal(journal.state, "releasing");
    assert.equal(journal.ownerThreadId, "t2");
  });

  it("journals bootedBySolenta before simctl boot and rolls back on boot failure", async () => {
    const userDataPath = makeUserDataPath();
    let journalBootedBeforeBootCall = false;
    const { adapter: baseAdapter, calls } = makeProcessAdapter({
      simctlList: bootedSimctlList("Shutdown"),
      bootError: new Error("/secret/path/simctl boot failed"),
    });
    const adapter = {
      ...baseAdapter,
      boot: async (developerDir, udid) => {
        const journal = readJournal(userDataPath);
        journalBootedBeforeBootCall = journal.bootedBySolenta === true;
        return baseAdapter.boot(developerDir, udid);
      },
    };
    const { service } = makeService({
      userDataPath,
      store: makeLeaseStore(),
      processAdapter: adapter,
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await assertRejects(
      service.boot({
        threadId: "t1",
        generation: attached.generation,
      }),
      "unexpected",
      (err) =>
        assertLeaseProcessSanitized(err, "Failed to boot the simulator device"),
    );
    assert.equal(journalBootedBeforeBootCall, true);
    assert.ok(calls.some((c) => Array.isArray(c) && c[0] === "boot"));
    const status = await service.getStatus({ threadId: "t1" });
    assert.equal(status.bootedBySolenta, false);
    const journalAfter = readJournal(userDataPath);
    assert.equal(journalAfter.bootedBySolenta, false);
  });

  it("retains bootedBySolenta and shuts down on detach when bootStatus fails after boot succeeds", async () => {
    const userDataPath = makeUserDataPath();
    const { service, calls } = makeService({
      userDataPath,
      store: makeLeaseStore(),
      processOverrides: {
        simctlList: bootedSimctlList("Shutdown"),
        bootStatusError: new Error("/secret/simctl bootstatus timeout"),
      },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await assertRejects(
      service.boot({ threadId: "t1", generation: attached.generation }),
      "unexpected",
      (err) =>
        assert.equal(err.message, "Failed to wait for the simulator device to boot"),
    );
    const status = await service.getStatus({ threadId: "t1" });
    assert.equal(status.bootedBySolenta, true);
    const journal = readJournal(userDataPath);
    assert.equal(journal.bootedBySolenta, true);
    await service.detach({
      threadId: "t1",
      generation: attached.generation,
    });
    assert.deepEqual(
      calls.filter((c) => Array.isArray(c) && c[0] === "shutdown"),
      [["shutdown", DEFAULT_DEV_DIR, DEVICE_UDID]],
    );
  });

  it("does not roll back a new owner when takeover runs during simctl boot", async () => {
    const userDataPath = makeUserDataPath();
    const bootGate = deferred();
    const { service, calls } = makeService({
      userDataPath,
      store: makeLeaseStore(),
      processOverrides: {
        simctlList: bootedSimctlList("Shutdown"),
        bootGate: bootGate.promise,
      },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const bootPromise = service.boot({
      threadId: "t1",
      generation: attached.generation,
    });
    bootPromise.catch(() => {});
    await waitFor(() =>
      calls.some((c) => Array.isArray(c) && c[0] === "boot"),
    );
    assert.equal(readJournal(userDataPath).bootedBySolenta, true);
    const takeoverResult = await service.takeover({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
      confirmed: true,
    });
    assert.equal(takeoverResult.generation, 2);
    bootGate.resolve();
    await assertRejects(bootPromise, "lease_stale");
    const status = await service.getStatus({ threadId: "t2" });
    assert.equal(status.isOwner, true);
    assert.equal(status.generation, 2);
    assert.equal(status.bootedBySolenta, true);
    const journal = readJournal(userDataPath);
    assert.equal(journal.ownerThreadId, "t2");
    assert.equal(journal.generation, 2);
    assert.equal(journal.bootedBySolenta, true);
    await assertRejects(
      service.boot({ threadId: "t1", generation: attached.generation }),
      "lease_stale",
    );
  });

  it("does not roll back a new owner when takeover runs during bootStatus", async () => {
    const userDataPath = makeUserDataPath();
    const bootStatusGate = deferred();
    const { service, calls } = makeService({
      userDataPath,
      store: makeLeaseStore(),
      processOverrides: {
        simctlList: bootedSimctlList("Shutdown"),
        bootStatusGate: bootStatusGate.promise,
      },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const bootPromise = service.boot({
      threadId: "t1",
      generation: attached.generation,
    });
    bootPromise.catch(() => {});
    await waitFor(() =>
      calls.some((c) => Array.isArray(c) && c[0] === "bootStatus"),
    );
    const takeoverResult = await service.takeover({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
      confirmed: true,
    });
    assert.equal(takeoverResult.generation, 2);
    bootStatusGate.resolve();
    await assertRejects(bootPromise, "lease_stale");
    const status = await service.getStatus({ threadId: "t2" });
    assert.equal(status.isOwner, true);
    assert.equal(status.generation, 2);
    assert.equal(status.bootedBySolenta, true);
    const journal = readJournal(userDataPath);
    assert.equal(journal.ownerThreadId, "t2");
    assert.equal(journal.generation, 2);
    assert.equal(journal.bootedBySolenta, true);
    await assertRejects(
      service.boot({ threadId: "t1", generation: attached.generation }),
      "lease_stale",
    );
  });

  it("returns success for an already-booted device when activity journal write fails", async () => {
    const warnings = [];
    const { service, calls } = makeService({
      store: makeLeaseStore(),
      logger: { warn: (msg) => warnings.push(msg) },
      processOverrides: { simctlList: bootedSimctlList("Booted") },
      fsApi: makeLeaseJournalFsApi({ failJournalSyncFromAttempt: 2 }),
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const result = await service.boot({
      threadId: "t1",
      generation: attached.generation,
    });
    assert.equal(result.bootedBySolenta, false);
    assert.equal(
      calls.some((c) => Array.isArray(c) && c[0] === "boot"),
      false,
    );
    assert.ok(warnings.length >= 1);
  });

  it("rejects a URL whose normalized href exceeds 2048 characters", async () => {
    const segment = "😀".repeat(200);
    const raw = `https://example.com/${segment}`;
    assert.ok(raw.length < 2048);
    assert.ok(new URL(raw).href.length > 2048);
    const { service, calls } = makeService({ store: makeLeaseStore() });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const callsAfterAttach = calls.length;
    await assertRejects(
      service.openUrl({
        threadId: "t1",
        generation: attached.generation,
        url: raw,
      }),
      "invalid_url",
    );
    assert.equal(calls.length, callsAfterAttach);
  });

  it("rejects an openUrl whose normalized href exceeds 2048 before any process call", async () => {
    const segment = "\u00E9".repeat(700);
    const raw = `https://example.com/${segment}`;
    assert.ok(raw.length < 2048);
    assert.ok(new URL(raw).href.length > 2048);
    const { service, calls } = makeService({ store: makeLeaseStore() });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const callsAfterAttach = calls.length;
    await assertRejects(
      service.openUrl({
        threadId: "t1",
        generation: attached.generation,
        url: raw,
      }),
      "invalid_url",
    );
    assert.equal(calls.length, callsAfterAttach);
  });

  it("rejects a true stale generation after takeover", async () => {
    const { service, calls } = makeService({
      store: makeLeaseStore(),
      processOverrides: { simctlList: bootedSimctlList("Shutdown") },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await service.takeover({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
      confirmed: true,
    });
    const callsAfterTakeover = calls.length;
    await assertRejects(
      service.boot({ threadId: "t1", generation: attached.generation }),
      "lease_stale",
    );
    assert.equal(calls.length, callsAfterTakeover);
  });

  it("serializes concurrent mutations so detach waits for an in-flight boot", async () => {
    const bootGate = deferred();
    const { service, calls } = makeService({
      store: makeLeaseStore(),
      processOverrides: {
        simctlList: bootedSimctlList("Shutdown"),
        bootGate: bootGate.promise,
      },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const bootPromise = service.boot({
      threadId: "t1",
      generation: attached.generation,
    });
    await flushMicrotasks();
    const detachPromise = service.detach({
      threadId: "t1",
      generation: attached.generation,
    });
    await flushMicrotasks();
    assert.equal(
      calls.filter((c) => Array.isArray(c) && c[0] === "boot").length,
      0,
    );
    assert.equal(
      calls.filter((c) => Array.isArray(c) && c[0] === "shutdown").length,
      0,
    );
    bootGate.resolve();
    await bootPromise;
    await detachPromise;
    assert.deepEqual(
      calls.filter((c) => Array.isArray(c) && c[0] === "shutdown"),
      [["shutdown", DEFAULT_DEV_DIR, DEVICE_UDID]],
    );
  });

  it("rejects a deferred stale install after detach and re-attach to a different device", async () => {
    const prepareGate = deferred();
    const projectPath = makeProjectRoot();
    writeAppBundle(projectPath, "build/Products/App.app");
    const userDataPath = makeUserDataPath();
    const worktreeBase = path.join(userDataPath, "worktrees");
    const { store } = makeMutableStore({
      projectPath,
      threadOverrides: { pendingWorktree: true },
    });
    const { service, calls } = makeService({
      store,
      userDataPath,
      worktreeBase,
      processOverrides: { simctlList: dualDeviceSimctlList() },
      prepareThreadWorktree: async (opts) => {
        await prepareGate.promise;
        const wtPath = path.join(worktreeBase, "t1");
        fs.mkdirSync(wtPath, { recursive: true });
        writeAppBundle(wtPath, "build/Products/App.app");
        store.updateThread("t1", {
          worktreePath: wtPath,
          pendingWorktree: false,
        });
      },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const staleInstall = service.install({
      threadId: "t1",
      generation: attached.generation,
      relativeAppPath: "build/Products/App.app",
    });
    staleInstall.catch(() => {});
    await flushMicrotasks();
    await service.detach({
      threadId: "t1",
      generation: attached.generation,
    });
    const reattached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID_2,
    });
    assert.equal(reattached.generation, 2);
    assert.equal(reattached.deviceUdid, DEVICE_UDID_2);
    prepareGate.resolve();
    await assertRejects(staleInstall, "lease_stale");
    assert.equal(
      calls.filter((c) => Array.isArray(c) && c[0] === "install").length,
      0,
    );
  });

  it("sanitizes prepareThreadWorktree failures at the public install boundary", async () => {
    const projectPath = makeProjectRoot();
    writeAppBundle(projectPath, "build/Products/App.app");
    const { store } = makeMutableStore({
      projectPath,
      threadOverrides: { pendingWorktree: true },
    });
    const { service, calls } = makeService({
      store,
      prepareThreadWorktree: async () => {
        throw new Error("/secret/git/worktree failed");
      },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await assertRejects(
      service.install({
        threadId: "t1",
        generation: attached.generation,
        relativeAppPath: "build/Products/App.app",
      }),
      "unexpected",
      (err) => {
        assert.equal(err.message, "Failed to prepare the app bundle");
        assert.ok(!err.message.includes("/secret"));
        assert.ok(!err.message.includes("git"));
        return true;
      },
    );
    assert.equal(
      calls.some((c) => Array.isArray(c) && c[0] === "install"),
      false,
    );
  });

  it("returns success when post-install journal write fails", async () => {
    const projectPath = makeProjectRoot();
    writeAppBundle(projectPath, "build/Products/App.app");
    const { store } = makeMutableStore({ projectPath });
    const warnings = [];
    const { service } = makeService({
      store,
      logger: { warn: (msg) => warnings.push(msg) },
      fsApi: makeLeaseJournalFsApi({ failJournalSyncFromAttempt: 2 }),
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const result = await service.install({
      threadId: "t1",
      generation: attached.generation,
      relativeAppPath: "build/Products/App.app",
    });
    assert.equal(result.bundleId, "com.example.App");
    assert.ok(warnings.length >= 1);
  });

  it("returns success when post-launch journal write fails", async () => {
    const warnings = [];
    const { service } = makeService({
      store: makeLeaseStore(),
      logger: { warn: (msg) => warnings.push(msg) },
      fsApi: makeLeaseJournalFsApi({ failJournalSyncFromAttempt: 2 }),
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const result = await service.launch({
      threadId: "t1",
      generation: attached.generation,
      bundleId: "com.example.App",
    });
    assert.equal(result.pid, 4321);
    assert.ok(warnings.length >= 1);
  });

  it("returns success when post-openUrl journal write fails", async () => {
    const warnings = [];
    const { service } = makeService({
      store: makeLeaseStore(),
      logger: { warn: (msg) => warnings.push(msg) },
      fsApi: makeLeaseJournalFsApi({ failJournalSyncFromAttempt: 2 }),
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const result = await service.openUrl({
      threadId: "t1",
      generation: attached.generation,
      url: "https://example.com",
    });
    assert.equal(result.opened, true);
    assert.ok(warnings.length >= 1);
  });

  it("rejects ASCII control characters in URLs before any process call", async () => {
    const { service, calls } = makeService({ store: makeLeaseStore() });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const callsAfterAttach = calls.length;
    await assertRejects(
      service.openUrl({
        threadId: "t1",
        generation: attached.generation,
        url: "https://example.com/\x01evil",
      }),
      "invalid_url",
    );
    assert.equal(calls.length, callsAfterAttach);
  });

  it("passes normalized parsed.href to simctl openUrl", async () => {
    const { service, calls } = makeService({ store: makeLeaseStore() });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await service.openUrl({
      threadId: "t1",
      generation: attached.generation,
      url: "https://example.com/path",
    });
    const openCall = calls.find((c) => Array.isArray(c) && c[0] === "openUrl");
    assert.ok(openCall);
    assert.equal(openCall[3], "https://example.com/path");
  });

  for (const [name, processOverrides, message] of [
    [
      "boot",
      { simctlList: bootedSimctlList("Shutdown"), bootError: new Error("/secret/simctl boot") },
      "Failed to boot the simulator device",
    ],
    [
      "bootStatus",
      {
        simctlList: bootedSimctlList("Shutdown"),
        bootStatusError: new Error("/secret/simctl bootstatus"),
      },
      "Failed to wait for the simulator device to boot",
    ],
    [
      "install",
      { installError: new Error("/secret/simctl install") },
      "Failed to install the app bundle",
    ],
    [
      "shutdown",
      {
        simctlList: bootedSimctlList("Shutdown"),
        shutdownError: new Error("/secret/simctl shutdown"),
      },
      "Failed to shut down the simulator device",
    ],
    [
      "launch",
      { launchError: new Error("/secret/simctl launch") },
      "Failed to launch the app",
    ],
    [
      "openUrl",
      { openUrlError: new Error("/secret/simctl openurl") },
      "Failed to open the URL",
    ],
  ]) {
    it(`sanitizes ${name} process failures without leaking command paths`, async () => {
      const projectPath = makeProjectRoot();
      writeAppBundle(projectPath, "build/Products/App.app");
      const { store } = makeMutableStore({ projectPath });
      const overrides = { ...processOverrides };
      if (name === "shutdown" || name === "boot" || name === "bootStatus") {
        overrides.simctlList =
          overrides.simctlList ?? bootedSimctlList("Shutdown");
      }
      const { service } = makeService({
        store: overrides.installError ? store : makeLeaseStore(),
        processOverrides: overrides,
      });
      const attached = await service.attach({
        threadId: "t1",
        deviceUdid: DEVICE_UDID,
      });
      let promise;
      if (name === "boot" || name === "bootStatus") {
        promise = service.boot({
          threadId: "t1",
          generation: attached.generation,
        });
      } else if (name === "install") {
        promise = service.install({
          threadId: "t1",
          generation: attached.generation,
          relativeAppPath: "build/Products/App.app",
        });
      } else if (name === "shutdown") {
        await service.boot({
          threadId: "t1",
          generation: attached.generation,
        });
        promise = service.detach({
          threadId: "t1",
          generation: attached.generation,
        });
      } else if (name === "launch") {
        promise = service.launch({
          threadId: "t1",
          generation: attached.generation,
          bundleId: "com.example.App",
        });
      } else {
        promise = service.openUrl({
          threadId: "t1",
          generation: attached.generation,
          url: "https://example.com",
        });
      }
      await assertRejects(promise, "unexpected", (err) =>
        assertLeaseProcessSanitized(err, message),
      );
    });
  }
});

describe("createIOSSimulatorService screenshot", () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("captures a simulator screenshot artifact with metadata only", async () => {
    const { artifactStore, thread } = makeArtifactStore();
    const { service, calls } = makeService({
      store: makeLeaseStore(),
      artifactStore,
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const info = await service.captureScreenshot({
      threadId: thread.id,
      generation: attached.generation,
      runId: "r1",
      toolCallId: "tool1",
    });
    assert.equal(info.source, "simulator");
    assert.equal(info.kind, "image");
    assert.equal(info.mimeType, "image/png");
    assert.equal(info.runId, "r1");
    assert.equal(info.toolCallId, "tool1");
    assert.equal(info.name, "Simulator screenshot.png");
    assert.equal(info.path, undefined);
    assert.equal(info.threadId, thread.id);
    assert.match(info.id, /^[0-9a-f-]{36}$/i);
    const screenshotCall = calls.find(
      (c) => Array.isArray(c) && c[0] === "screenshot",
    );
    assert.ok(screenshotCall);
    assert.equal(screenshotCall[1], DEFAULT_DEV_DIR);
    assert.equal(screenshotCall[2], DEVICE_UDID);
    assert.ok(screenshotCall[3].includes(path.join("run-artifacts", ".staging")));
    const opened = await artifactStore.open({ id: info.id, threadId: thread.id });
    assert.ok(opened);
    assert.equal(opened.info.id, info.id);
  });

  it("does not discard staging after successful capture", async () => {
    const artifactStore = makeFakeArtifactStore();
    const { service } = makeService({
      store: makeLeaseStore(),
      artifactStore,
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await service.captureScreenshot({
      threadId: "t1",
      generation: attached.generation,
      runId: "r1",
    });
    assert.equal(artifactStore.discardCalls.length, 0);
    assert.equal(artifactStore.commitCalls.length, 1);
  });

  it("rejects screenshot when artifact store is unavailable", async () => {
    const { service } = makeService({ store: makeLeaseStore() });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await assertRejects(
      service.captureScreenshot({
        threadId: "t1",
        generation: attached.generation,
        runId: "r1",
      }),
      "unexpected",
      (err) => {
        assert.equal(err.message, "Simulator screenshot storage is unavailable");
        return true;
      },
    );
  });

  it("sanitizes stage failures without leaking host paths or calling downstream ops", async () => {
    const artifactStore = makeFakeArtifactStore();
    artifactStore.stage = async () => {
      throw new Error("mkdir '/secret/staging' ENOSPC");
    };
    const { service, calls } = makeService({
      store: makeLeaseStore(),
      artifactStore,
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await assertRejects(
      service.captureScreenshot({
        threadId: "t1",
        generation: attached.generation,
        runId: "r1",
      }),
      "unexpected",
      (err) => {
        assert.equal(err.message, "Failed to capture the simulator screenshot");
        assert.equal(err.details, undefined);
        assert.ok(!err.message.includes("/secret"));
        assert.ok(!err.message.includes("ENOSPC"));
        assert.ok(!err.message.includes("mkdir"));
        return true;
      },
    );
    assert.equal(artifactStore.commitCalls.length, 0);
    assert.equal(artifactStore.discardCalls.length, 0);
    assert.equal(
      calls.some((c) => Array.isArray(c) && c[0] === "screenshot"),
      false,
    );
  });

  it("commits manual screenshots under runId null", async () => {
    const { artifactStore, thread, artifactRoot } = makeArtifactStore();
    const { service } = makeService({
      store: makeLeaseStore(),
      artifactStore,
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const info = await service.captureScreenshot({
      threadId: thread.id,
      generation: attached.generation,
      runId: null,
    });
    assert.equal(info.runId, null);
    assert.equal(info.path, undefined);
    const opened = await artifactStore.open({ id: info.id, threadId: thread.id });
    assert.ok(opened);
    assert.equal(
      opened.path,
      path.join(artifactRoot, thread.id, "manual", `${info.id}.png`),
    );
  });

  it("rejects stale generation before staging or screenshot", async () => {
    const artifactStore = makeFakeArtifactStore();
    const { service, calls } = makeService({
      store: makeLeaseStore(),
      artifactStore,
    });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    await assertRejects(
      service.captureScreenshot({
        threadId: "t1",
        generation: 0,
        runId: "r1",
      }),
      "lease_stale",
    );
    assert.equal(artifactStore.stageCalls.length, 0);
    assert.equal(
      calls.some((c) => Array.isArray(c) && c[0] === "screenshot"),
      false,
    );
  });

  it("rejects non-owner screenshot before staging or screenshot", async () => {
    const artifactStore = makeFakeArtifactStore();
    const { service, calls } = makeService({
      store: makeLeaseStore(),
      artifactStore,
    });
    await service.attach({ threadId: "t1", deviceUdid: DEVICE_UDID });
    await assertRejects(
      service.captureScreenshot({
        threadId: "t2",
        generation: 1,
        runId: "r1",
      }),
      "lease_stale",
    );
    assert.equal(artifactStore.stageCalls.length, 0);
    assert.equal(
      calls.some((c) => Array.isArray(c) && c[0] === "screenshot"),
      false,
    );
  });

  it("discards staging when simctl screenshot fails", async () => {
    const artifactStore = makeFakeArtifactStore();
    const { service } = makeService({
      store: makeLeaseStore(),
      artifactStore,
      processOverrides: {
        screenshotError: new Error("/secret/simctl screenshot failed"),
      },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await assertRejects(
      service.captureScreenshot({
        threadId: "t1",
        generation: attached.generation,
        runId: "r1",
      }),
      "unexpected",
      (err) => {
        assert.equal(err.message, "Failed to capture the simulator screenshot");
        assert.equal(err.details, undefined);
        assert.ok(!err.message.includes("/secret"));
        assert.ok(!err.message.includes("simctl"));
        return true;
      },
    );
    assert.deepEqual(artifactStore.discardCalls, ["stage-token"]);
    assert.equal(artifactStore.commitCalls.length, 0);
  });

  it("preserves artifact_limit from commitBatch unchanged", async () => {
    const { artifactError } = require("../run-artifact-media.js");
    const artifactStore = makeFakeArtifactStore();
    artifactStore.commitBatch = async () => {
      throw artifactError("artifact_limit", "Thread artifact cap exceeded");
    };
    const { service } = makeService({
      store: makeLeaseStore(),
      artifactStore,
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await assert.rejects(
      service.captureScreenshot({
        threadId: "t1",
        generation: attached.generation,
        runId: "r1",
      }),
      (err) => {
        assert.equal(err.name, "RunArtifactError");
        assert.equal(err.code, "artifact_limit");
        assert.equal(err.message, "Thread artifact cap exceeded");
        return true;
      },
    );
    assert.deepEqual(artifactStore.discardCalls, ["stage-token"]);
  });

  it("rejects takeover during simctl screenshot before commit", async () => {
    const screenshotGate = deferred();
    const artifactStore = makeFakeArtifactStore();
    const { service, calls } = makeService({
      store: makeLeaseStore(),
      artifactStore,
      processOverrides: { screenshotGate: screenshotGate.promise },
    });
    const attached = await service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const screenshotPromise = service.captureScreenshot({
      threadId: "t1",
      generation: attached.generation,
      runId: "r1",
    });
    screenshotPromise.catch(() => {});
    await flushMicrotasks();
    assert.ok(
      calls.some((c) => Array.isArray(c) && c[0] === "screenshot"),
      "expected screenshot process call to have started",
    );
    const takeoverResult = await service.takeover({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
      confirmed: true,
    });
    assert.equal(takeoverResult.generation, 2);
    screenshotGate.resolve();
    await assertRejects(screenshotPromise, "lease_stale");
    assert.equal(artifactStore.commitCalls.length, 0);
    assert.deepEqual(artifactStore.discardCalls, ["stage-token"]);
  });
});

const STAGING_SEGMENTS = ["run-artifacts", ".staging"];

function stagingRootOf(userDataPath) {
  return path.join(userDataPath, ...STAGING_SEGMENTS);
}

async function settleAsync(times = 20) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Lets every pending real filesystem operation finish. Microtask draining alone
 * outruns a directory fsync, so a test that asserts a promise is *still*
 * pending has to give the disk a real chance to unblock it first.
 */
async function drainRealIo(ms = 60) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await settleAsync();
}

/**
 * Virtual timer wheel. `mode: "manual"` only fires timers when the test calls
 * `advance`; `mode: "auto"` fires each timer on the next macrotask, which keeps
 * recovery's bounded signal grace deterministic without wall-clock waits.
 */
function makeFakeTimers({ mode = "manual" } = {}) {
  let clock = 0;
  let nextId = 0;
  const pending = new Map();
  const cleared = [];

  function setTimer(fn, ms) {
    nextId += 1;
    const id = nextId;
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
    pending.set(id, { fn, at: clock + delay });
    if (mode === "auto") {
      setImmediate(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.fn();
      });
    }
    return id;
  }

  function clearTimer(id) {
    if (id == null) return;
    cleared.push(id);
    pending.delete(id);
  }

  async function advance(ms) {
    const target = clock + ms;
    for (;;) {
      let chosen = null;
      for (const [id, entry] of pending) {
        if (entry.at > target) continue;
        if (chosen === null || entry.at < chosen.entry.at || (entry.at === chosen.entry.at && id < chosen.id)) {
          chosen = { id, entry };
        }
      }
      if (chosen === null) break;
      pending.delete(chosen.id);
      clock = chosen.entry.at;
      chosen.entry.fn();
      await settleAsync();
    }
    clock = target;
    await settleAsync();
  }

  return {
    setTimer,
    clearTimer,
    advance,
    cleared,
    pendingCount: () => pending.size,
    clearedCount: () => cleared.length,
    duplicateClears: () =>
      cleared.length - new Set(cleared).size,
  };
}

/**
 * Fake `recordVideo` handle. `finalizeOnInterrupt` writes the MP4 bytes and
 * resolves `closed` the way `simctl io recordVideo` does on SIGINT.
 */
function makeRecorder(options = {}) {
  const {
    pid = 5150,
    mp4 = undefined,
    writesFile = true,
    finalizeOnInterrupt = true,
    closeImmediately = false,
    closeResult = { code: 0, signal: null },
    closeError = null,
  } = options;
  const state = {
    started: 0,
    interrupts: 0,
    outputPath: null,
    finalize: null,
    closeWithoutFile: null,
    fail: null,
  };
  const recordVideo = (_developerDir, _udid, output) => {
    state.started += 1;
    state.outputPath = output;
    let resolveClosed;
    let rejectClosed;
    const closed = new Promise((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    state.finalize = async () => {
      if (writesFile) {
        await fs.promises.writeFile(output, mp4 === undefined ? mp4Fixture() : mp4);
      }
      resolveClosed(closeResult);
    };
    state.closeWithoutFile = () => resolveClosed(closeResult);
    state.fail = (err) => rejectClosed(err ?? new Error("spawn failed"));
    if (closeImmediately) {
      // The recorder dies on its own the moment it is spawned.
      state.finalize().catch(() => {});
    }
    return Object.freeze({
      pid,
      closed,
      interrupt() {
        state.interrupts += 1;
        if (closeError) {
          state.fail(closeError);
          return;
        }
        if (finalizeOnInterrupt) {
          state.finalize().catch(() => {});
        }
      },
    });
  };
  return { state, recordVideo };
}

/**
 * `fsApi` shim that taps every lease-journal write, can force journal write
 * failures, can report a synthetic recording file size, and can fail unlinks.
 */
function makeRecordingFsApi({
  onJournalWrite = null,
  journalWriteError = null,
  gateJournalWrite = null,
  statSize = null,
  unlinkError = null,
  renameError = null,
} = {}) {
  const journalWrites = [];
  return {
    journalWrites,
    promises: {
      mkdir: (...args) => fs.promises.mkdir(...args),
      rename: async (from, to) => {
        if (typeof renameError === "function") {
          const err = renameError(String(from), String(to));
          if (err) throw err;
        }
        return fs.promises.rename(from, to);
      },
      readdir: (...args) => fs.promises.readdir(...args),
      lstat: (...args) => fs.promises.lstat(...args),
      readFile: (...args) => fs.promises.readFile(...args),
      realpath: (...args) => fs.promises.realpath(...args),
      writeFile: (...args) => fs.promises.writeFile(...args),
      stat: async (target) => {
        const stat = await fs.promises.stat(target);
        if (typeof statSize === "function") {
          const size = statSize(String(target), stat);
          if (typeof size === "number") {
            return {
              size,
              isFile: () => true,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            };
          }
        }
        return stat;
      },
      unlink: async (target) => {
        if (typeof unlinkError === "function") {
          const err = unlinkError(String(target));
          if (err) throw err;
        }
        return fs.promises.unlink(target);
      },
      open: async (filePath, flags, mode) => {
        const isJournal = String(filePath).includes("ios-simulator-lease.json");
        const handle = await fs.promises.open(filePath, flags, mode);
        return {
          writeFile: async (data, encoding) => {
            if (isJournal) {
              const parsed = JSON.parse(String(data));
              journalWrites.push(parsed);
              // Evaluate the gate before the observer so an observer that
              // reacts to this write cannot disarm its own gate.
              const gate =
                typeof gateJournalWrite === "function"
                  ? gateJournalWrite(parsed, journalWrites.length)
                  : null;
              if (onJournalWrite) onJournalWrite(parsed);
              if (typeof journalWriteError === "function") {
                const err = journalWriteError(parsed, journalWrites.length);
                if (err) throw err;
              }
              if (gate) await gate;
            }
            return handle.writeFile(data, encoding);
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    },
  };
}

function makeRecordingHarness(deps = {}) {
  const userDataPath = deps.userDataPath ?? makeUserDataPath();
  const artifacts = deps.fakeArtifactStore
    ? { artifactStore: deps.fakeArtifactStore }
    : makeArtifactStore({ userDataPath, limits: deps.limits });
  const recorder = deps.recorderInstance ?? makeRecorder(deps.recorder);
  const timers = makeFakeTimers({ mode: deps.timerMode ?? "manual" });
  /** @type {Array<[number, string]>} */
  const signals = [];
  const signalPid = (pid, signal) => {
    signals.push([pid, signal]);
    if (typeof deps.signalPidError === "function") {
      const err = deps.signalPidError(pid, signal);
      if (err) throw err;
      return;
    }
    if (deps.signalPidError) throw deps.signalPidError;
  };
  const { service, calls } = makeService({
    userDataPath,
    store: makeLeaseStore(),
    artifactStore: artifacts.artifactStore,
    processOverrides: {
      recordVideo: recorder.recordVideo,
      ...deps.processOverrides,
    },
    fsApi: deps.fsApi,
    randomUUID: deps.randomUUID,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    signalPid,
    now: deps.now,
    logger: deps.logger,
  });
  return {
    service,
    calls,
    recorder,
    timers,
    signals,
    artifactStore: artifacts.artifactStore,
    store: artifacts.store,
    userDataPath,
    stagingRoot: stagingRootOf(userDataPath),
  };
}

async function attachedRecordingHarness(deps = {}) {
  const harness = makeRecordingHarness(deps);
  const attached = await harness.service.attach({
    threadId: "t1",
    deviceUdid: DEVICE_UDID,
  });
  return { ...harness, generation: attached.generation };
}

function processCallNames(calls) {
  return calls
    .filter((call) => Array.isArray(call))
    .map((call) => call[0]);
}

function stagingEntries(userDataPath) {
  try {
    return fs.readdirSync(stagingRootOf(userDataPath));
  } catch {
    return [];
  }
}

function writeRecoveryJournal(userDataPath, overrides = {}) {
  fs.mkdirSync(userDataPath, { recursive: true });
  const record = {
    version: 1,
    state: "active",
    generation: 3,
    ownerThreadId: "t1",
    ownerProjectId: "p1",
    deviceUdid: DEVICE_UDID,
    developerDir: DEFAULT_DEV_DIR,
    bootedBySolenta: false,
    acquiredAt: 1000,
    lastActivityAt: 2000,
    helperPid: null,
    protocolToken: null,
    recording: null,
    ...overrides,
  };
  fs.writeFileSync(journalPath(userDataPath), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
  return record;
}

function stageRecoveryTempFile(userDataPath, name = "stale.bin") {
  const root = stagingRootOf(userDataPath);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, name);
  fs.writeFileSync(file, mp4Fixture());
  return file;
}

function recoveryRecording(tempPath, overrides = {}) {
  return {
    stagingToken: "stale-token",
    tempPath,
    pid: null,
    startedAt: 1500,
    runId: null,
    toolCallId: null,
    ...overrides,
  };
}

function corruptJournalFiles(userDataPath) {
  return fs
    .readdirSync(userDataPath)
    .filter((name) => name.startsWith("ios-simulator-lease.json.corrupt-"));
}

describe("createIOSSimulatorService recording", () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("journals a recording intent with pid null before spawn and the exact pid right after", async () => {
    const recorder = makeRecorder();
    /** @type {Array<{ pid: unknown, started: number }>} */
    const observed = [];
    const fsApi = makeRecordingFsApi({
      onJournalWrite: (record) => {
        if (!record.recording) return;
        observed.push({ pid: record.recording.pid, started: recorder.state.started });
      },
    });
    const harness = await attachedRecordingHarness({
      recorderInstance: recorder,
      fsApi,
    });
    const started = await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
      toolCallId: "tool1",
    });
    assert.equal(typeof started.recordingId, "string");
    assert.equal(observed.length >= 2, true);
    assert.equal(observed[0].pid, null);
    assert.equal(observed[0].started, 0);
    assert.equal(observed[1].pid, 5150);
    assert.equal(observed[1].started, 1);
    const journal = readJournal(harness.userDataPath);
    assert.equal(journal.recording.pid, 5150);
    assert.equal(journal.recording.runId, "r1");
    assert.equal(journal.recording.toolCallId, "tool1");
    assert.equal(
      journal.recording.tempPath.startsWith(harness.stagingRoot + path.sep),
      true,
    );
    await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
  });

  it("refuses a duplicate recording start while one is already running", async () => {
    const harness = await attachedRecordingHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await assertRejects(
      harness.service.startRecording({
        threadId: "t1",
        generation: harness.generation,
        runId: "r1",
      }),
      "recording_failed",
      (err) => {
        assert.equal(err.message, "A simulator recording is already running");
        return true;
      },
    );
    assert.equal(harness.recorder.state.started, 1);
    await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
  });

  it("serializes concurrent recording starts so only one spawn wins", async () => {
    const harness = await attachedRecordingHarness();
    const first = harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    const second = harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, "recording_failed");
    assert.equal(harness.recorder.state.started, 1);
    await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
  });

  it("stops with SIGINT, captures a poster, and commits video and poster in one batch", async () => {
    const harness = await attachedRecordingHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
      toolCallId: "tool1",
    });
    const result = await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    assert.equal(harness.recorder.state.interrupts, 1);
    assert.deepEqual(harness.signals, []);
    assert.equal(result.video.kind, "video");
    assert.equal(result.video.mimeType, "video/mp4");
    assert.equal(result.video.name, "Simulator recording.mp4");
    assert.equal(result.video.source, "simulator");
    assert.equal(result.video.runId, "r1");
    assert.equal(result.video.toolCallId, "tool1");
    assert.equal(result.poster.kind, "image");
    assert.equal(result.poster.mimeType, "image/png");
    assert.equal(result.poster.name, "Simulator recording poster.png");
    assert.equal(result.video.posterArtifactId, result.poster.id);
    const artifacts = harness.store.getRunArtifacts("t1");
    assert.equal(artifacts.length, 2);
    const posterCall = harness.calls.find(
      (call) => Array.isArray(call) && call[0] === "screenshot",
    );
    assert.ok(posterCall);
    assert.equal(posterCall[2], DEVICE_UDID);
    assert.ok(posterCall[3].startsWith(harness.stagingRoot + path.sep));
    assert.deepEqual(stagingEntries(harness.userDataPath), []);
  });

  it("returns frozen recording metadata without paths, tokens, or handles", async () => {
    const harness = await attachedRecordingHarness();
    const started = await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    assert.equal(Object.isFrozen(started), true);
    assert.deepEqual(Object.keys(started).sort(), ["recordingId", "startedAt"]);
    const result = await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(Object.keys(result).sort(), ["poster", "video"]);
    assert.equal(Object.isFrozen(result.video), true);
    for (const info of [result.video, result.poster]) {
      assert.equal(info.path, undefined);
      assert.equal(info.stagingToken, undefined);
      assert.equal(info.tempPath, undefined);
      assert.equal(info.pid, undefined);
      assert.equal(JSON.stringify(info).includes(harness.userDataPath), false);
    }
  });

  it("shares one finalization for repeated stop requests", async () => {
    const harness = await attachedRecordingHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    const first = harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    const second = harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b);
    assert.equal(harness.recorder.state.interrupts, 1);
    assert.equal(harness.store.getRunArtifacts("t1").length, 2);
    const third = await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    assert.equal(third, a);
    assert.equal(harness.store.getRunArtifacts("t1").length, 2);
  });

  it("rejects a stale generation stop without interrupting the recording", async () => {
    const harness = await attachedRecordingHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await assertRejects(
      harness.service.stopRecording({ threadId: "t1", generation: 99 }),
      "lease_stale",
    );
    assert.equal(harness.recorder.state.interrupts, 0);
    await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    assert.equal(harness.recorder.state.interrupts, 1);
  });

  it("rejects a non-owner stop so one thread cannot stop another recording", async () => {
    const harness = await attachedRecordingHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await assertRejects(
      harness.service.stopRecording({
        threadId: "t2",
        generation: harness.generation,
      }),
      "lease_stale",
    );
    assert.equal(harness.recorder.state.interrupts, 0);
    await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
  });

  it("auto-stops a recording after five minutes", async () => {
    const harness = await attachedRecordingHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await harness.timers.advance(5 * 60 * 1000);
    assert.equal(harness.recorder.state.interrupts, 1);
    // The timeout already drove finalization; stop only joins it.
    const result = await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    assert.equal(result.video.kind, "video");
    assert.equal(harness.recorder.state.interrupts, 1);
    assert.equal(harness.store.getRunArtifacts("t1").length, 2);
    const started = await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    assert.equal(typeof started.recordingId, "string");
    await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
  });

  it("interrupts and reports artifact_limit when the recording passes 250 MiB", async () => {
    const fsApi = makeRecordingFsApi({
      statSize: (target) =>
        target.includes(path.join("run-artifacts", ".staging"))
          ? 250 * 1024 * 1024 + 1
          : null,
    });
    const harness = await attachedRecordingHarness({ fsApi });
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await harness.timers.advance(1000);
    await assertRejects(
      harness.service.stopRecording({
        threadId: "t1",
        generation: harness.generation,
      }),
      "artifact_limit",
      (err) => {
        assert.equal(err.message, "Simulator recording exceeded its size limit");
        return true;
      },
    );
    assert.equal(harness.recorder.state.interrupts, 1);
    assert.equal(harness.store.getRunArtifacts("t1").length, 0);
    assert.deepEqual(stagingEntries(harness.userDataPath), []);
    assert.equal(processCallNames(harness.calls).includes("screenshot"), false);
  });

  it("does not trip the size cap at exactly 250 MiB", async () => {
    const fsApi = makeRecordingFsApi({
      statSize: (target) =>
        target.includes(path.join("run-artifacts", ".staging"))
          ? 250 * 1024 * 1024
          : null,
    });
    const harness = await attachedRecordingHarness({ fsApi });
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await harness.timers.advance(3000);
    assert.equal(harness.recorder.state.interrupts, 0);
    const result = await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    assert.equal(result.video.kind, "video");
  });

  it("sends SIGKILL and registers nothing when finalization times out", async () => {
    const harness = await attachedRecordingHarness({
      recorder: { pid: 6100, finalizeOnInterrupt: false },
    });
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    const stopped = harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    await harness.timers.advance(10_000);
    await assertRejects(stopped, "recording_finalize_failed", (err) => {
      assert.equal(err.message, "Failed to finalize the simulator recording");
      return true;
    });
    assert.deepEqual(harness.signals, [[-6100, "SIGKILL"]]);
    assert.equal(harness.store.getRunArtifacts("t1").length, 0);
    assert.deepEqual(stagingEntries(harness.userDataPath), []);
    assert.equal(processCallNames(harness.calls).includes("screenshot"), false);
  });

  it("registers neither video nor poster when the MP4 is corrupt", async () => {
    const harness = await attachedRecordingHarness({
      recorder: { mp4: Buffer.from("not-an-mp4-at-all") },
    });
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await assert.rejects(
      harness.service.stopRecording({
        threadId: "t1",
        generation: harness.generation,
      }),
      (err) => {
        assert.equal(err.name === "RunArtifactError" || err.name === "IOSSimulatorError", true);
        return true;
      },
    );
    assert.equal(harness.store.getRunArtifacts("t1").length, 0);
    assert.deepEqual(stagingEntries(harness.userDataPath), []);
  });

  it("clears the journalled recording after a successful stop", async () => {
    const harness = await attachedRecordingHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    assert.equal(readJournal(harness.userDataPath).recording, null);
  });

  it("clears recording timers exactly once and never fires them again", async () => {
    const harness = await attachedRecordingHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    assert.equal(harness.timers.pendingCount(), 0);
    assert.equal(harness.timers.duplicateClears(), 0);
    await harness.timers.advance(30 * 60 * 1000);
    assert.equal(harness.recorder.state.interrupts, 1);
    assert.equal(harness.store.getRunArtifacts("t1").length, 2);
  });

  it("sanitizes staging failures at start without spawning a recorder", async () => {
    const fakeStore = makeFakeArtifactStore();
    fakeStore.stage = async () => {
      throw new Error("mkdir '/secret/staging' ENOSPC");
    };
    const harness = await attachedRecordingHarness({ fakeArtifactStore: fakeStore });
    await assertRejects(
      harness.service.startRecording({
        threadId: "t1",
        generation: harness.generation,
        runId: "r1",
      }),
      "recording_failed",
      (err) => {
        assert.equal(err.message, "Failed to start the simulator recording");
        assert.equal(err.details, undefined);
        assert.ok(!err.message.includes("/secret"));
        assert.ok(!err.message.includes("ENOSPC"));
        return true;
      },
    );
    assert.equal(harness.recorder.state.started, 0);
    assert.equal(readJournal(harness.userDataPath).recording, null);
  });

  it("sanitizes recorder spawn failures and discards staging", async () => {
    const fakeStore = makeFakeArtifactStore();
    const harness = await attachedRecordingHarness({
      fakeArtifactStore: fakeStore,
      processOverrides: {
        recordVideoThrows: new Error("spawn /usr/bin/xcrun EACCES /secret"),
      },
    });
    await assertRejects(
      harness.service.startRecording({
        threadId: "t1",
        generation: harness.generation,
        runId: "r1",
      }),
      "recording_failed",
      (err) => {
        assert.equal(err.message, "Failed to start the simulator recording");
        assert.ok(!err.message.includes("/secret"));
        assert.ok(!err.message.includes("xcrun"));
        return true;
      },
    );
    assert.deepEqual(fakeStore.discardCalls, ["stage-token"]);
    assert.equal(fakeStore.commitCalls.length, 0);
    assert.equal(readJournal(harness.userDataPath).recording, null);
  });

  it("sanitizes intent journal write failures without spawning a recorder", async () => {
    const fakeStore = makeFakeArtifactStore();
    const fsApi = makeRecordingFsApi({
      journalWriteError: (record) =>
        record.recording ? new Error("/secret journal sync failed") : null,
    });
    const harness = await attachedRecordingHarness({
      fakeArtifactStore: fakeStore,
      fsApi,
    });
    await assertRejects(
      harness.service.startRecording({
        threadId: "t1",
        generation: harness.generation,
        runId: "r1",
      }),
      "unexpected",
      (err) => {
        assert.equal(err.message, "Simulator lease journal is invalid");
        assert.ok(!err.message.includes("/secret"));
        return true;
      },
    );
    assert.equal(harness.recorder.state.started, 0);
    assert.deepEqual(fakeStore.discardCalls, ["stage-token"]);
  });

  it("discards staging and registers nothing when the recorder reports no pid", async () => {
    const fakeStore = makeFakeArtifactStore();
    const harness = await attachedRecordingHarness({
      fakeArtifactStore: fakeStore,
      processOverrides: {
        recordVideo: () =>
          Object.freeze({
            pid: undefined,
            closed: Promise.resolve({ code: 0, signal: null }),
            interrupt() {},
          }),
      },
    });
    await assertRejects(
      harness.service.startRecording({
        threadId: "t1",
        generation: harness.generation,
        runId: "r1",
      }),
      "recording_failed",
    );
    assert.deepEqual(fakeStore.discardCalls, ["stage-token"]);
    assert.equal(fakeStore.commitCalls.length, 0);
    assert.equal(readJournal(harness.userDataPath).recording, null);
  });

  it("does not leave an unhandled rejection when the recorder process fails", async () => {
    const harness = await attachedRecordingHarness({
      recorder: { closeError: new Error("/secret spawn ENOENT") },
    });
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await assertRejects(
      harness.service.stopRecording({
        threadId: "t1",
        generation: harness.generation,
      }),
      "recording_finalize_failed",
      (err) => {
        assert.ok(!err.message.includes("/secret"));
        return true;
      },
    );
    await settleAsync();
    assert.equal(harness.store.getRunArtifacts("t1").length, 0);
    assert.deepEqual(stagingEntries(harness.userDataPath), []);
  });

  it("falls back to the recorder pid when the process group signal is unavailable", async () => {
    const harness = await attachedRecordingHarness({
      recorder: { pid: 6200, finalizeOnInterrupt: false },
      signalPidError: (pid) =>
        pid < 0 ? Object.assign(new Error("ESRCH"), { code: "ESRCH" }) : null,
    });
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    const stopped = harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    await harness.timers.advance(10_000);
    await assertRejects(stopped, "recording_finalize_failed");
    assert.deepEqual(harness.signals, [
      [-6200, "SIGKILL"],
      [6200, "SIGKILL"],
    ]);
  });

  it("reports artifact_limit even when the oversized recorder ignores SIGINT", async () => {
    const fsApi = makeRecordingFsApi({
      statSize: (target) =>
        target.includes(path.join("run-artifacts", ".staging"))
          ? 250 * 1024 * 1024 + 1
          : null,
    });
    const harness = await attachedRecordingHarness({
      fsApi,
      recorder: { pid: 6300, finalizeOnInterrupt: false },
    });
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await harness.timers.advance(1000);
    assert.equal(harness.recorder.state.interrupts, 1);
    await harness.timers.advance(10_000);
    assert.deepEqual(harness.signals, [[-6300, "SIGKILL"]]);
    // The terminal error is the size cap, not the forced-kill failure, and it
    // replays for every later stop of the same recording.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assertRejects(
        harness.service.stopRecording({
          threadId: "t1",
          generation: harness.generation,
        }),
        "artifact_limit",
        (err) => {
          assert.equal(
            err.message,
            "Simulator recording exceeded its size limit",
          );
          return true;
        },
      );
    }
    assert.equal(harness.store.getRunArtifacts("t1").length, 0);
    assert.deepEqual(stagingEntries(harness.userDataPath), []);
    assert.equal(processCallNames(harness.calls).includes("screenshot"), false);
  });

  it("auto-finalizes and retires the recording when the recorder exits early", async () => {
    let uuids = 0;
    const harness = await attachedRecordingHarness({
      randomUUID: () => `uuid-${(uuids += 1)}`,
      recorder: { pid: 6400, closeImmediately: true, writesFile: false },
    });
    const started = await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    // No stop call drove any of this: the journal already has no stale pid and
    // both timers are gone well before the five-minute auto-stop.
    await waitFor(() => readJournal(harness.userDataPath).recording === null);
    assert.equal(harness.timers.pendingCount(), 0);
    assert.equal(harness.timers.duplicateClears(), 0);
    // Awaiting the memoized outcome only observes the teardown the early exit
    // started; it cannot begin a second one. A recorder that produced no bytes
    // is a failed recording, not an oversized one.
    await assertRejects(
      harness.service.stopRecording({
        threadId: "t1",
        generation: harness.generation,
      }),
      "recording_failed",
      (err) => {
        assert.equal(err.message, "The simulator recording produced no video");
        return true;
      },
    );
    assert.equal(harness.store.getRunArtifacts("t1").length, 0);
    assert.deepEqual(stagingEntries(harness.userDataPath), []);
    const next = await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    assert.notEqual(next.recordingId, started.recordingId);
    await assertRejects(
      harness.service.stopRecording({
        threadId: "t1",
        generation: harness.generation,
      }),
      "recording_failed",
    );
    assert.equal(readJournal(harness.userDataPath).recording, null);
  });

  it("reports recording_failed when the recorder never wrote its output file", async () => {
    const harness = await attachedRecordingHarness({
      recorder: { pid: 6800, writesFile: false },
    });
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    // The staged file is removed outright, so the stop path sees no output at
    // all rather than an empty one.
    await fs.promises.unlink(harness.recorder.state.outputPath);
    await assertRejects(
      harness.service.stopRecording({
        threadId: "t1",
        generation: harness.generation,
      }),
      "recording_failed",
      (err) => {
        assert.equal(err.message, "The simulator recording produced no video");
        assert.equal(err.details, undefined);
        assert.equal(err.message.includes(harness.userDataPath), false);
        return true;
      },
    );
    assert.equal(harness.store.getRunArtifacts("t1").length, 0);
    assert.deepEqual(stagingEntries(harness.userDataPath), []);
    assert.equal(processCallNames(harness.calls).includes("screenshot"), false);
    assert.equal(readJournal(harness.userDataPath).recording, null);
  });

  it("commits a valid recording that the recorder finalized on its own", async () => {
    const harness = await attachedRecordingHarness({
      recorder: { pid: 6500, closeImmediately: true },
    });
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await waitFor(() => harness.store.getRunArtifacts("t1").length === 2);
    const replayed = await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    assert.equal(replayed.video.kind, "video");
    assert.equal(replayed.poster.kind, "image");
    assert.equal(replayed.video.posterArtifactId, replayed.poster.id);
    assert.equal(harness.store.getRunArtifacts("t1").length, 2);
    assert.equal(readJournal(harness.userDataPath).recording, null);
  });

  it("keeps takeover pending until the superseded recorder is stopped and discarded", async () => {
    const gate = deferred();
    /** @type {{ service: any, transfer: Promise<any> | null, settled: boolean }} */
    const ref = { service: null, transfer: null, settled: false };
    let pidWrites = 0;
    let uuids = 0;
    const fsApi = makeRecordingFsApi({
      gateJournalWrite: (record) =>
        record.recording && record.recording.pid != null && pidWrites === 0
          ? gate.promise
          : null,
      onJournalWrite: (record) => {
        if (!record.recording || record.recording.pid == null) return;
        pidWrites += 1;
        if (pidWrites !== 1) return;
        ref.transfer = ref.service.takeover({
          threadId: "t2",
          deviceUdid: DEVICE_UDID,
          confirmed: true,
        });
        ref.transfer.then(
          () => {
            ref.settled = true;
          },
          () => {
            ref.settled = true;
          },
        );
      },
    });
    const harness = await attachedRecordingHarness({
      fsApi,
      randomUUID: () => `uuid-${(uuids += 1)}`,
      recorder: { pid: 6600, finalizeOnInterrupt: false },
    });
    ref.service = harness.service;
    const startPromise = harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    startPromise.catch(() => {});
    // Phase A: the gate holds the pid write open with the takeover already
    // begun, so the on-disk journal is still the pre-spawn intent — enough for
    // recovery to reclaim the temp file if the app died right here.
    await waitFor(() => pidWrites === 1);
    assert.equal(ref.settled, false);
    const intentJournal = readJournal(harness.userDataPath);
    assert.ok(intentJournal.recording);
    assert.equal(intentJournal.recording.pid, null);
    assert.ok(
      intentJournal.recording.tempPath.startsWith(harness.stagingRoot + path.sep),
    );

    gate.resolve();
    // Phase B: drain everything that can proceed without the virtual clock. The
    // takeover must still be pending, because its only remaining blocker is the
    // held-open recorder it is now responsible for stopping. Both journal writes
    // land in call order, so the takeover's record wins on disk and still
    // describes a recoverable recording with the exact pid rather than being
    // clobbered back to the superseded owner.
    await waitFor(() => readJournal(harness.userDataPath).generation === 2);
    await drainRealIo();
    assert.equal(ref.settled, false, "takeover must await the old recorder");
    const handoffJournal = readJournal(harness.userDataPath);
    assert.equal(handoffJournal.generation, 2);
    assert.equal(handoffJournal.ownerThreadId, "t2");
    assert.equal(handoffJournal.state, "releasing");
    assert.equal(handoffJournal.recording.pid, 6600);
    assert.equal(harness.recorder.state.interrupts, 1);

    // Phase C: the held-open child is force-killed, then the transfer publishes.
    await harness.timers.advance(10_000);
    await assertRejects(startPromise, "lease_stale");
    const transferred = await ref.transfer;
    assert.equal(transferred.generation, 2);
    // The forced stop targets the recorder's process group, not just its pid.
    assert.deepEqual(harness.signals, [[-6600, "SIGKILL"]]);
    assert.deepEqual(stagingEntries(harness.userDataPath), []);
    assert.equal(harness.store.getRunArtifacts("t1").length, 0);
    // The superseded owner's in-flight pid write cannot land on top of the new
    // owner's record, no matter which write finishes its rename last.
    await drainRealIo();
    const finalJournal = readJournal(harness.userDataPath);
    assert.equal(finalJournal.state, "active");
    assert.equal(finalJournal.ownerThreadId, "t2");
    assert.equal(finalJournal.generation, 2);
    assert.equal(finalJournal.recording, null);
    await assertRejects(
      harness.service.stopRecording({ threadId: "t2", generation: 2 }),
      "recording_failed",
    );
  });

  it("stops and discards a spawned recorder when the pid journal write fails", async () => {
    let failPidWrite = true;
    const harness = await attachedRecordingHarness({
      recorder: { pid: 6700 },
      fsApi: makeRecordingFsApi({
        journalWriteError: (record) =>
          failPidWrite && record.recording && record.recording.pid != null
            ? Object.assign(new Error("EIO"), { code: "EIO" })
            : null,
      }),
    });
    await assertRejects(
      harness.service.startRecording({
        threadId: "t1",
        generation: harness.generation,
        runId: "r1",
      }),
      "unexpected",
      (err) => {
        assert.equal(err.message, "Simulator lease journal is invalid");
        return true;
      },
    );
    assert.equal(harness.recorder.state.interrupts, 1);
    assert.equal(harness.store.getRunArtifacts("t1").length, 0);
    assert.deepEqual(stagingEntries(harness.userDataPath), []);
    assert.equal(harness.timers.pendingCount(), 0);
    assert.equal(readJournal(harness.userDataPath).recording, null);
    // A start that never returned leaves nothing to replay.
    await assertRejects(
      harness.service.stopRecording({
        threadId: "t1",
        generation: harness.generation,
      }),
      "recording_failed",
      (err) => {
        assert.equal(err.message, "No simulator recording is active");
        return true;
      },
    );
    failPidWrite = false;
    const restarted = await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    assert.equal(typeof restarted.recordingId, "string");
    await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
  });

  it("does not replay a previous owner's stop result after detach and re-attach", async () => {
    const harness = await attachedRecordingHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    await harness.service.detach({
      threadId: "t1",
      generation: harness.generation,
    });
    const reattached = await harness.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    assert.equal(reattached.generation, 2);
    await assertRejects(
      harness.service.stopRecording({
        threadId: "t1",
        generation: reattached.generation,
      }),
      "recording_failed",
      (err) => {
        assert.equal(err.message, "No simulator recording is active");
        return true;
      },
    );
    const restarted = await harness.service.startRecording({
      threadId: "t1",
      generation: reattached.generation,
      runId: "r2",
    });
    assert.equal(typeof restarted.recordingId, "string");
    await harness.service.stopRecording({
      threadId: "t1",
      generation: reattached.generation,
    });
  });

  it("registers nothing when a takeover lands during the pid journal write", async () => {
    const fakeStore = makeFakeArtifactStore();
    /** @type {{ service: any, transfer: Promise<any> | null }} */
    const ref = { service: null, transfer: null };
    let counter = 0;
    const fsApi = makeRecordingFsApi({
      onJournalWrite: (record) => {
        if (!record.recording || record.recording.pid == null) return;
        if (ref.transfer) return;
        // `takeover` invalidates the old generation synchronously before its
        // first await, so this lands while the pid write is still in flight.
        ref.transfer = ref.service.takeover({
          threadId: "t2",
          deviceUdid: DEVICE_UDID,
          confirmed: true,
        });
        ref.transfer.catch(() => {});
      },
    });
    const harness = await attachedRecordingHarness({
      fakeArtifactStore: fakeStore,
      fsApi,
      randomUUID: () => `uuid-${(counter += 1)}`,
    });
    ref.service = harness.service;
    await assertRejects(
      harness.service.startRecording({
        threadId: "t1",
        generation: harness.generation,
        runId: "r1",
      }),
      "lease_stale",
    );
    const transferred = await ref.transfer;
    assert.equal(transferred.generation, 2);
    assert.equal(harness.recorder.state.interrupts, 1);
    assert.deepEqual(fakeStore.discardCalls, ["stage-token"]);
    assert.equal(fakeStore.commitCalls.length, 0);
    await assertRejects(
      harness.service.stopRecording({ threadId: "t2", generation: 2 }),
      "recording_failed",
      (err) => {
        assert.equal(err.message, "No simulator recording is active");
        return true;
      },
    );
  });

  it("reports no active recording for a stop after a failed start", async () => {
    const fakeStore = makeFakeArtifactStore();
    const harness = await attachedRecordingHarness({ fakeArtifactStore: fakeStore });
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    fakeStore.stage = async () => {
      throw new Error("stage unavailable");
    };
    await assertRejects(
      harness.service.startRecording({
        threadId: "t1",
        generation: harness.generation,
        runId: "r1",
      }),
      "recording_failed",
    );
    await assertRejects(
      harness.service.stopRecording({
        threadId: "t1",
        generation: harness.generation,
      }),
      "recording_failed",
      (err) => {
        assert.equal(err.message, "No simulator recording is active");
        return true;
      },
    );
  });

  it("takeover finalizes the previous recording before publishing the transfer", async () => {
    const harness = await attachedRecordingHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    const transferred = await harness.service.takeover({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
      confirmed: true,
    });
    assert.equal(transferred.generation, 2);
    assert.equal(harness.recorder.state.interrupts, 1);
    assert.equal(harness.store.getRunArtifacts("t1").length, 2);
    const journal = readJournal(harness.userDataPath);
    assert.equal(journal.state, "active");
    assert.equal(journal.ownerThreadId, "t2");
    assert.equal(journal.generation, 2);
    assert.equal(journal.recording, null);
    await assertRejects(
      harness.service.stopRecording({
        threadId: "t1",
        generation: harness.generation,
      }),
      "lease_stale",
    );
    assert.equal(harness.recorder.state.interrupts, 1);
  });

  it("detach finalizes an active recording before shutting the device down", async () => {
    const harness = await attachedRecordingHarness({
      processOverrides: { simctlList: bootedSimctlList("Shutdown") },
    });
    await harness.service.boot({
      threadId: "t1",
      generation: harness.generation,
    });
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await harness.service.detach({
      threadId: "t1",
      generation: harness.generation,
    });
    const names = processCallNames(harness.calls);
    const recordIndex = names.indexOf("recordVideo");
    const posterIndex = names.indexOf("screenshot");
    const shutdownIndex = names.indexOf("shutdown");
    assert.ok(recordIndex >= 0 && posterIndex > recordIndex);
    assert.ok(shutdownIndex > posterIndex);
    assert.equal(harness.recorder.state.interrupts, 1);
    assert.equal(harness.store.getRunArtifacts("t1").length, 2);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
  });

  it("preserves artifact_limit from commitBatch and discards both staging tokens", async () => {
    const { artifactError } = require("../run-artifact-media.js");
    const fakeStore = makeFakeArtifactStore();
    let staged = 0;
    fakeStore.stage = async (opts) => {
      staged += 1;
      fakeStore.stageCalls.push(opts);
      return { token: `stage-token-${staged}`, path: path.join(os.tmpdir(), `ios-sim-fake-${staged}.bin`) };
    };
    fakeStore.commitBatch = async (batch) => {
      fakeStore.commitCalls.push(batch);
      throw artifactError("artifact_limit", "Thread artifact cap exceeded");
    };
    const harness = await attachedRecordingHarness({ fakeArtifactStore: fakeStore });
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    await assert.rejects(
      harness.service.stopRecording({
        threadId: "t1",
        generation: harness.generation,
      }),
      (err) => {
        assert.equal(err.name, "RunArtifactError");
        assert.equal(err.code, "artifact_limit");
        assert.equal(err.message, "Thread artifact cap exceeded");
        return true;
      },
    );
    assert.deepEqual(fakeStore.discardCalls.sort(), [
      "stage-token-1",
      "stage-token-2",
    ]);
  });

  it("commits one batch whose items keep video-then-poster order with a poster relation", async () => {
    const fakeStore = makeFakeArtifactStore();
    let staged = 0;
    fakeStore.stage = async (opts) => {
      staged += 1;
      fakeStore.stageCalls.push(opts);
      return { token: `stage-token-${staged}`, path: path.join(os.tmpdir(), `ios-sim-batch-${staged}.bin`) };
    };
    fakeStore.commitBatch = async (batch) => {
      fakeStore.commitCalls.push(batch);
      return batch.items.map((item, index) => ({
        id: `artifact-${index}`,
        threadId: batch.threadId,
        runId: batch.runId,
        source: batch.source,
        kind: item.kind,
        mimeType: item.mimeType,
        name: item.name,
        size: 10,
        createdAt: "2026-08-25T12:00:00.000Z",
      }));
    };
    const harness = await attachedRecordingHarness({ fakeArtifactStore: fakeStore });
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
      toolCallId: "tool9",
    });
    await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    assert.equal(fakeStore.commitCalls.length, 1);
    const batch = fakeStore.commitCalls[0];
    assert.equal(batch.source, "simulator");
    assert.equal(batch.threadId, "t1");
    assert.equal(batch.runId, "r1");
    assert.equal(batch.toolCallId, "tool9");
    assert.deepEqual(
      batch.items.map((item) => item.key),
      ["video", "poster"],
    );
    assert.equal(batch.items[0].posterKey, "poster");
    assert.equal(batch.items[0].kind, "video");
    assert.equal(batch.items[1].kind, "image");
    assert.equal(batch.items[0].path, undefined);
  });
});

describe("createIOSSimulatorService recovery", () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("recovers nothing when no journal exists", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, false);
    assert.equal(summary.quarantined, false);
    assert.equal(Object.isFrozen(summary), true);
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.signals, []);
  });

  it("quarantines a malformed journal with zero inspect, signal, or simctl calls", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    fs.mkdirSync(harness.userDataPath, { recursive: true });
    fs.writeFileSync(journalPath(harness.userDataPath), "{not json at all");
    const summary = await harness.service.recover();
    assert.equal(summary.quarantined, true);
    assert.equal(summary.recovered, false);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
    const quarantined = corruptJournalFiles(harness.userDataPath);
    assert.equal(quarantined.length, 1);
    assert.match(quarantined[0], /\.corrupt-\d+-[A-Za-z0-9-]+$/);
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.signals, []);
  });

  it("never overwrites an earlier quarantined journal", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto", now: () => 4242 });
    fs.mkdirSync(harness.userDataPath, { recursive: true });
    fs.writeFileSync(journalPath(harness.userDataPath), "{first corrupt");
    const first = await harness.service.recover();
    assert.equal(first.quarantined, true);
    fs.writeFileSync(journalPath(harness.userDataPath), "{second corrupt");
    const second = await harness.service.recover();
    assert.equal(second.quarantined, true);
    const quarantined = corruptJournalFiles(harness.userDataPath);
    assert.equal(quarantined.length, 2);
    const bodies = quarantined
      .map((name) =>
        fs.readFileSync(path.join(harness.userDataPath, name), "utf8"),
      )
      .sort();
    assert.deepEqual(bodies, ["{first corrupt", "{second corrupt"]);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.signals, []);
  });

  it("quarantines a tampered journal carrying unknown fields", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    writeRecoveryJournal(harness.userDataPath, { eraseDevice: true });
    const summary = await harness.service.recover();
    assert.equal(summary.quarantined, true);
    assert.equal(corruptJournalFiles(harness.userDataPath).length, 1);
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.signals, []);
  });

  it("quarantines a journal whose recording temp path escapes the staging root", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    const outside = path.join(harness.userDataPath, "run-artifacts", "escaped.bin");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, mp4Fixture());
    writeRecoveryJournal(harness.userDataPath, {
      recording: recoveryRecording(outside, { pid: 7000 }),
    });
    const summary = await harness.service.recover();
    assert.equal(summary.quarantined, true);
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.signals, []);
    assert.equal(fs.existsSync(outside), true);
  });

  it("restores the generation high-water mark before quarantining a tampered temp path", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    const outside = path.join(harness.userDataPath, "escaped.bin");
    fs.writeFileSync(outside, mp4Fixture());
    writeRecoveryJournal(harness.userDataPath, {
      generation: 7,
      recording: recoveryRecording(outside, { pid: 7100 }),
    });
    const summary = await harness.service.recover();
    assert.equal(summary.quarantined, true);
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.signals, []);
    assert.equal(fs.existsSync(outside), true);
    const attached = await harness.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    assert.equal(attached.generation, 8);
  });

  it("quarantines a journal whose recording temp path traverses out of staging", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    const traversal = path.join(harness.stagingRoot, "..", "..", "escape.bin");
    writeRecoveryJournal(harness.userDataPath, {
      recording: recoveryRecording(traversal, { pid: 7000 }),
    });
    const summary = await harness.service.recover();
    assert.equal(summary.quarantined, true);
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.signals, []);
  });

  it("quarantines a journal whose recording temp path is a symlink", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    const outside = path.join(harness.userDataPath, "secret.bin");
    fs.writeFileSync(outside, "secret");
    fs.mkdirSync(harness.stagingRoot, { recursive: true });
    const link = path.join(harness.stagingRoot, "link.bin");
    fs.symlinkSync(outside, link);
    writeRecoveryJournal(harness.userDataPath, {
      recording: recoveryRecording(link, { pid: 7000 }),
    });
    const summary = await harness.service.recover();
    assert.equal(summary.quarantined, true);
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.signals, []);
    assert.equal(fs.existsSync(outside), true);
  });

  it("quarantines a journal whose recording temp path contains a NUL byte", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    writeRecoveryJournal(harness.userDataPath, {
      recording: recoveryRecording(`${harness.stagingRoot}/a\u0000b.bin`, {
        pid: 7000,
      }),
    });
    const summary = await harness.service.recover();
    assert.equal(summary.quarantined, true);
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.signals, []);
  });

  it("signals only a pid whose ps command holds the exact udid and staged path", async () => {
    let inspections = 0;
    const harness = makeRecordingHarness({
      timerMode: "auto",
      processOverrides: {
        inspectProcess: () => {
          inspections += 1;
          if (inspections === 1) {
            return `/usr/bin/xcrun simctl io ${DEVICE_UDID} recordVideo --codec=h264 --force ${tempPath}`;
          }
          throw new Error("no such process");
        },
      },
    });
    const tempPath = stageRecoveryTempFile(harness.userDataPath);
    writeRecoveryJournal(harness.userDataPath, {
      recording: recoveryRecording(tempPath, { pid: 7331 }),
    });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, true);
    assert.equal(summary.cleanedRecording, true);
    assert.deepEqual(harness.signals, [[7331, "SIGINT"]]);
    assert.equal(fs.existsSync(tempPath), false);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
  });

  // Literal `ps -o command=` fixtures, written out by hand rather than through
  // `recordingCommandLine`, so the matcher is pinned to what macOS actually
  // reports for the xcrun -> shell wrapper -> CoreSimulator exec chain.
  const XCRUN_PREFIX = "/usr/bin/xcrun simctl";
  const XCODE_SIMCTL =
    "/Applications/Xcode.app/Contents/Developer/usr/bin/simctl";
  const CORESIM_SIMCTL =
    "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/bin/simctl";

  for (const [name, fileName, buildCommand] of [
    [
      "xcrun invokes the recorder directly",
      "stale.bin",
      (udid, tempPath) =>
        `${XCRUN_PREFIX} io ${udid} recordVideo --codec=h264 --force ${tempPath}`,
    ],
    [
      "xcrun exec'd a shell wrapper around simctl",
      "stale.bin",
      (udid, tempPath) =>
        `/bin/bash ${XCODE_SIMCTL} io ${udid} recordVideo --codec=h264 --force ${tempPath}`,
    ],
    [
      "the CoreSimulator simctl binary runs it",
      "stale.bin",
      (udid, tempPath) =>
        `${CORESIM_SIMCTL} io ${udid} recordVideo --codec=h264 --force ${tempPath}`,
    ],
    [
      "xcrun ran it against a staged path containing spaces",
      "stale recording take 2.bin",
      (udid, tempPath) =>
        `${XCRUN_PREFIX} io ${udid} recordVideo --codec=h264 --force ${tempPath}`,
    ],
    [
      "the shell wrapper ran it against a staged path containing spaces",
      "stale recording take 3.bin",
      (udid, tempPath) =>
        `/bin/bash ${XCODE_SIMCTL} io ${udid} recordVideo --codec=h264 --force ${tempPath}`,
    ],
    [
      "ps reports the command with a trailing newline",
      "stale.bin",
      (udid, tempPath) =>
        `${CORESIM_SIMCTL} io ${udid} recordVideo --codec=h264 --force ${tempPath}\n`,
    ],
  ]) {
    it(`signals the recovered recorder when ${name}`, async () => {
      /** @type {{ tempPath: string | null }} */
      const ref = { tempPath: null };
      let inspections = 0;
      const harness = makeRecordingHarness({
        timerMode: "auto",
        processOverrides: {
          inspectProcess: () => {
            inspections += 1;
            if (inspections > 1) throw new Error("no such process");
            return buildCommand(DEVICE_UDID, ref.tempPath);
          },
        },
      });
      ref.tempPath = stageRecoveryTempFile(harness.userDataPath, fileName);
      writeRecoveryJournal(harness.userDataPath, {
        recording: recoveryRecording(ref.tempPath, { pid: 7340 }),
      });
      const summary = await harness.service.recover();
      assert.equal(summary.recovered, true);
      assert.equal(summary.cleanedRecording, true);
      assert.deepEqual(harness.signals, [[7340, "SIGINT"]]);
      assert.equal(fs.existsSync(ref.tempPath), false);
      assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
    });
  }

  for (const [name, buildCommand] of [
    [
      "a udid with a trailing suffix",
      (udid, tempPath) =>
        `${XCRUN_PREFIX} io ${udid}-extra recordVideo --codec=h264 --force ${tempPath}`,
    ],
    [
      "a udid with a leading suffix",
      (udid, tempPath) =>
        `${XCRUN_PREFIX} io x${udid} recordVideo --codec=h264 --force ${tempPath}`,
    ],
    [
      "a staged path with a trailing suffix",
      (udid, tempPath) =>
        `${XCRUN_PREFIX} io ${udid} recordVideo --codec=h264 --force ${tempPath}.extra`,
    ],
    [
      "a staged path with a leading suffix",
      (udid, tempPath) =>
        `${XCRUN_PREFIX} io ${udid} recordVideo --codec=h264 --force ${path.join(
          path.dirname(tempPath),
          `x${path.basename(tempPath)}`,
        )}`,
    ],
    [
      "a different codec flag",
      (udid, tempPath) =>
        `${XCRUN_PREFIX} io ${udid} recordVideo --codec=hevc --force ${tempPath}`,
    ],
    [
      "no codec flag",
      (udid, tempPath) =>
        `${XCRUN_PREFIX} io ${udid} recordVideo --force ${tempPath}`,
    ],
    [
      "a screenshot instead of a recording",
      (udid, tempPath) => `${XCRUN_PREFIX} io ${udid} screenshot ${tempPath}`,
    ],
    [
      "extra trailing arguments",
      (udid, tempPath) =>
        `${XCRUN_PREFIX} io ${udid} recordVideo --codec=h264 --force ${tempPath} --mask=black`,
    ],
    [
      "a shell wrapper around the whole recorder command",
      (udid, tempPath) =>
        `/bin/sh -c ${XCRUN_PREFIX} io ${udid} recordVideo --codec=h264 --force ${tempPath}`,
    ],
    [
      "an echo of the recorder command",
      (udid, tempPath) =>
        `/bin/echo ${XCRUN_PREFIX} io ${udid} recordVideo --codec=h264 --force ${tempPath}`,
    ],
    [
      "an untrusted executable with the recorder argv",
      (udid, tempPath) =>
        `/tmp/evil/simctl io ${udid} recordVideo --codec=h264 --force ${tempPath}`,
    ],
    [
      "a relative simctl path",
      (udid, tempPath) =>
        `bin/simctl io ${udid} recordVideo --codec=h264 --force ${tempPath}`,
    ],
    [
      "an unrelated command naming both the udid and the path",
      (udid, tempPath) => `/usr/bin/vim ${tempPath} ${udid}`,
    ],
  ]) {
    it(`never signals a pid whose ps command shows ${name}`, async () => {
      /** @type {{ tempPath: string | null }} */
      const ref = { tempPath: null };
      const harness = makeRecordingHarness({
        timerMode: "auto",
        processOverrides: {
          inspectProcess: () => buildCommand(DEVICE_UDID, ref.tempPath),
        },
      });
      ref.tempPath = stageRecoveryTempFile(harness.userDataPath);
      writeRecoveryJournal(harness.userDataPath, {
        recording: recoveryRecording(ref.tempPath, { pid: 7341 }),
      });
      const summary = await harness.service.recover();
      assert.equal(summary.recovered, true);
      assert.deepEqual(harness.signals, []);
      assert.equal(fs.existsSync(ref.tempPath), false);
    });
  }

  it("cleans the recorder up and retains the journal when the selected Xcode no longer matches", async () => {
    /** @type {{ tempPath: string | null }} */
    const ref = { tempPath: null };
    let inspections = 0;
    const harness = makeRecordingHarness({
      timerMode: "auto",
      processOverrides: {
        inspectProcess: () => {
          inspections += 1;
          if (inspections > 1) throw new Error("no such process");
          return `${XCRUN_PREFIX} io ${DEVICE_UDID} recordVideo --codec=h264 --force ${ref.tempPath}`;
        },
      },
    });
    ref.tempPath = stageRecoveryTempFile(harness.userDataPath);
    writeRecoveryJournal(harness.userDataPath, {
      bootedBySolenta: true,
      developerDir: ALT_DEV_DIR,
      recording: recoveryRecording(ref.tempPath, { pid: 7342 }),
    });
    const summary = await harness.service.recover();
    // A developer directory the app no longer trusts is a configuration change,
    // not corruption: nothing is quarantined and the journal stays retryable.
    assert.equal(summary.quarantined, false);
    assert.equal(summary.journalRetained, true);
    assert.equal(summary.cleanedRecording, true);
    assert.equal(summary.shutDownDevice, false);
    assert.equal(corruptJournalFiles(harness.userDataPath).length, 0);
    assert.deepEqual(harness.signals, [[7342, "SIGINT"]]);
    assert.equal(processCallNames(harness.calls).includes("shutdown"), false);
    assert.equal(fs.existsSync(ref.tempPath), false);
    // The recorder cleanup is durable, so a retry never re-signals a dead pid.
    const retained = readJournal(harness.userDataPath);
    assert.equal(retained.recording, null);
    assert.equal(retained.bootedBySolenta, true);
    assert.equal(retained.developerDir, ALT_DEV_DIR);
  });

  it("shuts down and clears on the next launch once the selected Xcode matches again", async () => {
    /** @type {{ tempPath: string | null }} */
    const ref = { tempPath: null };
    let inspections = 0;
    const first = makeRecordingHarness({
      timerMode: "auto",
      processOverrides: {
        inspectProcess: () => {
          inspections += 1;
          if (inspections > 1) throw new Error("no such process");
          return `${XCRUN_PREFIX} io ${DEVICE_UDID} recordVideo --codec=h264 --force ${ref.tempPath}`;
        },
      },
    });
    ref.tempPath = stageRecoveryTempFile(first.userDataPath);
    writeRecoveryJournal(first.userDataPath, {
      generation: 4,
      bootedBySolenta: true,
      developerDir: ALT_DEV_DIR,
      recording: recoveryRecording(ref.tempPath, { pid: 7343 }),
    });
    const firstSummary = await first.service.recover();
    assert.equal(firstSummary.journalRetained, true);
    assert.equal(firstSummary.shutDownDevice, false);

    // Second launch on the same user data, now with that Xcode selected.
    writePrefs(first.userDataPath, { version: 1, developerDir: ALT_DEV_DIR });
    const second = makeRecordingHarness({
      timerMode: "auto",
      userDataPath: first.userDataPath,
    });
    const secondSummary = await second.service.recover();
    assert.equal(secondSummary.recovered, true);
    assert.equal(secondSummary.shutDownDevice, true);
    assert.equal(secondSummary.journalRetained, false);
    const shutdownCall = second.calls.find(
      (call) => Array.isArray(call) && call[0] === "shutdown",
    );
    assert.deepEqual(shutdownCall, ["shutdown", ALT_DEV_DIR, DEVICE_UDID]);
    // The retained journal had no recording left, so nothing is re-signalled.
    assert.equal(
      processCallNames(second.calls).includes("inspectProcess"),
      false,
    );
    assert.deepEqual(second.signals, []);
    assert.equal(fs.existsSync(journalPath(first.userDataPath)), false);
    assert.equal(corruptJournalFiles(first.userDataPath).length, 0);
    const attached = await second.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    assert.equal(attached.generation, 5);
  });

  it("keeps the journal and the recording file when a matched recorder survives the signals", async () => {
    /** @type {{ tempPath: string | null }} */
    const ref = { tempPath: null };
    const harness = makeRecordingHarness({
      timerMode: "auto",
      processOverrides: {
        inspectProcess: () =>
          `${XCRUN_PREFIX} io ${DEVICE_UDID} recordVideo --codec=h264 --force ${ref.tempPath}`,
      },
    });
    ref.tempPath = stageRecoveryTempFile(harness.userDataPath);
    writeRecoveryJournal(harness.userDataPath, {
      recording: recoveryRecording(ref.tempPath, { pid: 7344 }),
    });
    const summary = await harness.service.recover();
    assert.deepEqual(harness.signals, [
      [7344, "SIGINT"],
      [7344, "SIGKILL"],
    ]);
    assert.equal(summary.cleanedRecording, false);
    assert.equal(summary.journalRetained, true);
    assert.equal(summary.quarantined, false);
    // A live recorder is still writing to the file, so neither the file nor the
    // journal that describes it may be thrown away.
    assert.equal(fs.existsSync(ref.tempPath), true);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), true);
    assert.equal(corruptJournalFiles(harness.userDataPath).length, 0);
  });

  it("retains a corrupt journal when quarantining fails", async () => {
    const harness = makeRecordingHarness({
      timerMode: "auto",
      fsApi: makeRecordingFsApi({
        renameError: (_from, to) =>
          to.includes(".corrupt-")
            ? Object.assign(new Error("EACCES"), { code: "EACCES" })
            : null,
      }),
    });
    fs.mkdirSync(harness.userDataPath, { recursive: true });
    fs.writeFileSync(journalPath(harness.userDataPath), "{not json at all");
    const summary = await harness.service.recover();
    assert.equal(summary.quarantined, false);
    assert.equal(summary.journalRetained, true);
    assert.equal(summary.recovered, false);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), true);
    assert.deepEqual(corruptJournalFiles(harness.userDataPath), []);
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.signals, []);
  });

  it("shuts down using the trusted selected developer directory", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    writePrefs(harness.userDataPath, { version: 1, developerDir: ALT_DEV_DIR });
    writeRecoveryJournal(harness.userDataPath, {
      bootedBySolenta: true,
      developerDir: ALT_DEV_DIR,
    });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, true);
    assert.equal(summary.shutDownDevice, true);
    const shutdownCall = harness.calls.find(
      (call) => Array.isArray(call) && call[0] === "shutdown",
    );
    assert.deepEqual(shutdownCall, ["shutdown", ALT_DEV_DIR, DEVICE_UDID]);
    assert.equal(harness.calls.includes("activeDeveloperDir"), false);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
  });

  it("accepts a journalled developer directory that only differs by path form", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    writeRecoveryJournal(harness.userDataPath, {
      bootedBySolenta: true,
      developerDir: `${DEFAULT_DEV_DIR}/./`,
    });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, true);
    assert.equal(summary.shutDownDevice, true);
    const shutdownCall = harness.calls.find(
      (call) => Array.isArray(call) && call[0] === "shutdown",
    );
    assert.deepEqual(shutdownCall, ["shutdown", DEFAULT_DEV_DIR, DEVICE_UDID]);
  });

  it("keeps the journal when the trusted developer directory cannot be resolved", async () => {
    const harness = makeRecordingHarness({
      timerMode: "auto",
      processOverrides: {
        activeDeveloperDirError: new Error("xcode-select: no developer tools"),
      },
    });
    writeRecoveryJournal(harness.userDataPath, { bootedBySolenta: true });
    const summary = await harness.service.recover();
    assert.equal(summary.journalRetained, true);
    assert.equal(summary.shutDownDevice, false);
    assert.equal(processCallNames(harness.calls).includes("shutdown"), false);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), true);
  });

  it("never signals a pid whose ps command lacks the staged path", async () => {
    const harness = makeRecordingHarness({
      timerMode: "auto",
      processOverrides: {
        inspectProcess: () =>
          `/usr/bin/xcrun simctl io ${DEVICE_UDID} recordVideo /private/tmp/other.mp4`,
      },
    });
    const tempPath = stageRecoveryTempFile(harness.userDataPath);
    writeRecoveryJournal(harness.userDataPath, {
      recording: recoveryRecording(tempPath, { pid: 7332 }),
    });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, true);
    assert.deepEqual(harness.signals, []);
    assert.equal(fs.existsSync(tempPath), false);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
  });

  it("never signals a pid whose ps command lacks the exact udid", async () => {
    const harness = makeRecordingHarness({
      timerMode: "auto",
      processOverrides: {
        inspectProcess: () => `/usr/bin/vim ${tempPath}`,
      },
    });
    const tempPath = stageRecoveryTempFile(harness.userDataPath);
    writeRecoveryJournal(harness.userDataPath, {
      recording: recoveryRecording(tempPath, { pid: 7333 }),
    });
    await harness.service.recover();
    assert.deepEqual(harness.signals, []);
  });

  it("escalates to SIGKILL when the recording process survives the SIGINT grace", async () => {
    /** @type {{ tempPath: string | null }} */
    const ref = { tempPath: null };
    let inspections = 0;
    const harness = makeRecordingHarness({
      timerMode: "auto",
      processOverrides: {
        inspectProcess: () => {
          inspections += 1;
          // Survives the SIGINT grace, then goes away once killed.
          if (inspections > 2) throw new Error("no such process");
          return `/usr/bin/xcrun simctl io ${DEVICE_UDID} recordVideo --codec=h264 --force ${ref.tempPath}`;
        },
      },
    });
    ref.tempPath = stageRecoveryTempFile(harness.userDataPath);
    writeRecoveryJournal(harness.userDataPath, {
      recording: recoveryRecording(ref.tempPath, { pid: 7334 }),
    });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, true);
    assert.equal(summary.cleanedRecording, true);
    assert.deepEqual(harness.signals, [
      [7334, "SIGINT"],
      [7334, "SIGKILL"],
    ]);
    assert.equal(fs.existsSync(ref.tempPath), false);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
  });

  it("tolerates an already-gone recording process", async () => {
    const harness = makeRecordingHarness({
      timerMode: "auto",
      processOverrides: {
        inspectProcessError: new Error("ps: no such process"),
      },
    });
    const tempPath = stageRecoveryTempFile(harness.userDataPath);
    writeRecoveryJournal(harness.userDataPath, {
      recording: recoveryRecording(tempPath, { pid: 7335 }),
    });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, true);
    assert.deepEqual(harness.signals, []);
    assert.equal(fs.existsSync(tempPath), false);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
  });

  it("does not inspect any process when the journalled recording has no pid", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    const tempPath = stageRecoveryTempFile(harness.userDataPath);
    writeRecoveryJournal(harness.userDataPath, {
      recording: recoveryRecording(tempPath),
    });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, true);
    assert.equal(processCallNames(harness.calls).includes("inspectProcess"), false);
    assert.deepEqual(harness.signals, []);
    assert.equal(fs.existsSync(tempPath), false);
  });

  it("shuts down only a device Solenta booted and never erases", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    writeRecoveryJournal(harness.userDataPath, { bootedBySolenta: true });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, true);
    assert.equal(summary.shutDownDevice, true);
    const shutdownCall = harness.calls.find(
      (call) => Array.isArray(call) && call[0] === "shutdown",
    );
    assert.deepEqual(shutdownCall, ["shutdown", DEFAULT_DEV_DIR, DEVICE_UDID]);
    assert.equal(processCallNames(harness.calls).includes("erase"), false);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
  });

  it("leaves a device Solenta did not boot untouched", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    writeRecoveryJournal(harness.userDataPath, { bootedBySolenta: false });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, true);
    assert.equal(summary.shutDownDevice, false);
    assert.deepEqual(harness.calls, []);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
  });

  it("tolerates an inherited boot intent whose device is already off", async () => {
    const harness = makeRecordingHarness({
      timerMode: "auto",
      processOverrides: {
        shutdownError: adapterError(
          "Command failed",
          "Unable to shutdown device in current state: Shutdown",
        ),
      },
    });
    writeRecoveryJournal(harness.userDataPath, {
      state: "releasing",
      bootedBySolenta: true,
    });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, true);
    assert.equal(summary.journalRetained, false);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
  });

  for (const [name, stderr] of [
    ["a raw spawn failure", "spawn EACCES /secret"],
    [
      "an unable-to-shutdown failure with no already-off state",
      "Unable to shutdown device: Operation not permitted",
    ],
  ]) {
    it(`keeps the journal when shutdown cleanup fails with ${name}`, async () => {
      const harness = makeRecordingHarness({
        timerMode: "auto",
        processOverrides: {
          shutdownError: adapterError("Command failed", stderr),
        },
      });
      writeRecoveryJournal(harness.userDataPath, { bootedBySolenta: true });
      const summary = await harness.service.recover();
      assert.equal(summary.journalRetained, true);
      assert.equal(summary.shutDownDevice, false);
      assert.equal(fs.existsSync(journalPath(harness.userDataPath)), true);
    });
  }

  it("keeps the journal when the recording temp file cannot be removed", async () => {
    const harness = makeRecordingHarness({
      timerMode: "auto",
      fsApi: makeRecordingFsApi({
        unlinkError: (target) =>
          target.endsWith("stale.bin")
            ? Object.assign(new Error("EACCES"), { code: "EACCES" })
            : null,
      }),
    });
    const tempPath = stageRecoveryTempFile(harness.userDataPath);
    writeRecoveryJournal(harness.userDataPath, {
      recording: recoveryRecording(tempPath),
    });
    const summary = await harness.service.recover();
    assert.equal(summary.journalRetained, true);
    assert.equal(summary.cleanedRecording, false);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), true);
  });

  it("restores the generation high-water mark before cleanup", async () => {
    const harness = makeRecordingHarness({
      timerMode: "auto",
      processOverrides: {
        shutdownError: adapterError("Command failed", "spawn EACCES"),
      },
    });
    writeRecoveryJournal(harness.userDataPath, {
      generation: 7,
      bootedBySolenta: true,
    });
    const summary = await harness.service.recover();
    assert.equal(summary.journalRetained, true);
    const attached = await harness.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    assert.equal(attached.generation, 8);
  });

  it("does not restore lease ownership after recovery", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    writeRecoveryJournal(harness.userDataPath, { bootedBySolenta: true });
    await harness.service.recover();
    const status = await harness.service.getStatus({ threadId: "t1" });
    assert.equal(status.attached, false);
    assert.equal(status.isOwner, false);
    assert.equal(status.generation, null);
  });

  it("tolerates an already-removed recording temp file", async () => {
    const harness = makeRecordingHarness({ timerMode: "auto" });
    fs.mkdirSync(harness.stagingRoot, { recursive: true });
    writeRecoveryJournal(harness.userDataPath, {
      recording: recoveryRecording(path.join(harness.stagingRoot, "gone.bin"), {
        pid: 7336,
      }),
    });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, true);
    assert.equal(summary.journalRetained, false);
    assert.deepEqual(harness.signals, []);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
  });
});

const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  encodeControl,
  createControlDecoder,
} = require("../ios-simulator-protocol.js");

const HELPER_SB = path.resolve(
  __dirname,
  "../../native/ios-simulator-helper/Resources/helper.sb",
);

function createFakeHelperChild(opts = {}) {
  const controlIn = new PassThrough();
  const controlOut = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  child.pid = opts.pid ?? 4242;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = stderr;
  child.stdio = [null, null, stderr, controlIn, controlOut];
  child.kill = (signal) => {
    child.killed = true;
    child.exitCode = 0;
    child.signalCode = signal || "SIGTERM";
    queueMicrotask(() => child.emit("exit", child.exitCode, child.signalCode));
    return true;
  };
  const requests = [];
  const decoder = createControlDecoder((value) => {
    requests.push(value);
    if (opts.onRequest) {
      const override = opts.onRequest(value);
      if (override === false) return;
      if (override && override.raw) {
        controlOut.write(override.raw);
        return;
      }
    }
    if (!value || typeof value.id !== "number") return;
    if (value.method === "handshake") {
      controlOut.write(
        encodeControl({
          id: value.id,
          ok: true,
          result: {
            v: 1,
            capabilities: opts.capabilities ?? {
              stream: true,
              touch: true,
              keyboard: true,
              hardwareButtons: true,
              accessibility: true,
            },
          },
        }),
      );
      return;
    }
    controlOut.write(
      encodeControl({
        id: value.id,
        ok: true,
        result: opts.resultFor?.(value) ?? { ok: true },
      }),
    );
  });
  controlIn.on("data", (chunk) => decoder(chunk));
  if (!opts.skipReady) {
    controlOut.write(encodeControl({ kind: "ready", v: 1 }));
  }
  return { child, requests, controlIn, controlOut };
}

function helperPsCommand(
  executable = "/tmp/SolentaSimulatorHelper",
  developerDir = DEFAULT_DEV_DIR,
  profile = HELPER_SB,
) {
  return `${executable} --sandbox-profile ${profile} --developer-dir ${developerDir} --control-in-fd 3 --control-out-fd 4`;
}

function makeHelperHarness(deps = {}) {
  const spawned = [];
  const logs = [];
  const streamSessions = [];
  const closedSessions = [];
  const fake = createFakeHelperChild(deps.helperOpts ?? {});
  const spawnHelper = (executable, args, options) => {
    spawned.push({ executable, args, options });
    if (deps.spawnImpl) return deps.spawnImpl(executable, args, options);
    return fake.child;
  };
  const streamBroker = deps.streamBroker ?? {
    async listen() {
      return { address: "127.0.0.1", port: 9 };
    },
    createSession(opts) {
      const session = {
        url: "ws://127.0.0.1:9",
        helperToken: "helper-secret-token",
        viewerToken: "viewer-secret-token",
        generation: opts.generation,
      };
      streamSessions.push({ opts, session });
      return session;
    },
    closeSession(generation) {
      closedSessions.push(generation);
    },
  };
  const toolchain = deps.toolchain ?? {
    async ensureHelper() {
      return "/tmp/SolentaSimulatorHelper";
    },
  };
  const created = makeService({
    userDataPath: deps.userDataPath,
    store: makeLeaseStore(),
    artifactStore: deps.artifactStore,
    processOverrides: deps.processOverrides ?? {},
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    signalPid: deps.signalPid,
    now: deps.now,
    serviceOverrides: {
      spawnHelper,
      streamBroker,
      toolchain,
      sandboxProfilePath: HELPER_SB,
      logger: {
        warn(msg) {
          logs.push(String(msg));
        },
      },
      ...deps.serviceOverrides,
    },
  });
  return {
    service: created.service,
    userDataPath: created.userDataPath,
    spawned,
    fake,
    logs,
    streamSessions,
    closedSessions,
  };
}

function makeHelperTakeoverHarness(deps = {}) {
  const userDataPath = makeUserDataPath();
  const artifacts = makeArtifactStore({ userDataPath });
  const recorder = makeRecorder({
    pid: 6601,
    finalizeOnInterrupt: false,
  });
  const timers = makeFakeTimers({ mode: "manual" });
  const first = createFakeHelperChild(deps.firstHelperOpts ?? {});
  const second = createFakeHelperChild();
  let spawnCount = 0;
  const signals = [];
  const harness = makeHelperHarness({
    userDataPath,
    artifactStore: artifacts.artifactStore,
    processOverrides: { recordVideo: recorder.recordVideo },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    signalPid: (pid, signal) => {
      signals.push([pid, signal]);
    },
    spawnImpl() {
      spawnCount += 1;
      return spawnCount === 1 ? first.child : second.child;
    },
  });
  return {
    ...harness,
    first,
    second,
    recorder,
    timers,
    signals,
    artifacts,
  };
}

describe("createIOSSimulatorService helper session", () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("spawns the helper on attach with inherited FD 3/4 and sandboxed argv", async () => {
    const harness = makeHelperHarness();
    const attached = await harness.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    assert.equal(attached.generation, 1);
    assert.equal(harness.spawned.length, 1);
    const spawn = harness.spawned[0];
    assert.equal(spawn.executable, "/tmp/SolentaSimulatorHelper");
    assert.deepEqual(spawn.args, [
      "--sandbox-profile",
      HELPER_SB,
      "--developer-dir",
      DEFAULT_DEV_DIR,
      "--control-in-fd",
      "3",
      "--control-out-fd",
      "4",
    ]);
    assert.equal(path.isAbsolute(spawn.args[1]), true);
    assert.deepEqual(spawn.options.stdio, [
      "ignore",
      "ignore",
      "pipe",
      "pipe",
      "pipe",
    ]);
    const handshake = harness.fake.requests.find((r) => r.method === "handshake");
    assert.ok(handshake);
    assert.equal(handshake.generation, 1);
    assert.equal(handshake.udid, DEVICE_UDID);
    assert.equal(typeof handshake.token, "string");
    assert.notEqual(handshake.token, "helper-secret-token");
    assert.notEqual(handshake.token, "viewer-secret-token");
    const start = harness.fake.requests.find((r) => r.method === "startStream");
    assert.ok(start);
    assert.equal(start.url, "ws://127.0.0.1:9");
    assert.equal(start.helperToken, "helper-secret-token");
    assert.equal(start.generation, 1);
    assert.equal(start.token, handshake.token);
    const info = await harness.service.streamInfo({
      threadId: "t1",
      generation: 1,
    });
    assert.deepEqual(info, {
      url: "ws://127.0.0.1:9",
      token: "viewer-secret-token",
      generation: 1,
      protocolVersion: 1,
      maxMessageBytes: 4194304,
    });
    assert.equal(info.helperToken, undefined);
    for (const msg of harness.logs) {
      assert.equal(msg.includes("helper-secret-token"), false);
      assert.equal(msg.includes("viewer-secret-token"), false);
      assert.equal(msg.includes(handshake.token), false);
    }
  });

  it("keeps the lease and marks helper capabilities disconnected on crash", async () => {
    const harness = makeHelperHarness();
    await harness.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    harness.fake.child.emit("exit", 1, null);
    await flushMicrotasks();
    const status = await harness.service.getStatus({ threadId: "t1" });
    assert.equal(status.attached, true);
    assert.equal(status.isOwner, true);
    assert.equal(status.generation, 1);
    assert.equal(status.stream, "disconnected");
    assert.equal(status.input, "disconnected");
    assert.equal(status.accessibility, "disconnected");
    await assert.rejects(
      harness.service.sendInput({
        threadId: "t1",
        generation: 1,
        input: { kind: "touch", phase: "down", pointerId: 1, x: 10, y: 20 },
      }),
      (err) => err.code === "stream_disconnected",
    );
  });

  it("ignores stale-generation helper results after takeover", async () => {
    let stallHandshake = null;
    const first = createFakeHelperChild({
      onRequest(value) {
        if (value.method === "touch" && !stallHandshake) {
          stallHandshake = deferred();
          return false;
        }
        return undefined;
      },
    });
    const second = createFakeHelperChild();
    let spawnCount = 0;
    const harness = makeHelperHarness({
      spawnImpl() {
        spawnCount += 1;
        return spawnCount === 1 ? first.child : second.child;
      },
    });
    const attached = await harness.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const pending = harness.service.sendInput({
      threadId: "t1",
      generation: attached.generation,
      input: { kind: "touch", phase: "down", pointerId: 1, x: 1, y: 1 },
    });
    pending.catch(() => {});
    await flushMicrotasks();
    await harness.service.takeover({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
      confirmed: true,
    });
    first.controlOut.write(
      encodeControl({ id: first.requests.at(-1).id, ok: true, result: {} }),
    );
    await assert.rejects(
      pending,
      (err) => err.code === "lease_stale" || err.code === "stream_disconnected",
    );
    await harness.service.sendInput({
      threadId: "t2",
      generation: 2,
      input: { kind: "button", button: "home" },
    });
    assert.ok(second.requests.some((r) => r.method === "pressButton"));
  });

  it("tap is touch down plus up; swipe is a bounded gesture; typeText is capped; pressButton is closed", async () => {
    const harness = makeHelperHarness();
    const attached = await harness.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const gen = attached.generation;
    await harness.service.tap({
      threadId: "t1",
      generation: gen,
      x: 50,
      y: 80,
    });
    const touch = harness.fake.requests.filter((r) => r.method === "touch");
    assert.equal(touch[0].phase, "down");
    assert.equal(touch[0].x, 50);
    assert.equal(touch[0].y, 80);
    assert.equal(touch[1].phase, "up");
    assert.equal(touch[1].x, 50);
    assert.equal(touch[1].y, 80);

    await harness.service.swipe({
      threadId: "t1",
      generation: gen,
      x1: 10,
      y1: 10,
      x2: 90,
      y2: 10,
      durationMs: 120,
    });
    const afterTap = harness.fake.requests.filter((r) => r.method === "touch").slice(2);
    assert.equal(afterTap[0].phase, "down");
    assert.equal(afterTap.at(-1).phase, "up");
    assert.ok(afterTap.length >= 3);
    assert.ok(afterTap.length <= 18);

    await harness.service.typeText({
      threadId: "t1",
      generation: gen,
      text: "hi",
    });
    assert.ok(harness.fake.requests.some((r) => r.method === "text" && r.text === "hi"));
    await assert.rejects(
      harness.service.typeText({
        threadId: "t1",
        generation: gen,
        text: "x".repeat(4097),
      }),
      (err) => err.code === "unexpected",
    );

    await harness.service.pressButton({
      threadId: "t1",
      generation: gen,
      button: "home",
    });
    assert.ok(
      harness.fake.requests.some(
        (r) => r.method === "pressButton" && r.button === "home",
      ),
    );
    await assert.rejects(
      harness.service.pressButton({
        threadId: "t1",
        generation: gen,
        button: "power",
      }),
      (err) => err.code === "unexpected",
    );

    await harness.service.scrollTo({
      threadId: "t1",
      generation: gen,
      x: 100,
      y: 200,
      dx: 0,
      dy: -120,
    });
    assert.ok(
      harness.fake.requests.some(
        (r) =>
          r.method === "scrollTo" &&
          r.x === 100 &&
          r.y === 200 &&
          r.dx === 0 &&
          r.dy === -120,
      ),
    );
    await assert.rejects(
      harness.service.scrollTo({
        threadId: "t1",
        generation: gen,
        x: Number.NaN,
        y: 200,
      }),
      (err) => err.code === "unexpected",
    );

    await harness.service.sendInput({
      threadId: "t1",
      generation: gen,
      input: { kind: "key", key: "enter", phase: "down" },
    });
    assert.ok(
      harness.fake.requests.some(
        (r) => r.method === "key" && r.usage === 0x28 && r.down === true,
      ),
    );
  });

  it("retryStream respawns the helper without transferring the lease", async () => {
    const children = [createFakeHelperChild(), createFakeHelperChild()];
    let n = 0;
    const harness = makeHelperHarness({
      spawnImpl() {
        const child = children[n].child;
        n += 1;
        return child;
      },
    });
    const attached = await harness.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    children[0].child.emit("exit", 1, null);
    await flushMicrotasks();
    const retried = await harness.service.retryStream({
      threadId: "t1",
      generation: attached.generation,
    });
    assert.equal(retried.generation, 1);
    assert.equal(n, 2);
    const status = await harness.service.getStatus({ threadId: "t1" });
    assert.equal(status.isOwner, true);
    assert.equal(status.stream, "connected");
    const info = await harness.service.streamInfo({
      threadId: "t1",
      generation: 1,
    });
    assert.equal(info.token, "viewer-secret-token");
  });

  it("takeover mid-tap writes nothing further to the old helper", async () => {
    const harness = makeHelperTakeoverHarness();
    const attached = await harness.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await harness.service.startRecording({
      threadId: "t1",
      generation: attached.generation,
      runId: "r1",
    });
    const tapPromise = harness.service.tap({
      threadId: "t1",
      generation: attached.generation,
      x: 10,
      y: 20,
    });
    tapPromise.catch(() => {});
    await waitFor(() =>
      harness.first.requests.some(
        (r) => r.method === "touch" && r.phase === "down",
      ),
    );
    const takeoverPromise = harness.service.takeover({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
      confirmed: true,
    });
    takeoverPromise.catch(() => {});
    await waitFor(() => readJournal(harness.userDataPath).generation === 2);
    await harness.timers.advance(50);
    await settleAsync();
    const touches = harness.first.requests.filter((r) => r.method === "touch");
    assert.equal(touches.length, 1, "old helper must not receive tap-up after takeover");
    assert.equal(touches[0].phase, "down");
    await harness.recorder.state.finalize();
    await takeoverPromise;
    await assert.rejects(
      tapPromise,
      (err) => err.code === "lease_stale" || err.code === "stream_disconnected",
    );
  });

  it("takeover mid-swipe writes nothing further to the old helper", async () => {
    let stalledMove = false;
    const harness = makeHelperTakeoverHarness({
      firstHelperOpts: {
        onRequest(value) {
          if (value.method === "touch" && value.phase === "move" && !stalledMove) {
            stalledMove = true;
            return false;
          }
          return undefined;
        },
      },
    });
    const attached = await harness.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await harness.service.startRecording({
      threadId: "t1",
      generation: attached.generation,
      runId: "r1",
    });
    const swipePromise = harness.service.swipe({
      threadId: "t1",
      generation: attached.generation,
      x1: 10,
      y1: 10,
      x2: 90,
      y2: 10,
      durationMs: 200,
    });
    swipePromise.catch(() => {});
    await waitFor(() =>
      harness.first.requests.some(
        (r) => r.method === "touch" && r.phase === "move",
      ),
    );
    const touchesAtStall = harness.first.requests.filter(
      (r) => r.method === "touch",
    );
    assert.equal(touchesAtStall[0].phase, "down");
    assert.equal(touchesAtStall.at(-1).phase, "move");
    const takeoverPromise = harness.service.takeover({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
      confirmed: true,
    });
    takeoverPromise.catch(() => {});
    await waitFor(() => readJournal(harness.userDataPath).generation === 2);
    const stalled = harness.first.requests.find(
      (r) => r.method === "touch" && r.phase === "move",
    );
    harness.first.controlOut.write(
      encodeControl({ id: stalled.id, ok: true, result: {} }),
    );
    await settleAsync();
    const touches = harness.first.requests.filter((r) => r.method === "touch");
    assert.equal(
      touches.length,
      touchesAtStall.length,
      "old helper must not receive further swipe frames after takeover",
    );
    assert.equal(
      touches.some((r) => r.phase === "up"),
      false,
    );
    await harness.recorder.state.finalize();
    await takeoverPromise;
    await assert.rejects(
      swipePromise,
      (err) => err.code === "lease_stale" || err.code === "stream_disconnected",
    );
  });

  it("fails an in-flight helper RPC when the helper crashes", async () => {
    const fake = createFakeHelperChild({
      onRequest(value) {
        if (value.method === "touch") return false;
        return undefined;
      },
    });
    const harness = makeHelperHarness({
      spawnImpl: () => fake.child,
    });
    const attached = await harness.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const pending = harness.service.sendInput({
      threadId: "t1",
      generation: attached.generation,
      input: { kind: "touch", phase: "down", pointerId: 1, x: 1, y: 1 },
    });
    pending.catch(() => {});
    await waitFor(() => fake.requests.some((r) => r.method === "touch"));
    const started = Date.now();
    fake.child.emit("exit", 1, null);
    await assert.rejects(pending, (err) => err.code === "stream_disconnected");
    assert.ok(Date.now() - started < 1000, "in-flight RPC must fail promptly");
  });

  it("fails the spawn waiter when the helper exits before ready", async () => {
    const fake = createFakeHelperChild({ skipReady: true });
    const harness = makeHelperHarness({
      spawnImpl: () => fake.child,
    });
    const started = Date.now();
    const attachPromise = harness.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    await waitFor(() => harness.spawned.length === 1);
    fake.child.emit("exit", 1, null);
    const attached = await Promise.race([
      attachPromise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("attach hung waiting for helper ready")), 2000);
      }),
    ]);
    assert.ok(Date.now() - started < 2000, "spawn waiter must fail promptly");
    assert.equal(attached.generation, 1);
    const status = await harness.service.getStatus({ threadId: "t1" });
    assert.equal(status.attached, true);
    assert.equal(status.stream, "disconnected");
  });

  it("journals helper pid and protocol token when the helper starts and clears them on exit", async () => {
    const harness = makeHelperHarness();
    await harness.service.attach({
      threadId: "t1",
      deviceUdid: DEVICE_UDID,
    });
    const handshake = harness.fake.requests.find((r) => r.method === "handshake");
    const journal = readJournal(harness.userDataPath);
    assert.equal(journal.helperPid, 4242);
    assert.equal(journal.protocolToken, handshake.token);
    harness.fake.child.emit("exit", 1, null);
    await waitFor(() => readJournal(harness.userDataPath).helperPid === null);
    const cleared = readJournal(harness.userDataPath);
    assert.equal(cleared.helperPid, null);
    assert.equal(cleared.protocolToken, null);
  });

  it("recover signals a helper pid whose ps command matches the helper Solenta spawned", async () => {
    let inspections = 0;
    const harness = makeRecordingHarness({
      timerMode: "auto",
      processOverrides: {
        inspectProcess: (pid) => {
          inspections += 1;
          assert.equal(pid, 8801);
          if (inspections === 1) return helperPsCommand();
          throw new Error("no such process");
        },
      },
    });
    writeRecoveryJournal(harness.userDataPath, {
      helperPid: 8801,
      protocolToken: "helper-protocol-token",
    });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, true);
    assert.equal(summary.quarantined, false);
    assert.deepEqual(harness.signals, [[8801, "SIGTERM"]]);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
  });

  it("recover does not signal a reused helper pid whose command does not match", async () => {
    const harness = makeRecordingHarness({
      timerMode: "auto",
      processOverrides: {
        inspectProcess: () => "/usr/bin/vim /tmp/notes.txt",
      },
    });
    writeRecoveryJournal(harness.userDataPath, {
      helperPid: 8802,
      protocolToken: "helper-protocol-token",
    });
    const summary = await harness.service.recover();
    assert.equal(summary.recovered, true);
    assert.equal(summary.quarantined, false);
    assert.deepEqual(harness.signals, []);
    assert.equal(processCallNames(harness.calls).includes("inspectProcess"), true);
    assert.equal(fs.existsSync(journalPath(harness.userDataPath)), false);
  });
});

