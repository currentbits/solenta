/**
 * Issue #1211: a consumed image paste must end as a chip or a visible
 * reason. Mounted App/useCoder/Composer over fakeCoder, so the host's
 * attachment:null and a rejected IPC both go through the real save path.
 *
 * Run: node --import=./test/support/render.mjs --test test/pasteImageErrors.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount, type Mounted } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  thread,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import type { AttachmentInfo } from "../src/shared/ipc";

// Node has File but no FileReader; this one reads instantly.
if (typeof FileReader === "undefined") {
  (globalThis as unknown as { FileReader: typeof FileReader }).FileReader = class {
    result: string | null = null;
    onload: (() => void) | null = null;
    readAsDataURL(blob: Blob) {
      this.result = `data:${blob.type};base64,AQ==`;
      this.onload?.();
    }
  } as unknown as typeof FileReader;
}

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

async function paste(m: Mounted, type = "image/png"): Promise<Event> {
  const textarea = m.query("textarea");
  assert.ok(textarea, "selected thread must expose the composer");
  const file = new File([Uint8Array.from([1])], "clip", { type });
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: {
      items: [{ kind: "file", type, getAsFile: () => file }],
      getData: () => "",
    },
  });
  await inAct(() => {
    textarea.dispatchEvent(ev);
  });
  await m.flush();
  return ev;
}

const alertText = (m: Mounted) => m.query('[role="alert"]')?.textContent ?? "";
const chips = (m: Mounted) => m.queryAll('[data-attachment-kind="image"]');

describe("clipboard image paste failures (#1211)", () => {
  it("null and rejected saves show an error, keep the draft, and a good paste recovers", async () => {
    let next: AttachmentInfo | null = null;
    const fail: Record<string, Error> = {};
    const fake = createFakeCoder({
      threads: [thread({ id: "t-paste", title: "paste thread" })],
      saveImage: () => ({ attachment: next }),
      fail,
    });
    const m = await boot(fake);
    await m.type(m.query("textarea"), "keep this draft");

    const ev = await paste(m);
    assert.equal(ev.defaultPrevented, true, "the image paste is consumed");
    assert.equal(fake.of("attachments.saveImage").length, 1);
    assert.equal(chips(m).length, 0, "a null save must not show a chip");
    assert.match(alertText(m), /Couldn't save the pasted image/);
    assert.equal(
      (m.query("textarea") as HTMLTextAreaElement).value,
      "keep this draft",
    );

    fail["attachments.saveImage"] = new Error("Attachments folder is read-only");
    await paste(m);
    assert.equal(fake.of("attachments.saveImage").length, 2);
    assert.equal(chips(m).length, 0, "a rejected save must not show a chip");
    assert.match(
      alertText(m),
      /^Attachments folder is read-only/,
      "a host error reaches the composer verbatim",
    );

    delete fail["attachments.saveImage"];
    next = { kind: "image", path: "/tmp/a/one.png", name: "one.png" };
    await paste(m);
    assert.equal(chips(m).length, 1, "a good paste attaches exactly once");
    assert.equal(m.query('[role="alert"]'), null, "success clears the error");

    next = null;
    await paste(m, "image/heic");
    assert.equal(chips(m).length, 1, "a later failure keeps existing chips");
    assert.match(alertText(m), /Can't attach HEIC images\. Paste a PNG/);
    assert.equal(
      (m.query("textarea") as HTMLTextAreaElement).value,
      "keep this draft",
    );
    m.unmount();
  });
});
