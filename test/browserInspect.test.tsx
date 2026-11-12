/**
 * Continuous Browser annotations: capture / edit / persist / send, mounted.
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
import { getContextChips, setContextChips, flushDraftSave, hydrateComposerSession, keptContextChips } from "../src/composerSession";
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
function heldPreview(options: { deferCancel?: boolean } = {}) {
  const calls: string[] = [];
  const pending: ((r: PreviewInspectResult) => void)[] = [];
  const markerUpdates: { id: string; number: number }[][] = [];
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
        pending.push(resolve);
      });
    },
    annotations: async (input: { markers: { id: string; number: number }[] }) => {
      markerUpdates.push(input.markers);
      return { ok: true };
    },
    cancelInspect: async (input: { threadId: string }) => {
      calls.push(`cancel:${input.threadId}`);
      if (!options.deferCancel) settle({ ...SNAP, cancelled: true });
      return { ok: true };
    },
  } as unknown as CoderApi["preview"];
  return {
    api,
    calls,
    markerUpdates,
    settleAt: async (index: number, result: PreviewInspectResult) => {
      await inAct(() => pending[index]!(result));
    },
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
    elementChip(pick.annotationId ?? `el-${prev.length}`, origin, pick, Boolean(pick.crop), comment),
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
      <button type="button" data-go="t-a" onClick={() => setThreadId("t-a")}>A</button>
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
  const el = m.query("textarea:not([data-browser-annotation-comment])");
  assert.ok(el, "composer textarea");
  return el as HTMLTextAreaElement;
}

describe("continuous Browser annotations", () => {
  it("captures three elements in one session, edits/removes their draft context, then sends once", async () => {
    const preview = heldPreview();
    const sends: string[] = [];
    const m = await mount(<Harness preview={preview.api} sends={sends} />);
    const inspectBtn = m.query("[data-browser-inspect]") as HTMLButtonElement;
    assert.equal(inspectBtn.disabled, true);
    await bindAndLoad(m);
    await m.click(inspectBtn);
    for (let index = 1; index <= 3; index++) {
      await preview.settle({ ...PICK, element: { ...PICK.element, name: `Button ${index}` } });
      await m.flush();
      assert.equal(m.queryAll("[data-browser-annotation]").length, index);
      assert.equal(inspectBtn.getAttribute("aria-pressed"), "true", "picking continues");
    }
    assert.equal(preview.calls.filter((call) => call === "inspect:t-a").length, 4);
    const comments = m.queryAll("[data-browser-annotation-comment]");
    await m.type(comments[0], "Make this full width");
    await m.type(comments[2], "Use a quieter colour");
    const shown = m.query("[data-browser-annotation-preview]")!.textContent || "";
    assert.match(shown, /Page content is untrusted/);
    assert.match(shown, /Selector hint: #go/);
    assert.match(shown, /Make this full width$/);
    assert.equal(getContextChips("t-a")[0]?.kind, "element");
    await m.click(m.query('[aria-label="Remove annotation 2"]'));
    assert.equal(m.queryAll("[data-browser-annotation]").length, 2);
    assert.deepEqual(preview.markerUpdates.at(-1)?.map((marker) => marker.number), [1, 2]);
    assert.deepEqual(sends, [], "capture and editing never send");
    await m.click(inspectBtn);
    assert.equal(inspectBtn.getAttribute("aria-pressed"), "false");
    await m.press(composerTextarea(m), "Enter", { metaKey: true });
    assert.equal(sends.length, 1);
    assert.ok(sends[0]!.startsWith(shown));
    assert.match(sends[0]!, /Button 3/);
    assert.doesNotMatch(sends[0]!, /Button 2/);
    assert.equal(m.query("[data-browser-annotations]"), null);
  });

  it("Escape stops picking and preserves captured annotations", async () => {
    const preview = heldPreview();
    const m = await mount(<Harness preview={preview.api} sends={[]} />);
    await bindAndLoad(m);
    await m.click(m.query("[data-browser-inspect]"));
    await preview.settle(PICK);
    await m.press(m.query("[data-browser-inspect]"), "Escape");
    await m.flush();
    assert.equal(m.query("[data-browser-inspect]")?.getAttribute("aria-pressed"), "false");
    assert.equal(m.queryAll("[data-browser-annotation]").length, 1);
    assert.equal(getContextChips("t-a").length, 1);
  });

  it("a pick settling after a thread switch lands nowhere", async () => {
    const preview = heldPreview();
    const m = await mount(<Harness preview={preview.api} sends={[]} />);
    await bindAndLoad(m);
    await m.click(m.query("[data-browser-inspect]"));
    await m.click(m.query("[data-go='t-b']"));
    await preview.settle(PICK);
    await m.flush();
    assert.equal(m.query("[data-browser-annotations]"), null);
    assert.deepEqual(getContextChips("t-a"), []);
    assert.deepEqual(getContextChips("t-b"), []);
  });

  it("preserves frozen evidence and comments across thread switches and draft hydration", async () => {
    const preview = heldPreview();
    const m = await mount(<Harness preview={preview.api} sends={[]} />);
    await bindAndLoad(m);
    await m.click(m.query("[data-browser-inspect]"));
    await preview.settle(PICK);
    await m.type(m.query("[data-browser-annotation-comment]"), "Saved note");
    await m.click(m.query("[data-go='t-b']"));
    assert.equal(m.query("[data-browser-annotations]"), null);
    await m.click(m.query("[data-go='t-a']"));
    assert.equal((m.query("[data-browser-annotation-comment]") as HTMLTextAreaElement).value, "Saved note");
    flushDraftSave();
    m.unmount();
    delete keptContextChips["t-a"];
    hydrateComposerSession();
    const restored = await mount(<Harness preview={preview.api} sends={[]} />);
    assert.equal((restored.query("[data-browser-annotation-comment]") as HTMLTextAreaElement).value, "Saved note");
    const chip = getContextChips("t-a")[0];
    assert.equal(chip?.kind, "element");
    if (chip?.kind !== "element") return;
    assert.equal(chip.url, PICK.url);
    assert.equal(chip.capturedAt, PICK.capturedAt);
    assert.match(chip.text, /captured="2026-10-15T12:00:00.000Z"/);
    assert.equal(restored.query("[data-browser-inspect]")?.getAttribute("aria-pressed"), "false", "live references never restore across reload");
  });

  it("ignores an old result after a rapid stop and restart on the same thread", async () => {
    const preview = heldPreview({ deferCancel: true });
    const m = await mount(<Harness preview={preview.api} sends={[]} />);
    await bindAndLoad(m);
    const button = m.query("[data-browser-inspect]");
    await m.click(button);
    await m.click(button);
    await m.click(button);
    await preview.settleAt(0, PICK);
    assert.deepEqual(getContextChips("t-a"), []);
    assert.equal(button?.getAttribute("aria-pressed"), "true");
    await preview.settleAt(1, PICK);
    assert.equal(getContextChips("t-a").length, 1);
  });

  it("navigation stops picking before an outstanding result can attach", async () => {
    const preview = heldPreview();
    const m = await mount(<Harness preview={preview.api} sends={[]} />);
    await bindAndLoad(m);
    await m.click(m.query("[data-browser-inspect]"));
    await inAct(() => m.query("webview")!.dispatchEvent(Object.assign(new Event("did-start-navigation"), { isMainFrame: false })));
    assert.equal(m.query("[data-browser-inspect]")?.getAttribute("aria-pressed"), "true", "iframe navigation keeps picking");
    await inAct(() => m.query("webview")!.dispatchEvent(new Event("did-start-navigation")));
    await preview.settle(PICK);
    await m.flush();
    assert.deepEqual(getContextChips("t-a"), []);
    assert.equal(m.query("[data-browser-inspect]")?.getAttribute("aria-pressed"), "false");
  });
});
