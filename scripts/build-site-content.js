#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { SOURCE, escape, breadcrumb, article, faqSchema, renderPage, writePage } = require("./site-html.js");
const { sections } = require("./build-site-docs.js");

function faqDetails(html) {
  const doc = new JSDOM(html).window.document;
  const heading = [...doc.querySelectorAll("h2")].find((node) => node.textContent.trim() === "Questions");
  if (!heading) return html;
  const list = doc.createElement("div");
  list.className = "faq-list";
  let node = heading.nextElementSibling;
  while (node && node.tagName !== "H2") {
    if (node.tagName !== "H3" || node.nextElementSibling?.tagName !== "P") throw new Error("FAQ requires an H3 question followed by its answer paragraph");
    const answer = node.nextElementSibling;
    const next = answer.nextElementSibling;
    const details = doc.createElement("details"); details.setAttribute("data-faq", "");
    details.innerHTML = `<summary>${escape(node.textContent)}</summary>${answer.outerHTML}`;
    list.append(details); node.remove(); answer.remove(); node = next;
  }
  heading.after(list);
  return doc.body.innerHTML;
}

async function build() {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const [{ default: Markdown }, { default: remarkGfm }] = await Promise.all([import("react-markdown"), import("remark-gfm")]);
  const mapping = Object.fromEntries(sections(fs.readFileSync(path.join(SOURCE, "docs.html"), "utf8")).topics.flatMap((topic) => topic.ids.map((id) => [id, topic.id])));
  const markdown = (body) => renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [remarkGfm], children: body, components: { table: ({ children }) => React.createElement("div", { className: "table-scroll" }, React.createElement("table", { className: "doc-table" }, children)) } }))
    .replace(/href="docs\.html#([^"]+)"/g, (match, id) => mapping[id] ? `href="docs/${mapping[id]}${id === mapping[id] ? "" : `#${id}`}"` : match);
  let guide = fs.readFileSync(path.join(SOURCE, "run-coding-agents-in-parallel.md"), "utf8");
  guide = guide.replace(/^# [^\n]+\n/, "");
  let body = faqDetails(markdown(guide));
  const route = "/guides/run-coding-agents-in-parallel";
  const heading = "How to run AI coding agents in parallel";
  const description = "Run several AI coding agents on one repo without conflicts: one git worktree per agent, a verify gate before merge, and a shared memory.";
  writePage("guides/run-coding-agents-in-parallel/index.html", renderPage({ title: "How to Run Claude Code, Codex and Cursor in Parallel", description, route, body: `<h1>${heading}</h1>${body}`, schema: [article(heading, description, route), breadcrumb([["Solenta", "/"], [heading, route]]), faqSchema(body)] }));
  for (const [name, title, description] of [
    ["conductor", "Solenta vs Conductor: parallel coding agents compared", "Compare Solenta and Conductor on agent support, worktrees, shared memory, issue workflows and pricing, with links to each product's own docs."],
    ["claude-squad", "Solenta vs Claude Squad: parallel coding agents compared", "Compare Solenta's desktop workflow with Claude Squad's terminal workflow: agents, worktrees, memory, issue tracking and source licenses."],
  ]) {
    body = faqDetails(markdown(fs.readFileSync(path.join(SOURCE, `compare-${name}.md`), "utf8")));
    const compareRoute = `/compare/solenta-vs-${name}`;
    writePage(`compare/solenta-vs-${name}/index.html`, renderPage({ title, description, route: compareRoute, body, schema: [{ "@context": "https://schema.org", "@type": "WebPage", name: title, description, url: `https://solenta.app${compareRoute}`, dateModified: "__DATE_MODIFIED__", publisher: { "@id": "https://solenta.app/#org" } }, breadcrumb([["Solenta", "/"], ["Compare", "/#compare"], [title, compareRoute]]), faqSchema(body)] }));
  }
  const hub = { title: "Conductor alternatives: Solenta and Claude Squad", description: "Compare two alternatives to Conductor for parallel coding agents: Solenta's desktop workflow and Claude Squad's terminal workflow, with primary sources." };
  writePage("alternatives/conductor/index.html", renderPage({ ...hub, route: "/alternatives/conductor", body: markdown(fs.readFileSync(path.join(SOURCE, "conductor-alternatives.md"), "utf8")), schema: [{ "@context": "https://schema.org", "@type": "WebPage", name: hub.title, description: hub.description, url: "https://solenta.app/alternatives/conductor", dateModified: "__DATE_MODIFIED__", publisher: { "@id": "https://solenta.app/#org" } }, breadcrumb([["Solenta", "/"], ["Conductor alternatives", "/alternatives/conductor"]])] }));
}
module.exports = { faqDetails, build };
if (require.main === module) build().catch((error) => { console.error(error); process.exitCode = 1; });
