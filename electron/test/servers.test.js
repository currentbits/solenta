"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  parseLsofListen,
  parseLsofCwds,
  cwdInsideRoot,
  filterServersByRoot,
  buildServerUrl,
} = require("../servers.js");

const LISTEN_FIXTURE = [
  "p1234",
  "cnode",
  "f19",
  "n*:5173",
  "n127.0.0.1:5173",
  "p5678",
  "cPython",
  "n0.0.0.0:8000",
  "p9012",
  "cnginx",
  "n[::]:80",
  "n[::1]:8080",
  "p3456",
  "cnode",
  "n192.168.1.20:3000",
  "p111",
  "cother",
  "n*:9999",
].join("\n");

const CWD_FIXTURE = [
  "p1234",
  "fcwd",
  "n/tmp/proj",
  "p5678",
  "fcwd",
  "n/tmp/proj/app",
  "p9012",
  "fcwd",
  "n/tmp/other",
  "p3456",
  "fcwd",
  "n/tmp/proj",
  "p111",
  "fcwd",
  "n/var/unrelated",
].join("\n");

describe("parseLsofListen", () => {
  it("parses pid, command, host, and port from -F pcn fixture output", () => {
    const entries = parseLsofListen(LISTEN_FIXTURE);
    assert.deepEqual(entries, [
      { pid: 1234, command: "node", host: "*", port: 5173 },
      { pid: 1234, command: "node", host: "127.0.0.1", port: 5173 },
      { pid: 5678, command: "Python", host: "0.0.0.0", port: 8000 },
      { pid: 9012, command: "nginx", host: "[::]", port: 80 },
      { pid: 9012, command: "nginx", host: "[::1]", port: 8080 },
      { pid: 3456, command: "node", host: "192.168.1.20", port: 3000 },
      { pid: 111, command: "other", host: "*", port: 9999 },
    ]);
  });

  it("returns [] for empty or garbage input", () => {
    assert.deepEqual(parseLsofListen(""), []);
    assert.deepEqual(parseLsofListen("not-lsof"), []);
  });
});

describe("parseLsofCwds", () => {
  it("maps pid to cwd from -Fn fixture output", () => {
    const cwds = parseLsofCwds(CWD_FIXTURE);
    assert.equal(cwds.get(1234), "/tmp/proj");
    assert.equal(cwds.get(5678), "/tmp/proj/app");
    assert.equal(cwds.get(9012), "/tmp/other");
    assert.equal(cwds.has(9999), false);
  });
});

describe("cwd-root filter", () => {
  it("keeps the root itself and descendants, not siblings", () => {
    const root = "/tmp/proj";
    const sep = path.sep;
    assert.equal(cwdInsideRoot("/tmp/proj", root), true);
    assert.equal(cwdInsideRoot(`/tmp/proj${sep}app`, root), true);
    assert.equal(cwdInsideRoot("/tmp/proj-other", root), false);
    assert.equal(cwdInsideRoot("/tmp/other", root), false);
    assert.equal(cwdInsideRoot("", root), false);
    assert.equal(cwdInsideRoot("/tmp/proj", ""), false);
  });

  it("keeps only in-root listeners, deduped by port, with urls", () => {
    const entries = parseLsofListen(LISTEN_FIXTURE);
    const cwds = parseLsofCwds(CWD_FIXTURE);
    const servers = filterServersByRoot(entries, cwds, "/tmp/proj");
    assert.deepEqual(servers, [
      {
        pid: 1234,
        command: "node",
        host: "*",
        port: 5173,
        url: "http://localhost:5173",
      },
      {
        pid: 5678,
        command: "Python",
        host: "0.0.0.0",
        port: 8000,
        url: "http://localhost:8000",
      },
      {
        pid: 3456,
        command: "node",
        host: "192.168.1.20",
        port: 3000,
        url: "http://192.168.1.20:3000",
      },
    ]);
  });

  it("uses the bound host for a specific non-wildcard interface", () => {
    assert.equal(buildServerUrl("*", 3000), "http://localhost:3000");
    assert.equal(buildServerUrl("0.0.0.0", 3000), "http://localhost:3000");
    assert.equal(buildServerUrl("[::]", 80), "http://localhost:80");
    assert.equal(buildServerUrl("127.0.0.1", 5173), "http://127.0.0.1:5173");
    assert.equal(buildServerUrl("[::1]", 8080), "http://[::1]:8080");
  });
});
