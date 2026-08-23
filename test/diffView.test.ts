/**
 * Pure helpers for the center Changes panel (tinted patch + empty state).
 * Run: node --experimental-strip-types --test test/diffView.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  annotateHunkLines,
  diffLineKind,
  formatDiffCommentPrompt,
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

describe("formatDiffCommentPrompt", () => {
  it("anchors an added line on the new-file number and quotes it", () => {
    const prompt = formatDiffCommentPrompt(
      {
        path: "src/foo.ts",
        kind: "add",
        text: "+  const x = 1;",
        oldLine: null,
        newLine: 42,
      },
      "use Y instead",
    );
    assert.match(prompt, /^Comment on src\/foo\.ts:42:\n/);
    assert.match(prompt, /\n    \+  const x = 1;\n/);
    assert.match(prompt, /\nuse Y instead$/);
  });

  it("labels a deletion with the old-file line", () => {
    const prompt = formatDiffCommentPrompt(
      {
        path: "src/foo.ts",
        kind: "del",
        text: "-  keepMe()",
        oldLine: 18,
        newLine: null,
      },
      "do not delete this",
    );
    assert.match(prompt, /^Comment on src\/foo\.ts \(removed line 18\):\n/);
    assert.match(prompt, /\n    -  keepMe\(\)\n/);
    assert.match(prompt, /\ndo not delete this$/);
  });

  it("falls back to path-only when line numbers are missing", () => {
    const prompt = formatDiffCommentPrompt(
      {
        path: "notes.txt",
        kind: "add",
        text: "+hello",
        oldLine: null,
        newLine: null,
      },
      "rename this",
    );
    assert.match(prompt, /^Comment on notes\.txt:\n/);
    assert.doesNotMatch(prompt, /line /);
    assert.match(prompt, /\nrename this$/);
  });

  it("trims the comment and refuses a blank one", () => {
    assert.equal(
      formatDiffCommentPrompt(
        {
          path: "a.ts",
          kind: "ctx",
          text: " keep",
          oldLine: 1,
          newLine: 1,
        },
        "   \n",
      ),
      "",
    );
  });
});
