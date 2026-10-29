"use strict";

/**
 * Discord transport for chat channels (#1718) over the Gateway, so no public
 * URL. Hello (op 10) gives the heartbeat interval; we IDENTIFY (op 2) with
 * the DIRECT_MESSAGES intent only (a bot's own DMs carry content without the
 * privileged MESSAGE_CONTENT intent), heartbeat (op 1) with the last
 * sequence, and RESUME (op 6) on resume_gateway_url after a drop, a
 * RECONNECT (op 7) or a missed heartbeat ACK. REST (send, interaction
 * callbacks) goes through fetch. Uses the platform WebSocket, no dependency.
 *
 * Timers are ref'd and cleared on stop() / socket close, and stop() closes
 * the socket, so nothing outlives a disconnect.
 */

const { chunkText } = require("./telegram.js");

const API = "https://discord.com/api/v10";
const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const QUERY = "/?v=10&encoding=json";
// Discord's hard cap on one message's content.
const MAX_TEXT = 2000;
const INTENT_DIRECT_MESSAGES = 1 << 12;
// Bad token, bad shard, bad / disallowed intents: retrying never helps.
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
// Invalid seq / session timed out: reconnect with a fresh IDENTIFY.
const FRESH_CLOSE = new Set([4007, 4009]);
// Our own close code for "drop this socket but keep the session resumable"
// (1000 / 1001 would end the session).
const RESUMABLE = 4000;
const BACKOFF_MAX_MS = 60_000;

/**
 * @param {object} opts
 * @param {string} opts.token bot token
 * @param {typeof fetch} [opts.fetch]
 * @param {typeof WebSocket} [opts.WebSocket]
 * @param {string} [opts.gatewayUrl]
 * @param {(msg: { chatId: string, chatType: string, senderId: string, text: string }) => Promise<void> | void} opts.onMessage
 * @param {(press: { id: string, chatId: string, chatType: string, senderId: string, data: string }) => Promise<void> | void} opts.onButton
 * @param {(state: { state: "connected" | "error", error?: string }) => void} [opts.onState]
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.backoffMs] first retry delay
 */
