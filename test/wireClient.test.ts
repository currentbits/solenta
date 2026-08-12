/**
 * Round 51 Worker B: browser CoderApi over the wire.ts WebSocket contract.
 *
 * Fake socket speaks ONLY WireClientMessage / WireServerMessage. No invented
 * dialect. A mutant that swaps the kind tags, drops auth-first, or loses
 * reply correlation must go red.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type {
  WireClientMessage,
  WireServerMessage,
} from "../src/shared/wire.ts";
import { createWireCoder } from "../src/wireClient.ts";
import type { CoderApi, ThreadInfo } from "../src/shared/ipc.ts";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: WireClientMessage[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("send on a non-open socket");
    }
    this.sent.push(JSON.parse(data) as WireClientMessage);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  deliver(msg: WireServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function lastSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error("no WebSocket constructed");
  return ws;
}

function connect(opts?: {
  token?: string;
  setTimeout?: (fn: () => void, ms: number) => unknown;
}): { api: CoderApi; ws: FakeWebSocket } {
  const api = createWireCoder({
    url: "ws://127.0.0.1:8787",
    token: opts?.token ?? "tok-secret",
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    setTimeout: opts?.setTimeout,
  });
  const ws = lastSocket();
  ws.open();
  return { api, ws };
}

function authOk(ws: FakeWebSocket): void {
  ws.deliver({ kind: "auth-ok" });
}

afterEach(() => {
  FakeWebSocket.instances = [];
});

describe("createWireCoder auth-first", () => {
  it("sends {kind:auth,token} as the first message on open, and queues invokes until auth-ok", async () => {
    const { api, ws } = connect({ token: "tok-secret" });
    const pending = api.threads.list();
    assert.deepEqual(ws.sent, [{ kind: "auth", token: "tok-secret" }]);
    authOk(ws);
    const invoke = ws.sent[1];
    assert.deepEqual(invoke, {
      kind: "invoke",
      id: (invoke as { id: number }).id,
      channel: "threads:list",
      args: [],
    });
    assert.equal(invoke.kind, "invoke");
    ws.deliver({
      kind: "reply",
      id: (invoke as { kind: "invoke"; id: number }).id,
      result: [],
    });
    assert.deepEqual(await pending, []);
  });

  it("does not send an invoke before the socket is open", () => {
    const api = createWireCoder({
      url: "ws://127.0.0.1:8787",
      token: "tok-secret",
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    const ws = lastSocket();
    void api.projects.list();
    assert.equal(ws.sent.length, 0);
    assert.equal(ws.readyState, FakeWebSocket.CONNECTING);
  });
});

describe("createWireCoder correlation", () => {
  it("resolves two concurrent invokes from out-of-order replies", async () => {
    const { api, ws } = connect();
    authOk(ws);
    const pStatus = api.app.status();
    const pProjects = api.projects.list();
    const invokes = ws.sent.filter((m) => m.kind === "invoke");
    assert.equal(invokes.length, 2);
    const status = invokes.find((m) => m.channel === "app:status");
    const projects = invokes.find((m) => m.channel === "projects:list");
    assert.ok(status && projects);
    assert.notEqual(status.id, projects.id);
    ws.deliver({
      kind: "reply",
      id: projects.id,
      result: [{ id: "p1" }],
    });
    ws.deliver({
      kind: "reply",
      id: status.id,
      result: { memory: "ok" },
    });
    assert.deepEqual(await pProjects, [{ id: "p1" }]);
    assert.deepEqual(await pStatus, { memory: "ok" });
  });
});

describe("createWireCoder errors", () => {
  it("rethrows a reply error as Error(message) byte-equal to the server string", async () => {
    const { api, ws } = connect();
    authOk(ws);
    const pending = api.git.restoreCheckpoint({
      threadId: "t1",
      sha: "abc",
    });
    const invoke = ws.sent.find((m) => m.kind === "invoke");
    assert.ok(invoke && invoke.kind === "invoke");
    const msg = "Cannot restore a checkpoint while a run is active";
    ws.deliver({ kind: "reply", id: invoke.id, error: msg });
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, msg);
      return true;
    });
  });
});

describe("createWireCoder push", () => {
  it("dispatches contract push payloads and unsubscribe stops delivery", () => {
    const { api, ws } = connect();
    authOk(ws);
    const seen: ThreadInfo[][] = [];
    const off = api.on("threads:changed", (threads) => {
      seen.push(threads);
    });
    const payload = [{ id: "t-push" }] as unknown as ThreadInfo[];
    ws.deliver({
      kind: "push",
      channel: "threads:changed",
      payload,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0]?.id, "t-push");
    off();
    ws.deliver({
      kind: "push",
      channel: "threads:changed",
      payload: [{ id: "t-late" }] as unknown as ThreadInfo[],
    });
    assert.equal(seen.length, 1);
  });

  it("rejects an unknown push channel with the preload error string", () => {
    const { api } = connect();
    assert.throws(
      () =>
        (api.on as (ch: string, cb: () => void) => () => void)("nope", () => {}),
      { message: "Push channel not allowed: nope" },
    );
  });
});

describe("createWireCoder disconnect", () => {
  it("rejects queued invokes when the socket closes before auth-ok", async () => {
    const api = createWireCoder({
      url: "ws://127.0.0.1:8787",
      token: "tok-secret",
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      setTimeout: () => 0,
    });
    const ws = lastSocket();
    const pending = api.threads.list();
    ws.open();
    assert.deepEqual(ws.sent[0], { kind: "auth", token: "tok-secret" });
    ws.close();
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /disconnect|closed|transport|auth/i);
      return true;
    });
  });

  it("rejects in-flight invokes on drop with a clear transport error", async () => {
    const { api, ws } = connect();
    authOk(ws);
    const pending = api.threads.get("t1");
    const invoke = ws.sent.find((m) => m.kind === "invoke");
    assert.ok(invoke && invoke.kind === "invoke");
    ws.close();
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /disconnect|closed|transport/i);
      return true;
    });
  });
});

describe("createWireCoder reconnect", () => {
  it("backs off, re-auths, re-invokes threads:list, and synthesizes threads:changed", async () => {
    const delays: number[] = [];
    const queued: Array<() => void> = [];
    const { api, ws } = connect({
      setTimeout: (fn, ms) => {
        delays.push(ms);
        queued.push(fn);
        return delays.length;
      },
    });
    authOk(ws);
    const resynced: ThreadInfo[][] = [];
    api.on("threads:changed", (threads) => {
      resynced.push(threads);
    });
    ws.close();
    assert.equal(delays[0], 1000, "first reconnect waits 1s");
    queued.shift()!();
    assert.equal(FakeWebSocket.instances.length, 2);
    const ws2 = lastSocket();
    assert.equal(ws2.url, "ws://127.0.0.1:8787");
    assert.equal(ws2.sent.length, 0, "no traffic before open");
    ws2.open();
    assert.deepEqual(ws2.sent[0], { kind: "auth", token: "tok-secret" });
    const listed = [{ id: "t-resync" }] as unknown as ThreadInfo[];
    authOk(ws2);
    const resync = ws2.sent.find(
      (m) => m.kind === "invoke" && m.channel === "threads:list",
    );
    assert.ok(resync && resync.kind === "invoke", "reconnect must invoke threads:list");
    ws2.deliver({ kind: "reply", id: resync.id, result: listed });
    assert.equal(resynced.length, 1);
    assert.equal(resynced[0][0]?.id, "t-resync");
  });

  it("caps exponential backoff at 30s", () => {
    const delays: number[] = [];
    const queued: Array<() => void> = [];
    const { ws } = connect({
      setTimeout: (fn, ms) => {
        delays.push(ms);
        queued.push(fn);
        return delays.length;
      },
    });
    authOk(ws);
    // Drop + fail-to-stay-open seven times: 1,2,4,8,16,30,30
    for (let i = 0; i < 7; i++) {
      lastSocket().close();
      queued.shift()!();
      lastSocket().open();
      // Do not auth-ok: treat as a failed session so backoff keeps climbing,
      // then immediately drop again. Successful auth-ok would reset.
      lastSocket().close();
    }
    assert.deepEqual(delays.slice(0, 7), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
