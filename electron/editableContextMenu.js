"use strict";

/**
 * Native editable-field menu (issue #1801). Electron shows no context menu
 * on its own; without this, right-click in any text input (including the
 * composer) does nothing -- no Cut/Copy/Paste, no spellcheck suggestions.
 *
 * Built straight from the raw webContents 'context-menu' event params so it
 * is unit-testable without a window. Gated on params.isEditable: every other
 * right-click in the app (images, attachment chips, thread cards, ...)
 * already has its own menu built in the renderer via showContextMenu /
 * contextMenu:show, and must see nothing from here.
 */

/**
 * @typedef {{
 *   isEditable?: boolean,
 *   misspelledWord?: string,
 *   dictionarySuggestions?: string[],
 *   editFlags?: {
 *     canCut?: boolean,
 *     canCopy?: boolean,
 *     canPaste?: boolean,
 *     canSelectAll?: boolean,
 *   },
 * }} EditableMenuParams
 */

/**
 * @typedef {{
 *   onSuggestion: (word: string) => void,
 *   onAddToDictionary: (word: string) => void,
 *   onCut: () => void,
 *   onCopy: () => void,
 *   onPaste: () => void,
 *   onSelectAll: () => void,
 * }} EditableMenuActions
 */

const MAX_SUGGESTIONS = 6;

/**
 * @param {EditableMenuParams | null | undefined} params
 * @param {EditableMenuActions} actions
 * @returns {import("electron").MenuItemConstructorOptions[]}
 */
function buildEditableMenuTemplate(params, actions) {
  if (!params || !params.isEditable) return [];
  const template = [];
  const word = params.misspelledWord;

  if (word) {
    const suggestions = Array.isArray(params.dictionarySuggestions)
      ? params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)
      : [];
    if (suggestions.length > 0) {
      for (const suggestion of suggestions) {
        template.push({
          label: suggestion,
          click: () => actions.onSuggestion(suggestion),
        });
      }
    } else {
      template.push({ label: "No Guesses Found", enabled: false });
    }
    template.push({ type: "separator" });
    template.push({
      label: "Add to Dictionary",
      click: () => actions.onAddToDictionary(word),
    });
    template.push({ type: "separator" });
  }

  const flags = params.editFlags || {};
  template.push({
    label: "Cut",
    enabled: flags.canCut !== false,
    click: () => actions.onCut(),
  });
  template.push({
    label: "Copy",
    enabled: flags.canCopy !== false,
    click: () => actions.onCopy(),
  });
  template.push({
    label: "Paste",
    enabled: flags.canPaste !== false,
    click: () => actions.onPaste(),
  });
  template.push({ type: "separator" });
  template.push({
    label: "Select All",
    enabled: flags.canSelectAll !== false,
    click: () => actions.onSelectAll(),
  });
  return template;
}

module.exports = { buildEditableMenuTemplate, MAX_SUGGESTIONS };
