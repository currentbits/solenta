/**
 * summarizeReleaseNotes (issue #1757): turns a GitHub release body into a
 * short "what's new" summary. Run: node --experimental-strip-types --test test/releaseNotes.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  summarizeReleaseNotes,
  RELEASE_SUMMARY_MAX_CHARS,
  RELEASE_SUMMARY_MAX_BULLETS,
} from "../src/releaseNotes.ts";

describe("summarizeReleaseNotes", () => {
  it("returns nothing for empty/missing bodies", () => {
    assert.deepEqual(summarizeReleaseNotes(null), []);
    assert.deepEqual(summarizeReleaseNotes(undefined), []);
    assert.deepEqual(summarizeReleaseNotes(""), []);
    assert.deepEqual(summarizeReleaseNotes("   \n  "), []);
  });

  it("takes the first paragraph when there is no bullet list (nightly body)", () => {
    const body = "Nightly build from abc1234.";
    assert.deepEqual(summarizeReleaseNotes(body), [body]);
  });

  it("strips <details> blocks and HTML comments before summarizing", () => {
    const body = [
      "<!-- generated -->",
      "A short paragraph of notes.",
      "<details><summary>Full diff</summary>huge noisy stuff</details>",
    ].join("\n\n");
    assert.deepEqual(summarizeReleaseNotes(body), ["A short paragraph of notes."]);
  });

  it("prefers bullets under a Highlights/Added/New heading", () => {
    const body = [
      "## Highlights",
      "- Faster cold start",
      "- Fixed a crash on quit",
      "",
      "## What's Changed",
      "* unrelated PR title (#99) by @bob in https://github.com/x/y/pull/99",
    ].join("\n");
    assert.deepEqual(summarizeReleaseNotes(body), [
      "Faster cold start",
      "Fixed a crash on quit",
    ]);
  });

  it("falls back to the first bullet list (gh --generate-notes shape) and strips PR/issue noise", () => {
    const body = [
      "## What's Changed",
      "* feat: add update notes popover (#1757) by @willem in https://github.com/currentbits/solenta/pull/1757",
      "* fix: something small (#1750) by @bob in https://github.com/currentbits/solenta/pull/1750",
      "",
      "## New Contributors",
      "* @newperson made their first contribution in #1750",
      "",
      "**Full Changelog**: https://github.com/currentbits/solenta/compare/v0.10.0...v0.11.0",
    ].join("\n");
    assert.deepEqual(summarizeReleaseNotes(body), [
      "feat: add update notes popover",
      "fix: something small",
    ]);
  });

  it("caps bullets at RELEASE_SUMMARY_MAX_BULLETS", () => {
    const bullets = Array.from({ length: 9 }, (_, i) => `- item ${i}`);
    const out = summarizeReleaseNotes(bullets.join("\n"));
    assert.equal(out.length, RELEASE_SUMMARY_MAX_BULLETS);
    assert.deepEqual(out, ["item 0", "item 1", "item 2", "item 3", "item 4"]);
  });

  it("caps total length at RELEASE_SUMMARY_MAX_CHARS and ellipsizes the line it stops on", () => {
    const long = "x".repeat(400);
    const out = summarizeReleaseNotes(long);
    assert.equal(out.length, 1);
    assert.ok(out[0].length <= RELEASE_SUMMARY_MAX_CHARS);
    assert.ok(out[0].endsWith("…"));
  });

  it("never emits an em-dash", () => {
    const body = [
      "## Highlights",
      "- Before — after still works",
    ].join("\n");
    for (const line of summarizeReleaseNotes(body)) {
      assert.ok(!line.includes("—"), `unexpected em-dash in: ${line}`);
    }
  });
});
