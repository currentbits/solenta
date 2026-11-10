import type { CoderApi, RemoteComputerDescriptor } from "./shared/ipc";
import { bindCoderApi } from "./shared/ipcChannels";
import {
  WIRE_PUSH_CHANNELS,
  type WireClientMessage,
  type WireServerMessage,
} from "./shared/wire";
import { setWireStatus } from "./wireStatus";

export type WireCredentials = { token: string; computerId: string; deviceId: string };
export type CreateWireCoderOptions = {
  url: string;
  token: string;
  WebSocket?: typeof WebSocket;
  setTimeout?: typeof setTimeout;
  expectedComputerId?: string;
  allowLegacy?: boolean;
  fetch?: typeof fetch;
  onComputer?: (computer: RemoteComputerDescriptor) => void;
  getCredentials?: () => Promise<WireCredentials>;
  subscribeCredentials?: (listener: (credentials: WireCredentials | null) => void) => () => void;
};

function computerDescriptor(value: unknown): RemoteComputerDescriptor {
  const descriptor = value as RemoteComputerDescriptor | null;
  if (!descriptor || descriptor.kind !== "solenta" || typeof descriptor.computerId !== "string" ||
    !descriptor.computerId || !descriptor.protocol ||
    !Number.isInteger(descriptor.protocol.min) || !Number.isInteger(descriptor.protocol.max) ||
    (descriptor.runtimeKind !== "server" && descriptor.runtimeKind !== "desktop")) {
    throw new Error("This address did not return a valid Solenta computer identity.");
  }
  if (descriptor.protocol.min > 1 || descriptor.protocol.max < 1) {
    throw new Error("This computer uses an incompatible connection protocol. Update Solenta on both computers.");
  }
  return descriptor;
}

