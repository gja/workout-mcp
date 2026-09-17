#!/usr/bin/env bash
#
# Compile, install and launch on a connected iPhone.
#
#   ios/run.sh Dust                          # by the name the phone calls itself
#   ios/run.sh 00008120-000E49423622201E     # or by UDID
#   IOS_DEVICE=Dust ios/run.sh               # or set it once
#
# The phone needs Developer Mode on and iOS 18 or newer. See ios/README.md.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="$here/WorkoutsMCP.xcodeproj"
scheme="WorkoutsMCP"

device="${1:-${IOS_DEVICE:-}}"
if [ -z "$device" ]; then
	echo "usage: ${BASH_SOURCE[0]} <device name or UDID>" >&2
	echo >&2
	xcrun devicectl list devices >&2
	exit 1
fi

# xcodebuild wants to be told which kind of name it has been given; devicectl takes either.
if [[ "$device" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$ || "$device" =~ ^[0-9a-f]{40}$ ]]; then
	selector="id=$device"
else
	selector="name=$device"
fi

# Read rather than written down, so this still works for a fork that signs as itself.
bundle="$(xcodebuild -project "$project" -scheme "$scheme" -configuration Debug -showBuildSettings 2>/dev/null |
	awk -F' = ' '$1 ~ /PRODUCT_BUNDLE_IDENTIFIER$/ { print $2; exit }')"

xcodebuild \
	-project "$project" \
	-scheme "$scheme" \
	-configuration Debug \
	-destination "platform=iOS,$selector" \
	-derivedDataPath "$here/build" \
	-allowProvisioningUpdates \
	build

app="$here/build/Build/Products/Debug-iphoneos/$scheme.app"

xcrun devicectl device install app --device "$device" "$app"
xcrun devicectl device process launch --device "$device" --terminate-existing "$bundle"
