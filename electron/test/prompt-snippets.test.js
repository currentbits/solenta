/**
 * Issue #189: promptSnippets setting — strict on settings:set, healing on
 * disk read.
 * Run: npm run test:electron
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");

describe("promptSnippets setting", () => {
  it("defaults to [], saves valid rows, rejects bad ones, heals junk on load", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-snippets-"));
    const file = path.join(tmpDir, "store.json");
    const store = new Store(file);
    assert.deepEqual(store.getSettings().promptSnippets, []);

    const rows = [{ name: "run-tests", text: "Run the tests first." }];
    assert.deepEqual(store.setSettings({ promptSnippets: rows }).promptSnippets, rows);

    assert.throws(() => store.setSettings({ promptSnippets: "x" }), /must be an array/);
    assert.throws(
      () => store.setSettings({ promptSnippets: [{ name: "has space", text: "t" }] }),
      /Snippet name/,
    );
    assert.throws(
      () => store.setSettings({ promptSnippets: [{ name: "a", text: "  " }] }),
      /text must be/,
    );
    assert.throws(
      () => store.setSettings({ promptSnippets: [...rows, ...rows] }),
      /Duplicate snippet name/,
    );
    assert.deepEqual(store.getSettings().promptSnippets, rows, "failed sets keep the old list");

    store.data.settings.promptSnippets = [...rows, { name: "" }, rows[0], 7];
    store.saveNow();
    assert.deepEqual(new Store(file).getSettings().promptSnippets, rows);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
