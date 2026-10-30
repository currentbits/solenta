/**
 * Keyboard shortcuts: toggle pin (⌘⇧P) and toggle settle/restore (⌘⇧A) for
 * the open thread (#1770). Both bindings use mod, so they still fire while a
 * text field is focused; only an open dialog blocks them.
 *
 * Run: npm run test:renderer -- --test-name-pattern="toggle"
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount, type Mounted } from "./support/dom.ts";
import {
  createFakeCoder,
  detail,
  installFakeCoder,
  project,
  thread,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import { setMacPlatformForTests } from "../src/keybindings";

setMacPlatformForTests(true);

async function boot(target = thread({ id: "t1", title: "target" })) {
  const fake = createFakeCoder({
    projects: [project({ id: "p1" })],
    threads: [target],
    details: { [target.id]: detail({ thread: target }) },
  });
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  const m = await mount(<App />);
  await m.flush();
  await m.click(m.query(`[data-thread-card="${target.id}"]`));
  await m.flush();
  return { m, fake, target };
}

async function settle(m: Mounted) {
  await m.flush();
  await inAct(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
  await m.flush();
}

function press(
  target: EventTarget,
  key: string,
  mods: { metaKey?: boolean; shiftKey?: boolean } = { metaKey: true, shiftKey: true },
) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
  );
}

describe("thread.togglePin / thread.toggleSettle shortcuts", () => {
  it("⌘⇧P pins the open thread", async () => {
    const { m, fake, target } = await boot();
    try {
      await inAct(() => press(document.body, "p"));
      await settle(m);
      const calls = fake.of("threads.setPinned");
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.args[0], { threadId: target.id, pinned: true });
    } finally {
      m.unmount();
    }
  });

  it("⌘⇧A settles the open thread, with the usual undo toast", async () => {
    const { m, fake, target } = await boot();
    try {
      await inAct(() => press(document.body, "a"));
      await settle(m);
      const calls = fake.of("threads.setSettled");
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.args[0], {
        threadId: target.id,
        override: "settled",
      });
      assert.match(
        document.querySelector('[data-toast="archive"]')?.textContent ?? "",
        /Settled/,
      );
    } finally {
      m.unmount();
    }
  });

  it("⌘⇧A restores an already-settled thread", async () => {
    const settled = thread({
      id: "t2",
      title: "settled already",
      settledOverride: "settled",
    });
    const { m, fake } = await boot(settled);
    try {
      await inAct(() => press(document.body, "a"));
      await settle(m);
      const calls = fake.of("threads.setSettled");
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.args[0], { threadId: "t2", override: "active" });
    } finally {
      m.unmount();
    }
  });

  it("fires even while a text field is focused, because it's a mod chord", async () => {
    const { m, fake } = await boot();
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    try {
      input.focus();
      await inAct(() => press(input, "p"));
      await settle(m);
      assert.equal(fake.of("threads.setPinned").length, 1);
    } finally {
      input.remove();
      m.unmount();
    }
  });

  it("does nothing when no thread is open", async () => {
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [],
    });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const m = await mount(<App />);
    await m.flush();
    try {
      await inAct(() => press(document.body, "p"));
      await settle(m);
      assert.equal(fake.of("threads.setPinned").length, 0);
    } finally {
      m.unmount();
    }
  });
});
