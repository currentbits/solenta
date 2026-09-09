"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "fixtures", "muse");

function readJsonl(name) {
  const raw = fs.readFileSync(path.join(DIR, name), "utf8");
  const rows = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t));
  }
  return rows;
}

describe("muse fixtures", () => {
  it("echo-hello.jsonl is JSONL with at least one object", () => {
    const rows = readJsonl("echo-hello.jsonl");
    assert.ok(rows.length >= 1);
    assert.equal(typeof rows[0], "object");
  });

  it("help.txt was captured", () => {
    const help = fs.readFileSync(path.join(DIR, "help.txt"), "utf8");
    assert.match(help, /exec|json|session/i);
  });

  it("spark-tools.jsonl is JSONL with a tool start and result", () => {
    const rows = readJsonl("spark-tools.jsonl");
    assert.ok(rows.length >= 1);
    assert.ok(
      rows.some((o) => o.payload_type === "task.lifecycle.side_effect_intent"),
    );
    assert.ok(rows.some((o) => o.payload_type === "tool.result"));
  });
});
