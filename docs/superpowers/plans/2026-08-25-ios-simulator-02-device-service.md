# iOS Simulator Device Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, testable macOS service for Xcode discovery, simulator lifecycle, validated app install/launch, lease ownership, screenshots, recordings, and crash recovery.

**Architecture:** `IOSSimulatorService` is a main-process singleton with one serialized lease and a separate atomic recovery journal. A narrow process adapter is the only code allowed to construct `xcrun`, `xcodebuild`, `plutil`, and process-inspection commands. Screenshots and recordings commit through the run-artifact interface from plan 01; this plan adds no renderer or MCP surface.

**Tech Stack:** Electron main (CommonJS), Node child processes/filesystem, `xcrun simctl`, Xcode command-line tools, `node:test`.

## Global Constraints

- Complete `2026-08-25-ios-simulator-01-run-artifacts.md` first.
- Design spec: `docs/superpowers/specs/2026-08-25-ios-simulator-integration-design.md`. Tracking issue: #248.
- Local macOS only. Reject remote/WSL before filesystem or subprocess work.
- No shell strings, generic command API, `xcodebuild` build wrapper, device creation, erase, or physical-device support.
- Existing available simulators only; one controlling thread lease globally.
- Never fall back to the project checkout when a pending/existing worktree fails to materialize.
- Never erase a simulator or shut down one that was already booted before Solenta attached.
- Recordings finalize with `SIGINT`; `SIGKILL` is only the bounded fallback.
- The normal cross-platform suite requires no Xcode or booted Simulator.
- Use TDD and commit after every task.

---

## File Structure

**Create**
- `electron/ios-simulator-process.js` — fixed executable/argv allowlist and bounded child-process behavior.
- `electron/ios-simulator.js` — policy, discovery, root/app validation, lease/journal, capture, cleanup.
- `electron/test/ios-simulator-process.test.js`
- `electron/test/ios-simulator.test.js`
- `electron/test/ios-simulator-lifecycle.test.js`

**Modify**
- `electron/proc.js` — export `signalGroup`.
- `electron/main.js` — construct/recover/shutdown the service.
- `electron/runner.js` — notify run terminal; stop a recording owned by that run.
- `electron/services.js` — release leases after successful archive/delete/project removal.
- `electron/ipc.js` — inject service into context only; no public simulator handlers yet.
- `electron/shutdown.js` — await one asynchronous cleanup.
- `scripts/test-electron.js` — run fully injected simulator tests on Windows.
- `electron/test/proc.test.js`
- `electron/test/shutdown.test.js`

---

### Task 1: Fixed process adapter

**Files:**
- Create: `electron/ios-simulator-process.js`
- Create: `electron/test/ios-simulator-process.test.js`
- Modify: `electron/proc.js:43-84`
- Modify: `electron/test/proc.test.js`

**Interfaces:**
- Produces `createIOSSimulatorProcess(deps)`; no method accepts arbitrary executable, argv, environment, or command text.
- Later tasks consume typed methods only.

- [ ] **Step 1: Write failing adapter tests**

Create a fake `execFile` that records `(file, args, options)` and returns fixture stdout. Cover every allowed operation. The representative assertions are:

```js
const processApi = createIOSSimulatorProcess({
  execFile: fakeExecFile,
  spawn: fakeSpawn,
  baseEnv: { PATH: "/usr/bin" },
  signalGroup: fakeSignalGroup,
});

await processApi.listDevices("/Applications/Xcode.app/Contents/Developer");
assert.deepEqual(calls[0], {
  file: "/usr/bin/xcrun",
  args: ["simctl", "list", "--json"],
  options: assertOptions({
    shell: false,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    env: {
      PATH: "/usr/bin",
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
    },
  }),
});

const recording = processApi.recordVideo(devDir, udid, "/private/tmp/a.mp4");
assert.equal(spawns[0].options.detached, true);
recording.interrupt();
assert.deepEqual(signals, [["SIGINT"]]);
```

Also assert the exported object has no `run`, `exec`, or `spawn` escape hatch.

- [ ] **Step 2: Run and verify red**

Run:

```sh
node --test electron/test/ios-simulator-process.test.js electron/test/proc.test.js
```

Expected: FAIL with `Cannot find module '../ios-simulator-process.js'` and `signalGroup` not exported.

- [ ] **Step 3: Export group signaling**

