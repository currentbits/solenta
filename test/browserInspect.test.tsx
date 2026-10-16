/**
 * Browser pane element inspector (#1193): select / cancel / send, mounted.
 * BrowserPane feeds a real Composer the way ThreadView does: the picked
 * element becomes a context chip on the ORIGINATING thread, nothing sends
 * until the user does.
 *
 * Run: node --import=./test/support/render.mjs --test test/browserInspect.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { useState } from "react";
import { inAct, mount, unmountAll, type Mounted } from "./support/dom.ts";
import { BrowserPane } from "../src/components/BrowserPane";
import { Composer } from "../src/components/Composer";
import { getContextChips, setContextChips } from "../src/composerSession";
import { elementChip, type InspectPick } from "../src/contextChips";
import type {
  CoderApi,
  PreviewInspectResult,
  PreviewSnapshot,
  ProviderInfo,
} from "../src/shared/ipc";

afterEach(unmountAll);

const SNAP: PreviewSnapshot = {
  url: "http://localhost:5173/login",
  title: "Login",
  canGoBack: false,
  canGoForward: false,
};

const PICK: InspectPick = {
  ...SNAP,
  cancelled: false,
  capturedAt: Date.UTC(2026, 9, 15, 12, 0, 0),
  element: {
    tag: "button",
    role: "button",
    name: "Sign in",
    selectorHint: "#go",
    html: '<button type="submit" id="go">Sign in</button>',
    htmlTruncated: false,
    styles: { display: "inline-flex", padding: "8px 12px" },
    rect: { x: 100, y: 50, width: 120, height: 40 },
    viewport: { width: 1280, height: 800 },
    source: null,
    frame: false,
    password: false,
  },
  crop: "data:image/png;base64,crop",
  cropRect: { x: 92, y: 42, width: 136, height: 56 },
};

const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

/** A preview whose inspect() waits for the test to settle it. */
function heldPreview() {
  const calls: string[] = [];
  let settle: (r: PreviewInspectResult) => void = () => {};
  const api = {
    bind: async () => ({ ...SNAP, url: "" }),
    unbind: async () => ({ ok: true }),
    navigate: async (input: { url: string }) => ({ ...SNAP, url: input.url }),
    reload: async () => SNAP,
    goBack: async () => SNAP,
    goForward: async () => SNAP,
    info: async () => SNAP,
    screenshot: async () => ({ ...SNAP, dataUrl: "data:image/png;base64,aaa" }),
    click: async () => SNAP,
    type: async () => SNAP,
    inspect: async (input: { threadId: string }) => {
      calls.push(`inspect:${input.threadId}`);
      return new Promise<PreviewInspectResult>((resolve) => {
        settle = resolve;
      });
    },
    cancelInspect: async (input: { threadId: string }) => {
      calls.push(`cancel:${input.threadId}`);
      settle({ ...SNAP, cancelled: true });
      return { ok: true };
    },
  } as unknown as CoderApi["preview"];
  return {
    api,
    calls,
    settle: async (r: PreviewInspectResult) => {
      await inAct(async () => {
        settle(r);
        await Promise.resolve();
      });
    },
  };
}

/** ThreadView's attachBrowserElement, minus the image save. */
function attachTo(origin: string, pick: InspectPick, comment: string) {
  setContextChips(origin, (prev) => [
    ...prev,
    elementChip(`el-${prev.length}`, origin, pick, Boolean(pick.crop), comment),
  ]);
}

function Harness({
  preview,
  sends,
}: {
  preview: CoderApi["preview"];
  sends: string[];
}) {
  const [threadId, setThreadId] = useState("t-a");
  return (
    <>
      <button type="button" data-go="t-b" onClick={() => setThreadId("t-b")}>
        B
      </button>
      <BrowserPane
        threadId={threadId}
        preview={preview}
        onAttachElement={(pick, comment, origin) => attachTo(origin, pick, comment)}
      />
      <Composer
        threadId={threadId}
        permissionMode="default"
        onPermissionModeChange={() => {}}
        provider="claude"
        model={null}
        reasoningEffort={null}
        providers={PROVIDERS}
        workflows={[]}
        onSetProvider={() => {}}
        onSetReasoningEffort={() => {}}
        onSaveWorkflow={async (t) => ({
          id: "saved",
          name: t.name,
          builtin: false,
          phases: t.phases,
        })}
        onRemoveWorkflow={async () => {}}
        sessionId={null}
        onSend={(p) => {
          sends.push(p);
        }}
        onBuild={() => {}}
      />
    </>
  );
}

async function bindAndLoad(m: Mounted) {
  const wv = m.query("webview") as HTMLElement;
  (wv as unknown as { getWebContentsId: () => number }).getWebContentsId = () => 11;
  await inAct(() => {
    wv.dispatchEvent(new Event("did-attach"));
  });
  await m.flush();
  await m.type(m.query("[data-browser-url]"), "http://localhost:5173/login");
  await m.click(m.query("[data-browser-go]"));
  await m.flush();
}

