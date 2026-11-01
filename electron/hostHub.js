"use strict";

/**
 * Host hub (#1819): other machines' Solenta in this window, T3-style.
 *
 * Each machine owns its projects, threads and runs. For every saved
 * Connection with "Show in sidebar" on, the hub keeps one tunnel + web
 * socket open and:
 *   - merges that host's threads and projects into the lists this window
 *     sees, each row tagged `host: { key, label, status }`;
 *   - forwards any invoke whose args name one of that host's thread or
 *     project ids, so opening, prompting or creating a thread in a remote
 *     project runs on that machine;
 *   - relays the host's per-thread pushes to the desktop windows.
 * This machine's own web clients never see remote rows.
 */

const { WebSocket } = require("ws");

// Reconnect backoff; the last delay repeats while the host stays saved.
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const INVOKE_TIMEOUT_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 5_000;
// Pushes relayed as-is to the windows. threads:changed is merged instead;
// select/boot/settings-style pushes would steer this window, so they stay.
const RELAYED_PUSHES = new Set(["terminal:data", "pr:progress", "clone:progress"]);
// Direct routes (#1824) have no ssh keepalive: ping, and drop a socket
// that misses a pong so a sleeping network shows offline and reconnects.
const HEARTBEAT_MS = 30_000;
const NO_RETRY = /refused the login|host key|rejected this computer's token|rejected this token|No web token found|not installed on|Plain http|must start with|Enter an address/i;
// Arg fields that name the thread or project a call acts on.
const ID_FIELDS = ["threadId", "projectId", "id", "parentThreadId", "sourceThreadId"];

/**
 * Same rules as src/threadPatch.ts applyThreadListPush: null when the patch
 * has no base we hold, so the caller refetches threads:list.
 */
function applyListPush(prev, push, heldSeq) {
  if (Array.isArray(push)) return push;
  if (!push || typeof push !== "object") return null;
  if (Array.isArray(push.threads)) return push.threads;
  if (heldSeq == null || push.base !== heldSeq || !Array.isArray(push.upserts)) return null;
  const upserts = new Map(push.upserts.map((t) => [t.id, t]));
  const removed = new Set(push.removedIds || []);
  const out = [];
  for (const t of prev) {
    if (removed.has(t.id)) continue;
    const next = upserts.get(t.id);
    if (next) upserts.delete(t.id);
    out.push(next ?? t);
  }
  return upserts.size === 0 ? out : null;
}

// A direct route is keyed by its origin, an SSH host by host:port.
function hostKey(h) {
  return h.url || `${h.host}:${h.remotePort}`;
}

/**
 * @param {{
 *   openTunnel: (input: { host: string, remotePort: number, url?: string | null, label?: string }, onClose: () => void) => Promise<{ child: { backPort: number | null, kill: () => void }, token: string, wsUrl?: string }>,
 *   pushWindows: (channel: string, payload: unknown) => void,
 *   onThreadsChanged: () => void,
 *   onHostThreads?: (key: string, rows: any[]) => void,
 *   onCrewCall?: (key: string, call: { callId: string, workerId: string, tool: string, args: object }) => Promise<unknown> | null,
 *   WebSocketImpl?: typeof WebSocket,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (t: unknown) => void,
 * }} deps
 */
