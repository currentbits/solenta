/**
 * IPC seam: the channel table, preload, and IPC_HANDLERS stay in lockstep,
 * and arguments survive the crossing.
 *
 * tsc cannot check channel-name strings, so renaming "git:createPr" on one side
 * only ships an app whose button throws "No handler registered". Four such
 * mutations passed the whole suite before this test existed. The table
 * (src/shared/ipcChannels.ts) is the other direction: a method in wireClient
 * / CoderApi but missing from preload is #622.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
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

  it("registers a handler for every table channel, and preload exposes each", async () => {
    const { IPC_CHANNELS, ipcChannelName } = await import(
      pathToFileURL(path.join(__dirname, "../../src/shared/ipcChannels.ts")).href
    );
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

      const table = new Set(IPC_CHANNELS.map(ipcChannelName));
      for (const row of IPC_CHANNELS) {
        const ch = ipcChannelName(row);
        assert.equal(
          typeof api[row.ns]?.[row.method],
          "function",
          `preload must expose ${row.ns}.${row.method}`,
        );
        assert.ok(handlers.has(ch), `main must handle ${ch}`);
      }
      for (const ch of handlers.keys()) {
        if (ch === "contextMenu:show") continue;
        assert.ok(table.has(ch), `IPC_CHANNELS missing handler ${ch}`);
      }

      assert.equal(
        typeof api.attachments.droppedFilePath,
        "function",
        "preload must expose attachments.droppedFilePath (not a channel)",
      );
      assert.equal(
        typeof api.contextMenu.show,
        "function",
        "preload must expose contextMenu.show",
      );
      assert.ok(
        handlers.has("contextMenu:show"),
        "registerIpc must still handle desktop-only contextMenu:show",
      );
      // #622 canary: these lived on wireClient and CoderApi but not preload.
      assert.equal(
        typeof api.threads.setVerifyCommand,
        "function",
        "preload must expose threads.setVerifyCommand",
      );
      assert.equal(
        typeof api.threads.runVerify,
        "function",
        "preload must expose threads.runVerify",
      );
      assert.equal(
        typeof api.threads.runCommand,
        "function",
        "preload must expose threads.runCommand",
      );
    });
  });

  it("preload inlined table matches src/shared/ipcChannels.ts", () => {
    const { spawnSync } = require("node:child_process");
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        path.join(__dirname, "../../scripts/sync-ipc-preload.js"),
        "--check",
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
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

const SIMULATOR_IPC_METHODS = [
  "capabilities",
  "selectDeveloperDir",
  "listDevices",
  "status",
  "attach",
  "detach",
  "takeControl",
  "streamInfo",
  "retryStream",
  "sendInput",
  "accessibility",
  "scrollTo",
  "install",
  "launch",
  "openUrl",
  "screenshot",
  "startRecording",
  "stopRecording",
];

const SIMULATOR_SERVICE_METHODS = {
  capabilities: "getCapabilities",
  selectDeveloperDir: "selectDeveloperDirectory",
  listDevices: "listDevices",
  status: "getStatus",
  attach: "attach",
  detach: "detach",
  takeControl: "takeover",
  streamInfo: "streamInfo",
  retryStream: "retryStream",
  sendInput: "sendInput",
  accessibility: "accessibility",
  scrollTo: "scrollTo",
  install: "install",
  launch: "launch",
  openUrl: "openUrl",
  screenshot: "captureScreenshot",
  startRecording: "startRecording",
  stopRecording: "stopRecording",
};

function makeFakeSimulatorService() {
  const calls = [];
  const service = {};
  for (const [ipcMethod, serviceMethod] of Object.entries(
    SIMULATOR_SERVICE_METHODS,
  )) {
    service[serviceMethod] = async (input) => {
      calls.push({ ipcMethod, serviceMethod, input });
      if (serviceMethod === "streamInfo") {
        return {
          url: "ws://127.0.0.1:9",
          token: "viewer-only-token",
          generation: 3,
          protocolVersion: 1,
          maxMessageBytes: 4194304,
        };
      }
      if (serviceMethod === "listDevices") return [];
      if (serviceMethod === "getCapabilities") {
        return { platform: "darwin", supported: true, capabilities: {} };
      }
      if (serviceMethod === "getStatus") {
        return { attached: false, generation: null };
      }
      if (serviceMethod === "attach") {
        return { generation: 1, deviceUdid: "u", bootedBySolenta: false };
      }
      if (serviceMethod === "startRecording") {
        return { recordingId: "rec-1", startedAt: 1 };
      }
      if (serviceMethod === "captureScreenshot") {
        return { id: "art-1", runId: input && input.runId };
      }
      return { ok: true };
    };
  }
  return { service, calls };
}

function assertNoSecretTokens(value, allowViewerToken = false) {
  const json = JSON.stringify(value);
  assert.equal(json.includes("helperToken"), false);
  assert.equal(json.includes("viewerToken"), false);
  if (!allowViewerToken) {
    assert.equal(json.includes("viewer-only-token"), false);
  }
}

describe("IPC seam: desktop-only simulator channels", () => {
  it("registers every simulator channel and preload exposes each", async () => {
    const { IPC_CHANNELS, ipcChannelName } = await import(
      pathToFileURL(path.join(__dirname, "../../src/shared/ipcChannels.ts")).href
    );
    const table = IPC_CHANNELS.filter((row) => row.ns === "simulator").map(
      ipcChannelName,
    );
    assert.deepEqual(
      table,
      SIMULATOR_IPC_METHODS.map((method) => `simulator:${method}`),
    );
    await withStubbedElectron(({ handlers, bridge }) => {
      delete require.cache[require.resolve("../ipc.js")];
      delete require.cache[require.resolve("../preload.js")];
      const { registerIpc } = require("../ipc.js");
      const { Store } = require("../store.js");
      const s = new Store(path.join(os.tmpdir(), `coder-sim-seam-${Date.now()}.json`));
      registerIpc({
        ipcMain: require("electron").ipcMain,
        dialog: {},
        store: s,
        runner: { start() {}, stop() {}, stopAll() {}, activeRunId() { return null; } },
        broadcast() {},
        worktreeBase: path.join(os.tmpdir(), "wt"),
        userDataPath: os.tmpdir(),
        getIosSimulator: () => makeFakeSimulatorService().service,
      });
      require("../preload.js");
      const api = bridge.coder;
      for (const method of SIMULATOR_IPC_METHODS) {
        assert.equal(
          typeof api.simulator?.[method],
          "function",
          `preload must expose simulator.${method}`,
        );
        assert.ok(
          handlers.has(`simulator:${method}`),
          `main must handle simulator:${method}`,
        );
      }
      assert.equal(api.simulator.tap, undefined);
      assert.equal(api.simulator.swipe, undefined);
      assert.equal(api.simulator.typeText, undefined);
      assert.equal(api.simulator.pressButton, undefined);
    });
  });

  it("desktop handlers reach the service with transport desktop and no helper tokens", async () => {
    await withStubbedElectron(async () => {
      delete require.cache[require.resolve("../ipc.js")];
      const { IPC_HANDLERS } = require("../ipc.js");
      const { service, calls } = makeFakeSimulatorService();
      const transports = [];
      const ctx = {
        transport: "desktop",
        getIosSimulator: () => service,
        runner: {
          activeRunId(threadId) {
            return threadId === "t-run" ? "run-active" : null;
          },
        },
      };
      const wrapped = new Proxy(ctx, {
        get(target, prop, receiver) {
          if (prop === "transport") transports.push(target.transport);
          return Reflect.get(target, prop, receiver);
        },
      });

      for (const method of SIMULATOR_IPC_METHODS) {
        const channel = `simulator:${method}`;
        assert.equal(typeof IPC_HANDLERS[channel], "function", channel);
        const input = {
          threadId: method === "screenshot" || method === "startRecording"
            ? "t-run"
            : "t1",
          generation: 1,
          runId: "from-renderer",
          helperToken: "leaked-helper",
          viewerToken: "leaked-viewer",
        };
        const result = await IPC_HANDLERS[channel](wrapped, input);
        assertNoSecretTokens(result, method === "streamInfo");
        if (method === "streamInfo") {
          assert.equal(result.token, "viewer-only-token");
          assert.equal(result.helperToken, undefined);
          assert.equal(result.viewerToken, undefined);
          assert.equal(result.protocolVersion, 1);
          assert.equal(result.maxMessageBytes, 4194304);
        }
      }

      assert.equal(calls.length, SIMULATOR_IPC_METHODS.length);
      assert.ok(transports.every((value) => value === "desktop"));
      assert.ok(transports.length >= SIMULATOR_IPC_METHODS.length);

      const shot = calls.find((c) => c.serviceMethod === "captureScreenshot");
      assert.equal(shot.input.runId, "run-active");
      assert.equal(shot.input.helperToken, undefined);

      const rec = calls.find((c) => c.serviceMethod === "startRecording");
      assert.equal(rec.input.runId, "run-active");

      const idle = makeFakeSimulatorService();
      const idleCtx = {
        transport: "desktop",
        getIosSimulator: () => idle.service,
        runner: { activeRunId() { return null; } },
      };
      await IPC_HANDLERS["simulator:screenshot"](idleCtx, {
        threadId: "t1",
        generation: 1,
        runId: "from-renderer",
      });
      assert.equal(idle.calls[0].input.runId, null);

      await assert.rejects(
        IPC_HANDLERS["simulator:status"](
          { ...ctx, transport: "web" },
          { threadId: "t1" },
        ),
        (err) => {
          assert.equal(err.code, "unsupported_platform");
          assert.match(err.message, /desktop app/);
          return true;
        },
      );
      await assert.rejects(
        IPC_HANDLERS["simulator:status"]({ getIosSimulator: () => service }, {
          threadId: "t1",
        }),
        (err) => err.code === "unsupported_platform",
      );
    });
  });
});

