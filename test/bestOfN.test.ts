/**
 * Pure Best of N plan: de-dupe, installed-only, 2+ required.
 * Run: node --experimental-strip-types --test test/bestOfN.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProfile, ProviderInfo } from "../src/shared/ipc";
import {
  buildBestOfNEntries,
  buildBestOfNPlan,
  providerVendor,
} from "../src/bestOfN";

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

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "prof-scout",
    name: "Cheap scout",
    provider: "claude",
    model: "haiku",
    reasoningEffort: "low",
    permissionMode: "plan",
    ...over,
  };
}

describe("buildBestOfNEntries", () => {
  const scout = profile();
  const deep = profile({
    id: "prof-deep",
    name: "Deep worker",
    provider: "codex",
    model: "gpt-5",
    reasoningEffort: "high",
    permissionMode: "acceptEdits",
  });
  const missing = profile({
    id: "prof-gone",
    name: "Grok scout",
    provider: "grok",
    model: "grok-4",
    reasoningEffort: null,
    permissionMode: "default",
  });

  it("keeps a provider-only pick identical to buildBestOfNPlan", () => {
    const selected = ["kimi", "claude", "codex"];
    const ids = buildBestOfNPlan(AVAILABLE, selected, "claude");
    const entries = buildBestOfNEntries(AVAILABLE, selected, "claude");
    assert.ok(Array.isArray(ids));
    assert.ok(Array.isArray(entries));
    assert.deepEqual(
      entries,
      ids.map((id) => ({ kind: "provider", id, provider: id })),
    );
  });

  it("mixes a profile and a provider in first-seen order", () => {
    const plan = buildBestOfNEntries(
      AVAILABLE,
      [scout.id, "kimi"],
      "claude",
      [scout, deep],
    );
    assert.deepEqual(plan, [
      {
        kind: "profile",
        id: "prof-scout",
        provider: "claude",
        model: "haiku",
        reasoningEffort: "low",
        permissionMode: "plan",
      },
      { kind: "provider", id: "kimi", provider: "kimi" },
    ]);
  });

  it("dedupes selected ids while keeping the first occurrence", () => {
    const plan = buildBestOfNEntries(
      AVAILABLE,
      [scout.id, "kimi", scout.id, "kimi"],
      "claude",
      [scout],
    );
    assert.deepEqual(plan, [
      {
        kind: "profile",
        id: "prof-scout",
        provider: "claude",
        model: "haiku",
        reasoningEffort: "low",
        permissionMode: "plan",
      },
      { kind: "provider", id: "kimi", provider: "kimi" },
    ]);
  });

  it("drops a profile whose provider is not installed", () => {
    const plan = buildBestOfNEntries(
      AVAILABLE,
      [missing.id, scout.id, "kimi"],
      "claude",
      [missing, scout],
    );
    assert.deepEqual(plan, [
      {
        kind: "profile",
        id: "prof-scout",
        provider: "claude",
        model: "haiku",
        reasoningEffort: "low",
        permissionMode: "plan",
      },
      { kind: "provider", id: "kimi", provider: "kimi" },
    ]);
  });

  it("rejects fewer than two surviving entries", () => {
    assert.equal(
      buildBestOfNEntries(AVAILABLE, [scout.id], "claude", [scout]),
      "Select at least two installed providers",
    );
    assert.equal(
      buildBestOfNEntries(
        AVAILABLE,
        [missing.id, scout.id],
        "claude",
        [missing, scout],
      ),
      "Select at least two installed providers",
    );
    assert.equal(
      buildBestOfNEntries(AVAILABLE, [scout.id, scout.id], "claude", [scout]),
      "Select at least two installed providers",
    );
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
