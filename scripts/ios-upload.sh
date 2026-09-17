#!/usr/bin/env bash
#
# Archive the iPhone app and send it to App Store Connect, from where TestFlight picks it up.
#
# There is no App Store Connect API key here and none is wanted. With no -authenticationKey*
# arguments, xcodebuild authenticates as the Apple ID Xcode is signed in as (Xcode › Settings
# › Accounts), whose session is in the login keychain — which is why a keychain prompt comes
# up, the same one Product › Archive raises. *Always Allow* answers it once and for good.
#
#   scripts/ios-upload.sh [--no-bump]
#
# The build number is bumped first, because App Store Connect refuses one it has already seen
# for a version and finding that out costs a whole archive. --no-bump is for re-running an
# upload that failed after the bump. `agvtool` writes the new number into the project file,
# so it is a change to commit.

set -euo pipefail

BUMP=yes
case "${1:-}" in
  --no-bump) BUMP=no ;;
  "") ;;
  *) echo "usage: scripts/ios-upload.sh [--no-bump]" >&2; exit 64 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/ios/WorkoutsMCP.xcodeproj"
ARCHIVE="$ROOT/build/WorkoutsMCP.xcarchive"

# agvtool wants to be run from the directory holding the project, and says what it set.
if [ "$BUMP" = yes ]; then
  (cd "$ROOT/ios" && agvtool next-version -all)
fi

rm -rf "$ARCHIVE"
xcodebuild -project "$PROJECT" -scheme WorkoutsMCP \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  archive

# Read back rather than written down, so a fork signing as itself needs nothing changed here.
TEAM="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:Team' "$ARCHIVE/Info.plist" 2>/dev/null || true)"
if [ -z "$TEAM" ]; then
  TEAM="$(xcodebuild -project "$PROJECT" -scheme WorkoutsMCP -showBuildSettings 2>/dev/null |
    awk -F' = ' '/ DEVELOPMENT_TEAM = /{ print $2; exit }')"
fi
[ -n "$TEAM" ] || { echo "no team id in the archive or the project; set DEVELOPMENT_TEAM" >&2; exit 1; }

# The export options are written here rather than kept in the repo: every value in them is
# either fixed or already in the project, so a file to maintain by hand would only be a file
# to get out of step with it.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OPTIONS="$WORK/ExportOptions.plist"
cat > "$OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
PLIST

# `destination: upload` is what makes this ship the archive rather than leave an .ipa behind.
echo "==> uploading to App Store Connect as team $TEAM"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$OPTIONS" \
  -exportPath "$ROOT/build/export" \
  -allowProvisioningUpdates

echo "==> uploaded. Processing takes five to thirty minutes; then it is under TestFlight."
