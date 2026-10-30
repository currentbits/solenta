/**
 * buildFileTree (#1772): compression, dirs-before-files sort, counts.
 * Run: node --experimental-strip-types --test test/fileTree.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allDirPaths, buildFileTree, type FileTreeNode } from "../src/fileTree.ts";

interface F {
  path: string;
  additions: number;
  deletions: number;
}

function file(path: string, additions = 1, deletions = 0): F {
  return { path, additions, deletions };
}

function names(nodes: FileTreeNode<F>[]): string[] {
  return nodes.map((n) => n.name ?? n.path);
}

describe("buildFileTree", () => {
  it("compresses a single-child directory chain into one row", () => {
    const tree = buildFileTree([file("src/components/thread/ChangesPanel.tsx")]);
    assert.equal(tree.length, 1);
    const dir = tree[0]!;
    assert.equal(dir.kind, "dir");
    assert.equal(dir.name, "src/components/thread");
    assert.equal(dir.path, "src/components/thread");
    assert.equal(dir.children.length, 1);
    assert.equal(dir.children[0]!.kind, "file");
    assert.equal(dir.children[0]!.path, "src/components/thread/ChangesPanel.tsx");
  });

  it("stops compressing at a directory with a sibling file", () => {
    const tree = buildFileTree([
      file("src/thread/ChangesPanel.tsx"),
      file("src/thread/PrCodeTab.tsx"),
      file("src/App.tsx"),
    ]);
    // src holds a file (App.tsx) alongside thread/, so it cannot compress away.
    assert.equal(tree.length, 1);
    const src = tree[0]!;
    assert.equal(src.name, "src");
    assert.equal(src.kind, "dir");
    assert.equal(src.fileCount, 3);
    const [threadDir, appFile] = src.children;
    assert.equal(threadDir!.name, "thread");
    assert.equal(appFile!.path, "src/App.tsx");
  });

  it("stops compressing at a directory with two subdirectories", () => {
    const tree = buildFileTree([
      file("src/a/one/x.ts"),
      file("src/a/two/y.ts"),
    ]);
    assert.equal(tree.length, 1);
    const src = tree[0]!;
    assert.equal(src.name, "src/a");
    assert.deepEqual(names(src.children), ["one", "two"]);
  });

  it("sorts directories before files, both alphabetically", () => {
    const tree = buildFileTree([
      file("b.ts"),
      file("a.ts"),
      file("zdir/x.ts"),
      file("adir/x.ts"),
    ]);
    assert.deepEqual(names(tree), ["adir", "zdir", "a.ts", "b.ts"]);
  });

  it("sums file counts and +/- recursively through nested dirs", () => {
    const tree = buildFileTree([
      file("src/a.ts", 3, 1),
      file("src/sub/b.ts", 2, 5),
      file("src/sub/c.ts", 0, 4),
    ]);
    const src = tree[0]!;
    assert.equal(src.kind, "dir");
    if (src.kind !== "dir") throw new Error("expected dir");
    assert.equal(src.fileCount, 3);
    assert.equal(src.additions, 5);
    assert.equal(src.deletions, 10);
    const sub = src.children.find((c) => c.kind === "dir");
    assert.ok(sub && sub.kind === "dir");
    if (sub?.kind === "dir") {
      assert.equal(sub.fileCount, 2);
      assert.equal(sub.additions, 2);
      assert.equal(sub.deletions, 9);
    }
  });

  it("top-level files with no directory stay flat", () => {
    const tree = buildFileTree([file("README.md"), file("package.json")]);
    assert.deepEqual(names(tree), ["package.json", "README.md"]);
    assert.ok(tree.every((n) => n.kind === "file"));
  });

  it("empty input builds an empty tree", () => {
    assert.deepEqual(buildFileTree([]), []);
  });

  it("allDirPaths lists every directory row, compressed chains included", () => {
    const tree = buildFileTree([
      file("src/components/thread/ChangesPanel.tsx"),
      file("src/components/thread/PrCodeTab.tsx"),
      file("src/other/x.ts"),
    ]);
    assert.deepEqual(allDirPaths(tree).sort(), ["src", "src/components/thread", "src/other"].sort());
  });
});
