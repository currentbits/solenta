"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  captureServerUrl,
  detectScripts,
  scriptsFromPackageJson,
  appendLog,
  start,
  stop,
} = require("../devservers.js");

function fakeNpmChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.pid = 0;
  child.unref = () => {};
  return child;
}

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

describe("appendLog", () => {
  function fresh() {
    return {
      pid: 0,
      script: "dev",
      startedAt: 0,
      url: null,
      lines: [],
      pending: "",
      dead: false,
      deadAt: null,
    };
  }

  it("rewrites carriage-return progress without growing pending or flooding lines", () => {
    const rec = fresh();
    for (let i = 0; i < 200; i++) {
      appendLog(rec, `building ${i}%\r`);
    }
    assert.ok(rec.pending.length < 100);
    assert.equal(rec.lines.length, 0);
  });

  it("caps a giant newline-less chunk to PENDING_LIMIT", () => {
    const rec = fresh();
    appendLog(rec, "x".repeat(10_000));
    assert.equal(rec.pending.length, 4096);
  });

  it("captures a Local URL and pushes that line", () => {
    const rec = fresh();
    appendLog(rec, "  Local: http://localhost:5173/\n");
    assert.equal(rec.url, "http://localhost:5173/");
    assert.deepEqual(rec.lines, ["  Local: http://localhost:5173/"]);
  });

  it("treats \\r\\n as a newline, not a blank rewrite", () => {
    const rec = fresh();
    appendLog(rec, "a\r\nb\n");
    assert.deepEqual(rec.lines, ["a", "b"]);
  });
});

describe("start spawn shape", () => {
  it("spawns npm run <script> as argv, not /bin/sh -c", () => {
    const calls = [];
    start("t-posix", "/repo", "dev", {
      platform: "darwin",
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeNpmChild();
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "npm");
    assert.deepEqual(calls[0].args, ["run", "dev"]);
    assert.equal(calls[0].opts.cwd, "/repo");
    stop("t-posix");
  });

  it("uses wsl.exe for a WSL-side root on win32", () => {
    const calls = [];
    start("t-wsl", "\\\\wsl$\\Ubuntu\\home\\me\\repo", "dev", {
      platform: "win32",
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeNpmChild();
      },
    });
    assert.equal(calls[0].bin, "wsl.exe");
    assert.deepEqual(calls[0].args, [
      "-d",
      "Ubuntu",
      "--cd",
      "/home/me/repo",
      "--",
      "npm",
      "run",
      "dev",
    ]);
    assert.equal(calls[0].opts.cwd, undefined);
    stop("t-wsl");
  });

  it("keeps npm as the binary on win32 windows-side (cross-spawn finds npm.cmd)", () => {
    const calls = [];
    start("t-win", "C:\\repo", "start", {
      platform: "win32",
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeNpmChild();
      },
    });
    assert.equal(calls[0].bin, "npm");
    assert.deepEqual(calls[0].args, ["run", "start"]);
    assert.equal(calls[0].opts.cwd, "C:\\repo");
    stop("t-win");
  });
});
