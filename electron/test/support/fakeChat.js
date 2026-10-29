/**
 * Fake chat platforms for the channel tests (#1718): Telegram's Bot API
 * (injected fetch), Slack Socket Mode and Discord Gateway (a loopback
 * WebSocket server plus injected fetch). Nothing here touches the network.
 */
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");

/** In-memory Bot API: getUpdates long-polls until an update is pushed or aborted. */
function fakeTelegram() {
  const sent = [];
  const answered = [];
  let queue = [];
  let nextId = 1;
  let wake = null;
  let polls = 0;
  let aborts = 0;
  let failPolls = false;
  async function fetch(url, init) {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body || "{}");
    const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
    if (method === "getMe") return ok({ id: 1, username: "test_bot" });
    if (method === "sendMessage") {
      sent.push(body);
      return ok({ message_id: sent.length });
    }
    if (method === "answerCallbackQuery") {
      answered.push(body);
      return ok(true);
    }
    if (method === "getUpdates") {
      polls++;
      if (failPolls) return { status: 502, json: async () => ({ ok: false, description: "Bad Gateway", error_code: 502 }) };
      queue = queue.filter((u) => u.update_id >= (body.offset || 0));
      if (queue.length === 0) {
        await new Promise((resolve, reject) => {
          wake = resolve;
          init.signal.addEventListener("abort", () => {
            aborts++;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }
      const out = queue;
      queue = [];
      return ok(out);
    }
    throw new Error(`unexpected ${method}`);
  }
  const push = (u) => {
    queue.push({ update_id: nextId++, ...u });
    if (wake) wake();
    wake = null;
  };
  return {
    fetch,
    sent,
    answered,
    get polls() {
      return polls;
    },
    get aborts() {
      return aborts;
    },
    failPolls(on) {
      failPolls = on;
    },
    message(from, text, chat = from, type = "private") {
      push({ message: { chat: { id: Number(chat), type }, from: { id: Number(from) }, text } });
    },
    press(from, data, chat = from, type = "private") {
      push({
        callback_query: { id: `cb${nextId}`, from: { id: Number(from) }, data, message: { chat: { id: Number(chat), type } } },
      });
    },
  };
}

function fakeRunner() {
  const starts = [];
  const responses = [];
  const running = new Set();
  return {
    starts,
    responses,
    running,
    approvals: [],
    async startRun(input) {
      starts.push(input);
    },
    isRunning: (id) => running.has(id),
    async respondPermission(input) {
      responses.push(input);
    },
    listPendingApprovals() {
      return this.approvals;
    },
  };
}

async function waitFor(cond, what = "condition") {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Loopback WebSocket server; `sock` is the newest client connection. */
async function socketServer(onConnection) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const srv = {
    wss,
    port: wss.address().port,
    sock: null,
    connections: 0,
    closes: 0,
    /** @type {any[]} every JSON frame clients sent */
    received: [],
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(r));
    },
  };
  /** @type {string[]} request path of every connection */
  srv.paths = [];
  wss.on("connection", (ws, req) => {
    srv.connections++;
    srv.paths.push(req.url);
    srv.sock = ws;
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      srv.received.push(m);
      onConnection.message?.(ws, m);
    });
    ws.on("close", () => {
      srv.closes++;
      if (srv.sock === ws) srv.sock = null;
    });
    onConnection.open(ws, req);
  });
  return srv;
}

/**
 * Slack: Web API through fetch (Bearer tokens checked), Socket Mode on a
 * loopback server that says hello and records every envelope ack.
 */
