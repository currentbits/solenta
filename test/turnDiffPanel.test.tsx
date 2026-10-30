/**
 * TurnDiffPanel: unified/split layout and per-file chips (#148).
 *
 * Run: node --import=./test/support/render.mjs --test test/turnDiffPanel.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { useState } from "react";
import { mount } from "./support/dom.ts";
import { TurnDiffPanel, type DiffViewMode } from "../src/components/TurnDiffPanel";
import { setDiffFilesCollapsed } from "../src/uiPrefs";
import type { DiffResult } from "../src/shared/ipc";

afterEach(() => {
  setDiffFilesCollapsed(false);
});

const DIFF: DiffResult = {
  files: [
    { path: "src/a.ts", status: "M", additions: 1, deletions: 1 },
    { path: "notes.txt", status: "A", additions: 1, deletions: 0 },
  ],
  patch: [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " keep",
    "-old",
    "+new",
    " keep",
    "diff --git a/notes.txt b/notes.txt",
    "--- /dev/null",
    "+++ b/notes.txt",
    "@@ -0,0 +1 @@",
    "+hello",
  ].join("\n"),
  truncated: true,
};

function Harness({
  diff = DIFF,
}: {
  diff?: DiffResult;
}) {
  const [mode, setMode] = useState<DiffViewMode>("unified");
  return (
    <TurnDiffPanel
      threadId="t1"
      sha="sha-turn-2-bbbbbbbb"
      turn={2}
      mode={mode}
      onModeChange={setMode}
      onFetch={async () => diff}
    />
  );
}

describe("TurnDiffPanel", () => {
  it("renders the unified patch then switches to split", async () => {
    const m = await mount(<Harness />);
    await m.flush();
    const panel = m.query("[data-turn-diff]");
    assert.ok(panel);
    assert.equal(panel!.getAttribute("data-turn-diff-mode"), "unified");
    assert.ok((panel!.textContent || "").includes("Turn 2"));
    assert.ok((panel!.textContent || "").includes("-old"));
    assert.ok((panel!.textContent || "").includes("Diff truncated"));

    await m.click(m.query("[data-turn-diff-mode-btn='split']") as HTMLElement);
    await m.flush();
    assert.equal(
      m.query("[data-turn-diff]")?.getAttribute("data-turn-diff-mode"),
      "split",
    );
    assert.ok(m.query("[data-turn-diff-split-row]"));
    assert.equal(m.query("[data-turn-diff-mode-btn='split']")?.getAttribute("aria-pressed"), "true");
    m.unmount();
  });

  it("filters the patch to the selected file", async () => {
    const m = await mount(<Harness />);
    await m.flush();
    const notes = m.query("[data-turn-diff-file='notes.txt']") as HTMLElement | null;
    assert.ok(notes);
    await m.click(notes);
    await m.flush();
    const text = m.query("[data-turn-diff]")?.textContent || "";
    assert.ok(text.includes("+hello"));
    assert.ok(!text.includes("-old"));
    m.unmount();
  });

  it("shows an empty state when the turn has no patch", async () => {
    const m = await mount(
      <Harness
        diff={{ files: [], patch: "", truncated: false }}
      />,
    );
    await m.flush();
    assert.ok(
      (m.query("[data-turn-diff]")?.textContent || "").includes(
        "No textual diff for this turn",
      ),
    );
    m.unmount();
  });
});

describe("TurnDiffPanel per-file collapse (#1787)", () => {
  it("renders no collapse header and a fully expanded body with the pref off", async () => {
    const m = await mount(<Harness />);
    await m.flush();
    assert.equal(
      m.query("[data-diff-file-header]"),
      null,
      "no collapse header when the pref is off",
    );
    assert.ok((m.query("[data-turn-diff]")?.textContent || "").includes("-old"));
    m.unmount();
  });

  it("starts collapsed with the pref on; the header click expands it", async () => {
    setDiffFilesCollapsed(true);
    const m = await mount(<Harness />);
    await m.flush();
    const header = m.query("[data-diff-file-header='src/a.ts']");
    assert.ok(header, "collapse header renders for the auto-selected file");
    assert.equal(header!.getAttribute("aria-expanded"), "false");
    assert.ok(
      !(m.query("[data-turn-diff]")?.textContent || "").includes("-old"),
      "body starts hidden",
    );

    await m.click(header as HTMLElement);
    await m.flush();
    assert.equal(
      m.query("[data-diff-file-header='src/a.ts']")?.getAttribute("aria-expanded"),
      "true",
      "a header click expands",
    );
    assert.ok((m.query("[data-turn-diff]")?.textContent || "").includes("-old"));
    m.unmount();
  });

  it("selecting a file from the chip list expands it", async () => {
    setDiffFilesCollapsed(true);
    const m = await mount(<Harness />);
    await m.flush();
    assert.equal(
      m.query("[data-diff-file-header='src/a.ts']")?.getAttribute("aria-expanded"),
      "false",
    );

    await m.click(m.query("[data-turn-diff-file='notes.txt']") as HTMLElement);
    await m.flush();
    assert.equal(
      m.query("[data-diff-file-header='notes.txt']")?.getAttribute("aria-expanded"),
      "true",
      "selecting a file from the list expands it",
    );
    assert.ok((m.query("[data-turn-diff]")?.textContent || "").includes("+hello"));
    m.unmount();
  });
});
