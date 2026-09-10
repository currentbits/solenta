/**
 * Split-view pairing for checkpoint-to-checkpoint hunks (#148).
 *
 * Run: node --experimental-strip-types --test test/turnDiff.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitHunkRows, splitLineText } from "../src/turnDiff.ts";

describe("splitLineText", () => {
  it("strips unified-diff prefixes for add/del/context", () => {
    assert.equal(splitLineText("+added", "add"), "added");
    assert.equal(splitLineText("-removed", "del"), "removed");
    assert.equal(splitLineText(" keep", "ctx"), "keep");
  });

  it("leaves hunk headers and no-newline markers intact", () => {
    assert.equal(splitLineText("@@ -1,2 +1,2 @@", "hunk"), "@@ -1,2 +1,2 @@");
    assert.equal(splitLineText("\\ No newline at end of file", "ctx"), "\\ No newline at end of file");
  });
});

describe("splitHunkRows", () => {
  it("pairs a one-for-one replacement on the same row", () => {
    const rows = splitHunkRows(
      "@@ -1,3 +1,3 @@",
      [" keep", "-old", "+new", " keep"].join("\n"),
    );
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.left.kind, "ctx");
    assert.equal(rows[0]!.left.text, "keep");
    assert.equal(rows[0]!.left.line, 1);
    assert.equal(rows[0]!.right.kind, "ctx");
    assert.equal(rows[0]!.right.text, "keep");
    assert.equal(rows[0]!.right.line, 1);

    assert.equal(rows[1]!.left.kind, "del");
    assert.equal(rows[1]!.left.text, "old");
    assert.equal(rows[1]!.left.line, 2);
    assert.equal(rows[1]!.right.kind, "add");
    assert.equal(rows[1]!.right.text, "new");
    assert.equal(rows[1]!.right.line, 2);

    assert.equal(rows[2]!.left.line, 3);
    assert.equal(rows[2]!.right.line, 3);
  });

  it("pads the shorter side when deletions and additions differ", () => {
    const rows = splitHunkRows(
      "@@ -1,3 +1,2 @@",
      ["-a", "-b", "+c"].join("\n"),
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.left.text, "a");
    assert.equal(rows[0]!.right.text, "c");
    assert.equal(rows[1]!.left.text, "b");
    assert.equal(rows[1]!.right.kind, "empty");
    assert.equal(rows[1]!.right.text, "");
    assert.equal(rows[1]!.right.line, null);
  });

  it("puts a new-file hunk entirely on the right", () => {
    const rows = splitHunkRows(
      "@@ -0,0 +1,2 @@",
      ["+one", "+two"].join("\n"),
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.left.kind, "empty");
    assert.equal(rows[0]!.right.kind, "add");
    assert.equal(rows[0]!.right.text, "one");
    assert.equal(rows[0]!.right.line, 1);
    assert.equal(rows[1]!.right.text, "two");
    assert.equal(rows[1]!.right.line, 2);
  });

  it("puts a deleted-file hunk entirely on the left", () => {
    const rows = splitHunkRows(
      "@@ -1,2 +0,0 @@",
      ["-one", "-two"].join("\n"),
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.left.kind, "del");
    assert.equal(rows[0]!.left.text, "one");
    assert.equal(rows[0]!.right.kind, "empty");
    assert.equal(rows[1]!.left.text, "two");
  });
});
