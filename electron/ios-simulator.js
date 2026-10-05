"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const {
  createIOSSimulatorProcess,
} = require("./ios-simulator-process.js");
const { createIOSSimulatorToolchain } = require("./ios-simulator-toolchain.js");
const protocol = require("./ios-simulator-protocol.js");
const { createJournal } = require("./ios-simulator-journal.js");
const { createDevices } = require("./ios-simulator-devices.js");
const { createAppBundle } = require("./ios-simulator-app-bundle.js");
const { createRecovery } = require("./ios-simulator-recovery.js");
const { createRecording } = require("./ios-simulator-recording.js");
const { createHelper } = require("./ios-simulator-helper.js");
const { createInput } = require("./ios-simulator-input.js");
const worktrees = require("./worktrees.js");
const {
  BUNDLE_ID_RE,
  IOSSimulatorError,
  iosError,
  parseXcodeVersion,
  parseSimulatorList,
  capabilitySnapshot,
  validateUserDataPath,
  invalidBundle,
  leaseStale,
  validateSimulatorUrl,
  parseLaunchPid,
  helperSpawnArgs,
} = require("./ios-simulator-parse.js");

const DEFAULT_SANDBOX_PROFILE = path.resolve(
  __dirname,
  "../native/ios-simulator-helper/Resources/helper.sb",
);

const RECORDING_MAX_DURATION_MS = 5 * 60 * 1_000;
const ARTIFACT_STAGING_SEGMENTS = ["run-artifacts", ".staging"];

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

async function callProcess(fn, failureMessage) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IOSSimulatorError) throw err;
    throw iosError("unexpected", failureMessage);
  }
}

function disconnectedHelperState() {
  return {
    stream: "disconnected",
    input: "disconnected",
    accessibility: "disconnected",
  };
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

function releaseSummary(fields = {}) {
  return Object.freeze({
    released: fields.released === true,
    stoppedRecording: fields.stoppedRecording === true,
    shutDownDevice: fields.shutDownDevice === true,
    journalCleared: fields.journalCleared === true,
  });
}

function normalizeRunId(rawRunId) {
  if (rawRunId == null || rawRunId === "") return null;
  return String(rawRunId);
}

function recordingFailed() {
  return iosError(
    "recording_failed",
    "Failed to start the simulator recording",
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

function recoverySummary(fields = {}) {
  return Object.freeze({
    recovered: fields.recovered === true,
    quarantined: fields.quarantined === true,
    cleanedRecording: fields.cleanedRecording === true,
    shutDownDevice: fields.shutDownDevice === true,
    journalRetained: fields.journalRetained === true,
  });
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

  // Shared context for the seam modules (`electron/ios-simulator-<seam>.js`,
  // #1447). Built after the derived consts and the `let`s; seam factories
  // destructure only what is on it when they run (see the header of
  // electron/runner-watchdogs.js). Hoisted function declarations of this
  // factory exist already, so they go on the literal.
  const ctx = {
    fsApi,
    randomUUID,
    now,
    leaseJournalFile,
    processAdapter,
    preferencesFile,
    resolvedToolchain,
    resolveThread,
    helperCapsForSnapshot,
    store,
    prepareThreadWorktree,
    resolvedWorktreeBase,
    broadcast,
    stagingRoot,
    sandboxProfilePath,
    signalPid,
    delay,
    recoverySummary,
    setTimer,
    clearTimer,
    artifactStore,
    callProcess,
    recordingFailed,
    discardStagedArtifactBestEffort,
    clearRecordingJournalBestEffort,
    finalizeRecording,
    finalizeIfRecorderClosed,
    streamBroker,
    getStreamBroker,
    helperSessionWritable,
    helperDisconnected,
    mutate,
    withHelper,
    assertHelperSession,
    touchLeaseActivityBestEffort,
  };

  const {
    readPreferences,
    writePreferences,
    writeJournal,
    removeJournal,
    readLeaseJournalRecord,
    quarantineJournal,
    removeJournalStrict,
  } = createJournal(ctx);
  // createDevices destructures these eagerly.
  Object.assign(ctx, { readPreferences, writePreferences });

  const {
    selectedDeveloperDirectory,
    discoverRaw,
    getCapabilities,
    selectDeveloperDirectory,
    listDevices,
    discoverToolchains,
    fingerprintToolchain,
    ensureHelper,
  } = createDevices(ctx);
  // createAppBundle destructures this eagerly.
  ctx.selectedDeveloperDirectory = selectedDeveloperDirectory;

  const { prepareAppBundle } = createAppBundle(ctx);
  // createRecovery destructures these eagerly.
  Object.assign(ctx, { quarantineJournal, writeJournal });

  const {
    resolveRecoveryTempPath,
    stopRecoveredHelperProcess,
    stopRecoveredRecordingProcess,
    removeRecoveredTempFile,
    trustedRecoveryDeveloperDir,
    shutdownRecoveredDevice,
    quarantineSummary,
    retainJournalWithoutRecording,
  } = createRecovery(ctx);

  const {
    observeRecordingClose,
    scheduleRecordingPoll,
    runRecordingFinalization,
    beginFinalization,
  } = createRecording(ctx);

  const {
    currentStreamBroker,
    disconnectHelperSession,
    waitForHelperReady,
    helperRpcWithSession,
  } = createHelper(ctx);
  // createInput destructures this eagerly.
  ctx.helperRpcWithSession = helperRpcWithSession;

  const {
    tap,
    swipe,
    typeText,
    pressButton,
    sendInput,
    accessibility,
    scrollTo,
  } = createInput(ctx);

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

  function nextGeneration() {
    const generation = lastGeneration + 1;
    lastGeneration = generation;
    return generation;
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

  function delay(ms) {
    return new Promise((resolve) => {
      setTimer(() => resolve(undefined), ms);
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
