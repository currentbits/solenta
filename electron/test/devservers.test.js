"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  captureServerUrl,
  detectScripts,
  scriptsFromPackageJson,
} = require("../devservers.js");

const temps = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-devservers-"));
  temps.push(dir);
  return dir;
}

after(() => {
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("captureServerUrl", () => {
  it("extracts the first http(s) URL that includes a port", () => {
    assert.equal(
      captureServerUrl("  Local: http://localhost:5173/"),
      "http://localhost:5173/",
    );
    assert.equal(
      captureServerUrl("ready on http://0.0.0.0:3000"),
      "http://0.0.0.0:3000",
    );
    assert.equal(
      captureServerUrl("https://127.0.0.1:8080/path?x=1"),
      "https://127.0.0.1:8080/path?x=1",
    );
  });

  it("returns the first URL when several appear", () => {
    assert.equal(
      captureServerUrl(
        "  Local:   http://localhost:5173/\n  Network: http://192.168.1.5:5173/",
      ),
      "http://localhost:5173/",
    );
  });

  it("ignores urls without a port and empty input", () => {
    assert.equal(captureServerUrl(""), null);
    assert.equal(captureServerUrl("listening on unix socket"), null);
    assert.equal(captureServerUrl("see https://example.com/docs"), null);
  });

  it("strips trailing sentence punctuation from the match", () => {
    assert.equal(
      captureServerUrl("open http://localhost:3000."),
      "http://localhost:3000",
    );
  });
});

describe("detectScripts", () => {
  it("returns present scripts in preference order: dev, start, serve", () => {
    assert.deepEqual(
      scriptsFromPackageJson({
        scripts: { serve: "npx serve", lint: "eslint .", start: "node .", dev: "vite" },
      }),
      ["dev", "start", "serve"],
    );
    assert.deepEqual(
      scriptsFromPackageJson({ scripts: { serve: "serve ." } }),
      ["serve"],
    );
    assert.deepEqual(scriptsFromPackageJson({ scripts: { test: "node --test" } }), []);
    assert.deepEqual(scriptsFromPackageJson({}), []);
    assert.deepEqual(scriptsFromPackageJson(null), []);
  });

  it("reads package.json at the thread root", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { start: "node server.js", build: "tsc" } }),
    );
    assert.deepEqual(detectScripts(dir), ["start"]);
  });

  it("returns [] when package.json is missing or invalid", () => {
    const dir = tmpDir();
    assert.deepEqual(detectScripts(dir), []);
    fs.writeFileSync(path.join(dir, "package.json"), "{not json");
    assert.deepEqual(detectScripts(dir), []);
    assert.deepEqual(detectScripts(""), []);
  });

  it("skips blank script values", () => {
    assert.deepEqual(
      scriptsFromPackageJson({ scripts: { dev: "   ", start: "node ." } }),
      ["start"],
    );
  });
});
