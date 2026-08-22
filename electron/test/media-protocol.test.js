const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SCHEME,
  toolImageUrl,
  localImageUrl,
  parseMediaUrl,
  resolveMediaUrl,
} = require("../media-protocol.js");
const { saveToolImages, extractImages } = require("../tool-images.js");
const attachments = require("../attachments.js");

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("solenta-media protocol", () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-media-"));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("builds and parses tool and local URLs", () => {
    assert.equal(toolImageUrl("shot.png"), `${SCHEME}://tool/shot.png`);
    assert.equal(
      toolImageUrl("tid/shot.png"),
      `${SCHEME}://tool/tid/shot.png`,
    );
    assert.deepEqual(parseMediaUrl(`${SCHEME}://tool/tid/shot.png`), {
      kind: "tool",
      name: "tid/shot.png",
    });

    const abs = path.join(dir, "pic.png");
    const url = localImageUrl(abs);
    assert.ok(url.startsWith(`${SCHEME}://local/?p=`));
    assert.deepEqual(parseMediaUrl(url), { kind: "local", path: abs });
  });

  it("rejects other hosts, credentials, and junk", () => {
    assert.equal(parseMediaUrl("https://tool/shot.png"), null);
    assert.equal(parseMediaUrl(`${SCHEME}://evil/shot.png`), null);
    assert.equal(parseMediaUrl(`${SCHEME}://user:pass@tool/shot.png`), null);
    assert.equal(parseMediaUrl("not a url"), null);
    assert.equal(toolImageUrl("../x.png"), null);
    assert.equal(toolImageUrl(""), null);
  });

  it("resolves a saved tool image and 404s traversal", async () => {
    const [name] = saveToolImages(
      dir,
      extractImages([
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG_B64 },
        },
      ]),
      "t1",
    );
    const resolved = await resolveMediaUrl(toolImageUrl(name), dir);
    assert.ok(resolved);
    assert.equal(
      resolved.path,
      path.join(dir, "tool-images", ...name.split("/")),
    );

    assert.equal(
      await resolveMediaUrl(`${SCHEME}://tool/../../etc/passwd`, dir),
      null,
    );
    assert.equal(
      await resolveMediaUrl(toolImageUrl("missing.png"), dir),
      null,
    );
  });

  it("resolves a pasted attachment and refuses non-images", async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from("x").toString("base64")}`;
    const saved = attachments.saveImage(dir, "t1", dataUrl);
    const resolved = await resolveMediaUrl(localImageUrl(saved.path), dir);
    assert.ok(resolved);
    assert.equal(resolved.path, saved.path);

    const txt = path.join(dir, "notes.txt");
    fs.writeFileSync(txt, "hello");
    assert.equal(await resolveMediaUrl(localImageUrl(txt), dir), null);
    assert.equal(
      await resolveMediaUrl(localImageUrl("/etc/passwd"), dir),
      null,
    );
  });
});
