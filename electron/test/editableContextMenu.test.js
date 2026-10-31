const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildEditableMenuTemplate,
} = require("../editableContextMenu.js");

function actions() {
  const calls = [];
  return {
    calls,
    onSuggestion: (word) => calls.push(["suggestion", word]),
    onAddToDictionary: (word) => calls.push(["addToDictionary", word]),
    onCut: () => calls.push(["cut"]),
    onCopy: () => calls.push(["copy"]),
    onPaste: () => calls.push(["paste"]),
    onSelectAll: () => calls.push(["selectAll"]),
  };
}

function clickLabel(template, label) {
  const item = template.find((t) => t.label === label);
  assert.ok(item, `expected a "${label}" item`);
  item.click();
}

describe("editable-field context menu template (#1801)", () => {
  it("not editable (images, attachment chips, ...): empty, so the renderer's own menu wins", () => {
    assert.deepEqual(buildEditableMenuTemplate({ isEditable: false }, actions()), []);
    assert.deepEqual(buildEditableMenuTemplate(null, actions()), []);
    assert.deepEqual(buildEditableMenuTemplate(undefined, actions()), []);
  });

  it("editable, no misspelling: plain Cut/Copy/Paste/Select All, no suggestions", () => {
    const template = buildEditableMenuTemplate(
      { isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } },
      actions(),
    );
    const labels = template.map((t) => t.label ?? "separator");
    assert.deepEqual(labels, ["Cut", "Copy", "Paste", "separator", "Select All"]);
  });

  it("editable with a misspelling and suggestions: suggestions, Add to Dictionary, then Cut/Copy/Paste", () => {
    const a = actions();
    const template = buildEditableMenuTemplate(
      {
        isEditable: true,
        misspelledWord: "teh",
        dictionarySuggestions: ["the", "ten"],
        editFlags: {},
      },
      a,
    );
    const labels = template.map((t) => t.label ?? "separator");
    assert.deepEqual(labels, [
      "the",
      "ten",
      "separator",
      "Add to Dictionary",
      "separator",
      "Cut",
      "Copy",
      "Paste",
      "separator",
      "Select All",
    ]);
    clickLabel(template, "the");
    clickLabel(template, "Add to Dictionary");
    assert.deepEqual(a.calls, [
      ["suggestion", "the"],
      ["addToDictionary", "teh"],
    ]);
  });

  it("misspelling with zero suggestions: disabled placeholder, still offers Add to Dictionary", () => {
    const template = buildEditableMenuTemplate(
      { isEditable: true, misspelledWord: "xqz", dictionarySuggestions: [], editFlags: {} },
      actions(),
    );
    const placeholder = template.find((t) => t.label === "No Guesses Found");
    assert.ok(placeholder);
    assert.equal(placeholder.enabled, false);
    assert.ok(template.some((t) => t.label === "Add to Dictionary"));
  });

  it("caps suggestions at 6", () => {
    const template = buildEditableMenuTemplate(
      {
        isEditable: true,
        misspelledWord: "x",
        dictionarySuggestions: ["a", "b", "c", "d", "e", "f", "g", "h"],
        editFlags: {},
      },
      actions(),
    );
    const suggestionLabels = template
      .slice(0, template.findIndex((t) => t.type === "separator"))
      .map((t) => t.label);
    assert.equal(suggestionLabels.length, 6);
  });

  it("editFlags gate enabled on Cut/Copy/Paste/Select All", () => {
    const template = buildEditableMenuTemplate(
      {
        isEditable: true,
        editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
      },
      actions(),
    );
    assert.equal(template.find((t) => t.label === "Cut").enabled, false);
    assert.equal(template.find((t) => t.label === "Copy").enabled, false);
    assert.equal(template.find((t) => t.label === "Paste").enabled, false);
    assert.equal(template.find((t) => t.label === "Select All").enabled, false);
  });

  it("wires Cut/Copy/Paste/Select All to the matching action", () => {
    const a = actions();
    const template = buildEditableMenuTemplate({ isEditable: true, editFlags: {} }, a);
    clickLabel(template, "Cut");
    clickLabel(template, "Copy");
    clickLabel(template, "Paste");
    clickLabel(template, "Select All");
    assert.deepEqual(a.calls, [["cut"], ["copy"], ["paste"], ["selectAll"]]);
  });
});
