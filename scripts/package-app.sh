#!/usr/bin/env bash
# package-app.sh — dependency-free macOS packaging for Solenta.
# Assembles a double-clickable out/Solenta.app ("Solenta Nightly.app" on
# --channel nightly) by dropping the app into a stock
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
# Update channel + release tag stamped into the bundle. A bundle without a
# releaseTag (default: any local build) never auto-updates, so install-swap
# bundles built from a working tree are left alone. publish-release.sh sets
# both.
CHANNEL="prod"
RELEASE_TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-verify) NO_VERIFY=1 ;;
    --channel) CHANNEL="$2"; shift ;;
    --tag) RELEASE_TAG="$2"; shift ;;
  esac
  shift
done
if [[ "$CHANNEL" != "prod" && "$CHANNEL" != "nightly" ]]; then
  echo "ERROR: --channel must be prod or nightly (got: $CHANNEL)" >&2
  exit 1
fi

# Nightly ships under its own bundle name + identifier so a prod install and a
# nightly install are tellable apart in Finder, the Dock and the app switcher.
# ONLY the outside changes: the embedded productName stays "Solenta" because
# userData derives from it (~/Library/Application Support/Solenta) — renaming
# it would silently strand every existing install's store.
APP_NAME="Solenta"
BUNDLE_ID="com.willem.solenta"
if [[ "$CHANNEL" == "nightly" ]]; then
  APP_NAME="Solenta Nightly"
  BUNDLE_ID="com.willem.solenta.nightly"
fi
APP_BUNDLE="out/${APP_NAME}.app"

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
echo "Packaging ${APP_NAME} v${VERSION} (${CHANNEL})..."

# ---------------------------------------------------------------------------
# Assemble the .app (idempotent)
# ---------------------------------------------------------------------------

rm -rf "$APP_BUNDLE"
mkdir -p out
cp -R "$ELECTRON_APP" "$APP_BUNDLE"

# The stock Electron.app can carry a stale Resources/app from an earlier
# mishap. With it in place, `cp -R dist "$APP_DIR/dist"` below nests the fresh
# bundle as dist/dist and the app silently ships the OLD UI while the build
# stamp claims otherwise. Always start from a clean slate.
rm -rf "$APP_BUNDLE/Contents/Resources/app"

APP_DIR="$APP_BUNDLE/Contents/Resources/app"
mkdir -p "$APP_DIR"

# Minimal package.json for the embedded app.
# The userData directory derives from this name (~/Library/Application
# Support/solenta); main.js migrates a legacy "coder" userData directory on
# first boot, so existing installs keep their data. Keep the name "solenta".
# Stamp the source commit so a running app can be told apart from the tree it
# was built from. A stale bundle silently missing recent fixes is otherwise
# indistinguishable from a broken feature.
BUILD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_DIRTY=""
git diff --quiet 2>/dev/null || BUILD_DIRTY="+dirty"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

RELEASE_TAG_JSON="null"
if [[ -n "$RELEASE_TAG" ]]; then
  RELEASE_TAG_JSON="\"${RELEASE_TAG}\""
fi

cat > "$APP_DIR/package.json" <<EOF
{
  "name": "solenta",
  "productName": "Solenta",
  "version": "${VERSION}",
  "main": "electron/main.js",
  "buildSha": "${BUILD_SHA}${BUILD_DIRTY}",
  "buildTime": "${BUILD_TIME}",
  "channel": "${CHANNEL}",
  "releaseTag": ${RELEASE_TAG_JSON}
}
EOF

# Assert name stayed "solenta" (the userData migration keys on it).
PKG_NAME="$(node -p "require('./${APP_DIR}/package.json').name")"
if [[ "$PKG_NAME" != "solenta" ]]; then
  echo "ERROR: packaged package.json name must be exactly 'solenta' (got: $PKG_NAME)" >&2
  exit 1
fi

