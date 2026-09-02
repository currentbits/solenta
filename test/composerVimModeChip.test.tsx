/**
 * Composer vim mode chip (issue #818 / #816).
 * Pref off: no chip. Pref on: Vim Insert, then Escape → Vim Normal.
 * Visible text must not match the transcript-view trigger (also "Normal").
 *
 * Run: node --import=./test/support/render.mjs --test test/composerVimModeChip.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach, beforeEach } from "node:test";
import { mount, unmountAll, type Mounted } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import { TRANSCRIPT_VIEW_LABELS } from "../src/focusView";
import { setComposerVimEnabled } from "../src/uiPrefs";
import type { ProviderInfo } from "../src/shared/ipc";

const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: ["opus"],
    modelInfo: [],
    efforts: [],
  },
];

function mountComposer() {
  return mount(
    <Composer
      threadId="t1"
      branch="coder/vim-mode-chip"
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
      hasWorktree={true}
      onSend={() => {}}
      onBuild={() => {}}
    />,
  );
}

function textarea(m: Mounted): HTMLTextAreaElement {
  const el = m.container.querySelector("textarea");
  assert.ok(el);
  return el as HTMLTextAreaElement;
}

function modeChip(m: Mounted): Element | null {
  return m.container.querySelector("[data-vim-mode-chip]");
}

function transcriptTrigger(m: Mounted): Element {
  const el = m.container.querySelector("[data-transcript-view-trigger]");
  assert.ok(el, "transcript-view trigger is on the composer");
  return el;
}

function assertChipDistinctFromTranscript(m: Mounted, chip: Element) {
  const trigger = transcriptTrigger(m);
  assert.notEqual(
    chip.textContent,
    trigger.textContent,
    "vim chip must not reuse the transcript-view trigger text",
  );
  assert.notEqual(
    chip.textContent,
    TRANSCRIPT_VIEW_LABELS.normal,
    "vim chip must not read the density label Normal",
  );
}

describe("Composer vim mode chip (#818)", () => {
  beforeEach(() => {
    setComposerVimEnabled(false);
  });
  afterEach(() => {
    unmountAll();
    setComposerVimEnabled(false);
  });

  it("does not show the chip when the pref is off", async () => {
    const m = await mountComposer();
    assert.equal(modeChip(m), null);
    assert.equal(
      transcriptTrigger(m).textContent,
      TRANSCRIPT_VIEW_LABELS.normal,
    );
  });

  it("shows Vim Insert when the pref is on and flips to Vim Normal on Escape", async () => {
    setComposerVimEnabled(true);
    const m = await mountComposer();
    const chip = modeChip(m);
    assert.ok(chip, "chip is on the composer when vim is on");
    assert.equal(chip.getAttribute("data-vim-mode-chip"), "insert");
    assert.equal(chip.textContent, "Vim Insert");
    assertChipDistinctFromTranscript(m, chip);

    await m.press(textarea(m), "Escape");
    const after = modeChip(m);
    assert.ok(after);
    assert.equal(after.getAttribute("data-vim-mode-chip"), "normal");
    assert.equal(after.textContent, "Vim Normal");
    assertChipDistinctFromTranscript(m, after);
  });
});
