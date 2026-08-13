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

TARGETS=("$@")
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=(linux-x64 win32-x64)
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

cat > "$PAYLOAD/package.json" <<EOF
{
  "name": "solenta",
  "productName": "Solenta",
  "version": "${VERSION}",
  "main": "electron/main.js",
  "buildSha": "${BUILD_SHA}",
  "buildTime": "${BUILD_TIME}"
}
EOF

mkdir -p "$PAYLOAD/electron"
for f in electron/*.js; do
  cp "$f" "$PAYLOAD/electron/"
done

mkdir -p "$PAYLOAD/node_modules"
rm -rf "$PAYLOAD/node_modules/ws"
cp -R node_modules/ws "$PAYLOAD/node_modules/ws"

cp -R dist "$PAYLOAD/dist"
if [[ -d "$PAYLOAD/dist/dist" ]] || ! diff -qr dist "$PAYLOAD/dist" >/dev/null; then
  echo "ERROR: payload dist does not match the freshly built dist/" >&2
  exit 1
fi

mkdir -p "$PAYLOAD/core"
cp -R core/dist "$PAYLOAD/core/dist"
cp core/package.json "$PAYLOAD/core/package.json"

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
  TOP="$WORK/solenta"
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
  (cd "$APP_DIR/memory-server" && npm ci --omit=dev --no-audit --no-fund --os="$os" --cpu="$cpu" "${LIBC_FLAG[@]}" --loglevel=error)

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
    mv "$BIN_DIR/electron.exe" "$BIN_DIR/solenta.exe"
    ARCHIVE="out/Solenta-${VERSION}-win32-x64.zip"
    rm -f "$ARCHIVE"
    (cd "$WORK" && zip -q -r -X "$ROOT/$ARCHIVE" solenta)
  else
    mv "$BIN_DIR/electron" "$BIN_DIR/solenta"
    chmod +x "$BIN_DIR/solenta"
    ARCHIVE="out/Solenta-${VERSION}-linux-x64.tar.gz"
    rm -f "$ARCHIVE"
    tar -czf "$ARCHIVE" -C "$WORK" solenta
  fi

  # Structural sanity: binary + payload markers must exist in the work tree.
  [[ -f "$APP_DIR/electron/main.js" && -f "$APP_DIR/dist/index.html" ]] || {
    echo "ERROR: [$target] payload incomplete" >&2; exit 1;
  }
  [[ -d "$MS_NM/ws" || -d "$APP_DIR/node_modules/ws" ]] || {
    echo "ERROR: [$target] ws missing" >&2; exit 1;
  }

  SIZE="$(du -sh "$ARCHIVE" | awk '{print $1}')"
  echo "[$target] packaged: $ARCHIVE ($SIZE)"
  rm -rf "$WORK"
done

rm -rf "$(dirname "$PAYLOAD")"
echo "cross packaging done (unsigned, unverified archives — see header)"
