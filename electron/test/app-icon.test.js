/**
 * Windows/Linux app icon. The taskbar button falls back to the icon embedded
 * in electron.exe when the window has none, which is how the packaged Windows
 * build shipped showing the stock Electron logo. assets/Solenta.ico is
 * hand-assembled by scripts/make-icon.sh, so a silent encoding slip would be
 * invisible until someone boots Windows — parse it here instead.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const ICO = path.join(ROOT, "assets", "Solenta.ico");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("app icon", () => {
  it("assets/Solenta.ico is a well-formed multi-size PNG icon", () => {
    const buf = fs.readFileSync(ICO);
    assert.equal(buf.readUInt16LE(0), 0, "reserved");
    assert.equal(buf.readUInt16LE(2), 1, "type must be 1 (icon)");
    const count = buf.readUInt16LE(4);
    assert.ok(count >= 5, `expected several sizes, got ${count}`);

    const sizes = [];
    for (let i = 0; i < count; i++) {
      const e = 6 + 16 * i;
      // 0 in the width/height byte means 256 (the format's max).
      const declared = buf.readUInt8(e) || 256;
      assert.equal(buf.readUInt8(e + 1) || 256, declared, "must be square");
      const bytes = buf.readUInt32LE(e + 8);
      const offset = buf.readUInt32LE(e + 12);
      assert.ok(
        offset >= 6 + 16 * count && offset + bytes <= buf.length,
        `entry ${i} points outside the file`,
      );
      const image = buf.subarray(offset, offset + bytes);
      assert.ok(image.subarray(0, 8).equals(PNG_MAGIC), `entry ${i} is not PNG`);
      // IHDR width/height are big-endian at byte 16/20 of a PNG.
      assert.equal(image.readUInt32BE(16), declared, `entry ${i} width`);
      assert.equal(image.readUInt32BE(20), declared, `entry ${i} height`);
      sizes.push(declared);
    }
    assert.ok(sizes.includes(16), "16px is what the title bar renders");
    assert.ok(sizes.includes(256), "256px is what the alt-tab switcher renders");
  });

  it("both Windows icon stamps stay wired", () => {
    // Windows needs two: the window icon (running app) and the .exe resource
    // (Explorer, shortcuts, a pinned taskbar button). Dropping either one
    // brings back half the Electron logo, so pin both call sites.
    const main = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
    assert.match(main, /Solenta\.ico/);
    assert.match(main, /icon-512\.png/);
    const cross = fs.readFileSync(
      path.join(ROOT, "scripts", "package-cross.sh"),
      "utf8",
    );
    assert.match(cross, /assets\/Solenta\.ico/, "payload must ship the icon");
    assert.match(cross, /set-win-icon\.js/, "win32 .exe must be stamped");
    // set-win-icon.js reads the rewritten .exe back and throws on a bad write,
    // which is the real check — but only if the packager keeps calling it.
    assert.ok(
      fs.existsSync(path.join(ROOT, "scripts", "set-win-icon.js")),
      "scripts/set-win-icon.js missing",
    );
    assert.equal(
      require(path.join(ROOT, "package.json")).devDependencies.resedit !==
        undefined,
      true,
      "resedit is what makes the .exe stamp possible off-Windows",
    );
  });
});
