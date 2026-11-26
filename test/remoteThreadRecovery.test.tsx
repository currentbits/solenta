import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder, detail, project, thread } from "./support/fakeCoder.ts";
import App from "../src/App";
import { captureComposerDraft, resetComposerSession } from "../src/composerSession";
import { STORAGE_KEY } from "../src/remoteHosts";
import type { SidebarHostStatus } from "../src/shared/ipc";

const HOST: SidebarHostStatus = { key: "me@box:4620", label: "Box", host: "me@box", remotePort: 4620, status: "online", error: null };
afterEach(resetComposerSession);

async function boot(options: { initiallyOffline?: boolean; reconnectFails?: boolean; delayedConnection?: boolean } = {}) {
  const remote = thread({ id: "remote-recovery", projectId: "rp", title: "Remote recovery", host: HOST });
  const local = thread({ id: "local-recovery", projectId: "lp", title: "Local recovery" });
  const fake = createFakeCoder({
    projects: [project({ id: "rp", host: HOST }), project({ id: "lp" })],
    threads: [remote, local],
    details: {
      [remote.id]: detail({ thread: remote, messages: [{ id: "saved", role: "user", text: "Previously sent remote request", createdAt: Date.now() }] }),
      [local.id]: detail({ thread: local }),
    },
  });
  let status: SidebarHostStatus = options.initiallyOffline ? { ...HOST, status: "offline", error: "Network unreachable" } : HOST;
  let publishHosts: (hosts: SidebarHostStatus[]) => void = () => {};
  const subscribe = fake.api.on;
  fake.api.on = ((channel, callback) => {
    if (channel === "hosts:changed") {
      publishHosts = callback as typeof publishHosts;
      return () => { publishHosts = () => {}; };
    }
    return subscribe(channel, callback);
  }) as typeof fake.api.on;
  const get = fake.api.threads.get;
  fake.api.threads.get = async (id, opts) => {
    if (id === remote.id && status.status !== "online") throw new Error("Box is offline");
    return get(id, opts);
  };
  const reconnectInputs: unknown[] = [];
  fake.api.app.setSidebarHosts = async (hosts) => {
    reconnectInputs.push(hosts);
    if (reconnectInputs.length > 1) {
      if (options.reconnectFails) throw new Error("Could not open the connection");
      status = options.delayedConnection ? { ...HOST, status: "connecting" } : HOST;
      publishHosts([status]);
    }
    return [status];
  };
  const shell = await mount(<div />);
  installFakeCoder(fake);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: "box", host: "me@box", remotePort: 4620, label: "Box", inSidebar: true }]));
  shell.unmount();
  const m = await mount(<App />);
  const select = async (title: string) => { await m.click(m.query(`button[aria-label^="Select thread: ${title}"]`)); await m.flush(); };
  await select("Remote recovery");
  return { m, fake, select, reconnectInputs,
    finishConnecting: async () => {
      status = HOST;
      await inAct(() => publishHosts([status]));
      await m.flush();
    },
    disconnect: async () => {
      status = { ...HOST, status: "offline", error: "Network unreachable" };
      await inAct(() => publishHosts([status]));
      await m.flush();
    },
  };
}

