/**
 * TurnDiffPanel: unified/split layout and per-file chips (#148).
 *
 * Run: node --import=./test/support/render.mjs --test test/turnDiffPanel.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useState } from "react";
import { mount } from "./support/dom.ts";
import { TurnDiffPanel, type DiffViewMode } from "../src/components/TurnDiffPanel";
import type { DiffResult } from "../src/shared/ipc";

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
