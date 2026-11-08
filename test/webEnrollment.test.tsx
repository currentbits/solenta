import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { StrictMode } from "react";
import { mount, unmountAll } from "./support/dom.ts";
import { captureWebEnrollment, exchangeWebEnrollment } from "../src/webEnrollment";
import { WebEnrollmentGate } from "../src/components/WebEnrollmentGate";
import { BootApp } from "../src/boot";
import { WEB_COMPUTER_KEY, WEB_TOKEN_KEY, webNavigation } from "../src/coderApi";

const descriptor = { kind: "solenta", computerId: "computer-one", protocol: { min: 1, max: 1 }, runtimeKind: "server" };
const grant = "g".repeat(43);
const token = "s".repeat(43);
const realFetch = globalThis.fetch;
const realReload = webNavigation.reload;
afterEach(() => { unmountAll(); globalThis.fetch = realFetch; webNavigation.reload = realReload; if (typeof window !== "undefined") { window.localStorage.clear(); window.history.replaceState(null, "", "/"); } });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

it("checks the link's computer before exchange and stores a bound session without URL credentials", async () => {
  await mount(<div />);
  const calls: { url: string; options: RequestInit }[] = [];
  const request = (async (url: URL | RequestInfo, options: RequestInit) => {
    calls.push({ url: String(url), options });
    return calls.length === 1 ? response(descriptor) : response({ token, computerId: "computer-one", expiresAt: Date.now() + 100000 });
  }) as typeof fetch;
  await exchangeWebEnrollment({ grant, computerId: "computer-one" }, { origin: "https://host.example", fetch: request });
  assert.deepEqual(calls.map(c => c.url), ["https://host.example/.well-known/solenta", "https://host.example/api/enroll"]);
  assert.ok(calls.every(c => c.options.credentials === "omit" && c.options.redirect === "error"));
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].options.body as string), { grant, computerId: "computer-one" });
  assert.equal(window.localStorage.getItem(WEB_TOKEN_KEY), token);
  assert.equal(window.localStorage.getItem(WEB_COMPUTER_KEY), "computer-one");
  assert.ok(!JSON.stringify(window.localStorage).includes(grant));
});

it("does not send an enrollment credential or change the saved token on identity mismatch", async () => {
  await mount(<div />);
  window.localStorage.setItem(WEB_TOKEN_KEY, "existing-session");
  let requests = 0;
  await assert.rejects(exchangeWebEnrollment({ grant, computerId: "computer-one" }, {
    origin: "https://host.example", fetch: (async () => { requests++; return response({ ...descriptor, computerId: "another-computer" }); }) as typeof fetch,
  }), /No enrollment credential was sent/);
  assert.equal(requests, 1);
  assert.equal(window.localStorage.getItem(WEB_TOKEN_KEY), "existing-session");
});

it("strips the one-time fragment before App mounts even with an existing saved session", async () => {
  await mount(<div />);
  window.localStorage.setItem(WEB_TOKEN_KEY, "existing-session");
  window.history.replaceState(null, "", `/?keep=1#pair=${grant}&computerId=computer-one&view=threads`);
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
  const m = await mount(<BootApp />);
  assert.ok(m.query("[data-web-enrollment-gate]"));
  assert.equal(window.location.search, "?keep=1");
  assert.equal(window.location.hash, "#view=threads");
  assert.ok(!JSON.stringify(window.localStorage).includes(grant));
});

it("shares one redemption across StrictMode effects and reloads only after session and pin persist", async () => {
  await mount(<div />);
  window.history.replaceState(null, "", `/#pair=${grant}&computerId=computer-one`);
  const enrollment = captureWebEnrollment()!;
  let posts = 0;
  globalThis.fetch = (async (_url, options) => {
    if (options?.method !== "POST") return response(descriptor);
    posts++;
    return response({ token, computerId: "computer-one", expiresAt: Date.now() + 100000 });
  }) as typeof fetch;
  let reloads = 0;
  webNavigation.reload = () => { assert.equal(window.localStorage.getItem(WEB_TOKEN_KEY), token); assert.equal(window.localStorage.getItem(WEB_COMPUTER_KEY), "computer-one"); reloads++; };
  const m = await mount(<StrictMode><WebEnrollmentGate enrollment={enrollment} /></StrictMode>);
  await m.flush();
  assert.equal(posts, 1);
  assert.equal(reloads, 1);
  assert.equal(window.location.hash, "");
});
