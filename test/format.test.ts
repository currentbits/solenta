/**
 * Relative age + working elapsed labels for the sidebar.
 * Run: node --experimental-strip-types --test test/format.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatBytes,
  formatWorktreeUsage,
  formatRelativeAge,
  formatWorkingLabel,
  formatClockTime,
  formatTimeTooltip,
  middleTruncate,
  shortModelName,
  providerDisplayName,
  PERMISSION_MODES,
  providerPermissionModes,
  permissionPickerModes,
  snapToHonouredPermissionMode,
} from "../src/format.ts";

describe("formatRelativeAge", () => {
  const now = 1_700_000_000_000;

  it('returns "now" under 60 seconds', () => {
    assert.equal(formatRelativeAge(now - 0, now), "now");
    assert.equal(formatRelativeAge(now - 59_000, now), "now");
  });

  it("returns minutes under an hour", () => {
    assert.equal(formatRelativeAge(now - 3 * 60_000, now), "3m");
    assert.equal(formatRelativeAge(now - 59 * 60_000, now), "59m");
  });

  it("returns hours under a day", () => {
    assert.equal(formatRelativeAge(now - 2 * 3_600_000, now), "2h");
  });

  it("returns days for longer spans", () => {
    assert.equal(formatRelativeAge(now - 5 * 86_400_000, now), "5d");
  });
});

describe("formatWorkingLabel", () => {
  const now = 1_700_000_000_000;

  it("shows seconds under one minute", () => {
    assert.equal(formatWorkingLabel(now - 12_000, now), "Working 12s");
    assert.equal(formatWorkingLabel(now - 0, now), "Working 0s");
    assert.equal(formatWorkingLabel(now - 59_000, now), "Working 59s");
  });

  it("shows whole minutes under one hour", () => {
    assert.equal(formatWorkingLabel(now - 3 * 60_000, now), "Working 3m");
    assert.equal(formatWorkingLabel(now - 59 * 60_000, now), "Working 59m");
  });

  it("shows hours and remaining minutes", () => {
    assert.equal(
      formatWorkingLabel(now - (1 * 3_600_000 + 4 * 60_000), now),
      "Working 1h 4m",
    );
    assert.equal(formatWorkingLabel(now - 2 * 3_600_000, now), "Working 2h");
  });
});

describe("shortModelName", () => {
  it("strips the leading provider segment from claude model ids", () => {
    assert.equal(shortModelName("claude-fable-5"), "fable-5");
    assert.equal(shortModelName("claude-opus-5"), "opus-5");
    assert.equal(shortModelName("claude-haiku-4-5"), "haiku-4-5");
  });

  it("returns the id unchanged when there is no hyphen", () => {
    assert.equal(shortModelName("default"), "default");
  });
});

describe("formatBytes", () => {
  it("formats bytes, kilobytes, and megabytes", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
    assert.equal(formatBytes(12 * 1024 * 1024), "12 MB");
  });
});

describe("formatWorktreeUsage", () => {
  it("omits bytes when they are unknown", () => {
    assert.equal(formatWorktreeUsage(119), "worktrees · 119");
    assert.equal(formatWorktreeUsage(119, 0), "worktrees · 119");
  });

  it("puts size first when bytes are known (#559)", () => {
    assert.equal(
      formatWorktreeUsage(3, 5 * 1024 * 1024),
      "worktrees 5.0 MB · 3",
    );
  });
});

describe("providerDisplayName", () => {
  const providers = [
    {
      id: "claude",
      name: "Claude Code",
      available: true,
      supportsResume: true,
      models: [] as string[],
      modelInfo: [],
      efforts: [],
    },
  ];

  it("returns ProviderInfo.name when known", () => {
    assert.equal(providerDisplayName("claude", providers), "Claude Code");
  });

  it("falls back to the raw id when unknown", () => {
    assert.equal(providerDisplayName("generic", providers), "generic");
  });
});

describe("providerPermissionModes", () => {
  it("treats a missing field as the full set so legacy fixtures stay clickable", () => {
    assert.deepEqual(
      providerPermissionModes({
        id: "claude",
        name: "Claude Code",
        available: true,
        supportsResume: true,
        models: [],
        modelInfo: [],
        efforts: [],
      }),
      PERMISSION_MODES,
    );
  });

  it("honours an explicit list, including a single Full access mode", () => {
    assert.deepEqual(
      providerPermissionModes({
        id: "kimi",
        name: "Kimi",
        available: true,
        supportsResume: true,
        models: [],
        modelInfo: [],
        efforts: [],
        permissionModes: ["bypassPermissions"],
      }),
      ["bypassPermissions"],
    );
  });

  it("lists a leftover current mode first when it is not honoured", () => {
    assert.deepEqual(
      permissionPickerModes("default", ["plan", "bypassPermissions"]),
      ["default", "plan", "bypassPermissions"],
    );
    assert.deepEqual(
      permissionPickerModes("plan", ["plan", "bypassPermissions"]),
      ["plan", "bypassPermissions"],
    );
  });

  it("snaps asking modes to Full access on unprompted CLIs", () => {
    assert.equal(
      snapToHonouredPermissionMode(["plan", "bypassPermissions"], "default"),
      "bypassPermissions",
    );
    assert.equal(
      snapToHonouredPermissionMode(["default", "bypassPermissions"], "plan"),
      "default",
    );
    assert.equal(
      snapToHonouredPermissionMode(["default", "bypassPermissions"], "acceptEdits"),
      "bypassPermissions",
    );
    assert.equal(
      snapToHonouredPermissionMode(["default", "bypassPermissions"], "auto"),
      "default",
    );
  });
});

describe("formatClockTime / formatTimeTooltip", () => {
  it("formats a plain local time with no date for today", () => {
    const now = new Date(2026, 9, 24, 9, 0, 0).getTime();
    const t = new Date(2026, 9, 24, 14, 32, 5).getTime();
    assert.equal(formatClockTime(t, now), "14:32:05");
  });

  it("prefixes a short date when the timestamp is not today", () => {
    const now = new Date(2026, 9, 24, 9, 0, 0).getTime();
    const t = new Date(2026, 9, 20, 14, 32, 5).getTime();
    assert.equal(formatClockTime(t, now), "Oct 20 14:32:05");
  });

  it("appends a duration when an end time is known", () => {
    const start = new Date(2026, 9, 24, 14, 32, 5).getTime();
    const end = start + 64_000;
    assert.equal(formatTimeTooltip(start, end, start), "14:32:05 · 1m");
  });

  it("omits the duration with no end time, or an end at/before start", () => {
    const start = new Date(2026, 9, 24, 14, 32, 5).getTime();
    assert.equal(formatTimeTooltip(start, null, start), "14:32:05");
    assert.equal(formatTimeTooltip(start, start, start), "14:32:05");
  });
});

describe("middleTruncate", () => {
  it("leaves short strings untouched", () => {
    assert.equal(middleTruncate("abc", 10), "abc");
    assert.equal(middleTruncate("", 10), "");
  });

  it("leaves a string exactly at max untouched", () => {
    assert.equal(middleTruncate("0123456789", 10), "0123456789");
  });

  it("keeps the start and end with one ellipsis in the middle", () => {
    const out = middleTruncate("0123456789abcdefghij", 11);
    assert.equal(out.length, 11);
    assert.ok(out.includes("…"));
    assert.ok(out.startsWith("0"));
    assert.ok(out.endsWith("j"));
  });

  it("favours the tail when endBias leans toward the end", () => {
    // 30 chars down to 12: a branch-style bias keeps more of the suffix.
    const out = middleTruncate("feat/add-the-thing-35693f-xyz", 12, 0.65);
    assert.equal(out.length, 12);
    assert.ok(out.endsWith("3f-xyz"));
  });

  it("is unicode-safe: never splits a surrogate pair", () => {
    const emoji = "😀".repeat(10); // 10 code points, 20 UTF-16 code units
    const out = middleTruncate(emoji, 5);
    assert.equal(Array.from(out).length, 5);
    assert.ok(!out.includes("�"));
    // Every remaining char (besides the ellipsis) is a full emoji, not a
    // lone surrogate half.
    for (const ch of out) {
      assert.ok(ch === "…" || ch === "😀");
    }
  });

  it("handles a tiny max", () => {
    assert.equal(middleTruncate("abcdef", 1), "…");
    assert.equal(middleTruncate("abcdef", 0), "");
    assert.equal(middleTruncate("abcdef", 2).length, 2);
  });
});
