"use strict";

/**
 * OpenCode `serve` adapter for interactive turns (#451 item 3). Per-turn
 * private server in the thread's worktree, like Codex app-server (#1170):
 * spawn → GET /event (SSE) → POST /session → POST prompt_async → wait for
 * session.idle → kill. Workflow / ask / commitmsg and ssh/WSL projects stay
 * on `opencode run --format json` (electron/opencode.js).
 *
 * Verified live on opencode 1.17.12 and 1.19.3 (2026-10-18):
 * - `serve --port 0` prints "opencode server listening on http://…" on stdout
 *   (4096 first, random when taken).
 * - OPENCODE_SERVER_PASSWORD gates every route with Basic auth, user "opencode".
 * - SSE frames are `data: {id, type, properties}`. Content arrives as
 *   message.part.updated (full part) + message.part.delta (field "text").
 *   The user's own prompt also echoes as a text part, so parts are kept
 *   only for assistant messages. step-finish parts carry tokens + cost.
 * - Permissions: permission.asked {id, permission, patterns, metadata,
 *   always, tool}; answer with POST /permission/:id/reply {reply}. The
 *   POST /session/:id/permissions/:permissionID route is deprecated.
 * - Two servers booting at the same instant can die with "database is
 *   locked" (shared SQLite), so our starts are serialized and retried.
 *
 * Events reach onEvent in the `run --format json` shapes electron/opencode.js
 * already parses, so the runner keeps one set of extractors.
 */

const spawn = require("cross-spawn");
const { randomBytes } = require("node:crypto");
const { agentSpawnOptions, killTree, isShuttingDown } = require("./proc.js");
const { SIGKILL_AFTER_MS } = require("./agent.js");
const { extractTerminalError } = require("./opencode.js");

const DEFAULT_ARGS = ["serve", "--port", "0", "--hostname", "127.0.0.1"];
const LISTEN_RE = /listening on (https?:\/\/\S+)/;
const LISTEN_TIMEOUT_MS = 30_000;
const ABORT_TIMEOUT_MS = 1_000;
const DB_LOCK_RETRIES = 2;
const STDERR_TAIL_CHARS = 4000;

/** @type {Promise<unknown>} */
let startGate = Promise.resolve();

/**
 * Spawn one `opencode serve` and resolve its base URL once it listens.
 * @param {{ binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, holder: { child: any, stderr: string, onClose: ((code: number | null) => void) | null } }} o
 * @returns {Promise<string>}
 */
function spawnServer(o) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        o.binary,
        o.args,
        agentSpawnOptions({ cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] }),
      );
    } catch (err) {
      reject(err);
      return;
    }
    o.holder.child = child;
    o.holder.stderr = "";
    let out = "";
    let listening = false;
    const timer = setTimeout(() => {
      if (listening) return;
      killTree(child, SIGKILL_AFTER_MS);
      reject(new Error("opencode serve did not start listening"));
    }, LISTEN_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (listening) return;
      out = (out + chunk).slice(-STDERR_TAIL_CHARS);
      const m = LISTEN_RE.exec(out);
      if (m) {
        listening = true;
        clearTimeout(timer);
        resolve(m[1].replace(/\/+$/, ""));
      }
    });
    child.stderr.on("data", (chunk) => {
      o.holder.stderr = (o.holder.stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!listening) reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!listening) {
        // Boot errors print to stdout ("Error: Unexpected error … database is locked").
        const err = new Error((o.holder.stderr || out).trim() || `opencode serve exited ${code}`);
        reject(err);
        return;
      }
      if (o.holder.onClose) o.holder.onClose(code);
    });
  });
}

/**
 * Serialized start with retry on the shared-db boot race.
 * @param {Parameters<typeof spawnServer>[0] & { isStopped: () => boolean }} o
 * @returns {Promise<string>}
 */
function startServer(o) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await spawnServer(o);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (o.isStopped() || attempt >= DB_LOCK_RETRIES || !/database is locked/i.test(msg)) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  };
  const p = startGate.then(run, run);
  startGate = p.catch(() => {});
  return p;
}

/**
 * Split an SSE byte stream into parsed JSON `data:` payloads.
 * @param {AsyncIterable<Uint8Array>} body
 * @param {(ev: any) => void} onEvent
 */
async function readSse(body, onEvent) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev && typeof ev === "object") onEvent(ev);
    }
  }
}

/**
 * Translate one serve SSE event for `sessionId` into zero or more
 * `run --format json` shaped events. Stateful: tracks message roles,
 * part text (deltas), and which tool parts already announced a start.
 * @param {string} sessionId
 */