describe("remote thread connection recovery", () => {
  it("names its computer, preserves an editable draft offline and reconnects without auto-sending", async () => {
    const { m, fake, disconnect, reconnectInputs } = await boot();
    try {
      assert.match(m.query("[data-thread-computer]")?.textContent ?? "", /Box.*Connected/);
      await m.type(m.query("textarea"), "finish this later");
      await disconnect();
      assert.match(m.text(), /Previously sent remote request/);
      assert.match(m.query("[data-thread-computer]")?.textContent ?? "", /Disconnected/);
      assert.equal((m.query("[data-composer-send]") as HTMLButtonElement).disabled, true);
      const input = m.query("textarea") as HTMLTextAreaElement;
      assert.equal(input.disabled, false);
      await m.type(input, "finish this when reconnected");
      for (const mods of [{ metaKey: true }, { altKey: true }, { metaKey: true, altKey: true }]) await m.press(input, "Enter", mods);
      assert.equal(fake.of("runs.start").length, 0);
      assert.equal(captureComposerDraft("remote-recovery").text, "finish this when reconnected");
      await m.click(m.query("[data-thread-reconnect]"));
      await m.flush();
      assert.deepEqual(reconnectInputs.at(-1), [{ host: "me@box", remotePort: 4620, label: "Box" }]);
      assert.match(m.query("[data-thread-computer]")?.textContent ?? "", /Connected/);
      assert.equal((m.query("[data-composer-send]") as HTMLButtonElement).disabled, false);
      assert.equal(fake.of("runs.start").length, 0, "reconnection must not send the saved draft");
      assert.equal((m.query("textarea") as HTMLTextAreaElement).value, "finish this when reconnected");
    } finally { m.unmount(); }
  });

  it("keeps the cached remote transcript when reopening it offline and does not lock local threads", async () => {
    const { m, select, disconnect } = await boot();
    try {
      await m.type(m.query("textarea"), "remote draft");
      await select("Local recovery");
      await disconnect();
      assert.equal(m.query("[data-thread-computer]"), null);
      await m.type(m.query("textarea"), "local request");
      assert.equal((m.query("[data-composer-send]") as HTMLButtonElement).disabled, false);
      await select("Remote recovery");
      assert.match(m.text(), /Previously sent remote request/);
      assert.equal((m.query("textarea") as HTMLTextAreaElement).value, "remote draft");
      assert.equal((m.query("[data-composer-send]") as HTMLButtonElement).disabled, true);
      await m.click(m.query("[data-thread-reconnect]"));
      await m.flush();
      assert.equal((m.query("[data-composer-send]") as HTMLButtonElement).disabled, false);
    } finally { m.unmount(); }
  });

  it("keeps sending blocked until a failed transcript refresh actually succeeds", async () => {
    const { m, fake, select, disconnect } = await boot();
    try {
      await m.type(m.query("textarea"), "wait for fresh state");
      await select("Local recovery");
      await disconnect();
      await select("Remote recovery");
      const get = fake.api.threads.get;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      fake.api.threads.get = async (id, opts) => { await pending; return get(id, opts); };
      await m.click(m.query("[data-thread-reconnect]"));
      assert.equal((m.query("[data-composer-send]") as HTMLButtonElement).disabled, true);
      await inAct(async () => { release(); await pending; });
      await m.flush();
      assert.equal((m.query("[data-composer-send]") as HTMLButtonElement).disabled, false);
      assert.equal((m.query("textarea") as HTMLTextAreaElement).value, "wait for fresh state");
      assert.equal(fake.of("runs.start").length, 0);
    } finally { m.unmount(); }
  });

  it("does not execute shell commands while disconnected", async () => {
    const { m, fake, disconnect } = await boot();
    try {
      await disconnect();
      await m.type(m.query("textarea"), "!pwd");
      await m.press(m.query("textarea"), "Enter", { metaKey: true });
      assert.equal(fake.calls.some((call) => /shell.*run|runs.start/i.test(call.channel)), false);
      assert.equal((m.query("textarea") as HTMLTextAreaElement).value, "!pwd");
    } finally { m.unmount(); }
  });

  it("offers connection recovery when no transcript has loaded", async () => {
    const { m } = await boot({ initiallyOffline: true });
    try {
      assert.ok(m.query("[data-thread-reconnect]"));
      assert.match(m.text(), /Waiting for Box/);
      await m.click(m.query("[data-thread-connections]"));
      assert.ok(m.query('[role="dialog"]'));
      assert.match(m.text(), /Connections/);
    } finally { m.unmount(); }
  });

  it("loads an uncached thread after the asynchronous connection succeeds", async () => {
    const { m, finishConnecting } = await boot({ initiallyOffline: true, delayedConnection: true });
    try {
      assert.equal(m.query("textarea"), null);
      await m.click(m.query("[data-thread-reconnect]"));
      assert.match(m.query("[data-thread-computer]")?.textContent ?? "", /Connecting/);
      assert.equal((m.query("[data-thread-reconnect]") as HTMLButtonElement).disabled, true);
      await finishConnecting();
      assert.match(m.text(), /Previously sent remote request/);
      assert.ok(m.query("textarea"));
      assert.match(m.query("[data-thread-computer]")?.textContent ?? "", /Connected/);
    } finally { m.unmount(); }
  });

  it("shows reconnect failures inline without discarding the draft", async () => {
    const { m, disconnect } = await boot({ reconnectFails: true });
    try {
      await m.type(m.query("textarea"), "preserve this");
      await disconnect();
      await m.click(m.query("[data-thread-reconnect]"));
      assert.match(m.query("[data-thread-computer]")?.textContent ?? "", /Could not open the connection/);
      assert.equal((m.query("textarea") as HTMLTextAreaElement).value, "preserve this");
    } finally { m.unmount(); }
  });
});
