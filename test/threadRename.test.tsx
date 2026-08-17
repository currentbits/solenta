/**
 * Issue #139: rename a thread from the header overflow menu.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount } from "./support/dom";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
  detail,
} from "./support/fakeCoder";
import App from "../src/App";

const FRESH = Date.now();

async function boot(fake: ReturnType<typeof createFakeCoder>) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

async function settle(m: Awaited<ReturnType<typeof mount>>) {
  await m.flush();
  await inAct(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await m.flush();
}

describe("thread rename (issue #139)", () => {
  it("header Rename thread commits on Enter and skips an empty title", async () => {
    const tOpen = thread({
      id: "t-rename",
      projectId: "p1",
      title: "old title",
      updatedAt: FRESH,
    });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tOpen],
      details: {
        "t-rename": detail({ thread: tOpen }),
      },
    });
    const m = await boot(fake);
    try {
      await m.flush();

      const menuBtn = m.query("[aria-label='Thread actions']");
      assert.ok(menuBtn, "overflow menu button");
      await m.click(menuBtn);
      const item = m.query("[data-rename-thread]");
      assert.ok(item, "Rename thread menu item");
      assert.equal((item!.textContent || "").trim(), "Rename thread");
      await m.click(item);

      const input = m.query("[data-thread-title-input]") as HTMLInputElement | null;
      assert.ok(input, "inline title input after Rename thread");
      assert.equal(input!.value, "old title");

      await m.type(input, "new title");
      await m.press(input, "Enter");
      await settle(m);

      const calls = fake.of("threads.rename");
      assert.equal(calls.length, 1, "rename must fire once");
      assert.deepEqual(calls[0]!.args[0], {
        threadId: "t-rename",
        title: "new title",
      });

      await m.click(m.query("[aria-label='Thread actions']"));
      await m.click(m.query("[data-rename-thread]"));
      const again = m.query(
        "[data-thread-title-input]",
      ) as HTMLInputElement | null;
      assert.ok(again, "inline title input reopens");
      await m.type(again, "");
      await m.press(again, "Enter");
      await settle(m);

      assert.equal(
        fake.of("threads.rename").length,
        1,
        "empty title must not fire another rename",
      );
    } finally {
      m.unmount();
    }
  });
});
