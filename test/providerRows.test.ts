/**
 * Provider level of the drill-down picker.
 * Run: node --experimental-strip-types --test test/providerRows.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderInfo } from "../src/shared/ipc";
import {
  buildProviderRows,
  providerDetail,
  firstSelectableProvider,
  initialProviderIndex,
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
  p({ id: "kimi", name: "Kimi", models: [] }),
];

describe("buildProviderRows", () => {
  it("lists one row per provider, not per model", () => {
    const rows = buildProviderRows(LIST, "claude", false);
    assert.equal(rows.length, 4, "the first level is providers only");
    assert.deepEqual(
      rows.map((r) => r.id),
      ["claude", "codex", "grok", "kimi"],
    );
  });

  it("summarises how many models each offers", () => {
    const rows = buildProviderRows(LIST, "claude", false);
    assert.equal(rows[0]!.summary, "2 models");
    assert.equal(rows[1]!.summary, "1 model", "singular, not '1 models'");
    assert.equal(
      rows[3]!.summary,
      "Default only",
      "a provider with no list must say so rather than '0 models'",
    );
  });

  it("uses a SHORT badge on the row and keeps the reason for the tooltip", () => {
    // The lock reason is a sentence. Rendering it on the row wrapped to three
    // lines each, which made the list unreadable exactly when every row was
    // locked. The row shows a word; the sentence goes in the title.
    const locked = buildProviderRows(LIST, "claude", true);
    const codex = locked.find((r) => r.id === "codex");
    assert.equal(codex?.badge, "locked");
    assert.match(String(codex?.disabledReason), /claude code/i);
    assert.ok(
      String(codex?.disabledReason).length > String(codex?.badge).length,
      "the tooltip must carry more than the badge",
    );

    const rows = buildProviderRows(LIST, "claude", false);
    assert.equal(rows[0]!.badge, "2 models", "an open row badges its count");
    assert.equal(
      rows.find((r) => r.id === "grok")?.badge,
      "not installed",
    );
  });

  it("marks a missing CLI unavailable and says why", () => {
    const rows = buildProviderRows(LIST, "claude", false);
    const grok = rows.find((r) => r.id === "grok");
    assert.equal(grok?.disabled, true);
    assert.equal(grok?.unavailable, true);
    assert.equal(grok?.disabledReason, "not installed");
  });

  it("locks other providers once the thread has a session, never its own", () => {
    // Entering another harness mid-session breaks a resumable conversation.
    const rows = buildProviderRows(LIST, "claude", true);
    const claude = rows.find((r) => r.id === "claude");
    const codex = rows.find((r) => r.id === "codex");
    assert.equal(claude?.disabled, false, "the current provider stays open");
    assert.equal(codex?.disabled, true, "other providers are locked");
    assert.match(String(codex?.disabledReason), /claude code/i);
  });

  it("marks exactly one row as current", () => {
    const rows = buildProviderRows(LIST, "codex", false);
    assert.deepEqual(
      rows.filter((r) => r.current).map((r) => r.id),
      ["codex"],
    );
  });
});

describe("provider keyboard movement", () => {
  it("starts on the provider the thread is using", () => {
    const rows = buildProviderRows(LIST, "codex", false);
    assert.equal(rows[initialProviderIndex(rows, "codex")]!.id, "codex");
  });

  it("falls back to the first enterable row for an unknown provider", () => {
    const rows = buildProviderRows(LIST, "nope", false);
    assert.equal(initialProviderIndex(rows, "nope"), 0);
  });

  it("skips rows that cannot be entered", () => {
    const rows = buildProviderRows(LIST, "claude", false);
    // index 2 is grok (not installed) and must be stepped over.
    assert.equal(stepProviderIndex(rows, 1, 1), 3, "grok is skipped");
    assert.equal(stepProviderIndex(rows, 3, -1), 1, "and skipped going back");
  });

  it("stays put rather than wrapping at the ends", () => {
    const rows = buildProviderRows(LIST, "claude", false);
    assert.equal(stepProviderIndex(rows, 0, -1), 0);
    assert.equal(stepProviderIndex(rows, 3, 1), 3);
  });

  it("firstSelectableProvider skips a leading disabled row", () => {
    const rows = buildProviderRows(
      [p({ id: "grok", name: "Grok", available: false }), p()],
      "claude",
      false,
    );
    assert.equal(firstSelectableProvider(rows), 1);
  });
});

describe("opening on an unusable provider", () => {
  it("does not start on a provider that cannot be entered", () => {
    // A thread whose CLI was uninstalled would otherwise open on a dead row and
    // the user's first keypress would do nothing.
    const rows = buildProviderRows(LIST, "grok", false);
    const at = initialProviderIndex(rows, "grok");
    assert.equal(
      rows[at]!.disabled,
      false,
      "the opening highlight must be enterable",
    );
  });
});

describe("providerDetail", () => {
  // Five of its six outputs were unpinned: only `label` had a test, so efforts,
  // vendor, providerId and the entire description string were free to be
  // anything. providerId gates the reasoning meter.
  const rows = (current = "claude", locked = false) =>
    buildProviderRows(LIST, current, locked);

  it("describes the CURRENT provider", () => {
    const d = providerDetail(rows(), 0, LIST);
    assert.equal(d?.providerId, "claude");
    assert.equal(d?.label, "Claude Code");
    assert.equal(d?.vendor, "current harness");
    assert.match(d?.description ?? "", /2 models to choose from/);
    assert.match(d?.description ?? "", /Current harness for this thread/);
  });

  it("describes a foreign provider without claiming it is current", () => {
    const d = providerDetail(rows(), 1, LIST);
    assert.equal(d?.providerId, "codex");
    assert.equal(d?.vendor, "harness");
    assert.match(d?.description ?? "", /1 model to choose from/);
    assert.equal(
      /Current harness/.test(d?.description ?? ""),
      false,
      "only the thread's own provider may claim to be current",
    );
  });

  it("says a provider is not installed", () => {
    const d = providerDetail(rows(), 2, LIST);
    assert.equal(d?.providerId, "grok");
    assert.equal(d?.vendor, "not installed");
    assert.match(d?.description ?? "", /CLI not found/);
  });

  it("says a provider is locked by the session", () => {
    const locked = rows("claude", true);
    const at = locked.findIndex((r) => r.id === "codex");
    const d = providerDetail(locked, at, LIST);
    assert.match(d?.description ?? "", /Locked/);
    assert.match(d?.description ?? "", /session/);
  });

  it("says when a provider offers no model choice", () => {
    const at = rows().findIndex((r) => r.id === "kimi");
    const d = providerDetail(rows(), at, LIST);
    assert.match(d?.description ?? "", /No model choice/);
    assert.equal(
      /\d+ model/.test(d?.description ?? ""),
      false,
      "a provider with no list must not claim a count",
    );
  });

  it("carries THAT provider's efforts, not the first provider's", () => {
    // This gates the reasoning meter: taking providers[0].efforts would render
    // the wrong number of segments for every other provider.
    const withEfforts: ProviderInfo[] = [
      p({ id: "claude", efforts: ["low", "medium", "high", "xhigh", "max"] }),
      p({ id: "codex", name: "Codex", efforts: ["low", "medium"] }),
    ] as ProviderInfo[];
    const r = buildProviderRows(withEfforts, "claude", false);
    assert.equal(providerDetail(r, 0, withEfforts)?.efforts.length, 5);
    assert.equal(providerDetail(r, 1, withEfforts)?.efforts.length, 2);
  });
});
