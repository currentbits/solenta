"use strict";

// createIOSSimulatorService seam: helper session I/O — the stream broker
// lookup, session disconnect, the ready wait and the control-pipe RPC
// (#1447 pass V2, seam 6). The `helper` slot and the helper lifecycle
// (startHelper, stopHelper, onHelperExit) stay in ios-simulator.js;
// helperSessionWritable, which reads `helper` and `lease`, is reached
// through ctx. Convention: see the header of electron/runner-watchdogs.js;
// plan: docs/superpowers/specs/2026-10-05-ios-simulator-split.md.

const protocol = require("./ios-simulator-protocol.js");
const { iosError, leaseStale } = require("./ios-simulator-parse.js");

const HELPER_READY_TIMEOUT_MS = 5_000;
const HELPER_RPC_TIMEOUT_MS = 10_000;

/**
 * @param {object} ctx - createIOSSimulatorService context
 */
function createHelper(ctx) {
  const {
    streamBroker,
    getStreamBroker,
    setTimer,
    clearTimer,
    helperSessionWritable,
    helperDisconnected,
  } = ctx;

  function currentStreamBroker() {
    if (typeof getStreamBroker === "function") return getStreamBroker();
    return streamBroker;
  }

  function disconnectHelperSession(session) {
    session.stream = "disconnected";
    session.input = "disconnected";
    session.accessibility = "disconnected";
    const broker = currentStreamBroker();
    if (session.streamInfo && broker && typeof broker.closeSession === "function") {
      try {
        broker.closeSession(session.streamInfo.generation);
      } catch {
        // ignore
      }
      session.streamInfo = null;
    }
  }

  function waitForHelperReady(session) {
    if (session.ready) return Promise.resolve();
    if (session.exited) return Promise.reject(helperDisconnected());
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        session.readyResolve = null;
        session.readyReject = null;
        reject(iosError("timeout", "Simulator helper did not become ready"));
      }, HELPER_READY_TIMEOUT_MS);
      session.readyResolve = () => {
        clearTimer(timer);
        resolve();
      };
      session.readyReject = (err) => {
        clearTimer(timer);
        reject(err);
      };
      if (session.exited) {
        session.readyReject(helperDisconnected());
      }
    });
  }

  function helperRpcWithSession(session, method, payload) {
    if (!session || !session.child) {
      return Promise.reject(helperDisconnected());
    }
    const controlIn = session.child.stdio && session.child.stdio[3];
    if (!controlIn || typeof controlIn.write !== "function") {
      return Promise.reject(helperDisconnected());
    }
    if (!helperSessionWritable(session)) {
      return Promise.reject(leaseStale());
    }
    const id = session.nextId;
    session.nextId += 1;
    const frame = {
      id,
      method,
      generation: session.generation,
      token: session.controlToken,
      ...(payload && typeof payload === "object" ? payload : {}),
    };
    if (payload && typeof payload === "object") {
      frame.payload = payload;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        session.pending.delete(id);
        reject(iosError("timeout", "Simulator helper did not respond"));
      }, HELPER_RPC_TIMEOUT_MS);
      session.pending.set(id, {
        resolve(result) {
          clearTimer(timer);
          resolve(result);
        },
        reject(err) {
          clearTimer(timer);
          reject(err);
        },
      });
      try {
        if (!helperSessionWritable(session)) {
          session.pending.delete(id);
          clearTimer(timer);
          reject(leaseStale());
          return;
        }
        controlIn.write(protocol.encodeControl(frame));
      } catch (err) {
        session.pending.delete(id);
        clearTimer(timer);
        reject(helperDisconnected());
      }
    });
  }

  return {
    currentStreamBroker,
    disconnectHelperSession,
    waitForHelperReady,
    helperRpcWithSession,
  };
}

module.exports = { createHelper };
