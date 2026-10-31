/**
 * Issue #1794: right-click a chat attachment chip for "Open" / Reveal in
 * Finder, the same shell:openPath / shell:reveal IPCs the Changes panel's
 * file-row menu already uses (src/components/thread/ChangesPanel.tsx).
 * Kept out of threadView.test.tsx, which sits at the 20s per-file cap on
 * Windows CI (see messageForkFrom.test.tsx).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { inAct, mount, unmountAll, type Mounted } from "./support/dom.ts";
import { MessageBlock } from "../src/components/thread/messages";
import type { ChatMessage } from "../src/shared/ipc";

afterEach(() => unmountAll());

const withAttachment: ChatMessage = {
  id: "u1",
  role: "user",
  text: "see this file",
  createdAt: 10,
  runId: null,
  attachments: [
    { kind: "file", path: "/Users/t/project/report.pdf", name: "report.pdf" },
  ],
};

async function withFakeShell<T>(
  run: (calls: {
    openPath: Array<{ threadId: string; path: string }>;
    reveal: Array<{ threadId: string; path: string }>;
  }) => Promise<T>,
): Promise<T> {
  // jsdom's `window` only exists once something has mounted (dom.ts), so
  // mount and discard a throwaway element first (same as changesPanel.test.tsx).
  const warmup = await mount(<div />);
  warmup.unmount();
  const prev = (window as unknown as { coder?: unknown }).coder;
  const calls = {
    openPath: [] as Array<{ threadId: string; path: string }>,
    reveal: [] as Array<{ threadId: string; path: string }>,
  };
  (window as unknown as { coder: unknown }).coder = {
    shell: {
      openPath: async (input: { threadId: string; path: string }) => {
        calls.openPath.push(input);
      },
      reveal: async (input: { threadId: string; path: string }) => {
        calls.reveal.push(input);
      },
    },
  };
  try {
    return await run(calls);
  } finally {
    (window as unknown as { coder?: unknown }).coder = prev;
  }
}

async function rightClick(view: Mounted, el: Element) {
  await inAct(() => {
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      }),
    );
  });
  await view.flush();
}

describe("attachment chip context menu (#1794)", () => {
  it("Open calls shell.openPath with the attachment's absolute path", async () => {
    await withFakeShell(async (calls) => {
      const view = await mount(
        <MessageBlock
          message={withAttachment}
          autoExpandTool={false}
          threadId="t1"
        />,
      );
      const chip = view.query('[data-attachment-kind="file"]');
      assert.ok(chip, "attachment chip rendered");
      await rightClick(view, chip!);
      const open = document.querySelector(
        "[data-attachment-open]",
      ) as HTMLElement | null;
      assert.ok(open, "Open item present");
      await view.click(open);
      await view.flush();
      assert.deepEqual(calls.openPath, [
        { threadId: "t1", path: "/Users/t/project/report.pdf" },
      ]);
      assert.equal(calls.reveal.length, 0);
    });
  });

  it("Reveal calls shell.reveal with the attachment's absolute path", async () => {
    await withFakeShell(async (calls) => {
      const view = await mount(
        <MessageBlock
          message={withAttachment}
          autoExpandTool={false}
          threadId="t1"
        />,
      );
      const chip = view.query('[data-attachment-kind="file"]');
      assert.ok(chip);
      await rightClick(view, chip!);
      const reveal = document.querySelector(
        "[data-attachment-reveal]",
      ) as HTMLElement | null;
      assert.ok(reveal, "Reveal item present");
      await view.click(reveal);
      await view.flush();
      assert.deepEqual(calls.reveal, [
        { threadId: "t1", path: "/Users/t/project/report.pdf" },
      ]);
      assert.equal(calls.openPath.length, 0);
    });
  });

  it("does nothing without a threadId", async () => {
    await withFakeShell(async (calls) => {
      const view = await mount(
        <MessageBlock message={withAttachment} autoExpandTool={false} />,
      );
      const chip = view.query('[data-attachment-kind="file"]');
      assert.ok(chip);
      await rightClick(view, chip!);
      assert.equal(document.querySelector("[data-context-menu]"), null);
      assert.equal(calls.openPath.length, 0);
      assert.equal(calls.reveal.length, 0);
    });
  });
});

/** Stub fetch + ClipboardItem + navigator.clipboard.write (issue #1801). */
function withFakeImageClipboard<T>(
  run: (calls: { fetched: string[]; copied: unknown[] }) => Promise<T>,
): Promise<T> {
  const calls = { fetched: [] as string[], copied: [] as unknown[] };
  const prevFetch = globalThis.fetch;
  const prevClipboardItem = (globalThis as { ClipboardItem?: unknown })
    .ClipboardItem;
  const prevClipboard = (navigator as { clipboard?: unknown }).clipboard;
  (globalThis as { fetch: typeof fetch }).fetch = (async (src: string) => {
    calls.fetched.push(src);
    return { ok: true, blob: async () => ({ type: "image/png" }) };
  }) as typeof fetch;
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = class {
    constructor(public data: unknown) {}
  };
  Object.defineProperty(navigator, "clipboard", {
    value: {
      write: async (items: unknown[]) => {
        calls.copied.push(...items);
      },
    },
    configurable: true,
  });
  return run(calls).finally(() => {
    globalThis.fetch = prevFetch;
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem =
      prevClipboardItem;
    Object.defineProperty(navigator, "clipboard", {
      value: prevClipboard,
      configurable: true,
    });
  });
}

const withImageAttachment: ChatMessage = {
  id: "u2",
  role: "user",
  text: "see this screenshot",
  createdAt: 10,
  runId: null,
  attachments: [
    { kind: "image", path: "/Users/t/project/shot.png", name: "shot.png" },
  ],
};

describe("attachment chip Copy Image (#1801)", () => {
  it("an image chip offers Copy Image alongside Open/Reveal and copies the resolved thumb", async () => {
    await withFakeShell(async () => {
      await withFakeImageClipboard(async (clip) => {
        const dataUrl = "data:image/png;base64,ZZZZ";
        const view = await mount(
          <MessageBlock
            message={withImageAttachment}
            autoExpandTool={false}
            threadId="t1"
            onLoadAttachmentImage={async () => dataUrl}
          />,
        );
        await view.flush();
        const chip = view.query('[data-attachment-kind="image"]');
        assert.ok(chip, "image chip rendered");
        await rightClick(view, chip!);
        const copyItem = document.querySelector(
          "[data-copy-image]",
        ) as HTMLElement | null;
        assert.ok(copyItem, "Copy Image present alongside Open/Reveal");
        assert.ok(
          document.querySelector("[data-attachment-open]"),
          "Open still present",
        );
        await view.click(copyItem);
        await view.flush();
        assert.deepEqual(clip.fetched, [dataUrl]);
        assert.equal(clip.copied.length, 1);
      });
    });
  });

  it("no Copy Image on a non-image chip", async () => {
    await withFakeShell(async () => {
      const view = await mount(
        <MessageBlock
          message={withAttachment}
          autoExpandTool={false}
          threadId="t1"
        />,
      );
      const chip = view.query('[data-attachment-kind="file"]');
      await rightClick(view, chip!);
      assert.equal(document.querySelector("[data-copy-image]"), null);
    });
  });
});
