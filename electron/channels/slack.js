"use strict";

/**
 * Slack transport for chat channels (#1718) over Socket Mode, so no public
 * URL: apps.connections.open (app-level xapp- token) hands out a wss URL,
 * Slack sends `hello`, then envelopes we ack by envelope_id, and a
 * `disconnect` (refresh_requested / warning / link_disabled) when it wants us
 * on a fresh URL. Web API calls (chat.postMessage, auth.test) use the bot
 * xoxb- token. Uses the platform WebSocket (Node 22 / Electron main), no
 * dependency. Knows nothing about threads: channels/index.js gets each DM
 * and button press through onMessage / onButton.
 *
 * Timers are ref'd and cleared on stop(), and stop() closes the socket and
 * aborts an in-flight connections.open, so nothing outlives a disconnect.
 */

const { chunkText } = require("./telegram.js");

const API = "https://slack.com/api";
// Slack truncates very long messages; 3,500 keeps well clear of its limits.
const MAX_TEXT = 3500;
// A section block's plain_text is capped at 3,000.
const MAX_BUTTON_TEXT = 2900;
const BACKOFF_MAX_MS = 60_000;
// Errors no retry fixes: stop instead of hammering Slack.
const FATAL = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired"]);

/** Slack treats & < > as markup in message text. @param {string} t */
const escape = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** @param {string} t */
const unescape = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * @param {object} opts
 * @param {string} opts.appToken xapp- token, opens the socket
 * @param {string} opts.botToken xoxb- token, Web API calls
 * @param {typeof fetch} [opts.fetch]
 * @param {typeof WebSocket} [opts.WebSocket]
 * @param {(msg: { chatId: string, chatType: string, senderId: string, text: string }) => Promise<void> | void} opts.onMessage
 * @param {(press: { id: string, chatId: string, chatType: string, senderId: string, data: string }) => Promise<void> | void} opts.onButton
 * @param {(state: { state: "connected" | "error", error?: string }) => void} [opts.onState]
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.backoffMs] first retry delay
 */
