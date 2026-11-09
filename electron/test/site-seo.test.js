"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { JSDOM } = require("jsdom");
const { execFileSync } = require("node:child_process");
const { PAGES, render } = require("../../scripts/build-sitemap.js");
const ROOT = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(ROOT, "site", file), "utf8");
const page = (file) => new JSDOM(read(file), { url: `https://solenta.app/${file}` }).window.document;

test("public pages have unique, bounded snippets, one main and one H1", () => {
  const titles = new Set(), descriptions = new Set();
  for (const file of PAGES) {
    const doc = page(file), title = doc.title;
    const description = doc.querySelector('meta[name="description"]').content;
    assert.ok(title.length >= 25 && title.length <= 60, file);
    assert.ok(description.length >= 70 && description.length <= 160, file);
    titles.add(title); descriptions.add(description);
    assert.equal(doc.querySelectorAll("main").length, 1, file);
    assert.equal(doc.querySelectorAll("h1").length, 1, file);
    assert.doesNotMatch(read(file), /\u2014|&mdash;|&#(?:8212|x2014);/i);
    assert.equal(doc.querySelectorAll('link[rel="preload"][as="font"]').length, 1);
    assert.equal(doc.querySelector('link[rel="preload"]').getAttribute("href"), "fonts/Geist-Variable.woff2");
    // The same relative links must resolve to the directory root on both hosts.
    for (const root of ["https://solenta.app/", "https://currentbits.github.io/solenta/"]) {
      const mirrored = new JSDOM(read(file), { url: root + file }).window.document;
      assert.equal(mirrored.querySelector("a.brand").href, root, file);
    }
    assert.equal(doc.querySelector('a[href^="index.html"]'), null);
  }
  assert.equal(titles.size, PAGES.length); assert.equal(descriptions.size, PAGES.length);
});

test("responsive screenshots preserve PNG fallback and prioritize only the hero", () => {
  const doc = page("index.html");
  const images = [...doc.querySelectorAll('img[src^="assets/screen-"]')];
  assert.equal(images.length, 4);
  for (const img of images) {
    assert.equal(img.width, 1680); assert.equal(img.height, 1050);
    assert.equal(img.parentElement.tagName, "PICTURE");
    assert.equal(img.getAttribute("decoding"), "async");
    const source = img.parentElement.querySelector('source[type="image/webp"]');
    assert.ok(source.getAttribute("sizes"));
    for (const candidate of source.getAttribute("srcset").split(",")) {
      const [url, width] = candidate.trim().split(/\s+/);
      const data = fs.readFileSync(path.join(ROOT, "site", url.split("?")[0]));
      assert.equal(data.toString("ascii", 8, 12), "WEBP");
      assert.ok(["800w", "1680w"].includes(width));
    }
    if (img.src.includes("screen-main")) {
      assert.equal(img.getAttribute("fetchpriority"), "high");
      assert.equal(img.getAttribute("loading"), null);
    } else {
      assert.equal(img.getAttribute("loading"), "lazy");
      assert.equal(img.getAttribute("fetchpriority"), null);
    }
  }
});

test("home features and ten newest releases link to existing documentation sections", () => {
  for (const file of ["index.html", "changelog.html"]) {
    const doc = page(file);
    const links = [...doc.querySelectorAll('a[href^="docs/"]')];
    assert.equal(doc.querySelector('a[href^="docs.html#"]'), null);
    for (const link of links) {
      const target = link.getAttribute("href").split("#")[0] + "/index.html";
      assert.ok(fs.existsSync(path.join(ROOT, "site", target)), `${file}: ${link.href}`);
      if (link.hash) assert.ok(page(target).getElementById(link.hash.slice(1)), `${file}: ${link.href}`);
    }
    if (file === "index.html") assert.ok(new Set(links.map((link) => link.pathname)).size >= 14);
    else for (const heading of [...doc.querySelectorAll("h2")].slice(0, 10)) {
      let node = heading.nextElementSibling, linked = false;
      while (node && node.tagName !== "H2") {
        linked ||= !!node.querySelector('a[href^="docs/"]');
        node = node.nextElementSibling;
      }
      assert.ok(linked, heading.textContent);
    }
  }
});

test("sitemap lists canonical HTML pages with dates bound to their current content", () => {
  const dates = JSON.parse(read("sitemap-dates.json"));
  assert.deepEqual(Object.keys(dates), PAGES);
  assert.equal(read("sitemap.xml"), render(), "run node scripts/build-sitemap.js");
  const xml = new JSDOM(read("sitemap.xml"), { contentType: "text/xml" }).window.document;
  const entries = [...xml.querySelectorAll("url")];
  assert.equal(entries.length, PAGES.length);
  for (const [i, file] of PAGES.entries()) {
    const url = page(file).querySelector('link[rel="canonical"]').href;
    assert.equal(entries[i].querySelector("loc").textContent, url);
    const date = entries[i].querySelector("lastmod").textContent;
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    const hash = createHash("sha256").update(read(file).replace(/\r\n/g, "\n")).digest("hex");
    assert.equal(dates[file].sha256, hash, `${file}: run node scripts/build-sitemap.js`);
    assert.equal(date, dates[file].lastmod, file);
    for (const script of page(file).querySelectorAll('script[type="application/ld+json"]')) {
      const modified = JSON.parse(script.textContent).dateModified;
      if (modified) assert.ok(date >= modified, file);
    }
    assert.ok(date <= new Date().toISOString().slice(0, 10));
  }
});

test("sitemap dates survive a next-day squash and advance only when page content changes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-sitemap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "site"));
  fs.copyFileSync(path.join(ROOT, "scripts/build-sitemap.js"), path.join(root, "scripts/build-sitemap.js"));
  const files = ["index.html", "docs.html", "changelog.html"];
  for (const file of files) fs.writeFileSync(path.join(root, "site", file), `<h1>${file}</h1>\n`);
  fs.writeFileSync(path.join(root, "site/sitemap-dates.json"), "{}");
  const readOutput = () => ["sitemap.xml", "sitemap-dates.json"].map((file) => fs.readFileSync(path.join(root, "site", file), "utf8"));
  const build = (day) => {
    fs.writeFileSync(path.join(root, "clock.cjs"), `Date = class extends Date { constructor() { super("2026-11-${day}T12:00:00Z"); } };`);
    execFileSync(process.execPath, ["--require", path.join(root, "clock.cjs"), path.join(root, "scripts/build-sitemap.js")]);
  };
  build("08");
  const beforeSquash = readOutput();
  const git = (...args) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: "2026-11-09T12:00:00Z", GIT_COMMITTER_DATE: "2026-11-09T12:00:00Z" } });
  git("init", "--quiet", "--initial-branch=main");
  git("add", "site", "scripts");
  git("-c", "user.name=Sitemap Test", "-c", "user.email=sitemap@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Squash pages generated yesterday");
  build("10");
  assert.deepEqual(readOutput(), beforeSquash, "clean rebuild after squash must be byte-identical");

  fs.appendFileSync(path.join(root, "site/docs.html"), "<p>New content</p>\n");
  build("10");
  const changed = JSON.parse(readOutput()[1]);
  assert.equal(changed["docs.html"].lastmod, "2026-11-10");
  assert.equal(changed["index.html"].lastmod, "2026-11-08");
  assert.equal(changed["changelog.html"].lastmod, "2026-11-08");
  fs.appendFileSync(path.join(root, "site/docs.html"), "<p>Another same-day edit</p>\n");
  const staleHash = createHash("sha256").update(fs.readFileSync(path.join(root, "site/docs.html"))).digest("hex");
  assert.notEqual(changed["docs.html"].sha256, staleHash, "freshness detects edits even before the date advances");
  build("10");
  assert.notEqual(JSON.parse(readOutput()[1])["docs.html"].sha256, changed["docs.html"].sha256);
  const afterChange = readOutput();
  build("11");
  assert.deepEqual(readOutput(), afterChange, "unchanged dirty pages must keep their content date");
});

test("conventional icons contain the required image dimensions", () => {
  const png = fs.readFileSync(path.join(ROOT, "site", "apple-touch-icon.png"));
  assert.equal(png.readUInt32BE(16), 180); assert.equal(png.readUInt32BE(20), 180);
  const ico = fs.readFileSync(path.join(ROOT, "site", "favicon.ico"));
  assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico[6], 32); assert.equal(ico[7], 32);
  for (const file of PAGES) assert.equal(page(file).querySelector('link[rel="apple-touch-icon"]').getAttribute("href"), "apple-touch-icon.png");
});
