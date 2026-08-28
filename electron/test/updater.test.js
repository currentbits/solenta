"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const updater = require("../updater.js");

/** Fake fetch keyed by URL substring. */
function fakeFetch(routes) {
  return async (url) => {
    for (const [needle, body] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

const PROD_PKG = { channel: "prod", releaseTag: "v0.1.0" };
const NIGHTLY_PKG = { channel: "nightly", releaseTag: "nightly-202608130000-abc123" };

describe("updater.checkUpdate", () => {
  it("never downloads or swaps, even with a matching asset and bundle", async () => {
    const seen = [];
    const res = await updater.checkUpdate({
      pkg: PROD_PKG,
      platform: "darwin",
      arch: "arm64",
      bundlePath: "/Applications/Solenta.app",
      fetch: async (url) => {
        seen.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: "v0.2.0",
            html_url: "u",
            assets: [
              {
                name: "Solenta-v0.2.0-macos-arm64.zip",
                browser_download_url: "https://example.invalid/app.zip",
              },
            ],
          }),
        };
      },
    });
    assert.equal(res.state, "available");
    assert.ok(
      !seen.some((u) => u.includes("example.invalid")),
      "check must not fetch the asset",
    );
  });

  it("is disabled without a channel/tag stamp (dev tree)", async () => {
    const res = await updater.checkUpdate({ pkg: {}, fetch: fakeFetch({}) });
    assert.equal(res.state, "disabled");
  });

  it("prod: reports none when already on the latest tag", async () => {
    const res = await updater.checkUpdate({
      pkg: PROD_PKG,
      bundlePath: null,
      fetch: fakeFetch({
        "/releases/latest": { tag_name: "v0.1.0", html_url: "x", assets: [] },
      }),
    });
    assert.equal(res.state, "none");
  });

  it("prod: reports available (with url) when latest tag differs and no bundle to swap", async () => {
    const res = await updater.checkUpdate({
      pkg: PROD_PKG,
      bundlePath: null,
      fetch: fakeFetch({
        "/releases/latest": {
          tag_name: "v0.2.0",
          html_url: "https://github.com/currentbits/solenta/releases/tag/v0.2.0",
          assets: [{ name: "Solenta-v0.2.0-macos-arm64.zip", browser_download_url: "d" }],
        },
      }),
    });
    assert.equal(res.state, "available");
    assert.equal(res.tag, "v0.2.0");
    assert.match(res.url, /releases\/tag\/v0.2.0/);
  });

  it("nightly: follows the newest release, prerelease or not", async () => {
    const res = await updater.checkUpdate({
      pkg: NIGHTLY_PKG,
      bundlePath: null,
      fetch: fakeFetch({
        "/releases?": [
          {
            tag_name: "v0.2.0",
            prerelease: false,
            draft: false,
            html_url: "y",
            published_at: "2026-08-14T20:00:00Z",
            assets: [],
          },
          {
            tag_name: "nightly-202608140000-def456",
            prerelease: true,
            draft: false,
            published_at: "2026-08-14T00:00:00Z",
            assets: [],
          },
        ],
      }),
    });
    // A prod release cut after the last nightly wins, otherwise the install
    // freezes as soon as nightlies stop being cut.
    assert.equal(res.state, "available");
    assert.equal(res.tag, "v0.2.0");
  });

  it("nightly: picks by publish time, not list position (GitHub floats 'latest' first)", async () => {
    // Real /releases payload shape from 2026-08-22: v0.10.0 (published 14:43)
    // sits at index 0, above a nightly published at 20:49. Trusting position
    // offered the running nightly a permanent downgrade to v0.10.0.
    const res = await updater.checkUpdate({
      pkg: { channel: "nightly", releaseTag: "nightly-202608222047-20a1cc0" },
      bundlePath: null,
      fetch: fakeFetch({
        "/releases?": [
          {
            tag_name: "v0.10.0",
            prerelease: false,
            draft: false,
            html_url: "y",
            published_at: "2026-08-22T14:43:22Z",
            assets: [],
          },
          {
            tag_name: "nightly-202608222047-20a1cc0",
            prerelease: true,
            draft: false,
            published_at: "2026-08-22T20:49:07Z",
            assets: [],
          },
        ],
      }),
    });
    assert.equal(res.state, "none", "the running nightly IS the newest release");
  });

  it("nightly: skips drafts", async () => {
    const res = await updater.checkUpdate({
      pkg: NIGHTLY_PKG,
      bundlePath: null,
      fetch: fakeFetch({
        "/releases?": [
          { tag_name: "v0.3.0", prerelease: false, draft: true, assets: [] },
          { tag_name: "v0.2.0", prerelease: false, draft: false, html_url: "y", assets: [] },
        ],
      }),
    });
    assert.equal(res.tag, "v0.2.0");
  });

  it("nightly: reports none when the newest release is this build", async () => {
    const res = await updater.checkUpdate({
      pkg: NIGHTLY_PKG,
      bundlePath: null,
      fetch: fakeFetch({
        "/releases?": [
          { tag_name: NIGHTLY_PKG.releaseTag, prerelease: true, draft: false, assets: [] },
        ],
      }),
    });
    assert.equal(res.state, "none");
  });

  it("channelOverride switches a prod build onto the nightly feed", async () => {
    const res = await updater.checkUpdate({
      pkg: PROD_PKG,
      channelOverride: "nightly",
      bundlePath: null,
      fetch: fakeFetch({
        "/releases?": [
          {
            tag_name: "nightly-202608140000-def456",
            prerelease: true,
            draft: false,
            html_url: "y",
            assets: [],
          },
        ],
      }),
    });
    assert.equal(res.state, "available");
    assert.equal(res.channel, "nightly");
    assert.equal(res.tag, "nightly-202608140000-def456");
  });

  it("channelOverride does not enable updates in an unstamped dev tree", async () => {
    const res = await updater.checkUpdate({
      pkg: {},
      channelOverride: "nightly",
      fetch: fakeFetch({}),
    });
    assert.equal(res.state, "disabled");
  });

  it("reports error when the check itself fails", async () => {
    const res = await updater.checkUpdate({
      pkg: PROD_PKG,
      bundlePath: null,
      fetch: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(res.state, "error");
    assert.match(res.error, /offline/);
  });
});

describe("updater.stage digest verification", () => {
  const bytes = Buffer.from("pretend this is a zip");
  const sum = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  const deps = {
    fetch: async () => ({
      ok: true,
      status: 200,
      body: Readable.toWeb(Readable.from(bytes)),
    }),
  };
  const asset = (digest) => ({ browser_download_url: "https://example.invalid/a.zip", digest });

  it("refuses an asset with no digest", async () => {
    await assert.rejects(
      updater.stage(asset(undefined), "/nope.app", "v1", deps),
      /no sha256 digest/,
    );
  });

  it("refuses a digest that does not match the bytes", async () => {
    await assert.rejects(
      updater.stage(asset(`sha256:${"0".repeat(64)}`), "/nope.app", "v1", deps),
      /digest mismatch/,
    );
  });

  it("gets past verification when the digest matches", async () => {
    // Extraction then fails (not a real zip) — that it got that far is the point.
    await assert.rejects(
      updater.stage(asset(`sha256:${sum}`), "/nope.app", "v1", deps),
      (err) => !/digest/.test(err.message),
    );
  });
});

describe("updater.pickAsset", () => {
  it("matches the platform/arch token in asset names", () => {
    const release = {
      assets: [
        { name: "Solenta-0.1.0-win32-x64.zip" },
        { name: "Solenta-0.1.0-macos-arm64.zip" },
        { name: "Solenta-0.1.0-linux-x64.tar.gz" },
      ],
    };
    assert.match(updater.pickAsset(release, "darwin", "arm64").name, /macos-arm64/);
    assert.match(updater.pickAsset(release, "win32", "x64").name, /win32-x64/);
    assert.equal(updater.pickAsset(release, "linux", "arm64"), null);
  });
});

describe("app:checkUpdate handler", () => {
  /** ipc.js requires electron at load; stub it to run in plain node. */
  function loadHandlers() {
    const Module = require("node:module");
    const orig = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === "electron") return { BrowserWindow: {}, shell: {} };
      return orig.apply(this, arguments);
    };
    try {
      delete require.cache[require.resolve("../ipc.js")];
      return require("../ipc.js").IPC_HANDLERS;
    } finally {
      Module.prototype.require = orig;
    }
  }

  /** @param {any} status @param {any} stored */
  async function check(status, stored) {
    const handlers = loadHandlers();
    const settings = { updateChannel: stored };
    const real = updater.downloadUpdate;
    updater.downloadUpdate = async () => status;
    try {
      await handlers["app:downloadUpdate"]({
        store: {
          getSettings: () => settings,
          setSettings: (patch) => Object.assign(settings, patch),
        },
      });
    } finally {
      updater.downloadUpdate = real;
    }
    return settings.updateChannel;
  }

  it("pins the channel when a nightly build stages a (prod-stamped) update", async () => {
    assert.equal(await check({ state: "staged", channel: "nightly" }, null), "nightly");
  });

  it("leaves settings alone when nothing was staged", async () => {
    assert.equal(await check({ state: "none", channel: "nightly" }, null), null);
  });

  it("never overrides an explicit channel choice", async () => {
    assert.equal(await check({ state: "staged", channel: "prod" }, "nightly"), "nightly");
  });
});

