#!/usr/bin/env bash
# Generate assets/Coder.icns (and assets/icon-512.png for the dev dock icon)
# from assets/icon.svg. Zero new dependencies: rasterizes with the sharp that
# already ships in memory-server/node_modules, converts with macOS iconutil.
# Idempotent: safe to re-run; outputs are overwritten.
set -euo pipefail
cd "$(dirname "$0")/.."

SVG="assets/icon.svg"
ICONSET="assets/Coder.iconset"
ICNS="assets/Coder.icns"
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
  console.log("rasterized", targets.length, "sizes + icon-512.png");
})().catch((e) => {
  console.error("rasterize failed:", e.message);
  process.exit(1);
});
EOF

iconutil -c icns "$ICONSET" -o "$ICNS"
echo "wrote $ICNS ($(du -h "$ICNS" | cut -f1)) and assets/icon-512.png"
