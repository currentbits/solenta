"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const ASSETS = path.join(ROOT, "site", "assets");
const SCREENSHOTS = [
  "screen-main.png",
  "screen-agents.png",
  "screen-automations.png",
  "screen-kanban.png",
];

function pngSize(file) {
  const data = fs.readFileSync(file);
  assert.equal(
    data.subarray(1, 4).toString("ascii"),
    "PNG",
    `${path.basename(file)} must be a PNG`,
  );
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

test("site product screenshots use the canonical 1680x1050 canvas", () => {
  for (const name of SCREENSHOTS) {
    assert.deepEqual(
      pngSize(path.join(ASSETS, name)),
      { width: 1680, height: 1050 },
      name,
    );
  }
});
