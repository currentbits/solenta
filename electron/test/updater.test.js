"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

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

describe("updater.checkAndStage", () => {
  it("is disabled without a channel/tag stamp (dev tree)", async () => {
    const res = await updater.checkAndStage({ pkg: {}, fetch: fakeFetch({}) });
    assert.equal(res.state, "disabled");
  });

  it("prod: reports none when already on the latest tag", async () => {
    const res = await updater.checkAndStage({
      pkg: PROD_PKG,
      bundlePath: null,
      fetch: fakeFetch({
        "/releases/latest": { tag_name: "v0.1.0", html_url: "x", assets: [] },
      }),
    });
    assert.equal(res.state, "none");
  });

  it("prod: reports available (with url) when latest tag differs and no bundle to swap", async () => {
    const res = await updater.checkAndStage({
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

  it("nightly: follows the newest prerelease, never a prod release", async () => {
    const res = await updater.checkAndStage({
      pkg: NIGHTLY_PKG,
      bundlePath: null,
      fetch: fakeFetch({
        "/releases?": [
          { tag_name: "v0.2.0", prerelease: false, draft: false, assets: [] },
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
    assert.equal(res.tag, "nightly-202608140000-def456");
  });

  it("nightly: reports none when the newest prerelease is this build", async () => {
    const res = await updater.checkAndStage({
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
    const res = await updater.checkAndStage({
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
    const res = await updater.checkAndStage({
      pkg: {},
      channelOverride: "nightly",
      fetch: fakeFetch({}),
    });
    assert.equal(res.state, "disabled");
  });

  it("reports error when the check itself fails", async () => {
    const res = await updater.checkAndStage({
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
});
