#!/usr/bin/env bash
# package-app.sh — dependency-free macOS packaging for Coder.
# Assembles a double-clickable out/Coder.app by dropping the app into a stock
# Electron.app (no electron-builder / electron-packager; npm blocks native
# postinstalls on this machine).
#
# Usage:
#   bash scripts/package-app.sh           # package + verify
#   bash scripts/package-app.sh --no-verify
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NO_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --no-verify) NO_VERIFY=1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

# ALWAYS rebuild the renderer. Reusing an existing dist/ is how a bundle ships
# with an old UI while the stamp below says otherwise: the sha comes from git,
# not from the artifacts, so a stale dist produces a build stamp that LIES.
# That defeats the whole point of stamping, which exists to make a stale bundle
# identifiable. Costs a few seconds; buys a bundle that matches its label.
echo "building renderer (dist/)..."
npx vite build

# Same reasoning for core: rebuild rather than trusting whatever is on disk.
echo "building core..."
(cd core && npm run build)

ELECTRON_APP="node_modules/electron/dist/Electron.app"
if [[ ! -d "$ELECTRON_APP/Contents/Frameworks" ]]; then
  cat <<'EOF' >&2
ERROR: Electron.app is a stub (missing Contents/Frameworks).
npm allow-scripts can skip Electron postinstall on this machine.