Add `signalGroup` to `electron/proc.js` exports. Preserve `killTree` behavior; `signalGroup(child, "SIGINT")` sends to the detached POSIX group and falls back to `child.kill(signal)`.

- [ ] **Step 4: Implement the adapter**

Export:

```js
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
```

Use 10s/256 KiB for `SHORT`, 30s/256 KiB for `NORMAL`, 120s/256 KiB for `LONG`, and 5s/1 MiB for `PROCESS`.

- [ ] **Step 5: Run tests and commit**

Run:

```sh
node --test electron/test/ios-simulator-process.test.js electron/test/proc.test.js
```

Expected: PASS.

Commit:

```sh
git add electron/ios-simulator-process.js electron/test/ios-simulator-process.test.js electron/proc.js electron/test/proc.test.js
git commit -m "feat: add fixed iOS Simulator process adapter"
```

---

### Task 2: Platform, Xcode, runtime, and device discovery

**Files:**
- Create: `electron/ios-simulator.js`
- Create: `electron/test/ios-simulator.test.js`

**Interfaces:**
- Produces `createIOSSimulatorService(deps)`, `IOSSimulatorError`, `getCapabilities`, `selectDeveloperDirectory`, and `listDevices`.
- Preferences persist in `userData/ios-simulator-preferences.json`, mode `0600`; host paths do not enter public app settings.

- [ ] **Step 1: Write failing discovery tests**

Create a fake Store with one local thread/project and an injected process adapter. Cover:

- `platform: "linux"` -> `unsupported_platform`, no process call;
- remote project -> `remote_project`, no process call;
- active `xcode-select` fallback;
- persisted selected developer directory;
- missing simctl -> `xcode_missing`;
- nonzero first-launch status -> `license_required`;
- Xcode version parsing;
- malformed `simctl list --json`;
- unavailable runtimes/devices excluded.

Fixture:

```js
const SIMCTL_LIST = {
  runtimes: [{
    identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
    name: "iOS 26.0",
    isAvailable: true,
  }],
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [{
      udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      name: "iPhone 17",
      state: "Shutdown",
      isAvailable: true,
    }],
  },
};
```

- [ ] **Step 2: Run and verify red**

Run:

```sh
node --test --test-name-pattern="capabilit|developer|device" electron/test/ios-simulator.test.js
```

Expected: FAIL with `Cannot find module '../ios-simulator.js'`.

- [ ] **Step 3: Add typed errors and service constructor**

```js
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

function createIOSSimulatorService({
  store,
  userDataPath,
  worktreeBase = path.join(userDataPath, "worktrees"),
  platform = process.platform,
  processAdapter = createIOSSimulatorProcess(),
  artifactStore,
  prepareThreadWorktree = worktrees.prepareThreadWorktree,
  fsApi = fs,
  now = Date.now,
  randomUUID = crypto.randomUUID,
  broadcast = () => {},
  log = () => {},
}) {
  const preferencesFile = path.join(
    userDataPath,
    "ios-simulator-preferences.json",
  );
  let lease = null;
  let mutationTail = Promise.resolve();

  function resolveThread(threadId) {
    const thread = store.getThread(String(threadId));
    if (!thread) throw iosError("unexpected", `Unknown thread: ${threadId}`);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw iosError("unexpected", `Unknown project: ${thread.projectId}`);
    }
    if (platform !== "darwin") {
      throw iosError("unsupported_platform", "iOS Simulator requires macOS");
    }
    if (project.remoteHost) {
      throw iosError("remote_project", "iOS Simulator requires a local project");
    }
    return { thread, project };
  }

  async function getCapabilities({ threadId }) {
    resolveThread(threadId);
    return discoverCapabilities();
  }

  async function selectDeveloperDirectory({ threadId, developerDir }) {
    resolveThread(threadId);
    return validateAndPersistDeveloperDirectory(developerDir);
  }

  async function listDevices({ threadId }) {
    resolveThread(threadId);
    return discoverDevices();
  }

  return { getCapabilities, selectDeveloperDirectory, listDevices };
}
```

Add a private `resolveThread(threadId)` that throws `unexpected` for missing thread/project, then rejects platform and `project.remoteHost` before calling any other dependency.

- [ ] **Step 4: Implement preferences and discovery**

Read/write:

```json
{"version":1,"developerDir":"/Applications/Xcode.app/Contents/Developer"}
```

