/**
 * Review itinerary planner (issue #421).
 *
 * Run: node --experimental-strip-types --test test/reviewItinerary.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FileChange } from "../src/shared/ipc.ts";
import {
  buildReviewItinerary,
  classifyPath,
  extractAddedSymbols,
  hunkId,
  orderedPatches,
  parsePatch,
  parseReviewAnnotation,
  planMismatches,
  planSummary,
  scanReuse,
} from "../src/reviewItinerary.ts";

function file(
  path: string,
  extras: Partial<FileChange> = {},
): FileChange {
  return { path, status: "M", additions: 4, deletions: 1, ...extras };
}

function patchFor(path: string, body: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,2 +1,4 @@`,
    body,
  ].join("\n");
}

describe("classifyPath", () => {
  it("puts CI and config ahead of everything else", () => {
    assert.equal(classifyPath(".github/workflows/ci.yml"), "ci-config");
    assert.equal(classifyPath("package.json"), "ci-config");
    assert.equal(classifyPath("tsconfig.json"), "ci-config");
    assert.equal(classifyPath("vite.config.ts"), "ci-config");
    assert.equal(classifyPath(".env.local"), "ci-config");
    assert.equal(classifyPath("scripts/publish-release.sh"), "ci-config");
  });

  it("classifies tests, critical path, docs, and meta", () => {
    assert.equal(classifyPath("test/reviewItinerary.test.ts"), "tests");
    assert.equal(classifyPath("src/foo.spec.ts"), "tests");
    assert.equal(classifyPath("electron/runner.js"), "critical");
    assert.equal(classifyPath("src/shared/ipc.ts"), "critical");
    assert.equal(classifyPath("src/App.tsx"), "critical");
    assert.equal(classifyPath("README.md"), "docs");
    assert.equal(classifyPath("docs/guide.md"), "docs");
    assert.equal(classifyPath(".solenta/review-itinerary.json"), "meta");
    assert.equal(classifyPath("src/reviewItinerary.ts"), "impl");
  });
});

describe("parsePatch", () => {
  it("splits a multi-file unified diff and hashes each hunk", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,2 @@",
      " keep",
      "+added",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -4,2 +4,3 @@ function x",
      " ctx",
      "+new",
    ].join("\n");
    const files = parsePatch(patch);
    assert.equal(files.length, 2);
    assert.equal(files[0]?.path, "src/a.ts");
    assert.equal(files[1]?.path, "src/b.ts");
    assert.equal(files[0]?.hunks.length, 1);
    assert.equal(files[0]?.hunks[0]?.header, "@@ -1,1 +1,2 @@");
    assert.equal(
      files[0]?.hunks[0]?.id,
      hunkId("src/a.ts", "@@ -1,1 +1,2 @@", " keep\n+added"),
    );
  });

  it("changes the hunk id when the body changes", () => {
    const a = hunkId("f.ts", "@@ -1 +1 @@", "+old");
    const b = hunkId("f.ts", "@@ -1 +1 @@", "+new");
    assert.notEqual(a, b);
  });
});

describe("extractAddedSymbols / scanReuse", () => {
  it("reads function and const bindings off added lines", () => {
    const names = extractAddedSymbols(
      "src/util.ts",
      [
        "@@ -1 +1,4 @@",
        "+export function formatUsd(n: number) {",
        "+  return n;",
        "+}",
        "+const parseUsd = (s: string) => Number(s);",
      ].join("\n"),
    );
    assert.deepEqual(names, ["formatUsd", "parseUsd"]);
  });

  it("flags a new helper that already exists in the code index", () => {
    const hits = scanReuse(
      [file("src/pay.ts")],
      patchFor("src/pay.ts", "+export function formatUsd() {}\n"),
      [{ name: "formatUsd", path: "src/format.ts" }],
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.name, "formatUsd");
    assert.equal(hits[0]?.existingPath, "src/format.ts");
    assert.equal(hits[0]?.reason, "existing");
  });

  it("flags the same name added in two files of this diff", () => {
    const patch = [
      patchFor("src/a.ts", "+function clip(s: string) { return s; }"),
      patchFor("src/b.ts", "+function clip(s: string) { return s.trim(); }"),
    ].join("\n");
    const hits = scanReuse([file("src/a.ts"), file("src/b.ts")], patch, []);
    assert.ok(hits.some((h) => h.name === "clip" && h.reason === "in-diff"));
  });

  it("does not flag editing a symbol in its own file", () => {
    const hits = scanReuse(
      [file("src/format.ts")],
      patchFor("src/format.ts", "+export function formatUsd() {}\n"),
      [{ name: "formatUsd", path: "src/format.ts" }],
    );
    assert.equal(hits.length, 0);
  });
});

describe("plan vs diff", () => {
  it("summarises a GitHub issue title from the first user prompt", () => {
    assert.equal(
      planSummary(
        "GitHub issue #421: Review itinerary: an ordered plan\n\nExperts don't read diffs top-to-bottom.",
        "thread title",
      ),
      "Review itinerary: an ordered plan",
    );
  });

  it("names files the plan did not mention", () => {
    const mismatches = planMismatches(
      "GitHub issue #421: Review itinerary for agent diffs",
      "Review itinerary",
      [
        file("src/reviewItinerary.ts"),
        file("electron/updater.js"),
        file("site/changelog.html"),
      ],
    );
    assert.equal(mismatches.length, 1);
    assert.match(mismatches[0]!.label, /issue says Review itinerary/);
    assert.match(mismatches[0]!.label, /updater\.js/);
    assert.match(mismatches[0]!.label, /changelog\.html/);
    assert.ok(!mismatches[0]!.extra.includes("src/reviewItinerary.ts"));
  });

  it("is silent when every file matches the plan", () => {
    assert.deepEqual(
      planMismatches("Build the review itinerary planner", "itinerary", [
        file("src/reviewItinerary.ts"),
        file("test/reviewItinerary.test.ts"),
      ]),
      [],
    );
  });
});

describe("buildReviewItinerary", () => {
  const files: FileChange[] = [
    file("src/zebra.ts", { additions: 2, deletions: 0 }),
    file("src/App.tsx", { additions: 8, deletions: 2 }),
    file("test/app.test.tsx", { additions: 12, deletions: 0 }),
    file(".github/workflows/ci.yml", { additions: 6, deletions: 1 }),
    file("README.md", { additions: 3, deletions: 0 }),
    file("src/alpha.ts", { additions: 20, deletions: 4 }),
    file(".solenta/review-itinerary.json", { status: "??", additions: 10 }),
  ];

  const patch = [
    patchFor(".github/workflows/ci.yml", "+  run: npm test\n"),
    patchFor("src/alpha.ts", "+export function formatUsd() {}\n+const x = 1;\n"),
    patchFor("src/App.tsx", "+export function App() {}\n"),
    patchFor("test/app.test.tsx", "+it('works', () => {});\n"),
    patchFor("README.md", "+hello\n"),
    patchFor("src/zebra.ts", "+const z = 1;\n"),
  ].join("\n");

  it("orders chunks by risk, never alphabetical, and drops the annotation file", () => {
    const plan = buildReviewItinerary({ files, patch });
    assert.deepEqual(
      plan.chunks.map((c) => c.area),
      ["ci-config", "critical", "tests", "impl", "docs"],
    );
    const impl = plan.chunks.find((c) => c.area === "impl")!;
    assert.deepEqual(
      impl.files.map((f) => f.path),
      ["src/alpha.ts", "src/zebra.ts"],
    );
    assert.ok(
      !plan.chunks.some((c) =>
        c.files.some((f) => f.path.includes("review-itinerary.json")),
      ),
    );
  });

  it("puts a blast-radius on workflow files and lists reuse + mismatch as steps", () => {
    const plan = buildReviewItinerary({
      files,
      patch,
      planText: "GitHub issue #421: Review itinerary for agent diffs",
      threadTitle: "Review itinerary",
      symbols: [{ name: "formatUsd", path: "src/format.ts" }],
    });
    assert.equal(plan.hardStop, null);
    assert.ok(plan.blastRadius);
    assert.deepEqual(plan.blastRadius?.files, [".github/workflows/ci.yml"]);
    assert.equal(plan.reuseHits[0]?.name, "formatUsd");
    assert.ok(plan.mismatches[0]?.label.includes("issue says"));
    assert.equal(plan.steps[0]?.kind, "blast-radius");
    assert.ok(plan.steps.some((s) => s.kind === "reuse"));
    assert.ok(plan.steps.some((s) => s.kind === "mismatch"));
  });

  it("lints github.event interpolation on a workflow run: line", () => {
    const plan = buildReviewItinerary({
      files: [file(".github/workflows/jira_issue.yml")],
      patch: [
        "diff --git a/.github/workflows/jira_issue.yml b/.github/workflows/jira_issue.yml",
        "--- a/.github/workflows/jira_issue.yml",
        "+++ b/.github/workflows/jira_issue.yml",
        "@@ -1,1 +1,2 @@",
        " name: jira",
        '+  run: echo "${{ github.event.issue.title }}"',
      ].join("\n"),
    });
    assert.equal(plan.blastRadius?.findings.length, 1);
    assert.match(
      plan.blastRadius?.findings[0]?.reason || "",
      /github\.event/,
    );
  });

  it("keeps a hard-stop for non-workflow config and a blast-radius for workflows", () => {
    const plan = buildReviewItinerary({
      files: [file("package.json"), file(".github/workflows/ci.yml")],
      patch: "",
    });
    assert.deepEqual(plan.blastRadius?.files, [".github/workflows/ci.yml"]);
    assert.deepEqual(plan.hardStop?.files, ["package.json"]);
    assert.equal(plan.steps[0]?.kind, "blast-radius");
    assert.equal(plan.steps[1]?.kind, "hard-stop");
  });

  it("tests-first moves tests ahead of critical, still after CI", () => {
    const plan = buildReviewItinerary({ files, patch, testsFirst: true });
    assert.deepEqual(
      plan.chunks.map((c) => c.area),
      ["ci-config", "tests", "critical", "impl", "docs"],
    );
  });

  it("marks previously accepted hunks and recounts only new ones", () => {
    const first = buildReviewItinerary({ files, patch });
    const keep = first.hunks[0]!;
    const again = buildReviewItinerary({
      files,
      patch,
      acceptedHunks: [keep.id, "stale-hash"],
    });
    assert.equal(again.hunks.find((h) => h.id === keep.id)?.accepted, true);
    assert.equal(again.acceptedHunkCount, 1);
    assert.equal(again.newHunkCount, again.hunks.length - 1);
  });

  it("orderedPatches follows chunk order, not git file order", () => {
    const plan = buildReviewItinerary({ files, patch });
    const paths = orderedPatches(plan).map((p) => p.path);
    assert.equal(paths[0], ".github/workflows/ci.yml");
    assert.ok(paths.indexOf("src/App.tsx") < paths.indexOf("src/alpha.ts"));
    assert.ok(paths.indexOf("test/app.test.tsx") < paths.indexOf("README.md"));
  });
});

describe("parseReviewAnnotation", () => {
  it("accepts a well-formed agent annotation and drops empty junk", () => {
    const parsed = parseReviewAnnotation({
      version: 1,
      readOrder: ["ci-config", "impl"],
      chunks: [
        { area: "impl", rationale: "the planner", risks: ["off-by-one"] },
      ],
      risks: ["forgot tests"],
    });
    assert.deepEqual(parsed?.readOrder, ["ci-config", "impl"]);
    assert.equal(parsed?.chunks[0]?.rationale, "the planner");
    assert.equal(parseReviewAnnotation({ version: 1 }), null);
    assert.equal(parseReviewAnnotation(null), null);
    assert.equal(parseReviewAnnotation("nope"), null);
  });
});
