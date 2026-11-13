"use strict";

const { it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { webcrypto } = require("node:crypto");
const { installWebMcp } = require("../preview-webmcp-preload.js");
const preview = require("../preview.js");
const { scopeForChannel, allows } = require("../webScopes.js");

function page({ allowed = true, secure = true, native, policy } = {}) {
  const context = vm.createContext({
    document: { ...(native ? { modelContext: native } : {}), featurePolicy: policy }, navigator: {},
    isSecureContext: secure, location: { origin: "http://localhost:5173" },
    crypto: webcrypto, TextEncoder, AbortController, DOMException, EventTarget, Event,
  });
  vm.runInContext(`globalThis.top = globalThis; (${installWebMcp.toString()})(${allowed})`, context);
  return context;
}

const register = (context, extra = "") => vm.runInContext(`
  document.modelContext.registerTool({ name: "counter", description: "Read or update the counter",
    inputSchema: { type: "object", properties: { increment: {type: "number"} } },
    annotations: { readOnlyHint: true },
    execute(input) { globalThis.count = (globalThis.count || 0) + (input.increment || 0); return {count: globalThis.count}; },
    ${extra}
  })`, context);

function bound(context) {
  const wc = new EventEmitter();
  wc.id = 7;
  wc.url = "http://localhost:5173";
  wc.getURL = () => wc.url;
  wc.session = { webRequest: { onSendHeaders() {}, onCompleted() {}, onErrorOccurred() {},
    onHeadersReceived(listener) { wc.headersReceived = listener; } } };
  wc.executeJavaScript = (code) => Promise.resolve(vm.runInContext(code, context, { timeout: 1000 }));
  wc.executeJavaScriptInIsolatedWorld = async () => null;
  preview.setWebContentsLookup((id) => id === wc.id ? wc : null);
  preview.bind({ threadId: "t1", webContentsId: wc.id });
  respond(wc);
  return wc;
}
// The main-document response the host observed; its headers decide WebMCP policy.
const respond = (wc, responseHeaders = {}) => wc.headersReceived(
  { resourceType: "mainFrame", webContentsId: wc.id, url: wc.url, responseHeaders }, () => {});
const base = { threadId: "t1" };
afterEach(() => preview.resetForTests());

it("registers before discovery, invokes page callbacks, and preserves literal arguments/results", async () => {
  const context = page();
  await register(context);
  bound(context);
  const list = await preview.webmcpTools(base);
  assert.equal(list.available, true);
  assert.equal(list.tools[0].annotations.untrustedContentHint, true);
  const ref = list.tools[0].ref;
  const result = await preview.webmcpInvoke({ ...base, ref, arguments: { increment: 3, text: "'); throw Error('injected" } });
  assert.equal(result.ok, true);
  assert.equal(result.completion, "done");
  assert.deepEqual(result.result, { count: 3 });
  assert.equal(result.untrusted, true);
  await register(context, 'name: "literal", execute: (input) => input.text');
  const literal = (await preview.webmcpTools(base)).tools.find((t) => t.name === "literal");
  assert.equal((await preview.webmcpInvoke({ ...base, ref: literal.ref, arguments: { text: "hello" } })).result, "hello");
});

it("never treats a page readOnlyHint as action authorization", () => {
  assert.equal(scopeForChannel("preview:webmcpTools"), "read");
  assert.equal(scopeForChannel("preview:webmcpInvoke"), "preview");
  assert.equal(scopeForChannel("preview:webmcpCancel"), "preview");
  assert.equal(allows(["read"], scopeForChannel("preview:webmcpInvoke")), false);
});

it("fails closed without secure context, host response policy, or an allowed tools feature", () => {
  assert.equal(page({ allowed: false }).document.modelContext, undefined);
  assert.equal(page({ secure: false }).document.modelContext, undefined);
  assert.equal(page({ policy: { features: () => ["tools"], allowsFeature: () => false } }).document.modelContext, undefined);
  assert.equal(preview.webMcpHeadersAllowed({ "Permissions-Policy": ["camera=()"] }), true);
  for (const header of ["tools=()", "camera=(), tools=(self)", "tools=broken", "tools", "tools=*"]) {
    assert.equal(preview.webMcpHeadersAllowed({ "permissions-policy": [header] }), false);
  }
});

it("returns unavailable for a document with no bridge and rejects nonlocal pages", async () => {
  const wc = bound(page({ allowed: false }));
  assert.deepEqual(await preview.webmcpTools(base), { available: false, tools: [], skipped: 0, untrusted: true });
  wc.url = "https://example.com";
  await assert.rejects(preview.webmcpTools(base), /local/);
});

it("invalidates refs on rediscovery and same-URL navigation, and never replays a mutation", async () => {
  const context = page(); await register(context); const wc = bound(context);
  const first = (await preview.webmcpTools(base)).tools[0].ref;
  const second = (await preview.webmcpTools(base)).tools[0].ref;
  await assert.rejects(preview.webmcpInvoke({ ...base, ref: first }), /stale/);
  wc.emit("did-navigate");
  await assert.rejects(preview.webmcpInvoke({ ...base, ref: second }), /stale/);
  assert.equal(context.count, undefined);
});

it("rejects a replaced registration even when its descriptor is identical", async () => {
  const context = page();
  await vm.runInContext(`globalThis.registration = new AbortController(); document.modelContext.registerTool({
    name: 'same', description: 'same', inputSchema: {type:'object'}, execute() {globalThis.executed=true;}
  }, {signal:registration.signal});`, context);
  bound(context);
  const ref = (await preview.webmcpTools(base)).tools[0].ref;
  await vm.runInContext(`registration.abort(); document.modelContext.registerTool({
    name: 'same', description: 'same', inputSchema: {type:'object'}, execute() {globalThis.executed=true;}
  });`, context);
  const result = await preview.webmcpInvoke({ ...base, ref });
  assert.equal(result.ok, false);
  assert.match(result.message, /stale/);
  assert.equal(context.executed, undefined);
});

it("checks native descriptors again, filters child-frame tools, and bounds schemas", async () => {
  const tool = { name: "native", description: "original", inputSchema: { type: "object" } };
  let executions = 0;
  const native = { getTools: async () => [tool, { ...tool, name: "child", window: {} },
    { ...tool, name: "huge", inputSchema: { type: "object", description: "x".repeat(20000) } }],
    executeTool: async () => { executions++; return "result"; } };
  const context = page({ native });
  tool.window = vm.runInContext("globalThis", context);
  bound(context);
  const list = await preview.webmcpTools(base);
  assert.equal(list.skipped, 2);
  assert.equal(list.tools.length, 1);
  tool.description = "changed";
  assert.equal((await preview.webmcpInvoke({ ...base, ref: list.tools[0].ref })).ok, false);
  assert.equal(executions, 0);
});

it("cancels a tool through AbortSignal even if it never resolves", async () => {
  const context = page();
  await register(context, 'execute: (_input, {signal}) => { globalThis.signal = signal; return new Promise(() => {}); }');
  bound(context);
  const ref = (await preview.webmcpTools(base)).tools[0].ref;
  const pending = preview.webmcpInvoke({ ...base, ref, invocationId: "slow" });
  await new Promise((r) => setImmediate(r));
  preview.webmcpCancel({ ...base, invocationId: "slow" });
  const result = await pending;
  assert.equal(context.signal.aborted, true);
  assert.equal(result.completion, "uncertain");
  await assert.rejects(preview.webmcpInvoke({ ...base, ref }), /stale/);
});

it("cancels on pane closure and fences an invocation cancelled before guest execution", async () => {
  const context = page(); await register(context); const wc = bound(context);
  let ref = (await preview.webmcpTools(base)).tools[0].ref;
  const invoke = wc.executeJavaScript;
  let run;
  wc.executeJavaScript = (code) => code.includes('["invoke"]') ? new Promise((resolve, reject) => {
    run = () => { try { resolve(invoke(code)); } catch (e) { reject(e); } };
  }) : invoke(code);
  const pending = preview.webmcpInvoke({ ...base, ref, invocationId: "queued" });
  preview.webmcpCancel({ ...base, invocationId: "queued" });
  assert.equal((await pending).completion, "uncertain");
  run(); await new Promise((r) => setImmediate(r));
  assert.equal(context.count, undefined);
  wc.executeJavaScript = invoke;
  await register(context, 'name: "slow", execute: (_i, {signal}) => {globalThis.signal=signal; return new Promise(() => {});}');
  ref = (await preview.webmcpTools(base)).tools.find((t) => t.name === "slow").ref;
  const closing = preview.webmcpInvoke({ ...base, ref });
  await new Promise((r) => setImmediate(r));
  preview.unbind(base);
  assert.equal((await closing).completion, "uncertain");
  assert.equal(context.signal.aborted, true);
});

it("bounds arguments and output, rejects invalid registrations and cyclic results", async () => {
  const context = page();
  await assert.rejects(register(context, 'inputSchema: {type:"object", description:"x".repeat(20000)}'), /size/);
  await register(context, 'execute: () => "x".repeat(70000)');
  bound(context);
  const ref = (await preview.webmcpTools(base)).tools[0].ref;
  await assert.rejects(preview.webmcpInvoke({ ...base, ref, arguments: { text: "x".repeat(20000) } }), /oversized/);
  await assert.rejects(preview.webmcpInvoke({ ...base, ref, arguments: [] }), /object/);
  const result = await preview.webmcpInvoke({ ...base, ref });
  assert.equal(result.ok, false);
  assert.ok(result.message.length <= 500);
  await register(context, 'name: "cycle", execute: () => {const a={};a.a=a;return a;}');
  const cycle = (await preview.webmcpTools(base)).tools.find((t) => t.name === "cycle");
  assert.equal((await preview.webmcpInvoke({ ...base, ref: cycle.ref })).ok, false);
});

it("rejects oversized forged bridge responses at the host boundary", async () => {
  const wc = bound(page());
  wc.executeJavaScript = async () => " ".repeat(40000);
  await assert.rejects(preview.webmcpTools(base), /oversized/);
});

it("times out once, aborts the callback, and requires rediscovery before retrying", async (t) => {
  const context = page();
  await register(context, 'execute: (_i, {signal}) => {globalThis.signal=signal; return new Promise(() => {});}');
  bound(context);
  const ref = (await preview.webmcpTools(base)).tools[0].ref;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = preview.webmcpInvoke({ ...base, ref });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(preview.ACTION_TIMEOUT_MS);
  assert.equal((await pending).completion, "uncertain");
  assert.equal(context.signal.aborted, true);
  await assert.rejects(preview.webmcpInvoke({ ...base, ref }), /stale/);
});

it("refuses discovery that raced navigation and cancels before a slow descriptor lookup can execute", async () => {
  let resolve;
  let executed = false;
  const tool = { name: "native", description: "native", inputSchema: { type: "object" } };
  const native = { getTools: async () => [tool], executeTool: () => { executed = true; } };
  const context = page({ native });
  tool.window = vm.runInContext("globalThis", context);
  const wc = bound(context);
  const ref = (await preview.webmcpTools(base)).tools[0].ref;
  native.getTools = () => new Promise((r) => { resolve = r; });
  const pending = preview.webmcpInvoke({ ...base, ref });
  wc.emit("did-start-navigation", {}, wc.url, false, true);
  assert.equal((await pending).completion, "uncertain");
  resolve([tool]); await new Promise((r) => setImmediate(r));
  assert.equal(executed, false);
  respond(wc);
  const discovery = preview.webmcpTools(base);
  wc.emit("did-navigate");
  resolve([tool]);
  await assert.rejects(discovery, /changed/);
});

it("caps aggregate discovery bytes and reports omitted tools", async () => {
  const context = page();
  for (let i = 0; i < 20; i++) await register(context, `name: "tool${i}", description: "x".repeat(4096)`);
  bound(context);
  const result = await preview.webmcpTools(base);
  assert.ok(result.tools.length < 20);
  assert.equal(result.tools.length + result.skipped, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 36_864);
});

it("allows JSON at the advertised nesting limit and rejects deeper payloads", async () => {
  const context = page();
  await register(context, `inputSchema: (() => {
    const root={type:'object'}; let at=root;
    for(let i=0;i<20;i++) at=at.child={}; return root;
  })(), execute: (input) => input`);
  bound(context);
  const ref = (await preview.webmcpTools(base)).tools[0].ref;
  const args = {}; let at = args;
  for (let i = 0; i < 20; i++) at = at.child = {};
  assert.equal((await preview.webmcpInvoke({ ...base, ref, arguments: args })).ok, true);
  at.child = {};
  await assert.rejects(preview.webmcpInvoke({ ...base, ref, arguments: args }), /deep/);
});

it("denies a page-defined bridge when the host-observed response policy refuses WebMCP", async () => {
  // The preload stayed out (policy denied), so the page plants its own global.
  const context = page({ allowed: false });
  vm.runInContext(`globalThis.__solentaWebMcp = { tools: async () => JSON.stringify({ documentId: "d", available: true,
    tools: [{ ref: "wd-1", name: "evil", description: "x", inputSchema: { type: "object" } }], skipped: 0 }),
    invoke: async () => { globalThis.invoked = true; return "{}"; }, cancel() {} };`, context);
  const wc = bound(context);
  respond(wc, { "Permissions-Policy": "tools=()" });
  assert.deepEqual(await preview.webmcpTools(base), { available: false, tools: [], skipped: 0, untrusted: true });
  await assert.rejects(preview.webmcpInvoke({ ...base, ref: "wd-1" }), /stale/);
  // A navigation start forgets the old response until the new one arrives.
  respond(wc);
  assert.equal((await preview.webmcpTools(base)).tools.length, 1);
  wc.emit("did-start-navigation", {}, wc.url, false, true);
  assert.equal((await preview.webmcpTools(base)).available, false);
  assert.equal(context.invoked, undefined);
});

it("keeps policy across same-document pushState and binds refs to the reporting document", async () => {
  const context = page(); await register(context); const wc = bound(context);
  wc.emit("did-start-navigation", {}, "http://localhost:5173/route#x", true, true);
  wc.url = "http://localhost:5173/route#x";
  const list = await preview.webmcpTools(base);
  assert.equal(list.tools.length, 1);
  const forged = JSON.stringify({ documentId: "other", available: true, skipped: 0,
    tools: [{ ...list.tools[0] }, { ...list.tools[0], ref: "wother-1" }] });
  const real = wc.executeJavaScript;
  wc.executeJavaScript = async () => forged;
  const result = await preview.webmcpTools(base);
  assert.deepEqual(result.tools.map((t) => t.ref), ["wother-1"]);
  assert.equal(result.skipped, 1);
  wc.executeJavaScript = real;
});

it("refuses a ref from another thread's Browser pane", async () => {
  const context = page(); await register(context); bound(context);
  const ref = (await preview.webmcpTools(base)).tools[0].ref;
  const other = new EventEmitter();
  Object.assign(other, { id: 8, url: "http://localhost:5173", getURL: () => other.url,
    session: { webRequest: { onSendHeaders() {}, onCompleted() {}, onErrorOccurred() {} } },
    executeJavaScript: (code) => Promise.resolve(vm.runInContext(code, context)) });
  const lookup = (id) => (id === 7 ? null : id === 8 ? other : null);
  preview.setWebContentsLookup(lookup);
  preview.bind({ threadId: "t2", webContentsId: 8 });
  await assert.rejects(preview.webmcpInvoke({ threadId: "t2", ref }), /stale/);
  assert.equal(context.count, undefined);
});

it("checks arguments against the discovered schema and refuses refs after schema replacement", async () => {
  const context = page();
  await vm.runInContext(`globalThis.registration = new AbortController(); document.modelContext.registerTool({
    name: "set", description: "Set the counter", annotations: { readOnlyHint: true },
    inputSchema: { type: "object", additionalProperties: false, required: ["value"],
      properties: { value: { type: "integer" }, mode: { enum: ["add", "set"] }, note: { type: ["string", "null"] } } },
    execute(input) { globalThis.count = input.value; return { count: input.value }; }
  }, { signal: registration.signal });`, context);
  bound(context);
  let ref = (await preview.webmcpTools(base)).tools[0].ref;
  for (const [args, message] of [
    [{}, /missing required argument "value"/],
    [{ value: 1.5 }, /must be integer/],
    [{ value: 1, mode: "drop" }, /not an allowed value/],
    [{ value: 1, note: 3 }, /must be string or null/],
    [{ value: 1, extra: true }, /unexpected argument "extra"/],
  ]) await assert.rejects(preview.webmcpInvoke({ ...base, ref, arguments: args }), message);
  assert.equal(context.count, undefined);
  // readOnlyHint does not skip validation or authorize anything: the mutation still runs only on valid input.
  assert.deepEqual((await preview.webmcpInvoke({ ...base, ref, arguments: { value: 2, mode: "set", note: null } })).result, { count: 2 });
  await vm.runInContext(`registration.abort(); document.modelContext.registerTool({
    name: "set", description: "Set the counter", inputSchema: { type: "object", properties: { value: { type: "string" } } },
    execute(input) { globalThis.count = input.value; }
  });`, context);
  const stale = await preview.webmcpInvoke({ ...base, ref, arguments: { value: 3 } });
  assert.equal(stale.ok, false);
  assert.equal(context.count, 2);
  ref = (await preview.webmcpTools(base)).tools[0].ref;
  await assert.rejects(preview.webmcpInvoke({ ...base, ref, arguments: { value: 3 } }), /must be string/);
});
