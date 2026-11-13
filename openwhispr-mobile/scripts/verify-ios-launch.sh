#!/bin/bash
# Launches an EAS iOS build's exact binary on every installed iOS 27+ simulator runtime and fails
# when it doesn't stay up. 1.2.4 (40) was built with the iOS 27 SDK and no UIScene lifecycle, and
# iOS 27 refused to launch it; this catches that class of failure before submitting to the App Store.
#
# Usage: npm run verify:ios-launch -- <eas-build-id>      (macOS with Xcode and the eas CLI)
set -euo pipefail

MIN_RUNTIME_MAJOR=27
STAY_UP_SECONDS=30
LAUNCH_FAILURE_PATTERN='Application failed to launch|UIScene life cycle is required'

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || {
  echo "Usage: $0 <eas-build-id>" >&2
  exit 2
}
BUILD_ID="$1"
[ "$(uname -s)" = Darwin ] || fail "this check needs macOS with Xcode and the iOS simulator."
for tool in eas node curl unzip codesign xcrun; do
  command -v "$tool" > /dev/null || fail "$tool is not on PATH."
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-ios-launch.XXXXXX")"
CREATED_UDIDS=""

cleanup() {
  for udid in $CREATED_UDIDS; do
    xcrun simctl shutdown "$udid" > /dev/null 2>&1 || true
    xcrun simctl delete "$udid" > /dev/null 2>&1 || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2> /dev/null
}

# --- Download the build's IPA -------------------------------------------------------------------

echo "Looking up EAS build $BUILD_ID..."
(cd "$ROOT" && eas build:view "$BUILD_ID" --json) > "$WORK/build.json" ||
  fail "eas build:view failed (run from an installed checkout, logged in to EAS)."
BUILD_URL="$(
  node -e '
    const build = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (build.platform !== "IOS") throw new Error(`build is ${build.platform}, not IOS`);
    if (build.status !== "FINISHED") throw new Error(`build status is ${build.status}`);
    const url = build.artifacts && build.artifacts.buildUrl;
    if (!url) throw new Error("build has no artifacts.buildUrl");
    console.error(`Build ${build.appVersion} (${build.appBuildVersion}), ${build.buildProfile} profile`);
    console.log(url);
  ' "$WORK/build.json"
)" || fail "EAS build $BUILD_ID can't be checked."

mkdir "$WORK/ipa"
echo "Downloading the IPA..."
curl -fsSL --retry 3 -o "$WORK/build.ipa" "$BUILD_URL" || fail "the IPA download failed."
unzip -q "$WORK/build.ipa" -d "$WORK/ipa" || fail "the IPA is not a valid archive."

