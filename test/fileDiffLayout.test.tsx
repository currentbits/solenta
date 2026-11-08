import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { inAct, mount, type Mounted } from "./support/dom.ts";
import { FileDiffLayout } from "../src/components/FileDiffLayout";
import { ChangesPanel } from "../src/components/thread/ChangesPanel";
import { PrCodeTab } from "../src/components/PrCodeTab";
import {
  DIFF_FILE_WIDTH_KEY,
  setDiffFileWidth,
  setDiffTreeView,
} from "../src/uiPrefs";
import type { CoderApi, DiffResult } from "../src/shared/ipc";

const observers = new Map<Element, () => void>();
let restoreObserver: (() => void) | null = null;
afterEach(() => {
  restoreObserver?.();
  restoreObserver = null;
  observers.clear();
  setDiffFileWidth(240);
  setDiffTreeView(false);
});

async function boot() {
  const m = await mount(<div />);
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private callback: () => void) {}
    observe(el: Element) { observers.set(el, this.callback); }
    unobserve(el: Element) { observers.delete(el); }
    disconnect() { /* Cleared by the test cleanup. */ }
  } as unknown as typeof ResizeObserver;
  restoreObserver = () => { globalThis.ResizeObserver = original; };
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  setDiffFileWidth(240);
  return m;
}

function handle(m: Mounted): HTMLElement {
  const el = m.query("[data-file-column-resize]");
  assert.ok(el);
  return el as HTMLElement;
}

async function resize(m: Mounted, width: number) {
  const root = m.query("[data-file-diff-layout]")!;
  assert.ok(root);
  root.getBoundingClientRect = () => ({ width } as DOMRect);
  await inAct(() => { observers.get(root)?.(); });
}

function pointer(type: string, x: number, pointerId = 1) {
  return new window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId, button: 0, clientX: x,
  });
}

async function drag(m: Mounted, from: number, to: number, finish = "pointerup") {
  await inAct(() => {
    handle(m).dispatchEvent(pointer("pointerdown", from));
    window.dispatchEvent(pointer("pointermove", to));
  });
  if (finish === "Escape") {
    await inAct(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
  } else {
    await inAct(() => { window.dispatchEvent(pointer(finish, to)); });
  }
}

it("exposes a labeled separator with keyboard bounds, reset, and a remembered shared width", async () => {
  const m = await boot();
  await m.rerender(<FileDiffLayout files="Files">Diff</FileDiffLayout>);
  await resize(m, 900);
  const separator = handle(m);
  assert.equal(separator.getAttribute("role"), "separator");
  assert.equal(separator.getAttribute("aria-orientation"), "vertical");
  assert.equal(separator.getAttribute("aria-label"), "Resize file column");
  assert.equal(separator.getAttribute("aria-valuemin"), "180");
  assert.equal(separator.getAttribute("aria-valuemax"), "480");
  assert.equal(separator.getAttribute("aria-valuenow"), "240");
  assert.ok(m.container.querySelector(`[id="${separator.getAttribute("aria-controls")}"]`));
  await inAct(() => { separator.focus(); });
  await m.pressFocused("ArrowRight");
  assert.equal(separator.getAttribute("aria-valuenow"), "248");
  await m.pressFocused("ArrowRight", { shiftKey: true });
  assert.equal(separator.getAttribute("aria-valuenow"), "280");
  assert.equal(window.localStorage.getItem(DIFF_FILE_WIDTH_KEY), "280");
  await m.pressFocused("End");
  await m.pressFocused("ArrowRight");
  assert.equal(separator.getAttribute("aria-valuenow"), "480");
  await m.pressFocused("Home");
  await m.pressFocused("ArrowLeft");
  assert.equal(separator.getAttribute("aria-valuenow"), "180");
  await m.pressFocused("Enter");
  assert.equal(separator.getAttribute("aria-valuenow"), "240");
  await m.pressFocused("ArrowRight", { shiftKey: true });
  await m.rerender(<div />);
  await m.rerender(<FileDiffLayout files="Files">Diff</FileDiffLayout>);
  assert.equal(handle(m).getAttribute("aria-valuenow"), "272");
  await inAct(() => { handle(m).dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })); });
  assert.equal(handle(m).getAttribute("aria-valuenow"), "240");
});

