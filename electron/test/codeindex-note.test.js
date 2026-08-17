"use strict";

/**
 * codeIndexNoteFor is pure: tests build CodeIndex object literals and
 * never call into codeindex.js (worker A owns those bodies).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { MIN_FILES_FOR_NOTE } = require("../codeindex.js");
const { codeIndexNoteFor } = require("../services.js");

/**
 * @param {Partial<import('../codeindex.js').CodeIndex> & { files?: object[] }} [overrides]
 * @returns {import('../codeindex.js').CodeIndex}
 */
function makeIndex(overrides = {}) {
  const files = overrides.files || [];
  return {
    version: 1,
    repoRoot: "/repo",
    updatedAt: Date.now() - 5 * 60_000,
    fileCount: files.length,
    symbolCount: files.reduce((n, f) => n + ((f && f.symbols) || []).length, 0),
    lineCount: 1000,
    files,
    ...overrides,
  };
}

/**
 * @param {number} n
 * @param {{ first?: object }} [opts]
 */
function rankedFiles(n, opts = {}) {
  const files = [];
  for (let i = 0; i < n; i++) {
    files.push({
      path: `src/mod${i}.js`,
      mtimeMs: 1,
      size: 100,
      lines: 10,
      symbols: [`sym${i}A`, `sym${i}B`],
      rank: n - i,
    });
  }
  if (opts.first) Object.assign(files[0], opts.first);
  return files;
}

describe("codeIndexNoteFor", () => {
  it("returns empty when the index is null", () => {
    assert.equal(codeIndexNoteFor(null), "");
    assert.equal(codeIndexNoteFor(undefined), "");
  });

  it("returns empty when the repo is below MIN_FILES_FOR_NOTE", () => {
    const files = rankedFiles(MIN_FILES_FOR_NOTE - 1);
    assert.equal(
      codeIndexNoteFor(makeIndex({ files, fileCount: files.length })),
      "",
    );
  });

  it("returns empty when CODER_CODEINDEX_DISABLE=1", () => {
    const prev = process.env.CODER_CODEINDEX_DISABLE;
    process.env.CODER_CODEINDEX_DISABLE = "1";
    try {
      const files = rankedFiles(MIN_FILES_FOR_NOTE, {
        first: { path: "electron/runner.js", symbols: ["createRunner"] },
      });
      assert.equal(codeIndexNoteFor(makeIndex({ files })), "");
    } finally {
      if (prev == null) delete process.env.CODER_CODEINDEX_DISABLE;
      else process.env.CODER_CODEINDEX_DISABLE = prev;
    }
  });

  it("includes the top-ranked file path and its symbols", () => {
    const files = rankedFiles(MIN_FILES_FOR_NOTE, {
      first: {
        path: "electron/runner.js",
        symbols: ["createRunner", "startRun", "tryReadCodeIndex"],
        rank: 999,
      },
    });
    const note = codeIndexNoteFor(makeIndex({ files, fileCount: files.length }));
    assert.match(note, /^(\n\n)?\[Code map\]/);
    assert.match(note, /electron\/runner\.js/);
    assert.match(note, /createRunner/);
    assert.match(note, /startRun/);
    assert.match(note, /tryReadCodeIndex/);
    assert.match(note, /MAIN checkout/);
    assert.match(note, /grepping to orient/);
    assert.match(note, /Read the file before editing/);
  });

  it("never exceeds the char cap given a huge index", () => {
    const files = [];
    for (let i = 0; i < 400; i++) {
      files.push({
        path: `packages/very/long/path/to/module-${i}/src/index.ts`,
        mtimeMs: 1,
        size: 4000,
        lines: 200,
        symbols: [
          `ExportedName${i}Alpha`,
          `ExportedName${i}Beta`,
          `ExportedName${i}Gamma`,
          `ExportedName${i}Delta`,
          `ExportedName${i}Epsilon`,
          `ExportedName${i}Zeta`,
          `ExportedName${i}Eta`,
          `ExportedName${i}Theta`,
        ],
        rank: 400 - i,
      });
    }
    const note = codeIndexNoteFor(
      makeIndex({ files, fileCount: files.length, symbolCount: files.length * 8 }),
    );
    assert.ok(note.length > 0);
    assert.ok(note.length <= 3500, `note length ${note.length} exceeds 3500`);
    assert.match(note, /packages\/very\/long\/path\/to\/module-0\/src\/index\.ts/);
    assert.doesNotMatch(note, /module-399/);
  });

  it("caps symbols per file and shows +N more", () => {
    const extras = [
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "NINTH_SHOULD_NOT_APPEAR",
      "TENTH_SHOULD_NOT_APPEAR",
      "ELEVENTH_SHOULD_NOT_APPEAR",
      "TWELFTH_SHOULD_NOT_APPEAR",
    ];
    const files = rankedFiles(MIN_FILES_FOR_NOTE, {
      first: { path: "core/big.js", symbols: extras },
    });
    const note = codeIndexNoteFor(makeIndex({ files }));
    assert.match(note, /core\/big\.js/);
    assert.match(note, /one, two, three, four, five, six, seven, eight, \+4 more/);
    assert.doesNotMatch(note, /NINTH_SHOULD_NOT_APPEAR/);
    assert.doesNotMatch(note, /TWELFTH_SHOULD_NOT_APPEAR/);
  });

  it("skips files with no extracted symbols", () => {
    const files = rankedFiles(MIN_FILES_FOR_NOTE, {
      first: { path: "electron/test/store.test.js", symbols: [], rank: 999 },
    });
    const note = codeIndexNoteFor(makeIndex({ files }));
    assert.doesNotMatch(note, /store\.test\.js/);
    assert.match(note, /src\/mod1\.js/);
  });
});