function createSlack(opts) {
  const doFetch = opts.fetch || globalThis.fetch;
  const WS = opts.WebSocket || globalThis.WebSocket;
  const log = opts.log || (() => {});
  const onState = opts.onState || (() => {});
  const backoffStart = opts.backoffMs ?? 1000;
  let stopped = true;
  /** @type {AbortController | null} */
  let abort = null;
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
  /** URL from getMe's connections.open, used by the first connect. */
  let firstUrl = /** @type {string | null} */ (null);
  let handlers = Promise.resolve();

  /**
   * @param {string} method
   * @param {string} token
   * @param {object} [body]
   * @param {AbortSignal} [signal]
   */
  async function call(method, token, body, signal) {
    const res = await doFetch(`${API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": body ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
      },
      body: body ? JSON.stringify(body) : "",
      signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // Fall through to the status error.
    }
    if (!json || json.ok !== true) {
      // Slack's error codes never carry the token; the headers stay put.
      const code = (json && json.error) || `HTTP ${res.status}`;
      const err = new Error(`Slack ${method} failed: ${code}`);
      /** @type {any} */ (err).fatal = FATAL.has(code);
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

  /** @param {any} env */
  async function handle(env) {
    const p = env.payload || {};
    if (env.type === "events_api") {
      const e = p.event || {};
      // Edits, joins and every bot post (our own replies included) carry a
      // subtype or bot_id: only plain human messages start work.
      if (e.type !== "message" || e.subtype || e.bot_id || !e.user || !e.channel) return;
      await opts.onMessage({
        chatId: String(e.channel),
        chatType: e.channel_type === "im" ? "private" : String(e.channel_type || ""),
        senderId: String(e.user),
        text: typeof e.text === "string" ? unescape(e.text) : "",
      });
    } else if (env.type === "interactive" && p.type === "block_actions") {
      const action = Array.isArray(p.actions) ? p.actions[0] : null;
      const chatId = String((p.channel && p.channel.id) || (p.container && p.container.channel_id) || "");
      if (!action || !p.user || !chatId) return;
      await opts.onButton({
        id: chatId,
        chatId,
        // block_actions has no channel_type; DM channel ids start with D.
        chatType: chatId.startsWith("D") ? "private" : "channel",
        senderId: String(p.user.id),
        data: String(action.value || ""),
      });
    }
  }

  /**
   * One socket's life. Resolves when it closes; true when Slack said hello,
   * so the caller reconnects at once instead of backing off.
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  function runSocket(url) {
    return new Promise((resolve) => {
      let hello = false;
      const ws = new WS(url);
      socket = ws;
      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.envelope_id) {
          // Ack first: Slack retries anything unacked after a few seconds.
          ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
          handlers = handlers
            .then(() => (stopped ? undefined : handle(msg)))
            .catch((err) => log(`slack: handler failed: ${err && err.message ? err.message : err}`));
        } else if (msg.type === "hello") {
          hello = true;
          onState({ state: "connected" });
        } else if (msg.type === "disconnect") {
          // Slack wants us on a fresh URL (refresh, warning, link disabled).
          ws.close(1000);
        }
      });
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        if (socket === ws) socket = null;
        if (endSocket === end) endSocket = null;
        resolve(hello);
      };
      endSocket = end;
      ws.addEventListener("close", end);
      // An error is always followed by close.
      ws.addEventListener("error", () => {});
    });
  }

  async function loop() {
    let backoff = backoffStart;
    while (!stopped) {
      try {
        let url = firstUrl;
        firstUrl = null;
        if (!url) {
          abort = new AbortController();
          url = (await call("apps.connections.open", opts.appToken, undefined, abort.signal)).url;
          abort = null;
        }
        if (stopped) break;
        if (await runSocket(String(url))) {
          backoff = backoffStart;
          continue;
        }
        if (stopped) break;
        throw new Error("Slack closed the connection before it was ready");
      } catch (err) {
        abort = null;
        if (stopped) break;
        onState({ state: "error", error: err && err.message ? err.message : String(err) });
        if (/** @type {any} */ (err).fatal) {
          stopped = true;
          break;
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  /** @param {string} channel @param {string} text */
  async function post(channel, text) {
    await call("chat.postMessage", opts.botToken, { channel, text: escape(text), mrkdwn: false });
  }

  return {
    /**
     * Check both tokens: auth.test for the bot, connections.open for the app
     * token (its URL is kept for the first connect). Resolves to { username }.
     */
    async getMe() {
      const me = await call("auth.test", opts.botToken);
      firstUrl = (await call("apps.connections.open", opts.appToken)).url;
      return { username: me.user ? String(me.user) : null };
    },
    /** Open the socket. No-op when already running. */
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
      if (abort) abort.abort();
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
     * Plain text: mrkdwn off and & < > escaped, so agent output is literal.
     * @param {string} chatId
     * @param {string} text
     */
    async sendText(chatId, text) {
      for (const part of chunkText(text, MAX_TEXT)) await post(chatId, part);
    },
    /**
     * Last chunk as a section plus one actions block (Block Kit buttons).
     * @param {string} chatId
     * @param {string} text
     * @param {Array<{ text: string, data: string }>} buttons
     */
    async sendButtons(chatId, text, buttons) {
      const parts = chunkText(text, MAX_BUTTON_TEXT);
      for (const part of parts.slice(0, -1)) await post(chatId, part);
      const last = parts[parts.length - 1] || "…";
      await call("chat.postMessage", opts.botToken, {
        channel: chatId,
        text: escape(last),
        blocks: [
          { type: "section", text: { type: "plain_text", text: last, emoji: false } },
          {
            type: "actions",
            elements: buttons.slice(0, 25).map((b, i) => ({
              type: "button",
              action_id: `b${i}`,
              text: { type: "plain_text", text: b.text.slice(0, 75), emoji: false },
              value: b.data,
            })),
          },
        ],
      });
    },
    /**
     * Slack has no toast for a press; say it in the DM instead.
     * @param {string} id the press's channel id
     * @param {string} [text]
     */
    async answerButton(id, text) {
      if (text) await post(id, text);
    },
  };
}

module.exports = { createSlack, MAX_TEXT };