set -- "$WORK"/ipa/Payload/*.app
[ "$#" -eq 1 ] && [ -d "$1" ] || fail "the IPA should hold exactly one Payload/*.app."
APP="$1"
INFO="$APP/Info.plist"

# --- Static check: an iOS 27 SDK build must declare a scene manifest ----------------------------

BUNDLE_ID="$(plist_value "$INFO" CFBundleIdentifier)" || fail "Info.plist has no CFBundleIdentifier."
SDK_NAME="$(plist_value "$INFO" DTSDKName)" || fail "Info.plist has no DTSDKName."
SDK_VERSION="${SDK_NAME#iphoneos}"
SDK_MAJOR="${SDK_VERSION%%.*}"
case "$SDK_MAJOR" in
  '' | *[!0-9]*) fail "unexpected DTSDKName \"$SDK_NAME\" (expected iphoneosNN.N)." ;;
esac
if plist_value "$INFO" UIApplicationSceneManifest > /dev/null; then
  HAS_SCENE_MANIFEST=yes
else
  HAS_SCENE_MANIFEST=no
fi
echo "$BUNDLE_ID: SDK $SDK_NAME, UIApplicationSceneManifest: $HAS_SCENE_MANIFEST"

if [ "$SDK_MAJOR" -ge 27 ] && [ "$HAS_SCENE_MANIFEST" = no ]; then
  fail "built with $SDK_NAME but has no UIApplicationSceneManifest. iOS 27 refuses to launch it" \
    "(\"UIScene life cycle is required for apps built with this SDK\")."
fi

# --- Find the iOS 27+ runtimes and a device type each one supports ------------------------------

xcrun simctl list runtimes --json > "$WORK/runtimes.json"
RUNTIMES="$(
  node -e '
    const { runtimes } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const minMajor = Number(process.argv[2]);
    for (const runtime of runtimes) {
      if (runtime.platform !== "iOS" || !runtime.isAvailable) continue;
      if (Number(runtime.version.split(".")[0]) < minMajor) continue;
      // Some runtimes support a single device type (27.1 only creates iPhone-Duo), so pick from
      // the runtime itself: an iPhone it lists, else whatever it lists.
      const types = runtime.supportedDeviceTypes || [];
      const iphones = types.filter((type) => type.productFamily === "iPhone");
      const deviceType = (iphones.length > 0 ? iphones : types).at(-1);
      if (!deviceType) continue;
      console.log([runtime.identifier, runtime.version, deviceType.identifier].join(" "));
    }
  ' "$WORK/runtimes.json" "$MIN_RUNTIME_MAJOR"
)"
[ -n "$RUNTIMES" ] ||
  fail "no iOS $MIN_RUNTIME_MAJOR+ simulator runtime is installed (xcodebuild -downloadPlatform iOS)."

# --- Retag the device binary for the simulator and ad hoc sign it -------------------------------

echo "Preparing the app for the simulator..."
find "$APP" -type f -print0 | while IFS= read -r -d '' file; do
  file -b "$file" | grep -q 'Mach-O' || continue
  build_info="$(xcrun vtool -show-build "$file")"
  # Keep each binary's own deployment target and SDK, so UIKit's linked-on-or-after checks
  # (the scene requirement among them) behave exactly as on a device.
  minos="$(echo "$build_info" | awk '$1 == "minos" || $1 == "version" { print $2; exit }')"
  sdk="$(echo "$build_info" | awk '$1 == "sdk" { print $2; exit }')"
  [ -n "$minos" ] && [ -n "$sdk" ] || fail "can't read the build version of ${file#"$APP"/}."
  # vtool warns that the signature is now invalid; everything is signed again below.
  xcrun vtool -set-build-version iossim "$minos" "$sdk" -replace -output "$file" "$file" \
    2> "$WORK/vtool.err" || {
    cat "$WORK/vtool.err" >&2
    fail "vtool could not retag ${file#"$APP"/}."
  }
done

find "$APP" -name embedded.mobileprovision -delete
sign() {
  codesign --force --sign - --timestamp=none "$1" > /dev/null 2>&1 || fail "codesign failed on ${1#"$APP"/}."
}
# Inside out: nested code must be signed before the bundle that contains it.
find "$APP" \( -name '*.framework' -o -name '*.dylib' \) -print0 | while IFS= read -r -d '' code; do
  sign "$code"
done
find "$APP" -name '*.appex' -print0 | while IFS= read -r -d '' appex; do sign "$appex"; done
sign "$APP"

# --- Launch on each runtime ---------------------------------------------------------------------

# Runs a command with a deadline (macOS has no timeout(1)), so a wedged simulator fails the check
# instead of hanging it.
with_timeout() {
  local seconds="$1"
  shift
  perl -e 'alarm shift; exec @ARGV' "$seconds" "$@"
}

# Not `log show` afterwards: on a freshly booted runtime it can scan the log store for most of an
# hour. `process != "log"` drops the log tool's own line, which quotes this predicate.
LOG_PREDICATE='process != "log" AND (eventMessage CONTAINS "Application failed to launch" OR eventMessage CONTAINS "UIScene life cycle is required")'

launch_on_runtime() {
  local runtime="$1" version="$2" device_type="$3"
  local udid pid label log_file stream_pid failure="" waited=0

  udid="$(with_timeout 60 xcrun simctl create "verify-ios-launch-$version" "$device_type" "$runtime")" || {
    echo "  can't create a ${device_type##*.} simulator"
    return 1
  }
  CREATED_UDIDS="$CREATED_UDIDS $udid"
  with_timeout 600 xcrun simctl bootstatus "$udid" -b > /dev/null || {
    echo "  the simulator didn't boot within 10 minutes"
    return 1
  }
  with_timeout 300 xcrun simctl install "$udid" "$APP" || {
    echo "  install failed"
    return 1
  }

  log_file="$WORK/launch-$version.log"
  xcrun simctl spawn "$udid" log stream --style compact --predicate "$LOG_PREDICATE" > "$log_file" 2>&1 &
  stream_pid=$!
  sleep 3

  label="UIKitApplication:$BUNDLE_ID["
  if ! pid="$(with_timeout 60 xcrun simctl launch "$udid" "$BUNDLE_ID" | awk -F': ' '{ print $2 }')" ||
    [ -z "$pid" ]; then
    failure="simctl launch failed"
  fi
  while [ -z "$failure" ] && [ "$waited" -lt "$STAY_UP_SECONDS" ]; do
    sleep 2
    waited=$((waited + 2))
    # launchctl keeps a crashed app's entry with "-" in the PID column, so match the PID.
    if ! with_timeout 30 xcrun simctl spawn "$udid" launchctl list |
      awk -v pid="$pid" -v label="$label" '$1 == pid && index($3, label) == 1 { found = 1 } END { exit !found }'; then
      failure="process $pid exited within ${waited}s"
    fi
  done

  sleep 2
  kill "$stream_pid" 2> /dev/null || true
  wait "$stream_pid" 2> /dev/null || true
  # The stream's "Filtering the log data using ..." header quotes the predicate too.
  local log_lines
  log_lines="$(grep -E "$LAUNCH_FAILURE_PATTERN" "$log_file" | grep -v '^Filtering the log data' || true)"
  if [ -n "$log_lines" ]; then
    failure="${failure:-UIKit reported a launch failure}"
    echo "$log_lines" | head -5 | sed 's/^/  log: /'
  fi

  if [ -n "$failure" ]; then
    echo "  $failure"
    return 1
  fi
  echo "  process $pid stayed up for ${STAY_UP_SECONDS}s"
}

FAILED=0
SUMMARY=""
# The list goes in on fd 3: simctl reads stdin and would otherwise swallow the rest of it.
while read -r runtime version device_type <&3; do
  echo "iOS $version (${device_type##*.}):"
  if launch_on_runtime "$runtime" "$version" "$device_type"; then
    SUMMARY="$SUMMARY
PASS  iOS $version"
  else
    FAILED=1
    SUMMARY="$SUMMARY
FAIL  iOS $version"
  fi
done 3<<< "$RUNTIMES"

echo "$SUMMARY"
[ "$FAILED" -eq 0 ] || fail "$BUNDLE_ID did not stay up on every iOS $MIN_RUNTIME_MAJOR+ runtime."
echo "PASS: $BUNDLE_ID ($SDK_NAME) stays up on every installed iOS $MIN_RUNTIME_MAJOR+ runtime."
