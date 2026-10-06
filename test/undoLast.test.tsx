/**
 * ⌘Z undo for settle / snooze / archive (#1506 H2).
 * Run: npm run test:renderer -- --test-name-pattern="undo"
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import {
  createFakeCoder,
  detail,
  installFakeCoder,
  project,
  thread,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import { useUndoLast } from "../src/app/useUndoLast";
import { setMacPlatformForTests } from "../src/keybindings";

setMacPlatformForTests(true);

async function bootTwo() {
  const tOpen = thread({ id: "t-open", title: "already open", updatedAt: Date.now() + 200 });
  const tMid = thread({ id: "t-mid", title: "act on me", updatedAt: Date.now() + 50 });
  const fake = createFakeCoder({
    projects: [project({ id: "p1" })],
    threads: [tOpen, tMid],
    details: { "t-open": detail({ thread: tOpen }), "t-mid": detail({ thread: tMid }) },
  });
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  const m = await mount(<App />);
  await m.flush();
  return { m, fake };
}

async function settle(m: Awaited<ReturnType<typeof mount>>) {
  await m.flush();
  await inAct(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
  await m.flush();
}

async function pressUndo(m: Awaited<ReturnType<typeof mount>>, target: EventTarget = document.body) {
  await inAct(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }),
    );
  });
  await settle(m);
}

const toastText = () => document.querySelector('[data-toast="archive"]')?.textContent ?? "";

describe("undo the last settle / snooze / archive", () => {
  it("⌘Z reverses a snooze, but never from inside a text field", async () => {
    // Snooze presets depend on the hour; pin the clock like pinSnooze does.
    const realNow = Date.now;
    const frozen = new Date(2024, 5, 15, 14, 0, 0, 0).getTime();
    Date.now = () => frozen;
    const { m, fake } = await bootTwo();
    try {
      await m.click(m.query('[data-snooze-btn="t-mid"]'));
      await m.click(document.querySelector('[data-snooze-preset="evening"]'));
      await settle(m);
      assert.equal(fake.of("threads.setSnoozed").length, 1);
      assert.match(toastText(), /Snoozed/);

      const input = document.createElement("textarea");
      document.body.appendChild(input);
      await pressUndo(m, input);
      input.remove();
      assert.equal(fake.of("threads.setSnoozed").length, 1, "text fields keep ⌘Z");

      await pressUndo(m);
      const calls = fake.of("threads.setSnoozed");
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1]!.args[0], { threadId: "t-mid", until: null });
      assert.equal(toastText(), "", "toast closes after undo");

      await pressUndo(m);
      assert.equal(fake.of("threads.setSnoozed").length, 2, "one undo per action");
    } finally {
      m.unmount();
      Date.now = realNow;
    }
  });

  it("the toast's Undo restores the previous settle override", async () => {
    const { m, fake } = await bootTwo();
    try {
      await m.click(m.query('[data-settle-btn="t-mid"]'));
      await settle(m);
      assert.match(toastText(), /Settled/);
      await m.click(m.byText("Undo"));
      await settle(m);
      const calls = fake.of("threads.setSettled");
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1]!.args[0], { threadId: "t-mid", override: null });
    } finally {
      m.unmount();
    }
  });
});

describe("undo slot", () => {
  it("joins a burst into one entry and reverses all of it", async () => {
    const reversed: string[] = [];
    let api: ReturnType<typeof useUndoLast> | null = null;
    function Host() {
      api = useUndoLast();
      return <span data-msg="">{api.undoMessage}</span>;
    }
    const m = await mount(<Host />);
    await inAct(() => {
      api!.offerUndo("Settled", () => reversed.push("a"));
      api!.offerUndo("Settled", () => reversed.push("b"));
    });
    assert.equal(m.query("[data-msg]")?.textContent, "2 settled");
    await inAct(() => {
      api!.offerUndo("Snoozed", () => reversed.push("c"));
    });
    assert.equal(m.query("[data-msg]")?.textContent, "Snoozed", "a new verb replaces the slot");
    await inAct(async () => {
      assert.equal(await api!.runUndo(), true);
    });
    assert.deepEqual(reversed, ["c"]);
    await inAct(async () => {
      assert.equal(await api!.runUndo(), false);
    });
    m.unmount();
  });
});
