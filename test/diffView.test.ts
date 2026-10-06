/**
 * Pure helpers for the center Changes panel (tinted patch + empty state).
 * Run: node --experimental-strip-types --test test/diffView.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  annotateHunkLines,
  diffLineKind,
  formatReviewCommentsPrompt,
  reviewCommentFromAnchors,
  reviewCommentLabel,
  isEmptyDiff,
  parseHunkHeader,
} from "../src/diffView.ts";
import type { DiffResult } from "../src/shared/ipc.ts";

describe("diffLineKind", () => {
  it("classifies unified-diff line prefixes for tinting", () => {
    assert.equal(diffLineKind("+added line"), "add");
    assert.equal(diffLineKind("-removed line"), "del");
    assert.equal(diffLineKind("@@ -1,2 +3,4 @@"), "hunk");
    assert.equal(diffLineKind("--- a/file"), "meta");
    assert.equal(diffLineKind("+++ b/file"), "meta");
    assert.equal(diffLineKind(" context"), "ctx");
    assert.equal(diffLineKind(""), "ctx");
  });

  it("treats +++ and --- as meta, not add/del", () => {
    assert.equal(diffLineKind("+++ b/foo"), "meta");
    assert.equal(diffLineKind("--- a/foo"), "meta");
  });
});

describe("isEmptyDiff", () => {
  it("is true only when files empty and patch blank", () => {
    const empty: DiffResult = { files: [], patch: "", truncated: false };
    assert.equal(isEmptyDiff(empty), true);
    assert.equal(isEmptyDiff({ ...empty, patch: "   \n" }), true);
    assert.equal(
      isEmptyDiff({
        files: [{ path: "a.ts", status: "M", additions: 1, deletions: 0 }],
        patch: "",
        truncated: false,
      }),
      false,
    );
    assert.equal(
      isEmptyDiff({ files: [], patch: "+x\n", truncated: false }),
      false,
    );
  });
});

describe("parseHunkHeader", () => {
  it("reads old/new starts and counts", () => {
    assert.deepEqual(parseHunkHeader("@@ -10,3 +12,4 @@"), {
      oldStart: 10,
      oldCount: 3,
      newStart: 12,
      newCount: 4,
    });
  });

  it("defaults omitted counts to 1", () => {
    assert.deepEqual(parseHunkHeader("@@ -1 +1 @@"), {
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
    });
  });

  it("parses a new-file hunk", () => {
    assert.deepEqual(parseHunkHeader("@@ -0,0 +1,2 @@"), {
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: 2,
    });
  });

  it("returns null for a non-hunk line", () => {
    assert.equal(parseHunkHeader("+added"), null);
    assert.equal(parseHunkHeader("@@ garbage"), null);
  });
});

describe("annotateHunkLines", () => {
  it("assigns old/new line numbers and marks code lines commentable", () => {
    const lines = annotateHunkLines(
      "@@ -10,3 +10,4 @@",
      [" keep", "-old", "+new", " context"].join("\n"),
    );
    assert.deepEqual(
      lines.map((l) => ({
        kind: l.kind,
        oldLine: l.oldLine,
        newLine: l.newLine,
        commentable: l.commentable,
      })),
      [
        { kind: "ctx", oldLine: 10, newLine: 10, commentable: true },
        { kind: "del", oldLine: 11, newLine: null, commentable: true },
        { kind: "add", oldLine: null, newLine: 11, commentable: true },
        { kind: "ctx", oldLine: 12, newLine: 12, commentable: true },
      ],
    );
  });

  it("does not spend a line number on the no-newline marker", () => {
    const lines = annotateHunkLines("@@ -1 +1 @@", "+x\n\\ No newline at end of file");
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.kind, "add");
    assert.equal(lines[0]?.newLine, 1);
    assert.equal(lines[0]?.commentable, true);
    assert.equal(lines[1]?.commentable, false);
    assert.equal(lines[1]?.oldLine, null);
    assert.equal(lines[1]?.newLine, null);
  });

  it("treats +++ inside a hunk body as an added line, not meta", () => {
    const lines = annotateHunkLines("@@ -1 +1,2 @@", " keep\n+++ still added");
    assert.equal(lines[1]?.kind, "add");
    assert.equal(lines[1]?.commentable, true);
    assert.equal(lines[1]?.newLine, 2);
  });
});

describe("review comments (#1493)", () => {
  const add = (n: number, text: string) => ({
    path: "src/foo.ts",
    kind: "add" as const,
    text,
    oldLine: null,
    newLine: n,
  });

  it("anchors a single added line on the new-file number", () => {
    const c = reviewCommentFromAnchors([add(42, "+  const x = 1;")], " use Y ", "c1");
    assert.equal(reviewCommentLabel(c), "src/foo.ts:L42");
    assert.equal(c.text, "use Y");
    const prompt = formatReviewCommentsPrompt([c]);
    assert.match(prompt, /^Review comment:\n\nsrc\/foo\.ts:L42\n/);
    assert.match(prompt, /\n    \+  const x = 1;\n/);
    assert.match(prompt, /\nuse Y$/);
  });

  it("spans a range and ignores removed rows inside it", () => {
    const c = reviewCommentFromAnchors(
      [
        add(12, "+a"),
        { path: "src/foo.ts", kind: "del", text: "-b", oldLine: 9, newLine: null },
        add(18, "+c"),
      ],
      "tidy",
      "c2",
    );
    assert.equal(reviewCommentLabel(c), "src/foo.ts:L12-18");
    assert.equal(c.code, "+a\n-b\n+c");
  });

  it("labels an all-removed pick with old-file lines", () => {
    const c = reviewCommentFromAnchors(
      [{ path: "src/foo.ts", kind: "del", text: "-keepMe()", oldLine: 18, newLine: null }],
      "do not delete this",
      "c3",
    );
    assert.equal(reviewCommentLabel(c), "src/foo.ts (removed L18)");
  });

  it("falls back to path-only when line numbers are missing", () => {
    const c = reviewCommentFromAnchors(
      [{ path: "notes.txt", kind: "add", text: "+hello", oldLine: null, newLine: null }],
      "rename this",
      "c4",
    );
    assert.equal(reviewCommentLabel(c), "notes.txt");
  });

  it("batches several comments into one block and drops blank ones", () => {
    const a = reviewCommentFromAnchors([add(1, "+x")], "one", "a");
    const b = reviewCommentFromAnchors([add(2, "+y")], "two", "b");
    const blank = reviewCommentFromAnchors([add(3, "+z")], "  ", "c");
    const prompt = formatReviewCommentsPrompt([a, blank, b]);
    assert.match(prompt, /^Review comments:\n/);
    assert.match(prompt, /L1\n    \+x\n\none\n\nsrc\/foo\.ts:L2/);
    assert.doesNotMatch(prompt, /L3/);
    assert.equal(formatReviewCommentsPrompt([blank]), "");
  });

  it("caps the code excerpt", () => {
    const rows = Array.from({ length: 20 }, (_, i) => add(i + 1, `+l${i}`));
    const prompt = formatReviewCommentsPrompt([
      reviewCommentFromAnchors(rows, "long", "d"),
    ]);
    assert.match(prompt, /… 8 more lines/);
    assert.doesNotMatch(prompt, /l12/);
  });
});
