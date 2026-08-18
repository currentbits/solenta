/**
 * Path-in-transcript detection: which tokens become openable file refs.
 *
 * Run: node --experimental-strip-types --test test/pathLinks.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findPathRefs,
  resolveWorkspacePath,
} from "../src/pathLinks.ts";

describe("findPathRefs", () => {
  it("finds a relative file", () => {
    const hits = findPathRefs("see src/foo.ts for the handler");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, "src/foo.ts");
    assert.equal(hits[0].raw, "src/foo.ts");
    assert.equal(hits[0].line, undefined);
  });

  it("parses file:12 and file:12:4", () => {
    const line = findPathRefs("see src/foo.ts:12");
    assert.equal(line.length, 1);
    assert.equal(line[0].path, "src/foo.ts");
    assert.equal(line[0].line, 12);
    assert.equal(line[0].col, undefined);
    assert.equal(line[0].raw, "src/foo.ts:12");

    const col = findPathRefs("src/foo.ts:12:4");
    assert.equal(col.length, 1);
    assert.equal(col[0].path, "src/foo.ts");
    assert.equal(col[0].line, 12);
    assert.equal(col[0].col, 4);
  });

  it("leaves http links alone", () => {
    assert.deepEqual(findPathRefs("see https://example.com/src/foo.ts"), []);
    assert.deepEqual(findPathRefs("docs at http://localhost:5173/src/foo.ts"), []);
  });

  it("ignores npm package names", () => {
    assert.deepEqual(findPathRefs("install @types/node and react-markdown"), []);
  });

  it("picks a quoted path out of tool args", () => {
    const hits = findPathRefs('{"file_path":"src/components/Markdown.tsx"}');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, "src/components/Markdown.tsx");
  });
});

describe("resolveWorkspacePath", () => {
  const root = "/tmp/wt";
  const existing = new Set([
    "/tmp/wt/src/foo.ts",
    "/tmp/wt/images/1.jpg",
    "/tmp/wt",
  ]);
  const exists = (abs: string) => existing.has(abs);

  it("resolves a relative file against the worktree", () => {
    assert.equal(
      resolveWorkspacePath(root, "src/foo.ts", exists),
      "/tmp/wt/src/foo.ts",
    );
  });

  it("returns null for a missing file", () => {
    assert.equal(resolveWorkspacePath(root, "src/missing.ts", exists), null);
  });

  it("rejects a path that escapes the worktree", () => {
    const absExists = (p: string) => p === "/etc/passwd";
    assert.equal(resolveWorkspacePath(root, "/etc/passwd", absExists), null);
  });
});
