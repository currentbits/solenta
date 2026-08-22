/**
 * files:image / attachments:readImage: desktop replies with a solenta-media
 * URL (no base64), web (serveDataUrls) still replies with a data URL.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { saveToolImages, extractImages } = require("../tool-images.js");
const attachments = require("../attachments.js");
const { SCHEME } = require("../media-protocol.js");

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function withStubbedElectron(fn) {
  const stub = {
    ipcMain: { handle() {} },
    BrowserWindow: { getAllWindows: () => [] },
    dialog: {},
    shell: {},
    app: { getPath: () => os.tmpdir() },
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return stub;
    return origLoad.apply(this, arguments);
  };
  try {
    return await fn();
  } finally {
    Module._load = origLoad;
  }
}

describe("image IPC replies (issue #145)", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-iipc-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("desktop files:image returns a protocol URL; web returns a data URL", async () => {
    const [name] = saveToolImages(
      tmp,
      extractImages([
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG_B64 },
        },
      ]),
      "t1",
    );
    await withStubbedElectron(async () => {
      for (const m of ["../ipc.js", "../media-protocol.js", "../tool-images.js"]) {
        delete require.cache[require.resolve(m)];
      }
      const { IPC_HANDLERS } = require("../ipc.js");
      const desktop = await IPC_HANDLERS["files:image"](
        { userDataPath: tmp },
        { name },
      );
      assert.ok(
        desktop.dataUrl && desktop.dataUrl.startsWith(`${SCHEME}://tool/`),
        `desktop must not base64, got ${desktop.dataUrl}`,
      );
      assert.ok(
        !desktop.dataUrl.includes(PNG_B64),
        "desktop reply must not carry image bytes",
      );

      const web = await IPC_HANDLERS["files:image"](
        { userDataPath: tmp, serveDataUrls: true },
        { name },
      );
      assert.equal(web.dataUrl, `data:image/png;base64,${PNG_B64}`);
    });
  });

  it("desktop attachments:readImage returns a protocol URL", async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from("paste").toString("base64")}`;
    const saved = attachments.saveImage(tmp, "t1", dataUrl);
    await withStubbedElectron(async () => {
      for (const m of ["../ipc.js", "../media-protocol.js", "../attachments.js"]) {
        delete require.cache[require.resolve(m)];
      }
      const { IPC_HANDLERS } = require("../ipc.js");
      const desktop = await IPC_HANDLERS["attachments:readImage"](
        { userDataPath: tmp },
        { path: saved.path },
      );
      assert.ok(
        desktop.dataUrl && desktop.dataUrl.startsWith(`${SCHEME}://local/`),
        `desktop must not base64, got ${desktop.dataUrl}`,
      );

      const web = await IPC_HANDLERS["attachments:readImage"](
        { userDataPath: tmp, serveDataUrls: true },
        { path: saved.path },
      );
      assert.equal(web.dataUrl, dataUrl);
    });
  });

  it("missing or traversal names return null", async () => {
    await withStubbedElectron(async () => {
      delete require.cache[require.resolve("../ipc.js")];
      const { IPC_HANDLERS } = require("../ipc.js");
      const missing = await IPC_HANDLERS["files:image"](
        { userDataPath: tmp },
        { name: "nope.png" },
      );
      assert.deepEqual(missing, { dataUrl: null });
      const traversal = await IPC_HANDLERS["files:image"](
        { userDataPath: tmp },
        { name: "../../etc/passwd" },
      );
      assert.deepEqual(traversal, { dataUrl: null });
    });
  });
});
