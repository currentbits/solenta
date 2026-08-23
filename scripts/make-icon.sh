#!/usr/bin/env bash
# Generate assets/Solenta.icns (macOS bundle), assets/Solenta.ico (Windows
# window/taskbar icon) and assets/icon-512.png (dev dock + Linux window icon)
# from assets/icon.svg. Zero new dependencies: rasterizes with the sharp that
# already ships in memory-server/node_modules, converts with macOS iconutil.
# Idempotent: safe to re-run; outputs are overwritten.
set -euo pipefail
cd "$(dirname "$0")/.."

SVG="assets/icon.svg"
ICONSET="assets/Solenta.iconset"
ICNS="assets/Solenta.icns"
SHARP_DIR="memory-server/node_modules/sharp"

if [[ ! -f "$SVG" ]]; then
  echo "error: $SVG missing" >&2
  exit 1
fi
if [[ ! -d "$SHARP_DIR" ]]; then
  echo "error: sharp not installed at $SHARP_DIR" >&2
  echo "fix:   cd memory-server && npm install" >&2
  exit 1
fi

rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# macOS iconset canonical names: icon_<pt>x<pt>[@2x].png
# pt sizes 16 32 128 256 512; @2x doubles the pixel size.
node - "$SVG" "$ICONSET" <<'EOF'
const path = require("node:path");
const sharp = require(path.resolve("memory-server/node_modules/sharp"));
const [svg, iconset] = process.argv.slice(2);
const targets = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];
(async () => {
  for (const [name, px] of targets) {
    await sharp(svg, { density: Math.max(72, (px / 1024) * 72 * 8) })
      .resize(px, px)
      .png()
      .toFile(path.join(iconset, name));
  }
  // Dev dock icon (app.dock.setIcon wants an image file).
  await sharp(svg, { density: 288 }).resize(512, 512).png().toFile("assets/icon-512.png");

  // assets/Solenta.ico — Windows has no Info.plist, so BrowserWindow({icon})
  // reads this file directly. An .ico is a 6-byte header, one 16-byte entry
  // per size, then the images; Vista+ accepts PNG payloads verbatim, so no
  // BMP/DIB encoding is needed. 256 is the format's max dimension.
  // ponytail: hand-rolled container instead of an ico encoder dep; it is
  // 20 lines and the format has not moved since 2007.
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(
    icoSizes.map((px) =>
      sharp(svg, { density: Math.max(72, (px / 1024) * 72 * 8) })
        .resize(px, px)
        .png()
        .toBuffer(),
    ),
  );
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(icoSizes.length, 4);
  let offset = 6 + 16 * icoSizes.length;
  const entries = icoSizes.map((px, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(px === 256 ? 0 : px, 0); // 0 means 256
    e.writeUInt8(px === 256 ? 0 : px, 1);
    e.writeUInt8(0, 2); // palette colors
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return e;
  });
  require("node:fs").writeFileSync(
    "assets/Solenta.ico",
    Buffer.concat([header, ...entries, ...pngs]),
  );

  console.log(
    "rasterized",
    targets.length,
    "sizes + icon-512.png + Solenta.ico (" + icoSizes.join(",") + ")",
  );
})().catch((e) => {
  console.error("rasterize failed:", e.message);
  process.exit(1);
});
EOF

iconutil -c icns "$ICONSET" -o "$ICNS"
echo "wrote $ICNS ($(du -h "$ICNS" | cut -f1)) and assets/icon-512.png"
