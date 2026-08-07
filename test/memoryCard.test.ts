/**
 * Expanded memory card state machine.
 * Run: node --experimental-strip-types --test test/memoryCard.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryCardState } from "../src/memoryCard.ts";

const base = {
  expanding: false,
  hasFull: false,
  hasError: false,
  editRequested: false,
};

describe("memoryCardState", () => {
  it("shows a loading body while the fetch is in flight", () => {
    const s = memoryCardState({ ...base, expanding: true });
    assert.equal(s.loadingBody, true);
    assert.equal(s.editing, false);
    assert.equal(s.showError, false);
  });

  it("never offers Edit without the full body", () => {
    // Regression: entry.body in a list row is an excerpt (recent) or an FTS
    // snippet (search). Editing from it saved the truncation over the original.
    assert.equal(memoryCardState({ ...base }).canEdit, false);
    assert.equal(
      memoryCardState({ ...base, expanding: true }).canEdit,
      false,
      "loading",
    );
    assert.equal(
      memoryCardState({ ...base, hasError: true }).canEdit,
      false,
      "errored",
    );
    assert.equal(memoryCardState({ ...base, hasFull: true }).canEdit, true);
  });

  it("keeps the action row on screen whenever the form is not", () => {
    // Regression: a card that was asked to edit while loading, or whose get
    // failed, rendered only "Loading…" or the error: no Save, Cancel or Delete,
    // and with an error that state was permanent.
    for (const variant of [
      { ...base, editRequested: true, expanding: true },
      { ...base, editRequested: true, hasError: true },
      { ...base, editRequested: true },
      { ...base },
    ]) {
      const s = memoryCardState(variant);
      assert.equal(
        s.showActions,
        !s.editing,
        `actions must show unless the form does: ${JSON.stringify(variant)}`,
      );
      assert.ok(
        s.editing || s.showActions,
        `card must never lose every control: ${JSON.stringify(variant)}`,
      );
    }
  });

  it("shows the form only once the body is really there", () => {
    assert.equal(
      memoryCardState({ ...base, editRequested: true, expanding: true }).editing,
      false,
      "still loading",
    );
    assert.equal(
      memoryCardState({ ...base, editRequested: true, hasError: true }).editing,
      false,
      "get failed",
    );
    assert.equal(
      memoryCardState({ ...base, editRequested: true, hasFull: true }).editing,
      true,
    );
  });

  it("prefers an arrived body over a stale in-flight flag", () => {
    const s = memoryCardState({ ...base, expanding: true, hasFull: true });
    assert.equal(s.loadingBody, false);
    assert.equal(s.canEdit, true);
  });

  it("an error beats a loading spinner once the fetch settled", () => {
    const s = memoryCardState({ ...base, hasError: true });
    assert.equal(s.showError, true);
    assert.equal(s.loadingBody, false);
    assert.equal(s.showActions, true, "Delete must stay reachable on a bad row");
  });
});
