import type { CoderApi } from "./shared/ipc";
import { bindCoderApi } from "./shared/ipcChannels";
import {
  WIRE_PUSH_CHANNELS,
  type WireClientMessage,
  type WireServerMessage,
} from "./shared/wire";

export type CreateWireCoderOptions = {
  url: string;
  token: string;
  WebSocket?: typeof WebSocket;
  setTimeout?: typeof setTimeout;
};

type Pending = {
  id: number;
  channel: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

const TRANSPORT_ERROR = "WebSocket disconnected";
const QUEUE_FULL_ERROR = "Offline queue full, request dropped";
const MAX_BACKOFF_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_QUEUED = 64;
// ponytail: one timeout for every channel. Raise it if a legitimately slow
// handler (gh network calls) starts tripping instead of per-channel budgets.
const INVOKE_TIMEOUT_MS = 120_000;

function unref(timer: unknown): void {
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

export function createWireCoder(opts: CreateWireCoderOptions): CoderApi {
  const WS = opts.WebSocket ?? WebSocket;
  const schedule = opts.setTimeout ?? setTimeout;

  let socket: InstanceType<typeof WS> | null = null;
  let ready = false;
  let nextId = 1;
  let backoffMs = MIN_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let everAuthed = false;

  const inflight = new Map<number, Pending>();
  const queued: Pending[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let resyncId: number | null = null;

  function send(msg: WireClientMessage): void {
    if (!socket || socket.readyState !== WS.OPEN) return;
    socket.send(JSON.stringify(msg));
  }

  function sendPending(p: Pending): void {
    inflight.set(p.id, p);
    send({ kind: "invoke", id: p.id, channel: p.channel, args: p.args });
  }

  function flushQueue(): void {
    const batch = queued.splice(0);
    const bySig = new Map<string, Pending>();
    for (const p of batch) {
      const sig = JSON.stringify([p.channel, p.args]);
      const first = bySig.get(sig);
      if (!first) {
        bySig.set(sig, p);
        sendPending(p);
        continue;
      }
      // Interval pollers queue the same call over and over during an outage.
      // Send one and share its reply instead of stampeding main on reconnect.
      const { resolve, reject } = first;
      first.resolve = (v) => {
        resolve(v);
        p.resolve(v);
      };
      first.reject = (e) => {
        reject(e);
        p.reject(e);
      };
    }
  }

  function rejectInflight(message: string): void {
    const err = new Error(message);
    for (const p of inflight.values()) p.reject(err);
    inflight.clear();
  }

  function rejectQueued(message: string): void {
    const err = new Error(message);
    while (queued.length) queued.shift()!.reject(err);
  }

  function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      // Covers both a handler that hangs in main and a queued call that never
      // gets a reconnect: either way the caller's button stops spinning.
      const timer = schedule(() => {
        inflight.delete(id);
        const i = queued.findIndex((q) => q.id === id);
        if (i >= 0) queued.splice(i, 1);
        reject(new Error(`Timed out after ${INVOKE_TIMEOUT_MS}ms: ${channel}`));
      }, INVOKE_TIMEOUT_MS);
      unref(timer);
      const p: Pending = {
        id,
        channel,
        args,
        resolve: (v) => {
          clearTimeout(timer as ReturnType<typeof setTimeout>);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer as ReturnType<typeof setTimeout>);
          reject(e);
        },
      };
      if (ready && socket && socket.readyState === WS.OPEN) {
        sendPending(p);
      } else {
        while (queued.length >= MAX_QUEUED) {
          queued.shift()!.reject(new Error(QUEUE_FULL_ERROR));
        }
        queued.push(p);
      }
    });
  }

  function resyncThreads(): void {
    const p: Pending = {
      id: nextId++,
      channel: "threads:list",
      args: [],
      resolve: () => {},
      reject: () => {},
    };
    resyncId = p.id;
    sendPending(p);
  }

  function handleMessage(raw: string): void {
    let msg: WireServerMessage;
    try {
      msg = JSON.parse(raw) as WireServerMessage;
    } catch {
      return;
    }
    if (msg.kind === "auth-ok") {
      ready = true;
      backoffMs = MIN_BACKOFF_MS;
      const reconnecting = everAuthed;
      everAuthed = true;
      flushQueue();
      if (reconnecting) resyncThreads();
      return;
    }
    if (msg.kind === "reply") {
      const p = inflight.get(msg.id);
      if (!p) return;
      inflight.delete(msg.id);
      if (typeof msg.error === "string") {
        p.reject(new Error(msg.error));
        return;
      }
      p.resolve(msg.result);
      if (msg.id === resyncId) {
        resyncId = null;
        const set = listeners.get("threads:changed");
        if (set) {
          for (const cb of set) cb(msg.result);
        }
      }
      return;
    }
    if (msg.kind === "push") {
      const set = listeners.get(msg.channel);
      if (!set) return;
      for (const cb of set) cb(msg.payload);
    }
  }

  function scheduleReconnect(): void {
    if (reconnectTimer != null) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    const timer = schedule(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
    reconnectTimer = timer as ReturnType<typeof setTimeout>;
    unref(timer);
  }

  function attach(ws: InstanceType<typeof WS>): void {
    socket = ws;
    ready = false;
    ws.onopen = () => {
      send({ kind: "auth", token: opts.token });
    };
    ws.onmessage = (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      handleMessage(data);
    };
    // Browser WebSocket errors stay on onerror. The `ws` package (and Node's
    // WebSocket) emit an 'error' that becomes uncaughtException with no
    // listener — same close path either way, so swallow here.
    ws.onerror = () => {};
    ws.onclose = () => {
      ready = false;
      rejectInflight(TRANSPORT_ERROR);
      // Queued invokes sit here until auth-ok. A close before the first
      // auth-ok (wrong token, refused, drop) used to leave them pending
      // forever — the integration harness hung on a bad token.
      if (!everAuthed) rejectQueued(TRANSPORT_ERROR);
      scheduleReconnect();
    };
  }

  function openSocket(): void {
    attach(new WS(opts.url));
  }

  function on(channel: string, cb: (payload: unknown) => void): () => void {
    if (!(WIRE_PUSH_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`Push channel not allowed: ${channel}`);
    }
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  openSocket();

  const api = bindCoderApi(invoke);
  return {
    ...api,
    on: on as CoderApi["on"],
  };
}