Use temp-file + `fsync` + rename and `0600`. `selectDeveloperDirectory({ threadId, developerDir })` validates the selected directory with `xcodeVersion` and `findSimctl` before persisting.

Add these discovery functions inside the service:

```js
async function readPreferences(file) {
  try {
    const parsed = JSON.parse(await fsApi.promises.readFile(file, "utf8"));
    return parsed && parsed.version === 1 ? parsed : null;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw iosError("unexpected", "Simulator preferences are invalid");
  }
}

async function writePreferences(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fsApi.promises.mkdir(path.dirname(file), { recursive: true });
  const handle = await fsApi.promises.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsApi.promises.rename(temp, file);
}

async function selectedDeveloperDirectory() {
  const saved = await readPreferences(preferencesFile);
  if (saved && typeof saved.developerDir === "string" && saved.developerDir) {
    return saved.developerDir;
  }
  return String(await processAdapter.activeDeveloperDir()).trim();
}

async function discoverRaw() {
  const developerDir = await selectedDeveloperDirectory();
  const versionText = String(
    await processAdapter.xcodeVersion(developerDir),
  ).trim();
  try {
    await processAdapter.firstLaunchStatus(developerDir);
  } catch {
    throw iosError("license_required", "Complete Xcode first-launch setup");
  }
  try {
    await processAdapter.findSimctl(developerDir);
  } catch {
    throw iosError("xcode_missing", "Full Xcode with Simulator is required");
  }
  let doc;
  try {
    doc = JSON.parse(await processAdapter.listDevices(developerDir));
  } catch {
    throw iosError("unexpected", "Simulator device list is invalid");
  }
  return {
    developerDir,
    xcode: parseXcodeVersion(versionText),
    ...parseSimulatorList(doc),
  };
}

async function discoverDevices() {
  return (await discoverRaw()).devices;
}

async function discoverCapabilities() {
  const raw = await discoverRaw();
  return capabilitySnapshot(raw);
}

async function validateAndPersistDeveloperDirectory(developerDir) {
  const selected = String(developerDir || "").trim();
  if (!path.isAbsolute(selected)) {
    throw iosError("xcode_missing", "Select an absolute Xcode developer directory");
  }
  await processAdapter.xcodeVersion(selected);
  await processAdapter.findSimctl(selected);
  await writePreferences(preferencesFile, {
    version: 1,
    developerDir: selected,
  });
  return discoverCapabilities();
}
```

`parseXcodeVersion`, `parseSimulatorList`, and `capabilitySnapshot` are pure exported test seams. `parseSimulatorList` joins `doc.devices[runtime.identifier]` only for `runtime.isAvailable === true` and device `isAvailable !== false`.

`getCapabilities` returns:

```js
{
  platform: "darwin",
  supported: true,
  developerDir,
  xcode: { version: "26.0", build: "17A123" },
  licenseAccepted: true,
  runtimes,
  capabilities: {
    deviceLifecycle: true,
    screenshot: true,
    recording: true,
    stream: false,
    touch: false,
    keyboard: false,
    hardwareButtons: false,
    accessibility: false,
  },
}
```

`listDevices` flattens only available devices under available runtimes and normalizes states to `Shutdown|Booted|Booting|Shutting Down|Unknown`.

- [ ] **Step 5: Run tests and commit**

Run:

```sh
node --test --test-name-pattern="capabilit|developer|device" electron/test/ios-simulator.test.js
```

Expected: PASS.

Commit:

```sh
git add electron/ios-simulator.js electron/test/ios-simulator.test.js
git commit -m "feat: discover local Xcode simulators"
```

---

### Task 3: Strict worktree and app-bundle validation

**Files:**
- Modify: `electron/ios-simulator.js`
- Extend: `electron/test/ios-simulator.test.js`

**Interfaces:**
- Produces internal `prepareAppBundle({ threadId, relativeAppPath })` for Task 4's lease-gated `install`.
- Consumes `prepareThreadWorktree` and process adapter `readBundleId`; it must not call `simctl install` before Task 4 adds ownership/generation validation.

- [ ] **Step 1: Add failing path tests**

Cover pending worktree materialization, disappeared worktree rematerialization, failed materialization with zero command calls, and plain checkout use. Reject:

- absolute, NUL, `..`, wrong extension;
- missing/non-directory `.app`;
- top-level or nested symlink escaping root;
- symlinked/missing `Info.plist`;
- malformed bundle ID.

