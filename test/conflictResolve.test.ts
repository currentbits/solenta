/**
 * Prompt template for one-click agent conflict resolution (#163).
 * Run: npm run test:renderer -- test/conflictResolve.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildConflictResolvePrompt,
  parseConflictFiles,
} from "../src/conflictResolve.ts";

const CONFLICT_MESSAGE = `coder/ship-it conflicts with main:
  README.md
  src/foo.ts
main was merged into the worktree. Resolve these files there, then merge again.`;

describe("parseConflictFiles", () => {
  it("extracts indented paths and skips headline and footer", () => {
    assert.deepEqual(parseConflictFiles(CONFLICT_MESSAGE), [
      "README.md",
      "src/foo.ts",
    ]);
  });

  it("returns empty for a message with no file list", () => {
    assert.deepEqual(parseConflictFiles("merge failed"), []);
  });
});

describe("buildConflictResolvePrompt", () => {
  it("lists conflicted files and includes marker snippets", () => {
    const prompt = buildConflictResolvePrompt({
      files: [
        {
          path: "README.md",
          content: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n",
          truncated: false,
          binary: false,
        },
      ],
      branch: "coder/ship-it",
      baseBranch: "main",
    });
    assert.match(prompt, /coder\/ship-it/);
    assert.match(prompt, /main/);
    assert.match(prompt, /README\.md/);
    assert.match(prompt, /<<<<<<< HEAD/);
    assert.match(prompt, /theirs/);
    assert.match(prompt, /git add/);
    assert.match(prompt, /Do not merge into the project checkout/);
  });

  it("notes binary files without dumping contents", () => {
    const prompt = buildConflictResolvePrompt({
      files: [
        {
          path: "icon.png",
          content: "",
          truncated: false,
          binary: true,
        },
      ],
    });
    assert.match(prompt, /icon\.png/);
    assert.match(prompt, /binary/i);
  });

  it("notes truncated snippets", () => {
    const prompt = buildConflictResolvePrompt({
      files: [
        {
          path: "big.ts",
          content: "<<<<<<< HEAD\nkeep\n",
          truncated: true,
          binary: false,
        },
      ],
      omitted: 2,
    });
    assert.match(prompt, /truncated/i);
    assert.match(prompt, /2 more/);
  });

  it("falls back to path-only files when snippets are empty", () => {
    const prompt = buildConflictResolvePrompt({
      files: [
        { path: "a.ts", content: "", truncated: false, binary: false },
      ],
    });
    assert.match(prompt, /a\.ts/);
    assert.match(prompt, /conflict markers/);
  });
});