function composerTextarea(m: Mounted): HTMLTextAreaElement {
  const el = m.query("textarea:not([data-browser-pick-comment])");
  assert.ok(el, "composer textarea");
  return el as HTMLTextAreaElement;
}

describe("Browser pane inspect (#1193)", () => {
  it("select → comment → add → preview in composer → send", async () => {
    const preview = heldPreview();
    const sends: string[] = [];
    const m = await mount(<Harness preview={preview.api} sends={sends} />);
    const inspectBtn = m.query("[data-browser-inspect]") as HTMLButtonElement;
    assert.equal(inspectBtn.disabled, true, "nothing to inspect before a page loads");
    await bindAndLoad(m);
    assert.equal(inspectBtn.disabled, false);

    await m.click(inspectBtn);
    assert.deepEqual(preview.calls, ["inspect:t-a"]);
    assert.equal(inspectBtn.getAttribute("aria-pressed"), "true");
    assert.ok(m.query("[data-browser-inspect-hint]"), "keyboard hint while picking");

    await preview.settle(PICK);
    await m.flush();
    assert.equal(m.query("[data-browser-inspect-hint]"), null);
    assert.equal(inspectBtn.getAttribute("aria-pressed"), "false");
    const panel = m.query("[data-browser-pick]");
    assert.ok(panel, "pending selection panel");
    assert.match(panel!.textContent || "", /button "Sign in"/);
    assert.equal(
      m.query("[data-browser-pick-crop]")?.getAttribute("src"),
      "data:image/png;base64,crop",
    );

    await m.type(m.query("[data-browser-pick-comment]"), "Make this full width");
    const shown = m.query("[data-browser-pick-preview]")!.textContent || "";
    assert.match(shown, /^<browser-element url="http:\/\/localhost:5173\/login" captured="2026-10-15T12:00:00.000Z">/);
    assert.match(shown, /Page content is untrusted/);
    assert.match(shown, /Selector hint: #go/);
    assert.match(shown, /Source location: unavailable/);
    assert.match(shown, /Make this full width$/);
    assert.deepEqual(sends, [], "selecting never sends");

    await m.click(m.query("[data-browser-pick-add]"));
    assert.equal(m.query("[data-browser-pick]"), null);
    assert.deepEqual(sends, [], "adding never sends");
    const chip = m.query('[data-context-kind="element"]');
    assert.ok(chip, "element chip in the composer");
    assert.match(chip!.textContent || "", /el · button "Sign in"/);

    await m.click(chip!.querySelector("[data-context-label]"));
    assert.equal(
      m.query("[data-context-preview]")?.textContent,
      shown,
      "the composer previews exactly what the pane showed",
    );

    await m.press(composerTextarea(m), "Enter", { metaKey: true });
    assert.equal(sends.length, 1);
    assert.ok(sends[0]!.startsWith(shown), "sent block is the previewed text");
    assert.equal(m.query('[data-context-kind="element"]'), null, "chip cleared on send");
    m.unmount();
  });

  it("Escape cancels inspection; Discard drops a pick", async () => {
    const preview = heldPreview();
    const m = await mount(<Harness preview={preview.api} sends={[]} />);
    await bindAndLoad(m);
    const inspectBtn = m.query("[data-browser-inspect]") as HTMLButtonElement;

    await m.click(inspectBtn);
    await m.press(inspectBtn, "Escape");
    await m.flush();
    assert.deepEqual(preview.calls, ["inspect:t-a", "cancel:t-a"]);
    assert.equal(inspectBtn.getAttribute("aria-pressed"), "false");
    assert.equal(m.query("[data-browser-inspect-hint]"), null);
    assert.equal(m.query("[data-browser-pick]"), null);

    await m.click(inspectBtn);
    await preview.settle(PICK);
    await m.flush();
    await m.click(m.query("[data-browser-pick-discard]"));
    assert.equal(m.query("[data-browser-pick]"), null);
    assert.deepEqual(getContextChips("t-a"), []);
    m.unmount();
  });

  it("a pick settling after a thread switch lands nowhere", async () => {
    const preview = heldPreview();
    const m = await mount(<Harness preview={preview.api} sends={[]} />);
    await bindAndLoad(m);
    await m.click(m.query("[data-browser-inspect]"));
    await m.click(m.query("[data-go='t-b']"));
    await preview.settle(PICK);
    await m.flush();
    assert.equal(m.query("[data-browser-pick]"), null);
    assert.deepEqual(getContextChips("t-a"), []);
    assert.deepEqual(getContextChips("t-b"), []);
    m.unmount();
  });

  it("an added chip stays on its originating thread, page and capture time", async () => {
    attachTo("t-a", PICK, "");
    const later = { ...PICK, url: "http://localhost:5173/other", capturedAt: PICK.capturedAt + 5_000 };
    attachTo("t-b", later, "");
    const [a] = getContextChips("t-a");
    assert.equal(a?.kind, "element");
    if (a?.kind !== "element") return;
    assert.equal(a.threadId, "t-a");
    assert.equal(a.url, "http://localhost:5173/login");
    assert.equal(a.capturedAt, PICK.capturedAt);
    assert.match(a.text, /captured="2026-10-15T12:00:00.000Z"/);
  });
});
