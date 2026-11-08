"use strict";

// The homepage ships static JSON-LD for search and answer engines (many AI
// crawlers do not run JS). Search engines penalise FAQ markup that differs
// from the visible page, so the FAQPage must mirror #faq word for word.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "site", "index.html"), "utf8");
const { document } = new JSDOM(html).window;
const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) =>
  JSON.parse(s.textContent),
);
const byType = (t) => blocks.find((b) => b["@type"] === t);

test("homepage JSON-LD parses and describes a free SoftwareApplication", () => {
  const app = byType("SoftwareApplication");
  assert.ok(app, "SoftwareApplication block");
  assert.equal(app.name, "Solenta");
  assert.equal(app.offers.price, "0");
  assert.equal(app.description, document.querySelector('meta[name="description"]').content);
});

test("SoftwareApplication tracks the newest documented release", () => {
  const changelog = fs.readFileSync(path.join(__dirname, "..", "..", "site", "changelog.html"), "utf8");
  const newest = new JSDOM(changelog).window.document.querySelector("h2").textContent.match(/^[\d.]+/)[0];
  const app = byType("SoftwareApplication");
  assert.equal(app.softwareVersion, newest, "update the homepage JSON-LD when adding a release");
  assert.equal(app.isAccessibleForFree, true);
  assert.equal(app.releaseNotes, "https://solenta.app/changelog.html");
});

test("FAQPage JSON-LD mirrors the visible #faq entries", () => {
  const visible = [...document.querySelectorAll("#faq details")].map((d) => [
    d.querySelector("summary").textContent.trim(),
    d.querySelector("p").textContent.trim(),
  ]);
  const marked = byType("FAQPage").mainEntity.map((q) => [q.name, q.acceptedAnswer.text]);
  assert.deepEqual(marked, visible);
});
