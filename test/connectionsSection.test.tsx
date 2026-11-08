import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { ConnectionsSection } from "../src/components/ConnectionsSection";

afterEach(() => {
  window.localStorage.removeItem("coder.remoteConnections");
  unmountAll();
});

it("saves an SSH host after connecting without persisting its web token", async () => {
  const calls: unknown[] = [];
  const m = await mount(<ConnectionsSection onOpen={async (input) => {
    calls.push(input);
    return { host: input.host, remotePort: input.remotePort ?? 4620, tokenSaved: false };
  }} />);
  await m.type(m.query("[data-connection-label]"), "Build machine");
  await m.type(m.query("[data-connection-host]"), "user@work");
  await m.type(m.query("[data-connection-token]"), "remote-secret");
  await m.click(m.query("[data-connection-open]"));
  assert.deepEqual(calls, [{
    host: "user@work", label: "Build machine", remotePort: 4620,
    token: "remote-secret", remember: true,
  }]);
  const saved = window.localStorage.getItem("coder.remoteConnections") || "";
  assert.match(saved, /user@work/);
  assert.doesNotMatch(saved, /remote-secret/);
  assert.equal((m.query("[data-connection-token]") as HTMLInputElement).value, "");
  m.unmount();
});

it("connects with a blank token and forgets the saved one with the host", async () => {
  const calls: unknown[] = [];
  const forgot: unknown[] = [];
  const m = await mount(<ConnectionsSection
    onOpen={async (input) => {
      calls.push(input);
      return { host: input.host, remotePort: input.remotePort ?? 4620, tokenSaved: true };
    }}
    onForget={async (input) => { forgot.push(input); }}
  />);
  await m.type(m.query("[data-connection-host]"), "user@work");
  await m.type(m.query("[data-connection-token]"), "remote-secret");
  await m.click(m.query("[data-connection-open]"));
  assert.match(m.container.textContent || "", /token saved/);
  await m.click(m.query("[data-connection-open]"));
  assert.equal((calls[1] as { token: string }).token, "");
  await m.click(m.query('[aria-label="Forget user@work"]'));
  assert.deepEqual(forgot, [{ host: "user@work", remotePort: 4620 }]);
  assert.doesNotMatch(window.localStorage.getItem("coder.remoteConnections") || "", /user@work/);
  m.unmount();
});

it("offers Install when the host has no Solenta, then connects once it is installed (#1660)", async () => {
  const opened: unknown[] = [];
  const installs: unknown[] = [];
  let present = false;
  const m = await mount(<ConnectionsSection
    onOpen={async (input) => {
      opened.push(input);
      if (!present) throw new Error(`Solenta is not installed on ${input.host}. Install it there first.`);
      return { host: input.host, remotePort: 4620, tokenSaved: true };
    }}
    onInstall={async (input) => {
      installs.push(input);
      present = true;
      return { tag: "v0.26.0", missingLibraries: [], aptCommand: null, restartNeeded: false };
    }}
  />);
  await m.type(m.query("[data-connection-host]"), "me@server");
  await m.click(m.query("[data-connection-open]"));
  const install = m.query("[data-connection-install]");
  assert.match(install?.textContent || "", /Install Solenta on me@server/);
  await m.click(install);
  assert.deepEqual(installs, [{ host: "me@server" }]);
  assert.equal(opened.length, 2, "connects again right after a clean install");
  assert.match(m.query("[data-connection-installed]")?.textContent || "", /Installed Solenta v0\.26\.0 on me@server/);
  assert.equal(m.query("[data-connection-install]"), null);
});

it("shows the apt line instead of connecting when libraries are missing", async () => {
  let opens = 0;
  const m = await mount(<ConnectionsSection
    onOpen={async (input) => {
      opens += 1;
      throw new Error(`Solenta is not installed on ${input.host}.`);
    }}
    onInstall={async () => ({
      tag: "v0.26.0",
      missingLibraries: ["libnss3.so", "libgbm.so.1"],
      aptCommand: "sudo apt install libnss3 libgbm1",
      restartNeeded: false,
    })}
  />);
  await m.type(m.query("[data-connection-host]"), "me@server");
  await m.click(m.query("[data-connection-open]"));
  await m.click(m.query("[data-connection-install]"));
  assert.equal(opens, 1, "no connect while libraries are missing");
  const libs = m.query("[data-connection-missing-libs]")?.textContent || "";
  assert.match(libs, /libnss3\.so, libgbm\.so\.1/);
  assert.match(libs, /sudo apt install libnss3 libgbm1/);
});

