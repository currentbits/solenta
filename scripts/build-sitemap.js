#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const ROOT = path.join(__dirname, "..");
const SITE = path.join(ROOT, "site");
// Bind dates to content so rebases and delayed squash merges cannot change them.
const DATES_FILE = path.join(SITE, "sitemap-dates.json");
const dates = JSON.parse(fs.readFileSync(DATES_FILE, "utf8"));
const today = new Date().toISOString().slice(0, 10);
const PAGES = ["index.html", "docs.html", "changelog.html"];
for (const group of ["docs", "guides", "compare", "alternatives"]) {
  const dir = path.join(SITE, group);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir).sort()) {
    const file = `${group}/${name}/index.html`;
    if (fs.existsSync(path.join(SITE, file))) PAGES.push(file);
  }
}
const routeFor = (file) => file === "index.html" ? "/" : "/" + file.replace(/\/index\.html$/, "");

function contentHash(file) {
  const html = fs.readFileSync(path.join(SITE, file), "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(html).digest("hex");
}

function lastModified(file) {
  const date = dates[file]?.sha256 === contentHash(file) ? dates[file].lastmod : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid sitemap date for site/${file}`);
  return date;
}

function render() {
  const urls = PAGES.map((file) => `  <url><loc>https://solenta.app${routeFor(file)}</loc><lastmod>${lastModified(file)}</lastmod></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join("\n");
}
module.exports = { PAGES, routeFor, lastModified, render };
if (require.main === module) {
  fs.writeFileSync(path.join(SITE, "sitemap.xml"), render());
  const updated = Object.fromEntries(PAGES.map((file) => [file, { lastmod: lastModified(file), sha256: contentHash(file) }]));
  fs.writeFileSync(DATES_FILE, JSON.stringify(updated, null, 2) + "\n");
}