Repair from the cached zip (match version to node_modules/electron/package.json):

  ditto -x -k ~/Library/Caches/electron/*/electron-v*-darwin-arm64.zip \
    node_modules/electron/dist
  printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt

See README.md "Electron binary on this machine".
EOF
  exit 1
fi

if [[ ! -d memory-server/node_modules ]]; then
  echo "memory-server/node_modules missing; installing..."
  (cd memory-server && npm install)
fi

VERSION="$(node -p "require('./package.json').version")"
echo "Packaging Coder v${VERSION}..."

# ---------------------------------------------------------------------------
# Assemble out/Coder.app (idempotent)
# ---------------------------------------------------------------------------

rm -rf out/Coder.app
mkdir -p out
cp -R "$ELECTRON_APP" out/Coder.app

APP_DIR="out/Coder.app/Contents/Resources/app"
mkdir -p "$APP_DIR"

# Minimal package.json for the embedded app.
# IMPORTANT: "name" must remain exactly "coder". Electron derives the userData
# directory from package.json name; keeping it "coder" preserves continuity
# with dev sessions (same ~/Library/Application Support/coder). Never change it.
# Stamp the source commit so a running app can be told apart from the tree it
# was built from. A stale bundle silently missing recent fixes is otherwise
# indistinguishable from a broken feature.
BUILD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_DIRTY=""
git diff --quiet 2>/dev/null || BUILD_DIRTY="+dirty"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$APP_DIR/package.json" <<EOF
{
  "name": "coder",
  "productName": "Coder",
  "version": "${VERSION}",
  "main": "electron/main.js",
  "buildSha": "${BUILD_SHA}${BUILD_DIRTY}",
  "buildTime": "${BUILD_TIME}"
}
EOF

# Assert name stayed "coder" (userData continuity).
PKG_NAME="$(node -p "require('./${APP_DIR}/package.json').name")"
if [[ "$PKG_NAME" != "coder" ]]; then
  echo "ERROR: packaged package.json name must be exactly 'coder' (got: $PKG_NAME)" >&2
  exit 1
fi

# electron/ .js sources only (no tests). web.js lives at this level so this
# loop ships the Coder Web server; a subdirectory would be silently dropped.
mkdir -p "$APP_DIR/electron"
for f in electron/*.js; do
  cp "$f" "$APP_DIR/electron/"
done

# Root node_modules is NOT copied into the bundle (only memory-server's is).
# electron/web.js `require("ws")` therefore needs an explicit copy. ws 8.x is
# pure JS (no native addon, no transitive deps).
if [[ ! -d node_modules/ws ]]; then
  echo "ERROR: node_modules/ws missing; npm install (ws is a production dep)" >&2
  exit 1
fi
mkdir -p "$APP_DIR/node_modules"
rm -rf "$APP_DIR/node_modules/ws"
cp -R node_modules/ws "$APP_DIR/node_modules/ws"
echo "packaged node_modules: ws"

# vite build output
cp -R dist "$APP_DIR/dist"

# core/dist + core/package.json — main.js resolves:
#   path.join(__dirname, "../core/dist/index.js")  (electron/ -> app root)
# and dynamic-import of that file. Layout mirrors repo root relative to electron/.
mkdir -p "$APP_DIR/core"
cp -R core/dist "$APP_DIR/core/dist"
cp core/package.json "$APP_DIR/core/package.json"

# memory-server: src + package.json + node_modules (for the SDK + embedder).
# Supervisor resolves: path.join(appPath, "memory-server", "src", "index.js")
# where appPath is app.getAppPath() when packaged (= Resources/app).
mkdir -p "$APP_DIR/memory-server"
cp -R memory-server/src "$APP_DIR/memory-server/src"
cp memory-server/package.json "$APP_DIR/memory-server/package.json"
cp -R memory-server/node_modules "$APP_DIR/memory-server/node_modules"

# Prune packaged tree ONLY (never source node_modules). Drop onnxruntime-web
# (browser WASM, ~91MB, unreachable in a Node process). Keep sharp and @img:
# @huggingface/transformers statically imports sharp from its Node entrypoint;
# removing them makes the package unimportable and embed() returns null forever.
# Keep onnxruntime-node for the cpu q8 feature-extraction path.
PKG_MS_NM="$APP_DIR/memory-server/node_modules"
PRUNED=()
for name in onnxruntime-web; do
  target="$PKG_MS_NM/$name"
  if [[ -e "$target" ]]; then
    rm -rf "$target"
    PRUNED+=("$name")
  fi
done
if [[ ${#PRUNED[@]} -gt 0 ]]; then
  echo "pruned packaged memory-server/node_modules: ${PRUNED[*]}"
else
  echo "pruned packaged memory-server/node_modules: (nothing matched)"
fi

# ---------------------------------------------------------------------------
# Branding via Info.plist (no custom icon this round)
# Rename the MacOS binary Electron -> Coder so app.isPackaged is true.
# Electron treats an executable still named "Electron" as unpackaged, which
# would load the vite dev URL instead of dist/.
# ---------------------------------------------------------------------------

PLIST="out/Coder.app/Contents/Info.plist"
MACOS_DIR="out/Coder.app/Contents/MacOS"
if [[ -f "$MACOS_DIR/Electron" ]]; then
  mv "$MACOS_DIR/Electron" "$MACOS_DIR/Coder"
fi
if [[ -f "$PLIST" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Coder" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleName string Coder" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Coder" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Coder" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.willem.coder" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.willem.coder" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable Coder" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string Coder" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile Coder" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string Coder" "$PLIST"
else
  echo "WARNING: Info.plist missing at $PLIST" >&2
fi

# ---------------------------------------------------------------------------
# App icon (regenerate when missing, then bundle)
# ---------------------------------------------------------------------------
if [[ ! -f assets/Coder.icns ]]; then
  bash scripts/make-icon.sh
fi
cp assets/Coder.icns "out/Coder.app/Contents/Resources/Coder.icns"
echo "icon: Contents/Resources/Coder.icns"

# ---------------------------------------------------------------------------
# Report size
# ---------------------------------------------------------------------------

APP_PATH="$ROOT/out/Coder.app"
SIZE="$(du -sh "$APP_PATH" | awk '{print $1}')"
echo "Packaged: $APP_PATH ($SIZE)"

# ---------------------------------------------------------------------------
# Optional verify
# ---------------------------------------------------------------------------

if [[ "$NO_VERIFY" -eq 0 ]]; then
  bash "$ROOT/scripts/verify-package.sh"
fi