it("after connecting, lists the host's version and agents, and offers Update on an older Linux host", async () => {
  const installs: unknown[] = [];
  const m = await mount(<ConnectionsSection
    onOpen={async (input) => ({
      host: input.host,
      remotePort: 4620,
      tokenSaved: true,
      localVersion: "0.26.0",
      descriptor: { kind: "solenta", computerId: "linux-desktop", protocol: { min: 1, max: 1 }, runtimeKind: "desktop" },
      remote: {
        version: "0.25.0",
        platform: "linux",
        outdated: true,
        agents: [
          { id: "claude", name: "Claude Code", available: true, auth: "signedIn", account: { email: "me@x.dev", plan: "max" } },
          { id: "codex", name: "Codex", available: true, auth: "signedOut" },
          { id: "grok", name: "Grok", available: false },
        ],
      },
    })}
    onInstall={async (input) => {
      installs.push(input);
      return { tag: "v0.26.0", missingLibraries: [], aptCommand: null, restartNeeded: false };
    }}
  />);
  await m.type(m.query("[data-connection-host]"), "me@server");
  await m.click(m.query("[data-connection-open]"));
  const info = m.query("[data-connection-remote]")?.textContent || "";
  assert.match(info, /me@server runs Solenta 0\.25\.0, older than 0\.26\.0 on this computer/);
  assert.match(m.query('[data-connection-agent="claude"]')?.textContent || "", /Claude Code: Signed in as me@x\.dev · Max/);
  assert.match(m.query('[data-connection-agent="codex"]')?.textContent || "", /Codex: Signed out/);
  assert.match(m.query('[data-connection-agent="grok"]')?.textContent || "", /Grok: Not installed/);
  assert.match(info, /open Settings > Providers in its window/);
  await m.click(m.query("[data-connection-update]"));
  assert.deepEqual(installs, [{ host: "me@server", computerId: "linux-desktop" }]);
});

it("an older Mac host gets a pointer, not an Update button", async () => {
  const m = await mount(<ConnectionsSection
    onOpen={async (input) => ({
      host: input.host, remotePort: 4620, tokenSaved: true, localVersion: "0.26.0",
      remote: { version: "0.25.0", platform: "darwin", outdated: true, agents: [] },
    })}
    onInstall={async () => ({ tag: "", missingLibraries: [], aptCommand: null, restartNeeded: false })}
  />);
  await m.type(m.query("[data-connection-host]"), "me@mac");
  await m.click(m.query("[data-connection-open]"));
  assert.equal(m.query("[data-connection-update]"), null);
  assert.match(m.query("[data-connection-remote]")?.textContent || "", /update on that computer using its own supported installer/);
});

it("shows a connected host in the sidebar and hands main the shown set (#1819)", async () => {
  const pushed: unknown[] = [];
  const m = await mount(<ConnectionsSection
    onOpen={async (input) => ({ host: input.host, remotePort: input.remotePort ?? 4620, tokenSaved: true })}
    onSidebarHosts={async (hosts) => {
      pushed.push(hosts);
      return [];
    }}
    sidebarHosts={[{ key: "user@work:4620", host: "user@work", remotePort: 4620, label: "Work", status: "offline", error: "Cannot find user@work." }]}
  />);
  await m.type(m.query("[data-connection-label]"), "Work");
  await m.type(m.query("[data-connection-host]"), "user@work");
  await m.click(m.query("[data-connection-open]"));
  assert.deepEqual(pushed.at(-1), [{ host: "user@work", remotePort: 4620, label: "Work" }]);
  assert.match(m.container.textContent || "", /offline/);
  assert.match(m.query("[data-connection-host-error]").textContent || "", /Cannot find user@work/);
  const toggle = m.query("[data-connection-sidebar]") as HTMLInputElement;
  assert.equal(toggle.checked, true);
  await m.click(toggle);
  assert.deepEqual(pushed.at(-1), []);
  assert.match(window.localStorage.getItem("coder.remoteConnections") || "", /"inSidebar":false/);
  m.unmount();
});

it("adds a computer by address with a pasted device link, keeping only the address (#1824)", async () => {
  const opened: unknown[] = [];
  const pushed: unknown[] = [];
  const forgot: unknown[] = [];
  const m = await mount(<ConnectionsSection
    onOpen={async (input) => {
      opened.push(input);
      return { host: "mini.tail1234.ts.net", remotePort: 443, url: "https://mini.tail1234.ts.net", tokenSaved: true };
    }}
    onForget={async (input) => { forgot.push(input); }}
    onSidebarHosts={async (hosts) => {
      pushed.push(hosts);
      return [];
    }}
    sidebarHosts={[{ key: "https://mini.tail1234.ts.net", host: "mini.tail1234.ts.net", remotePort: 443, url: "https://mini.tail1234.ts.net", label: "Mini", status: "online", error: null }]}
  />);
  await m.change(m.query("[data-connection-mode]"), "address");
  assert.equal(m.query("[data-connection-host]"), null, "no SSH host field");
  assert.match(m.query('[data-connection-steps="address"]')?.textContent || "", /Full access/);
  await m.type(m.query("[data-connection-label]"), "Mini");
  await m.type(m.query("[data-connection-url]"), "https://mini.tail1234.ts.net/?token=link-secret");
  await m.click(m.query("[data-connection-open]"));
  assert.deepEqual(opened, [{ host: "", url: "https://mini.tail1234.ts.net/?token=link-secret", label: "Mini", token: "", remember: true }]);
  assert.equal((m.query("[data-connection-url]") as HTMLInputElement).value, "https://mini.tail1234.ts.net");
  const saved = window.localStorage.getItem("coder.remoteConnections") || "";
  assert.match(saved, /"url":"https:\/\/mini\.tail1234\.ts\.net"/);
  assert.doesNotMatch(saved, /link-secret/);
  assert.deepEqual(pushed.at(-1), [{ host: "mini.tail1234.ts.net", remotePort: 443, label: "Mini", url: "https://mini.tail1234.ts.net" }]);
  assert.match(m.container.textContent || "", /https:\/\/mini\.tail1234\.ts\.net · token saved · connected/);
  await m.click(m.query('[aria-label="Forget Mini"]'));
  assert.deepEqual(forgot, [{ host: "mini.tail1234.ts.net", remotePort: 443, url: "https://mini.tail1234.ts.net" }]);
  m.unmount();
});

