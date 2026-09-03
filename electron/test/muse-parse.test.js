"use strict";

/**
 * Muse exec --json extractors (#873). Fixture-driven from Task 1 capture.
 * Echo has no tool start/result and no usage; do not invent those shapes.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  extractSessionId,
  extractAssistantText,
  extractThinking,
  extractToolEvent,
  extractUsage,
  toolCardKey,
} = require("../muse.js");

const DIR = path.join(__dirname, "fixtures", "muse");
function load(name) {
  return fs.readFileSync(path.join(DIR, name), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("muse JSONL extractors", () => {
  it("extracts a session id from echo-hello", () => {
    const ids = load("echo-hello.jsonl").map(extractSessionId).filter(Boolean);
    assert.ok(ids.length >= 1, "CAPTURE.md must name the session-id path");
    assert.equal(typeof ids[0], "string");
    assert.ok(ids[0].length > 0);
  });

  it("uses stream.id when stream.kind is session, not top-level id", () => {
    const row = load("echo-hello.jsonl")[0];
    const id = extractSessionId(row);
    assert.equal(id, row.stream.id);
    assert.notEqual(id, row.id);
    const withRun = load("echo-hello.jsonl").find(
      (o) => o.payload && o.payload.run_stream && o.payload.run_stream.id,
    );
    assert.ok(withRun);
    assert.notEqual(extractSessionId(withRun), withRun.payload.run_stream.id);
  });

  it("extracts assistant text from echo-hello", () => {
    const text = load("echo-hello.jsonl").map(extractAssistantText).filter(Boolean).join("");
    assert.match(text, /hello/i);
  });

  it("reads payload.text from run.output.delta and run.terminal.completed", () => {
    const rows = load("echo-hello.jsonl");
    const delta = rows.find((o) => o.payload_type === "run.output.delta");
    const term = rows.find((o) => o.payload_type === "run.terminal.completed");
    assert.ok(delta);
    assert.ok(term);
    assert.match(extractAssistantText(delta), /hello/i);
    assert.match(extractAssistantText(term), /hello/i);
    const user = rows.find((o) => o.payload_type === "turn.input.user");
    assert.equal(extractAssistantText(user), null);
  });

  it("ignores unknown objects", () => {
    assert.equal(extractSessionId({ not: "ours" }), null);
    assert.equal(extractAssistantText({ not: "ours" }), null);
    assert.equal(extractToolEvent({ not: "ours" }), null);
  });

  it("tool card keys are stream-scoped", () => {
    assert.equal(toolCardKey("s1", "1"), "s1:1");
    assert.notEqual(toolCardKey("s1", "1"), toolCardKey("s2", "1"));
  });

  it("returns null for thinking, tools, and usage on echo fixtures", () => {
    for (const name of ["echo-hello.jsonl", "echo-tools.jsonl"]) {
      for (const obj of load(name)) {
        assert.equal(extractThinking(obj), null);
        assert.equal(extractToolEvent(obj), null);
        assert.equal(extractUsage(obj), null);
      }
    }
  });

  it("never throws on unknown or malformed objects", () => {
    for (const bad of [null, undefined, 1, "x", [], { payload_type: 1 }]) {
      assert.equal(extractSessionId(bad), null);
      assert.equal(extractAssistantText(bad), null);
      assert.equal(extractThinking(bad), null);
      assert.equal(extractToolEvent(bad), null);
      assert.equal(extractUsage(bad), null);
    }
  });
});
