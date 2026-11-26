"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { claimStarPrompt } = require("../starPrompt.js");

it("claims the star prompt once across windows and module reloads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-star-"));
  try {
    assert.equal(claimStarPrompt(dir), true);
    assert.equal(claimStarPrompt(dir), false);
    delete require.cache[require.resolve("../starPrompt.js")];
    assert.equal(require("../starPrompt.js").claimStarPrompt(dir), false);
    assert.equal(claimStarPrompt(""), false);
    assert.equal(claimStarPrompt(path.join(dir, "missing")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