function createEventTranslator(sessionId) {
  /** @type {Map<string, string>} messageID -> role */
  const roles = new Map();
  /** @type {Map<string, { type: string, text: string }>} partID -> part */
  const parts = new Map();
  /** @type {Set<string>} */
  const startedTools = new Set();

  /** @param {any} ev @returns {object[]} */
  return function translate(ev) {
    const p = ev && ev.properties && typeof ev.properties === "object" ? ev.properties : {};
    if (p.sessionID !== sessionId) return [];
    const base = { sessionID: sessionId };
    switch (ev.type) {
      case "message.updated": {
        const info = p.info || {};
        if (info.id && info.role) roles.set(info.id, info.role);
        return [];
      }
      case "message.part.delta": {
        if (roles.get(p.messageID) === "user" || p.field !== "text") return [];
        const part = parts.get(p.partID);
        if (!part) return [];
        part.text += String(p.delta ?? "");
        return [{ ...base, type: part.type, part: { id: p.partID, text: part.text } }];
      }
      case "message.part.updated": {
        const part = p.part || {};
        if (roles.get(part.messageID) === "user") return [];
        if (part.type === "text" || part.type === "reasoning") {
          const text = String(part.text ?? "");
          parts.set(part.id, { type: part.type, text });
          // Empty opening part: wait for deltas.
          return text ? [{ ...base, type: part.type, part: { id: part.id, text } }] : [];
        }
        if (part.type === "tool") {
          const status = part.state && part.state.status;
          if (status === "completed" || status === "error") {
            return [{ ...base, type: "tool_use", part }];
          }
          // pending has no input yet; announce once, at running.
          if (status === "running" && !startedTools.has(part.id)) {
            startedTools.add(part.id);
            return [{ ...base, type: "tool_use", part: { ...part, state: { ...part.state, output: undefined } } }];
          }
          return [];
        }
        if (part.type === "step-finish") {
          return [{ ...base, type: "step_finish", part }];
        }
        return [];
      }
      case "session.error":
        return [{ ...base, type: "error", error: p.error || {} }];
      default:
        return [];
    }
  };
}

/**
 * @param {string} model - "provider/model"
 * @returns {{ providerID: string, modelID: string } | null}
 */
function modelRef(model) {
  const s = String(model || "");
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) };
}

const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

/**
 * Prompt parts: the text, then attachments as file:// parts (what `run -f` sends).
 * @param {string} prompt
 * @param {string[]} [files]
 */
function promptParts(prompt, files) {
  const { pathToFileURL } = require("node:url");
  const path = require("node:path");
  /** @type {object[]} */
  const out = [{ type: "text", text: String(prompt ?? "") }];
  for (const f of Array.isArray(files) ? files : []) {
    if (typeof f !== "string" || !f) continue;
    const ext = path.extname(f).slice(1).toLowerCase();
    // ponytail: non-image/pdf attachments go as text/plain, like run -f does for source files.
    out.push({
      type: "file",
      mime: MIME_BY_EXT[ext] || "text/plain",
      url: pathToFileURL(f).href,
      filename: path.basename(f),
    });
  }
  return out;
}

/**
 * One interactive turn on a private `opencode serve`.
 *
 * @param {object} opts
 * @param {string} [opts.binary]
 * @param {string[]} [opts.args]
 * @param {string} opts.cwd
 * @param {NodeJS.ProcessEnv} [opts.env] - overlay env
 * @param {string} opts.prompt
 * @param {string[]} [opts.files]
 * @param {string | null} [opts.sessionId]
 * @param {string | null} [opts.model]
 * @param {string | null} [opts.agent]
 * @param {string | null} [opts.variant]
 * @param {(ev: object) => void} opts.onEvent - run-json shaped events
 * @param {(req: object) => void} [opts.onPermission] - permission.asked properties
 * @param {(requestID: string) => void} [opts.onPermissionReplied]
 * @param {(info: { code: number | null, stderr: string }) => void} opts.onExit
 * @param {(err: Error) => void} [opts.onError]
 * @returns {{ kill: () => void, replyPermission: (id: string, reply: "once" | "always" | "reject") => Promise<boolean> }}
 */
