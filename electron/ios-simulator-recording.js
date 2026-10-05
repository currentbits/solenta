"use strict";

// createIOSSimulatorService seam: recorder I/O — the size poll and timers,
// forced kill, bounded close wait, and the finalization that commits or
// discards the video (#1447 pass V2, seam 5). The `recording` and
// `finishedRecording` slots stay in ios-simulator.js; finalizeRecording,
// which retires them, is reached through ctx. Convention: see the header of
// electron/runner-watchdogs.js; plan:
// docs/superpowers/specs/2026-10-05-ios-simulator-split.md.

const { IOSSimulatorError, iosError } = require("./ios-simulator-parse.js");

const MAX_RECORDING_BYTES = 250 * 1024 * 1024;
const RECORDING_POLL_INTERVAL_MS = 1_000;
const RECORDING_FINALIZE_TIMEOUT_MS = 10_000;

function recordingFinalizeFailed() {
  return iosError(
    "recording_finalize_failed",
    "Failed to finalize the simulator recording",
  );
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

/**
 * @param {object} ctx - createIOSSimulatorService context
 */
function createRecording(ctx) {
  const {
    setTimer,
    clearTimer,
    fsApi,
    signalPid,
    artifactStore,
    processAdapter,
    callProcess,
    recordingFailed,
    discardStagedArtifactBestEffort,
    clearRecordingJournalBestEffort,
    finalizeRecording,
    finalizeIfRecorderClosed,
  } = ctx;

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

  function beginFinalization(context, reason) {
    if (!context.finalization) {
      context.reason = reason;
      context.finalization = finalizeRecording(context);
      // Timer- and handoff-driven finalizations have no awaiting caller.
      context.finalization.catch(() => {});
    }
    return context.finalization;
  }

  return {
    observeRecordingClose,
    scheduleRecordingPoll,
    runRecordingFinalization,
    beginFinalization,
  };
}

module.exports = { createRecording };
