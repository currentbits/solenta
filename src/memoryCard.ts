/**
 * What an expanded memory card shows. Pure so it can be tested without a DOM.
 *
 * Two rules this encodes, both learned the hard way:
 * 1. Edit is only offered once the FULL body has arrived. List rows carry an
 *    excerpt (recent) or an FTS snippet with [] markers (search), so editing
 *    from a list row would save the truncation over the real body.
 * 2. The action row renders whenever the edit form is not actually on screen.
 *    Keying it off "edit was requested" instead loses every control (Save,
 *    Cancel, Delete) on a card whose body is still loading or failed to load.
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
  /** The user asked to edit this card. */
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
