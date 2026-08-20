/**
 * IPC seam: every channel the preload invokes must have a handler registered,
 * and the arguments must survive the crossing.
 *
 * tsc cannot check channel-name strings, so renaming "git:createPr" on one side
 * only ships an app whose button throws "No handler registered". Four such
 * mutations passed the whole suite before this test existed.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const cp = require("node:child_process");

/**
 * Stub the electron module so ipc.js and preload.js can be loaded in plain node.
 * Calls must not overlap: the patch is a single module-level swap, so a second
 * concurrent call would restore the real loader out from under the first.
 */
async function withStubbedElectron(fn) {
  const handlers = new Map();
  const bridge = {};
  const stub = {
    ipcMain: {
      handle(channel, cb) {
        handlers.set(channel, cb);
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        const cb = handlers.get(channel);
        if (!cb) {
          // Exactly what Electron throws in a shipped app.
          return Promise.reject(
            new Error(`No handler registered for '${channel}'`),
          );
        }
        return Promise.resolve(cb({}, ...args));
      },
      on() {},
      removeListener() {},
    },
    contextBridge: {
      exposeInMainWorld(name, api) {
        bridge[name] = api;
      },
    },
    dialog: {},
    shell: {},
    app: { getPath: () => os.tmpdir() },
  };

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return stub;
    return origLoad.apply(this, arguments);
  };
  // The patch must outlive an async callback: restoring in a synchronous
  // `finally` would unhook before any `await` in fn() resumes, so a require
  // after the first await would get the real electron module.
  const restore = () => {
    Module._load = origLoad;
  };
  let result;
  try {
    result = fn({ handlers, bridge });
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === "function") {
    return result.then(
      (value) => {
        restore();
        return value;
      },
      (err) => {
        restore();
        throw err;
      },
    );
  }
  restore();
  return result;
}

const git = (args, cwd) => cp.execFileSync("git", args, { cwd, stdio: "pipe" });