describe("updater.bundlePath", () => {
  it("rejects non-.app and node_modules electron binaries", () => {
    if (process.platform !== "darwin") return;
    assert.equal(updater.bundlePath("/usr/local/bin/node"), null);
    assert.equal(
      updater.bundlePath(
        "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      null,
    );
    assert.equal(
      updater.bundlePath("/Applications/Solenta.app/Contents/MacOS/Solenta"),
      "/Applications/Solenta.app",
    );
  });

  it("linux: install root is the folder containing solenta + resources", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-upd-root-"));
    try {
      fs.mkdirSync(path.join(dir, "resources"));
      const exe = path.join(dir, "solenta");
      fs.writeFileSync(exe, "");
      assert.equal(updater.bundlePath(exe, "linux"), dir);
      const nightlyDir = path.join(dir, "nightly");
      fs.mkdirSync(path.join(nightlyDir, "resources"), { recursive: true });
      const nightly = path.join(nightlyDir, "solenta-nightly");
      fs.writeFileSync(nightly, "");
      assert.equal(updater.bundlePath(nightly, "linux"), nightlyDir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("linux: rejects electron, node_modules, and a tree with no resources", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-upd-bad-"));
    try {
      fs.mkdirSync(path.join(dir, "resources"));
      const electron = path.join(dir, "electron");
      fs.writeFileSync(electron, "");
      assert.equal(updater.bundlePath(electron, "linux"), null);

      const nested = path.join(dir, "node_modules", "electron");
      fs.mkdirSync(path.join(nested, "resources"), { recursive: true });
      const nestedExe = path.join(nested, "solenta");
      fs.writeFileSync(nestedExe, "");
      assert.equal(updater.bundlePath(nestedExe, "linux"), null);

      const bare = path.join(dir, "bare");
      fs.mkdirSync(bare);
      const bareExe = path.join(bare, "solenta");
      fs.writeFileSync(bareExe, "");
      assert.equal(updater.bundlePath(bareExe, "linux"), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Portable linux tar.gz matching package-cross.sh: solenta/solenta + resources/. */
function makeLinuxTar() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-upd-tar-"));
  const tree = path.join(parent, "solenta");
  fs.mkdirSync(path.join(tree, "resources", "app"), { recursive: true });
  fs.writeFileSync(path.join(tree, "solenta"), "new-bin");
  fs.chmodSync(path.join(tree, "solenta"), 0o755);
  fs.writeFileSync(path.join(tree, "resources", "app", "marker.txt"), "next");
  const tar = path.join(parent, "update.tar.gz");
  execFileSync("tar", ["-czf", tar, "solenta"], { cwd: parent });
  const bytes = fs.readFileSync(tar);
  return {
    parent,
    tar,
    bytes,
    digest: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
  };
}

describe("updater.downloadUpdate linux portable", () => {
  afterEach(() => {
    if (typeof updater.resetStaged === "function") updater.resetStaged();
  });

  it("stages next to the live folder and leaves the running tree untouched", async () => {
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-upd-live-"));
    const archive = makeLinuxTar();
    try {
      fs.mkdirSync(path.join(install, "resources", "app"), { recursive: true });
      fs.writeFileSync(path.join(install, "solenta"), "old-bin");
      fs.writeFileSync(path.join(install, "resources", "app", "marker.txt"), "current");

      const res = await updater.downloadUpdate({
        pkg: PROD_PKG,
        platform: "linux",
        arch: "x64",
        bundlePath: install,
        fetch: async (url) => {
          if (String(url).includes("example.invalid")) {
            return {
              ok: true,
              status: 200,
              body: Readable.toWeb(Readable.from(archive.bytes)),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              tag_name: "v0.2.0",
              html_url: "u",
              assets: [
                {
                  name: "Solenta-v0.2.0-linux-x64.tar.gz",
                  browser_download_url: "https://example.invalid/app.tar.gz",
                  digest: archive.digest,
                },
              ],
            }),
          };
        },
      });

      assert.equal(res.state, "staged");
      assert.equal(
        fs.readFileSync(path.join(install, "resources", "app", "marker.txt"), "utf8"),
        "current",
        "live install must stay put; extract beside it, swap after quit",
      );
      const staged = `${install}.update`;
      assert.equal(
        fs.readFileSync(path.join(staged, "resources", "app", "marker.txt"), "utf8"),
        "next",
      );
      assert.equal(fs.readFileSync(path.join(staged, "solenta"), "utf8"), "new-bin");
    } finally {
      fs.rmSync(install, { recursive: true, force: true });
      fs.rmSync(`${install}.update`, { recursive: true, force: true });
      fs.rmSync(archive.parent, { recursive: true, force: true });
    }
  });

  it("refuses to stage a linux asset with no digest", async () => {
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-upd-nodigest-"));
    try {
      fs.mkdirSync(path.join(install, "resources"), { recursive: true });
      const res = await updater.downloadUpdate({
        pkg: PROD_PKG,
        platform: "linux",
        arch: "x64",
        bundlePath: install,
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: "v0.2.0",
            html_url: "u",
            assets: [
              {
                name: "Solenta-v0.2.0-linux-x64.tar.gz",
                browser_download_url: "https://example.invalid/app.tar.gz",
              },
            ],
          }),
        }),
      });
      assert.equal(res.state, "available");
      assert.match(res.error, /no sha256 digest/);
      assert.equal(fs.existsSync(`${install}.update`), false);
    } finally {
      fs.rmSync(install, { recursive: true, force: true });
    }
  });
});

describe("updater.applyUpdate linux", () => {
  afterEach(() => {
    if (typeof updater.resetStaged === "function") updater.resetStaged();
  });

  it("launches a shell helper and quits without relaunch", () => {
    const calls = [];
    updater.applyUpdate({
      platform: "linux",
      stagedDir: "/opt/Solenta.update",
      installRoot: "/opt/Solenta",
      exeName: "solenta",
      pid: 4242,
      spawn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return { unref() {} };
      },
      app: {
        relaunch: () => calls.push("relaunch"),
        quit: () => calls.push("quit"),
      },
    });
    const spawned = calls.find((c) => c && c.cmd);
    assert.ok(spawned, "must spawn a helper");
    assert.ok(/\/bin\/sh$/.test(spawned.cmd) || spawned.cmd === "sh", "must spawn a shell helper");
    assert.ok(!/cmd\.exe/i.test(spawned.cmd), "linux must not use cmd.exe");
    assert.ok(spawned.args.includes("/opt/Solenta.update"));
    assert.ok(spawned.args.includes("/opt/Solenta"));
    assert.ok(spawned.args.includes("solenta"));
    assert.ok(spawned.args.includes("4242"));
    assert.ok(!calls.includes("relaunch"), "relaunch would exec the still-old tree");
    assert.ok(calls.includes("quit"));
  });

  it("macOS still relaunches the already-swapped bundle", () => {
    const calls = [];
    updater.applyUpdate({
      platform: "darwin",
      app: {
        relaunch: () => calls.push("relaunch"),
        quit: () => calls.push("quit"),
      },
    });
    assert.deepEqual(calls, ["relaunch", "quit"]);
  });
});
