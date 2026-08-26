"use strict";

/**
 * Loopback WebSocket broker for simulator helper → viewer video (#248).
 * Drops delta frames under viewer backpressure; requests IDR on recovery.
 */

const crypto = require("node:crypto");
const { WebSocketServer: DefaultWebSocketServer, WebSocket } = require("ws");
const protocol = require("./ios-simulator-protocol.js");

const HEADER_SIZE = 32;
const DEFAULT_BITRATE = 1_500_000;
const MIN_BITRATE = 500_000;

/**
 * @param {string} a
 * @param {string} b
 */
function tokensEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * @param {import("ws").WebSocket} ws
 */
function safeTerminate(ws) {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  } catch {
    // ignore
  }
  try {
    ws.terminate();
  } catch {
    // ignore
  }
}

/**
 * @param {{
 *   WebSocketServer?: typeof DefaultWebSocketServer,
 *   randomBytes?: typeof crypto.randomBytes,
 *   decodeRecord?: typeof protocol.decodeVideoRecord,
 *   getBufferedAmount?: (ws: import("ws").WebSocket) => number,
 *   log?: (msg: string) => void,
 * }} [opts]
 */
function createIOSSimulatorStreamBroker({
  WebSocketServer = DefaultWebSocketServer,
  randomBytes = crypto.randomBytes,
  decodeRecord = protocol.decodeVideoRecord,
  getBufferedAmount = (ws) => ws.bufferedAmount,
  log = () => {},
} = {}) {
  /** @type {import("ws").WebSocketServer | null} */
  let wss = null;
  /** @type {{ address: string, family: string, port: number } | null} */
  let bound = null;

  /**
   * @typedef {{
   *   generation: number,
   *   helperToken: string,
   *   viewerToken: string,
   *   requestKeyframe: () => void,
   *   setBitrate: (bps: number) => void,
   *   helper: import("ws").WebSocket | null,
   *   viewer: import("ws").WebSocket | null,
   *   dropping: boolean,
   *   keyframeRequested: boolean,
   *   bitrate: number,
   * }} Session
   */

  /** @type {Map<number, Session>} */
  const sessions = new Map();

  /**
   * @param {import("ws").WebSocket} ws
   * @param {Buffer | ArrayBuffer | Buffer[]} raw
   * @param {boolean} isBinary
   */
  function asBuffer(raw, isBinary) {
    if (Buffer.isBuffer(raw)) return raw;
    if (Array.isArray(raw)) return Buffer.concat(raw);
    if (raw instanceof ArrayBuffer) return Buffer.from(raw);
    return Buffer.from(raw);
  }

  /**
   * @param {Session} session
   * @param {number} next
   */
  function applyBitrate(session, next) {
    const bps = Math.max(MIN_BITRATE, Math.floor(next));
    session.bitrate = bps;
    try {
      session.setBitrate(bps);
    } catch (err) {
      log(
        `ios-simulator-stream: setBitrate failed generation=${session.generation}: ${
          err && err.message ? err.message : err
        }`,
      );
    }
  }

  /**
   * @param {Session} session
   */
  function cutBitrate(session) {
    applyBitrate(session, session.bitrate / 2);
  }

  /**
   * @param {Session} session
   * @param {Buffer} data
   */
  function handleHelperBinary(session, data) {
    if (data.length > HEADER_SIZE + protocol.limits.maxVideoBytes) {
      log(
        `ios-simulator-stream: video too large generation=${session.generation} bytes=${data.length}`,
      );
      if (session.helper) safeTerminate(session.helper);
      return;
    }

    let record;
    try {
      record = decodeRecord(data);
    } catch (err) {
      log(
        `ios-simulator-stream: malformed video generation=${session.generation}: ${
          err && err.code ? err.code : err && err.message ? err.message : err
        }`,
      );
      if (session.helper) safeTerminate(session.helper);
      return;
    }

    const viewer = session.viewer;
    if (!viewer || viewer.readyState !== WebSocket.OPEN) return;

    const buffered = getBufferedAmount(viewer);

    if (record.type === "delta") {
      if (buffered > protocol.limits.dropViewerBytes) {
        if (!session.dropping) {
          session.dropping = true;
          session.keyframeRequested = false;
          cutBitrate(session);
          log(
            `ios-simulator-stream: drop deltas generation=${session.generation} buffered=${buffered}`,
          );
        }
        return;
      }

      if (session.dropping) {
        if (buffered >= protocol.limits.recoverViewerBytes) {
          return;
        }
        session.dropping = false;
        if (!session.keyframeRequested) {
          session.keyframeRequested = true;
          try {
            session.requestKeyframe();
          } catch (err) {
            log(
              `ios-simulator-stream: requestKeyframe failed generation=${session.generation}: ${
                err && err.message ? err.message : err
              }`,
            );
          }
          log(
            `ios-simulator-stream: recovered generation=${session.generation} buffered=${buffered}`,
          );
        }
      }
    } else if (
      session.dropping &&
      buffered < protocol.limits.recoverViewerBytes &&
      !session.keyframeRequested
    ) {
      // Recovery observed on a non-delta while still marked dropping.
      session.dropping = false;
      session.keyframeRequested = true;
      try {
        session.requestKeyframe();
      } catch (err) {
        log(
          `ios-simulator-stream: requestKeyframe failed generation=${session.generation}: ${
            err && err.message ? err.message : err
          }`,
        );
      }
    }

    try {
      viewer.send(data, { binary: true });
    } catch (err) {
      log(
        `ios-simulator-stream: forward failed generation=${session.generation}: ${
          err && err.message ? err.message : err
        }`,
      );
    }
  }

  /**
   * @param {import("ws").WebSocket} ws
   */
  function attachSocket(ws) {
    let authed = false;
    /** @type {Session | null} */
    let session = null;
    /** @type {"helper" | "viewer" | null} */
    let role = null;

    ws.on("message", (raw, isBinary) => {
      const data = asBuffer(raw, isBinary);

      if (!authed) {
        if (isBinary) {
          safeTerminate(ws);
          return;
        }
        let msg;
        try {
          msg = JSON.parse(data.toString("utf8"));
        } catch {
          safeTerminate(ws);
          return;
        }
        if (
          !msg ||
          typeof msg !== "object" ||
          typeof msg.token !== "string" ||
          typeof msg.generation !== "number"
        ) {
          safeTerminate(ws);
          return;
        }

        const candidate = sessions.get(msg.generation >>> 0);
        if (!candidate) {
          safeTerminate(ws);
          return;
        }

        if (tokensEqual(msg.token, candidate.helperToken)) {
          role = "helper";
        } else if (tokensEqual(msg.token, candidate.viewerToken)) {
          role = "viewer";
        } else {
          safeTerminate(ws);
          return;
        }

        // Generation in the auth message must match the session key exactly.
        if (msg.generation !== candidate.generation) {
          safeTerminate(ws);
          return;
        }

        authed = true;
        session = candidate;
        if (role === "helper") {
          if (session.helper && session.helper !== ws) safeTerminate(session.helper);
          session.helper = ws;
        } else {
          if (session.viewer && session.viewer !== ws) safeTerminate(session.viewer);
          session.viewer = ws;
        }
        log(
          `ios-simulator-stream: ${role} connected generation=${session.generation}`,
        );
        return;
      }

      // Authed: only binary video from the helper. Later text is rejected.
      if (!isBinary) {
        safeTerminate(ws);
        return;
      }
      if (role !== "helper" || !session) {
        safeTerminate(ws);
        return;
      }
      handleHelperBinary(session, data);
    });

    ws.on("close", () => {
      if (!session || !role) return;
      if (role === "helper" && session.helper === ws) session.helper = null;
      if (role === "viewer" && session.viewer === ws) session.viewer = null;
    });

    ws.on("error", () => {
      safeTerminate(ws);
    });
  }

  /**
   * @returns {Promise<{ address: string, family: string, port: number }>}
   */
  function listen() {
    if (wss && bound) return Promise.resolve(bound);

    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      server.on("connection", attachSocket);
      server.once("error", (err) => {
        wss = null;
        bound = null;
        reject(err);
      });
      server.once("listening", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          wss = null;
          bound = null;
          try {
            server.close();
          } catch {
            // ignore
          }
          reject(new Error("ios-simulator-stream: failed to bind loopback"));
          return;
        }
        if (addr.address !== "127.0.0.1") {
          wss = null;
          bound = null;
          try {
            server.close();
          } catch {
            // ignore
          }
          reject(new Error(`ios-simulator-stream: refused non-loopback bind ${addr.address}`));
          return;
        }
        wss = server;
        bound = {
          address: addr.address,
          family: addr.family,
          port: addr.port,
        };
        log(`ios-simulator-stream: listening on 127.0.0.1:${bound.port}`);
        resolve(bound);
      });
    });
  }

  /**
   * @param {{
   *   generation: number,
   *   requestKeyframe?: () => void,
   *   setBitrate?: (bps: number) => void,
   * }} opts
   */
  function createSession({
    generation,
    requestKeyframe = () => {},
    setBitrate = () => {},
  }) {
    if (!bound) throw new Error("ios-simulator-stream: not listening");
    const gen = generation >>> 0;
    const existing = sessions.get(gen);
    if (existing) {
      closeSession(gen);
    }

    let helperToken = randomBytes(32).toString("base64url");
    let viewerToken = randomBytes(32).toString("base64url");
    // Helper and viewer tokens must differ.
    while (helperToken === viewerToken) {
      viewerToken = randomBytes(32).toString("base64url");
    }

    /** @type {Session} */
    const session = {
      generation: gen,
      helperToken,
      viewerToken,
      requestKeyframe,
      setBitrate,
      helper: null,
      viewer: null,
      dropping: false,
      keyframeRequested: false,
      bitrate: DEFAULT_BITRATE,
    };
    sessions.set(gen, session);
    log(`ios-simulator-stream: session created generation=${gen}`);

    return {
      url: `ws://127.0.0.1:${bound.port}`,
      helperToken,
      viewerToken,
      generation: gen,
    };
  }

  /**
   * @param {number} generation
   */
  function closeSession(generation) {
    const gen = generation >>> 0;
    const session = sessions.get(gen);
    if (!session) return;
    sessions.delete(gen);
    if (session.helper) safeTerminate(session.helper);
    if (session.viewer) safeTerminate(session.viewer);
    session.helper = null;
    session.viewer = null;
    log(`ios-simulator-stream: session closed generation=${gen}`);
  }

  /**
   * Safe snapshot for diagnostics — never includes tokens.
   */
  function status() {
    return {
      listening: Boolean(wss && bound),
      address: bound ? bound.address : null,
      port: bound ? bound.port : null,
      sessions: [...sessions.values()].map((s) => ({
        generation: s.generation,
        helperConnected: Boolean(s.helper),
        viewerConnected: Boolean(s.viewer),
        dropping: s.dropping,
        bitrate: s.bitrate,
      })),
    };
  }

  /**
   * @returns {Promise<void>}
   */
  function close() {
    for (const gen of [...sessions.keys()]) {
      closeSession(gen);
    }
    const server = wss;
    wss = null;
    bound = null;
    if (!server) return Promise.resolve();

    return new Promise((resolve) => {
      for (const client of server.clients) {
        safeTerminate(client);
      }
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  return {
    listen,
    createSession,
    closeSession,
    close,
    status,
  };
}

module.exports = {
  createIOSSimulatorStreamBroker,
  MIN_BITRATE,
  DEFAULT_BITRATE,
};
