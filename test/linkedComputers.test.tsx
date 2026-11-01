/**
 * Settings → Connections → Linked computers (#1832).
 * Run: node --import=./test/support/render.mjs --test test/linkedComputers.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder } from "./support/fakeCoder.ts";
import { LinkedComputersSection } from "../src/components/LinkedComputersSection";

describe("Linked computers (#1832)", () => {
  it("links a computer from its device link and unlinks it", async () => {
    const fake = createFakeCoder();
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const m = await mount(<LinkedComputersSection active />);
    try {
      await m.flush();
      assert.equal(m.query("[data-linked-list]"), null);
      const add = m.query("[data-linked-add]") as HTMLButtonElement;
      assert.equal(add.disabled, true, "nothing to link yet");
      await m.type(m.query("[data-linked-link]") as HTMLInputElement, "https://mac.tailnet.ts.net/?token=abc");
      await m.type(m.query("[data-linked-label]") as HTMLInputElement, "Mac");
      await m.click(add);
      await m.flush();
      const row = m.query('[data-linked-peer="https://mac.tailnet.ts.net"]');
      assert.ok(row);
      assert.match(row!.textContent || "", /Mac.*https:\/\/mac\.tailnet\.ts\.net/);
      assert.equal((m.query("[data-linked-link]") as HTMLInputElement).value, "", "field cleared, token not kept on screen");
      assert.deepEqual(fake.calls.find((c) => c.channel === "app.linkPeer")?.args, [{ link: "https://mac.tailnet.ts.net/?token=abc", label: "Mac" }]);

      await m.click(m.query('[data-linked-unlink="https://mac.tailnet.ts.net"]') as HTMLElement);
      await m.flush();
      assert.equal(m.query("[data-linked-list]"), null);
    } finally {
      m.unmount();
    }
  });
});
