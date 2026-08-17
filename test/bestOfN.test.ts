/**
 * Pure Best of N plan: de-dupe, installed-only, 2+ required.
 * Run: node --experimental-strip-types --test test/bestOfN.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProfile, ProviderInfo } from "../src/shared/ipc";
import { buildBestOfNEntries, providerVendor } from "../src/bestOfN";

const AVAILABLE = ["claude", "codex", "kimi"];

/** Entry ids, for the provider-only cases where the kind is not the point. */
function ids(plan: ReturnType<typeof buildBestOfNEntries>): string[] {
  assert.ok(Array.isArray(plan), `expected a plan, got ${String(plan)}`);
  return plan.map((e) => e.id);
}

describe("buildBestOfNEntries, providers only", () => {
  it("returns selected installed ids in first-seen order", () => {
    const plan = buildBestOfNEntries(AVAILABLE, ["kimi", "claude", "codex"]);
    assert.deepEqual(ids(plan), ["kimi", "claude", "codex"]);
  });

  it("marks every provider-only entry as a bare provider override", () => {
    // Regression guard: a provider row must keep inheriting model and
    // permission from the source thread, so it carries no profile fields.
    const plan = buildBestOfNEntries(AVAILABLE, ["kimi", "claude"]);
    assert.deepEqual(plan, [
      { kind: "provider", id: "kimi", provider: "kimi" },
      { kind: "provider", id: "claude", provider: "claude" },
    ]);
  });

  it("dedupes while keeping the first occurrence", () => {
    const plan = buildBestOfNEntries(AVAILABLE, [
      "codex",
      "claude",
      "codex",
      "claude",
    ]);
    assert.deepEqual(ids(plan), ["codex", "claude"]);
  });

  it("drops ids that are not installed", () => {
    const plan = buildBestOfNEntries(AVAILABLE, [
      "claude",
      "grok",
      "codex",
      "opencode",
    ]);
    assert.deepEqual(ids(plan), ["claude", "codex"]);
  });

  it("plans only what was selected, never auto-inserting a provider", () => {
    const plan = buildBestOfNEntries(AVAILABLE, ["codex", "kimi"]);
    assert.deepEqual(ids(plan), ["codex", "kimi"]);
  });

  it("rejects fewer than two installed selections", () => {
    assert.equal(
      buildBestOfNEntries(AVAILABLE, ["claude"]),
      "Select at least two installed providers",
    );
    assert.equal(
      buildBestOfNEntries(AVAILABLE, ["claude", "claude", "grok"]),
      "Select at least two installed providers",
    );
    assert.equal(
      buildBestOfNEntries(AVAILABLE, []),
      "Select at least two installed providers",
    );
  });

  it("skips empty selected ids", () => {
    const plan = buildBestOfNEntries(AVAILABLE, ["", "claude", "codex"]);
    assert.deepEqual(ids(plan), ["claude", "codex"]);
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

  it("mixes a profile and a provider in first-seen order", () => {
    const plan = buildBestOfNEntries(
      AVAILABLE,
      [scout.id, "kimi"],
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
      buildBestOfNEntries(AVAILABLE, [scout.id], [scout]),
      "Select at least two installed providers",
    );
    assert.equal(
      buildBestOfNEntries(
        AVAILABLE,
        [missing.id, scout.id],
        [missing, scout],
      ),
      "Select at least two installed providers",
    );
    assert.equal(
      buildBestOfNEntries(AVAILABLE, [scout.id, scout.id], [scout]),
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
