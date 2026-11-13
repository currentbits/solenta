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

describe("login env (#320)", () => {
  const { parseLoginEnv, applyLoginEnv, primeProcessPath, refreshLoginPath } = require("../pathEnv.js");
  const block = (vars) =>
    `rc noise__CODER_ENV_BEGIN__${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\0")}\0__CODER_ENV_END__`;

  it("parses env -0 output between the markers; values may hold = and newlines", () => {
    assert.deepEqual(parseLoginEnv(block({ A: "1", B: "x=y\nz" })), { A: "1", B: "x=y\nz" });
    assert.equal(parseLoginEnv("no markers"), null);
    assert.equal(parseLoginEnv("__CODER_ENV_BEGIN____CODER_ENV_END__"), null);
  });

  it("applies only what the rc files changed, minus shell bookkeeping and a tty-less GPG_TTY", () => {
    const sent = { HOME: "/h", KEEP: "app", SSH_AUTH_SOCK: "/launchd" };
    const env = { ...sent, KEEP: "set-by-app-meanwhile" };
    const login = {
      HOME: "/h", KEEP: "app", SSH_AUTH_SOCK: "/1password.sock", ZSHRC_VAR: "v",
      PATH: "/x", PWD: "/h", SHLVL: "1", _: "/usr/bin/env", GPG_TTY: "not a tty",
    };
    assert.equal(applyLoginEnv(env, sent, login), 2);
    assert.deepEqual(env, {
      HOME: "/h", KEEP: "set-by-app-meanwhile", SSH_AUTH_SOCK: "/1password.sock", ZSHRC_VAR: "v",
    });
    const tty = {};
    applyLoginEnv(tty, {}, { GPG_TTY: "/dev/ttys003" });
    assert.equal(tty.GPG_TTY, "/dev/ttys003");
  });

  it("refreshLoginPath applies the login env alongside PATH and does not cache it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pathenv-"));
    const cacheFile = path.join(dir, "login-path.json");
    const out = `__CODER_PATH_BEGIN__/login/bin__CODER_PATH_END__${block({ TOKEN: "s3cret", PATH: "/login/bin" })}`;
    const env = { PATH: "/usr/bin" };
    primeProcessPath({
      cacheFile, env, execFn: (f, a, o, cb) => cb(null, out), existsFn: () => false, home: "/h", platform: "darwin",
    });
    await refreshLoginPath();
    assert.equal(env.PATH, "/login/bin:/usr/bin");
    assert.equal(env.TOKEN, "s3cret");
    assert.ok(!fs.readFileSync(cacheFile, "utf8").includes("s3cret"));
  });
});

describe("login shell with a DEBUG trap that echoes each command", () => {
  it("captures the real PATH and env, not the echoed command text", { skip: process.platform === "win32" || !fs.existsSync("/bin/bash") }, async () => {
    const { captureLoginPathAsync, primeProcessPath, refreshLoginPath } = require("../pathEnv.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pathenv-trap-"));
    fs.writeFileSync(
      path.join(home, ".bash_profile"),
      "export PATH=/trap/bin:$PATH\nexport CODER_TRAP_LAST=tail\ntrap 'echo \"$BASH_COMMAND\"' DEBUG\n",
    );
    const env = { HOME: home, SHELL: "/bin/bash", PATH: "/usr/bin:/bin" };
    // /etc/profile may add system dirs (macOS path_helper); the rc's entry
    // must lead and no echoed command text may leak in.
    for (const login of [await captureLoginPathAsync(env), captureLoginPath(env)]) {
      assert.equal(login?.[0], "/trap/bin", JSON.stringify(login));
      assert.ok(login.includes("/usr/bin") && login.every((e) => e.startsWith("/")), JSON.stringify(login));
    }

    primeProcessPath({ cacheFile: path.join(home, "cache.json"), env, existsFn: () => false, home, platform: process.platform });
    await refreshLoginPath();
    assert.equal(env.CODER_TRAP_LAST, "tail");
    assert.ok(Object.keys(env).every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)), Object.keys(env).join(","));
  });
});
