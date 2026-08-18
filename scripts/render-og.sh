#!/usr/bin/env bash
# Render site/og-card.html to site/assets/og.png at 1200x630.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/site/assets/og.png"
html="file://$root/site/og-card.html"
# Brave headless hangs on this machine; Firefox --screenshot is reliable.
browser="/Applications/Firefox.app/Contents/MacOS/firefox"

if [[ ! -x "$browser" ]]; then
  echo "Firefox not found at $browser" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

"$browser" \
  --headless \
  --profile "$tmpdir" \
  --screenshot "$out" \
  --window-size=1200,630 \
  "$html"

# Confirm size. sips is on every macOS box.
if command -v sips >/dev/null; then
  sips -g pixelWidth -g pixelHeight "$out"
fi
# Public share URL is card.png — a new filename busts crawler image caches.
# Keep og.png as the render target so older links still resolve.
cp "$out" "$root/site/assets/card.png"
ls -lh "$out" "$root/site/assets/card.png"
echo "wrote $out and site/assets/card.png"
