#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { SOURCE, escape, json, text, breadcrumb, article, faqSchema, renderPage, writePage } = require("./site-html.js");

function sections(html) {
  const doc = new JSDOM(html).window.document;
  const main = doc.querySelector("main.docs-content");
  const topics = [];
  let topic;
  for (const node of main.children) {
    if (node.tagName === "H2") {
      topic = { id: node.id, title: node.textContent.trim(), nodes: [], ids: [node.id] };
      topics.push(topic);
    } else if (topic) {
      topic.nodes.push(node.outerHTML);
      if (node.id) topic.ids.push(node.id);
      topic.ids.push(...[...node.querySelectorAll("[id]")].map((element) => element.id));
    }
  }
  return { topics, intro: main.querySelector(".lede").outerHTML, title: main.querySelector("h1").textContent };
}
function topicLinks(html, mapping) {
  return html.replace(/href="#([^"]+)"/g, (match, id) => mapping[id] ? `href="docs/${mapping[id]}${id === mapping[id] ? "" : `#${id}`}"` : match);
}
function summary(html) {
  const first = new JSDOM(html).window.document.querySelector("p");
  return first ? first.textContent.replace(/\s+/g, " ").trim() : text(html);
}
function build() {
  const source = fs.readFileSync(path.join(SOURCE, "docs.html"), "utf8");
  const { topics, intro, title } = sections(source);
  const metadata = JSON.parse(fs.readFileSync(path.join(SOURCE, "docs-metadata.json"), "utf8"));
  const mapping = Object.fromEntries(topics.flatMap((topic) => topic.ids.map((id) => [id, topic.id])));
  const sidebar = `<nav class="docs-nav" aria-label="Docs topics">${topics.map((topic) => `<a href="docs/${topic.id}">${escape(topic.title)}</a>`).join("\n")}</nav>`;
  const overview = `<h1>${escape(title)}</h1>${intro}\n<div data-doc-overview>${topics.map((topic) => `<section><h2 id="${topic.id}">${escape(topic.title)}</h2><p>${escape(summary(topic.nodes.join("\n")))}</p><p><a data-doc-topic="${topic.id}" href="docs/${topic.id}">Read ${escape(topic.title.toLowerCase())}</a></p></section>`).join("\n")}</div>`;
  // Hashes are not sent to nginx. Preserve every previous H2/H3 anchor in JS,
  // and keep the overview section IDs as a useful no-JS fallback.
  const legacyScript = `<script>(() => { const topics = ${json(mapping)}; let id; try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; } if (!Object.hasOwn(topics, id)) return; const root = new URL("./", location.href); location.replace(new URL("docs/" + topics[id] + "/" + (topics[id] === id ? "" : "#" + encodeURIComponent(id)), root).href); })();</script>`;
  const description = "How Solenta works: shared agent memory, a planboard on your issues, worktrees, Build workflows, spend caps, web mode and SSH remotes.";
  writePage("docs.html", renderPage({ title: "Solenta docs: shared memory and parallel coding agents", description, route: "/docs.html", body: overview, sidebar, schema: [article(title, description, "/docs.html"), breadcrumb([["Solenta", "/"], ["Docs", "/docs.html"]])], legacyScript }));
  for (const [i, topic] of topics.entries()) {
    const route = `/docs/${topic.id}`;
    const promoteHeadings = (html) => html.replace(/<(\/?)h3(?=[\s>])/g, "<$1h2");
    const content = promoteHeadings(topicLinks(topic.nodes.join("\n"), mapping));
    const first = summary(content);
    const heading = topic.id === "memory" ? "Shared memory for AI coding agents" : topic.title;
    const pageTitle = topic.id === "memory" ? "Shared Memory for Claude Code, Codex and Cursor Agents" : `${topic.title} | Solenta ${topic.title.length < 10 ? "documentation" : "docs"}`;
    const meta = metadata[topic.id];
    if (!meta) throw new Error(`Missing metadata for ${topic.id}`);
    const extraFile = path.join(SOURCE, `docs-${topic.id}.html`);
    const extra = fs.existsSync(extraFile) ? promoteHeadings(topicLinks(fs.readFileSync(extraFile, "utf8"), mapping)) : "";
    const neighbors = [topics[i - 1], topics[i + 1]].filter(Boolean).map((neighbor) => `<a href="docs/${neighbor.id}">${escape(neighbor.title)}</a>`).join(" <span aria-hidden=\"true\">·</span> ");
    const paragraphs = [...new JSDOM(content).window.document.querySelectorAll("p")].map((p) => p.textContent.replace(/\s+/g, " ").trim()).join(" ");
    const lead = topic.id === "palette" ? "Solenta's command palette has three entry points in one overlay. Use them for commands, file search and thread search." : [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(paragraphs || first)].slice(0, 2).map((part) => part.segment).join("").trim();
    const body = `<p><a href="docs.html">All docs</a></p><h1>${escape(heading)}</h1><p class="lede">${escape(lead)}</p><section data-doc-section="${topic.id}" data-doc-title="${escape(topic.title)}"><div data-doc-content>${content}</div>${extra ? `<div data-doc-extra>${extra}</div>` : ""}</section><nav class="topic-neighbors" aria-label="Adjacent topics">${neighbors}</nav>`;
    const activeSidebar = sidebar.replace(`href="docs/${topic.id}"`, `class="active" aria-current="page" href="docs/${topic.id}"`);
    writePage(`docs/${topic.id}/index.html`, renderPage({ title: pageTitle, description: meta, route, body, sidebar: activeSidebar, schema: [article(heading, meta, route), breadcrumb([["Solenta", "/"], ["Docs", "/docs.html"], [topic.title, route]]), faqSchema(extra)] }));
  }
  console.log(`Built docs overview and ${topics.length} topic pages`);
}
module.exports = { sections, topicLinks, build };
if (require.main === module) build();
