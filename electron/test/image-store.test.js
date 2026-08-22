const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pruneImageStores } = require("../image-store.js");
const { saveToolImages, extractImages } = require("../tool-images.js");
const attachments = require("../attachments.js");

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_BLOCK = [
  {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: PNG_B64 },
  },
];

function mockStore(userData, { live = [], archived = [], imagesByThread = {} } = {}) {
  const threads = [
    ...live.map((id) => ({ id, archived: false })),
    ...archived.map((id) => ({ id, archived: true })),
  ];
  return {
    filePath: path.join(userData, "store.json"),
    getThreads: () => threads,
    getMessages: (id) => {
      const names = imagesByThread[id];
      if (!names || !names.length) return [];
      return [{ tool: { images: names } }];
    },
  };
}

describe("image store prune (issue #145)", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-iprune-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("drops archived and deleted thread dirs, keeps live ones", async () => {
    const [liveName] = saveToolImages(dir, extractImages(PNG_BLOCK), "live");
    saveToolImages(dir, extractImages(PNG_BLOCK), "old");
    saveToolImages(dir, extractImages(PNG_BLOCK), "gone");
    const dataUrl = `data:image/png;base64,${Buffer.from("paste").toString("base64")}`;
    const livePaste = attachments.saveImage(dir, "live", dataUrl);
    attachments.saveImage(dir, "old", dataUrl);
    attachments.saveImage(dir, "gone", dataUrl);

    const store = mockStore(dir, {
      live: ["live"],
      archived: ["old"],
    });
    const result = await pruneImageStores({ userDataPath: dir, store });
    assert.ok(result.removed >= 2);

    assert.equal(fs.existsSync(path.join(dir, "tool-images", liveName)), true);
    assert.equal(fs.existsSync(livePaste.path), true);
    assert.equal(fs.existsSync(path.join(dir, "tool-images", "old")), false);
    assert.equal(fs.existsSync(path.join(dir, "tool-images", "gone")), false);
    assert.equal(fs.existsSync(path.join(dir, "attachments", "old")), false);
    assert.equal(fs.existsSync(path.join(dir, "attachments", "gone")), false);
  });

  it("drops unreferenced legacy flat tool-images without hydrating archived threads", async () => {
    const [kept] = saveToolImages(dir, extractImages(PNG_BLOCK));
    const [orphaned] = saveToolImages(dir, extractImages(PNG_BLOCK));
    let archivedHydrated = 0;
    const store = {
      filePath: path.join(dir, "store.json"),
      getThreads: () => [
        { id: "live", archived: false },
        { id: "old", archived: true },
      ],
      getMessages: (id) => {
        if (id === "old") archivedHydrated += 1;
        if (id === "live") return [{ tool: { images: [kept] } }];
        return [{ tool: { images: ["should-not-keep.png"] } }];
      },
    };

    await pruneImageStores({ userDataPath: dir, store });
    assert.equal(archivedHydrated, 0, "must not hydrate archived transcripts");
    assert.equal(fs.existsSync(path.join(dir, "tool-images", kept)), true);
    assert.equal(fs.existsSync(path.join(dir, "tool-images", orphaned)), false);
  });

  it("enforces a global size cap, oldest files first", async () => {
    const a = path.join(dir, "tool-images");
    fs.mkdirSync(a, { recursive: true });
    const oldFile = path.join(a, "old.png");
    const newFile = path.join(a, "new.png");
    fs.writeFileSync(oldFile, Buffer.alloc(80));
    fs.writeFileSync(newFile, Buffer.alloc(80));
    const oldTs = new Date("2020-01-01T00:00:00Z");
    const newTs = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(oldFile, oldTs, oldTs);
    fs.utimesSync(newFile, newTs, newTs);

    const store = mockStore(dir, {
      live: ["live"],
      imagesByThread: { live: ["old.png", "new.png"] },
    });
    await pruneImageStores({ userDataPath: dir, store, maxBytes: 100 });
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(newFile), true);
  });

  it("is a no-op without userData or store", async () => {
    assert.deepEqual(await pruneImageStores({}), { removed: 0, bytes: 0 });
    assert.deepEqual(await pruneImageStores({ userDataPath: dir, store: null }), {
      removed: 0,
      bytes: 0,
    });
  });
});
