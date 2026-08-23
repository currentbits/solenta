#!/usr/bin/env bash
# codesign-app.sh <bundle> [--notarize] — Developer ID sign (and optionally
# notarize + staple) a packaged Solenta .app. Called by package-app.sh; safe to
# re-run by hand on an existing bundle.
#
# Credentials come from the environment, never from this file:
#   CODESIGN_IDENTITY       full identity string; auto-detected when unset
#   APPLE_KEYCHAIN_PROFILE  notarytool profile (see `notarytool store-credentials`);
#                           falls back to the "solenta" profile when it exists
#   APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD   fallback if no profile
#
# No Developer ID identity in the keychain -> WARN and exit 0, leaving the
# bundle unsigned. Local builds must keep working on a machine without the cert.
# A signing or notarization that was ASKED for and then failed is fatal.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-}"
NOTARIZE=0
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --notarize) NOTARIZE=1 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "usage: codesign-app.sh <bundle.app> [--notarize]" >&2
  exit 1
fi
ENTITLEMENTS="$ROOT/scripts/entitlements.plist"
[[ -f "$ENTITLEMENTS" ]] || { echo "ERROR: missing $ENTITLEMENTS" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------
IDENTITY="${CODESIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  # find-identity prints:  1) <hash> "Developer ID Application: Name (TEAM)"
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
fi
if [[ -z "$IDENTITY" && "$NOTARIZE" -eq 1 ]]; then
  echo "ERROR: --notarize (release build) but no Developer ID Application identity." >&2
  echo "  A release must not ship unsigned: README and the site tell users the" >&2
  echo "  download is signed and notarized. Fix the cert or cut no release." >&2
  exit 1
fi
if [[ -z "$IDENTITY" ]]; then
  cat >&2 <<'EOF'

  ############################################################
  #  WARNING: no "Developer ID Application" identity found.   #
  #  The bundle is UNSIGNED — macOS will quarantine it and    #
  #  users need right-click > Open to launch it.              #
  #                                                           #
  #  Fix: join the Apple Developer Program, then Xcode >      #
  #  Settings > Accounts > Manage Certificates > + Developer  #
  #  ID Application. Or set CODESIGN_IDENTITY explicitly.     #
  ############################################################

EOF
  exit 0
fi
echo "signing identity: $IDENTITY"

# ---------------------------------------------------------------------------
# Sign
# ---------------------------------------------------------------------------
# cp -R carries com.apple.provenance and friends across; codesign rejects a
# bundle with "resource fork, Finder information, or similar detritus".
xattr -cr "$APP"

sign() {
  codesign --force --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$@"
}

# 1. Every nested Mach-O, leaves first. The payload under Resources/app carries
#    native addons (sharp, onnxruntime-node) that signing the outer bundle does
#    NOT cover — notarization rejects each unsigned one by name. `--deep` does
#    not reach them either; it walks bundles, not loose binaries in Resources.
#    Prefilter on name/exec-bit so `file` runs over hundreds, not ~20k, paths.
#    The non-darwin onnxruntime binaries shipped in the same tree are ELF/PE and
#    fall out here, which is what we want — they are unsignable and notarization
#    ignores anything that is not Mach-O.
echo "signing nested binaries..."
NESTED=0
while IFS= read -r -d '' f; do
  case "$(file -b "$f")" in
    *Mach-O*) sign "$f"; NESTED=$((NESTED + 1)) ;;
  esac
done < <(find "$APP/Contents" -type f \
  \( -name "*.dylib" -o -name "*.so" -o -name "*.node" -o -perm -100 \) -print0)
echo "  signed $NESTED nested Mach-O binaries"

# 2. Nested bundles (Electron frameworks + the four helper .apps). Frameworks
#    are versioned: codesign wants Versions/A, not the .framework wrapper.
if [[ -d "$APP/Contents/Frameworks" ]]; then
  for item in "$APP/Contents/Frameworks/"*; do
    [[ -d "$item" ]] || continue
    if [[ -d "$item/Versions/A" ]]; then
      sign "$item/Versions/A"
    else
      sign "$item"
    fi
    echo "  signed $(basename "$item")"
  done
fi

# 3. The bundle itself, last: its seal covers everything signed above.
sign "$APP"
echo "signed: $APP"

codesign --verify --deep --strict --verbose=2 "$APP"

# ---------------------------------------------------------------------------
# Notarize + staple
# ---------------------------------------------------------------------------
if [[ "$NOTARIZE" -ne 1 ]]; then
  echo "notarize: skipped (no --notarize). Gatekeeper will still block this bundle on other Macs."
  exit 0
fi

# The profile lives in the keychain, not the environment, so an interactive
# shell that never exported APPLE_KEYCHAIN_PROFILE still has working creds.
# Probe the default name before declaring there are none.
if [[ -z "${APPLE_KEYCHAIN_PROFILE:-}" ]] \
  && xcrun notarytool history --keychain-profile solenta >/dev/null 2>&1; then
  APPLE_KEYCHAIN_PROFILE=solenta
fi

NOTARY_AUTH=()
if [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
  NOTARY_AUTH=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]]; then
  NOTARY_AUTH=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD")
else
  echo "ERROR: --notarize requested but no credentials in the environment." >&2
  echo "  Set APPLE_KEYCHAIN_PROFILE, or all of APPLE_ID + APPLE_TEAM_ID + APPLE_APP_PASSWORD." >&2
  echo "  APPLE_APP_PASSWORD is an app-specific password from appleid.apple.com, not the account password." >&2
  exit 1
fi

# notarytool takes an archive, not a bundle. This zip is for submission only —
# publish-release.sh re-zips the STAPLED .app afterwards, which is the one that
# works offline.
SUBMIT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/solenta-notarize.XXXXXX")"
trap 'rm -rf "$SUBMIT_DIR"' EXIT
SUBMIT_ZIP="$SUBMIT_DIR/$(basename "$APP").zip"
ditto -c -k --keepParent "$APP" "$SUBMIT_ZIP"

echo "notarize: submitting $(du -h "$SUBMIT_ZIP" | awk '{print $1}') (this takes minutes)..."
xcrun notarytool submit "$SUBMIT_ZIP" "${NOTARY_AUTH[@]}" --wait

xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
echo "notarize: stapled $APP"
