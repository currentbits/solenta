"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SITE = path.join(__dirname, "..", "..", "site");
const PAGES = ["index.html", "docs.html", "changelog.html"];

function read(name) {
  return fs.readFileSync(path.join(SITE, name), "utf8");
}

test("every public page dropped Plausible and loads stats.js", () => {
  for (const name of PAGES) {
    const html = read(name);
    assert.equal(html.includes("plausible.io"), false, name);
    assert.equal(html.includes("plausible-event-"), false, name);
    assert.match(html, /src="stats\.js"/, name);
  }
});

test("homepage CTAs use data-event and data-platform", () => {
  const html = read("index.html");
  assert.match(html, /data-event="Docs"/);
  assert.match(html, /data-event="Changelog"/);
  assert.match(html, /data-event="GitHub Repo"/);
  assert.match(html, /data-event="Download"/);
  assert.match(html, /data-event="GitHub Star"/);
  assert.match(html, /data-event="All downloads"/);
  assert.match(html, /data-platform="mac"/);
  assert.match(html, /id="hero-dl"[^>]*data-platform="unknown"/);
});

function loadStats(url) {
  const html = read("index.html");
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const beacons = [];
  dom.window.navigator.sendBeacon = (endpoint, body) => {
    beacons.push({ endpoint, body: String(body) });
    return true;
  };
  dom.window.eval(fs.readFileSync(path.join(SITE, "stats.js"), "utf8"));
  return { window: dom.window, document: dom.window.document, beacons };
}

test("stats.js beacons a pageview and a tagged click on solenta.app", () => {
  const { document, beacons } = loadStats("https://solenta.app/");
  assert.equal(beacons.length, 1);
  const page = JSON.parse(beacons[0].body);
  assert.equal(page.n, "pageview");
  assert.equal(beacons[0].endpoint, "https://stats.solenta.app/e");
  const star = document.querySelector('[data-event="GitHub Star"]');
  star.dispatchEvent(new document.defaultView.MouseEvent("click", { bubbles: true }));
  assert.equal(beacons.length, 2);
  const ev = JSON.parse(beacons[1].body);
  assert.equal(ev.n, "GitHub Star");
});

test("stats.js is inert off the production host", () => {
  const local = loadStats("http://127.0.0.1:8080/");
  assert.equal(local.beacons.length, 0);
  const preview = loadStats("https://solenta-preview.platform.rungirder.com/");
  assert.equal(preview.beacons.length, 0);
});
