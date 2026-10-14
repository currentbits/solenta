/**
 * Proactive fix suggestions (#253): failure detection over real toolchain
 * output, and the prompt a fix card sends.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectFailure, failureKey, fixPrompt, plainText } from "../src/fixSuggest.ts";

const hit = (text: string) => detectFailure(plainText(text));

describe("detectFailure", () => {
  it("spots build errors from common toolchains", () => {
    for (const [out, line] of [
      ["src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."],
      ["\x1b[96msrc/a.ts\x1b[0m:\x1b[93m3\x1b[0m:\x1b[93m7\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2322: \x1b[0mType", "src/a.ts:3:7 - error TS2322: Type"],
      ["error[E0308]: mismatched types\n --> src/main.rs:4:18", "error[E0308]: mismatched types"],
      ["main.c:5:3: error: use of undeclared identifier 'x'", "main.c:5:3: error: use of undeclared identifier 'x'"],
      ["✘ [ERROR] Could not resolve \"./nope\"", "✘ [ERROR] Could not resolve \"./nope\""],
      ["12:01:02 [vite] Internal server error: Failed to resolve import", "12:01:02 [vite] Internal server error: Failed to resolve import"],
    ]) {
      assert.deepEqual(hit(out), { kind: "build", line }, out);
    }
  });

  it("spots test failures from common runners", () => {
    for (const out of [
      " FAIL  src/sum.test.ts > adds",
      "Tests:       1 failed, 4 passed, 5 total",
      " Tests  2 failed | 10 passed (12)",
      "# tests 9\n# pass 8\n# fail 1",
      "ℹ fail 3",
      "  2 failing",
      "--- FAIL: TestSum (0.00s)",
      "test result: FAILED. 3 passed; 1 failed",
      "FAILED tests/test_x.py::test_sum - assert 1 == 2",
    ]) {
      assert.equal(hit(out)?.kind, "test", out);
    }
  });

  it("spots merge and rebase conflicts", () => {
    assert.deepEqual(
      hit("Auto-merging a.ts\nCONFLICT (content): Merge conflict in a.ts\nAutomatic merge failed; fix conflicts and then commit the result."),
      { kind: "conflict", line: "CONFLICT (content): Merge conflict in a.ts" },
    );
    assert.equal(hit("error: could not apply 1a2b3c4... wip")?.kind, "conflict");
  });

  it("stays quiet on passing runs and everyday output", () => {
    for (const out of [
      "# tests 9\n# pass 9\n# fail 0",
      "ℹ fail 0",
      "Tests:       5 passed, 5 total",
      "  VITE v6.0.0  ready in 300 ms\n  ➜  Local:   http://localhost:5173/",
      "$ git status\nOn branch main\nnothing to commit, working tree clean",
      "error: pathspec 'nope' did not match any file(s) known to git",
      "npm warn deprecated inflight@1.0.6",
    ]) {
      assert.equal(hit(out), null, out);
    }
  });

  it("prefers the conflict over the build errors it causes", () => {
    assert.equal(hit("a.ts(1,1): error TS1185: Merge conflict marker encountered.\nCONFLICT (content): Merge conflict in a.ts")?.kind, "conflict");
  });
});

describe("plainText", () => {
  it("drops escapes and keeps what a \\r rewrite left on screen", () => {
    assert.equal(plainText("\x1b[31mred\x1b[0m\r\nbuilding 10%\rbuilding 100%\r\n"), "red\nbuilding 100%\n");
  });
});

describe("failureKey", () => {
  it("treats a rerun with new numbers as the same failure", () => {
    assert.equal(
      failureKey({ kind: "test", line: "Tests:  1 failed, 4 passed (1.2s)" }),
      failureKey({ kind: "test", line: "Tests:  2 failed, 3 passed (0.9s)" }),
    );
  });
});

describe("fixPrompt", () => {
  it("quotes the output around the failing line and asks for a fix", () => {
    const noise = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const out = [...noise.slice(0, 60), "src/a.ts(3,7): error TS2322: bad", ...noise.slice(60)].join("\n");
    const prompt = fixPrompt({ kind: "build", line: "src/a.ts(3,7): error TS2322: bad" }, "terminal", out);
    assert.match(prompt, /^The terminal in this thread's worktree reported a build error:/);
    assert.match(prompt, /error TS2322: bad/);
    assert.match(prompt, /line 59\n/);
    assert.doesNotMatch(prompt, /line 0\n/);
    assert.match(prompt, /re-run the build to confirm\.$/);
  });

  it("falls back to the latest output when the line has scrolled out", () => {
    const out = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const prompt = fixPrompt({ kind: "test", line: "gone" }, "dev server", out);
    assert.match(prompt, /line 99\n```/);
    assert.doesNotMatch(prompt, /line 59\n/);
  });
});
