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
  reviewItineraryPathFor,
  reviewItineraryNoteFor,
  readAnnotation,
  flattenSymbols,
  normalizeAcceptedHunks,
  loadReviewContext,
  setReviewAccepted,
} = require("../reviewItinerary.js");
const { reviewItineraryNoteFor: fromServices } = require("../services.js");

const THREAD_ID = "a2db4269-c85d-4822-815d-c03f5d92a395";

describe("reviewItineraryNoteFor", () => {
  it("is silent without a worktree and speaks the per-thread path (#621)", () => {
    assert.equal(reviewItineraryNoteFor(null), "");
    assert.equal(reviewItineraryNoteFor({}), "");
    assert.equal(reviewItineraryNoteFor({ worktreePath: null }), "");
    assert.equal(reviewItineraryNoteFor({ worktreePath: "/tmp/wt" }), "");
    const note = reviewItineraryNoteFor({ id: THREAD_ID, worktreePath: "/tmp/wt" });
    const rel = reviewItineraryPathFor(THREAD_ID);
    assert.equal(rel, `.solenta/review-itinerary/${THREAD_ID}.json`);
    assert.match(note, new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(note, /`\.solenta\/review-itinerary\.json`/);
    assert.match(note, /never alphabetical/);
    assert.equal(
      reviewItineraryNoteFor({ id: THREAD_ID, pendingWorktree: true }),
      note,
    );
    assert.equal(
      fromServices({ id: THREAD_ID, worktreePath: "/tmp/wt" }),
      note,
    );
    assert.equal(reviewItineraryPathFor("../escape"), "");
    assert.equal(reviewItineraryPathFor("a/b"), "");
    assert.equal(
      reviewItineraryNoteFor({ id: "../escape", worktreePath: "/tmp/wt" }),
      "",
    );
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

  it("prefers the per-thread file and falls back to the legacy flat path (#621)", () => {
    const cwd = path.join(tmp, "per-thread");
    const id = "thread-aaa";
    fs.mkdirSync(path.join(cwd, ".solenta", "review-itinerary"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(cwd, reviewItineraryPathFor(id)),
      JSON.stringify({ version: 1, risks: ["per-thread"] }),
    );
    fs.writeFileSync(
      path.join(cwd, REVIEW_ITINERARY_FILE),
      JSON.stringify({ version: 1, risks: ["legacy"] }),
    );
    assert.deepEqual(readAnnotation(cwd, id).risks, ["per-thread"]);
    assert.deepEqual(readAnnotation(cwd, "other-thread").risks, ["legacy"]);
    assert.deepEqual(readAnnotation(cwd).risks, ["legacy"]);
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

  it("loadReviewContext concatenates the directory and keeps same-area chunks (#621)", () => {
    const cwd = path.join(tmp, "dir-concat");
    fs.mkdirSync(path.join(cwd, ".solenta", "review-itinerary"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(cwd, reviewItineraryPathFor("t-a")),
      JSON.stringify({
        version: 1,
        readOrder: ["tests", "impl"],
        chunks: [{ area: "impl", rationale: "from a", risks: ["a-risk"] }],
        risks: ["a top"],
      }),
    );
    fs.writeFileSync(
      path.join(cwd, reviewItineraryPathFor("t-b")),
      JSON.stringify({
        version: 1,
        readOrder: ["critical"],
        chunks: [{ area: "impl", rationale: "from b", risks: ["b-risk"] }],
        risks: ["b top"],
      }),
    );
    fs.writeFileSync(
      path.join(cwd, REVIEW_ITINERARY_FILE),
      JSON.stringify({
        version: 1,
        chunks: [{ area: "tests", rationale: "legacy", risks: [] }],
        risks: ["legacy top"],
      }),
    );
    const thread = {
      id: "t-a",
      projectId: "p1",
      worktreePath: cwd,
      reviewAcceptedHunks: [],
    };
    const store = {
      getThread: (id) => (id === "t-a" ? thread : null),
      getProject: (id) =>
        id === "p1" ? { id: "p1", path: cwd, remoteHost: null } : null,
    };
    const ctx = loadReviewContext({ store, threadId: "t-a", userDataPath: "" });
    const areas = ctx.annotation.chunks.map((c) => `${c.area}:${c.rationale}`);
    assert.ok(areas.includes("impl:from a"));
    assert.ok(areas.includes("impl:from b"), "same-area chunks must not dedupe");
    assert.ok(areas.includes("tests:legacy"));
    assert.deepEqual(ctx.annotation.readOrder, ["tests", "impl"]);
    assert.ok(ctx.annotation.risks.includes("a top"));
    assert.ok(ctx.annotation.risks.includes("b top"));
    assert.ok(ctx.annotation.risks.includes("legacy top"));
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