type Pending = {
  id: number;
  channel: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

const TRANSPORT_ERROR = "WebSocket disconnected";
const UNCONFIRMED_SEND = "Connection lost before confirmation. Your message may have reached the computer. Check the thread before sending it again.";
const QUEUE_FULL_ERROR = "Offline queue full, request dropped";
const MAX_BACKOFF_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_QUEUED = 64;
// ponytail: one timeout for every channel. Raise it if a legitimately slow
// handler (gh network calls) starts tripping instead of per-channel budgets.
const INVOKE_TIMEOUT_MS = 120_000;
// Mirrors electron/webBridge.js close codes.
const CLOSE_TOKEN_REJECTED = 4401;
const CLOSE_RATE_LIMITED = 4429;
const TOKEN_REJECTED_ERROR = "Not authorized: Solenta rejected this device's token";
// Calls that carry a user's message; queuing one is worth telling them about.
const SEND_CHANNELS = new Set(["runs:start", "runs:steer", "runs:sendQueued"]);
// Only side-effect-free reads may share one reply on reconnect. ponytail:
// method-name allowlist; an unlisted read just costs one extra request.
const COALESCE_SAFE = /^[a-zA-Z]+:(list\w*|get|status|summaries|search|recent)$/;

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
  let rejected = false;
  let blockedReason: string | null = null;
  let computerId = opts.expectedComputerId;
  let authenticatingComputerId: string | undefined;
  let authSent = false;
  let authenticatingToken = opts.token;
  let token = opts.token;
  let deviceId: string | undefined;
  let credentialRevision = 0;
  let awaitingCredentialAck = false;

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
      if (!COALESCE_SAFE.test(p.channel)) {
        // A mutation runs as queued, and a read queued after it must not
        // borrow a reply from before it (#928).
        bySig.clear();
        sendPending(p);
        continue;
      }
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
    for (const p of inflight.values()) p.reject(message === TRANSPORT_ERROR && SEND_CHANNELS.has(p.channel)
      ? new Error(UNCONFIRMED_SEND) : err);
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
      } else if (rejected || blockedReason) {
        p.reject(new Error(blockedReason || TOKEN_REJECTED_ERROR));
      } else {
        if (SEND_CHANNELS.has(channel)) setWireStatus({ queuedSend: true });
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
    if (blockedReason) return;
    let msg: WireServerMessage;
    try {
      msg = JSON.parse(raw) as WireServerMessage;
    } catch {
      return;
    }
    if (msg.kind === "auth-updated") {
      if (!awaitingCredentialAck) return;
      try {
        if (computerDescriptor(msg.computer).computerId !== computerId || msg.deviceId !== deviceId) throw new Error("Cloud credential identity mismatch.");
        awaitingCredentialAck = false;
      } catch (error) { block(error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (msg.kind === "auth-ok") {
      if (!authSent) return;
      try {
        if (msg.computer) {
          const computer = computerDescriptor(msg.computer);
          if ((computerId || authenticatingComputerId) && computer.computerId !== (computerId || authenticatingComputerId)) {
            throw new Error("This address belongs to a different computer. The saved connection was not changed.");
          }
          computerId = computer.computerId;
          opts.onComputer?.(computer);
        } else if (computerId || opts.allowLegacy === false) {
          throw new Error("This computer cannot confirm its identity. Update its Solenta server or use explicit legacy compatibility for an unbound connection.");
        }
      } catch (error) {
        block(error instanceof Error ? error.message : String(error));
        return;
      }
      ready = true;
      awaitingCredentialAck = false;
      if (deviceId && deviceId !== msg.deviceId) { block("Cloud device identity mismatch."); return; }
      deviceId = msg.deviceId ?? deviceId;
      if (authenticatingToken !== token && computerId) {
        authenticatingToken = token; awaitingCredentialAck = true;
        send({ kind: "auth-update", token, computerId });
      }
      backoffMs = MIN_BACKOFF_MS;
      const reconnecting = everAuthed;
      everAuthed = true;
      setWireStatus({ state: "connected", queuedSend: false });
      flushQueue();
      if (reconnecting) resyncThreads();
      return;
    }
    if (!ready) return;
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
    authenticatingComputerId = undefined;
    authSent = false;
    ws.onopen = () => {
      if (socket !== ws) return;
      void authenticate(ws);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (socket !== ws) return;
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      handleMessage(data);
    };
    // Browser WebSocket errors stay on onerror. The `ws` package (and Node's
    // WebSocket) emit an 'error' that becomes uncaughtException with no
    // listener — same close path either way, so swallow here.
    ws.onerror = () => {};
    ws.onclose = (ev?: CloseEvent) => {
      if (socket !== ws) return;
      ready = false;
      resyncId = null;
      rejectInflight(TRANSPORT_ERROR);
      if (blockedReason) return;
      const code = ev && typeof ev.code === "number" ? ev.code : 0;
      if (code === 4409) {
        block("This computer could not confirm the saved identity or connection protocol. Check its address and Solenta version.");
        return;
      }
      // A wrong or revoked token will not heal by retrying: stop, and let
      // the token gate ask for a new one.
      if (code === CLOSE_TOKEN_REJECTED) {
        if (awaitingCredentialAck || authenticatingToken !== token) { awaitingCredentialAck = false; scheduleReconnect(); return; }
        rejected = true;
        rejectQueued(TOKEN_REJECTED_ERROR);
        setWireStatus({ state: "rejected" });
        return;
      }
      // Queued invokes sit here until auth-ok. A close before the first
      // auth-ok (wrong token, refused, drop) used to leave them pending
      // forever — the integration harness hung on a bad token.
      if (!everAuthed) rejectQueued(TRANSPORT_ERROR);
      setWireStatus({
        state: code === CLOSE_RATE_LIMITED ? "rateLimited" : everAuthed ? "reconnecting" : "connecting",
      });
      scheduleReconnect();
    };
  }

  function block(reason: string): void {
    blockedReason = reason;
    ready = false;
    authSent = false;
    rejectInflight(reason);
    rejectQueued(reason);
    setWireStatus({ state: "blocked", queuedSend: false, error: reason });
    socket?.close();
  }

  async function preflight(ws: InstanceType<typeof WS>): Promise<void> {
    const url = new URL(opts.url);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/.well-known/solenta";
    url.search = "";
    url.hash = "";
    let response: Response;
    try {
      response = await (opts.fetch ?? fetch)(url.href, {
        credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
      });
    } catch {
      if (socket === ws && ws.readyState === WS.OPEN) ws.close();
      return;
    }
    if (socket !== ws || ws.readyState !== WS.OPEN || blockedReason) return;
    try {
      if (!response.ok) throw new Error("This computer cannot confirm its identity. Update its Solenta server before reconnecting.");
      const computer = computerDescriptor(await response.json());
      if (socket !== ws || ws.readyState !== WS.OPEN || blockedReason) return;
      if (computerId && computer.computerId !== computerId) {
        throw new Error("This address belongs to a different computer. No saved credential was sent.");
      }
      // A public descriptor selects a route. Only auth-ok pins/persists it.
      authenticatingComputerId = computer.computerId;
      authSent = true; authenticatingToken = token;
      send({ kind: "auth", token, computerId: computer.computerId, protocol: 1 });
    } catch (error) {
      if (socket === ws) block(error instanceof Error ? error.message : String(error));
    }
  }

  function openSocket(): void {
    attach(new WS(opts.url));
  }

  function credentials(value: WireCredentials): void {
    if (!value || typeof value.token !== "string" || !value.token || value.token.length > 1024 || typeof value.computerId !== "string" || !value.computerId ||
        typeof value.deviceId !== "string" || !value.deviceId || (computerId && value.computerId !== computerId) || (deviceId && value.deviceId !== deviceId)) throw new Error("Cloud credential identity mismatch.");
    token = value.token; computerId = value.computerId; deviceId = value.deviceId; credentialRevision++;
  }
  async function authenticate(ws: InstanceType<typeof WS>): Promise<void> {
    try {
      const revision = credentialRevision;
      if (opts.getCredentials) {
        const value = await opts.getCredentials();
        if (socket !== ws || ws.readyState !== WS.OPEN) return;
        if (revision === credentialRevision) credentials(value);
      }
      if (!computerId && opts.allowLegacy !== false) { authSent = true; authenticatingToken = token; send({ kind: "auth", token }); return; }
      await preflight(ws);
    } catch { if (socket === ws && ws.readyState === WS.OPEN) ws.close(); }
  }
  opts.subscribeCredentials?.(value => {
    if (!value) { block("Cloud access ended. Reconnect from the desktop's Connections settings."); return; }
    const changed = value.token !== token;
    try { credentials(value); } catch (error) { block(error instanceof Error ? error.message : String(error)); return; }
    if (blockedReason) return;
    if (ready && computerId) { awaitingCredentialAck = true; authenticatingToken = token; send({ kind: "auth-update", token, computerId }); }
    else if (rejected && changed) { rejected = false; openSocket(); }
  });

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

  setWireStatus({ state: "connecting", queuedSend: false });
  openSocket();

  const api = bindCoderApi(invoke);
  return {
    ...api,
    on: on as CoderApi["on"],
  };
}