it("previews a bounded drag, commits only on release, and cancels or cleans up interrupted drags", async () => {
  const m = await boot();
  await m.rerender(<FileDiffLayout files="Files">Diff</FileDiffLayout>);
  await resize(m, 900);
  await inAct(() => {
    handle(m).dispatchEvent(pointer("pointerdown", 240));
    window.dispatchEvent(pointer("pointermove", 360, 2));
  });
  assert.equal(handle(m).getAttribute("aria-valuenow"), "240", "unrelated pointer ignored");
  await inAct(() => { window.dispatchEvent(pointer("pointermove", 360)); });
  assert.equal(handle(m).getAttribute("aria-valuenow"), "360");
  assert.equal(window.localStorage.getItem(DIFF_FILE_WIDTH_KEY), "240");
  await inAct(() => { window.dispatchEvent(pointer("pointerup", 360)); });
  assert.equal(window.localStorage.getItem(DIFF_FILE_WIDTH_KEY), "360");
  await drag(m, 360, 900);
  assert.equal(handle(m).getAttribute("aria-valuenow"), "480");
  await drag(m, 480, -100);
  assert.equal(handle(m).getAttribute("aria-valuenow"), "180");
  for (const cancel of ["Escape", "pointercancel"]) {
    await drag(m, 180, 300, cancel);
    assert.equal(handle(m).getAttribute("aria-valuenow"), "180");
    assert.equal(window.localStorage.getItem(DIFF_FILE_WIDTH_KEY), "180");
    assert.equal(document.body.style.cursor, "");
  }
  await inAct(() => { handle(m).dispatchEvent(pointer("pointerdown", 180)); });
  assert.equal(document.body.style.cursor, "col-resize");
  await m.rerender(<div />);
  assert.equal(document.body.style.cursor, "");
  assert.equal(document.body.style.userSelect, "");
});

it("fits the actual pane and hides the separator when stacked without forgetting the wider preference", async () => {
  const m = await boot();
  await m.rerender(<FileDiffLayout files="Files">Diff</FileDiffLayout>);
  await inAct(() => { setDiffFileWidth(460); });
  await resize(m, 650);
  assert.equal(handle(m).getAttribute("aria-valuenow"), "324");
  assert.equal(handle(m).getAttribute("aria-valuemax"), "324");
  await inAct(() => { handle(m).focus(); });
  await m.pressFocused("ArrowRight");
  assert.equal(window.localStorage.getItem(DIFF_FILE_WIDTH_KEY), "460");
  await drag(m, 324, 400);
  assert.equal(window.localStorage.getItem(DIFF_FILE_WIDTH_KEY), "460", "dragging against the fit cap preserves the preference");
  await inAct(() => {
    handle(m).dispatchEvent(pointer("pointerdown", 324));
    window.dispatchEvent(pointer("pointermove", 300));
  });
  await resize(m, 500);
  assert.equal(handle(m).tabIndex, -1);
  assert.equal(handle(m).getAttribute("aria-hidden"), "true");
  assert.notEqual(document.activeElement, handle(m), "focus leaves a hidden separator");
  assert.equal(document.body.style.cursor, "");
  await m.pressFocused("ArrowLeft");
  assert.equal(window.localStorage.getItem(DIFF_FILE_WIDTH_KEY), "460");
  await resize(m, 900);
  assert.equal(handle(m).tabIndex, 0);
  assert.equal(handle(m).getAttribute("aria-valuenow"), "460");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 700 });
  await inAct(() => { window.dispatchEvent(new window.Event("resize")); });
  assert.equal(handle(m).tabIndex, -1, "existing narrow-window layout retained");
});

const patch = (path: string, text: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${text}\n`;
const diff: DiffResult = {
  files: [
    { path: "src/one.ts", status: "M", additions: 1, deletions: 1 },
    { path: "src/two.ts", status: "M", additions: 1, deletions: 1 },
  ],
  patch: patch("src/one.ts", "firstFile") + patch("src/two.ts", "secondFile"),
  truncated: false,
};

it("keeps Changes and PR file selection stable across resize, stacked mode, and tree navigation", async () => {
  const m = await boot();
  const w = window as unknown as { coder: CoderApi };
  const previous = w.coder;
  w.coder = { git: { prDiff: async () => ({ ok: true, ...diff, headSha: "abc", commits: [] }) } } as unknown as CoderApi;
  try {
    await m.rerender(<ChangesPanel open threadId="resize" threadTitle="Resize" threadBranch="coder/resize"
      planText="" openNonce={1} onFetchDiff={async () => diff} onCommit={async () => ({ subject: "done" })}
      onSuggest={async () => ({ message: "done" })} onComment={() => {}} />);
    await m.flush();
    await resize(m, 900);
    await m.click(m.query('[data-file-path="src/two.ts"]'));
    assert.equal(m.query('[data-file-path="src/two.ts"]')?.getAttribute("data-selected"), "true");
    await drag(m, 240, 350);
    await resize(m, 500);
    assert.equal(m.query('[data-file-path="src/two.ts"]')?.getAttribute("data-selected"), "true");
    await m.rerender(<PrCodeTab projectPath="/tmp/review" prNumber={1} />);
    await m.flush();
    await resize(m, 900);
    assert.equal(handle(m).getAttribute("aria-valuenow"), "350", "PR shares remembered Changes width");
    await m.click(m.query('[data-pr-code-file="src/two.ts"]'));
    await drag(m, 350, 400);
    await resize(m, 500);
    assert.equal(m.query('[data-pr-code-file="src/two.ts"]')?.getAttribute("aria-pressed"), "true");
    assert.match(m.query("[data-pr-code-patch]")?.textContent ?? "", /secondFile/);
    await inAct(() => { setDiffTreeView(true); });
    assert.ok(m.query("[data-pr-code-tree]"));
    await m.click(m.query('[data-pr-code-file="src/one.ts"]'));
    assert.match(m.query("[data-pr-code-patch]")?.textContent ?? "", /firstFile/);
  } finally {
    w.coder = previous;
  }
});
