import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import type { CoderApi } from "../src/shared/ipc";
import { ConnectionsSection } from "../src/components/ConnectionsSection";
import { mount, unmountAll, type Mounted } from "./support/dom.ts";

afterEach(() => {
  window.localStorage.removeItem("coder.remoteConnections");
  unmountAll();
});

async function pairStep(m: Mounted) {
  await m.click(m.query("[data-connection-setup]"));
  await m.type(m.query("[data-setup-port]"), "4621");
  await m.click(m.query("[data-setup-next]"));
  assert.match(m.text(), /http:\/\/127\.0\.0\.1:4621/);
  await m.type(m.query("[data-setup-address]"), "https://solenta.example.com/");
  await m.click(m.query("[data-setup-next]"));
}

it("guides own-tunnel setup, pins a copied device identity and saves only the authenticated route", async () => {
  const calls: Parameters<CoderApi["app"]["openRemoteConnection"]>[0][] = [], pushed: unknown[] = [];
  const m = await mount(<ConnectionsSection onOpen={async input => {
    calls.push(input);
    return { host: "solenta.example.com", remotePort: 443, url: "https://solenta.example.com", tokenSaved: true, computerId: "computer-123" };
  }} onSidebarHosts={async rows => { pushed.push(rows); return []; }} />);
  await pairStep(m);
  assert.match(m.text(), /Step 3 of 3: Pair and test/);
  assert.equal(document.activeElement?.tagName, "H3");
  await m.type(m.query("[data-setup-credential]"), "http://127.0.0.1:4621/#token=private-device-secret&computerId=computer-123");
  await m.click(m.query("[data-setup-connect]"));
  assert.deepEqual(calls, [{ host: "", url: "https://solenta.example.com", token: "private-device-secret", computerId: "computer-123", remember: true }]);
  assert.match(m.text(), /Computer connected/);
  assert.equal(m.query("[data-setup-credential]"), null);
  assert.equal(pushed.length, 1);
  const saved = window.localStorage.getItem("coder.remoteConnections") || "";
  assert.match(saved, /https:\/\/solenta.example.com/);
  assert.doesNotMatch(saved, /private-device-secret|127\.0\.0\.1|#token/);
  await m.click(m.byText("Done"));
  assert.equal(m.query("[data-connection-wizard]"), null);
  assert.equal(m.query("[data-connection-mode]")?.getAttribute("disabled"), null);
  assert.equal((m.query("[data-connection-mode]") as HTMLSelectElement).value, "address");
});

it("blocks invalid ports, insecure or credential-bearing public addresses and browser enrollment links", async () => {
  let opens = 0;
  const m = await mount(<ConnectionsSection onOpen={async () => { opens++; throw new Error("Must not connect"); }} />);
  await m.click(m.query("[data-connection-setup]"));
  await m.type(m.query("[data-setup-port]"), "0");
  await m.click(m.query("[data-setup-next]"));
  assert.match(m.text(), /from 1 to 65535/);
  await m.type(m.query("[data-setup-port]"), "4621");
  await m.click(m.query("[data-setup-next]"));
  for (const address of ["http://public.example.com", "https://me:secret@example.com", "https://example.com/#token=private", "https://example.com/path", "https://example.com/?token=private"]) {
    await m.type(m.query("[data-setup-address]"), address);
    await m.click(m.query("[data-setup-next]"));
    assert.match(m.text(), /Enter only your public HTTPS address/);
    assert.doesNotMatch(m.text(), /me:secret|token=private/);
  }
  await m.type(m.query("[data-setup-address]"), "https://solenta.example.com");
  await m.click(m.query("[data-setup-next]"));
  await m.type(m.query("[data-setup-credential]"), "https://solenta.example.com/#pair=one-use-browser-grant&computerId=computer-123");
  await m.click(m.query("[data-setup-connect]"));
  assert.match(m.text(), /browser enrollment link cannot be used/);
  assert.equal(opens, 0);
  assert.equal(window.localStorage.getItem("coder.remoteConnections"), null);
});

it("gives standalone-host instructions using the chosen port and startup token", async () => {
  const m = await mount(<ConnectionsSection onOpen={async () => { throw new Error("Not requested"); }} />);
  await m.click(m.query("[data-connection-setup]"));
  await m.change(m.query("[data-setup-runtime]"), "server");
  await m.type(m.query("[data-setup-port]"), "4621");
  assert.match(m.text(), /bin\/solenta-server --host 127\.0\.0\.1 --port 4621/);
  await m.click(m.query("[data-setup-next]"));
  await m.type(m.query("[data-setup-address]"), "https://solenta.example.com");
  await m.click(m.query("[data-setup-next]"));
  assert.match(m.text(), /token printed when the standalone server started/);
  assert.doesNotMatch(m.text(), /Under Devices, add a device/);
});

it("waits for the authenticated check before completing and prevents duplicate submissions", async () => {
  let opens = 0, finish = () => { throw new Error("Connection was not started"); };
  const m = await mount(<ConnectionsSection onOpen={() => {
    opens++;
    return new Promise(resolve => { finish = () => resolve({ host: "solenta.example.com", remotePort: 443, url: "https://solenta.example.com", tokenSaved: false }); });
  }} />);
  await pairStep(m);
  await m.type(m.query("[data-setup-credential]"), "device-secret");
  await m.click(m.query("[data-setup-connect]"));
  assert.match(m.text(), /Checking the host and device access/);
  assert.doesNotMatch(m.text(), /Computer connected/);
  assert.ok(m.query("[data-setup-connect]")?.hasAttribute("disabled"));
  assert.ok(m.byText("Cancel setup")?.hasAttribute("disabled"));
  await m.click(m.query("[data-setup-connect]"));
  assert.equal(opens, 1);
  finish();
  await m.flush();
  assert.match(m.text(), /Computer connected/);
});

it("keeps a failed connection retryable, preserves inputs when going back and clears credentials on cancel", async () => {
  let fail = true;
  const calls: Parameters<CoderApi["app"]["openRemoteConnection"]>[0][] = [];
  const m = await mount(<ConnectionsSection onOpen={async input => {
    calls.push(input);
    if (fail) throw new Error("Device access revoked");
    return { host: "solenta.example.com", remotePort: 443, url: "https://solenta.example.com", tokenSaved: false };
  }} />);
  await pairStep(m);
  await m.type(m.query("[data-setup-credential]"), "revoked-device-secret");
  await m.click(m.query("[data-setup-connect]"));
  assert.match(m.text(), /Device access revoked/);
  assert.doesNotMatch(m.text(), /Computer connected/);
  assert.equal(window.localStorage.getItem("coder.remoteConnections"), null);
  await m.click(m.query("[data-setup-back]"));
  assert.equal((m.query("[data-setup-address]") as HTMLInputElement).value, "https://solenta.example.com");
  await m.click(m.query("[data-setup-next]"));
  await m.type(m.query("[data-setup-credential]"), "replacement-device-secret");
  await m.click(m.query("[data-setup-remember]"));
  fail = false;
  await m.click(m.query("[data-setup-connect]"));
  assert.equal(calls[1].remember, false);
  assert.equal(calls[1].token, "replacement-device-secret");
  assert.match(m.text(), /Computer connected/);
  await m.click(m.byText("Done"));
  await m.click(m.query("[data-connection-setup]"));
  await m.click(m.query("[data-setup-next]"));
  await m.type(m.query("[data-setup-address]"), "https://solenta.example.com");
  await m.click(m.query("[data-setup-next]"));
  assert.equal((m.query("[data-setup-credential]") as HTMLInputElement).value, "");
  await m.type(m.query("[data-setup-credential]"), "cancelled-secret");
  await m.click(m.byText("Cancel setup"));
  assert.doesNotMatch(m.html(), /cancelled-secret/);
  assert.equal(calls.length, 2);
});
