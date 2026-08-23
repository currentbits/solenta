/**
 * Browser pane: local URL bar, screenshot-to-composer, empty state.
 *
 * Run: node --import=./test/support/render.mjs --test test/browserPane.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import { BrowserPane } from "../src/components/BrowserPane";
import type { CoderApi, PreviewSnapshot } from "../src/shared/ipc";

afterEach(unmountAll);

const SNAP: PreviewSnapshot = {
  url: "http://localhost:5173/",
  title: "app",
  canGoBack: false,
  canGoForward: false,
};

function fakePreview(over: Partial<CoderApi["preview"]> = {}): CoderApi["preview"] {
  const calls: string[] = [];
  return {
    bind: async () => {
      calls.push("bind");
      return { url: "", title: "", canGoBack: false, canGoForward: false };
    },
    unbind: async () => ({ ok: true }),
    navigate: async (input) => {
      calls.push(`navigate:${input.url}`);
      return { ...SNAP, url: input.url };
    },
    reload: async () => SNAP,
    goBack: async () => SNAP,
    goForward: async () => SNAP,
    info: async () => SNAP,
    screenshot: async () => ({ ...SNAP, dataUrl: "data:image/png;base64,aaa" }),
    click: async () => SNAP,
    type: async () => SNAP,
    ...over,
    // test-only
    calls,
  } as CoderApi["preview"] & { calls: string[] };
}

describe("BrowserPane (issue #155)", () => {
  it("shows an empty state until a local URL is loaded", async () => {
    const m = await mount(<BrowserPane threadId="t1" />);
    assert.ok(m.query("[data-browser-pane]"));
    assert.ok(m.query("[data-browser-empty]"));
    assert.match(
      m.query("[data-browser-empty]")!.textContent || "",
      /dev server/,
    );
    m.unmount();
  });

  it("rejects a non-loopback URL without calling navigate", async () => {
    const preview = fakePreview();
    const m = await mount(<BrowserPane threadId="t1" preview={preview} />);
    const input = m.query("[data-browser-url]") as HTMLInputElement;
    await m.type(input, "https://github.com/currentbits/solenta");
    await m.click(m.query("[data-browser-go]"));
    await m.flush();
    assert.ok(m.query("[data-browser-error]"));
    assert.match(
      m.query("[data-browser-error]")!.textContent || "",
      /local URLs/,
    );
    assert.equal(
      (preview as unknown as { calls: string[] }).calls.some((c) =>
        c.startsWith("navigate:"),
      ),
      false,
    );
    m.unmount();
  });

  it("navigates a localhost URL and screenshots into the composer callback", async () => {
    const preview = fakePreview();
    const shots: string[] = [];
    const m = await mount(
      <BrowserPane
        threadId="t1"
        preview={preview}
        onAttachScreenshot={async (dataUrl) => {
          shots.push(dataUrl);
        }}
      />,
    );
    const wv = m.query("webview") as HTMLElement;
    assert.ok(wv, "webview guest");
    (wv as unknown as { getWebContentsId: () => number }).getWebContentsId =
      () => 11;
    await inAct(() => {
      wv.dispatchEvent(new Event("did-attach"));
    });
    await m.flush();

    const input = m.query("[data-browser-url]") as HTMLInputElement;
    await m.type(input, "http://localhost:5173/");
    await m.click(m.query("[data-browser-go]"));
    await m.flush();
    assert.equal(m.query("[data-browser-empty]"), null);
    assert.equal(
      (m.query("[data-browser-url]") as HTMLInputElement).value,
      "http://localhost:5173/",
    );

    const shotBtn = m.query("[data-browser-screenshot]") as HTMLButtonElement;
    assert.equal(shotBtn.disabled, false);
    await m.click(shotBtn);
    await m.flush();
    assert.deepEqual(shots, ["data:image/png;base64,aaa"]);
    m.unmount();
  });
});
