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
ls -lh "$out"
echo "wrote $out"
