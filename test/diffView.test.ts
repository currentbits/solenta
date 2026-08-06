/**
 * Pure helpers for the center Changes panel (tinted patch + empty state).
 * Run: node --experimental-strip-types --test test/diffView.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffLineKind, isEmptyDiff } from "../src/diffView.ts";
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
