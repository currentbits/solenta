#!/usr/bin/env node
// Writes site/llms-full.txt: the docs overview and ordered topics as Markdown, so an agent
// can read the docs in one fetch (https://llmstxt.org). site/llms.txt is the
// short hand-written index that points here.
//
//   node scripts/build-llms.js          # rewrite site/llms-full.txt
//
// electron/test/site-llms.test.js fails when the committed file no longer
// matches docs.html, so a docs edit without a rebuild cannot land.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SITE = path.join(__dirname, "..", "site");
const BASE = "https://solenta.app/docs.html";

// ponytail: covers the tags docs.html actually uses; an unknown tag falls
// through to its text, so a new one degrades instead of vanishing.
function inline(node) {
  if (node.nodeType === 3) return node.textContent.replace(/\s+/g, " ");
  if (node.nodeType !== 1) return "";
  const inner = [...node.childNodes].map(inline).join("");
  switch (node.tagName) {
    case "STRONG":
      return `**${inner}**`;
    case "EM":
      return `*${inner}*`;
    case "CODE":
    case "KBD":
      return `\`${node.textContent}\``;
    case "A": {
      const href = node.getAttribute("href") || "";
      const url = href.startsWith("#") ? BASE + href : href.startsWith("docs/") || href.startsWith("guides/") ? `https://solenta.app/${href}` : href;
      return `[${inner}](${url})`;
    }
    case "BR":
      return "\n";
    default:
      return inner;
  }
}

const text = (node) => inline(node).replace(/ *\n */g, "\n").trim();

function block(node) {
  if (node.nodeType !== 1) return [];
  switch (node.tagName) {
    case "H1":
      return [`# ${text(node)}`];
    case "H2":
      return [`## ${text(node)}`];
    case "H3":
      return [`### ${text(node)}`];
    case "P":
      return [text(node)];
    case "PRE":
      return ["```\n" + node.textContent.replace(/\n+$/, "") + "\n```"];
    case "UL":
    case "OL": {
      const ordered = node.tagName === "OL";
      const items = [...node.children].filter((c) => c.tagName === "LI");
      return [items.map((li, i) => `${ordered ? `${i + 1}.` : "-"} ${text(li)}`).join("\n")];
    }
    case "TABLE": {
      const rows = [...node.querySelectorAll("tr")].map(
        (tr) => `| ${[...tr.children].map((c) => text(c).replace(/\|/g, "\\|")).join(" | ")} |`,
      );
      const cols = node.querySelector("tr").children.length;
      rows.splice(1, 0, `|${" --- |".repeat(cols)}`);
      return [rows.join("\n")];
    }
    case "DETAILS": {
      const summary = node.querySelector("summary");
      return [`### ${text(summary)}`, ...[...node.children].filter((child) => child !== summary).flatMap(block)];
    }
    default:
      return [...node.childNodes].flatMap(block);
  }
}

function render(html, readTopic = (id) => fs.readFileSync(path.join(SITE, "docs", id, "index.html"), "utf8")) {
  const { document } = new JSDOM(html).window;
  const main = document.querySelector("main.docs-content");
  let nodes = [...main.childNodes];
  if (main.querySelector("[data-doc-overview]")) {
    nodes = [main.querySelector("h1"), main.querySelector(".lede")];
    for (const link of main.querySelectorAll("a[data-doc-topic]")) {
      const topic = new JSDOM(readTopic(link.dataset.docTopic)).window.document;
      const section = topic.querySelector("[data-doc-section]");
      // A topic's former H2 is its page H1. Restore the original subsection
      // depth when recombining standalone pages into one document.
      for (const h2 of section.querySelectorAll("h2")) {
        const h3 = document.createElement("h3");
        h3.innerHTML = h2.innerHTML;
        h2.replaceWith(h3);
      }
      const heading = document.createElement("h2");
      heading.textContent = section.dataset.docTitle;
      nodes.push(heading, ...section.querySelector("[data-doc-content]").childNodes);
      const extra = section.querySelector("[data-doc-extra]");
      if (extra) nodes.push(...extra.childNodes);
    }
  }
  const intro = `> Source: ${BASE}, generated from the docs overview and topic pages by scripts/build-llms.js.`;
  const [title, ...rest] = nodes.flatMap(block).filter(Boolean);
  return [title, intro, ...rest].join("\n\n") + "\n";
}

module.exports = { render };

if (require.main === module) {
  const out = render(fs.readFileSync(path.join(SITE, "docs.html"), "utf8"));
  fs.writeFileSync(path.join(SITE, "llms-full.txt"), out);
  console.log(`site/llms-full.txt: ${out.length} bytes`);
}
