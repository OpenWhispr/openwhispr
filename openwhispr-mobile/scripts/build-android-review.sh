#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK directory}"
: "${JAVA_HOME:?Set JAVA_HOME to a Java 17 JDK}"
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  echo 'Use Node 24 before building Android.' >&2
  exit 1
fi
export OPENWHISPR_APP_ENV=development
export SENTRY_DISABLE_AUTO_UPLOAD=true
npx expo prebuild --platform android --no-install
cd android
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --max-workers=4 \
  '-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m'
echo 'Review APK: android/app/build/outputs/apk/release/app-release.apk'
