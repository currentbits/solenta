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
  captureLoginPath,
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

  it("does not spawn a login shell on win32", () => {
    let called = false;
    const execFn = () => {
      called = true;
      return "should not run";
    };
    assert.equal(
      captureLoginPath({ SHELL: "C:\\Windows\\System32\\cmd.exe" }, execFn, "win32"),
      null,
    );
    assert.equal(called, false);
  });

  it("leaves a Windows PATH untouched (does not split on ':')", () => {
    const env = { PATH: "C:\\Windows\\system32;C:\\Windows" };
    let called = false;
    const info = enrichProcessPath({
      env,
      platform: "win32",
      execFn: () => {
        called = true;
        return "";
      },
      existsFn: () => true,
      home: "C:\\Users\\me",
    });
    assert.equal(info.source, "win32");
    assert.equal(env.PATH, "C:\\Windows\\system32;C:\\Windows");
    assert.equal(called, false);
  });
});

describe("primeProcessPath / refreshLoginPath (#1475)", () => {
  const {
    primeProcessPath,
    refreshLoginPath,
    whenPathReady,
  } = require("../pathEnv.js");
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pathenv-"));
  /** execFile stand-in that answers only when release() is called. */
  function deferredShell(out) {
    const calls = [];
    let release = () => {};
    const execFn = (file, args, opts, cb) => {
      calls.push(file);
      release = () => cb(null, out);
    };
    return { execFn, calls, release: () => release() };
  }

  it("applies the cached PATH synchronously without spawning a shell", () => {
    const dir = tmp();
    const cacheFile = path.join(dir, "login-path.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ path: ["/cached/bin"] }));
    const shell = deferredShell("");
    const env = { PATH: "/usr/bin" };
    const r = primeProcessPath({
      cacheFile, env, execFn: shell.execFn, existsFn: () => false, home: "/h", platform: "darwin",
    });
    assert.equal(r.source, "cache");
    assert.equal(env.PATH, "/cached/bin:/usr/bin");
    assert.equal(shell.calls.length, 0);
    assert.equal(whenPathReady({ ifUncached: true }), null, "cached boot: probes do not wait");
    assert.ok(whenPathReady(), "spawns still wait for the recapture");
  });

  it("first run without a cache: launch PATH now, login PATH after the async capture, then cached", async () => {
    const dir = tmp();
    const cacheFile = path.join(dir, "login-path.json");
    const shell = deferredShell("__CODER_PATH_BEGIN__/login/bin:/usr/bin__CODER_PATH_END__");
    const env = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    const r = primeProcessPath({
      cacheFile, env, execFn: shell.execFn, existsFn: () => false, home: "/h", platform: "darwin",
    });
    assert.equal(r.source, "fallback");
    assert.equal(env.PATH, "/usr/bin");

    // A spawn before the capture finishes gets a pending promise and waits.
    const wait = whenPathReady();
    assert.ok(wait, "spawn must wait while the capture is in flight");
    assert.equal(whenPathReady({ ifUncached: true }), wait, "first run: probes wait too");
    assert.deepEqual(shell.calls, ["/bin/zsh"], "whenPathReady starts the capture");
    let done = false;
    void wait.then(() => { done = true; });
    await new Promise((res) => setImmediate(res));
    assert.equal(done, false);
    assert.equal(env.PATH, "/usr/bin");

    shell.release();
    await wait;
    assert.equal(env.PATH, "/login/bin:/usr/bin");
    assert.equal(whenPathReady(), null, "settled: later spawns skip the await");
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, "utf8")).path, ["/login/bin", "/usr/bin"]);
    assert.equal(refreshLoginPath(), wait, "captures once per launch");
  });

  it("recapture replaces stale cached entries; a failed capture keeps the primed PATH", async () => {
    const dir = tmp();
    const cacheFile = path.join(dir, "login-path.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ path: ["/stale/bin"] }));
    const ok = deferredShell("__CODER_PATH_BEGIN__/fresh/bin__CODER_PATH_END__");
    const env = { PATH: "/usr/bin" };
    primeProcessPath({ cacheFile, env, execFn: ok.execFn, existsFn: () => false, home: "/h", platform: "darwin" });
    assert.equal(env.PATH, "/stale/bin:/usr/bin");
    const p = refreshLoginPath();
    ok.release();
    await p;
    assert.equal(env.PATH, "/fresh/bin:/usr/bin");

    const failing = (file, args, opts, cb) => cb(new Error("timeout"), "");
    const env2 = { PATH: "/usr/bin" };
    primeProcessPath({ cacheFile, env: env2, execFn: failing, existsFn: () => false, home: "/h", platform: "darwin" });
    assert.equal(await refreshLoginPath(), null);
    assert.equal(env2.PATH, "/fresh/bin:/usr/bin");
  });

  it("is a no-op on win32 and never asks spawns to wait", () => {
    const env = { PATH: "C:\\a;C:\\b" };
    primeProcessPath({ cacheFile: "/nonexistent", env, platform: "win32" });
    assert.equal(env.PATH, "C:\\a;C:\\b");
    assert.equal(whenPathReady(), null);
  });
});
