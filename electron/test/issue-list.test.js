"use strict";

/**
 * parseIssueListJson: gh issue list JSON → PlanIssue rows.
 * planboardNoteFor: note only for checkouts with a GitHub origin.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseIssueListJson } = require("../issues.js");
const { planboardNoteFor, PLANBOARD_NOTE } = require("../services.js");

describe("parseIssueListJson", () => {
  it("maps rows, label names, state, and updatedAt", () => {
    const rows = parseIssueListJson(
      JSON.stringify([
        {
          number: 7,
          title: "Ship it",
          url: "https://github.com/a/b/issues/7",
          state: "OPEN",
          labels: [{ name: "plan:doing" }, { name: "roadmap" }],
          updatedAt: "2026-01-02T03:04:05Z",
        },
        {
          number: 8,
          title: "Done thing",
          url: "https://github.com/a/b/issues/8",
          state: "closed",
          labels: [],
        },
      ]),
    );
    assert.deepEqual(rows, [
      {
        number: 7,
        title: "Ship it",
        url: "https://github.com/a/b/issues/7",
        state: "OPEN",
        labels: ["plan:doing", "roadmap"],
        updatedAt: "2026-01-02T03:04:05Z",
      },
      {
        number: 8,
        title: "Done thing",
        url: "https://github.com/a/b/issues/8",
        state: "CLOSED",
        labels: [],
      },
    ]);
  });

  it("drops rows missing number, title, or url; keeps the rest", () => {
    const rows = parseIssueListJson(
      JSON.stringify([
        { number: 0, title: "bad", url: "u" },
        { number: 1, title: "", url: "u" },
        { number: 2, title: "ok", url: "" },
        { number: 3, title: "good", url: "https://x/3", state: "OPEN" },
      ]),
    );
    assert.deepEqual(
      rows.map((r) => r.number),
      [3],
    );
  });

  it("empty stdout is an empty list", () => {
    assert.deepEqual(parseIssueListJson(""), []);
  });

  it("throws on non-JSON and non-array JSON", () => {
    assert.throws(() => parseIssueListJson("nope"), /unparseable/);
    assert.throws(() => parseIssueListJson("{}"), /incomplete/);
  });
});

describe("planboardNoteFor", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-note-"));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function git(cwd, args) {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  it("empty for a missing path and for a repo without a GitHub origin", () => {
    assert.equal(planboardNoteFor(""), "");
    assert.equal(planboardNoteFor(path.join(tmp, "nope")), "");
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    git(plain, ["init", "-q"]);
    assert.equal(planboardNoteFor(plain), "");
    git(plain, ["remote", "add", "origin", "https://gitlab.com/a/b.git"]);
    assert.equal(planboardNoteFor(plain), "");
  });

  it("returns the note for a GitHub origin", () => {
    const gh = path.join(tmp, "gh");
    fs.mkdirSync(gh);
    git(gh, ["init", "-q"]);
    git(gh, ["remote", "add", "origin", "git@github.com:acme/demo.git"]);
    assert.equal(planboardNoteFor(gh), PLANBOARD_NOTE);
    assert.match(PLANBOARD_NOTE, /plan:todo, plan:doing, plan:done/);
  });
});