Happy path returns an internal trusted descriptor. It may contain a host path because it never crosses IPC/MCP; no public result may expose it:

```js
const result = await service.prepareAppBundle({
  threadId: thread.id,
  relativeAppPath: "build/Products/App.app",
});
assert.equal(result.bundleId, "com.example.App");
assert.equal(result.appPath.endsWith("build/Products/App.app"), true);
```

- [ ] **Step 2: Run and verify red**

Run:

```sh
node --test --test-name-pattern="worktree|app|install" electron/test/ios-simulator.test.js
```

Expected: FAIL with `service.prepareAppBundle is not a function`.

- [ ] **Step 3: Implement trusted root resolution**

```js
async function resolveExecutionRoot(threadId) {
  let { thread, project } = resolveThread(threadId);
  const isolated = Boolean(thread.pendingWorktree || thread.worktreePath);
  if (isolated) {
    await prepareThreadWorktree({
      store,
      threadId,
      worktreeBase,
      broadcast,
    });
    thread = store.getThread(threadId);
    if (!thread || !thread.worktreePath) {
      throw iosError("worktree_missing", "Thread worktree is unavailable");
    }
  }
  const root = isolated ? thread.worktreePath : project.path;
  const canonical = await fsApi.promises.realpath(root);
  return { thread, project, root: canonical };
}
```

Do not catch materialization failure and substitute `project.path`.

- [ ] **Step 4: Implement bundle validation**

Require a relative `.app`, then:

```js
const candidate = path.resolve(root, relativeAppPath);
if (!isWithin(root, candidate)) throw invalidApp();
const canonical = await fsApi.promises.realpath(candidate);
if (!isWithin(root, canonical)) throw invalidApp();
```

Walk at most 20,000 entries with `lstat`. For every symlink, resolve its target and require `isWithin(root, target)`. Require a directory bundle and regular non-symlink `Info.plist`.

Validate bundle ID with:

```js
const BUNDLE_ID_RE =
  /^(?=.{1,255}$)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
```

- [ ] **Step 5: Run tests and commit**

Run:

```sh
node --test --test-name-pattern="worktree|app|install" electron/test/ios-simulator.test.js
```

Expected: PASS.

Commit:

```sh
git add electron/ios-simulator.js electron/test/ios-simulator.test.js
git commit -m "feat: validate worktree-scoped simulator apps safely"
```

---

### Task 4: Serialized device lease, boot, app launch, and URL open

**Files:**
- Modify: `electron/ios-simulator.js`
- Extend: `electron/test/ios-simulator.test.js`

**Interfaces:**
- Produces `getStatus`, `attach`, `takeover`, `boot`, `detach`, `install`, `launch`, `openUrl`.
- Every mutating call except initial attach carries `{ threadId, generation }`.

- [ ] **Step 1: Write failing lease tests**

Cover:

- first attach journals generation 1;
- same owner/device idempotence;
- different thread -> `device_busy`;
- device already booted -> `bootedBySolenta:false`;
- shutdown device -> boot + bootstatus + `bootedBySolenta:true`;
- stale generation rejected before process calls;
- takeover requires `confirmed:true`, invalidates old generation before awaits;
- old deferred action cannot mutate after takeover;
- detach shuts down only Solenta-booted device;
- launch PID parsing;
- URL max 2,048 and rejects `file`, `javascript`, `data`, `about`.

- [ ] **Step 2: Run and verify red**

Run:

```sh
node --test --test-name-pattern="lease|attach|boot|takeover|launch|url" electron/test/ios-simulator.test.js
```

Expected: FAIL because lease methods are undefined.

- [ ] **Step 3: Add the atomic journal**

Use `userData/ios-simulator-lease.json`:

```js
{
  version: 1,
  state: "active",
  generation,
  ownerThreadId,
  ownerProjectId,
  deviceUdid,
  developerDir,
  bootedBySolenta,
  acquiredAt,
  lastActivityAt,
  recording: null,
}
```

Implement `writeJournal` with temp file, file `fsync`, rename, and best-effort directory `fsync`.

- [ ] **Step 4: Serialize mutations and validate generation**

Use one promise queue:

```js
let mutationTail = Promise.resolve();
function mutate(fn) {
  const next = mutationTail.then(fn, fn);
  mutationTail = next.catch(() => {});
  return next;
}
```

