"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  createIOSSimulatorProcess,
  recordingCommandLine,
  recordingArgumentTail,
} = require("../ios-simulator-process.js");

const devDir = "/Applications/Xcode.app/Contents/Developer";
const udid = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const baseEnv = { PATH: "/usr/bin" };

const SHORT = { timeout: 10_000, maxBuffer: 256 * 1024 };
const NORMAL = { timeout: 30_000, maxBuffer: 256 * 1024 };
const LONG = { timeout: 120_000, maxBuffer: 256 * 1024 };
const PROCESS = { timeout: 5_000, maxBuffer: 1024 * 1024 };

function assertOptions(overrides) {
  return { windowsHide: true, ...overrides };
}

function makeHarness() {
  /** @type {Array<{ file: string, args: string[], options: object }>} */
  const calls = [];
  /** @type {Array<{ file: string, args: string[], options: object, child: object }>} */
  const spawns = [];
  /** @type {Array<[string]>} */
  const signals = [];

  const fakeExecFile = (file, args, options, cb) => {
    calls.push({ file, args, options });
    cb(null, "fixture-stdout", "fixture-stderr");
  };

  const fakeSpawn = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.kill = () => {};
    spawns.push({ file, args, options, child });
    return child;
  };

  const fakeSignalGroup = (child, sig) => {
    signals.push([sig]);
  };

  const processApi = createIOSSimulatorProcess({
    execFile: fakeExecFile,
    spawn: fakeSpawn,
    baseEnv,
    signalGroup: fakeSignalGroup,
  });

  return { processApi, calls, spawns, signals, fakeExecFile, fakeSpawn, fakeSignalGroup };
}

function makeProcessApi(overrides = {}) {
  const harness = makeHarness();
  return {
    ...harness,
    processApi: createIOSSimulatorProcess({
      execFile: overrides.execFile || harness.fakeExecFile,
      spawn: overrides.spawn || harness.fakeSpawn,
      baseEnv: overrides.baseEnv || baseEnv,
      signalGroup: overrides.signalGroup || harness.fakeSignalGroup,
    }),
  };
}

