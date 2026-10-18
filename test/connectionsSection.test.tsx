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
  assert.match(m.query("[data-connection-installed]")?.textContent || "", /Installed Solenta v0\.26\.0 in ~\/solenta on me@server/);
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
  assert.match(info, /open Settings > Agents in its window/);
  await m.click(m.query("[data-connection-update]"));
  assert.deepEqual(installs, [{ host: "me@server" }]);
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
  assert.match(m.query("[data-connection-remote]")?.textContent || "", /Update it on that computer/);
});
