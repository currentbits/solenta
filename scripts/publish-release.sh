#!/usr/bin/env bash
# publish-release.sh — cut a Solenta release the auto-updater can see.
#
#   bash scripts/publish-release.sh prod      # tag v<version>, regular release
#   bash scripts/publish-release.sh nightly   # tag nightly-<utc>-<sha>, prerelease
#
# prod builds update from GET /releases/latest; nightly builds update from the
# newest prerelease. Both compare the release tag against the releaseTag
# stamped into the bundle by package-app.sh / package-cross.sh.
# Assets: macos-arm64 (auto-install), win32-x64 + linux-x64 (updater surfaces
# the release URL only).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHANNEL="${1:-}"
if [[ "$CHANNEL" != "prod" && "$CHANNEL" != "nightly" ]]; then
  echo "usage: publish-release.sh prod|nightly" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: working tree is dirty; releases come from committed code" >&2
  exit 1
fi

SHA="$(git rev-parse --short HEAD)"
VERSION="$(node -p "require('./package.json').version")"
if [[ "$CHANNEL" == "prod" ]]; then
  TAG="v${VERSION}"
else
  TAG="nightly-$(date -u +%Y%m%d%H%M)-${SHA}"
fi

# The release tag must point at a commit GitHub knows about.
if ! git branch -r --contains HEAD | grep -q "origin/"; then
  echo "ERROR: HEAD is not on any origin branch; push first" >&2
  exit 1
fi

bash scripts/package-app.sh --channel "$CHANNEL" --tag "$TAG"
bash scripts/package-cross.sh --channel "$CHANNEL" --tag "$TAG"

ZIP="out/Solenta-${TAG}-macos-arm64.zip"
rm -f "$ZIP"
ditto -c -k --keepParent out/Solenta.app "$ZIP"

# Cross archives come out versioned; name release assets by tag so every
# asset in a release carries the tag the updater compares against.
ASSETS=("$ZIP")
for cross in "linux-x64.tar.gz" "win32-x64.zip"; do
  src="out/Solenta-${VERSION}-${cross}"
  dst="out/Solenta-${TAG}-${cross}"
  if [[ "$src" != "$dst" ]]; then
    mv "$src" "$dst"
  fi
  ASSETS+=("$dst")
done

if [[ "$CHANNEL" == "nightly" ]]; then
  gh release create "$TAG" "${ASSETS[@]}" \
    --prerelease \
    --target "$(git rev-parse HEAD)" \
    --title "Solenta nightly ${TAG#nightly-}" \
    --notes "Nightly build from ${SHA}."
else
  gh release create "$TAG" "${ASSETS[@]}" \
    --target "$(git rev-parse HEAD)" \
    --title "Solenta v${VERSION}" \
    --generate-notes
fi

echo "Published ${TAG} (${CHANNEL})"
