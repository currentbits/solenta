"use strict";

// Windows taskbar overlay for the "needs you" count (#1512). Windows has no
// badge-count API, so we draw the number ourselves: an ink disc with paper
// digits, as a raw BGRA bitmap for nativeImage.createFromBitmap. nativeImage
// cannot decode SVG, and a canvas would need a window, so the digits come
// from a 3x5 pixel font scaled 2x.

const SIZE = 16;
const SCALE = 2;

/** 3x5 glyphs, one string per row, "#" = lit. */
const GLYPHS = {
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["##.", "..#", ".#.", "#..", "###"],
  "3": ["##.", "..#", ".#.", "..#", "##."],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "##.", "..#", "##."],
  "6": [".##", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "##."],
  "+": ["...", ".#.", "###", ".#.", "..."],
};

/**
 * Overlay text for a count: none at 0, the digit up to 9, then "9+".
 * @param {number} n
 * @returns {string | null}
 */
function overlayLabel(n) {
  if (!Number.isFinite(n) || n < 1) return null;
  return n > 9 ? "9+" : String(Math.floor(n));
}

/**
 * Accessible description Windows reads out for the overlay.
 * @param {number} n
 */
function overlayDescription(n) {
  return n === 1 ? "1 thread needs you" : `${n} threads need you`;
}

/**
 * 16x16 BGRA bitmap of the label on an ink disc.
 * @param {string} label
 * @returns {{ width: number, height: number, buffer: Buffer }}
 */
function overlayBitmap(label) {
  const buffer = Buffer.alloc(SIZE * SIZE * 4);
  /** @param {number} x @param {number} y @param {number} v */
  const put = (x, y, v) => {
    const i = (y * SIZE + x) * 4;
    buffer[i] = v;
    buffer[i + 1] = v;
    buffer[i + 2] = v;
    buffer[i + 3] = 255;
  };
  const r = SIZE / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if ((x + 0.5 - r) ** 2 + (y + 0.5 - r) ** 2 <= r * r) put(x, y, 0x1c);
    }
  }
  const chars = [...label].filter((c) => GLYPHS[/** @type {keyof typeof GLYPHS} */ (c)]);
  const gap = chars.length > 1 ? 1 : 0;
  const width = chars.length * 3 * SCALE + gap * (chars.length - 1);
  let left = Math.floor((SIZE - width) / 2);
  const top = Math.floor((SIZE - 5 * SCALE) / 2);
  for (const c of chars) {
    const rows = GLYPHS[/** @type {keyof typeof GLYPHS} */ (c)];
    rows.forEach((row, gy) => {
      [...row].forEach((cell, gx) => {
        if (cell !== "#") return;
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            put(left + gx * SCALE + dx, top + gy * SCALE + dy, 0xf7);
          }
        }
      });
    });
    left += 3 * SCALE + gap;
  }
  return { width: SIZE, height: SIZE, buffer };
}

module.exports = { overlayLabel, overlayDescription, overlayBitmap };
