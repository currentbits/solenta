/**
 * Expanded memory card state machine + keyed per-card actions.
 * Run: node --experimental-strip-types --test test/memoryCard.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  actionErrorFor,
  afterCollapse,
  beginConfirmDelete,
  cancelConfirmDelete,
  cancelEdit,
  clearAllCardActions,
  clearEntryActions,
  draftFor,
  emptyCardActions,
  isConfirmDelete,
  isEditing,
  memoryCardState,
  setActionError,
  setDraft,
  startEdit,
} from "../src/memoryCard.ts";

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

describe("keyed card actions (draft survival + isolation)", () => {
  it("keeps a mid-edit draft across collapse and re-expand", () => {
    // Defect 1: toggleExpand used to clearCardActions() and wipe the draft.
    // afterCollapse must leave draft + editing so re-expand restores the form.
    let actions = emptyCardActions();
    actions = startEdit(actions, "a", "Title A", "full body A");
    actions = setDraft(actions, "a", {
      title: "Title A edited",
      body: "user typed this and must not lose it",
    });

    actions = afterCollapse(actions, "a");

    assert.equal(isEditing(actions, "a"), true, "edit intent survives collapse");
    const draft = draftFor(actions, "a");
    assert.ok(draft, "draft must still be present after collapse");
    assert.equal(draft!.title, "Title A edited");
    assert.equal(draft!.body, "user typed this and must not lose it");

    // Re-expand is just expandedId === "a" again; pure state still drives the form.
    const view = memoryCardState({
      expanding: false,
      hasFull: true,
      hasError: false,
      editRequested: isEditing(actions, "a"),
    });
    assert.equal(view.editing, true, "form returns on re-expand");
    assert.equal(view.showActions, false);
  });

  it("afterCollapse never discards a dirty draft (mutation target)", () => {
    // If someone "fixes" collapse by wiping editing/drafts, this fails.
    let actions = startEdit(emptyCardActions(), "x", "t", "b");
    actions = setDraft(actions, "x", { title: "dirty", body: "draft body" });
    const collapsed = afterCollapse(actions, "x");
    assert.deepEqual(draftFor(collapsed, "x"), {
      title: "dirty",
      body: "draft body",
    });
    assert.equal(isEditing(collapsed, "x"), true);
    // confirm chrome may clear; draft must not.
    assert.equal(isConfirmDelete(collapsed, "x"), false);
  });

  it("card B never surfaces card A's error, confirm, or draft", () => {
    // Defect 2: un-keyed actionError / editId / confirmDeleteId painted on any open card.
    let actions = emptyCardActions();
    actions = startEdit(actions, "a", "A title", "A body");
    actions = setDraft(actions, "a", { title: "A draft title", body: "A draft body" });
    actions = setActionError(actions, "a", "save failed on A");
    actions = beginConfirmDelete(actions, "a");
    // Re-set error after for the isolation check on errors map structure.
    actions = setActionError(actions, "a", "save failed on A");

    // Card B reads
    assert.equal(isEditing(actions, "b"), false);
    assert.equal(draftFor(actions, "b"), null);
    assert.equal(isConfirmDelete(actions, "b"), false);
    assert.equal(actionErrorFor(actions, "b"), null);

    // Card A still owns its state
    assert.equal(draftFor(actions, "a")?.body, "A draft body");
    assert.equal(isConfirmDelete(actions, "a"), true);
    assert.equal(actionErrorFor(actions, "a"), "save failed on A");

    // Structural proof: maps are keyed; there is no global scalar to "leak".
    assert.ok("a" in actions.drafts);
    assert.ok(!("b" in actions.drafts));
    assert.ok("a" in actions.errors);
    assert.ok(!("b" in actions.errors));
    assert.ok("a" in actions.confirmDelete);
    assert.ok(!("b" in actions.confirmDelete));
  });

  it("setting state for A cannot put the same values under B's keys", () => {
    // Mutation that reintroduces global slots would typically assign one
    // editId / actionError for the whole tab; keyed helpers must keep A and B
    // disjoint even after both have activity.
    let actions = emptyCardActions();
    actions = startEdit(actions, "a", "ta", "ba");
    actions = setDraft(actions, "a", { title: "da", body: "body-a" });
    actions = setActionError(actions, "a", "err-a");

    actions = startEdit(actions, "b", "tb", "bb");
    actions = setDraft(actions, "b", { title: "db", body: "body-b" });
    actions = beginConfirmDelete(actions, "b");
    // Confirm clears that card's prior error; set the error after to prove
    // independent error slots.
    actions = setActionError(actions, "b", "err-b");

    assert.equal(draftFor(actions, "a")?.body, "body-a");
    assert.equal(draftFor(actions, "b")?.body, "body-b");
    assert.equal(actionErrorFor(actions, "a"), "err-a");
    assert.equal(actionErrorFor(actions, "b"), "err-b");
    assert.equal(isConfirmDelete(actions, "a"), false);
    assert.equal(isConfirmDelete(actions, "b"), true);
    assert.notEqual(draftFor(actions, "a")?.body, draftFor(actions, "b")?.body);
  });

  it("cancelEdit drops draft so Cancel is a real discard", () => {
    let actions = startEdit(emptyCardActions(), "a", "t", "b");
    actions = setDraft(actions, "a", { title: "x", body: "y" });
    actions = cancelEdit(actions, "a");
    assert.equal(isEditing(actions, "a"), false);
    assert.equal(draftFor(actions, "a"), null);
  });

  it("clearAllCardActions wipes every card (list reload)", () => {
    let actions = startEdit(emptyCardActions(), "a", "t", "b");
    actions = setActionError(actions, "b", "e");
    actions = beginConfirmDelete(actions, "c");
    actions = clearAllCardActions();
    assert.deepEqual(actions, emptyCardActions());
  });

  it("clearEntryActions only clears that entry", () => {
    let actions = startEdit(emptyCardActions(), "a", "ta", "ba");
    actions = startEdit(actions, "b", "tb", "bb");
    actions = clearEntryActions(actions, "a");
    assert.equal(draftFor(actions, "a"), null);
    assert.equal(isEditing(actions, "b"), true);
    assert.equal(draftFor(actions, "b")?.title, "tb");
  });

  it("setDraft is a no-op when the entry is not editing", () => {
    const actions = setDraft(emptyCardActions(), "a", {
      title: "ghost",
      body: "should not stick",
    });
    assert.equal(draftFor(actions, "a"), null);
  });


  it("cancelConfirmDelete only clears confirm for that id", () => {
    let actions = beginConfirmDelete(emptyCardActions(), "a");
    actions = beginConfirmDelete(actions, "b");
    actions = cancelConfirmDelete(actions, "a");
    assert.equal(isConfirmDelete(actions, "a"), false);
    assert.equal(isConfirmDelete(actions, "b"), true);
  });
});