describe("IPC seam: preload channels resolve to handlers", () => {
  let tmp;
  let repo;
  let ghBin;
  let ctx;
  let store;
  let thread;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-seam-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "t@example.com"], repo);
    git(["config", "user.name", "t"], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "1");
    git(["add", "."], repo);
    git(["commit", "-qm", "init"], repo);

    const bare = path.join(tmp, "origin.git");
    cp.execFileSync("git", ["init", "-q", "--bare", bare]);
    git(["remote", "add", "origin", "https://github.com/owner/repo.git"], repo);
    // pushInsteadOf keeps `remote get-url` reading as GitHub (so the guard
    // passes) while the transport stays local. Nothing touches the network.
    git(
      ["config", `url.${bare}.pushInsteadOf`, "https://github.com/owner/repo.git"],
      repo,
    );

    ghBin = path.join(tmp, "gh");
    fs.writeFileSync(
      ghBin,
      `#!/bin/sh
printf '%s\\n' "$@" >> "${tmp}/gh-argv.txt"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ -f "${tmp}/created" ]; then
    echo '{"number":42,"url":"https://github.com/owner/repo/pull/42","state":"OPEN"}'
    exit 0
  fi
  echo "no pull requests found for branch" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  touch "${tmp}/created"
  echo "https://github.com/owner/repo/pull/42"
  exit 0
fi
exit 1`,
    );
    fs.chmodSync(ghBin, 0o755);
    process.env.CODER_GH_BIN = ghBin;
  });

  after(() => {
    delete process.env.CODER_GH_BIN;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("registers a handler for every channel preload exposes", async () => {
    await withStubbedElectron(({ handlers, bridge }) => {
      delete require.cache[require.resolve("../ipc.js")];
      delete require.cache[require.resolve("../preload.js")];
      const { registerIpc } = require("../ipc.js");
      const { Store } = require("../store.js");
      const s = new Store(path.join(tmp, "chan-store.json"));
      registerIpc({
        ipcMain: require("electron").ipcMain,
        dialog: {},
        store: s,
        runner: { start() {}, stop() {}, stopAll() {} },
        broadcast() {},
        worktreeBase: path.join(tmp, "wt"),
        userDataPath: tmp,
      });
      require("../preload.js");

      const api = bridge.coder;
      assert.ok(api, "preload must expose window.coder");
      assert.ok(api.git, "preload must expose coder.git");

      // The two this round adds, named explicitly so a rename cannot slip by.
      for (const name of [
        "createPr",
        "prStatus",
        "prChecks",
        "prMerge",
        "listPrs",
      ]) {
        assert.equal(
          typeof api.git[name],
          "function",
          `preload must expose git.${name}`,
        );
      }
      assert.ok(
        handlers.has("git:createPr"),
        "main must handle git:createPr",
      );
      assert.ok(
        handlers.has("git:prStatus"),
        "main must handle git:prStatus",
      );
      assert.ok(
        handlers.has("git:prChecks"),
        "main must handle git:prChecks",
      );
      assert.ok(
        handlers.has("git:prMerge"),
        "main must handle git:prMerge",
      );
      assert.ok(
        handlers.has("git:listPrs"),
        "main must handle git:listPrs",
      );

      assert.equal(
        typeof api.servers.list,
        "function",
        "preload must expose servers.list",
      );
      assert.ok(
        handlers.has("servers:list"),
        "main must handle servers:list",
      );

      assert.equal(
        typeof api.files.resolve,
        "function",
        "preload must expose files.resolve",
      );
      assert.ok(
        handlers.has("files:resolve"),
        "main must handle files:resolve",
      );
      assert.equal(
        typeof api.fs.browse,
        "function",
        "preload must expose fs.browse",
      );
      assert.ok(
        handlers.has("fs:browse"),
        "main must handle fs:browse",
      );

      for (const name of ["scripts", "start", "stop", "status"]) {
        assert.equal(
          typeof api.devserver[name],
          "function",
          `preload must expose devserver.${name}`,
        );
      }
      for (const ch of [
        "devserver:scripts",
        "devserver:start",
        "devserver:stop",
        "devserver:status",
      ]) {
        assert.ok(handlers.has(ch), `main must handle ${ch}`);
      }

      // Round 44 pin + snooze (mirror setSettled seam).
      for (const name of ["setPinned", "setSnoozed", "setQueued", "setNotes", "setFeltEstimate", "setQuotaWaitAutoResume", "peek"]) {
        assert.equal(
          typeof api.threads[name],
          "function",
          `preload must expose threads.${name}`,
        );
      }
      assert.ok(
        handlers.has("threads:peek"),
        "main must handle threads:peek",
      );
      assert.ok(
        handlers.has("threads:setPinned"),
        "main must handle threads:setPinned",
      );
      assert.ok(
        handlers.has("threads:setSnoozed"),
        "main must handle threads:setSnoozed",
      );
      assert.ok(
        handlers.has("threads:setQueued"),
        "main must handle threads:setQueued",
      );
      assert.ok(
        handlers.has("threads:setNotes"),
        "main must handle threads:setNotes",
      );
      assert.equal(
        typeof api.threads.resolveSuggestion,
        "function",
        "preload must expose threads.resolveSuggestion",
      );
      assert.ok(
        handlers.has("threads:resolveSuggestion"),
        "main must handle threads:resolveSuggestion",
      );
      assert.equal(
        typeof api.issues.create,
        "function",
        "preload must expose issues.create",
      );
      assert.ok(
        handlers.has("issues:create"),
        "main must handle issues:create",
      );
      assert.ok(
        handlers.has("threads:setFeltEstimate"),
        "main must handle threads:setFeltEstimate",
      );
      assert.ok(
        handlers.has("threads:setQuotaWaitAutoResume"),
        "main must handle threads:setQuotaWaitAutoResume",
      );
      for (const name of ["btw", "dismissBtw", "promoteBtw"]) {
        assert.equal(
          typeof api.threads[name],
          "function",
          `preload must expose threads.${name}`,
        );
      }
      assert.ok(handlers.has("threads:btw"), "main must handle threads:btw");
      assert.ok(
        handlers.has("threads:dismissBtw"),
        "main must handle threads:dismissBtw",
      );
      assert.ok(
        handlers.has("threads:promoteBtw"),
        "main must handle threads:promoteBtw",
      );
      assert.equal(
        typeof api.runs.resumeQuotaWait,
        "function",
        "preload must expose runs.resumeQuotaWait",
      );
      assert.ok(
        handlers.has("runs:resumeQuotaWait"),
        "main must handle runs:resumeQuotaWait",
      );
    });
  });

  it("carries createPr arguments across the bridge and back", async () => {
    await withStubbedElectron(async ({ bridge }) => {
      delete require.cache[require.resolve("../ipc.js")];
      delete require.cache[require.resolve("../preload.js")];
      const { registerIpc } = require("../ipc.js");
      const { Store } = require("../store.js");
      const services = require("../services.js");
      const worktrees = require("../worktrees.js");

      store = new Store(path.join(tmp, "store.json"));
      const project = await services.addProject(store, repo);
      thread = services.createThread(store, {
        projectId: project.id,
        title: "seam thread",
      });
      worktrees.setupWorktree({
        store,
        threadId: thread.id,
        worktreeBase: path.join(tmp, "wt"),
      });
      const wtPath = store.getThread(thread.id).worktreePath;
      fs.writeFileSync(path.join(wtPath, "b.txt"), "2");
      git(["add", "."], wtPath);
      git(["commit", "-qm", "work"], wtPath);

      registerIpc({
        ipcMain: require("electron").ipcMain,
        dialog: {},
        store,
        runner: { start() {}, stop() {}, stopAll() {} },
        broadcast() {},
        worktreeBase: path.join(tmp, "wt"),
        userDataPath: tmp,
      });
      require("../preload.js");
      ctx = bridge.coder;

      const info = await ctx.git.createPr({
        threadId: thread.id,
        title: "Seam title",
        body: "Seam body",
      });

      assert.equal(info.number, 42);
      assert.equal(info.url, "https://github.com/owner/repo/pull/42");
      assert.equal(info.state, "OPEN");
      assert.equal(info.created, true);

      // The title must actually reach gh: a handler that drops it would still
      // return a valid-looking PrInfo.
      const argv = fs.readFileSync(path.join(tmp, "gh-argv.txt"), "utf8");
      assert.ok(
        argv.includes("Seam title"),
        "title must survive the IPC crossing into gh argv",
      );
      assert.ok(argv.includes("Seam body"), "body must survive too");

      // And it must be recorded on the thread the renderer reads back.
      const row = store.getThread(thread.id);
      assert.equal(row.prNumber, 42);
      assert.equal(row.prUrl, "https://github.com/owner/repo/pull/42");

      const live = await ctx.git.prStatus({ threadId: thread.id });
      assert.equal(live.number, 42);
      assert.equal(live.created, false);
    });
  });
});