function createDiscord(opts) {
  const doFetch = opts.fetch || globalThis.fetch;
  const WS = opts.WebSocket || globalThis.WebSocket;
  const log = opts.log || (() => {});
  const onState = opts.onState || (() => {});
  const backoffStart = opts.backoffMs ?? 1000;
  let stopped = true;
  /** @type {WebSocket | null} */
  let socket = null;
  /** Ends the current runSocket without waiting for its close event. */
  let endSocket = /** @type {(() => void) | null} */ (null);
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {(() => void) | null} */
  let wake = null;
  /** @type {Promise<void> | null} */
  let loopDone = null;
  /** @type {{ id: string | null, seq: number | null, resumeUrl: string | null }} */
  const session = { id: null, seq: null, resumeUrl: null };
  let handlers = Promise.resolve();

  /**
   * @param {string} label for errors; never the path (interaction tokens)
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   */
  async function call(label, method, path, body) {
    const res = await doFetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bot ${opts.token}`,
        "content-type": "application/json",
        "user-agent": "DiscordBot (https://solenta.app, 1)",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    let json = null;
    try {
      json = await res.json();
    } catch {
      // Fall through to the status error.
    }
    if (!res.ok) {
      const err = new Error(`Discord ${label} failed (HTTP ${res.status})${json && json.message ? `: ${json.message}` : ""}`);
      /** @type {any} */ (err).status = res.status;
      throw err;
    }
    return json;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(() => {
        timer = null;
        wake = null;
        resolve(undefined);
      }, ms);
    });
  }

  /** @param {string} t @param {any} d */
  async function dispatch(t, d) {
    if (t === "MESSAGE_CREATE") {
      // Our own replies (and any other bot) come back as MESSAGE_CREATE too.
      if (!d.author || d.author.bot) return;
      await opts.onMessage({
        chatId: String(d.channel_id),
        chatType: d.guild_id ? "guild" : "private",
        senderId: String(d.author.id),
        text: typeof d.content === "string" ? d.content : "",
      });
    } else if (t === "INTERACTION_CREATE" && d.type === 3) {
      const user = d.user || (d.member && d.member.user);
      if (!user || !d.data) return;
      await opts.onButton({
        // answerButton needs both; ids are snowflakes, tokens have no "/".
        id: `${d.id}/${d.token}`,
        chatId: String(d.channel_id),
        chatType: d.guild_id ? "guild" : "private",
        senderId: String(user.id),
        data: String(d.data.custom_id || ""),
      });
    }
  }

  /**
   * One socket's life. Resolves on close with whether the session became
   * ready (READY / RESUMED) and the close code.
   * @param {string} url
   * @returns {Promise<{ ready: boolean, code: number, invalid: boolean }>}
   */
  function runSocket(url) {
    return new Promise((resolve) => {
      let ready = false;
      let invalid = false;
      let acked = true;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let beatTimer = null;
      let interval = 0;
      const ws = new WS(url);
      socket = ws;
      const send = (/** @type {object} */ m) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(m));
      };
      const beat = () => {
        beatTimer = null;
        if (!acked) {
          // No ACK since the last beat: a zombie connection. Resume.
          ws.close(RESUMABLE);
          return;
        }
        acked = false;
        send({ op: 1, d: session.seq });
        beatTimer = setTimeout(beat, interval);
      };
      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.s != null) session.seq = msg.s;
        if (msg.op === 10) {
          interval = Number(msg.d && msg.d.heartbeat_interval) || 41_250;
          beatTimer = setTimeout(beat, interval * Math.random());
          if (session.id) {
            send({ op: 6, d: { token: opts.token, session_id: session.id, seq: session.seq } });
          } else {
            send({
              op: 2,
              d: {
                token: opts.token,
                intents: INTENT_DIRECT_MESSAGES,
                properties: { os: process.platform, browser: "solenta", device: "solenta" },
              },
            });
          }
        } else if (msg.op === 11) {
          acked = true;
        } else if (msg.op === 1) {
          send({ op: 1, d: session.seq });
        } else if (msg.op === 7) {
          ws.close(RESUMABLE);
        } else if (msg.op === 9) {
          // d: true means the session can still be resumed.
          if (!msg.d) session.id = null;
          invalid = true;
          ws.close(RESUMABLE);
        } else if (msg.op === 0) {
          if (msg.t === "READY") {
            session.id = String(msg.d.session_id);
            session.resumeUrl = msg.d.resume_gateway_url ? String(msg.d.resume_gateway_url) : null;
          }
          if (msg.t === "READY" || msg.t === "RESUMED") {
            ready = true;
            onState({ state: "connected" });
            return;
          }
          handlers = handlers
            .then(() => (stopped ? undefined : dispatch(msg.t, msg.d || {})))
            .catch((err) => log(`discord: handler failed: ${err && err.message ? err.message : err}`));
        }
      });
      let ended = false;
      const end = (/** @type {number} */ code) => {
        if (ended) return;
        ended = true;
        if (beatTimer) clearTimeout(beatTimer);
        beatTimer = null;
        if (socket === ws) socket = null;
        if (endSocket === stopEnd) endSocket = null;
        resolve({ ready, code, invalid });
      };
      const stopEnd = () => end(1000);
      endSocket = stopEnd;
      ws.addEventListener("close", (ev) => end(ev.code));
      // An error is always followed by close.
      ws.addEventListener("error", () => {});
    });
  }

  async function loop() {
    let backoff = backoffStart;
    while (!stopped) {
      try {
        const url = session.id && session.resumeUrl ? `${session.resumeUrl.replace(/\/+$/, "")}${QUERY}` : opts.gatewayUrl || GATEWAY;
        const { ready, code, invalid } = await runSocket(url);
        if (stopped) break;
        if (FATAL_CLOSE.has(code)) {
          onState({ state: "error", error: `Discord closed the gateway (code ${code}). Check the bot token and intents.` });
          stopped = true;
          break;
        }
        if (FRESH_CLOSE.has(code)) session.id = null;
        // Discord asks for a short wait (1-5 s) before identifying again.
        if (invalid) await sleep(backoffStart + Math.random() * 4 * backoffStart);
        if (stopped) break;
        if (ready) {
          backoff = backoffStart;
          continue;
        }
        throw new Error(`Discord gateway closed before it was ready (code ${code})`);
      } catch (err) {
        if (stopped) break;
        onState({ state: "error", error: err && err.message ? err.message : String(err) });
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  /** @param {string} chatId @param {string} content @param {object} [extra] */
  const post = (chatId, content, extra) =>
    call("send", "POST", `/channels/${encodeURIComponent(chatId)}/messages`, {
      content,
      // Agent output never pings anyone.
      allowed_mentions: { parse: [] },
      ...extra,
    });

  return {
    /** Check the token; resolves to the bot user ({ username, ... }). */
    getMe: () => call("token check", "GET", "/users/@me"),
    /** Open the gateway. No-op when already running. */
    start() {
      if (!stopped) return;
      stopped = false;
      loopDone = loop();
    },
    /** Close the socket; resolves once the loop has exited. */
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (wake) wake();
      wake = null;
      if (socket) socket.close(1000);
      // close() during the handshake may never fire "close" (seen under load).
      if (endSocket) endSocket();
      if (loopDone) await loopDone;
      loopDone = null;
    },
    get running() {
      return !stopped;
    },
    /**
     * @param {string} chatId DM channel id
     * @param {string} text
     */
    async sendText(chatId, text) {
      for (const part of chunkText(text, MAX_TEXT)) await post(chatId, part);
    },
    /**
     * Last chunk carries the buttons: action rows of up to 5, at most 5 rows.
     * @param {string} chatId
     * @param {string} text
     * @param {Array<{ text: string, data: string }>} buttons
     */
    async sendButtons(chatId, text, buttons) {
      const parts = chunkText(text, MAX_TEXT);
      for (const part of parts.slice(0, -1)) await post(chatId, part);
      const rows = [];
      for (let i = 0; i < Math.min(buttons.length, 25); i += 5) {
        rows.push({
          type: 1,
          components: buttons.slice(i, i + 5).map((b) => ({
            type: 2,
            style: 2,
            label: b.text.slice(0, 80),
            custom_id: b.data,
          })),
        });
      }
      await post(chatId, parts[parts.length - 1] || "…", { components: rows });
    },
    /**
     * Respond to the interaction (within Discord's 3 s) with a message only
     * the presser sees.
     * @param {string} id "interactionId/token" from onButton
     * @param {string} [text]
     */
    async answerButton(id, text) {
      const [iid, token] = id.split("/");
      await call("button reply", "POST", `/interactions/${iid}/${token}/callback`, {
        type: 4,
        data: { content: text || "OK", flags: 64 },
      });
    },
  };
}

module.exports = { createDiscord, MAX_TEXT, INTENT_DIRECT_MESSAGES };