Inside the queue, reload/check owner and generation immediately before each process call. Takeover changes state to `releasing` and increments generation before awaiting old cleanup.

- [ ] **Step 5: Implement lifecycle actions**

`attach` requires a UDID present in a fresh device list. `boot` treats an already-booted device as success without changing ownership. `install` validates owner/generation, calls Task 3's `prepareAppBundle`, validates owner/generation again, then calls the fixed process-adapter install method; its public result contains only `bundleId`. `launch` parses `<bundleId>: <pid>` and returns `pid:null` for unknown-but-successful output. `openUrl` parses with `new URL`, then rejects blocked schemes.

- [ ] **Step 6: Run tests and commit**

Run:

```sh
node --test --test-name-pattern="lease|attach|boot|takeover|launch|url" electron/test/ios-simulator.test.js
```

Expected: PASS.

Commit:

```sh
git add electron/ios-simulator.js electron/test/ios-simulator.test.js
git commit -m "feat: serialize shared simulator ownership"
```

---

### Task 5: Screenshot artifacts

**Files:**
- Modify: `electron/ios-simulator.js`
- Extend: `electron/test/ios-simulator.test.js`

**Interfaces:**
- Consumes plan-01 `artifactStore.stage`, `commitBatch`, and `discard`.
- Produces `captureScreenshot({ threadId, generation, runId, toolCallId? })`.

- [ ] **Step 1: Write failing screenshot tests**

Assert stale/non-owner requests do not stage or spawn. For success:

```js
const info = await service.captureScreenshot({
  threadId: thread.id,
  generation: lease.generation,
  runId: "r1",
  toolCallId: "tool1",
});
assert.equal(info.source, "simulator");
assert.equal(info.kind, "image");
assert.equal(info.runId, "r1");
assert.equal(info.path, undefined);
```

Assert simctl failure calls `discard`; preserve `artifact_limit` unchanged.

- [ ] **Step 2: Run and verify red**

Run: `node --test --test-name-pattern="screenshot" electron/test/ios-simulator.test.js`

Expected: FAIL because `captureScreenshot` is undefined.

- [ ] **Step 3: Implement capture**

Stage PNG, run exact screenshot command, commit one item:

```js
const [info] = await artifactStore.commitBatch({
  threadId,
  runId,
  toolCallId,
  source: "simulator",
  items: [{
    key: "screenshot",
    stagingToken: staged.token,
    kind: "image",
    mimeType: "image/png",
    name: "Simulator screenshot.png",
  }],
});
```

Discard in `catch` unless commit consumed the token.

- [ ] **Step 4: Run and commit**

Run: `node --test --test-name-pattern="screenshot" electron/test/ios-simulator.test.js`

Expected: PASS.

Commit:

```sh
git add electron/ios-simulator.js electron/test/ios-simulator.test.js
git commit -m "feat: capture simulator screenshot artifacts"
```

---

### Task 6: Recording finalization and crash recovery

**Files:**
- Modify: `electron/ios-simulator.js`
- Extend: `electron/test/ios-simulator.test.js`

**Interfaces:**
- Produces `startRecording`, `stopRecording`, and `recover`.
- Video and poster metadata become visible in one `commitBatch`.

- [ ] **Step 1: Write failing recording tests**

Cover:

- journal intent with `pid:null` before spawn and PID immediately after;
- duplicate start refused;
- stop sends `SIGINT`, waits for close, captures poster, commits one batch;
- five-minute timeout auto-stops;
- size over 250 MiB interrupts and returns `artifact_limit`;
- finalize timeout sends `SIGKILL`, discards staging, registers nothing;
- corrupt MP4 registers neither video nor poster;
- recovery signals only a PID whose `/bin/ps` command contains exact UDID and staged path;
- corrupt journal performs zero signal/simctl actions;
- recovery shuts down only `bootedBySolenta:true`.

- [ ] **Step 2: Run and verify red**

Run:

```sh
node --test --test-name-pattern="record|recover" electron/test/ios-simulator.test.js
```

Expected: FAIL because recording/recovery methods are undefined.

- [ ] **Step 3: Implement recording state**

Before spawning, persist:

```js
recording: {
  stagingToken,
  tempPath,
  pid: null,
  startedAt: now(),
  runId,
  toolCallId,
}
```

