#!/usr/bin/env bash
# package-cross.sh — cross-platform packaging for Solenta (linux-x64, win32-x64)
# built FROM macOS. Complements package-app.sh (macOS .app); produces plain
# archives, not installers:
#
#   out/Solenta-<version>-linux-x64.tar.gz
#   out/Solenta-<version>-win32-x64.zip
#
# Method: download the stock Electron zip per target, drop our app payload
# into resources/app, rename the binary so app.isPackaged is true. The only
# platform-specific payload is memory-server/node_modules: sharp ships
# per-platform optional deps, so it is re-installed per target with
# `npm ci --os --cpu`. onnxruntime-node ships every platform in one package;
# the non-target bin dirs are pruned.
#
# LIMITS: artifacts are unsigned and UNVERIFIED — unlike package-app.sh there
# is no boot probe, because linux/win binaries cannot run on this Mac.
#
# Branding on Windows takes two separate stamps and needs both:
#   - the RUNNING window/taskbar icon comes from electron/main.js reading
#     assets/Solenta.ico at BrowserWindow time;
#   - Explorer, desktop shortcuts and a pinned (not-running) taskbar button
#     read the icon compiled into the .exe, done below by set-win-icon.js.
#
# This zip is a portable Electron tree, not an installer. winget publishes
# an installer (or a signed portable with a publisher identity). Do not add
# a winget manifest that points at this unsigned archive — that is worse
# than nothing. #397 / #437. What a real Windows packaging story takes:
# Authenticode signing, then either submit this zip as installerType:
# portable or add NSIS/WiX (electron-builder is a product decision; this
# repo avoids it because npm blocks native postinstalls). There is no
# node-pty in the repo, so a ConPTY rebuild CI step would be a no-op.
#
# Usage:
#   bash scripts/package-cross.sh                # both targets
#   bash scripts/package-cross.sh linux-x64      # one target
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
ELECTRON_VER="$(node -p "require('electron/package.json').version")"
CACHE="out/.electron-cache"
BUILD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
git diff --quiet 2>/dev/null || BUILD_SHA="${BUILD_SHA}+dirty"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Same channel/tag stamps as package-app.sh: no releaseTag -> the bundle
# never auto-updates (win/linux builds only surface the release URL anyway).
CHANNEL="prod"
RELEASE_TAG=""
TARGETS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift ;;
    --tag) RELEASE_TAG="$2"; shift ;;
    *) TARGETS+=("$1") ;;
  esac
  shift
done
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=(linux-x64 win32-x64)
fi
if [[ "$CHANNEL" != "prod" && "$CHANNEL" != "nightly" ]]; then
  echo "ERROR: --channel must be prod or nightly (got: $CHANNEL)" >&2
  exit 1
fi

# Launcher + top-level folder name. Nightly gets its own so an unpacked
# nightly can sit next to a prod one. productName below stays "Solenta" on
# both channels: userData derives from it and renaming strands the store.
SLUG="solenta"
DISPLAY_NAME="Solenta"
if [[ "$CHANNEL" == "nightly" ]]; then
  SLUG="solenta-nightly"
  DISPLAY_NAME="Solenta Nightly"
fi

# The .exe icon/version stamp needs resedit (pure JS PE resource editor; the
# usual tool, rcedit, is a Windows binary and cannot run on this host). Fail
# now rather than after a multi-minute build.
if [[ " ${TARGETS[*]} " == *" win32-x64 "* && ! -d node_modules/resedit ]]; then
  echo "ERROR: node_modules/resedit missing; npm install (win32 .exe icon stamp)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Fresh builds (same reasoning as package-app.sh: never ship a stale dist).
# ---------------------------------------------------------------------------
echo "building renderer (dist/)..."
npx vite build
echo "building core..."
(cd core && npm run build)

