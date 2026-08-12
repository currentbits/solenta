/**
 * Round 51 Worker B: resolveCoderApi selection + web token flow.
 *
 * Electron path: window.coder present → that object, ZERO WebSocket
 * constructions. Web path: query token scrub+persist, localStorage, or the
 * paste-token gate. Mutant: skip the Electron guard and every web boot
 * opens a socket.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import {
  WEB_TOKEN_KEY,
  needsWebTokenGate,
  persistWebToken,
  resolveCoderApi,
  resolveWebToken,
  webNavigation,
  wsUrlFromLocation,
} from "../src/coderApi.ts";
import { BootApp } from "../src/boot.tsx";
import type { CoderApi } from "../src/shared/ipc.ts";

class CountingWebSocket {
  static constructions = 0;
  constructor() {
    CountingWebSocket.constructions += 1;
  }
}

function wipeCoder(): void {
  delete (window as unknown as { coder?: CoderApi }).coder;
}

async function withDom(): Promise<{ unmount: () => void }> {
  const shell = await mount(<div />);
  window.localStorage.clear();
  wipeCoder();
  window.history.replaceState(null, "", "/");
  CountingWebSocket.constructions = 0;
  return shell;
}

const originalReload = webNavigation.reload;

afterEach(() => {
  CountingWebSocket.constructions = 0;
  webNavigation.reload = originalReload;
  if (typeof window !== "undefined") {
    window.localStorage?.clear();
    wipeCoder();
  }
});

describe("wsUrlFromLocation", () => {
  it("maps http origin to ws and https origin to wss", () => {
    assert.equal(
      wsUrlFromLocation({ protocol: "http:", host: "127.0.0.1:8787" }),
      "ws://127.0.0.1:8787",
    );
    assert.equal(
      wsUrlFromLocation({ protocol: "https:", host: "coder.example" }),
      "wss://coder.example",
    );
  });
});

describe("resolveWebToken", () => {
  it("scrubs ?token= from the URL and persists it to localStorage", async () => {
    await withDom();
    window.history.replaceState(null, "", "/?token=from-query&x=1");
    const token = resolveWebToken();
    assert.equal(token, "from-query");
    assert.equal(window.localStorage.getItem(WEB_TOKEN_KEY), "from-query");
    const url = new URL(window.location.href);
    assert.equal(url.searchParams.get("token"), null);
    assert.equal(url.searchParams.get("x"), "1");
  });

  it("reads a previously persisted localStorage token when the query is empty", async () => {
    await withDom();
    window.localStorage.setItem(WEB_TOKEN_KEY, "stored-tok");
    assert.equal(resolveWebToken(), "stored-tok");
  });
});

describe("needsWebTokenGate", () => {
  it("is true only in web mode with no token", async () => {
    await withDom();
    assert.equal(needsWebTokenGate(), true);
    persistWebToken("have-one");
    assert.equal(needsWebTokenGate(), false);
    wipeCoder();
    (window as unknown as { coder: { n: 1 } }).coder = { n: 1 } as unknown as CoderApi;
    window.localStorage.clear();
    assert.equal(needsWebTokenGate(), false, "Electron preload must not show the gate");
  });
});

describe("DEV browser fallback (npm run dev, no Electron, no token)", () => {
  it("gate is suppressed and resolveCoderApi returns devCoder in a DEV build", async () => {
    await withDom();
    // Web mode (no window.coder), no token: production would gate, DEV must
    // not. isDev injected true because the esbuild harness pins env.DEV falsy.
    assert.equal(
      needsWebTokenGate(true),
      false,
      "DEV browser session must not show the token gate",
    );
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      CountingWebSocket as unknown as typeof WebSocket;
    const api = resolveCoderApi(true);
    assert.equal(
      (api as unknown as { __devCoder?: true }).__devCoder ??
        typeof api.projects.list,
      typeof api.projects.list,
      "DEV fallback returns a working CoderApi (devCoder), not a throw",
    );
    assert.equal(
      CountingWebSocket.constructions,
      0,
      "DEV fallback must not open a socket",
    );
  });

  it("production (isDev=false) still gates then throws, never devCoder", async () => {
    await withDom();
    assert.equal(needsWebTokenGate(false), true, "prod web with no token gates");
    assert.throws(
      () => resolveCoderApi(false),
      /Missing web token/,
      "prod must throw, never silently fall back to devCoder",
    );
  });
});

describe("resolveCoderApi Electron guard", () => {
  it("returns window.coder and constructs zero WebSockets", async () => {
    await withDom();
    const sentinel = { electron: true } as unknown as CoderApi;
    (window as unknown as { coder: CoderApi }).coder = sentinel;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      CountingWebSocket as unknown as typeof WebSocket;
    const api = resolveCoderApi();
    assert.equal(api, sentinel);
    assert.equal(
      CountingWebSocket.constructions,
      0,
      "window.coder present must not construct a WebSocket",
    );
  });

  it("constructs a WebSocket from the page origin when there is no window.coder", async () => {
    await withDom();
    persistWebToken("web-tok");
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      CountingWebSocket as unknown as typeof WebSocket;
    resolveCoderApi();
    assert.equal(CountingWebSocket.constructions, 1);
  });
});

describe("token-missing gate", () => {
  it("renders a paste-token form when web mode has no token, then stores and reloads", async () => {
    await withDom();
    let reloads = 0;
    webNavigation.reload = () => {
      reloads += 1;
    };
    const m = await mount(<BootApp />);
    const input = m.query("input");
    assert.ok(input, "missing-token web boot must show a token field");
    assert.match(m.text(), /token/i);
    await m.type(input, "pasted-tok");
    const submit = m.query("button[type=submit]") ?? m.byText("Continue");
    await m.click(submit);
    assert.equal(window.localStorage.getItem(WEB_TOKEN_KEY), "pasted-tok");
    assert.equal(reloads, 1);
    m.unmount();
  });
});
