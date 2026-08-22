const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  extractImages,
  saveToolImages,
  readToolImage,
  resolveToolImagePath,
  toolImageExists,
} = require("../tool-images.js");
const { flattenContent } = require("../claude.js");

// 1x1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const IMAGE_RESULT = [
  { type: "text", text: "Read image" },
  { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
];

describe("tool images", () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-images-"));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("extracts base64 image blocks and skips malformed ones", () => {
    assert.deepEqual(extractImages(IMAGE_RESULT), [
      { mediaType: "image/png", data: PNG_B64 },
    ]);
    assert.deepEqual(extractImages("plain text"), []);
    assert.deepEqual(
      extractImages([{ type: "image", source: { type: "url", url: "x" } }]),
      [],
    );
  });

  it("keeps base64 out of the tool output text", () => {
    const text = flattenContent(IMAGE_RESULT);
    assert.equal(text, "Read image\n[image]");
    assert.ok(!text.includes(PNG_B64));
  });

  it("round-trips a scoped save through disk as a data URL", async () => {
    const [name] = saveToolImages(dir, extractImages(IMAGE_RESULT), "thread-1");
    assert.match(name, /^thread-1\/[0-9a-f-]+\.png$/);
    assert.ok(fs.existsSync(path.join(dir, "tool-images", name)));
    assert.equal(
      await readToolImage(dir, name),
      `data:image/png;base64,${PNG_B64}`,
    );
    assert.equal(await toolImageExists(dir, name), true);
  });

  it("still writes a flat file when threadId is missing (legacy)", async () => {
    const [name] = saveToolImages(dir, extractImages(IMAGE_RESULT));
    assert.match(name, /^[0-9a-f-]+\.png$/);
    assert.ok(!name.includes("/"));
    assert.ok(fs.existsSync(path.join(dir, "tool-images", name)));
    assert.equal(
      await readToolImage(dir, name),
      `data:image/png;base64,${PNG_B64}`,
    );
  });

  it("refuses traversal and non-image names", async () => {
    assert.equal(resolveToolImagePath(dir, "../../etc/passwd"), null);
    assert.equal(resolveToolImagePath(dir, "tid/../../etc/passwd.png"), null);
    assert.equal(resolveToolImagePath(dir, "../uuid.png"), null);
    assert.equal(resolveToolImagePath(dir, "notes.txt"), null);
    assert.equal(resolveToolImagePath(dir, ""), null);
    assert.equal(await readToolImage(dir, "../../etc/passwd"), null);
    assert.equal(await readToolImage(dir, "notes.txt"), null);
    assert.equal(await readToolImage(dir, ""), null);
    assert.equal(await toolImageExists(dir, "../../etc/passwd"), false);
  });
});
