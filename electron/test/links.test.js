const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { windowOpenAction, navigateAction } = require("../links.js");

const DEV = "http://localhost:5173";
const APP = "file:///Applications/Solenta.app/Contents/Resources/app/dist/index.html";

describe("external link policy", () => {
  it("sends http(s) targets to the OS browser", () => {
    assert.deepEqual(
      windowOpenAction("https://github.com/owner/repo/pull/7"),
      { external: true },
    );
    assert.deepEqual(windowOpenAction("http://example.com"), { external: true });
  });

  it("refuses to hand non-web schemes to the OS", () => {
    // openExternal on these is a local-code-execution footgun, not a link.
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vscode://file/etc/passwd",
      "",
    ]) {
      assert.deepEqual(
        windowOpenAction(url),
        { external: false },
        `${url} must not be opened externally`,
      );
    }
  });

  it("blocks the app window from navigating to the web", () => {
    const r = navigateAction("https://github.com/owner/repo/pull/7", {
      currentUrl: APP,
    });
    assert.equal(r.allow, false, "the window must never leave the app");
    assert.equal(r.external, true, "but the link should still open somewhere");
  });

  it("allows a reload of the page already loaded", () => {
    assert.deepEqual(navigateAction(APP, { currentUrl: APP }), {
      allow: true,
      external: false,
    });
  });

  it("allows dev-server navigation only in dev", () => {
    const inDev = navigateAction(`${DEV}/index.html`, {
      currentUrl: DEV,
      isDev: true,
      devServerUrl: DEV,
    });
    assert.equal(inDev.allow, true, "HMR navigation must survive in dev");

    const packaged = navigateAction(`${DEV}/index.html`, {
      currentUrl: APP,
      isDev: false,
      devServerUrl: DEV,
    });
    assert.equal(
      packaged.allow,
      false,
      "a packaged app must not navigate to localhost",
    );
  });

  it("matches the dev server by origin, not string prefix", () => {
    // startsWith admits all three of these; they are different hosts.
    for (const evil of [
      "http://localhost:5173.evil.com/x",
      "http://localhost:5173@evil.com/",
      "http://localhost:51730/x",
    ]) {
      const r = navigateAction(evil, {
        currentUrl: DEV,
        isDev: true,
        devServerUrl: DEV,
      });
      assert.equal(r.allow, false, `${evil} must not be treated as the dev server`);
    }
    // The real dev server still works.
    assert.equal(
      navigateAction(`${DEV}/src/main.tsx`, {
        currentUrl: DEV,
        isDev: true,
        devServerUrl: DEV,
      }).allow,
      true,
    );
  });

  it("blocks a file:// navigation without offering it to the OS", () => {
    const r = navigateAction("file:///etc/passwd", { currentUrl: APP });
    assert.deepEqual(r, { allow: false, external: false });
  });
});

const {
  previewNavigateAction,
  isLoopbackHost,
  coercePreviewUrl,
  canonicalizePreviewUrl,
} = require("../links.js");

describe("preview guest navigation policy (issue #155)", () => {
  it("allows loopback http(s) and about:blank", () => {
    for (const url of [
      "http://localhost:5173/",
      "http://127.0.0.1:3000/app",
      "https://localhost/",
      "http://[::1]:8080/",
      "http://foo.localhost:5173/",
      "about:blank",
    ]) {
      const r = previewNavigateAction(url);
      assert.equal(r.allow, true, url);
      assert.equal(r.external, false, url);
    }
  });

  it("rewrites 0.0.0.0 bind-all banners to 127.0.0.1", () => {
    const r = previewNavigateAction("http://0.0.0.0:3000/");
    assert.equal(r.allow, true);
    assert.equal(r.url, "http://127.0.0.1:3000/");
  });

  it("coerces a scheme-less localhost:port to http", () => {
    assert.equal(coercePreviewUrl("localhost:5173"), "http://localhost:5173");
    const r = previewNavigateAction("localhost:5173");
    assert.equal(r.allow, true);
    assert.ok(r.url && r.url.startsWith("http://localhost:5173"));
  });

  it("sends non-loopback http(s) to the OS browser instead of the guest", () => {
    const r = previewNavigateAction("https://github.com/currentbits/solenta");
    assert.equal(r.allow, false);
    assert.equal(r.external, true);
  });

  it("drops file, javascript, and data URLs", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      assert.deepEqual(
        previewNavigateAction(url),
        { allow: false, external: false },
        url,
      );
    }
  });

  it("does not treat prefix-similar hosts as loopback", () => {
    assert.equal(isLoopbackHost("localhost.evil.com"), false);
    assert.equal(isLoopbackHost("127.0.0.1.evil.com"), false);
    const r = previewNavigateAction("http://localhost.evil.com/");
    assert.equal(r.allow, false);
    assert.equal(r.external, true);
  });

  it("canonicalizePreviewUrl is null on garbage", () => {
    assert.equal(canonicalizePreviewUrl("not a url"), null);
  });
});
