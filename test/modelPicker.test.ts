/**
 * Pure model-picker decisions (no DOM).
 * Run: node --experimental-strip-types --test test/modelPicker.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderInfo, ReasoningEffort } from "../src/shared/ipc";
import { REASONING_EFFORTS } from "../src/shared/ipc";
import {
  buildModelRows,
  clampHighlightIndex,
  detailModelRow,
  effortDisplayLabel,
  effortSegments,
  initialHighlightIndex,
  modelTriggerLabel,
  showReasoningControl,
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

describe("buildModelRows", () => {
  it("leads with Default, then modelInfo labels (never raw ids as labels when info exists)", () => {
    const rows = buildModelRows(provider());
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.id, null);
    assert.equal(rows[0]!.label, "Default");
    assert.equal(rows[1]!.label, "Opus 5");
    assert.equal(rows[1]!.vendor, "Anthropic");
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

  it("returns only Default when models and modelInfo are both empty", () => {
    const rows = buildModelRows(provider({ models: [], modelInfo: [] }));
    assert.deepEqual(
      rows.map((r) => r.id),
      [null],
    );
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

describe("detailModelRow", () => {
  it("follows the highlight over the selection", () => {
    const rows = buildModelRows(provider());
    const detail = detailModelRow(rows, "claude-opus-5", "claude-sonnet-5");
    assert.equal(detail.id, "claude-sonnet-5");
    assert.equal(detail.label, "Sonnet 5");
  });

  it("falls back to the selected row when highlight is undefined", () => {
    const rows = buildModelRows(provider());
    const detail = detailModelRow(rows, "claude-opus-5", undefined);
    assert.equal(detail.id, "claude-opus-5");
  });

  it("falls back to Default when nothing matches", () => {
    const rows = buildModelRows(provider());
    const detail = detailModelRow(rows, "missing", "also-missing");
    assert.equal(detail.id, null);
    assert.equal(detail.label, "Default");
  });
});

describe("highlight helpers", () => {
  it("initialHighlightIndex finds the selected row", () => {
    const rows = buildModelRows(provider());
    assert.equal(initialHighlightIndex(rows, "claude-sonnet-5"), 2);
    assert.equal(initialHighlightIndex(rows, null), 0);
    assert.equal(initialHighlightIndex(rows, "nope"), 0);
  });

  it("clampHighlightIndex stays in range", () => {
    const rows = buildModelRows(provider());
    assert.equal(clampHighlightIndex(rows, -3), 0);
    assert.equal(clampHighlightIndex(rows, 99), 2);
    assert.equal(clampHighlightIndex(rows, 1), 1);
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
});