# electron/ .js sources only (no tests). webBridge.js + webServer.js live at
# this level so this loop ships them; a subdirectory would be silently dropped.
mkdir -p "$APP_DIR/electron"
for f in electron/*.js; do
  cp "$f" "$APP_DIR/electron/"
done

# Root node_modules is NOT copied into the bundle (only memory-server's is).
# electron/webBridge.js `require("ws")`, the provider spawn path
# `require("cross-spawn")`, and skillPackages.js `require("yauzl")` (pulled
# in at boot via mcpImports -> ipc -> main) therefore need explicit copies.
# All three trees are pure JS (no native addon). Production transitives
# must come too: a missing nested require dies at load (Electron dialog,
# never reaches whenReady). electron/test/package-deps.test.js owns the list.
ROOT_NM_PKGS=(ws cross-spawn path-key shebang-command shebang-regex which isexe yauzl pend)
mkdir -p "$APP_DIR/node_modules"
for pkg in "${ROOT_NM_PKGS[@]}"; do
  if [[ ! -d "node_modules/$pkg" ]]; then
    echo "ERROR: node_modules/$pkg missing; npm install ($pkg is a production dep)" >&2
    exit 1
  fi
  rm -rf "$APP_DIR/node_modules/$pkg"
  cp -R "node_modules/$pkg" "$APP_DIR/node_modules/$pkg"
done
echo "packaged node_modules: ${ROOT_NM_PKGS[*]}"

# vite build output
cp -R dist "$APP_DIR/dist"
# The packaged dist must be byte-identical to the one just built; a stale or
# nested copy is exactly the "old UI in a new-stamped app" failure mode.
if [[ -d "$APP_DIR/dist/dist" ]] || ! diff -qr dist "$APP_DIR/dist" >/dev/null; then
  echo "ERROR: packaged dist does not match the freshly built dist/" >&2
  exit 1
fi

# core/dist + core/package.json — main.js resolves:
#   path.join(__dirname, "../core/dist/index.js")  (electron/ -> app root)
# and dynamic-import of that file. Layout mirrors repo root relative to electron/.
mkdir -p "$APP_DIR/core"
cp -R core/dist "$APP_DIR/core/dist"
cp core/package.json "$APP_DIR/core/package.json"

# iOS simulator helper sources — electron/ios-simulator-protocol.js requires
# ../native/ios-simulator-helper/protocol.json at module load, and the
# toolchain builds the Swift helper from this tree at runtime.
mkdir -p "$APP_DIR/native"
cp -R native/ios-simulator-helper "$APP_DIR/native/ios-simulator-helper"

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
# Rename the MacOS binary Electron -> Solenta so app.isPackaged is true.
# Electron treats an executable still named "Electron" as unpackaged, which
# would load the vite dev URL instead of dist/.
# ---------------------------------------------------------------------------

PLIST="$APP_BUNDLE/Contents/Info.plist"
MACOS_DIR="$APP_BUNDLE/Contents/MacOS"
if [[ -f "$MACOS_DIR/Electron" ]]; then
  mv "$MACOS_DIR/Electron" "$MACOS_DIR/$APP_NAME"
fi
if [[ -f "$PLIST" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleName ${APP_NAME}" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleName string ${APP_NAME}" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName ${APP_NAME}" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string ${APP_NAME}" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${BUNDLE_ID}" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string ${BUNDLE_ID}" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable ${APP_NAME}" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string ${APP_NAME}" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile Solenta" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string Solenta" "$PLIST"
else
  echo "WARNING: Info.plist missing at $PLIST" >&2
fi

# ---------------------------------------------------------------------------
# App icon (regenerate when missing, then bundle)
# ---------------------------------------------------------------------------
if [[ ! -f assets/Solenta.icns ]]; then
  bash scripts/make-icon.sh
fi
cp assets/Solenta.icns "$APP_BUNDLE/Contents/Resources/Solenta.icns"
echo "icon: Contents/Resources/Solenta.icns"

# ---------------------------------------------------------------------------
# Code signing (Developer ID + hardened runtime)
# ---------------------------------------------------------------------------
# Last mutation of the bundle: codesign seals the tree, so anything that edits
# a file after this point invalidates the signature.
#
# Notarization only runs for tagged builds (publish-release.sh passes --tag).
# It is a multi-minute round trip to Apple, and a local install-swap bundle
# never leaves this machine — where the signature alone is enough. Releases go
# to other people's Macs, where an un-stapled bundle is still Gatekeeper-blocked.
CODESIGN_ARGS=()
if [[ -n "$RELEASE_TAG" ]]; then
  CODESIGN_ARGS+=(--notarize)
fi
bash "$ROOT/scripts/codesign-app.sh" "$APP_BUNDLE" ${CODESIGN_ARGS[@]+"${CODESIGN_ARGS[@]}"}

# ---------------------------------------------------------------------------
# Report size
# ---------------------------------------------------------------------------

APP_PATH="$ROOT/$APP_BUNDLE"
SIZE="$(du -sh "$APP_PATH" | awk '{print $1}')"
echo "Packaged: $APP_PATH ($SIZE)"

# ---------------------------------------------------------------------------
# Optional verify
# ---------------------------------------------------------------------------

if [[ "$NO_VERIFY" -eq 0 ]]; then
  bash "$ROOT/scripts/verify-package.sh" "$APP_BUNDLE"
fi
