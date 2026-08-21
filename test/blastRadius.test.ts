/**
 * Blast-radius classifier + Snowflake interpolation lint (issue #510).
 *
 * Run: node --experimental-strip-types --test test/blastRadius.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blastRadiusFor,
  blastRadiusLabel,
  ciWorkflowBlockMessage,
  ciWorkflowFiles,
  CI_WORKFLOW_BLOCK_PREFIX,
  isCiWorkflowBlockMessage,
  isCiWorkflowPath,
  isGithubWorkflowPath,
  lintWorkflowDiff,
  lintWorkflowPatch,
} from "../src/blastRadius.ts";

describe("isCiWorkflowPath", () => {
  it("matches the #510 CI/workflow list and not ordinary config", () => {
    assert.equal(isCiWorkflowPath(".github/workflows/ci.yml"), true);
    assert.equal(isCiWorkflowPath(".github/workflows/jira_issue.yml"), true);
    assert.equal(isCiWorkflowPath(".github/workflows/release.yaml"), true);
    assert.equal(isCiWorkflowPath("pkg/.github/workflows/ci.yml"), true);
    assert.equal(isCiWorkflowPath(".github\\workflows\\ci.yml"), true);
    assert.equal(isCiWorkflowPath(".gitlab-ci.yml"), true);
    assert.equal(isCiWorkflowPath("nested/.gitlab-ci.yaml"), true);
    assert.equal(isCiWorkflowPath(".circleci/config.yml"), true);
    assert.equal(isCiWorkflowPath("Jenkinsfile"), true);
    assert.equal(isCiWorkflowPath("Jenkinsfile.prod"), true);
    assert.equal(isCiWorkflowPath("azure-pipelines.yml"), true);
    assert.equal(isCiWorkflowPath("bitbucket-pipelines.yml"), true);

    assert.equal(isCiWorkflowPath(".github/ISSUE_TEMPLATE/bug.md"), false);
    assert.equal(isCiWorkflowPath("package.json"), false);
    assert.equal(isCiWorkflowPath("tsconfig.json"), false);
    assert.equal(isCiWorkflowPath("vite.config.ts"), false);
    assert.equal(isCiWorkflowPath(".env.local"), false);
    assert.equal(isCiWorkflowPath("src/reviewItinerary.ts"), false);
    assert.equal(isCiWorkflowPath("docs/Jenkinsfile.md"), false);
  });

  it("treats GitHub Actions YAML as the lint target", () => {
    assert.equal(isGithubWorkflowPath(".github/workflows/ci.yml"), true);
    assert.equal(isGithubWorkflowPath(".github/workflows/notes.md"), false);
    assert.equal(isGithubWorkflowPath(".gitlab-ci.yml"), false);
  });
});

describe("ciWorkflowFiles / blastRadiusFor", () => {
  it("dedupes, posix-normalizes, and ignores non-workflow paths", () => {
    assert.deepEqual(
      ciWorkflowFiles([
        ".github/workflows/ci.yml",
        "src/a.ts",
        ".github\\workflows\\ci.yml",
        "Jenkinsfile",
      ]),
      [".github/workflows/ci.yml", "Jenkinsfile"],
    );
    const radius = blastRadiusFor(["package.json", "src/a.ts"]);
    assert.equal(radius, null);
    const hit = blastRadiusFor([".github/workflows/ci.yml"]);
    assert.equal(hit?.kind, "ci-workflow");
    assert.deepEqual(hit?.files, [".github/workflows/ci.yml"]);
    assert.equal(blastRadiusLabel(hit!), "CI workflow");
  });
});

describe("lintWorkflowPatch — Snowflake pattern", () => {
  const path = ".github/workflows/jira_issue.yml";

  function patch(body: string): string {
    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,4 +1,6 @@",
      body,
    ].join("\n");
  }

  it("flags github.event interpolation on a run: line", () => {
    const findings = lintWorkflowPatch(
      path,
      patch('+  run: echo "${{ github.event.issue.title }}"\n'),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.path, path);
    assert.match(findings[0]?.reason || "", /run:/);
    assert.match(findings[0]?.excerpt || "", /github\.event\.issue\.title/);
  });

  it("flags a YAML list-item - run: line (the Snowflake shape)", () => {
    const findings = lintWorkflowPatch(
      path,
      patch('+      - run: echo "${{ github.event.issue.title }}"\n'),
    );
    assert.equal(findings.length, 1);
  });

  it("flags interpolation inside a run: | block", () => {
    const findings = lintWorkflowPatch(
      path,
      patch(
        [
          "+  run: |",
          '+    echo "${{ github.event.issue.title }}"',
          "+    jq .",
        ].join("\n"),
      ),
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.reason || "", /run: block/);
  });

  it("flags an added interpolation inside an existing run: | block", () => {
    const findings = lintWorkflowPatch(
      path,
      patch(
        [
          "  run: |",
          "    echo ok",
          '+    echo "${{ github.event.comment.body }}"',
        ].join("\n"),
      ),
    );
    assert.equal(findings.length, 1);
  });

  it("does not flag the safe env: + run: $VAR pattern", () => {
    const findings = lintWorkflowPatch(
      path,
      patch(
        [
          "+  env:",
          "+    TITLE: ${{ github.event.issue.title }}",
          "+  run: echo \"$TITLE\" | jq -Rs .",
        ].join("\n"),
      ),
    );
    assert.equal(findings.length, 0);
  });

  it("does not flag github.sha / github.repository in run:", () => {
    const findings = lintWorkflowPatch(
      path,
      patch('+  run: echo "${{ github.sha }}" "${{ github.repository }}"\n'),
    );
    assert.equal(findings.length, 0);
  });

  it("does not lint non-GitHub workflow files", () => {
    assert.deepEqual(
      lintWorkflowPatch(
        ".gitlab-ci.yml",
        "@@ -1 +1 @@\n+  script: echo ${{ github.event.issue.title }}\n",
      ),
      [],
    );
  });

  it("lintWorkflowDiff walks a multi-file patch and skips src", () => {
    const findings = lintWorkflowDiff(
      [
        patch('+  run: echo "${{ github.event.pull_request.title }}"\n'),
        [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1 +1,2 @@",
          '+run: echo "${{ github.event.issue.title }}"',
        ].join("\n"),
      ].join("\n"),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.path, path);
  });
});

describe("merge refusal message", () => {
  it("uses the shared prefix the renderer recognizes", () => {
    const msg = ciWorkflowBlockMessage([".github/workflows/ci.yml"]);
    assert.equal(msg.startsWith(CI_WORKFLOW_BLOCK_PREFIX), true);
    assert.equal(isCiWorkflowBlockMessage(msg), true);
    assert.equal(isCiWorkflowBlockMessage("gh pr merge failed"), false);
    assert.match(msg, /ci\.yml/);
    assert.match(msg, /human must explicitly approve/);
  });
});
