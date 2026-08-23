/**
 * Renderer preview URL helpers (issue #155). Must stay in lockstep with
 * electron/links.js isLoopbackHost / coercePreviewUrl.
 *
 * Run: node --import=./test/support/render.mjs --test test/previewUrl.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coercePreviewUrl, isLoopbackPreviewUrl } from "../src/previewUrl";

describe("previewUrl", () => {
  it("prepends http:// when the user typed host:port", () => {
    assert.equal(coercePreviewUrl("localhost:5173"), "http://localhost:5173");
    assert.equal(coercePreviewUrl("  127.0.0.1:3000/ "), "http://127.0.0.1:3000/");
    assert.equal(coercePreviewUrl("https://localhost/"), "https://localhost/");
  });

  it("accepts loopback hosts and rejects the open web", () => {
    for (const url of [
      "http://localhost:5173/",
      "http://127.0.0.1:3000",
      "http://0.0.0.0:8080",
      "http://[::1]:80/",
      "http://app.localhost:5173/",
    ]) {
      assert.equal(isLoopbackPreviewUrl(url), true, url);
    }
    assert.equal(isLoopbackPreviewUrl("https://github.com/x"), false);
    assert.equal(isLoopbackPreviewUrl("http://localhost.evil.com/"), false);
    assert.equal(isLoopbackPreviewUrl("file:///etc/passwd"), false);
    assert.equal(isLoopbackPreviewUrl("not a url"), false);
  });
});
