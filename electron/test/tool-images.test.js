const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  extractImages,
  saveToolImages,
  readToolImage,
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

  it("round-trips through disk as a data URL", () => {
    const [name] = saveToolImages(dir, extractImages(IMAGE_RESULT));
    assert.match(name, /\.png$/);
    assert.ok(fs.existsSync(path.join(dir, "tool-images", name)));
    assert.equal(readToolImage(dir, name), `data:image/png;base64,${PNG_B64}`);
  });

  it("refuses traversal and non-image names", () => {
    assert.equal(readToolImage(dir, "../../etc/passwd"), null);
    assert.equal(readToolImage(dir, "notes.txt"), null);
    assert.equal(readToolImage(dir, ""), null);
  });
});
