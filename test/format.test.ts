/**
 * Relative age + working elapsed labels for the sidebar.
 * Run: node --experimental-strip-types --test test/format.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatBytes,
  formatRelativeAge,
  formatWorkingLabel,
  shortModelName,
  providerDisplayName,
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
