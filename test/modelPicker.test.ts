/**
 * Pure model-picker decisions (no DOM).
 * Run: node --experimental-strip-types --test test/modelPicker.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderInfo, ReasoningEffort } from "../src/shared/ipc";
import { REASONING_EFFORTS } from "../src/shared/ipc";
import {
  CUSTOM_MODEL_ID,
  buildModelRows,
  buildUnifiedModelRows,
  clampHighlightIndex,
  detailModelRow,
  effortDisplayLabel,
  effortSegments,
  firstSelectableIndex,
  initialHighlightIndex,
  isRowSelected,
  lastSelectableIndex,
  modelTriggerLabel,
  rowKey,
  sessionLockReason,
  showReasoningControl,
  stepHighlightIndex,
} from "../src/modelPicker";

function provider(over: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: ["claude-opus-5", "claude-sonnet-5"],
    modelInfo: [
      {
        id: "claude-opus-5",
        label: "Opus 5",
        description: "Deepest reasoning",
        vendor: "Anthropic",
      },
      {
        id: "claude-sonnet-5",
        label: "Sonnet 5",
        description: "Everyday complex work",
        vendor: "Anthropic",
        recommended: true,
      },
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    ...over,
  };
}

const MULTI: ProviderInfo[] = [
  provider(),
  {
    id: "codex",
    name: "Codex",
    available: true,
    supportsResume: false,
    models: [],
    modelInfo: [],
    efforts: [],
  },
  {
    id: "grok",
    name: "Grok",
    available: false,
    supportsResume: false,
    models: ["grok-4"],
    modelInfo: [
      {
        id: "grok-4",
        label: "Grok 4",
        description: "xAI flagship",
        vendor: "xAI",
      },
    ],
    efforts: ["low", "medium", "high"],
  },
];

describe("buildModelRows", () => {
  it("leads with Default, then modelInfo labels (never raw ids as labels when info exists)", () => {
    const rows = buildModelRows(provider());
    // Default + 2 models + Custom
    assert.equal(rows.length, 4);
    assert.equal(rows[0]!.id, null);
    assert.equal(rows[0]!.label, "Default");
    assert.equal(rows[0]!.providerId, "claude");
    assert.equal(rows[0]!.groupHeading, "Claude Code");
    assert.equal(rows[1]!.label, "Opus 5");
    assert.equal(rows[1]!.vendor, "Anthropic");
    assert.equal(rows[1]!.groupHeading, null);
    assert.equal(rows[2]!.label, "Sonnet 5");
    assert.equal(
      rows.some((r) => r.label === "claude-opus-5"),
      false,
      "raw model ids must not appear as labels when modelInfo is present",
    );
  });

  it("falls back to the raw id when modelInfo is empty", () => {
    const rows = buildModelRows(
      provider({
        modelInfo: [],
        models: ["claude-sonnet-4", "claude-opus-4"],
      }),
    );
    assert.equal(rows[0]!.label, "Default");
    assert.equal(rows[1]!.id, "claude-sonnet-4");
    assert.equal(rows[1]!.label, "claude-sonnet-4");
    assert.equal(rows[2]!.label, "claude-opus-4");
  });

  it("offers Default and Custom when models and modelInfo are both empty", () => {
    // Custom is what makes "the list is a suggestion" reachable: without it no
    // UI path can name an id the published snapshot does not know.
    const rows = buildModelRows(provider({ models: [], modelInfo: [] }));
    assert.deepEqual(
      rows.map((r) => r.id),
      [null, CUSTOM_MODEL_ID],
    );
  });

  it("ends every provider's group with a Custom row", () => {
    const rows = buildModelRows(provider());
    const last = rows[rows.length - 1];
    assert.equal(last.id, CUSTOM_MODEL_ID);
    assert.equal(
      rows.filter((r) => r.id === CUSTOM_MODEL_ID).length,
      1,
      "exactly one Custom row per provider",
    );
  });

  it("marks every row disabled when the provider CLI is missing", () => {
    const rows = buildModelRows(provider({ available: false }));
    assert.ok(rows.length > 0);
    assert.ok(
      rows.every((r) => r.disabled && r.unavailable),
      "unavailable provider rows must all be disabled",
    );
    assert.ok(rows.every((r) => r.disabledReason === "not installed"));
  });
});

describe("buildUnifiedModelRows", () => {
  it("lists every provider's Default and models in one flat list", () => {
    const rows = buildUnifiedModelRows(MULTI, "claude", false);
    const providers = [...new Set(rows.map((r) => r.providerId))];
    assert.deepEqual(providers, ["claude", "codex", "grok"]);
    // Each provider contributes Default + its models + Custom.
    // Claude: 1+2+1; Codex: 1+0+1; Grok: 1+1+1
    assert.equal(rows.length, 4 + 2 + 3);
    assert.ok(
      rows.some((r) => r.providerId === "claude" && r.label === "Sonnet 5"),
    );
    assert.ok(
      rows.some((r) => r.providerId === "codex" && r.id === null),
      "empty-list providers still get a Default row",
    );
    assert.ok(
      rows.some((r) => r.providerId === "grok" && r.label === "Grok 4"),
    );
  });

  it("disables unavailable provider rows but keeps them visible", () => {
    const rows = buildUnifiedModelRows(MULTI, "claude", false);
    const grok = rows.filter((r) => r.providerId === "grok");
    assert.ok(grok.length >= 1);
    assert.ok(grok.every((r) => r.disabled && r.unavailable));
    const claude = rows.filter((r) => r.providerId === "claude");
    assert.ok(claude.every((r) => !r.disabled));
  });

  it("session-locks other providers while current provider stays selectable", () => {
    const rows = buildUnifiedModelRows(MULTI, "claude", true, "Claude Code");
    const claude = rows.filter((r) => r.providerId === "claude");
    const codex = rows.filter((r) => r.providerId === "codex");
    assert.ok(
      claude.every((r) => !r.disabled),
      "current provider must stay selectable with a session",
    );
    assert.ok(
      codex.every((r) => r.disabled),
      "other providers must be locked when sessionId is set",
    );
    assert.equal(
      codex[0]!.disabledReason,
      sessionLockReason("Claude Code"),
    );
    // Unavailable grok stays "not installed", not the lock message.
    const grok = rows.filter((r) => r.providerId === "grok");
    assert.ok(grok.every((r) => r.disabledReason === "not installed"));
  });
});

describe("modelTriggerLabel", () => {
  it("uses the modelInfo label when known", () => {
    assert.equal(modelTriggerLabel("claude-sonnet-5", provider()), "Sonnet 5");
  });

  it("returns Default for null model", () => {
    assert.equal(modelTriggerLabel(null, provider()), "Default");
  });

  it("falls back to the raw id when modelInfo is missing the entry", () => {
    assert.equal(
      modelTriggerLabel("custom-x", provider({ modelInfo: [] })),
      "custom-x",
    );
  });
});

describe("detailModelRow and selection", () => {
  it("follows the highlight index over the selection", () => {
    const rows = buildUnifiedModelRows(MULTI, "claude", false);
    const sonnetIdx = rows.findIndex(
      (r) => r.id === "claude-sonnet-5" && r.providerId === "claude",
    );
    const detail = detailModelRow(rows, "claude", "claude-opus-5", sonnetIdx);
    assert.equal(detail.id, "claude-sonnet-5");
    assert.equal(detail.label, "Sonnet 5");
  });

  it("falls back to the selected row when highlight is undefined", () => {
    const rows = buildUnifiedModelRows(MULTI, "claude", false);
    const detail = detailModelRow(rows, "claude", "claude-opus-5", undefined);
    assert.equal(detail.id, "claude-opus-5");
    assert.equal(detail.providerId, "claude");
  });

  it("distinguishes Default rows of different providers", () => {
    const rows = buildUnifiedModelRows(MULTI, "codex", false);
    const detail = detailModelRow(rows, "codex", null, undefined);
    assert.equal(detail.providerId, "codex");
    assert.equal(detail.id, null);
    assert.equal(isRowSelected(rows[0]!, "claude", null), true);
    assert.equal(isRowSelected(rows[0]!, "codex", null), false);
  });

  it("rowKey is unique across providers sharing a null model id", () => {
    const rows = buildUnifiedModelRows(MULTI, "claude", false);
    const keys = rows.map(rowKey);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe("highlight helpers", () => {
  it("initialHighlightIndex finds the selected provider+model row", () => {
    const rows = buildUnifiedModelRows(MULTI, "claude", false);
    assert.equal(
      initialHighlightIndex(rows, "claude", "claude-sonnet-5"),
      rows.findIndex((r) => r.id === "claude-sonnet-5"),
    );
    assert.equal(initialHighlightIndex(rows, "claude", null), 0);
    assert.equal(
      initialHighlightIndex(rows, "missing", "nope"),
      firstSelectableIndex(rows),
    );
  });

  it("clampHighlightIndex stays in range", () => {
    const rows = buildModelRows(provider());
    assert.equal(clampHighlightIndex(rows, -3), 0);
    // Last row is Custom, so the clamp lands there, not on the last model.
    assert.equal(clampHighlightIndex(rows, 99), rows.length - 1);
    assert.equal(clampHighlightIndex(rows, 1), 1);
  });

  it("stepHighlightIndex skips disabled rows", () => {
    const rows = buildUnifiedModelRows(MULTI, "claude", true, "Claude Code");
    // Claude rows are 0..3 (Default, Opus, Sonnet, Custom); Codex starts at 4.
    const lastClaude = 3;
    const stepped = stepHighlightIndex(rows, lastClaude, 1);
    assert.equal(
      stepped,
      lastClaude,
      "ArrowDown from last selectable must not land on a locked row",
    );
    // From a locked row, ArrowUp should reach the last selectable.
    const fromLocked = stepHighlightIndex(rows, 4, -1);
    assert.equal(fromLocked, lastClaude);
    assert.equal(rows[fromLocked]!.disabled, false);
  });

  it("first and last selectable skip locked and unavailable rows", () => {
    // Only codex available? Use multi with session lock on claude current:
    // first selectable is claude Default (0); last is claude's Custom row (3),
    // since Custom belongs to the current provider and stays selectable.
    const rows = buildUnifiedModelRows(MULTI, "claude", true, "Claude Code");
    assert.equal(firstSelectableIndex(rows), 0);
    assert.equal(lastSelectableIndex(rows), 3);
    assert.equal(rows[lastSelectableIndex(rows)]!.disabled, false);
  });
});

describe("reasoning control", () => {
  it("hides when efforts is empty or missing", () => {
    assert.equal(showReasoningControl([]), false);
    assert.equal(showReasoningControl(undefined), false);
    assert.equal(showReasoningControl(null), false);
  });

  it("shows when at least one effort is advertised", () => {
    assert.equal(showReasoningControl(["low"]), true);
    assert.equal(showReasoningControl(["low", "high"]), true);
  });

  it("fills left-to-right up to the current level on the provider's list only", () => {
    // Grok-shaped list: three levels. Must not expand to REASONING_EFFORTS.
    const efforts: ReasoningEffort[] = ["low", "medium", "high"];
    const segs = effortSegments(efforts, "high");
    assert.equal(segs.length, 3);
    assert.notEqual(segs.length, REASONING_EFFORTS.length);
    assert.deepEqual(
      segs.map((s) => s.filled),
      [true, true, true],
    );
    assert.deepEqual(
      segs.map((s) => s.level),
      efforts,
    );
  });

  it("fills through xhigh on a full claude-shaped list", () => {
    const efforts: ReasoningEffort[] = [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ];
    const segs = effortSegments(efforts, "xhigh");
    assert.deepEqual(
      segs.map((s) => s.filled),
      [true, true, true, true, false],
    );
  });

  it("fills nothing when current effort is null (provider default)", () => {
    const segs = effortSegments(["low", "medium", "high"], null);
    assert.ok(segs.every((s) => !s.filled));
  });

  it("labels null as Default and maps each CLI token to a human word", () => {
    assert.equal(effortDisplayLabel(null), "Default");
    assert.equal(effortDisplayLabel("high"), "High");
    assert.equal(effortDisplayLabel("xhigh"), "Extra high");
    assert.equal(effortDisplayLabel("max"), "Max");
    assert.equal(effortDisplayLabel("low"), "Low");
    assert.equal(effortDisplayLabel("medium"), "Medium");
  });

  it("unified row carries the provider's efforts for the detail meter", () => {
    const rows = buildUnifiedModelRows(MULTI, "claude", false);
    const claude = rows.find((r) => r.providerId === "claude")!;
    const codex = rows.find((r) => r.providerId === "codex")!;
    const grok = rows.find((r) => r.providerId === "grok")!;
    assert.equal(claude.efforts.length, 5);
    assert.equal(codex.efforts.length, 0);
    assert.equal(grok.efforts.length, 3);
    assert.equal(showReasoningControl(claude.efforts), true);
    assert.equal(showReasoningControl(codex.efforts), false);
  });
});
