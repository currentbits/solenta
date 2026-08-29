"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  wikiFromIndex,
  parseDependencies,
  formatWikiNote,
  WIKI_NOTE_MAX,
} = require("../codewiki.js");

function index(files) {
  return {
    version: 1,
    repoRoot: "/repo",
    updatedAt: 1,
    fileCount: files.length,
    symbolCount: files.reduce((n, f) => n + f.symbols.length, 0),
    lineCount: 10,
    files,
  };
}

function file(rel, symbols, rank) {
  return {
    path: rel,
    mtimeMs: 1,
    size: 10,
    lines: 4,
    symbols,
    rank,
  };
}

describe("codewiki", () => {
  it("groups files into top-level modules and packages/*", () => {
    const wiki = wikiFromIndex(
      index([
        file("src/App.tsx", ["App"], 5),
        file("src/useCoder.ts", ["useCoder"], 8),
        file("electron/runner.js", ["createRunner"], 20),
        file("packages/core/src/index.ts", ["boot"], 2),
        file("README.md", [], 0),
      ]),
    );
    const names = wiki.modules.map((m) => m.name);
    assert.equal(names[0], "src");
    assert.deepEqual(new Set(names), new Set(["src", "electron", "packages/core", "(root)"]));
    const src = wiki.modules.find((m) => m.name === "src");
    assert.equal(src.fileCount, 2);
    assert.equal(src.hot[0].path, "src/useCoder.ts");
  });

  it("reads package.json dependencies in declaration order", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codewiki-"));
    try {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          dependencies: { react: "19", electron: "35" },
          devDependencies: { typescript: "5" },
        }),
      );
      assert.deepEqual(parseDependencies(dir), ["react", "electron", "typescript"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formatWikiNote names modules and deps and stays under the cap", () => {
    const wiki = wikiFromIndex(
      index([
        file("electron/runner.js", ["createRunner"], 9),
        file("src/App.tsx", ["App"], 3),
      ]),
      { dependencies: ["react", "electron"], headSha: "abcdef1", defaultBranch: "main" },
    );
    const note = formatWikiNote(wiki);
    assert.match(note, /\[Code wiki\]/);
    assert.match(note, /not agent memory/);
    assert.match(note, /main @ abcdef1/);
    assert.match(note, /electron\/ — 1 file/);
    assert.match(note, /Hottest: runner\.js/);
    assert.match(note, /Dependencies: react, electron/);
    assert.ok(note.length <= WIKI_NOTE_MAX);
    assert.equal(formatWikiNote(wikiFromIndex({ files: [] })), "");
  });
});
