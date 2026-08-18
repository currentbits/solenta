"use strict";

/**
 * Review itinerary extras: finishing-agent note, annotation file, accepted hunks.
 *
 * Run: node --test electron/test/review-itinerary.test.js
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  REVIEW_ITINERARY_FILE,
  REVIEW_ITINERARY_NOTE,
  reviewItineraryNoteFor,
  readAnnotation,
  flattenSymbols,
  normalizeAcceptedHunks,
  loadReviewContext,
  setReviewAccepted,
} = require("../reviewItinerary.js");
const { reviewItineraryNoteFor: fromServices, REVIEW_ITINERARY_NOTE: noteFromServices } =
  require("../services.js");

describe("reviewItineraryNoteFor", () => {
  it("is silent without a worktree and speaks on a coding thread", () => {
    assert.equal(reviewItineraryNoteFor(null), "");
    assert.equal(reviewItineraryNoteFor({}), "");
    assert.equal(reviewItineraryNoteFor({ worktreePath: null }), "");
    const note = reviewItineraryNoteFor({ worktreePath: "/tmp/wt" });
    assert.equal(note, REVIEW_ITINERARY_NOTE);
    assert.match(note, /\.solenta\/review-itinerary\.json/);
    assert.match(note, /never alphabetical/);
    assert.equal(reviewItineraryNoteFor({ pendingWorktree: true }), note);
    assert.equal(fromServices({ worktreePath: "/tmp/wt" }), noteFromServices);
  });
});

describe("annotation + accepted hunks", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-itin-"));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("reads a well-formed annotation and ignores junk", () => {
    const cwd = path.join(tmp, "wt");
    fs.mkdirSync(path.join(cwd, ".solenta"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, REVIEW_ITINERARY_FILE),
      JSON.stringify({
        version: 1,
        readOrder: ["ci-config", "impl"],
        chunks: [{ area: "impl", rationale: "the planner", risks: [] }],
        risks: ["forgot tests"],
      }),
    );
    const got = readAnnotation(cwd);
    assert.deepEqual(got.readOrder, ["ci-config", "impl"]);
    assert.equal(readAnnotation(path.join(tmp, "missing")), null);
    fs.writeFileSync(path.join(cwd, REVIEW_ITINERARY_FILE), "not-json");
    assert.equal(readAnnotation(cwd), null);
  });

  it("caps and dedupes accepted hunk hashes", () => {
    assert.deepEqual(normalizeAcceptedHunks(["a", "a", "", "b"]), ["a", "b"]);
    assert.equal(normalizeAcceptedHunks(null).length, 0);
    const many = Array.from({ length: 600 }, (_, i) => `h${i}`);
    assert.equal(normalizeAcceptedHunks(many).length, 500);
  });

  it("loadReviewContext returns annotation, symbols, and accepted hunks", () => {
    const cwd = path.join(tmp, "ctx");
    fs.mkdirSync(path.join(cwd, ".solenta"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, REVIEW_ITINERARY_FILE),
      JSON.stringify({ version: 1, risks: ["watch the runner"] }),
    );
    const thread = {
      id: "t1",
      projectId: "p1",
      worktreePath: cwd,
      reviewAcceptedHunks: ["abc", "abc"],
    };
    const store = {
      getThread: (id) => (id === "t1" ? thread : null),
      getProject: (id) =>
        id === "p1" ? { id: "p1", path: cwd, remoteHost: null } : null,
      updateThread: (id, patch) => Object.assign(thread, patch),
    };
    const ctx = loadReviewContext({ store, threadId: "t1", userDataPath: "" });
    assert.deepEqual(ctx.acceptedHunks, ["abc"]);
    assert.deepEqual(ctx.annotation.risks, ["watch the runner"]);
    assert.deepEqual(ctx.symbols, []);

    const updated = setReviewAccepted(store, "t1", ["h1", "h1", "h2"]);
    assert.deepEqual(updated.reviewAcceptedHunks, ["h1", "h2"]);
  });

  it("flattenSymbols walks the code index", () => {
    const rows = flattenSymbols({
      files: [
        { path: "src/format.ts", symbols: ["formatUsd", "clip"] },
        { path: "src/a.ts", symbols: ["App"] },
      ],
    });
    assert.deepEqual(rows, [
      { name: "formatUsd", path: "src/format.ts" },
      { name: "clip", path: "src/format.ts" },
      { name: "App", path: "src/a.ts" },
    ]);
  });
});
