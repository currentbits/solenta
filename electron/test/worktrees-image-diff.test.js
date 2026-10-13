// Git pane image before/after (#1192): exact scope refs, missing sides,
// caps, and that viewing never touches the index or runs a filename.
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { diff, imageDiff } = require("../worktrees.js");
const { imageInfo } = require("../worktrees-changes.js");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A real, decodable w×h PNG filled with one RGBA colour. */
function png(w, h, [r, g, b, a]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 4).fill(Buffer.from([r, g, b, a]))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(h).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const bytesOf = (dataUrl) => Buffer.from(dataUrl.split(",")[1], "base64");

describe("imageInfo", () => {
  it("reads dimensions from headers without decoding", () => {
    assert.deepEqual(imageInfo(png(3, 2, [0, 0, 0, 0])), { mime: "image/png", width: 3, height: 2 });
    const gif = Buffer.from("GIF89a\x05\x00\x07\x00", "latin1");
    assert.deepEqual(imageInfo(gif), { mime: "image/gif", width: 5, height: 7 });
    const bmp = Buffer.alloc(26);
    bmp.write("BM", 0, "latin1");
    bmp.writeInt32LE(9, 18);
    bmp.writeInt32LE(-4, 22);
    assert.deepEqual(imageInfo(bmp), { mime: "image/bmp", width: 9, height: 4 });
    // SOI, APP0 (len 4), SOF0 with height 6, width 8.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 6, 0, 8, 3, 0, 0, 0]);
    assert.deepEqual(imageInfo(jpeg), { mime: "image/jpeg", width: 8, height: 6 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBPVP8X", 8, "latin1");
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(49, 27, 3);
    assert.deepEqual(imageInfo(webp), { mime: "image/webp", width: 100, height: 50 });
  });

  it("refuses SVG, text and truncated headers", () => {
    assert.equal(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.equal(imageInfo(Buffer.from("hello")), null);
    assert.equal(imageInfo(png(1, 1, [0, 0, 0, 0]).subarray(0, 20)), null);
  });
});

describe("imageDiff", () => {
  let tmpDir;
  let store;
  let repo;
  let thread;
  const red = png(4, 3, [255, 0, 0, 255]);
  const blue = png(4, 3, [0, 0, 255, 128]);

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-imgdiff-"));
    store = new Store(path.join(tmpDir, "store.json"));
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "icon.png"), red);
    fs.writeFileSync(path.join(repo, "gone.png"), red);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "init"]);
    const project = await services.addProject(store, repo);
    thread = services.createThread(store, { projectId: project.id, title: "Images" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uncommitted: HEAD bytes before, working-tree bytes after, index untouched", async () => {
    fs.writeFileSync(path.join(repo, "icon.png"), blue);
    const status = git(repo, ["status", "--porcelain"]);
    const index = fs.readFileSync(path.join(repo, ".git", "index"));
    const head = git(repo, ["rev-parse", "--short", "HEAD"]);

    const { before, after } = await imageDiff({ store, threadId: thread.id, path: "icon.png" });
    assert.equal(before.label, `HEAD ${head}`);
    assert.deepEqual([before.width, before.height, before.bytes], [4, 3, red.length]);
    assert.ok(bytesOf(before.dataUrl).equals(red));
    assert.equal(after.label, "Working tree");
    assert.ok(after.dataUrl.startsWith("data:image/png;base64,"));
    assert.ok(bytesOf(after.dataUrl).equals(blue));

    assert.equal(git(repo, ["status", "--porcelain"]), status);
    assert.ok(fs.readFileSync(path.join(repo, ".git", "index")).equals(index));
  });

  it("marks the missing side of added and deleted images", async () => {
    fs.writeFileSync(path.join(repo, "new.png"), blue);
    fs.rmSync(path.join(repo, "gone.png"));
    const added = await imageDiff({ store, threadId: thread.id, path: "new.png" });
    assert.equal(added.before.exists, false);
    assert.equal(added.after.exists, true);
    const deleted = await imageDiff({ store, threadId: thread.id, path: "gone.png" });
    assert.equal(deleted.before.exists, true);
    assert.equal(deleted.after.exists, false);
  });

  it("follows a staged rename through the diff's oldPath", async () => {
    git(repo, ["mv", "icon.png", "logo.png"]);
    fs.writeFileSync(path.join(repo, "logo.png"), Buffer.concat([red, Buffer.from("tail")]));
    const listed = (await diff({ store, threadId: thread.id })).files.find((f) => f.path === "logo.png");
    assert.equal(listed.oldPath, "icon.png");
    const { before, after } = await imageDiff({
      store, threadId: thread.id, path: listed.path, oldPath: listed.oldPath,
    });
    assert.ok(bytesOf(before.dataUrl).equals(red));
    assert.equal(after.bytes, red.length + 4);
  });

  it("branch scope compares against the merge base, not HEAD", async () => {
    const base = git(repo, ["rev-parse", "--short", "HEAD"]);
    git(repo, ["checkout", "-b", "feature"]);
    store.updateThread(thread.id, { baseBranch: "main" });
    fs.writeFileSync(path.join(repo, "icon.png"), blue);
    git(repo, ["commit", "-am", "blue"]);
    fs.writeFileSync(path.join(repo, "icon.png"), png(2, 2, [0, 255, 0, 255]));
    const { before, after } = await imageDiff({
      store, threadId: thread.id, scope: "branch", path: "icon.png",
    });
    assert.equal(before.label, `Merge base ${base}`);
    assert.ok(bytesOf(before.dataUrl).equals(red));
    assert.deepEqual([after.width, after.height], [2, 2]);
  });

  it("caps bytes and pixels with a note instead of a preview", async () => {
    // Valid header claiming 100k × 100k: tiny file, huge decode.
    const bomb = png(1, 1, [0, 0, 0, 0]);
    bomb.writeUInt32BE(100_000, 16);
    bomb.writeUInt32BE(100_000, 20);
    fs.writeFileSync(path.join(repo, "bomb.png"), bomb);
    const big = Buffer.alloc(9 * 1024 * 1024);
    red.copy(big);
    fs.writeFileSync(path.join(repo, "big.png"), big);
    fs.writeFileSync(path.join(repo, "fake.png"), "<html>not an image</html>");

    const b = (await imageDiff({ store, threadId: thread.id, path: "bomb.png" })).after;
    assert.equal(b.note, "Too many pixels to preview");
    assert.equal(b.dataUrl, undefined);
    const l = (await imageDiff({ store, threadId: thread.id, path: "big.png" })).after;
    assert.deepEqual([l.note, l.bytes, l.dataUrl], ["Too large to preview", big.length, undefined]);
    const f = (await imageDiff({ store, threadId: thread.id, path: "fake.png" })).after;
    assert.equal(f.note, "Not a supported image format");
  });

  it("treats filenames as data and refuses escapes and symlinks", async () => {
    const name = "$(touch pwned) `id`; rm -rf x.png";
    fs.writeFileSync(path.join(repo, name), blue);
    const odd = await imageDiff({ store, threadId: thread.id, path: name });
    assert.ok(bytesOf(odd.after.dataUrl).equals(blue));
    assert.equal(fs.existsSync(path.join(repo, "pwned")), false);

    await assert.rejects(imageDiff({ store, threadId: thread.id, path: "../outside.png" }), /escapes/);
    await assert.rejects(imageDiff({ store, threadId: thread.id, path: "-x.png" }), /Invalid path/);

    const outside = path.join(tmpDir, "secret.png");
    fs.writeFileSync(outside, red);
    fs.symlinkSync(outside, path.join(repo, "link.png"));
    const link = await imageDiff({ store, threadId: thread.id, path: "link.png" });
    assert.equal(link.after.note, "Not a regular file");
    assert.equal(link.after.dataUrl, undefined);
  });
});
