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

  it("keeps compiler positions separate from file names", () => {
    for (const path of ["src/foo.ts", "src/routes/(app)/page.tsx", "C:\\repo\\foo.ts"]) {
      for (const suffix of ["(12,3)", "(12, 3)", "(12)"]) {
        const text = `${path}${suffix}: error TS2322`;
        const hits = findPathRefs(text);
        assert.equal(hits.length, 1, text);
        assert.equal(hits[0].path, path);
        assert.equal(hits[0].line, 12);
        assert.equal(hits[0].col, suffix.includes(",") ? 3 : undefined);
        assert.equal(text.slice(hits[0].start, hits[0].end), `${path}${suffix}`);
      }
    }
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

  it("leaves elided paths wholly unlinked", () => {
    for (const path of ["/tmp/.../report.md", "/tmp/claude-1000/...", "src/…/file.ts:12:3", "C:\\repo\\...\\file.ts", "/tmp/……/file.ts", "../.../report.md"]) {
      assert.deepEqual(findPathRefs(path), [], path);
    }
    const hits = findPathRefs("skip /tmp/.../bad.ts then src/good.ts:4");
    assert.deepEqual(hits.map((hit) => hit.raw), ["src/good.ts:4"]);
  });

  it("keeps framework and package-manager segments intact", () => {
    for (const path of ["src/app/[id]/page.tsx", "src/app/[[...slug]]/page.tsx", "src/routes/(app)/+page.svelte", "app/routes/posts.$id.tsx", "node_modules/.pnpm/react@18.3.1/node_modules/react/index.js", "(app)/page.tsx"]) {
      const text = `See ${path}:12:5 for details`;
      const hits = findPathRefs(text);
      assert.equal(hits.length, 1, path);
      assert.equal(hits[0].path, path);
      assert.equal(hits[0].line, 12);
      assert.equal(hits[0].col, 5);
      assert.equal(text.slice(hits[0].start, hits[0].end), `${path}:12:5`);
    }
  });

  it("preserves parent paths and excludes surrounding prose punctuation", () => {
    for (const [text, expected] of [["(src/foo.ts:12).", "src/foo.ts:12"], ["src/foo.ts).", "src/foo.ts"], ["(src/foo.ts:12)", "src/foo.ts:12"], ["[src/foo.ts]", "src/foo.ts"], ["src/routes/(app)/page.tsx.", "src/routes/(app)/page.tsx"], ["../src/foo.ts", "../src/foo.ts"], ["../..", "../.."], ["src/.hidden.ts", "src/.hidden.ts"]]) {
      const hits = findPathRefs(text);
      assert.equal(hits.length, 1, text);
      assert.equal(hits[0].raw, expected);
      assert.equal(text.slice(hits[0].start, hits[0].end), expected);
    }
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
