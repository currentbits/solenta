#!/usr/bin/env node
// Run against the built nginx container, then again against production after deploy.
// node scripts/verify-site-seo.js http://localhost:8187
"use strict";
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
async function verify(base) {
  const get = (route) => fetch(new URL(route, base), { redirect: "manual", signal: AbortSignal.timeout(30000) });
  for (const [route, target] of [["/docs", "/docs.html"], ["/changelog", "/changelog.html"], ["/index.html", "/"]]) {
    const response = await get(route);
    assert.equal(response.status, 301, route);
    const location = response.headers.get("location");
    assert.ok(location === target || location === new URL(target, base).href, `${route}: ${location}`);
    assert.ok(!location.startsWith("http://"), `${route}: insecure redirect`);
  }
  for (const route of ["/", "/docs.html", "/changelog.html", "/robots.txt", "/sitemap.xml", "/fonts/Geist-Variable.woff2", "/style.css", "/main.js", "/assets/screen-main-800.webp", "/favicon.ico", "/apple-touch-icon.png", "/missing-seo-page"]) {
    const response = await get(route);
    assert.equal(response.status, route === "/missing-seo-page" ? 404 : 200, route);
    assert.equal(response.headers.get("x-frame-options"), "DENY", route);
    assert.match(response.headers.get("permissions-policy"), /camera=\(\).*microphone=\(\).*geolocation=\(\)/, route);
    assert.match(response.headers.get("content-security-policy-report-only") || response.headers.get("content-security-policy"), /frame-ancestors 'none'/, route);
    if (route.startsWith("/fonts/")) assert.match(response.headers.get("cache-control"), /max-age=31536000, immutable/);
    if (["/", "/docs.html", "/changelog.html", "/style.css", "/main.js"].includes(route)) assert.match(response.headers.get("cache-control"), /max-age=0, must-revalidate/);
  }
  for (const route of ["/Dockerfile", "/nginx.conf", "/security-headers.conf"]) assert.equal((await get(route)).status, 404, route);
  const sitemap = new JSDOM(await (await get("/sitemap.xml")).text(), { contentType: "text/xml" }).window.document;
  const entries = [...sitemap.querySelectorAll("url")];
  assert.ok(entries.length >= 3);
  for (const entry of entries) {
    const canonical = entry.querySelector("loc").textContent;
    assert.ok(!canonical.endsWith(".txt"));
    assert.match(entry.querySelector("lastmod").textContent, /^\d{4}-\d{2}-\d{2}$/);
    const response = await get(new URL(canonical).pathname);
    assert.equal(response.status, 200, canonical);
    assert.match(response.headers.get("cache-control"), /max-age=0, must-revalidate/, canonical);
    assert.equal(response.headers.get("x-frame-options"), "DENY", canonical);
    assert.match(response.headers.get("content-security-policy-report-only") || "", /frame-ancestors 'none'/, canonical);
    const doc = new JSDOM(await response.text()).window.document;
    assert.equal(doc.querySelector('link[rel="canonical"]').href, canonical);
    const pathname = new URL(canonical).pathname;
    if (/^\/(docs|guides|compare|alternatives)\//.test(pathname)) {
      for (const suffix of ["/", "/index.html"]) {
        const redirect = await get(`${pathname}${suffix}?source=seo-check`);
        assert.equal(redirect.status, 301, pathname + suffix);
        assert.equal(redirect.headers.get("location"), `${pathname}?source=seo-check`);
      }
    }
  }
  for (const route of ["/docs/missing-topic", "/compare/missing-comparison", "/guides/missing-guide"]) assert.equal((await get(route)).status, 404, route);
  console.log(`SEO HTTP checks passed: ${entries.length} sitemap pages, redirects, cache policy, headers, icons and 404s`);
}
if (!process.argv[2]) throw new Error("Usage: node scripts/verify-site-seo.js <base URL>");
verify(process.argv[2]).catch((error) => { console.error(error); process.exitCode = 1; });
