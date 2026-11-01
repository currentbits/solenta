#!/usr/bin/env bash
# package-server.sh: the headless Solenta server (#1829) as self-contained
# archives, one per target, for SSH provisioning on computers with no
# Solenta installed. No Electron: electron/server/index.js boots main.js
# behind a stand-in electron module, on a pinned official Node runtime.
#
#   out/solenta-server-<version>-<os>-<arch>.tar.gz   (+ .sha256)
#
# Layout inside: solenta-server/{bin/node, bin/solenta-server, app/...}.
# Native payload per target: the Node binary, @lydell/node-pty's prebuild,
# and memory-server's deps (sharp, onnxruntime-node) via npm ci --os --cpu.
#
# Usage:
#   bash scripts/package-server.sh                  # all four targets
#   bash scripts/package-server.sh linux-x64        # one target
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE_VERSION="24.22.2"
VERSION="$(node -p "require('./package.json').version")"
PTY_VER="$(node -p "require('./node_modules/@lydell/node-pty/package.json').version")"
CACHE="out/.server-cache"
TARGETS=("$@")
[[ ${#TARGETS[@]} -gt 0 ]] || TARGETS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64)

mkdir -p "$CACHE"
[[ -f dist/index.html ]] || npx vite build
[[ -f core/dist/index.js ]] || (cd core && npm run build)

# Shared app payload: same file set as the desktop bundle (package-cross.sh).
PAYLOAD="out/.server-payload"
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD/electron" "$PAYLOAD/core" "$PAYLOAD/native" "$PAYLOAD/memory-server" "$PAYLOAD/node_modules"
rsync -a --prune-empty-dirs --exclude='/test/' --include='*/' --include='*.js' --exclude='*' electron/ "$PAYLOAD/electron/"
cp package.json "$PAYLOAD/package.json"
cp -R dist "$PAYLOAD/dist"
cp -R core/dist "$PAYLOAD/core/dist"
cp core/package.json "$PAYLOAD/core/package.json"
cp -R native/ios-simulator-helper "$PAYLOAD/native/ios-simulator-helper"
cp -R memory-server/src "$PAYLOAD/memory-server/src"
cp memory-server/package.json memory-server/package-lock.json "$PAYLOAD/memory-server/"
ROOT_NM_PKGS=(ws cross-spawn path-key shebang-command shebang-regex which isexe yauzl pend qrcode-generator @lydell/node-pty pdfjs-dist)
for pkg in "${ROOT_NM_PKGS[@]}"; do
  [[ -d "node_modules/$pkg" ]] || { echo "ERROR: node_modules/$pkg missing; npm install" >&2; exit 1; }
  mkdir -p "$(dirname "$PAYLOAD/node_modules/$pkg")"
  cp -R "node_modules/$pkg" "$PAYLOAD/node_modules/$pkg"
done
PDFJS_DIR="$PAYLOAD/node_modules/pdfjs-dist"
find "$PDFJS_DIR" -mindepth 1 -maxdepth 1 ! -name package.json ! -name legacy -exec rm -rf {} +
find "$PDFJS_DIR/legacy" -mindepth 1 -maxdepth 1 ! -name build -exec rm -rf {} +
find "$PDFJS_DIR/legacy/build" -type f ! -name pdf.min.mjs ! -name pdf.worker.min.mjs -delete

# Official Node, checked against nodejs.org's SHASUMS256.
SUMS="$CACHE/SHASUMS256-$NODE_VERSION.txt"
[[ -f "$SUMS" ]] || curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$SUMS"

for target in "${TARGETS[@]}"; do
  os="${target%-*}"; cpu="${target#*-}"
  case "$target" in darwin-arm64|darwin-x64|linux-x64|linux-arm64) ;; *) echo "ERROR: unknown target $target" >&2; exit 1 ;; esac
  echo "[$target] staging..."
  STAGE="out/.server-stage-$target/solenta-server"
  rm -rf "$(dirname "$STAGE")"
  mkdir -p "$STAGE/bin"
  cp -R "$PAYLOAD" "$STAGE/app"

  node_tar="node-v$NODE_VERSION-$os-$cpu.tar.gz"
  if [[ ! -f "$CACHE/$node_tar" ]]; then
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$node_tar" -o "$CACHE/$node_tar.part"
    mv "$CACHE/$node_tar.part" "$CACHE/$node_tar"
  fi
  want="$(grep " $node_tar\$" "$SUMS" | cut -d' ' -f1)"
  got="$(shasum -a 256 "$CACHE/$node_tar" | cut -d' ' -f1)"
  [[ -n "$want" && "$want" == "$got" ]] || { echo "ERROR: $node_tar checksum mismatch" >&2; rm -f "$CACHE/$node_tar"; exit 1; }
  tar -xzf "$CACHE/$node_tar" -C "$CACHE" "node-v$NODE_VERSION-$os-$cpu/bin/node"
  cp "$CACHE/node-v$NODE_VERSION-$os-$cpu/bin/node" "$STAGE/bin/node"

  cat > "$STAGE/bin/solenta-server" <<'SH'
#!/bin/sh
here="$(cd "$(dirname "$0")" && pwd)"
exec "$here/node" "$here/../app/electron/server/index.js" "$@"
SH
  chmod +x "$STAGE/bin/solenta-server" "$STAGE/bin/node"

  # This target's node-pty prebuild, at the wrapper's exact version.
  pty_pkg="node-pty-$os-$cpu"
  pty_tgz="$CACHE/lydell-$pty_pkg-$PTY_VER.tgz"
  [[ -f "$pty_tgz" ]] || (cd "$CACHE" && npm pack --silent "@lydell/$pty_pkg@$PTY_VER" >/dev/null)
  mkdir -p "$STAGE/app/node_modules/@lydell/$pty_pkg"
  tar -xzf "$pty_tgz" -C "$STAGE/app/node_modules/@lydell/$pty_pkg" --strip-components=1

  echo "[$target] installing memory-server deps ($os/$cpu)..."
  LIBC=()
  [[ "$os" == linux ]] && LIBC=(--libc=glibc)
  (cd "$STAGE/app/memory-server" && npm ci --omit=dev --no-audit --no-fund --os="$os" --cpu="$cpu" ${LIBC[@]+"${LIBC[@]}"} --loglevel=error)
  rm -rf "$STAGE/app/memory-server/node_modules/onnxruntime-web"
  # onnxruntime-node ships every platform; keep this target's.
  ORT_BIN="$STAGE/app/memory-server/node_modules/onnxruntime-node/bin/napi-v3"
  if [[ -d "$ORT_BIN" ]]; then
    find "$ORT_BIN" -mindepth 1 -maxdepth 1 -type d ! -name "$os" -exec rm -rf {} +
    [[ -d "$ORT_BIN/$os" ]] && find "$ORT_BIN/$os" -mindepth 1 -maxdepth 1 -type d ! -name "$cpu" -exec rm -rf {} +
  fi

  archive="out/solenta-server-$VERSION-$target.tar.gz"
  # No AppleDouble/xattr headers: GNU tar on the remote warns on every file.
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$archive" -C "$(dirname "$STAGE")" solenta-server
  shasum -a 256 "$archive" | cut -d' ' -f1 > "$archive.sha256"
  echo "[$target] $archive ($(du -h "$archive" | cut -f1))"
  rm -rf "$(dirname "$STAGE")"
done
rm -rf "$PAYLOAD"