it("checks separately from preparation and offers only supported managed controls", async () => {
  const actions: string[] = [];
  const m = await mount(<ConnectionsSection onManage={async input => {
    actions.push(input.action);
    return { mode: "managed", manager: "systemd-user", installed: input.action !== "status", running: false, sessionLimit: "User service requires linger to survive logout", linger: false };
  }} />);
  await m.type(m.query("[data-connection-host]"), "me@new");
  await m.click(m.query("[data-connection-check]"));
  assert.deepEqual(actions, ["status"]);
  assert.match(m.text(), /Not installed, stopped/);
  await m.click(m.query("[data-connection-prepare]"));
  assert.deepEqual(actions, ["status", "install"]);
  assert.match(m.text(), /Installed, stopped/);
  assert.match(m.text(), /Start server/);
  assert.doesNotMatch(m.text(), /Stop server|Uninstall/);
  await m.change(m.query("[data-connection-mode]"), "address");
  assert.equal(m.query("[data-connection-check]"), null);
  assert.equal(m.query("[data-connection-prepare]"), null);
});

it("saves verified computer identity and sends it on subsequent connections", async () => {
  const calls: unknown[] = [];
  const descriptor = { kind: "solenta" as const, computerId: "computer-one", runtimeKind: "server" as const, protocol: { min: 1 as const, max: 1 as const }, buildSha: "abc123" };
  const m = await mount(<ConnectionsSection onOpen={async input => {
    calls.push(input);
    return { host: input.host, remotePort: 4620, tokenSaved: true, computerId: descriptor.computerId, descriptor };
  }} />);
  await m.type(m.query("[data-connection-host]"), "me@server");
  await m.click(m.query("[data-connection-open]"));
  assert.match(m.text(), /Computer computer-one · build abc123/);
  await m.click(m.query("[data-connection-open]"));
  assert.equal((calls[1] as { computerId: string }).computerId, "computer-one");
  const saved = JSON.parse(window.localStorage.getItem("coder.remoteConnections")!);
  assert.equal(saved[0].descriptor.buildSha, "abc123");
  assert.equal(saved[0].token, undefined);
});

it("allows identity-free compatibility only after an explicit choice", async () => {
  const calls: unknown[] = [];
  const m = await mount(<ConnectionsSection onOpen={async input => {
    calls.push(input);
    return { host: input.host, remotePort: 4620, tokenSaved: false, legacy: true };
  }} />);
  await m.type(m.query("[data-connection-host]"), "old-host");
  await m.click(m.query("[data-connection-legacy]"));
  await m.click(m.query("[data-connection-open]"));
  assert.equal((calls[0] as { allowLegacy: boolean }).allowLegacy, true);
  const saved = JSON.parse(window.localStorage.getItem("coder.remoteConnections")!);
  assert.equal(saved[0].legacy, true);
});

it("offers explicit external preparation without claiming service supervision", async () => {
  const prepared: unknown[] = [];
  const m = await mount(<ConnectionsSection onManage={async input => {
    prepared.push(input);
    return { mode: "external", manager: null, installed: true, running: true, sessionLimit: "Unsupervised; no restart guarantee." };
  }} />);
  await m.type(m.query("[data-connection-host]"), "headless-mac");
  await m.change(m.query("[data-connection-service-mode]"), "external");
  assert.match(m.text(), /no service supervision or guaranteed restart after logout or reboot/);
  await m.click(m.query("[data-connection-prepare]"));
  assert.deepEqual(prepared, [{ host: "headless-mac", remotePort: 4620, serviceMode: "external", action: "install" }]);
  assert.match(m.text(), /externally managed/);
  assert.equal(m.query("[data-connection-prepare]"), null, "preparation must not take over an external process");
  assert.doesNotMatch(m.text(), /Start server|Recent logs/);
});
