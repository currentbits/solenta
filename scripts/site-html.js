"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const ROOT = path.join(__dirname, "..");
const SITE = path.join(ROOT, "site");
const SOURCE = path.join(ROOT, "site-content");
const ORIGIN = "https://solenta.app";
const ORG = { "@context": "https://schema.org", "@type": "Organization", "@id": `${ORIGIN}/#org`, name: "Solenta", url: `${ORIGIN}/`, logo: `${ORIGIN}/assets/icon.svg`, sameAs: ["https://github.com/currentbits/solenta", "https://x.com/currentbitsNET"] };
const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const json = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
const text = (html) => new JSDOM(html).window.document.body.textContent.replace(/\s+/g, " ").trim();
const breadcrumb = (items) => ({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map(([name, route], i) => ({ "@type": "ListItem", position: i + 1, name, item: ORIGIN + route })) });
function article(title, description, route) {
  return { "@context": "https://schema.org", "@type": "TechArticle", headline: title, description, url: ORIGIN + route, image: `${ORIGIN}/assets/card.png?v=4`, dateModified: "__DATE_MODIFIED__", author: { "@id": ORG["@id"] }, publisher: { "@id": ORG["@id"] }, about: { "@type": "SoftwareApplication", name: "Solenta", url: `${ORIGIN}/` } };
}
function faqSchema(html) {
  const doc = new JSDOM(html).window.document;
  const items = [...doc.querySelectorAll("details[data-faq]")];
  return items.length ? { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: items.map((node) => ({ "@type": "Question", name: node.querySelector("summary").textContent.trim(), acceptedAnswer: { "@type": "Answer", text: node.querySelector("p").textContent.trim() } })) } : null;
}
function renderPage({ title, description, route, body, sidebar = "", schema = [], legacyScript = "" }) {
  const template = fs.readFileSync(path.join(SOURCE, "docs.html"), "utf8");
  const head = template.slice(0, template.indexOf("</head>"))
    .replace(/<title>.*?<\/title>/, `<title>${escape(title)}</title>`)
    .replace(/(<meta (?:name="(?:description|twitter:description)"|property="og:description") content=")[^"]*/g, (_, p) => p + escape(description))
    .replace(/(<meta (?:name="twitter:title"|property="og:title") content=")[^"]*/g, (_, p) => p + escape(title))
    .replace(/(<link rel="canonical" href=")[^"]*/, (_, p) => p + ORIGIN + route)
    .replace(/(<meta property="og:url" content=")[^"]*/, (_, p) => p + ORIGIN + route)
    .replace('href="style.css?v=12"', 'href="style.css?v=13"')
    .replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />${route.includes("/", 1) ? '\n  <base href="../../" />' : ""}`);
  const nav = template.slice(template.indexOf('<nav class="nav">'), template.indexOf('<div class="wrap">', template.indexOf('<nav class="nav">')));
  const footer = template.slice(template.indexOf("<footer>"));
  return `${head}\n${schema.filter(Boolean).map((block) => `<script type="application/ld+json">${json(block)}</script>`).join("\n")}\n${legacyScript}\n</head>\n<body>\n${nav}<div class="wrap"><div class="docs-layout">${sidebar}<main class="docs-content">${body}</main></div></div>\n${footer}`;
}
function writePage(file, html) {
  const target = path.join(SITE, file);
  const previous = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const normalized = previous.replace(/"dateModified":"\d{4}-\d{2}-\d{2}"/g, '"dateModified":"__DATE_MODIFIED__"');
  if (normalized === html) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html.replaceAll("__DATE_MODIFIED__", new Date().toISOString().slice(0, 10)));
}
module.exports = { ROOT, SITE, SOURCE, ORIGIN, ORG, escape, json, text, breadcrumb, article, faqSchema, renderPage, writePage };
