"use strict";

/**
 * Two-way chat channels (#1718): a chat message starts or continues a
 * thread, and the thread's result, approval prompts and questions go back
 * to the chat. One transport per kind (TRANSPORTS below), each with its own
 * settings key, channel state and status. A transport needs: sendText,
 * sendButtons, answerButton, getMe, start/stop, and to hand
 * onMessage({ chatId, chatType, senderId, text }) / onButton({ id, chatId,
 * chatType, senderId, data }) normalized events in here. Direct messages
 * report chatType "private"; anything else is ignored.
 *
 * Chat text is untrusted: it only ever becomes a prompt (never a shell
 * argument), senders off the allowlist and group chats get no reply at all, and threads run
 * with the project's / profile's normal permission mode.
 *
 * State: store.getChannelState(kind) holds the transport's cursor (Telegram's
 * poll offset) and the chat -> thread map; the thread carries
 * `channel: { kind, chatId }` so a finished turn finds its chat.
 */

const services = require("../services.js");
const { createTelegram } = require("./telegram.js");
const { createSlack } = require("./slack.js");
const { createDiscord } = require("./discord.js");

/**
 * @typedef {{ sendText(chatId: string, text: string): Promise<void>, sendButtons(chatId: string, text: string, buttons: Array<{ text: string, data: string }>): Promise<void>, answerButton(id: string, text?: string): Promise<unknown>, getMe(): Promise<any>, start(): void, stop(): Promise<void> }} Transport
 * @typedef {{ fetch?: typeof fetch, state: { offset: number }, save: () => void, onMessage: (m: any) => Promise<void>, onButton: (p: any) => Promise<void>, onState: (s: { state: string, error?: string }) => void, log: (msg: string) => void }} TransportHooks
 */

/**
 * Per kind: settings fields holding tokens (all required to connect), and
 * how to build the transport from saved settings.
 * @type {Record<string, { label: string, tokens: string[], create: (c: any, h: TransportHooks, deps: any) => Transport }>}
 */
const TRANSPORTS = {
  telegram: {
    label: "Telegram",
    tokens: ["botToken"],
    create: (c, h, deps) =>
      createTelegram({
        token: c.botToken,
        fetch: h.fetch,
        offset: h.state.offset,
        onOffset: (offset) => {
          h.state.offset = offset;
          h.save();
        },
        onMessage: h.onMessage,
        onButton: h.onButton,
        onState: /** @type {any} */ (h.onState),
        log: h.log,
        pollTimeoutSec: deps.pollTimeoutSec,
        backoffMs: deps.backoffMs,
      }),
  },
  slack: {
    label: "Slack",
    tokens: ["appToken", "botToken"],
    create: (c, h, deps) =>
      createSlack({
        appToken: c.appToken,
        botToken: c.botToken,
        fetch: h.fetch,
        WebSocket: deps.WebSocket,
        onMessage: h.onMessage,
        onButton: h.onButton,
        onState: /** @type {any} */ (h.onState),
        log: h.log,
        backoffMs: deps.backoffMs,
      }),
  },
  discord: {
    label: "Discord",
    tokens: ["botToken"],
    create: (c, h, deps) =>
      createDiscord({
        token: c.botToken,
        fetch: h.fetch,
        WebSocket: deps.WebSocket,
        gatewayUrl: deps.discordGatewayUrl,
        onMessage: h.onMessage,
        onButton: h.onButton,
        onState: /** @type {any} */ (h.onState),
        log: h.log,
        backoffMs: deps.backoffMs,
      }),
  },
};
const KINDS = Object.keys(TRANSPORTS);

const HELP =
  "Send a message to start a thread. Later messages continue it.\n" +
  "/new starts a fresh thread, /status shows the current one.";
const QUESTION_PREFIX = "Answering your question:\n\n";

/** @param {unknown} err */
function errText(err) {
  return String((err && /** @type {any} */ (err).message) || err).slice(0, 500);
}

