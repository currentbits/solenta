"use strict";
// Site test, not an electron one. It lives here because electron/test is the
// repo's only plain node:test suite (test/ is the React renderer), so
// `npm run test:electron` picks it up with no new wiring.
//
// What it guards: the download CTAs on solenta.app build asset URLs from a
// version string. A wrong string is a 404 on the one button the whole site
// points at, and nothing else in the repo would notice.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SITE = path.join(__dirname, "..", "..", "site");
const HTML = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
const MAIN = fs.readFileSync(path.join(SITE, "main.js"), "utf8");
const FALLBACK = /const FALLBACK_TAG = "(v[\d.]+)"/.exec(MAIN)[1];
const DL = "https://github.com/currentbits/solenta/releases/latest/download/";
const RELEASES = "https://github.com/currentbits/solenta/releases/latest";

// runScripts:"outside-only" keeps the page's own <script src> tags inert and
// still lets us eval main.js against the real markup.
function render({ platform = "MacIntel", userAgent, tag, cached } = {}) {
  const dom = new JSDOM(HTML, { runScripts: "outside-only", url: "https://solenta.app/" });
  const { window } = dom;
  const def = (obj, key, value) =>
    Object.defineProperty(obj, key, { value, configurable: true });

  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  def(window.navigator, "platform", platform);
  if (userAgent) def(window.navigator, "userAgent", userAgent);

  const store = new Map();
  if (cached) store.set("solenta.tag", JSON.stringify({ v: cached, t: Date.now() }));
  def(window, "localStorage", {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  });

  const calls = [];
  window.fetch = (url) => {
    calls.push(url);
    return tag
      ? Promise.resolve({ ok: true, json: async () => ({ tag_name: tag }) })
      : Promise.reject(new Error("offline"));
  };

  window.eval(MAIN);
  return { doc: window.document, calls, store };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const href = (doc, sel) => doc.querySelector(sel).getAttribute("href");

test("the fallback tag is a release tag", () => {
  assert.match(FALLBACK, /^v\d+\.\d+\.\d+$/);
});

test("every download link is a releases page until JS narrows it", () => {
  // No-JS visitors must never land on a 404, so the markup itself is generic.
  for (const m of HTML.matchAll(/<a[^>]*\bdata-dl=[^>]*>/g)) {
    assert.match(m[0], /href="https:\/\/github\.com\/currentbits\/solenta\/releases\/latest"/);
  }
});

test("macOS gets a direct asset link and owns its install card", async () => {
  const { doc } = render({ platform: "MacIntel" });
  const hero = doc.getElementById("hero-dl");
  assert.equal(hero.textContent.trim(), "Download for macOS");
  assert.equal(hero.getAttribute("href"), `${DL}Solenta-${FALLBACK}-macos-arm64.zip`);
  assert.ok(hero.classList.contains("plausible-event-platform=mac"));
  assert.ok(!hero.classList.contains("plausible-event-platform=unknown"));

  // The alternates line drops the platform you are already on.
  assert.ok(doc.querySelector('.hero-alt [data-dl="mac"]').hasAttribute("hidden"));
  assert.ok(!doc.querySelector('.hero-alt [data-dl="win"]').hasAttribute("hidden"));
  assert.equal(doc.getElementById("hero-alt-lead").textContent, "Also for");

  const card = doc.querySelector('.install-card[data-os="mac"]');
  assert.ok(card.classList.contains("is-you"));
  assert.ok(card.querySelector(".btn").classList.contains("btn-primary"));
  assert.ok(!doc.querySelector('.install-card[data-os="win"]').classList.contains("is-you"));
});

test("windows and linux resolve to their own archives", () => {
  const win = render({ platform: "Win32" }).doc;
  assert.equal(
    href(win, "#hero-dl"),
    `${DL}Solenta-${FALLBACK}-win32-x64.zip`,
  );
  const linux = render({ platform: "Linux x86_64" }).doc;
  assert.equal(
    href(linux, "#hero-dl"),
    `${DL}Solenta-${FALLBACK}-linux-x64.tar.gz`,
  );
  // Card links do not depend on detection at all.
  assert.equal(
    href(linux, '.install-card[data-os="win"] [data-dl]'),
    `${DL}Solenta-${FALLBACK}-win32-x64.zip`,
  );
});

test("phones keep the neutral CTA, since there is no mobile build", () => {
  const { doc } = render({
    platform: "iPhone",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1",
  });
  assert.equal(doc.getElementById("hero-dl").textContent.trim(), "Download Solenta");
  assert.equal(href(doc, "#hero-dl"), RELEASES);
  assert.ok(!doc.querySelector(".install-card.is-you"));
});

test("a newer published tag wins and is cached", async () => {
  const { doc, store } = render({ tag: "v9.9.9" });
  await settle();
  assert.equal(href(doc, "#hero-dl"), `${DL}Solenta-v9.9.9-macos-arm64.zip`);
  assert.match(doc.querySelector("[data-tag]").textContent, /Latest release v9\.9\.9/);
  assert.equal(JSON.parse(store.get("solenta.tag")).v, "v9.9.9");
});

test("a cached tag skips the API entirely", async () => {
  const { doc, calls } = render({ cached: "v9.9.9" });
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(href(doc, "#hero-dl"), `${DL}Solenta-v9.9.9-macos-arm64.zip`);
});

test("a junk tag or a dead API leaves the fallback links intact", async () => {
  for (const tag of ["nightly-abc1234", "", undefined]) {
    const { doc } = render({ tag });
    await settle();
    assert.equal(
      href(doc, "#hero-dl"),
      `${DL}Solenta-${FALLBACK}-macos-arm64.zip`,
      `tag ${JSON.stringify(tag)} must not reach an href`,
    );
  }
});