describe("createIOSSimulatorProcess", () => {
  it("has no run, exec, or spawn escape hatch", () => {
    const { processApi } = makeHarness();
    assert.equal("run" in processApi, false);
    assert.equal("exec" in processApi, false);
    assert.equal("spawn" in processApi, false);
  });

  it("activeDeveloperDir uses xcode-select without DEVELOPER_DIR", async () => {
    const { processApi, calls } = makeHarness();
    const out = await processApi.activeDeveloperDir();
    assert.equal(out, "fixture-stdout");
    assert.deepEqual(calls[0], {
      file: "/usr/bin/xcode-select",
      args: ["-p"],
      options: assertOptions({
        shell: false,
        ...SHORT,
        env: { PATH: "/usr/bin" },
      }),
    });
  });

  it("xcodeVersion uses xcodebuild -version", async () => {
    const { processApi, calls } = makeHarness();
    await processApi.xcodeVersion(devDir);
    assert.deepEqual(calls[0], {
      file: "/usr/bin/xcodebuild",
      args: ["-version"],
      options: assertOptions({
        shell: false,
        ...SHORT,
        env: { PATH: "/usr/bin", DEVELOPER_DIR: devDir },
      }),
    });
  });

  it("firstLaunchStatus uses xcodebuild -checkFirstLaunchStatus", async () => {
    const { processApi, calls } = makeHarness();
    await processApi.firstLaunchStatus(devDir);
    assert.deepEqual(calls[0], {
      file: "/usr/bin/xcodebuild",
      args: ["-checkFirstLaunchStatus"],
      options: assertOptions({
        shell: false,
        ...SHORT,
        env: { PATH: "/usr/bin", DEVELOPER_DIR: devDir },
      }),
    });
  });

  it("findSimctl uses xcrun --find simctl", async () => {
    const { processApi, calls } = makeHarness();
    await processApi.findSimctl(devDir);
    assert.deepEqual(calls[0], {
      file: "/usr/bin/xcrun",
      args: ["--find", "simctl"],
      options: assertOptions({
        shell: false,
        ...SHORT,
        env: { PATH: "/usr/bin", DEVELOPER_DIR: devDir },
      }),
    });
  });

  it("listDevices uses xcrun simctl list --json", async () => {
    const { processApi, calls } = makeHarness();
    await processApi.listDevices(devDir);
    assert.deepEqual(calls[0], {
      file: "/usr/bin/xcrun",
      args: ["simctl", "list", "--json"],
      options: assertOptions({
        shell: false,
        ...SHORT,
        env: { PATH: "/usr/bin", DEVELOPER_DIR: devDir },
      }),
    });
  });

  it("boot uses xcrun simctl boot", async () => {
    const { processApi, calls } = makeHarness();
    await processApi.boot(devDir, udid);
    assert.deepEqual(calls[0], {
      file: "/usr/bin/xcrun",
      args: ["simctl", "boot", udid],
      options: assertOptions({
        shell: false,
        ...NORMAL,
        env: { PATH: "/usr/bin", DEVELOPER_DIR: devDir },
      }),
    });
  });

  it("bootStatus uses xcrun simctl bootstatus -b", async () => {
    const { processApi, calls } = makeHarness();
    await processApi.bootStatus(devDir, udid);
    assert.deepEqual(calls[0], {
      file: "/usr/bin/xcrun",
      args: ["simctl", "bootstatus", udid, "-b"],
      options: assertOptions({
        shell: false,
        ...LONG,
        env: { PATH: "/usr/bin", DEVELOPER_DIR: devDir },
      }),
    });
  });

  it("shutdown uses xcrun simctl shutdown", async () => {
    const { processApi, calls } = makeHarness();
    await processApi.shutdown(devDir, udid);
    assert.deepEqual(calls[0], {
      file: "/usr/bin/xcrun",
      args: ["simctl", "shutdown", udid],
      options: assertOptions({
        shell: false,
        ...NORMAL,
        env: { PATH: "/usr/bin", DEVELOPER_DIR: devDir },
      }),
    });
  });

  it("install uses xcrun simctl install", async () => {
    const { processApi, calls } = makeHarness();
    const appPath = "/tmp/MyApp.app";
    await processApi.install(devDir, udid, appPath);
    assert.deepEqual(calls[0], {
      file: "/usr/bin/xcrun",
      args: ["simctl", "install", udid, appPath],
      options: assertOptions({
        shell: false,
        ...LONG,
        env: { PATH: "/usr/bin", DEVELOPER_DIR: devDir },
      }),
    });
  });

  it("launch uses xcrun simctl launch", async () => {
    const { processApi, calls } = makeHarness();
    await processApi.launch(devDir, udid, "com.example.app");
    assert.deepEqual(calls[0], {
      file: "/usr/bin/xcrun",
      args: ["simctl", "launch", udid, "com.example.app"],
      options: assertOptions({
        shell: false,
        ...NORMAL,
        env: { PATH: "/usr/bin", DEVELOPER_DIR: devDir },
      }),
    });
  });

  it("openUrl uses xcrun simctl openurl", async () => {
    const { processApi, calls } = makeHarness();
    await processApi.openUrl(devDir, udid, "https://example.com");
    assert.deepEqual(calls[0], {
      file: "/usr/bin/xcrun",
      args: ["simctl", "openurl", udid, "https://example.com"],
      options: assertOptions({
        shell: false,
        ...NORMAL,
        env: { PATH: "/usr/bin", DEVELOPER_DIR: devDir },
      }),
    });
  });

  it("screenshot uses xcrun simctl io screenshot", async () => {
    const { processApi, calls } = makeHarness();
    const output = "/private/tmp/a.png";
    await processApi.screenshot(devDir, udid, output);
    assert.deepEqual(calls[0], {
      file: "/usr/bin/xcrun",
      args: ["simctl", "io", udid, "screenshot", output],
      options: assertOptions({
        shell: false,
        ...NORMAL,
        env: { PATH: "/usr/bin", DEVELOPER_DIR: devDir },
      }),
    });
  });

  it("readBundleId uses plutil", async () => {
    const { processApi, calls } = makeHarness();
    const infoPlist = "/tmp/MyApp.app/Info.plist";
    await processApi.readBundleId(devDir, infoPlist);
    assert.deepEqual(calls[0], {
      file: "/usr/bin/plutil",
      args: ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist],
      options: assertOptions({
        shell: false,
        ...SHORT,
        env: { PATH: "/usr/bin", DEVELOPER_DIR: devDir },
      }),
    });
  });

  it("inspectProcess uses ps without DEVELOPER_DIR", async () => {
    const { processApi, calls } = makeHarness();
    await processApi.inspectProcess(12345);
    assert.deepEqual(calls[0], {
      file: "/bin/ps",
      args: ["-p", "12345", "-o", "command="],
      options: assertOptions({
        shell: false,
        ...PROCESS,
        env: { PATH: "/usr/bin" },
      }),
    });
  });

  it("rejects with stdout and stderr attached on execFile error", async () => {
    const { processApi } = makeProcessApi({
      execFile: (file, args, options, cb) => {
        const err = Object.assign(new Error("simctl failed"), { code: 1 });
        cb(err, "partial-out", "partial-err");
      },
    });
    await assert.rejects(
      () => processApi.listDevices(devDir),
      (err) => {
        assert.equal(err.message, "simctl failed");
        assert.equal(err.code, 1);
        assert.equal(err.stdout, "partial-out");
        assert.equal(err.stderr, "partial-err");
        return true;
      },
    );
  });

  it("recordVideo spawns detached and finalizes with SIGINT", async () => {
    const { processApi, spawns, signals } = makeHarness();
    const output = "/private/tmp/a.mp4";
    const recording = processApi.recordVideo(devDir, udid, output);
    assert.equal(spawns[0].file, "/usr/bin/xcrun");
    assert.deepEqual(spawns[0].args, [
      "simctl",
      "io",
      udid,
      "recordVideo",
      "--codec=h264",
      "--force",
      output,
    ]);
    assert.equal(spawns[0].options.shell, false);
    assert.equal(spawns[0].options.detached, true);
    assert.equal(spawns[0].options.stdio, "ignore");
    assert.equal(spawns[0].options.windowsHide, true);
    assert.deepEqual(spawns[0].options.env, {
      PATH: "/usr/bin",
      DEVELOPER_DIR: devDir,
    });
    assert.equal(recording.pid, 4242);
    assert.equal("kill" in recording, false);
    assert.equal("on" in recording, false);
    assert.equal("stdout" in recording, false);
    assert.equal(typeof recording.interrupt, "function");
    assert.equal(typeof recording.closed.then, "function");
    recording.interrupt();
    assert.deepEqual(signals, [["SIGINT"]]);
    spawns[0].child.emit("close", 0, "SIGINT");
    assert.deepEqual(await recording.closed, { code: 0, signal: "SIGINT" });
  });

  it("recordingCommandLine matches the argv recordVideo actually spawns", () => {
    const { processApi, spawns } = makeHarness();
    const output = "/private/tmp/a recording.mp4";
    processApi.recordVideo(devDir, udid, output);
    assert.equal(
      recordingCommandLine(udid, output),
      [spawns[0].file, ...spawns[0].args].join(" "),
    );
  });

  it("recordingArgumentTail is the spawned argv after the simctl executable", () => {
    const { processApi, spawns } = makeHarness();
    const output = "/private/tmp/a recording.mp4";
    processApi.recordVideo(devDir, udid, output);
    assert.equal(spawns[0].args[0], "simctl");
    assert.equal(
      recordingArgumentTail(udid, output),
      spawns[0].args.slice(1).join(" "),
    );
    assert.equal(
      recordingCommandLine(udid, output).endsWith(
        ` ${recordingArgumentTail(udid, output)}`,
      ),
      true,
    );
  });

  it("recordVideo omits DEVELOPER_DIR when developer directory is absent", () => {
    const { processApi, spawns } = makeHarness();
    processApi.recordVideo(undefined, udid, "/private/tmp/a.mp4");
    assert.deepEqual(spawns[0].options.env, { PATH: "/usr/bin" });
  });

  it("recordVideo sets DEVELOPER_DIR when developer directory is selected", () => {
    const { processApi, spawns } = makeHarness();
    processApi.recordVideo(devDir, udid, "/private/tmp/a.mp4");
    assert.deepEqual(spawns[0].options.env, {
      PATH: "/usr/bin",
      DEVELOPER_DIR: devDir,
    });
  });

  it("recordVideo closed resolves once on close", async () => {
    const { processApi, spawns } = makeHarness();
    const recording = processApi.recordVideo(devDir, udid, "/private/tmp/a.mp4");
    spawns[0].child.emit("close", 0, null);
    assert.deepEqual(await recording.closed, { code: 0, signal: null });
    spawns[0].child.emit("close", 1, "SIGKILL");
    assert.deepEqual(await recording.closed, { code: 0, signal: null });
  });

  it("recordVideo closed rejects once on spawn error", async () => {
    const { processApi, spawns } = makeHarness();
    const recording = processApi.recordVideo(devDir, udid, "/private/tmp/a.mp4");
    const spawnErr = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    spawns[0].child.emit("error", spawnErr);
    await assert.rejects(recording.closed, (err) => {
      assert.equal(err.message, "spawn EACCES");
      assert.equal(err.code, "EACCES");
      return true;
    });
    spawns[0].child.emit("close", 0, null);
    await assert.rejects(recording.closed, (err) => {
      assert.equal(err.message, "spawn EACCES");
      return true;
    });
  });
});
