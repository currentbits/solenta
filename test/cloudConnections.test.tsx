import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { ConnectionsSection } from "../src/components/ConnectionsSection";
import type { CloudComputer, CloudStatus, CoderApi } from "../src/shared/ipc";

afterEach(() => { window.localStorage.clear(); unmountAll(); });

function fixture() {
  const status: CloudStatus = { account: { configured: true, signedIn: true, accountId: "user_test", storage: "encrypted" },
    host: { configured: true, supported: true, enabled: false, computerId: "this-computer", state: "unlinked", revocationPending: false } };
  let computers: CloudComputer[] = [{ computerId: "remote-computer", label: "Build machine", status: "online", lastSeen: Date.now(),
    descriptor: { kind: "solenta", computerId: "remote-computer", runtimeKind: "server", platform: "linux", protocol: { min: 1, max: 1 }, version: "0.29.0" } }];
  const calls: Array<{ method: string; input?: unknown }> = [];
  let loginError = "", connectError = "", pending = false;
  const api = {
    cloudStatus: async () => structuredClone(status),
    cloudLogin: async () => { calls.push({ method: "login" }); if (loginError) throw new Error(loginError); status.account.signedIn = true; return status.account; },
    cloudLogout: async () => { calls.push({ method: "logout" }); status.account.signedIn = false; return { revocationPending: false }; },
    cloudComputers: async () => computers,
    cloudConnect: async (input: { computerId: string; scopes?: string[] }) => {
      calls.push({ method: "connect", input }); if (connectError) throw new Error(connectError);
      return { host: "cloud.example.com", remotePort: 443, computerId: input.computerId, descriptor: computers[0].descriptor, tokenSaved: false,
        cloud: { accountId: "user_test", computerId: input.computerId, scopes: input.scopes }, token: "never-persist-this" };
    },
    cloudLink: async () => { calls.push({ method: "link" }); status.host!.enabled = true; status.host!.state = "running"; return status.host!; },
    cloudUnlink: async (input: { computerId: string }) => { calls.push({ method: "unlink", input }); status.host!.enabled = false; return { revocationPending: pending }; },
  } as Pick<CoderApi["app"], "cloudStatus" | "cloudLogin" | "cloudLogout" | "cloudComputers" | "cloudConnect" | "cloudLink" | "cloudUnlink">;
  return { status, api, calls, offline: () => { computers = computers.map(row => ({ ...row, status: "offline" })); }, failLogin: (error: string) => { loginError = error; }, failConnect: (error: string) => { connectError = error; }, pending: () => { pending = true; } };
}

it("shows unavailable cloud configuration without offering a fake sign-in", async () => {
  const f = fixture(); f.status.account.configured = false; f.status.account.signedIn = false;
  const m = await mount(<ConnectionsSection cloudApi={f.api} />);
  assert.match(m.container.textContent || "", /cloud.*not configured|cloud.*isn.t configured/i);
  assert.equal(m.query("[data-cloud-sign-in]"), null);
});

it("reports a failed browser sign-in and keeps the user signed out", async () => {
  const f = fixture(); f.status.account.signedIn = false; f.failLogin("Browser sign-in cancelled");
  const m = await mount(<ConnectionsSection cloudApi={f.api} />);
  await m.click(m.query("[data-cloud-sign-in]"));
  assert.match(m.container.textContent || "", /Browser sign-in cancelled/);
  assert.equal(m.query("[data-cloud-sign-out]"), null);
});

it("connects a listed cloud computer and saves only verified route references and access scopes", async () => {
  const f = fixture(), sidebar: unknown[] = [];
  const m = await mount(<ConnectionsSection cloudApi={f.api} onSidebarHosts={async rows => { sidebar.push(rows); return []; }} />);
  assert.match(m.container.textContent || "", /Build machine/);
  assert.match(m.container.textContent || "", /Linux/);
  await m.change(m.query("[data-cloud-access]"), "read");
  await m.click(m.query('[data-cloud-connect="remote-computer"]'));
  assert.deepEqual(f.calls[0], { method: "connect", input: { computerId: "remote-computer", label: "Build machine", scopes: ["read"] } });
  const saved = window.localStorage.getItem("coder.remoteConnections") || "";
  assert.match(saved, /user_test/);
  assert.match(saved, /remote-computer/);
  assert.doesNotMatch(saved, /never-persist-this/);
  assert.equal(sidebar.length, 1);
});

it("an offline computer failure leaves the account signed in and does not loop sign-in", async () => {
  const f = fixture(); f.offline(); f.failConnect("Cloud computer is offline");
  const m = await mount(<ConnectionsSection cloudApi={f.api} />);
  assert.match(m.container.textContent || "", /Offline/);
  await m.click(m.query('[data-cloud-connect="remote-computer"]'));
  assert.match(m.container.textContent || "", /Cloud computer is offline/);
  assert.ok(m.query("[data-cloud-sign-out]"));
  assert.deepEqual(f.calls.map(call => call.method), ["connect"]);
});

it("sign-out clears receiving connections without globally unlinking a computer", async () => {
  const f = fixture();
  const m = await mount(<ConnectionsSection cloudApi={f.api} />);
  await m.click(m.query("[data-cloud-sign-out]"));
  assert.deepEqual(f.calls.map(call => call.method), ["logout"]);
  assert.ok(m.query("[data-cloud-sign-in]"));
  assert.equal(m.query('[data-cloud-connect="remote-computer"]'), null);
});

it("enabling and unlinking this host are separate actions, with honest pending revocation", async () => {
  const f = fixture(); f.pending();
  const m = await mount(<ConnectionsSection cloudApi={f.api} />);
  await m.click(m.query("[data-cloud-enable]"));
  assert.ok(m.query("[data-cloud-disable]"));
  await m.click(m.query("[data-cloud-disable]"));
  assert.match(m.container.textContent || "", /pending/i);
  assert.deepEqual(f.calls.map(call => call.method), ["link", "unlink"]);
  assert.deepEqual(f.calls[1].input, { computerId: "this-computer" });
});
