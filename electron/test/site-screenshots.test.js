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

const SITE = path.join(ROOT, "site");
const PAGE_FILES = ["index.html", "docs.html", "changelog.html"];
const CARD_URL = "https://solenta.app/assets/card.png?v=2";

test("social preview images use the canonical 1200x630 canvas", () => {
  for (const name of ["og.png", "card.png"]) {
    assert.deepEqual(
      pngSize(path.join(ASSETS, name)),
      { width: 1200, height: 630 },
      name,
    );
  }
});

test("public screenshot and social-card URLs carry the light capture version", () => {
  const index = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  assert.match(index, /src="assets\/screen-main\.png\?v=2"/);
  assert.match(index, /src="assets\/screen-agents\.png\?v=2"/);
  assert.match(index, /src="assets\/screen-automations\.png\?v=2"/);
  assert.match(index, /src="assets\/screen-kanban\.png\?v=2"/);

  for (const page of PAGE_FILES) {
    const html = fs.readFileSync(path.join(SITE, page), "utf8");
    assert.ok(html.includes(CARD_URL), `${page} must reference ${CARD_URL}`);
    assert.doesNotMatch(
      html,
      /https:\/\/solenta\.app\/assets\/card\.png"/,
      `${page} must not retain an unversioned card URL`,
    );
  }
});