async function fakeSlack({ appToken, botToken }) {
  const srv = await socketServer({ open: (ws) => ws.send(JSON.stringify({ type: "hello", num_connections: 1 })) });
  const sent = [];
  let opens = 0;
  let nextEnv = 1;
  async function fetch(url, init) {
    const method = String(url).split("/api/").pop();
    const auth = init.headers.authorization;
    const body = init.body ? JSON.parse(init.body) : {};
    const ok = (extra) => ({ status: 200, json: async () => ({ ok: true, ...extra }) });
    const bad = (error) => ({ status: 200, json: async () => ({ ok: false, error }) });
    if (method === "apps.connections.open") {
      if (auth !== `Bearer ${appToken}`) return bad("invalid_auth");
      opens++;
      return ok({ url: `ws://127.0.0.1:${srv.port}/link/?ticket=${opens}` });
    }
    if (auth !== `Bearer ${botToken}`) return bad("invalid_auth");
    if (method === "auth.test") return ok({ user: "solenta_bot", user_id: "UBOT", bot_id: "B1" });
    if (method === "chat.postMessage") {
      sent.push(body);
      return ok({ ts: String(sent.length) });
    }
    throw new Error(`unexpected ${method}`);
  }
  const envelope = (type, payload) => {
    const id = `env${nextEnv++}`;
    srv.sock.send(JSON.stringify({ envelope_id: id, type, payload, accepts_response_payload: false }));
    return id;
  };
  return {
    srv,
    fetch,
    sent,
    get opens() {
      return opens;
    },
    get acks() {
      return srv.received.map((m) => m.envelope_id);
    },
    message(user, text, channel = `D${user}`, channelType = "im", extra = {}) {
      return envelope("events_api", {
        type: "event_callback",
        event: { type: "message", channel, channel_type: channelType, user, text, ts: "1.0", ...extra },
      });
    },
    press(user, value, channel = `D${user}`) {
      return envelope("interactive", {
        type: "block_actions",
        user: { id: user },
        channel: { id: channel },
        container: { type: "message", channel_id: channel },
        actions: [{ action_id: "b0", value }],
      });
    },
    disconnect(reason = "refresh_requested") {
      srv.sock.send(JSON.stringify({ type: "disconnect", reason }));
    },
    drop() {
      srv.sock.terminate();
    },
    close: () => srv.close(),
  };
}

/**
 * Discord: REST through fetch (Bot token checked; interaction callbacks need
 * none), Gateway on a loopback server: HELLO, READY / RESUMED, heartbeat ACKs.
 */
async function fakeDiscord({ token, heartbeatMs = 45_000 }) {
  let seq = 0;
  /** @type {any[]} identify (op 2) and resume (op 6) payloads, in order */
  const logins = [];
  const srv = await socketServer({
    open: (ws) => ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: heartbeatMs } })),
    message(ws, m) {
      if (m.op === 2) {
        logins.push(m);
        ws.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: ++seq,
            d: { session_id: `sess${logins.length}`, resume_gateway_url: `ws://127.0.0.1:${srv.port}/resume`, user: { username: "solenta_bot" } },
          }),
        );
      } else if (m.op === 6) {
        logins.push(m);
        ws.send(JSON.stringify({ op: 0, t: "RESUMED", s: ++seq, d: {} }));
      } else if (m.op === 1) {
        ws.send(JSON.stringify({ op: 11 }));
      }
    },
  });
  const sent = [];
  const answered = [];
  let nextId = 1;
  async function fetch(url, init) {
    const p = String(url).replace("https://discord.com/api/v10", "");
    const res = (status, body) => ({ status, ok: status < 300, json: async () => body });
    const cb = /^\/interactions\/(\w+)\/([\w.-]+)\/callback$/.exec(p);
    if (cb) {
      answered.push({ id: cb[1], token: cb[2], ...JSON.parse(init.body) });
      return res(204, null);
    }
    if (init.headers.authorization !== `Bot ${token}`) return res(401, { message: "401: Unauthorized", code: 0 });
    if (p === "/users/@me") return res(200, { id: "1", username: "solenta_bot", bot: true });
    const msg = /^\/channels\/(\d+)\/messages$/.exec(p);
    if (msg && init.method === "POST") {
      sent.push({ channel: msg[1], ...JSON.parse(init.body) });
      return res(200, { id: String(sent.length) });
    }
    throw new Error(`unexpected ${init.method} ${p}`);
  }
  const dispatch = (t, d) => srv.sock.send(JSON.stringify({ op: 0, t, s: ++seq, d }));
  return {
    srv,
    fetch,
    sent,
    answered,
    logins,
    gatewayUrl: `ws://127.0.0.1:${srv.port}/gateway?v=10&encoding=json`,
    get seq() {
      return seq;
    },
    message(user, content, channel = `9${user}`, extra = {}) {
      dispatch("MESSAGE_CREATE", { id: String(nextId++), channel_id: channel, author: { id: user }, content, ...extra });
    },
    press(user, customId, channel = `9${user}`, guildId) {
      const id = String(1000 + nextId++);
      dispatch("INTERACTION_CREATE", {
        id,
        token: `itok-${id}`,
        type: 3,
        channel_id: channel,
        data: { custom_id: customId, component_type: 2 },
        ...(guildId ? { guild_id: guildId, member: { user: { id: user } } } : { user: { id: user } }),
      });
      return id;
    },
    send(m) {
      srv.sock.send(JSON.stringify(m));
    },
    drop() {
      srv.sock.terminate();
    },
    closeWith(code) {
      srv.sock.close(code);
    },
    close: () => srv.close(),
  };
}

module.exports = { fakeTelegram, fakeRunner, waitFor, socketServer, fakeSlack, fakeDiscord };