/**
 * @param {object} deps
 * @param {import("../store").Store} deps.store
 * @param {any} deps.runner
 * @param {(channel: string, payload: unknown) => void} [deps.broadcast]
 * @param {typeof fetch} [deps.fetch]
 * @param {(msg: string) => void} [deps.log]
 * @param {number} [deps.pollTimeoutSec]
 * @param {number} [deps.backoffMs]
 * @param {typeof WebSocket} [deps.WebSocket]
 * @param {string} [deps.discordGatewayUrl] test seam
 */
function createChannels(deps) {
  const { store, runner } = deps;
  const broadcast = deps.broadcast || (() => {});
  const log = deps.log || ((msg) => console.warn(msg));
  /** @type {Record<string, { client: Transport | null, state: string, botUsername: string | null, error: string | null }>} */
  const live = Object.fromEntries(
    KINDS.map((k) => [k, { client: null, state: "off", botUsername: null, error: null }]),
  );
  const warnedSenders = new Set();
  // Button key -> what it answers. Lost on restart: a stale press says so.
  // ponytail: grows by one per unanswered prompt; prune if that ever matters.
  /** @type {Map<string, { kind: string, chatId: string, threadId: string, requestId?: string, questionId?: string }>} */
  const buttons = new Map();
  let nextKey = 1;
  const sentPrompts = new Set();
  /** @type {Map<string, unknown>} threadId -> last assistant message posted */
  const posted = new Map();

  const cfg = (/** @type {string} */ kind) => /** @type {any} */ (store.getSettings())[kind];
  const allowed = (/** @type {string} */ kind, /** @type {string} */ senderId) =>
    cfg(kind).allowedSenderIds.includes(String(senderId));
  const chats = (/** @type {string} */ kind) => store.getChannelState(kind).chats;
  const changed = () => broadcast("threads:changed", services.listThreads(store));

  /** @param {string} kind @param {string} chatId @param {string} text */
  async function send(kind, chatId, text) {
    const client = live[kind] && live[kind].client;
    if (!client) return;
    try {
      await client.sendText(chatId, text);
    } catch (err) {
      log(`${kind}: send failed: ${errText(err)}`);
    }
  }

  /** @param {string} kind @param {string} chatId @param {string} text @param {Array<{ text: string, data: string }>} list */
  async function sendButtons(kind, chatId, text, list) {
    const client = live[kind] && live[kind].client;
    if (!client) return;
    try {
      await client.sendButtons(chatId, text, list);
    } catch (err) {
      log(`${kind}: send failed: ${errText(err)}`);
    }
  }

  /** @param {string} kind @param {string} chatId @param {string} text */
  async function startThread(kind, chatId, text) {
    const c = cfg(kind);
    const project = c.projectId ? store.getProject(c.projectId) : null;
    if (!project) {
      await send(
        kind,
        chatId,
        `No default project is set. Pick one in Solenta: Settings → Integrations → ${TRANSPORTS[kind].label}.`,
      );
      return;
    }
    const thread = services.createThread(store, {
      projectId: project.id,
      title: text.split("\n")[0],
      channel: { kind, chatId },
    });
    if (c.agentProfileId) {
      try {
        services.applyAgentProfile(store, { threadId: thread.id, profileId: c.agentProfileId });
      } catch (err) {
        log(`${kind}: agent profile not applied: ${errText(err)}`);
      }
    }
    // Same lazy worktree intent as a New Thread with the default on; the
    // project's own defaultWorktree override (#1775) wins over the global.
    if (
      !project.scratch &&
      !project.remoteHost &&
      services.resolveDefaultWorktree(project, store.getSettings())
    ) {
      store.updateThread(thread.id, { pendingWorktree: true });
    }
    chats(kind)[chatId] = thread.id;
    store.save();
    changed();
    try {
      await runner.startRun({ threadId: thread.id, prompt: text });
      await send(kind, chatId, `Started "${thread.title}". I'll reply here when it's done.`);
    } catch (err) {
      await send(kind, chatId, `Could not start the thread: ${errText(err)}`);
    }
  }

  /** @param {string} kind @param {any} thread @param {string} chatId @param {string} text */
  async function continueThread(kind, thread, chatId, text) {
    const queue = async () => {
      services.setQueued(store, { threadId: thread.id, prompt: text });
      changed();
      await send(kind, chatId, "Queued. It runs when the current turn finishes.");
    };
    if (runner.isRunning(thread.id) || thread.status === "working") return queue();
    try {
      await runner.startRun({ threadId: thread.id, prompt: text });
    } catch (err) {
      if (/already active/i.test(errText(err))) return queue();
      await send(kind, chatId, `Could not send: ${errText(err)}`);
    }
  }

  /** @param {string} kind @param {{ chatId: string, chatType: string, senderId: string, text: string }} msg */
  async function onMessage(kind, { chatId, chatType, senderId, text }) {
    // Private chats only: in a group, every member would read the agent's
    // output (code, diffs, maybe secrets) even if only the sender is allowed.
    if (chatType !== "private") {
      if (!warnedSenders.has(`${kind}:chat:${chatId}`)) {
        warnedSenders.add(`${kind}:chat:${chatId}`);
        log(`${kind}: ignored a message in ${chatType || "a non-private"} chat ${chatId}. Message the bot directly.`);
      }
      return;
    }
    if (!allowed(kind, senderId)) {
      if (!warnedSenders.has(`${kind}:${senderId}`)) {
        warnedSenders.add(`${kind}:${senderId}`);
        log(
          `${kind}: ignored a message from sender id ${senderId}. ` +
            "Add it to Allowed sender IDs in Settings to let it start threads.",
        );
      }
      return;
    }
    const body = text.trim();
    if (!body) {
      await send(kind, chatId, "Only text messages are supported.");
      return;
    }
    const cmd = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(body);
    const name = cmd ? cmd[1].toLowerCase() : null;
    if (name === "start" || name === "help") {
      await send(kind, chatId, HELP);
      return;
    }
    if (name === "new") {
      delete chats(kind)[chatId];
      store.save();
      const rest = (cmd && cmd[2] ? cmd[2] : "").trim();
      if (rest) await startThread(kind, chatId, rest);
      else await send(kind, chatId, "OK. Your next message starts a new thread.");
      return;
    }
    const threadId = chats(kind)[chatId];
    const thread = threadId ? store.getThread(threadId) : null;
    const current = thread && !services.isTrashed(thread) ? thread : null;
    if (name === "status") {
      if (!current) await send(kind, chatId, "No thread yet. Send a message to start one.");
      else {
        const s = current.status === "working" && current.awaitingInput ? "waiting for you" : current.status;
        await send(kind, chatId, `${current.title}: ${s}`);
      }
      return;
    }
    if (current) await continueThread(kind, current, chatId, body);
    else await startThread(kind, chatId, body);
  }

  /** @param {string} kind @param {{ id: string, chatId: string, chatType: string, senderId: string, data: string }} press */
  async function onButton(kind, { id, chatId, chatType, senderId, data }) {
    if (chatType !== "private" || !allowed(kind, senderId)) return;
    const answer = async (/** @type {string} */ text) => {
      try {
        const client = live[kind].client;
        if (client) await client.answerButton(id, text);
      } catch {
        // The spinner times out on its own.
      }
    };
    const [verb, key, idx] = data.split(":");
    const b = buttons.get(key);
    if (!b || b.kind !== kind || b.chatId !== chatId) {
      await answer("This button has expired. Answer in Solenta.");
      return;
    }
    if ((verb === "ok" || verb === "no") && b.requestId) {
      buttons.delete(key);
      try {
        // Same call the approvals inbox and the thread's permission card make.
        await runner.respondPermission({
          threadId: b.threadId,
          requestId: b.requestId,
          decision: verb === "ok" ? "allow" : "deny",
        });
        await answer(verb === "ok" ? "Allowed" : "Denied");
      } catch (err) {
        await answer(errText(err).slice(0, 180));
      }
      return;
    }
    if (verb === "q" && b.questionId) {
      const thread = store.getThread(b.threadId);
      const card = thread && thread.pendingQuestion;
      const q = card && card.id === b.questionId ? card.questions[0] : null;
      const opt = q ? q.options[Number(idx)] : null;
      if (!thread || !q || !opt) {
        buttons.delete(key);
        await answer("This question was already answered.");
        return;
      }
      buttons.delete(key);
      await answer(opt.label);
      // The desktop question card answers through the normal send path too.
      await continueThread(kind, thread, chatId, `${QUESTION_PREFIX}${q.question}\n→ ${opt.label}`);
      return;
    }
    await answer("Unknown button.");
  }

  /** @param {any} thread */
  async function sendApprovals(thread) {
    const { kind, chatId } = thread.channel;
    const list = typeof runner.listPendingApprovals === "function" ? runner.listPendingApprovals() : [];
    for (const a of list) {
      if (a.threadId !== thread.id) continue;
      const seen = `${thread.id}:${a.requestId}`;
      if (sentPrompts.has(seen)) continue;
      sentPrompts.add(seen);
      if ((a.questions && a.questions.length) || a.inputRequest) {
        await send(kind, chatId, `${thread.title} is asking: ${a.summary}\nAnswer this in Solenta.`);
        continue;
      }
      const key = String(nextKey++);
      buttons.set(key, { kind, chatId, threadId: thread.id, requestId: a.requestId });
      const detail = a.plan ? `Plan:\n${a.plan}` : a.command || a.summary;
      await sendButtons(kind, chatId, `${thread.title} needs approval:\n${detail}`, [
        { text: "Allow", data: `ok:${key}` },
        { text: "Deny", data: `no:${key}` },
      ]);
    }
  }

  /** @param {any} thread */
  async function sendQuestion(thread) {
    const card = thread.pendingQuestion;
    if (!card || sentPrompts.has(card.id)) return;
    sentPrompts.add(card.id);
    const { kind, chatId } = thread.channel;
    const qs = Array.isArray(card.questions) ? card.questions : [];
    const one = qs.length === 1 && !qs[0].multiSelect && qs[0].options.length > 0 ? qs[0] : null;
    if (one) {
      const key = String(nextKey++);
      buttons.set(key, { kind, chatId, threadId: thread.id, questionId: card.id });
      const tail = one.customAnswer === false ? "" : "\n\nOr reply with your own answer.";
      await sendButtons(
        kind,
        chatId,
        `${one.question}${tail}`,
        one.options.map((/** @type {any} */ o, /** @type {number} */ i) => ({
          text: String(o.label).slice(0, 60),
          data: `q:${key}:${i}`,
        })),
      );
      return;
    }
    const lines = qs.map(
      (/** @type {any} */ q) =>
        `${q.question}\n${q.options.map((/** @type {any} */ o) => `• ${o.label}`).join("\n")}`,
    );
    await send(kind, chatId, `${lines.join("\n\n")}\n\nReply with your answers here, or answer in Solenta.`);
  }

  /** @param {any} thread @param {string} next */
  async function deliver(thread, next) {
    const { kind, chatId } = thread.channel;
    if (next === "done") {
      const msg = store.getLastAssistantMessage(thread.id);
      const mark = msg && (msg.id ?? msg.text);
      if (msg && posted.get(thread.id) !== mark) {
        posted.set(thread.id, mark);
        await send(kind, chatId, msg.text);
      }
    } else if (next === "failed") {
      await send(kind, chatId, `${thread.title} failed: ${thread.lastError || "unknown error"}`);
    } else if (next === "waiting") {
      await sendApprovals(thread);
    }
    await sendQuestion(store.getThread(thread.id) || thread);
  }

  /**
   * Thread state transition hook (main.js pushFn, same gate as the webhook):
   * next is "done" | "failed" | "waiting". Routed by thread.channel.kind.
   * @param {any} thread
   * @param {string} next
   */
  function onThreadUpdate(thread, next) {
    const kind = thread && thread.channel && thread.channel.kind;
    if (!kind || !live[kind] || !live[kind].client) return;
    void deliver(thread, next).catch((err) => log(`${kind}: deliver failed: ${errText(err)}`));
  }

  /** @param {string} kind */
  async function stopClient(kind) {
    const client = live[kind].client;
    live[kind].client = null;
    if (client) await client.stop();
  }

  function status() {
    return Object.fromEntries(
      KINDS.map((k) => [k, { state: live[k].state, botUsername: live[k].botUsername, error: live[k].error }]),
    );
  }

  /** @param {string} kind */
  function known(kind) {
    if (!Object.prototype.hasOwnProperty.call(TRANSPORTS, kind)) {
      throw new Error(`Unknown channel: ${kind}`);
    }
    return TRANSPORTS[kind];
  }

  /**
   * Validate the token(s) with getMe, then listen. Persists enabled so a
   * relaunch reconnects.
   * @param {string} [kind]
   */
  async function connect(kind = "telegram") {
    const t = known(kind);
    const c = cfg(kind);
    if (t.tokens.some((f) => !c[f])) {
      throw new Error(t.tokens.length > 1 ? "Add both tokens first" : "Add a bot token first");
    }
    if (c.allowedSenderIds.length === 0) {
      throw new Error("Add at least one allowed sender ID first");
    }
    await stopClient(kind);
    const st = live[kind];
    /** @type {Transport} */
    const client = t.create(
      c,
      {
        fetch: deps.fetch,
        state: store.getChannelState(kind),
        save: () => store.save(),
        onMessage: (m) => onMessage(kind, m),
        onButton: (p) => onButton(kind, p),
        onState: (s) => {
          if (st.client !== client) return;
          st.state = s.state;
          st.error = s.error || null;
        },
        log,
      },
      deps,
    );
    st.state = "connecting";
    st.error = null;
    try {
      const { recordSecretUse } = require("../secrets.js");
      for (const f of t.tokens) recordSecretUse({ purpose: kind, key: `${kind}.${f}` });
      const me = await client.getMe();
      st.botUsername = me && me.username ? String(me.username) : null;
    } catch (err) {
      st.state = "error";
      st.error = errText(err);
      throw err;
    }
    st.client = client;
    st.state = "connected";
    client.start();
    if (!c.enabled) {
      store.setSettings({ [kind]: { enabled: true } });
      store.save();
    }
    return status();
  }

  /** @param {string} [kind] */
  async function disconnect(kind = "telegram") {
    known(kind);
    await stopClient(kind);
    live[kind].state = "off";
    live[kind].error = null;
    if (cfg(kind).enabled) {
      store.setSettings({ [kind]: { enabled: false } });
      store.save();
    }
    return status();
  }

  return {
    /** App start: reconnect every channel the user left connected. */
    start() {
      for (const kind of KINDS) {
        const c = cfg(kind);
        if (!c || !c.enabled || TRANSPORTS[kind].tokens.some((f) => !c[f]) || c.allowedSenderIds.length === 0) continue;
        connect(kind).catch((err) => log(`${kind}: connect failed: ${errText(err)}`));
      }
    },
    /** App quit: stop every transport, keep the enabled flags. */
    async stopAll() {
      await Promise.all(KINDS.map(stopClient));
    },
    connect,
    disconnect,
    status,
    onThreadUpdate,
  };
}

module.exports = { createChannels, KINDS };
