#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { SITE, ORIGIN, ORG, json, breadcrumb, writePage } = require("./site-html.js");
const { sections } = require("./build-site-docs.js");
function upsert(html, block) {
  let found = false;
  html = html.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, (script, data) => {
    if (JSON.parse(data)["@type"] !== block["@type"]) return script;
    found = true;
    return `<script type="application/ld+json">${json(block)}</script>`;
  });
  return found ? html : html.replace("</head>", `<script type="application/ld+json">${json(block)}</script>\n</head>`);
}
function build() {
  const changelogPath = path.join(SITE, "changelog.html");
  let changelog = fs.readFileSync(changelogPath, "utf8");
  const release = new JSDOM(changelog).window.document.querySelector("h2");
  const version = release.textContent.match(/^[\d.]+/)[0];
  const releaseDate = release.querySelector("small").textContent.trim();
  const indexPath = path.join(SITE, "index.html");
  let index = fs.readFileSync(indexPath, "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "site-content", "docs.html"), "utf8");
  const mapping = Object.fromEntries(sections(source).topics.flatMap((topic) => topic.ids.map((id) => [id, topic.id])));
  const updateLinks = (html) => html.replace(/href="docs\.html#([^"]+)"/g, (match, id) => mapping[id] ? `href="docs/${mapping[id]}${mapping[id] === id ? "" : `#${id}`}"` : match).replaceAll("style.css?v=12", "style.css?v=13");
  index = updateLinks(index);
  changelog = updateLinks(changelog);
  const doc = new JSDOM(index).window.document;
  const app = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent)).find((block) => block["@type"] === "SoftwareApplication");
  index = upsert(index, { ...app, description: doc.querySelector('meta[name="description"]').content, softwareVersion: version, publisher: { "@id": ORG["@id"] } });
  index = upsert(index, ORG);
  index = upsert(index, { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [...doc.querySelectorAll("#faq details")].map((node) => ({ "@type": "Question", name: node.querySelector("summary").textContent.trim(), acceptedAnswer: { "@type": "Answer", text: node.querySelector("p").textContent.trim() } })) });
  fs.writeFileSync(indexPath, index);
  changelog = upsert(changelog, { "@context": "https://schema.org", "@type": "WebPage", name: "Solenta changelog", url: `${ORIGIN}/changelog.html`, dateModified: "__DATE_MODIFIED__", about: { "@type": "SoftwareApplication", name: "Solenta", url: `${ORIGIN}/`, softwareVersion: version, datePublished: releaseDate }, publisher: { "@id": ORG["@id"] }, breadcrumb: breadcrumb([["Solenta", "/"], ["Changelog", "/changelog.html"]]) });
  writePage("changelog.html", changelog);
}
if (require.main === module) build();
module.exports = { upsert, build };
