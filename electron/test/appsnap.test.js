const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const appsnap = require("../appsnap.js");

describe("appsnap", () => {
  afterEach(() => {
    appsnap.setGetSources(null);
  });

  it("lists named windows and skips blank ids", async () => {
    appsnap.setGetSources(async () => [
      { id: "window:1:0", name: "Finder" },
      { id: "", name: "ghost" },
      { id: "window:2:0", name: "  " },
      { id: "window:3:0", name: "Solenta" },
    ]);
    const { windows } = await appsnap.listWindows();
    assert.deepEqual(windows, [
      { id: "window:1:0", name: "Finder" },
      { id: "window:3:0", name: "Solenta" },
    ]);
  });

  it("captures the matching window PNG", async () => {
    const png = Buffer.from("png-bytes");
    appsnap.setGetSources(async () => [
      { id: "window:1:0", name: "Finder", thumbnail: { toPNG: () => png } },
    ]);
    const buf = await appsnap.captureWindowPng("window:1:0");
    assert.equal(buf, png);
  });

  it("rejects a vanished window", async () => {
    appsnap.setGetSources(async () => []);
    await assert.rejects(
      () => appsnap.captureWindowPng("window:9:0"),
      /no longer available/i,
    );
  });
});