After spawn, persist PID. Check file size every second and schedule a five-minute stop. `stopRecording` sends `SIGINT`, waits up to 10 seconds, then `SIGKILL`s and rejects if the child did not finalize.

- [ ] **Step 4: Commit poster/video atomically**

After MP4 close, stage/capture PNG poster and call:

```js
const [video, poster] = await artifactStore.commitBatch({
  threadId,
  runId,
  toolCallId,
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
});
```

`commitBatch` preserves item order, so this destructuring is the stable contract defined by plan 01.

- [ ] **Step 5: Implement recovery**

Quarantine malformed journal as `.corrupt-<timestamp>` and perform no mutation. For valid recording PID, call process inspection and signal only on exact command/path/UDID match. Keep the journal if cleanup fails so next launch retries. Never erase a device.

- [ ] **Step 6: Run tests and commit**

Run:

```sh
node --test --test-name-pattern="record|recover" electron/test/ios-simulator.test.js
```

Expected: PASS.

Commit:

```sh
git add electron/ios-simulator.js electron/test/ios-simulator.test.js
git commit -m "feat: finalize and recover simulator recordings"
```

---

### Task 7: Thread lifecycle and awaitable app shutdown

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/runner.js`
- Modify: `electron/services.js`
- Modify: `electron/ipc.js`
- Modify: `electron/shutdown.js`
- Modify: `scripts/test-electron.js`
- Create: `electron/test/ios-simulator-lifecycle.test.js`
- Modify: `electron/test/shutdown.test.js`

**Interfaces:**
- Consumes the complete service.
- Produces exactly-once async cleanup during quit and ownership release after durable thread/project lifecycle operations.

- [ ] **Step 1: Write failing lifecycle tests**

Prove:

- successful archive/delete releases the thread; failed deletion does not;
- successful project removal releases project; rejected active-run removal does not;
- run terminal stops only a recording with the same run ID;
- repeated `before-quit`/signals await one cleanup promise and exit once;
- shutdown order stops runs, awaits simulator finalization, then tears down remaining services.

- [ ] **Step 2: Run and verify red**

Run:

```sh
node --test electron/test/ios-simulator-lifecycle.test.js electron/test/shutdown.test.js
```

Expected: FAIL because lifecycle callbacks and async shutdown are absent.

- [ ] **Step 3: Make shutdown awaitable**

Change `installShutdown` to accept `cleanup: () => void | Promise<void>`. On first quit:

```js
event.preventDefault();
cleanupPromise ??= Promise.resolve()
  .then(cleanup)
  .finally(() => app.exit(0));
```

Repeated quit/signals reuse `cleanupPromise`; guard `app.exit` exactly once.

- [ ] **Step 4: Wire service lifecycle**

Construct the service after Store/artifact store. `await iosSimulator.recover()` before exposing use. Add service to `makeCtx` without adding public handlers.

After successful archive/delete/project removal, call `releaseThread`/`releaseProject` best-effort. In runner terminal notification call:

```js
iosSimulator.onRunTerminal({ threadId, runId, status });
```

Synchronous revocation of matching lease/recording state must happen before the first await.

- [ ] **Step 5: Keep injected tests cross-platform**

Add new simulator test files to the explicit Windows test allowlist in `scripts/test-electron.js`; all platform/process dependencies are fake.

- [ ] **Step 6: Run complete verification and commit**

Run:

```sh
node --test electron/test/ios-simulator-lifecycle.test.js electron/test/shutdown.test.js
npm run typecheck
npm run build
npm run test:electron
npm test
```

Expected: PASS without Xcode.

Commit:

```sh
git add electron/main.js electron/runner.js electron/services.js electron/ipc.js electron/shutdown.js scripts/test-electron.js electron/test/ios-simulator-lifecycle.test.js electron/test/shutdown.test.js
git commit -m "feat: bind simulator cleanup to thread and app lifecycle"
```

## Self-Review Coverage

- Xcode/runtime/device discovery: Task 2
- Strict worktree and `.app` containment: Task 3
- Single shared lease, generation, takeover, ownership-aware shutdown: Task 4
- Durable screenshot artifacts: Task 5
- H.264 MP4 recording, poster, limits, SIGINT finalization: Task 6
- Crash journal and recovery: Tasks 4 and 6
- Archive/delete/project/run/app cleanup: Task 7
- Native live helper, pane/input/accessibility, renderer IPC, MCP identity, and approvals are intentionally deferred to plans 03 and 04.
