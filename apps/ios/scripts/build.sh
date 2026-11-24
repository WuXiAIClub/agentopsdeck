#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-build}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "iOS builds require macOS and Xcode; this machine cannot compile or sign an IPA." >&2
  exit 1
fi
case "$MODE" in
  generate|build|test|archive) ;;
  *) echo "Usage: bash scripts/build.sh [generate|build|test|archive]" >&2; exit 1 ;;
esac
command -v xcodegen >/dev/null || { echo "Install XcodeGen: brew install xcodegen" >&2; exit 1; }
xcodebuild -version
xcodegen generate --spec "$ROOT/project.yml" --project "$ROOT"
if [[ "$MODE" == "generate" ]]; then exit 0; fi

BUILD_ARGS=(-project "$ROOT/AgentOpsDeck.xcodeproj" -scheme AgentOpsDeck -derivedDataPath "$ROOT/.build/DerivedData")
if [[ "$MODE" == "build" ]]; then
  xcodebuild "${BUILD_ARGS[@]}" -configuration Debug -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
elif [[ "$MODE" == "test" ]]; then
  : "${IOS_SIMULATOR_DESTINATION:?Set IOS_SIMULATOR_DESTINATION to an installed simulator, e.g. platform=iOS Simulator,name=iPhone 16}"
  xcodebuild "${BUILD_ARGS[@]}" -configuration Debug -destination "$IOS_SIMULATOR_DESTINATION" CODE_SIGNING_ALLOWED=NO test
elif [[ "$MODE" == "archive" ]]; then
  if [[ ! -f "$ROOT/Config/Signing.local.xcconfig" ]]; then
    echo "Create Config/Signing.local.xcconfig with your real bundle ID and Apple Team ID first." >&2
    exit 1
  fi
  xcodebuild "${BUILD_ARGS[@]}" -configuration Release -showBuildSettings -json | python3 -c '
import json, re, sys
targets = json.load(sys.stdin)
settings = next(item["buildSettings"] for item in targets if item["target"] == "AgentOpsDeck")
bundle = settings.get("PRODUCT_BUNDLE_IDENTIFIER", "")
team = settings.get("DEVELOPMENT_TEAM", "")
valid = bool(re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", bundle))
valid = valid and not bundle.startswith(("com.example.", "com.yourcompany."))
valid = valid and bool(re.fullmatch(r"[A-Z0-9]{10}", team)) and team != "YOURTEAMID"
if not valid:
    sys.exit("Archive refused: replace placeholder bundle/team with your real Apple identifiers.")
'
  xcodebuild "${BUILD_ARGS[@]}" -configuration Release -destination 'generic/platform=iOS' \
    -archivePath "$ROOT/.build/AgentOpsDeck.xcarchive" -allowProvisioningUpdates archive
  echo "Archive created. Review and distribute through Xcode Organizer; nothing has been uploaded."
fi
