"use strict";

/**
 * Shared per-repo code index (issue #377): extract, incremental refresh,
 * readIndex failure modes, maybeRefreshIndex disable switch.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  INDEX_VERSION,
  indexPathFor,
  readIndex,
  refreshIndex,
  maybeRefreshIndex,
} = require("../codeindex.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeindex-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
}

function write(repo, rel, body) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function row(index, rel) {
  return index.files.find((f) => f.path === rel);
}

describe("codeindex", () => {
  it("indexPathFor is userData/codeindex/<first 16 of sha1(repoRoot)>.json", () => {
    const repoRoot = "/tmp/some-repo";
    const id = crypto.createHash("sha1").update(repoRoot).digest("hex").slice(0, 16);
    assert.equal(
      indexPathFor("/tmp/ud", repoRoot),
      path.join("/tmp/ud", "codeindex", `${id}.json`),
    );
  });

  it("extracts top-level symbols and skips indented ones", async () => {
    const repo = path.join(tmp, "extract");
    const userDataPath = path.join(tmp, "ud-extract");
    initRepo(repo);
    write(
      repo,
      "src/app.js",
      [
        "export function alpha() {}",
        "export default function beta() {}",
        "export class Gamma {}",
        "const delta = () => {};",
        "export const epsilon = function () {};",
        "const skip = 1;",
        "  function hidden() {}",
        "export type Zeta = string;",
        "export interface Eta { x: number }",
        "export enum Theta { A }",
        "",
      ].join("\n"),
    );
    write(
      repo,
      "src/mod.py",
      ["def iota():", "    pass", "class Kappa:", "    def method(self):", "        pass", ""].join(
        "\n",
      ),
    );
    write(repo, "src/lib.go", ["func Lambda() {}", "func (s *S) Mu() {}", "type Nu struct {}", ""].join("\n"));
    write(
      repo,
      "src/lib.rs",
      ["pub fn xi() {}", "fn omicron() {}", "pub struct Pi {}", "enum Rho {}", "trait Sigma {}", ""].join(
        "\n",
      ),
    );
    write(repo, "README.md", "not source\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);

    const index = await refreshIndex({ userDataPath, repoRoot: repo });
    assert.ok(index);
    assert.equal(index.version, INDEX_VERSION);
    assert.equal(index.fileCount, 4);
    assert.deepEqual(row(index, "src/app.js").symbols, [
      "alpha",
      "beta",
      "Gamma",
      "delta",
      "epsilon",
      "Zeta",
      "Eta",
      "Theta",
    ]);
    assert.deepEqual(row(index, "src/mod.py").symbols, ["iota", "Kappa"]);
    assert.deepEqual(row(index, "src/lib.go").symbols, ["Lambda", "Mu", "Nu"]);
    assert.deepEqual(row(index, "src/lib.rs").symbols, [
      "xi",
      "omicron",
      "Pi",
      "Rho",
      "Sigma",
    ]);
    assert.equal(row(index, "README.md"), undefined);

    const onDisk = readIndex(userDataPath, repo);
    assert.ok(onDisk);
    assert.equal(onDisk.symbolCount, index.symbolCount);
  });

  it("reuses an unchanged row and re-reads an edited file", async () => {
    const repo = path.join(tmp, "incr");
    const userDataPath = path.join(tmp, "ud-incr");
    initRepo(repo);
    write(repo, "keep.js", "function keep() {}\n");
    write(repo, "edit.js", "function before() {}\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);

    const first = await refreshIndex({ userDataPath, repoRoot: repo });
    assert.ok(first);
    assert.deepEqual(row(first, "keep.js").symbols, ["keep"]);
    assert.deepEqual(row(first, "edit.js").symbols, ["before"]);

    const dest = indexPathFor(userDataPath, repo);
    const tampered = JSON.parse(fs.readFileSync(dest, "utf8"));
    row(tampered, "keep.js").symbols = ["SENTINEL"];
    fs.writeFileSync(dest, JSON.stringify(tampered));

    write(repo, "edit.js", "function after() {}\nfunction extra() {}\n");
    const second = await refreshIndex({ userDataPath, repoRoot: repo });
    assert.ok(second);
    assert.deepEqual(row(second, "keep.js").symbols, ["SENTINEL"]);
    assert.deepEqual(row(second, "edit.js").symbols, ["after", "extra"]);
  });

  it("drops a deleted file", async () => {
    const repo = path.join(tmp, "gone");
    const userDataPath = path.join(tmp, "ud-gone");
    initRepo(repo);
    write(repo, "stay.js", "function stay() {}\n");
    write(repo, "drop.js", "function drop() {}\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    const first = await refreshIndex({ userDataPath, repoRoot: repo });
    assert.ok(row(first, "drop.js"));

    fs.unlinkSync(path.join(repo, "drop.js"));
    const second = await refreshIndex({ userDataPath, repoRoot: repo });
    assert.ok(second);
    assert.ok(row(second, "stay.js"));
    assert.equal(row(second, "drop.js"), undefined);
    assert.equal(second.fileCount, 1);
  });

  it("readIndex returns null on missing, garbage, and version mismatch", () => {
    const userDataPath = path.join(tmp, "ud-read");
    const repoRoot = "/tmp/codeindex-missing-repo";
    assert.equal(readIndex(userDataPath, repoRoot), null);

    const dest = indexPathFor(userDataPath, repoRoot);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "not-json{{{");
    assert.equal(readIndex(userDataPath, repoRoot), null);

    fs.writeFileSync(
      dest,
      JSON.stringify({ version: INDEX_VERSION + 1, files: [] }),
    );
    assert.equal(readIndex(userDataPath, repoRoot), null);
  });

  it("maybeRefreshIndex is a no-op when CODER_CODEINDEX_DISABLE=1", async () => {
    const repo = path.join(tmp, "disable");
    const userDataPath = path.join(tmp, "ud-disable");
    initRepo(repo);
    write(repo, "a.js", "function a() {}\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);

    const prev = process.env.CODER_CODEINDEX_DISABLE;
    process.env.CODER_CODEINDEX_DISABLE = "1";
    try {
      assert.doesNotThrow(() => maybeRefreshIndex({ userDataPath, repoRoot: repo }));
      assert.equal(readIndex(userDataPath, repo), null);
      assert.equal(fs.existsSync(indexPathFor(userDataPath, repo)), false);
    } finally {
      if (prev === undefined) delete process.env.CODER_CODEINDEX_DISABLE;
      else process.env.CODER_CODEINDEX_DISABLE = prev;
    }
  });

  it("refreshIndex returns null for a non-git directory and does not throw", async () => {
    const dir = path.join(tmp, "not-git");
    fs.mkdirSync(dir);
    const userDataPath = path.join(tmp, "ud-not-git");
    assert.equal(await refreshIndex({ userDataPath, repoRoot: dir }), null);
    assert.equal(await refreshIndex({}), null);
  });
});
