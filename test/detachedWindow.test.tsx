/**
 * Detached thread windows (#519): the main window offers "Open in new
 * window", and a `?thread=` window renders only that thread.
 *
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/detachedWindow.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  thread,
  detail,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import { detachedWindowTitle, droppedOutsideWindow } from "../src/detachedWindow";

async function boot(fake: ReturnType<typeof createFakeCoder>, detached: string[] = []) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  (fake.api as { windows?: unknown }).windows = {
    detachThread: async (id: string) => void detached.push(id),
  };
  shell.unmount();
  return mount(<App />);
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("detached thread windows (#519)", () => {
  it("main window: the card menu opens the thread in a new window", async () => {
    const fake = createFakeCoder({ threads: [thread({ id: "ta", title: "alpha" })] });
    const detached: string[] = [];
    const m = await boot(fake, detached);
    try {
      await m.click(m.query('[data-more-btn="ta"]'));
      await m.flush();
      const item = document.querySelector('[data-detach-thread="ta"]');
      assert.ok(item, "Open in new window must be in the card menu");
      await m.click(item as HTMLElement);
      await m.flush();
      assert.deepEqual(detached, ["ta"]);
    } finally {
      m.unmount();
    }
  });

  it("?thread= window: no sidebar, locked to that thread, attention in the title", async () => {
    window.history.replaceState(null, "", "/?thread=tb");
    const tb = thread({ id: "tb", title: "beta", awaitingInput: true, status: "working" });
    const fake = createFakeCoder({
      // ta is what the main window's boot fallback would pick.
      threads: [thread({ id: "ta", title: "alpha", status: "working" }), tb],
      details: { tb: detail({ thread: tb }) },
    });
    const detached: string[] = [];
    const m = await boot(fake, detached);
    try {
      await m.flush();
      assert.equal(m.query("[data-thread-card]"), null, "sidebar must not render");
      assert.equal(m.query("[data-sidebar-show]"), null, "no Show sidebar button");
      const gets = fake.of("threads.get");
      assert.equal(gets.at(-1)?.args[0], "tb");
      assert.equal(document.title, "● beta");
    } finally {
      m.unmount();
    }
  });

  it("drag-out only counts drops outside the window that nothing accepted", () => {
    const at = (x: number, y: number, dropEffect = "none") => ({
      clientX: x,
      clientY: y,
      dataTransfer: { dropEffect },
    });
    assert.equal(droppedOutsideWindow(at(-5, 10)), true);
    assert.equal(droppedOutsideWindow(at(10, window.innerHeight + 1)), true);
    assert.equal(droppedOutsideWindow(at(10, 10)), false);
    assert.equal(droppedOutsideWindow(at(-5, 10, "copy")), false);
  });

  it("title falls back cleanly", () => {
    assert.equal(detachedWindowTitle(undefined), "Solenta");
    assert.equal(detachedWindowTitle({ title: "x" }), "x");
    assert.equal(detachedWindowTitle({ title: "x", pendingSecret: null, pendingQuestion: null }), "x");
  });
});
