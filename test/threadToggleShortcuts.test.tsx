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

// Three idle threads, newest first (buildFlatSidebar's default active
// order) so the eligible settle order is deterministic: t1, t2, t3.
async function bootThree(openId: string) {
  const now = Date.now();
  const threads = [
    // buildFlatSidebar's active order is newest-createdAt-first.
    thread({ id: "t1", title: "first", createdAt: now - 1_000, updatedAt: now - 1_000 }),
    thread({ id: "t2", title: "second", createdAt: now - 2_000, updatedAt: now - 2_000 }),
    thread({ id: "t3", title: "third", createdAt: now - 3_000, updatedAt: now - 3_000 }),
  ];
  const fake = createFakeCoder({
    projects: [project({ id: "p1" })],
    threads,
    details: Object.fromEntries(
      threads.map((t) => [t.id, detail({ thread: t })]),
    ),
  });
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  const m = await mount(<App />);
  await m.flush();
  const title = threads.find((t) => t.id === openId)!.title;
  await m.click(m.query(`button[aria-label="Select thread: ${title}"]`));
  await m.flush();
  return { m, fake };
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

describe("settling the open thread advances selection (#1790)", () => {
  it("⌘⇧A settling the open thread selects the next thread below", async () => {
    const { m, fake } = await bootThree("t1");
    try {
      await inAct(() => press(document.body, "a"));
      await settle(m);
      assert.deepEqual(fake.of("threads.setSettled").at(-1)?.args[0], {
        threadId: "t1",
        override: "settled",
      });
      assert.ok(
        m.query('[data-thread-card="t2"][data-active="true"]'),
        "t2 (next below t1) becomes the open thread",
      );
    } finally {
      m.unmount();
    }
  });

  it("the settle button on the open thread's card selects the next thread below", async () => {
    const { m, fake } = await bootThree("t1");
    try {
      await m.click(m.query('[data-settle-btn="t1"]'));
      await settle(m);
      assert.deepEqual(fake.of("threads.setSettled").at(-1)?.args[0], {
        threadId: "t1",
        override: "settled",
      });
      assert.ok(
        m.query('[data-thread-card="t2"][data-active="true"]'),
        "t2 (next below t1) becomes the open thread",
      );
    } finally {
      m.unmount();
    }
  });

  it("settling the last (oldest) item falls back to the previous one", async () => {
    const { m, fake } = await bootThree("t3");
    try {
      await inAct(() => press(document.body, "a"));
      await settle(m);
      assert.deepEqual(fake.of("threads.setSettled").at(-1)?.args[0], {
        threadId: "t3",
        override: "settled",
      });
      assert.ok(
        m.query('[data-thread-card="t2"][data-active="true"]'),
        "t2 (above t3, the last item) becomes the open thread",
      );
    } finally {
      m.unmount();
    }
  });

  it("settling a different (non-open) thread from the sidebar keeps selection", async () => {
    const { m, fake } = await bootThree("t1");
    try {
      await m.click(m.query('[data-settle-btn="t2"]'));
      await settle(m);
      assert.deepEqual(fake.of("threads.setSettled").at(-1)?.args[0], {
        threadId: "t2",
        override: "settled",
      });
      assert.ok(
        m.query('[data-thread-card="t1"][data-active="true"]'),
        "t1 (originally open) stays selected",
      );
    } finally {
      m.unmount();
    }
  });

  it("undo restores the settled thread as the open selection", async () => {
    const { m, fake } = await bootThree("t1");
    try {
      await inAct(() => press(document.body, "a"));
      await settle(m);
      assert.ok(m.query('[data-thread-card="t2"][data-active="true"]'));
      await m.click(m.byText("Undo"));
      await settle(m);
      const calls = fake.of("threads.setSettled");
      assert.deepEqual(calls.at(-1)?.args[0], {
        threadId: "t1",
        override: null,
      });
      assert.ok(
        m.query('[data-thread-card="t1"][data-active="true"]'),
        "undo re-selects the settled thread",
      );
    } finally {
      m.unmount();
    }
  });
});