function createHostHub(deps) {
  const WS = deps.WebSocketImpl || WebSocket;
  const setTimer = deps.setTimer || ((fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  const clearTimer = deps.clearTimer || clearTimeout;
  /** @type {Map<string, any>} */
  const hosts = new Map();

  function tagFor(entry) {
    return { key: entry.key, label: entry.label, status: entry.status };
  }

  // Tagged rows are cached per source object so an unchanged remote row
  // keeps its identity and the window encoder sends a row patch, not the list.
  function tagRows(entry, rows, cacheName) {
    const prev = entry[cacheName];
    const next = new Map();
    const out = rows.map((row) => {
      const held = prev.get(row.id);
      const tagged = held && held.src === row && held.tag === entry.tag
        ? held.tagged
        : { ...row, host: entry.tag };
      next.set(row.id, { src: row, tag: entry.tag, tagged });
      return tagged;
    });
    entry[cacheName] = next;
    return out;
  }

  function setStatus(entry, status, error) {
    if (entry.status === status && entry.error === (error || null)) return;
    entry.status = status;
    entry.error = error || null;
    retag(entry);
  }

  function retag(entry) {
    entry.tag = tagFor(entry);
    entry.taggedThreads = tagRows(entry, entry.threads, "threadCache");
    entry.taggedProjects = tagRows(entry, entry.projects, "projectCache");
    deps.pushWindows("hosts:changed", list());
    deps.onThreadsChanged();
  }

  function setThreads(entry, rows) {
    entry.threads = rows;
    entry.threadIds = new Set(rows.map((t) => t.id));
    entry.taggedThreads = tagRows(entry, rows, "threadCache");
    deps.onHostThreads?.(entry.key, rows);
  }

  function setProjects(entry, rows) {
    entry.projects = Array.isArray(rows) ? rows : [];
    entry.projectIds = new Set(entry.projects.map((p) => p.id));
    entry.taggedProjects = tagRows(entry, entry.projects, "projectCache");
  }

  function send(entry, channel, args, timeoutMs) {
    if (entry.status !== "online" || !entry.ws) {
      return Promise.reject(new Error(`${entry.label} is ${entry.status === "connecting" ? "still connecting" : "offline"}. Its threads come back when it reconnects.`));
    }
    const id = ++entry.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        entry.pending.delete(id);
        reject(new Error(`${entry.label} did not answer in time.`));
      }, timeoutMs);
      entry.pending.set(id, { resolve, reject, timer });
      entry.ws.send(JSON.stringify({ kind: "invoke", id, channel, args }));
    });
  }

  async function refreshThreads(entry) {
    const rows = await send(entry, "threads:list", [], LIST_TIMEOUT_MS * 6);
    setThreads(entry, Array.isArray(rows) ? rows : []);
    entry.listSeq = null;
    deps.onThreadsChanged();
  }

  function onPush(entry, channel, payload) {
    if (channel === "threads:changed") {
      const next = applyListPush(entry.threads, payload, entry.listSeq);
      if (!next) {
        void refreshThreads(entry).catch(() => {});
        return;
      }
      entry.listSeq = payload && !Array.isArray(payload) ? payload.seq ?? null : null;
      setThreads(entry, next);
      deps.onThreadsChanged();
      return;
    }
    if (channel === "thread:updated") {
      if (!payload || !payload.thread) return;
      deps.pushWindows(channel, { ...payload, thread: { ...payload.thread, host: entry.tag } });
      return;
    }
    if (channel === "crew:call") {
      // A worker forked onto that host calls its crew tools here (#1821).
      // null = not one of ours: another desktop on that host answers.
      const pending = payload && deps.onCrewCall ? deps.onCrewCall(entry.key, payload) : null;
      if (!pending) return;
      void Promise.resolve(pending).then(
        (result) => ({ callId: payload.callId, result }),
        (err) => ({ callId: payload.callId, error: err && err.message ? err.message : String(err) }),
      ).then((answer) => send(entry, "threads:crewReply", [answer], LIST_TIMEOUT_MS)).catch(() => {});
      return;
    }
    if (channel === "boot:ready") {
      void refreshThreads(entry).catch(() => {});
      return;
    }
    if (RELAYED_PUSHES.has(channel)) deps.pushWindows(channel, payload);
  }

  function dropSocket(entry, why) {
    const ws = entry.ws;
    entry.ws = null;
    if (entry.beat) clearTimer(entry.beat);
    entry.beat = null;
    if (ws) {
      try { ws.terminate(); } catch { /* already gone */ }
    }
    entry.child?.kill();
    entry.child = null;
    for (const p of entry.pending.values()) {
      clearTimer(p.timer);
      p.reject(new Error(`${entry.label} disconnected.`));
    }
    entry.pending.clear();
    if (entry.removed || entry.retry) return;
    setStatus(entry, "offline", why);
    // A refused login, host key or token will not heal by retrying, and with
    // in-app SSH prompts (#1818) each retry would ask again. Wait for the
    // user: Connect, or Show in sidebar off and on, calls setHosts again.
    if (NO_RETRY.test(why || "")) {
      entry.parked = true;
      return;
    }
    const delay = RETRY_DELAYS_MS[Math.min(entry.attempt, RETRY_DELAYS_MS.length - 1)];
    entry.attempt += 1;
    entry.retry = setTimer(() => {
      entry.retry = null;
      void connect(entry);
    }, delay);
  }

  async function connect(entry) {
    if (entry.removed || entry.ws) return;
    if (entry.status !== "online") setStatus(entry, "connecting", entry.error);
    let opened;
    try {
      opened = await deps.openTunnel({ host: entry.host, remotePort: entry.remotePort, url: entry.url, label: entry.label }, () => {
        if (entry.child === opened?.child) dropSocket(entry, "SSH connection ended.");
      });
    } catch (err) {
      dropSocket(entry, err && err.message ? err.message : String(err));
      return;
    }
    if (entry.removed) {
      opened.child.kill();
      return;
    }
    entry.child = opened.child;
    const ws = new WS(opened.wsUrl || `ws://127.0.0.1:${opened.child.backPort}/ws`, { maxPayload: 128 * 1024 * 1024 });
    entry.ws = ws;
    if (entry.url && typeof ws.ping === "function") {
      let alive = true;
      ws.on("pong", () => { alive = true; });
      const beat = () => {
        if (entry.ws !== ws) return;
        if (!alive) {
          dropSocket(entry, `${entry.label} stopped answering.`);
          return;
        }
        alive = false;
        try { ws.ping(); } catch { /* close follows */ }
        entry.beat = setTimer(beat, HEARTBEAT_MS);
      };
      entry.beat = setTimer(beat, HEARTBEAT_MS);
    }
    ws.on("open", () => ws.send(JSON.stringify({ kind: "auth", token: opened.token })));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.kind === "auth-ok") {
        entry.attempt = 0;
        setStatus(entry, "online");
        void Promise.all([
          refreshThreads(entry),
          send(entry, "projects:list", [], LIST_TIMEOUT_MS * 6).then((rows) => {
            setProjects(entry, rows);
            deps.onThreadsChanged();
          }),
        ]).catch(() => {});
        return;
      }
      if (msg.kind === "reply") {
        const p = entry.pending.get(msg.id);
        if (!p) return;
        entry.pending.delete(msg.id);
        clearTimer(p.timer);
        if (msg.error) p.reject(new Error(String(msg.error)));
        else p.resolve(msg.result);
        return;
      }
      if (msg.kind === "push") onPush(entry, msg.channel, msg.payload);
    });
    ws.on("close", (code) => {
      if (entry.ws !== ws) return;
      dropSocket(entry, code === 4401 ? `${entry.label} rejected this computer's token. Connect again from Settings → Connections.` : "Connection closed.");
    });
    ws.on("error", () => {
      // close follows
    });
  }

  function remove(entry) {
    entry.removed = true;
    if (entry.retry) clearTimer(entry.retry);
    dropSocket(entry);
    hosts.delete(entry.key);
  }

  /**
   * Replace the set of hosts shown here. Unchanged hosts keep their socket.
   * @param {Array<{ host: string, remotePort: number, url?: string, label?: string }>} input
   */
  function setHosts(input) {
    const want = new Map();
    for (const h of Array.isArray(input) ? input : []) {
      if (!h) continue;
      if (typeof h.url === "string" && h.url) {
        let origin;
        try {
          origin = new URL(h.url).origin;
        } catch {
          continue;
        }
        want.set(origin, { ...h, url: origin, host: typeof h.host === "string" && h.host ? h.host : new URL(origin).hostname });
        continue;
      }
      if (typeof h.host !== "string" || !Number.isInteger(h.remotePort)) continue;
      want.set(hostKey(h), { ...h, url: null });
    }
    let changed = false;
    for (const entry of [...hosts.values()]) {
      if (!want.has(entry.key)) {
        remove(entry);
        changed = true;
      }
    }
    for (const [key, h] of want) {
      const label = (typeof h.label === "string" && h.label.trim()) || h.host;
      const held = hosts.get(key);
      if (held && held.parked) {
        // Saved again after a refusal: try once more.
        held.parked = false;
        held.attempt = 0;
        void connect(held);
      }
      if (held) {
        if (held.label !== label) {
          held.label = label;
          retag(held);
        }
        continue;
      }
      const entry = {
        key, host: h.host, remotePort: h.remotePort, url: h.url, label, beat: null,
        status: "connecting", error: null, tag: null,
        ws: null, child: null, pending: new Map(), nextId: 0, attempt: 0, retry: null, removed: false,
        threads: [], threadIds: new Set(), threadCache: new Map(), taggedThreads: [], listSeq: null,
        projects: [], projectIds: new Set(), projectCache: new Map(), taggedProjects: [],
      };
      entry.tag = tagFor(entry);
      hosts.set(key, entry);
      changed = true;
      void connect(entry);
    }
    if (changed) {
      deps.pushWindows("hosts:changed", list());
      deps.onThreadsChanged();
    }
    return list();
  }

  function list() {
    return [...hosts.values()].map((e) => ({
      key: e.key, host: e.host, remotePort: e.remotePort, ...(e.url ? { url: e.url } : {}),
      label: e.label, status: e.status, error: e.error,
    }));
  }

  /** @param {unknown[]} args */
  function ownerOf(args) {
    if (hosts.size === 0) return null;
    // Calls that create something on a host (add/clone a project, browse
    // its folders) name it explicitly with `onHost: key`.
    for (const arg of args.slice(0, 2)) {
      if (arg && typeof arg === "object" && typeof arg.onHost === "string" && arg.onHost) {
        const entry = hosts.get(arg.onHost);
        if (entry) return entry;
        throw new Error("That computer is no longer in the sidebar.");
      }
    }
    for (const arg of args.slice(0, 2)) {
      const ids = typeof arg === "string"
        ? [arg]
        : arg && typeof arg === "object" ? ID_FIELDS.map((k) => arg[k]).filter((v) => typeof v === "string") : [];
      for (const id of ids) {
        for (const entry of hosts.values()) {
          if (entry.threadIds.has(id) || entry.projectIds.has(id)) return entry;
        }
      }
    }
    return null;
  }

  // Thread- and project-shaped results get the host tag so the renderer can
  // tell them apart, and their ids route here before the next list.
  function tagResult(entry, channel, result) {
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    if (channel.startsWith("projects:") && typeof result.id === "string" && typeof result.path === "string") {
      entry.projectIds.add(result.id);
      return { ...result, host: entry.tag };
    }
    if (result.thread && typeof result.thread === "object" && typeof result.thread.id === "string") {
      if (result.thread.projectId) entry.threadIds.add(result.thread.id);
      return { ...result, thread: { ...result.thread, host: entry.tag } };
    }
    if (typeof result.id === "string" && typeof result.projectId === "string") {
      entry.threadIds.add(result.id);
      return { ...result, host: entry.tag };
    }
    return result;
  }

  /** Local rows plus every host's tagged rows, local first. */
  function mergeThreads(local) {
    if (hosts.size === 0) return local;
    const out = Array.isArray(local) ? local.slice() : [];
    for (const entry of hosts.values()) out.push(...entry.taggedThreads);
    return out;
  }

  function mergeProjects(local) {
    if (hosts.size === 0) return local;
    const out = Array.isArray(local) ? local.slice() : [];
    for (const entry of hosts.values()) out.push(...entry.taggedProjects);
    return out;
  }

  /**
   * Desktop invoke router. Returns a promise when the hub answers the call
   * (a merged list, or a forward to the owning host), else null.
   * @param {string} channel
   * @param {unknown[]} args
   * @param {() => Promise<unknown>} local
   */
  function route(channel, args, local) {
    if (hosts.size === 0) return null;
    if (channel === "threads:list") return local().then(mergeThreads);
    if (channel === "projects:list") {
      return local().then(async (rows) => {
        // Projects have no push, and the renderer refetches them on every
        // threads:changed: refresh each online host here, at most every 2 s.
        const now = Date.now();
        await Promise.all([...hosts.values()].map((entry) => {
          if (entry.status !== "online" || now - (entry.projectsAt || 0) < 2_000) return null;
          entry.projectsAt = now;
          return send(entry, "projects:list", [], LIST_TIMEOUT_MS).then((p) => setProjects(entry, p), () => {});
        }));
        return mergeProjects(rows);
      });
    }
    let entry;
    try {
      entry = ownerOf(args);
    } catch (err) {
      return Promise.reject(err);
    }
    if (!entry) return null;
    const sent = args.map((arg) => {
      if (!arg || typeof arg !== "object" || !("onHost" in arg)) return arg;
      const { onHost: _drop, ...rest } = arg;
      return rest;
    });
    return send(entry, channel, sent, INVOKE_TIMEOUT_MS).then((result) => tagResult(entry, channel, result));
  }

  /** Call one host by key, e.g. to start a worker there (#1821). */
  function invoke(key, channel, args) {
    const entry = hosts.get(key);
    if (!entry) return Promise.reject(new Error("That computer is no longer in the sidebar."));
    return send(entry, channel, args, INVOKE_TIMEOUT_MS).then((result) => tagResult(entry, channel, result));
  }

  function projectsOf(key) {
    return hosts.get(key)?.projects || [];
  }

  function threadsOf(key) {
    return hosts.get(key)?.threads || [];
  }

  function close() {
    for (const entry of [...hosts.values()]) remove(entry);
  }

  return { setHosts, list, route, ownerOf, mergeThreads, mergeProjects, invoke, projectsOf, threadsOf, close };
}

module.exports = { createHostHub, applyListPush, RELAYED_PUSHES };
