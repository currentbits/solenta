const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  overlayLabel,
  overlayDescription,
  overlayBitmap,
} = require("../taskbarOverlay.js");

describe("taskbar overlay (Windows, #1512)", () => {
  it("maps the needs-you count to an overlay label", () => {
    assert.equal(overlayLabel(0), null);
    assert.equal(overlayLabel(-1), null);
    assert.equal(overlayLabel(NaN), null);
    assert.equal(overlayLabel(1), "1");
    assert.equal(overlayLabel(9), "9");
    assert.equal(overlayLabel(10), "9+");
    assert.equal(overlayLabel(250), "9+");
  });

  it("describes the count for screen readers", () => {
    assert.equal(overlayDescription(1), "1 thread needs you");
    assert.equal(overlayDescription(12), "12 threads need you");
  });

  it("draws a 16x16 BGRA bitmap with paper digits on an ink disc", () => {
    const one = overlayBitmap("1");
    assert.equal(one.width, 16);
    assert.equal(one.height, 16);
    assert.equal(one.buffer.length, 16 * 16 * 4);
    const px = (/** @type {Buffer} */ b, x, y) => b[(y * 16 + x) * 4];
    const alpha = (/** @type {Buffer} */ b, x, y) => b[(y * 16 + x) * 4 + 3];
    assert.equal(alpha(one.buffer, 0, 0), 0, "corner is transparent");
    assert.equal(px(one.buffer, 8, 1), 0x1c, "disc edge is ink");
    const lit = (/** @type {Buffer} */ b) => {
      let n = 0;
      for (let i = 0; i < b.length; i += 4) if (b[i] === 0xf7) n += 1;
      return n;
    };
    // "1" has 8 lit cells, each 2x2; "9+" has 11 + 5.
    assert.equal(lit(one.buffer), 8 * 4);
    assert.equal(lit(overlayBitmap("9+").buffer), 16 * 4);
    assert.notDeepEqual(overlayBitmap("2").buffer, overlayBitmap("3").buffer);
  });
});