function runOpencodeServeTurn(opts) {
  const {
    binary = process.env.CODER_OPENCODE_BIN || "opencode",
    args = DEFAULT_ARGS,
    cwd,
    env: envOverride,
    prompt,
    files,
    sessionId: resumeId,
    model,
    agent,
    variant,
    onEvent,
    onPermission,
    onPermissionReplied,
    onExit,
    onError,
  } = opts;

  const password = randomBytes(24).toString("hex");
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const sse = new AbortController();
  /** @type {{ child: any, stderr: string, onClose: ((code: number | null) => void) | null }} */
  const holder = { child: null, stderr: "", onClose: null };
  let baseUrl = "";
  let sessionId = resumeId ? String(resumeId) : "";
  let settled = false;
  let stopping = false;
  let sawBusy = false;
  let terminalError = "";

  function emit(ev) {
    try {
      onEvent(ev);
    } catch {
      // defensive: never crash the stream
    }
  }

  function finish(code, stderr) {
    if (settled) return;
    settled = true;
    sse.abort();
    if (holder.child) killTree(holder.child, SIGKILL_AFTER_MS);
    if (typeof onExit === "function") onExit({ code, stderr: stderr || "" });
  }

  async function api(method, route, body) {
    const res = await fetch(baseUrl + route, {
      method,
      headers: { authorization: auth, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = (j && j.data && j.data.message) || (j && j.message) || text;
      } catch {
        // keep raw text
      }
      throw new Error(`${method} ${route} → ${res.status}${msg ? `: ${msg}` : ""}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async function shutdown() {
    if (stopping || settled) return;
    stopping = true;
    if (baseUrl && sessionId && !isShuttingDown()) {
      try {
        await Promise.race([
          api("POST", `/session/${encodeURIComponent(sessionId)}/abort`),
          new Promise((r) => {
            const t = setTimeout(r, ABORT_TIMEOUT_MS);
            if (typeof t.unref === "function") t.unref();
          }),
        ]);
      } catch {
        // kill anyway
      }
    }
    finish(1, "");
  }

  void (async () => {
    try {
      baseUrl = await startServer({
        binary,
        args,
        cwd,
        env: { ...process.env, ...(envOverride || {}), OPENCODE_SERVER_PASSWORD: password },
        holder,
        isStopped: () => stopping || settled,
      });
      if (stopping || settled) {
        finish(1, "");
        return;
      }
      holder.onClose = (code) => {
        finish(code == null || code === 0 ? 1 : code, terminalError || holder.stderr || "opencode serve exited");
      };

      const res = await fetch(`${baseUrl}/event`, {
        headers: { authorization: auth, accept: "text/event-stream" },
        signal: sse.signal,
      });
      if (!res.ok || !res.body) throw new Error(`GET /event → ${res.status}`);

      let translate = sessionId ? createEventTranslator(sessionId) : null;
      const pump = readSse(res.body, (ev) => {
        const p = ev.properties || {};
        if (!sessionId || p.sessionID !== sessionId) return;
        if (ev.type === "permission.asked") {
          if (typeof onPermission === "function") onPermission(p);
          return;
        }
        if (ev.type === "permission.replied") {
          if (typeof onPermissionReplied === "function") onPermissionReplied(String(p.requestID || ""));
          return;
        }
        if (ev.type === "session.status" && p.status && p.status.type === "busy") sawBusy = true;
        if (ev.type === "session.idle" && sawBusy) {
          finish(terminalError ? 1 : 0, terminalError);
          return;
        }
        for (const out of translate ? translate(ev) : []) {
          if (out.type === "error") terminalError = extractTerminalError(out) || "opencode session error";
          emit(out);
        }
      });
      pump.then(
        () => finish(1, terminalError || holder.stderr || "opencode event stream ended"),
        (err) => {
          if (settled || stopping) return;
          finish(1, terminalError || (err && err.message) || String(err));
        },
      );

      if (!sessionId) {
        const created = await api("POST", "/session", {});
        if (!created || typeof created.id !== "string") throw new Error("opencode serve returned no session");
        sessionId = created.id;
        translate = createEventTranslator(sessionId);
      }
      emit({ type: "session", sessionID: sessionId });
      if (stopping || settled) return;

      /** @type {Record<string, unknown>} */
      const body = { parts: promptParts(prompt, files) };
      const ref = modelRef(model);
      if (ref) body.model = ref;
      if (agent) body.agent = String(agent);
      if (variant) body.variant = String(variant);
      await api("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, body);
    } catch (err) {
      if (settled || stopping) return;
      const e = err instanceof Error ? err : new Error(String(err));
      if (typeof onError === "function") {
        try {
          onError(e);
        } catch {
          // ignore
        }
      }
      finish(1, e.message);
    }
  })();

  return {
    kill() {
      void shutdown();
    },
    async replyPermission(id, reply) {
      if (settled || !baseUrl) return false;
      try {
        await api("POST", `/permission/${encodeURIComponent(id)}/reply`, { reply });
        return true;
      } catch {
        return false;
      }
    },
  };
}

module.exports = {
  runOpencodeServeTurn,
  createEventTranslator,
  promptParts,
  modelRef,
  readSse,
  DEFAULT_ARGS,
};
