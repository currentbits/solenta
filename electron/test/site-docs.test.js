"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { sections } = require("../../scripts/build-site-docs.js");
const { render } = require("../../scripts/build-llms.js");
const { PAGES, routeFor } = require("../../scripts/build-sitemap.js");
const ROOT = path.join(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, "site", file), "utf8");
const source = fs.readFileSync(path.join(ROOT, "site-content/docs.html"), "utf8");
const { topics } = sections(source);
const parse = (html, url = "https://solenta.app/") => new JSDOM(html, { url }).window.document;
const plain = (html) => parse(html).body.textContent.replace(/\s+/g, " ").trim();

test("docs migration preserves every source section, ID and topic order", () => {
  const overview = parse(read("docs.html"));
  assert.deepEqual([...overview.querySelectorAll("a[data-doc-topic]")].map((a) => a.dataset.docTopic), topics.map((t) => t.id));
  for (const topic of topics) {
    const doc = parse(read(`docs/${topic.id}/index.html`));
    const body = doc.querySelector("[data-doc-content]");
    assert.equal(plain(body.innerHTML), plain(topic.nodes.join("\n")), topic.id);
    for (const id of topic.ids.filter((id) => id !== topic.id)) assert.ok(body.querySelector(`[id="${id}"]`), id);
    assert.equal(doc.querySelector("[data-doc-section]").dataset.docTitle, topic.title);
  }
  // Remove only the additive expansions and normalize link destinations. The
  // split must not silently drop or reorder existing paragraphs in llms-full.
  const withoutExtras = render(read("docs.html"), (id) => {
    const doc = parse(read(`docs/${id}/index.html`));
    doc.querySelector("[data-doc-extra]")?.remove();
    return doc.documentElement.outerHTML;
  });
  const normalizeLinks = (markdown) => markdown.replace(/\]\([^)]*\)/g, "]()");
  assert.equal(normalizeLinks(withoutExtras), normalizeLinks(render(source)));
});

test("all legacy docs anchors redirect correctly on primary and Pages hosts", () => {
  const doc = parse(read("docs.html"));
  const script = [...doc.querySelectorAll("script:not([src])")].find((s) => s.textContent.includes("location.replace")).textContent;
  for (const root of ["https://solenta.app/", "https://currentbits.github.io/solenta/"]) {
    const redirect = (hash) => {
      let destination;
      const location = { href: `${root}docs.html${hash}`, hash, replace: (url) => { destination = url; } };
      vm.runInNewContext(script, { location, URL });
      return destination;
    };
    for (const topic of topics) for (const id of topic.ids) {
      assert.equal(redirect(`#${id}`), `${root}docs/${topic.id}/${topic.id === id ? "" : `#${id}`}`, id);
    }
    for (const hash of ["", "#unknown", "#%E0%A4%A", "#__proto__"]) assert.equal(redirect(hash), undefined, hash);
  }
});

test("local links and assets resolve on canonical routes and the Pages mirror", () => {
  const routes = new Map(PAGES.map((file) => [routeFor(file), file]));
  for (const file of PAGES) for (const mirror of [false, true]) {
    const prefix = mirror ? "/solenta" : "";
    const route = routeFor(file);
    const nested = route.split("/").length > 2;
    const url = `https://example.test${prefix}${route}${mirror && nested ? "/" : ""}`;
    const doc = parse(read(file), url);
    for (const node of doc.querySelectorAll("a[href], img[src], script[src], link[href], source[srcset]")) {
      const raw = node.getAttribute("href") || node.getAttribute("src") || node.getAttribute("srcset").split(",")[0].trim().split(" ")[0];
      const link = new URL(raw, doc.baseURI);
      if (link.origin !== "https://example.test") continue;
      assert.ok(link.pathname.startsWith(prefix + "/"), `${file}: ${raw}`);
      const target = link.pathname.slice(prefix.length).replace(/\/$/, "") || "/";
      const targetFile = routes.get(target);
      if (targetFile) {
        if (link.hash) assert.ok(parse(read(targetFile)).getElementById(decodeURIComponent(link.hash.slice(1))), `${file}: missing ${link.href}`);
      } else assert.ok(fs.existsSync(path.join(ROOT, "site", target)), `${file}: missing ${link.href}`);
    }
  }
});

test("topic articles, publisher references, breadcrumbs and FAQs match public content", () => {
  const home = parse(read("index.html"));
  const homeBlocks = [...home.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent));
  const org = homeBlocks.find((b) => b["@type"] === "Organization");
  assert.equal(org.name, "Solenta");
  assert.equal(org.logo, "https://solenta.app/assets/icon.svg");
  assert.deepEqual(org.sameAs, ["https://github.com/currentbits/solenta", "https://x.com/currentbitsNET"]);
  assert.equal(homeBlocks.find((b) => b["@type"] === "SoftwareApplication").publisher["@id"], org["@id"]);
  for (const file of PAGES.filter((file) => file !== "index.html")) {
    const doc = parse(read(file));
    const blocks = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent));
    const article = blocks.find((b) => ["TechArticle", "WebPage"].includes(b["@type"]));
    assert.ok(article, file);
    assert.equal(article.publisher["@id"], org["@id"]);
    assert.match(article.dateModified, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(article.dateModified <= new Date().toISOString().slice(0, 10));
    assert.equal(article.url, "https://solenta.app" + routeFor(file));
    const breadcrumb = blocks.find((b) => b["@type"] === "BreadcrumbList") || article.breadcrumb;
    assert.equal(breadcrumb.itemListElement.at(-1).item, article.url);
    const visible = [...doc.querySelectorAll("details[data-faq]")].map((d) => [d.querySelector("summary").textContent.trim(), d.querySelector("p").textContent.trim()]);
    const faq = blocks.find((b) => b["@type"] === "FAQPage");
    assert.deepEqual(faq?.mainEntity.map((q) => [q.name, q.acceptedAnswer.text]) || [], visible, file);
    assert.ok(!blocks.some((b) => b["@type"] === "HowTo"));
  }
});

test("approved providers, issue hosts and H1 agree across authored surfaces", () => {
  const home = parse(read("index.html"));
  assert.equal(home.querySelector("h1").textContent.replace(/\s+/g, " ").trim(), "Run AI coding agents in parallel, with shared memory");
  const providers = ["Claude Code", "Codex", "Cursor", "Kimi", "Grok", "OpenCode", "Muse Code"];
  assert.deepEqual(new Set([...home.querySelectorAll(".agent-chip")].map((node) => node.textContent.trim())), new Set(providers));
  const surfaces = [home.querySelector("#faq").textContent, plain(source), read("llms.txt"), read("llms-full.txt")];
  for (const surface of surfaces) {
    for (const provider of providers) assert.ok(surface.includes(provider), provider);
    assert.match(surface, /GitHub or GitLab/);
  }
});
