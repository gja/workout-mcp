#!/usr/bin/env bash
#
# Build the iPhone app and put it on a phone, without opening Xcode.
#
# Nothing about signing is passed in: the target signs automatically against the team id in
# the project, so the identity comes out of the login keychain and -allowProvisioningUpdates
# fetches or refreshes the profile. The phone needs Developer Mode on and this Mac trusted.
#
#   scripts/ios-install.sh <device-id>
#
# With no argument it prints the phones it can see and stops. Run over SSH, unlock the
# keychain first — security unlock-keychain ~/Library/Keychains/login.keychain-db — or
# codesign fails with errSecInternalComponent rather than saying what is wrong.

set -euo pipefail

DEVICE="${1:-}"
if [ -z "$DEVICE" ]; then
  echo "usage: scripts/ios-install.sh <device-id>" >&2
  echo >&2
  xcrun devicectl list devices >&2
  exit 64
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/ios/WorkoutsMCP.xcodeproj"
DERIVED="$ROOT/build/ios"

xcodebuild -project "$PROJECT" -scheme WorkoutsMCP \
  -configuration Debug \
  -destination "id=$DEVICE" \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  build

# Found rather than spelled out, and the bundle id read back off it, so a fork that renamed
# either of them installs and launches the app it just built instead of one this file names.
APP="$(find "$DERIVED/Build/Products" -maxdepth 2 -name '*.app' -print -quit)"
[ -n "$APP" ] || { echo "the build left no .app under $DERIVED/Build/Products" >&2; exit 1; }
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")"

echo "==> installing $(basename "$APP") ($BUNDLE_ID) on $DEVICE"
xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" --terminate-existing "$BUNDLE_ID"