# ---------------------------------------------------------------------------
# Shared payload (everything except memory-server/node_modules, which is
# per-target). Staged once, copied into each Electron tree.
# ---------------------------------------------------------------------------
PAYLOAD="$(mktemp -d "${TMPDIR:-/tmp}/solenta-cross-payload.XXXXXX")/app"
mkdir -p "$PAYLOAD"

RELEASE_TAG_JSON="null"
if [[ -n "$RELEASE_TAG" ]]; then
  RELEASE_TAG_JSON="\"${RELEASE_TAG}\""
fi

cat > "$PAYLOAD/package.json" <<EOF
{
  "name": "solenta",
  "productName": "Solenta",
  "version": "${VERSION}",
  "main": "electron/main.js",
  "buildSha": "${BUILD_SHA}",
  "buildTime": "${BUILD_TIME}",
  "channel": "${CHANNEL}",
  "releaseTag": ${RELEASE_TAG_JSON}
}
EOF

mkdir -p "$PAYLOAD/electron"
for f in electron/*.js; do
  cp "$f" "$PAYLOAD/electron/"
done

# Same explicit root deps as package-app.sh (ws + cross-spawn tree).
ROOT_NM_PKGS=(ws cross-spawn path-key shebang-command shebang-regex which isexe)
mkdir -p "$PAYLOAD/node_modules"
for pkg in "${ROOT_NM_PKGS[@]}"; do
  if [[ ! -d "node_modules/$pkg" ]]; then
    echo "ERROR: node_modules/$pkg missing; npm install ($pkg is a production dep)" >&2
    exit 1
  fi
  rm -rf "$PAYLOAD/node_modules/$pkg"
  cp -R "node_modules/$pkg" "$PAYLOAD/node_modules/$pkg"
done

cp -R dist "$PAYLOAD/dist"
if [[ -d "$PAYLOAD/dist/dist" ]] || ! diff -qr dist "$PAYLOAD/dist" >/dev/null; then
  echo "ERROR: payload dist does not match the freshly built dist/" >&2
  exit 1
fi

mkdir -p "$PAYLOAD/core"
cp -R core/dist "$PAYLOAD/core/dist"
cp core/package.json "$PAYLOAD/core/package.json"

# App icon. Windows/Linux have no Info.plist, so electron/main.js sets the
# window icon from these files at runtime; without them the Windows taskbar
# falls back to the icon embedded in electron.exe (the stock Electron logo).
if [[ ! -f assets/Solenta.ico ]]; then
  bash scripts/make-icon.sh
fi
mkdir -p "$PAYLOAD/assets"
cp assets/Solenta.ico assets/icon-512.png "$PAYLOAD/assets/"

mkdir -p "$PAYLOAD/memory-server"
cp -R memory-server/src "$PAYLOAD/memory-server/src"
cp memory-server/package.json "$PAYLOAD/memory-server/package.json"
cp memory-server/package-lock.json "$PAYLOAD/memory-server/package-lock.json"

echo "payload staged: $PAYLOAD"

# ---------------------------------------------------------------------------
# Per-target assembly
# ---------------------------------------------------------------------------
for target in "${TARGETS[@]}"; do
  os="${target%%-*}"   # linux | win32
  cpu="${target##*-}"  # x64
  zip_name="electron-v${ELECTRON_VER}-${os}-${cpu}.zip"
  zip_url="https://github.com/electron/electron/releases/download/v${ELECTRON_VER}/${zip_name}"
  cached="$CACHE/$zip_name"

  mkdir -p "$CACHE"
  if [[ ! -f "$cached" ]]; then
    echo "downloading $zip_url"
    curl -fL --retry 3 -o "$cached" "$zip_url"
  fi

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/solenta-cross-${target}.XXXXXX")"
  # bsdtar has no --transform, so the top-level "solenta/" folder is real.
  TOP="$WORK/$SLUG"
  mkdir -p "$TOP"
  unzip -q "$cached" -d "$TOP"

  # Stock zip layout: binary + resources/ at top level for both linux & win32.
  BIN_DIR="$TOP"
  APP_DIR="$TOP/resources/app"
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR"
  cp -R "$PAYLOAD"/. "$APP_DIR/"

  # Per-target memory-server deps (sharp's platform binaries come from
  # optional deps selected by os/cpu; linux sharp also keys on libc, which
  # npm cannot infer when cross-installing from macOS — default to glibc).
  echo "[$target] installing memory-server deps ($os/$cpu)..."
  LIBC_FLAG=()
  if [[ "$os" == "linux" ]]; then
    LIBC_FLAG=(--libc=glibc)
  fi
  # ${arr[@]+...}: bash 3.2 (macOS) treats an empty array as unbound under set -u.
  (cd "$APP_DIR/memory-server" && npm ci --omit=dev --no-audit --no-fund --os="$os" --cpu="$cpu" ${LIBC_FLAG[@]+"${LIBC_FLAG[@]}"} --loglevel=error)

  # Prune: onnxruntime-web (browser WASM, unreachable from Node) and the
  # onnxruntime-node binaries for platforms this archive does not run on.
  MS_NM="$APP_DIR/memory-server/node_modules"
  rm -rf "$MS_NM/onnxruntime-web"
  if [[ -d "$MS_NM/onnxruntime-node/bin/napi-v3" ]]; then
    for platdir in "$MS_NM/onnxruntime-node/bin/napi-v3"/*; do
      plat="$(basename "$platdir")"
      if [[ "$plat" != "$os" ]]; then
        rm -rf "$platdir"
      fi
    done
  fi

  # Rename the binary so Electron treats the app as packaged.
  if [[ "$os" == "win32" ]]; then
    mv "$BIN_DIR/electron.exe" "$BIN_DIR/${SLUG}.exe"
    # Renaming the binary does not touch its resource section: without this
    # the file keeps Electron's icon and "Electron" file properties wherever
    # Windows reads the .exe rather than the running window. Self-verifies.
    node "$ROOT/scripts/set-win-icon.js" \
      "$BIN_DIR/${SLUG}.exe" "$ROOT/assets/Solenta.ico" "$VERSION" "$DISPLAY_NAME"
    ARCHIVE="out/Solenta-${VERSION}-win32-x64.zip"
    rm -f "$ARCHIVE"
    (cd "$WORK" && zip -q -r -X "$ROOT/$ARCHIVE" "$SLUG")
  else
    mv "$BIN_DIR/electron" "$BIN_DIR/$SLUG"
    chmod +x "$BIN_DIR/$SLUG"
    ARCHIVE="out/Solenta-${VERSION}-linux-x64.tar.gz"
    rm -f "$ARCHIVE"
    tar -czf "$ARCHIVE" -C "$WORK" "$SLUG"
  fi

  # Structural sanity: binary + payload markers must exist in the work tree.
  [[ -f "$APP_DIR/electron/main.js" && -f "$APP_DIR/dist/index.html" ]] || {
    echo "ERROR: [$target] payload incomplete" >&2; exit 1;
  }
  [[ -f "$APP_DIR/assets/Solenta.ico" && -f "$APP_DIR/assets/icon-512.png" ]] || {
    echo "ERROR: [$target] app icon missing (taskbar would show Electron's)" >&2; exit 1;
  }
  [[ -d "$MS_NM/ws" || -d "$APP_DIR/node_modules/ws" ]] || {
    echo "ERROR: [$target] ws missing" >&2; exit 1;
  }
  [[ -d "$APP_DIR/node_modules/cross-spawn" ]] || {
    echo "ERROR: [$target] cross-spawn missing" >&2; exit 1;
  }

  SIZE="$(du -sh "$ARCHIVE" | awk '{print $1}')"
  echo "[$target] packaged: $ARCHIVE ($SIZE)"
  rm -rf "$WORK"
done

rm -rf "$(dirname "$PAYLOAD")"
echo "cross packaging done (unsigned, unverified archives — see header)"
