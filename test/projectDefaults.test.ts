/**
 * Per-project default-worktree override (#1775): the project's own
 * defaultWorktree wins over the global setting; null/absent falls through.
 *
 * Run: npm run test:renderer -- test/projectDefaults.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDefaultWorktree } from "../src/projectDefaults";

describe("resolveDefaultWorktree", () => {
  it("falls through to the global default when the project has no override", () => {
    assert.equal(resolveDefaultWorktree(null, true), true);
    assert.equal(resolveDefaultWorktree(undefined, false), false);
    assert.equal(resolveDefaultWorktree({}, true), true);
    assert.equal(resolveDefaultWorktree({ defaultWorktree: null }, true), true);
  });

  it("a project override of true wins over a global false", () => {
    assert.equal(
      resolveDefaultWorktree({ defaultWorktree: true }, false),
      true,
    );
  });

  it("a project override of false wins over a global true", () => {
    assert.equal(
      resolveDefaultWorktree({ defaultWorktree: false }, true),
      false,
    );
  });
});
