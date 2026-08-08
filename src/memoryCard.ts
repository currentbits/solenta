/**
 * What an expanded memory card shows, and how per-card action state is keyed.
 * Pure so it can be tested without a DOM.
 *
 * Two display rules this encodes, both learned the hard way:
 * 1. Edit is only offered once the FULL body has arrived. List rows carry an
 *    excerpt (recent) or an FTS snippet with [] markers (search), so editing
 *    from a list row would save the truncation over the real body.
 * 2. The action row renders whenever the edit form is not actually on screen.
 *    Keying it off "edit was requested" instead loses every control (Save,
 *    Cancel, Delete) on a card whose body is still loading or failed to load.
 *
 * Action state is keyed by entry id so card A's draft, confirm, or error can
 * never paint on card B. Collapse does not discard a draft: the draft and the
 * "still editing" intent stay under that entry id and reappear on re-expand.
 */

export interface MemoryCardState {
  /** Body fetch in flight and nothing to show yet. */
  loadingBody: boolean;
  /** The get failed; show the error instead of a body. */
  showError: boolean;
  /** The edit form is on screen. */
  editing: boolean;
  /** Edit/Delete row is on screen. */
  showActions: boolean;
  /** Edit is clickable (full body present). */
  canEdit: boolean;
}

export function memoryCardState(input: {
  /** This card's body fetch is in flight. */
  expanding: boolean;
  /** The full body has arrived. */
  hasFull: boolean;
  /** The body fetch failed. */
  hasError: boolean;
  /** The user asked to edit this card (or a draft is still open for it). */
  editRequested: boolean;
}): MemoryCardState {
  const loadingBody = input.expanding && !input.hasFull && !input.hasError;
  const showError = !loadingBody && input.hasError;
  const editing = input.editRequested && !loadingBody && !showError;
  return {
    loadingBody,
    showError,
    editing,
    showActions: !editing,
    canEdit: input.hasFull,
  };
}

// --- Per-card action state (keyed by entry id) --------------------------------

export interface EditDraft {
  title: string;
  body: string;
}

/**
 * All mutable per-card UI (draft, edit intent, delete confirm, action error)
 * lives under the entry id it belongs to. A single global slot is forbidden:
 * it would let card A's error/confirm/draft appear on card B.
 */
export interface CardActionsById {
  drafts: Record<string, EditDraft>;
  /** Entry is mid-edit (including while collapsed). */
  editing: Record<string, true>;
  confirmDelete: Record<string, true>;
  errors: Record<string, string>;
}

export function emptyCardActions(): CardActionsById {
  return { drafts: {}, editing: {}, confirmDelete: {}, errors: {} };
}

function omitKey<T>(map: Record<string, T>, id: string): Record<string, T> {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

/** Read helpers: always scoped to one entry id. */
export function isEditing(actions: CardActionsById, entryId: string): boolean {
  return actions.editing[entryId] === true;
}

export function draftFor(
  actions: CardActionsById,
  entryId: string,
): EditDraft | null {
  return actions.drafts[entryId] ?? null;
}

export function isConfirmDelete(
  actions: CardActionsById,
  entryId: string,
): boolean {
  return actions.confirmDelete[entryId] === true;
}

export function actionErrorFor(
  actions: CardActionsById,
  entryId: string,
): string | null {
  return actions.errors[entryId] ?? null;
}

/**
 * Begin edit (or re-seed when starting fresh after cancel). Seeds the draft
 * from the full body so the form never opens on a list excerpt.
 */
export function startEdit(
  actions: CardActionsById,
  entryId: string,
  title: string,
  body: string,
): CardActionsById {
  return {
    drafts: { ...actions.drafts, [entryId]: { title, body } },
    editing: { ...actions.editing, [entryId]: true },
    confirmDelete: omitKey(actions.confirmDelete, entryId),
    errors: omitKey(actions.errors, entryId),
  };
}

/** Typing in the open form. No-op if this entry is not editing. */
export function setDraft(
  actions: CardActionsById,
  entryId: string,
  draft: EditDraft,
): CardActionsById {
  if (!isEditing(actions, entryId)) return actions;
  return {
    ...actions,
    drafts: { ...actions.drafts, [entryId]: draft },
  };
}

/**
 * Collapse/expand must not discard drafts. Only drop the delete-confirm chrome
 * for this card (it is meaningless while collapsed); leave draft + editing.
 */
export function afterCollapse(
  actions: CardActionsById,
  entryId: string,
): CardActionsById {
  if (!actions.confirmDelete[entryId]) return actions;
  return {
    ...actions,
    confirmDelete: omitKey(actions.confirmDelete, entryId),
  };
}

/** Cancel leaves no draft and no edit intent for this entry. */
export function cancelEdit(
  actions: CardActionsById,
  entryId: string,
): CardActionsById {
  return {
    drafts: omitKey(actions.drafts, entryId),
    editing: omitKey(actions.editing, entryId),
    confirmDelete: omitKey(actions.confirmDelete, entryId),
    errors: omitKey(actions.errors, entryId),
  };
}

/** Successful save/delete: clear every action slot for this entry. */
export function clearEntryActions(
  actions: CardActionsById,
  entryId: string,
): CardActionsById {
  return cancelEdit(actions, entryId);
}

/** List reload / remount: wipe all cards (entries may no longer exist). */
export function clearAllCardActions(): CardActionsById {
  return emptyCardActions();
}

export function beginConfirmDelete(
  actions: CardActionsById,
  entryId: string,
): CardActionsById {
  return {
    ...actions,
    confirmDelete: { ...actions.confirmDelete, [entryId]: true },
    errors: omitKey(actions.errors, entryId),
  };
}

export function cancelConfirmDelete(
  actions: CardActionsById,
  entryId: string,
): CardActionsById {
  return {
    ...actions,
    confirmDelete: omitKey(actions.confirmDelete, entryId),
  };
}

export function setActionError(
  actions: CardActionsById,
  entryId: string,
  message: string,
): CardActionsById {
  return {
    ...actions,
    errors: { ...actions.errors, [entryId]: message },
  };
}

export function clearActionError(
  actions: CardActionsById,
  entryId: string,
): CardActionsById {
  return {
    ...actions,
    errors: omitKey(actions.errors, entryId),
  };
}

