const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseLoginPath,
  mergePathEntries,
  fallbackBinDirs,
  newestNvmBin,
  enrichProcessPath,
} = require("../pathEnv.js");

describe("parseLoginPath", () => {
  it("extracts entries between the markers", () => {
    const out = "__CODER_PATH_BEGIN__/a:/b:/c__CODER_PATH_END__";
    assert.deepEqual(parseLoginPath(out), ["/a", "/b", "/c"]);
  });

  it("tolerates rc-file noise around the markers", () => {
    const out =
      "bash: cannot set terminal process group\n" +
      "__CODER_PATH_BEGIN__/x:/y__CODER_PATH_END__\nprompt junk";
    assert.deepEqual(parseLoginPath(out), ["/x", "/y"]);
  });

  it("returns null when markers are missing or the path is empty", () => {
    assert.equal(parseLoginPath("no markers at all"), null);
    assert.equal(parseLoginPath("__CODER_PATH_BEGIN__only begin"), null);
    assert.equal(
      parseLoginPath("__CODER_PATH_BEGIN____CODER_PATH_END__"),
      null,
    );
    assert.equal(parseLoginPath(""), null);
  });
});

describe("mergePathEntries", () => {
  it("dedupes preserving order, earlier lists win", () => {
    assert.deepEqual(mergePathEntries(["/a", "/b"], ["/b", "/c"], ["/a", "/d"]), [
      "/a",
      "/b",
      "/c",
      "/d",
    ]);
  });

  it("skips empty entries", () => {
    assert.deepEqual(mergePathEntries(["", "/a"], []), ["/a"]);
  });
});

describe("fallbackBinDirs", () => {
  it("keeps only dirs that exist", () => {
    const dirs = fallbackBinDirs("/home/u", (p) => p === "/opt/homebrew/bin");
    assert.deepEqual(dirs, ["/opt/homebrew/bin"]);
  });
});

describe("newestNvmBin", () => {
  it("picks the numerically newest version (v26 beats v9, not lexicographic)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-nvm-"));
    try {
      for (const v of ["v9.11.2", "v26.4.0", "v10.0.0"]) {
        fs.mkdirSync(path.join(home, ".nvm/versions/node", v, "bin"), {
          recursive: true,
        });
      }
      assert.equal(
        newestNvmBin(home),
        path.join(home, ".nvm/versions/node/v26.4.0/bin"),
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("is null when no nvm versions exist", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-nvm-"));
    try {
      assert.equal(newestNvmBin(home), null);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("enrichProcessPath", () => {
  it("prefers login-shell PATH, then current, then fallback dirs", () => {
    const env = { PATH: "/usr/bin:/bin", SHELL: "/bin/bash" };
    const execFn = () => "__CODER_PATH_BEGIN__/nvm/bin:/opt/homebrew/bin__CODER_PATH_END__";
    const existsFn = (p) => p === "/custom/bin";
    const info = enrichProcessPath({
      env,
      execFn,
      existsFn,
      home: "/custom",
    });
    assert.equal(info.source, "login-shell");
    assert.equal(
      env.PATH,
      "/nvm/bin:/opt/homebrew/bin:/usr/bin:/bin:/custom/bin",
    );
  });

  it("falls back to current PATH + known dirs when the shell fails", () => {
    const env = { PATH: "/usr/bin:/bin", SHELL: "/bin/bash" };
    const execFn = () => {
      throw new Error("timed out");
    };
    const existsFn = (p) => p === "/opt/homebrew/bin";
    const info = enrichProcessPath({ env, execFn, existsFn, home: "/nope" });
    assert.equal(info.source, "fallback");
    assert.equal(env.PATH, "/usr/bin:/bin:/opt/homebrew/bin");
  });

  it("ignores marker-less shell output", () => {
    const env = { PATH: "/usr/bin", SHELL: "/bin/bash" };
    const execFn = () => "bashrc prints stuff but no markers";
    const info = enrichProcessPath({
      env,
      execFn,
      existsFn: () => false,
      home: "/nope",
    });
    assert.equal(info.source, "fallback");
    assert.equal(env.PATH, "/usr/bin");
  });
});
