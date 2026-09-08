/**
 * Per-worktree dev-server isolation (#250): data dirs and optional
 * app name/icon. PORT stays on mergeQueue.laneEnv; this module only
 * builds the overlay that start() forwards via opts.env.
 *
 * Run: node --test electron/test/worktree-env.test.js
 */
"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isolationEnv,
  normalizeProjectEnv,
  mergeDevServerEnv,
  ensureIsolationDirs,
  spawnEnvForDevServer,
  laneEnvExtra,
  looksLikeChromiumCommand,
  chromiumUserDataDir,
  chromiumSpawnArgs,
  withChromiumUserDataDir,
  rewriteChromiumScriptBody,
  looksLikeElectronCommand,
  electronIdentityBundleDir,
  materializeElectronIdentity,
  electronIdentityEnv,
} = require("../worktreeEnv.js");

const temps = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-worktree-env-"));
  temps.push(dir);
  return dir;
}

after(() => {
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("isolationEnv", () => {
  it("points XDG and SOLENTA_DATA_DIR under userDataPath/dev-homes/<threadId>", () => {
    const userDataPath = tmpDir();
    const env = isolationEnv({
      threadId: "thr-1",
      worktreePath: "/repo/wt",
      userDataPath,
      platform: "darwin",
    });
    const root = path.join(userDataPath, "dev-homes", "thr-1");
    assert.equal(env.SOLENTA_DATA_DIR, root);
    assert.equal(env.XDG_DATA_HOME, path.join(root, "share"));
    assert.equal(env.XDG_CONFIG_HOME, path.join(root, "config"));
    assert.equal(env.XDG_CACHE_HOME, path.join(root, "cache"));
    assert.equal(env.XDG_STATE_HOME, path.join(root, "state"));
    assert.equal(env.TMPDIR, path.join(root, "tmp"));
  });

  it("sets SOLENTA_WORKTREE and SOLENTA_THREAD_ID, not PORT or HOME", () => {
    const env = isolationEnv({
      threadId: "thr-2",
      worktreePath: "/repo/wt",
      userDataPath: tmpDir(),
      platform: "darwin",
    });
    assert.equal(env.SOLENTA_WORKTREE, "/repo/wt");
    assert.equal(env.SOLENTA_THREAD_ID, "thr-2");
    assert.equal(env.PORT, undefined);
    assert.equal(env.SOLENTA_LANE, undefined);
    assert.equal(env.HOME, undefined);
  });

  it("identity:true sets SOLENTA_APP_NAME from the project name", () => {
    const env = isolationEnv({
      threadId: "abcd1234ffff",
      worktreePath: "/repo/wt",
      userDataPath: tmpDir(),
      project: { name: "Acme" },
      identity: true,
      platform: "darwin",
    });
    assert.equal(env.SOLENTA_APP_NAME, "Acme · abcd1234");
  });

  it("identity:false omits name and icon", () => {
    const env = isolationEnv({
      threadId: "thr-3",
      worktreePath: "/repo/wt",
      userDataPath: tmpDir(),
      project: { name: "Acme", iconPath: "icon.png" },
      identity: false,
      platform: "darwin",
    });
    assert.equal(env.SOLENTA_APP_NAME, undefined);
    assert.equal(env.SOLENTA_APP_ICON, undefined);
  });

  it("sets SOLENTA_APP_ICON when identity.icon exists on disk", () => {
    const dir = tmpDir();
    const icon = path.join(dir, "app.png");
    fs.writeFileSync(icon, "x");
    const env = isolationEnv({
      threadId: "thr-4",
      worktreePath: "/repo/wt",
      userDataPath: dir,
      identity: { icon },
      platform: "darwin",
    });
    assert.equal(env.SOLENTA_APP_ICON, icon);
  });

  it("omits SOLENTA_APP_ICON when the icon file is missing", () => {
    const env = isolationEnv({
      threadId: "thr-5",
      worktreePath: "/repo/wt",
      userDataPath: tmpDir(),
      identity: { icon: "/no/such/icon.png" },
      platform: "darwin",
    });
    assert.equal(env.SOLENTA_APP_ICON, undefined);
  });

  it("win32 sets APPDATA, LOCALAPPDATA, TEMP, and TMP", () => {
    const userDataPath = tmpDir();
    const env = isolationEnv({
      threadId: "thr-win",
      worktreePath: "C:\\repo\\wt",
      userDataPath,
      platform: "win32",
    });
    const root = path.join(userDataPath, "dev-homes", "thr-win");
    assert.equal(env.APPDATA, path.join(root, "AppData", "Roaming"));
    assert.equal(env.LOCALAPPDATA, path.join(root, "AppData", "Local"));
    assert.equal(env.TEMP, path.join(root, "tmp"));
    assert.equal(env.TMP, path.join(root, "tmp"));
  });

  it("darwin does not set APPDATA", () => {
    const env = isolationEnv({
      threadId: "thr-mac",
      worktreePath: "/repo/wt",
      userDataPath: tmpDir(),
      platform: "darwin",
    });
    assert.equal(env.APPDATA, undefined);
    assert.equal(env.LOCALAPPDATA, undefined);
  });

  it("remote/wsl uses posix /tmp/solenta-dev-homes/<id>, not host userDataPath", () => {
    const userDataPath = tmpDir();
    const env = isolationEnv({
      threadId: "thr-r",
      worktreePath: "/home/me/repo",
      userDataPath,
      project: { remoteHost: "me@box", remotePath: "/home/me/repo" },
      platform: "darwin",
    });
    assert.equal(env.SOLENTA_DATA_DIR, "/tmp/solenta-dev-homes/thr-r");
    assert.equal(env.XDG_DATA_HOME, "/tmp/solenta-dev-homes/thr-r/share");
    assert.equal(env.XDG_CONFIG_HOME, "/tmp/solenta-dev-homes/thr-r/config");
    assert.ok(!String(env.SOLENTA_DATA_DIR).startsWith(userDataPath));
  });

  it("sanitizes unsafe thread ids in the data-dir name", () => {
    const userDataPath = tmpDir();
    const env = isolationEnv({
      threadId: "../evil/id",
      worktreePath: "/repo/wt",
      userDataPath,
      platform: "darwin",
    });
    const name = path.basename(env.SOLENTA_DATA_DIR);
    assert.ok(!name.includes(".."));
    assert.ok(!name.includes("/"));
    assert.equal(env.SOLENTA_DATA_DIR, path.join(userDataPath, "dev-homes", name));
  });

  it("gives two threads distinct data dirs so they do not share a profile", () => {
    const userDataPath = tmpDir();
    const first = isolationEnv({
      threadId: "lane-a",
      userDataPath,
      platform: "darwin",
    });
    const second = isolationEnv({
      threadId: "lane-b",
      userDataPath,
      platform: "darwin",
    });
    assert.notEqual(first.SOLENTA_DATA_DIR, second.SOLENTA_DATA_DIR);
    assert.notEqual(first.XDG_CONFIG_HOME, second.XDG_CONFIG_HOME);
    assert.notEqual(first.TMPDIR, second.TMPDIR);
  });
});

describe("normalizeProjectEnv", () => {
  it("keeps string values with valid names", () => {
    assert.deepEqual(
      normalizeProjectEnv({ AWS_PROFILE: "bedrock", API_URL: "https://x" }),
      { AWS_PROFILE: "bedrock", API_URL: "https://x" },
    );
  });

  it("drops invalid keys, non-strings, and PATH", () => {
    assert.deepEqual(
      normalizeProjectEnv({
        PATH: "/evil",
        "BAD-KEY": "x",
        PORT: 3001,
        OK: "yes",
        "": "no",
      }),
      { OK: "yes" },
    );
    assert.deepEqual(normalizeProjectEnv(null), {});
    assert.deepEqual(normalizeProjectEnv(["AWS_PROFILE=x"]), {});
  });
});

describe("mergeDevServerEnv", () => {
  it("applies project env, then isolation, then extra so PORT wins", () => {
    const merged = mergeDevServerEnv({
      projectEnv: { AWS_PROFILE: "a", PORT: "1111", XDG_DATA_HOME: "/from-project" },
      isolation: { XDG_DATA_HOME: "/from-iso", SOLENTA_THREAD_ID: "t" },
      extra: { PORT: "3001", SOLENTA_LANE: "1" },
    });
    assert.equal(merged.AWS_PROFILE, "a");
    assert.equal(merged.XDG_DATA_HOME, "/from-iso");
    assert.equal(merged.PORT, "3001");
    assert.equal(merged.SOLENTA_LANE, "1");
    assert.equal(merged.SOLENTA_THREAD_ID, "t");
  });
});

describe("ensureIsolationDirs", () => {
  it("creates the local data dirs", () => {
    const userDataPath = tmpDir();
    const env = isolationEnv({
      threadId: "thr-dirs",
      worktreePath: "/repo/wt",
      userDataPath,
      platform: "darwin",
    });
    ensureIsolationDirs(env);
    assert.ok(fs.statSync(env.SOLENTA_DATA_DIR).isDirectory());
    assert.ok(fs.statSync(env.XDG_DATA_HOME).isDirectory());
    assert.ok(fs.statSync(env.TMPDIR).isDirectory());
  });

  it("skips remote posix overlay paths", () => {
    const env = isolationEnv({
      threadId: "thr-skip",
      worktreePath: "/home/me/repo",
      userDataPath: tmpDir(),
      project: { remoteHost: "me@box", remotePath: "/home/me/repo" },
      platform: "darwin",
    });
    ensureIsolationDirs(env);
    assert.equal(fs.existsSync(env.SOLENTA_DATA_DIR), false);
  });
});

describe("laneEnvExtra", () => {
  it("delegates PORT and SOLENTA_LANE to mergeQueue.laneEnv", () => {
    const extra = laneEnvExtra({ lane: { n: 3, port: 4003 } });
    assert.equal(extra.PORT, "4003");
    assert.equal(extra.SOLENTA_LANE, "3");
  });

  it("returns {} when the thread has no claimed lane", () => {
    assert.deepEqual(laneEnvExtra({}), {});
    assert.deepEqual(laneEnvExtra({ lane: { n: 0 } }), {});
  });
});

describe("spawnEnvForDevServer", () => {
  it("merges project.env with isolation and extra, identity on by default", () => {
    const userDataPath = tmpDir();
    const env = spawnEnvForDevServer({
      project: { name: "Acme", env: { AWS_PROFILE: "bedrock" } },
      thread: { id: "thr-spawn", worktreePath: "/repo/wt" },
      userDataPath,
      extra: { PORT: "3002" },
      platform: "darwin",
    });
    assert.equal(env.AWS_PROFILE, "bedrock");
    assert.equal(env.PORT, "3002");
    assert.equal(env.SOLENTA_THREAD_ID, "thr-spawn");
    assert.equal(env.SOLENTA_WORKTREE, "/repo/wt");
    assert.equal(env.SOLENTA_APP_NAME, "Acme · thr-spaw");
    assert.ok(env.XDG_DATA_HOME.startsWith(path.join(userDataPath, "dev-homes")));
    assert.ok(fs.statSync(env.SOLENTA_DATA_DIR).isDirectory());
  });

  it("resolves a relative project.iconPath against the project path", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "mark.png"), "x");
    const env = spawnEnvForDevServer({
      project: { name: "Acme", path: dir, iconPath: "mark.png" },
      thread: { id: "thr-icon", worktreePath: dir },
      userDataPath: dir,
      platform: "darwin",
    });
    assert.equal(env.SOLENTA_APP_ICON, path.join(dir, "mark.png"));
  });

  it("identity:false skips app name and icon", () => {
    const env = spawnEnvForDevServer({
      project: { name: "Acme" },
      thread: { id: "thr-off", worktreePath: "/repo/wt" },
      userDataPath: tmpDir(),
      identity: false,
      platform: "darwin",
    });
    assert.equal(env.SOLENTA_APP_NAME, undefined);
    assert.equal(env.SOLENTA_APP_ICON, undefined);
    assert.ok(env.SOLENTA_DATA_DIR);
  });
});

