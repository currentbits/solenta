/**
 * Back/forward thread history (#1506 H2).
 * Run: npm run test:renderer -- --test-name-pattern="thread history"
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
import { setMacPlatformForTests } from "../src/keybindings";
import { canStep, EMPTY_HISTORY, stepThread, visitThread } from "../src/threadHistory";

setMacPlatformForTests(true);

describe("thread history stack", () => {
  const all = () => true;

  it("steps back and forward and drops the forward tail on a new visit", () => {
    let h = ["a", "b", "c"].reduce(visitThread, EMPTY_HISTORY);
    const back = stepThread(h, -1, all)!;
    assert.equal(back.id, "b");
    h = visitThread(back.history, "b");
    assert.equal(h, back.history, "re-visiting the current entry is a no-op");
    assert.equal(stepThread(h, 1, all)?.id, "c");
    h = visitThread(h, "d");
    assert.deepEqual(h.stack, ["a", "b", "d"]);
    assert.equal(stepThread(h, 1, all), null);
  });

  it("skips deleted threads and repeats of the current one", () => {
    const h = ["a", "b", "a", "c"].reduce(visitThread, EMPTY_HISTORY);
    assert.equal(stepThread(h, -1, (id) => id !== "a")?.id, "b");
    assert.equal(stepThread(h, -1, (id) => id === "c"), null);
  });

  it("caps the stack", () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < 80; i++) h = visitThread(h, `t${i}`);
    assert.equal(h.stack.length, 50);
    assert.equal(h.stack[49], "t79");
  });

  it("canStep reports whether a direction has anywhere live to land (#1752)", () => {
    const h = ["a", "b", "c"].reduce(visitThread, EMPTY_HISTORY);
    assert.equal(canStep(h, -1, all), true);
    assert.equal(canStep(h, 1, all), false, "already at the tip");
    assert.equal(canStep(h, -1, (id) => id !== "a" && id !== "b"), false);
  });
});

describe("thread history in the app", () => {
  it("⌘[ / ⌘] and the mouse side buttons walk opened threads", async () => {
    const threads = ["a", "b", "c"].map((id, i) =>
      thread({ id, title: `thread ${id}`, updatedAt: Date.now() - i }),
    );
    const fake = createFakeCoder({
      projects: [project()],
      threads,
      details: Object.fromEntries(threads.map((t) => [t.id, detail({ thread: t })])),
    });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const m = await mount(<App />);
    const active = () =>
      m.query("[data-thread-card][data-active=true]")?.getAttribute("data-thread-card");
    const open = async (id: string) => {
      await m.click(m.query(`[data-thread-card="${id}"]`)!.querySelector("button"));
      await m.flush();
    };
    const fire = async (ev: Event) => {
      await inAct(() => {
        (document.activeElement as HTMLElement | null)?.blur?.();
        window.dispatchEvent(ev);
      });
      await m.flush();
    };
    const key = (k: string) =>
      new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true, cancelable: true });
    try {
      await m.flush();
      await open("a");
      await open("b");
      await open("c");
      assert.equal(active(), "c");
      await fire(key("["));
      assert.equal(active(), "b");
      await fire(new MouseEvent("mouseup", { button: 3, bubbles: true, cancelable: true }));
      assert.equal(active(), "a");
      await fire(key("]"));
      assert.equal(active(), "b");
      await fire(new MouseEvent("mouseup", { button: 4, bubbles: true, cancelable: true }));
      assert.equal(active(), "c");
    } finally {
      m.unmount();
    }
  });

  it("sidebar Back/Forward buttons and a trackpad swipe over the thread pane also walk the stack (#1752)", async () => {
    const threads = ["a", "b", "c"].map((id, i) =>
      thread({ id, title: `thread ${id}`, updatedAt: Date.now() - i }),
    );
    const fake = createFakeCoder({
      projects: [project()],
      threads,
      details: Object.fromEntries(threads.map((t) => [t.id, detail({ thread: t })])),
    });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const m = await mount(<App />);
    const active = () =>
      m.query("[data-thread-card][data-active=true]")?.getAttribute("data-thread-card");
    const open = async (id: string) => {
      await m.click(m.query(`[data-thread-card="${id}"]`)!.querySelector("button"));
      await m.flush();
    };
    const back = () => m.query("[data-history-back]") as HTMLButtonElement;
    const forward = () => m.query("[data-history-forward]") as HTMLButtonElement;
    // Several small wheel events, each inside the 150ms reset gap, so they
    // build up into one gesture the way a real trackpad delivers them.
    const swipe = async (deltaX: number) => {
      const pane = m.query('[data-pane="thread"]')!;
      for (const chunk of [deltaX * 0.4, deltaX * 0.4, deltaX * 0.4]) {
        await inAct(() => {
          pane.dispatchEvent(
            new window.WheelEvent("wheel", {
              deltaX: chunk,
              deltaY: 0,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        await m.flush();
      }
    };
    try {
      await m.flush();
      await open("a");
      await open("b");
      await open("c");
      assert.equal(back().disabled, false);
      assert.equal(forward().disabled, true, "nothing ahead of the tip");
      await m.click(back());
      assert.equal(active(), "b");
      assert.equal(forward().disabled, false);
      await m.click(back());
      assert.equal(active(), "a");
      assert.equal(back().disabled, true, "nothing further back than the first visit");
      await m.click(forward());
      assert.equal(active(), "b");
      await swipe(-150); // swipe right: back
      assert.equal(active(), "a");
      // A real gap longer than SWIPE_RESET_MS: otherwise this reads as more
      // of the gesture that already committed, same as a real trackpad.
      await new Promise((r) => setTimeout(r, 200));
      await swipe(150); // swipe left: forward
      assert.equal(active(), "b");
    } finally {
      m.unmount();
    }
  });
});
