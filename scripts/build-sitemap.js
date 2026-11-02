#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ROOT = path.join(__dirname, "..");
const SITE = path.join(ROOT, "site");
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

function lastModified(file) {
  // Regenerate before committing page edits, so that the sitemap travels with them.
  const changed = execFileSync("git", ["status", "--porcelain", "--", `site/${file}`], { cwd: ROOT, encoding: "utf8" }).trim();
  if (changed) return new Date().toISOString().slice(0, 10);
  const date = execFileSync("git", ["log", "-1", "--format=%cs", "--", `site/${file}`], { cwd: ROOT, encoding: "utf8" }).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`No commit date for site/${file}`);
  return date;
}

function render() {
  const urls = PAGES.map((file) => `  <url><loc>https://solenta.app${routeFor(file)}</loc><lastmod>${lastModified(file)}</lastmod></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join("\n");
}
module.exports = { PAGES, routeFor, lastModified, render };
if (require.main === module) fs.writeFileSync(path.join(ROOT, "site", "sitemap.xml"), render());
