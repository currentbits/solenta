/**
 * Pure Best of N plan: de-dupe, installed-only, 2+ required.
 * Run: node --experimental-strip-types --test test/bestOfN.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderInfo } from "../src/shared/ipc";
import { buildBestOfNPlan, providerVendor } from "../src/bestOfN";

const AVAILABLE = ["claude", "codex", "kimi"];

describe("buildBestOfNPlan", () => {
  it("returns selected installed ids in first-seen order", () => {
    const plan = buildBestOfNPlan(
      AVAILABLE,
      ["kimi", "claude", "codex"],
      "claude",
    );
    assert.deepEqual(plan, ["kimi", "claude", "codex"]);
  });

  it("dedupes while keeping the first occurrence", () => {
    const plan = buildBestOfNPlan(
      AVAILABLE,
      ["codex", "claude", "codex", "claude"],
      "kimi",
    );
    assert.deepEqual(plan, ["codex", "claude"]);
  });

  it("drops ids that are not installed", () => {
    const plan = buildBestOfNPlan(
      AVAILABLE,
      ["claude", "grok", "codex", "opencode"],
      "claude",
    );
    assert.deepEqual(plan, ["claude", "codex"]);
  });

  it("allows the current provider when it is installed and selected", () => {
    const plan = buildBestOfNPlan(AVAILABLE, ["claude", "kimi"], "claude");
    assert.deepEqual(plan, ["claude", "kimi"]);
  });

  it("does not auto-insert the current provider when it was not selected", () => {
    const plan = buildBestOfNPlan(AVAILABLE, ["codex", "kimi"], "claude");
    assert.deepEqual(plan, ["codex", "kimi"]);
  });

  it("rejects fewer than two installed selections", () => {
    assert.equal(
      buildBestOfNPlan(AVAILABLE, ["claude"], "claude"),
      "Select at least two installed providers",
    );
    assert.equal(
      buildBestOfNPlan(AVAILABLE, ["claude", "claude", "grok"], "claude"),
      "Select at least two installed providers",
    );
    assert.equal(
      buildBestOfNPlan(AVAILABLE, [], "claude"),
      "Select at least two installed providers",
    );
  });

  it("skips empty selected ids", () => {
    const plan = buildBestOfNPlan(AVAILABLE, ["", "claude", "codex"], "claude");
    assert.deepEqual(plan, ["claude", "codex"]);
  });
});

describe("providerVendor", () => {
  it("reads the first modelInfo vendor and falls back to empty", () => {
    const withVendor: ProviderInfo = {
      id: "claude",
      name: "Claude Code",
      available: true,
      supportsResume: true,
      models: ["sonnet"],
      modelInfo: [
        {
          id: "sonnet",
          label: "Sonnet",
          description: "",
          vendor: "Anthropic",
        },
      ],
      efforts: [],
    };
    const bare: ProviderInfo = {
      id: "codex",
      name: "Codex",
      available: true,
      supportsResume: false,
      models: [],
      modelInfo: [],
      efforts: [],
    };
    assert.equal(providerVendor(withVendor), "Anthropic");
    assert.equal(providerVendor(bare), "");
  });
});
