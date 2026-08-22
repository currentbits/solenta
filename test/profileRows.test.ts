/**
 * Saved agent profiles in the model picker's first level.
 * Run: node --experimental-strip-types --test test/profileRows.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProfile, ProviderInfo } from "../src/shared/ipc";
import {
  buildProfileRows,
  profileSummary,
  stepProviderIndex,
} from "../src/modelPicker";

function p(over: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: ["a", "b"],
    modelInfo: [],
    efforts: [],
    ...over,
  } as ProviderInfo;
}

const LIST: ProviderInfo[] = [
  p(),
  p({ id: "codex", name: "Codex", models: ["x"] }),
  p({ id: "grok", name: "Grok", available: false, models: ["g"] }),
];

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "p1",
    name: "Cheap scout",
    provider: "claude",
    model: "haiku",
    reasoningEffort: "low",
    permissionMode: "plan",
    ...over,
  };
}

describe("buildProfileRows", () => {
  it("enables a profile whose provider is installed", () => {
    const rows = buildProfileRows([profile()], LIST);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.disabled, false);
    assert.equal(rows[0]!.disabledReason, null);
    assert.equal(rows[0]!.name, "Cheap scout");
  });

  it("disables a profile whose provider is not installed", () => {
    const rows = buildProfileRows(
      [profile({ id: "p2", name: "Grok worker", provider: "grok" })],
      LIST,
    );
    assert.equal(rows[0]!.disabled, true);
    assert.equal(rows[0]!.disabledReason, "not installed");
  });

  it("disables a profile whose provider is missing from the registry", () => {
    const rows = buildProfileRows(
      [profile({ provider: "nope" })],
      LIST,
    );
    assert.equal(rows[0]!.disabled, true);
    assert.equal(rows[0]!.disabledReason, "not installed");
  });

  it("returns nothing when no profiles are saved", () => {
    assert.deepEqual(buildProfileRows([], LIST), []);
  });
});

describe("profileSummary", () => {
  it("joins provider, model, effort, and permission", () => {
    assert.equal(
      profileSummary(profile(), LIST),
      "Claude Code · haiku · Low · Plan mode",
    );
  });

  it("prefers the ModelInfo label over the raw id", () => {
    const known = p({
      modelInfo: [
        {
          id: "haiku",
          label: "Haiku 4.5",
          description: "",
          vendor: "Anthropic",
        },
      ],
    });
    assert.equal(
      profileSummary(profile(), [known]),
      "Claude Code · Haiku 4.5 · Low · Plan mode",
    );
  });

  it("says Default for a null model and Auto for a null effort", () => {
    // Two different nulls, two different words: the model pill and the effort
    // pill sit side by side and used to both read "Default".
    assert.equal(
      profileSummary(
        profile({ model: null, reasoningEffort: null, permissionMode: "default" }),
        LIST,
      ),
      "Claude Code · Default · Auto · Ask first",
    );
  });

  it("says Default for an empty model id", () => {
    assert.match(
      profileSummary(profile({ model: "" }), LIST),
      /^Claude Code · Default · /,
    );
  });

  it("falls back to the raw provider id when the registry has none", () => {
    assert.equal(
      profileSummary(profile({ provider: "nope", model: null }), LIST),
      "nope · Default · Low · Plan mode",
    );
  });
});

describe("keyboard across profiles then providers", () => {
  it("steps from a profile onto the first enterable provider", () => {
    const profiles = buildProfileRows([profile()], LIST);
    const mixed = [
      ...profiles,
      { disabled: false },
      { disabled: true },
      { disabled: false },
    ];
    assert.equal(stepProviderIndex(mixed, 0, 1), 1);
    assert.equal(stepProviderIndex(mixed, 1, 1), 3, "skips the disabled provider");
    assert.equal(stepProviderIndex(mixed, 1, -1), 0);
  });
});