describe("chromium --user-data-dir spawn args", () => {
  it("looksLikeChromiumCommand matches Electron and Chromium binaries, not vite", () => {
    assert.equal(looksLikeChromiumCommand("electron ."), true);
    assert.equal(looksLikeChromiumCommand("npx electron ."), true);
    assert.equal(looksLikeChromiumCommand("electron.exe ."), true);
    assert.equal(looksLikeChromiumCommand("google-chrome --app=http://localhost"), true);
    assert.equal(looksLikeChromiumCommand("chromium --incognito"), true);
    assert.equal(looksLikeChromiumCommand("vite"), false);
    assert.equal(looksLikeChromiumCommand("next dev"), false);
    assert.equal(looksLikeChromiumCommand("chromedriver"), false);
  });

  it("chromiumSpawnArgs points --user-data-dir at isolationEnv chrome-profile", () => {
    const userDataPath = tmpDir();
    const env = isolationEnv({
      threadId: "thr-chrome",
      userDataPath,
      platform: "darwin",
    });
    const profile = path.join(env.SOLENTA_DATA_DIR, "chrome-profile");
    assert.equal(chromiumUserDataDir(env), profile);
    assert.deepEqual(chromiumSpawnArgs(env, "electron ."), [
      `--user-data-dir=${profile}`,
    ]);
    assert.deepEqual(chromiumSpawnArgs(env, "vite"), []);
  });

  it("two isolationEnv lanes get distinct --user-data-dir flags", () => {
    const userDataPath = tmpDir();
    const a = isolationEnv({
      threadId: "lane-a",
      userDataPath,
      platform: "darwin",
    });
    const b = isolationEnv({
      threadId: "lane-b",
      userDataPath,
      platform: "darwin",
    });
    const argsA = chromiumSpawnArgs(a, "electron .");
    const argsB = chromiumSpawnArgs(b, "electron .");
    assert.equal(argsA.length, 1);
    assert.equal(argsB.length, 1);
    assert.notEqual(argsA[0], argsB[0]);
    assert.ok(argsA[0].startsWith("--user-data-dir="));
    assert.ok(String(argsA[0]).includes(a.SOLENTA_DATA_DIR));
    assert.ok(String(argsB[0]).includes(b.SOLENTA_DATA_DIR));
  });

  it("withChromiumUserDataDir appends -- --user-data-dir after npm run", () => {
    const env = isolationEnv({
      threadId: "thr-npm",
      userDataPath: tmpDir(),
      platform: "darwin",
    });
    const profile = chromiumUserDataDir(env);
    assert.deepEqual(
      withChromiumUserDataDir(["run", "electron"], env, "electron ."),
      ["run", "electron", "--", `--user-data-dir=${profile}`],
    );
  });

  it("withChromiumUserDataDir appends after a WSL-wrapped npm run", () => {
    const env = isolationEnv({
      threadId: "thr-wsl",
      userDataPath: tmpDir(),
      platform: "darwin",
    });
    const profile = chromiumUserDataDir(env);
    assert.deepEqual(
      withChromiumUserDataDir(
        ["-d", "Ubuntu", "--cd", "/home/me/repo", "--", "npm", "run", "electron"],
        env,
        "electron .",
      ),
      [
        "-d",
        "Ubuntu",
        "--cd",
        "/home/me/repo",
        "--",
        "npm",
        "run",
        "electron",
        "--",
        `--user-data-dir=${profile}`,
      ],
    );
  });

  it("withChromiumUserDataDir leaves vite argv alone", () => {
    const env = isolationEnv({
      threadId: "thr-vite",
      userDataPath: tmpDir(),
      platform: "darwin",
    });
    assert.deepEqual(
      withChromiumUserDataDir(["run", "dev"], env, "vite"),
      ["run", "dev"],
    );
  });

  it("withChromiumUserDataDir does not add a second --user-data-dir", () => {
    const env = isolationEnv({
      threadId: "thr-dup",
      userDataPath: tmpDir(),
      platform: "darwin",
    });
    const existing = ["electron", ".", "--user-data-dir=/already"];
    assert.deepEqual(
      withChromiumUserDataDir(existing, env, "electron . --user-data-dir=/already"),
      existing,
    );
  });

  it("withChromiumUserDataDir does not append --user-data-dir after npm run when the script is concurrently", () => {
    const env = isolationEnv({
      threadId: "thr-conc",
      userDataPath: tmpDir(),
      platform: "darwin",
    });
    const body = 'concurrently "vite" "electron ."';
    assert.deepEqual(
      withChromiumUserDataDir(["run", "dev"], env, body),
      ["run", "dev"],
    );
  });

  it("rewriteChromiumScriptBody puts isolationEnv chrome-profile on the inner electron, not vite", () => {
    const env = isolationEnv({
      threadId: "thr-body",
      userDataPath: tmpDir(),
      platform: "darwin",
    });
    const profile = chromiumUserDataDir(env);
    const body = 'concurrently "vite" "electron ."';
    const rewritten = rewriteChromiumScriptBody(body, env);
    assert.match(rewritten, /electron(?:\.exe|\.cmd)?(?:\s+\.)?\s+--user-data-dir=/);
    assert.ok(rewritten.includes(`--user-data-dir=${profile}`));
    assert.ok(rewritten.includes("vite"));
    assert.doesNotMatch(rewritten, /vite[^\n"]*--user-data-dir/);
    assert.ok(rewritten.startsWith("concurrently"));
  });

  it("rewriteChromiumScriptBody isolates npm-run-all and run-p quoted electron children", () => {
    const env = isolationEnv({
      threadId: "thr-nra",
      userDataPath: tmpDir(),
      platform: "darwin",
    });
    const profile = chromiumUserDataDir(env);
    const nra = rewriteChromiumScriptBody(
      'npm-run-all --parallel "vite" "electron ."',
      env,
    );
    const runp = rewriteChromiumScriptBody('run-p "vite" "electron ."', env);
    assert.ok(nra.includes(`electron . --user-data-dir=${profile}`));
    assert.ok(runp.includes(`electron . --user-data-dir=${profile}`));
    assert.doesNotMatch(nra, /vite[^\n"]*--user-data-dir/);
    assert.doesNotMatch(runp, /vite[^\n"]*--user-data-dir/);
  });

  it("rewriteChromiumScriptBody quotes --user-data-dir when SOLENTA_DATA_DIR has spaces", () => {
    const userDataPath = path.join(tmpDir(), "Application Support", "Solenta");
    fs.mkdirSync(userDataPath, { recursive: true });
    const env = isolationEnv({
      threadId: "thr-space",
      userDataPath,
      platform: "darwin",
    });
    const profile = chromiumUserDataDir(env);
    assert.ok(profile.includes(" "), "fixture must use a spaced data dir");
    const rewritten = rewriteChromiumScriptBody(
      'concurrently "vite" "electron ."',
      env,
    );
    assert.ok(
      rewritten.includes(`--user-data-dir='${profile}'`),
      "spaces in Application Support would otherwise split the inner electron argv",
    );
    assert.doesNotMatch(rewritten, /vite[^\n"]*--user-data-dir/);
  });

  it("rewriteChromiumScriptBody does not add a second --user-data-dir", () => {
    const env = isolationEnv({
      threadId: "thr-dup-body",
      userDataPath: tmpDir(),
      platform: "darwin",
    });
    const body = 'concurrently "vite" "electron . --user-data-dir=/already"';
    assert.equal(rewriteChromiumScriptBody(body, env), body);
  });

  it("remote isolationEnv uses a posix chrome-profile under SOLENTA_DATA_DIR", () => {
    const env = isolationEnv({
      threadId: "thr-r",
      userDataPath: tmpDir(),
      project: { remoteHost: "me@box", remotePath: "/home/me/repo" },
      platform: "darwin",
    });
    assert.equal(
      chromiumUserDataDir(env),
      "/tmp/solenta-dev-homes/thr-r/chrome-profile",
    );
    assert.deepEqual(chromiumSpawnArgs(env, "electron ."), [
      "--user-data-dir=/tmp/solenta-dev-homes/thr-r/chrome-profile",
    ]);
  });
});

describe("Electron display-name stretch (#250)", () => {
  it("looksLikeElectronCommand matches electron only, not chrome or vite", () => {
    assert.equal(looksLikeElectronCommand("electron ."), true);
    assert.equal(looksLikeElectronCommand("npx electron ."), true);
    assert.equal(looksLikeElectronCommand("electron.exe ."), true);
    assert.equal(looksLikeElectronCommand("vite"), false);
    assert.equal(looksLikeElectronCommand("next dev"), false);
    assert.equal(looksLikeElectronCommand("google-chrome --app=http://localhost"), false);
    assert.equal(looksLikeElectronCommand("chromium --incognito"), false);
  });

  it("materializeElectronIdentity writes a darwin stub .app named from isolationEnv", () => {
    const userDataPath = tmpDir();
    const icon = path.join(userDataPath, "mark.png");
    fs.writeFileSync(icon, "png");
    const env = isolationEnv({
      threadId: "abcd1234ffff",
      userDataPath,
      project: { name: "Acme" },
      identity: { icon },
      platform: "darwin",
    });
    const bundle = materializeElectronIdentity(env, { platform: "darwin" });
    const expected = path.join(env.SOLENTA_DATA_DIR, "Electron.app");
    assert.equal(electronIdentityBundleDir(env), expected);
    assert.equal(bundle, expected);
    const plist = fs.readFileSync(path.join(bundle, "Contents", "Info.plist"), "utf8");
    assert.match(plist, /<key>CFBundleName<\/key>\s*<string>Acme · abcd1234<\/string>/);
    assert.match(plist, /<key>CFBundleDisplayName<\/key>\s*<string>Acme · abcd1234<\/string>/);
    assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>dev\.solenta\.lane\.abcd1234ffff<\/string>/);
    assert.ok(
      fs.existsSync(path.join(bundle, "Contents", "MacOS", "launcher")),
      "stub needs a MacOS executable so Launch Services binds the plist",
    );
    assert.ok(
      fs.existsSync(path.join(bundle, "Contents", "Resources", "app.icns")) ||
        fs.existsSync(path.join(bundle, "Contents", "Resources", "app.png")),
      "optional SOLENTA_APP_ICON should land in Resources",
    );
    assert.match(plist, /<key>CFBundleIconFile<\/key>/);
  });

  it("two isolationEnv lanes get distinct CFBundleName and bundle identifiers", () => {
    const userDataPath = tmpDir();
    const a = isolationEnv({
      threadId: "lane-aaaa",
      userDataPath,
      project: { name: "Acme" },
      identity: true,
      platform: "darwin",
    });
    const b = isolationEnv({
      threadId: "lane-bbbb",
      userDataPath,
      project: { name: "Acme" },
      identity: true,
      platform: "darwin",
    });
    const bundleA = materializeElectronIdentity(a, { platform: "darwin" });
    const bundleB = materializeElectronIdentity(b, { platform: "darwin" });
    assert.notEqual(bundleA, bundleB);
    const plistA = fs.readFileSync(path.join(bundleA, "Contents", "Info.plist"), "utf8");
    const plistB = fs.readFileSync(path.join(bundleB, "Contents", "Info.plist"), "utf8");
    assert.ok(plistA.includes(`<string>${a.SOLENTA_APP_NAME}</string>`));
    assert.ok(plistB.includes(`<string>${b.SOLENTA_APP_NAME}</string>`));
    assert.notEqual(a.SOLENTA_APP_NAME, b.SOLENTA_APP_NAME);
    assert.ok(plistA.includes("dev.solenta.lane.lane-aaaa"));
    assert.ok(plistB.includes("dev.solenta.lane.lane-bbbb"));
  });

  it("electronIdentityEnv prepends a PATH shim so npm run finds the stub", () => {
    const userDataPath = tmpDir();
    const env = isolationEnv({
      threadId: "thr-path",
      userDataPath,
      project: { name: "Acme" },
      identity: true,
      platform: "darwin",
    });
    const extra = electronIdentityEnv(env, "electron .", {
      platform: "darwin",
      path: "/usr/bin:/bin",
    });
    const bundle = electronIdentityBundleDir(env);
    assert.ok(extra.PATH, "PATH must expose the per-lane electron shim");
    const shimDir = extra.PATH.split(path.delimiter)[0];
    assert.ok(fs.existsSync(path.join(shimDir, "electron")));
    assert.ok(extra.PATH.startsWith(`${shimDir}${path.delimiter}`));
    assert.ok(extra.PATH.endsWith("/usr/bin:/bin") || extra.PATH.includes("/usr/bin:/bin"));
    assert.ok(fs.existsSync(path.join(bundle, "Contents", "Info.plist")));
  });

  it("electronIdentityEnv leaves vite, chrome, remote, and non-darwin alone", () => {
    const userDataPath = tmpDir();
    const local = isolationEnv({
      threadId: "thr-skip",
      userDataPath,
      project: { name: "Acme" },
      identity: true,
      platform: "darwin",
    });
    assert.deepEqual(
      electronIdentityEnv(local, "vite", { platform: "darwin", path: "/bin" }),
      {},
    );
    assert.deepEqual(
      electronIdentityEnv(local, "google-chrome", { platform: "darwin", path: "/bin" }),
      {},
    );
    assert.deepEqual(
      electronIdentityEnv(local, "electron .", { platform: "linux", path: "/bin" }),
      {},
    );
    const remote = isolationEnv({
      threadId: "thr-r",
      userDataPath,
      project: { name: "Acme", remoteHost: "me@box", remotePath: "/home/me/repo" },
      identity: true,
      platform: "darwin",
    });
    assert.deepEqual(
      electronIdentityEnv(remote, "electron .", { platform: "darwin", path: "/bin" }),
      {},
    );
    assert.equal(fs.existsSync("/tmp/solenta-dev-homes/thr-r/Electron.app"), false);
  });
});

