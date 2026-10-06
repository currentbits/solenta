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
import { EMPTY_HISTORY, stepThread, visitThread } from "../src/threadHistory";

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
});
