# Android development app

This is an Android implementation in the existing mobile app. Start with [the acceptance matrix](acceptance.md); it distinguishes the completed development review from unverified provider and physical-device behavior. [Parakeet](parakeet.md) records the speech runtime, exact model choice and measured limits. [The implementation plan](implementation-plan.md) records product decisions and shared iPhone functionality.

## Build

Use Node 24, Java 17, Python 3, curl and tar on macOS or Linux. Install Android SDK platform/build-tools 36, NDK 27.1.12297006 and CMake 3.22.1 through SDK Manager. Set `ANDROID_HOME` and `JAVA_HOME` to those installations.

From `openwhispr-mobile/`:

```sh
npm ci
bash scripts/build-android-review.sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

The script prebuilds the development application ID (`com.gizmolabs.openwhispr.dev`), disables production OTA updates and builds an ARM64 APK with its JavaScript bundled. No Metro connection should be required. This is a development signing configuration, not a Play release. Keep the resulting APK outside generated build directories before cleaning them.

The Android bundle-input plugin explicitly tracks `src/android` and `src/locales`: React Native's default input tree excludes directories named `android` and omits JSON. Keep this plugin enabled so incremental APK builds include current Android code and translations.

Gradle compiles the speech-only Sherpa JNI from pinned source on its first run. The Android inference plugin also sets `rnllamaBuildFromSource=true`: the checked-in llama.rn patch removes unconditional prompt-token and decoded-text logs, so the default prebuilt libraries must not be used. Downloads and compilation are cached in the Gradle user directory; the APK does not contain model weights. Models download inside the app and activate only after exact size and SHA-256 verification. Download Parakeet v3 and Qwen2.5 1.5B (Balanced) for the tested local pairing. The light text model is available but did not translate the tutorial reliably in the initial check.

For development with Fast Refresh:

```sh
OPENWHISPR_APP_ENV=development npx expo start --dev-client --port 8087
adb reverse tcp:8087 tcp:8087
```

Open the development client and select that server. NativeWind and CSS interop are pinned to matching 4.2.7/0.2.7 releases, which include the Metro 0.83 change-event fix. Native module changes need another Android build.

## Local use and permissions

Choose the explicit local workspace route to use local processing without signing in. Hosted processing, account sync and BYOK are separate choices. Existing account entitlements remain authoritative; rewards and trial eligibility are never invented locally.

Open **Models & processing** and turn **Local Mode** off to use OpenWhispr Cloud. The switch reuses the shared account and model checks. The retained signed-in session completed two live short-clip cloud dictations in the review pass; local processing was restored afterward.

**Plans & billing** now connects a remotely configured Superwall paywall to RevenueCat as the sole Android purchase controller. It selects the exact Play product/base plan/offer, restores purchases, retries server access verification and preserves existing web/workspace subscriptions. Prices and eligibility come from the configured store paywall, not local constants. The local review APK has neither Android public SDK key configured. The EAS Play build includes both keys, the catalog/paywall are configured, RevenueCat validates credentials, and version 1.2.4/code 10 is installed from the private Play test track. Code 9 verified a zero-charge monthly test purchase, accelerated renewal, cancellation and expiration through Play, RevenueCat and Superwall. Successful restore and server access remain unverified; see [current purchase configuration](purchase-configuration-review.md) for backend activation and test-access dependencies.

Unresolved payments and access verification expose Google Play management and support. Both links and Back navigation are verified against the real pending-access state on signed code 10. Refresh invalidates cached customer information, and an empty restore does not claim that a pending payment was cancelled. Automatic recovery after cancellation/expiry remains incomplete: the current SDK response does not expose a verified terminal transaction state. The app preserves the purchase lock rather than risking a second payment; original-transaction correlation and provider/backend status support are required to clear that lock safely. No real charge or manual trial grant has been issued.

Enable overlay and text insertion through Bubble & permissions and Android's normal consent screens. Enabling the bubble asks for microphone permission, and notification permission on Android 13+. Recording starts only from a user gesture. Password fields are excluded; if the original field or selection changes, the result is preserved in Home instead of writing into another field. Disable the bubble from that settings screen or its close button.

For unattended testing, keep emulator host microphone input off and use **Use an audio file** with explicitly identified synthetic/prerecorded audio. File inference, silent recorder lifecycle and cross-process insertion tests are separate checks; none proves physical-phone speech quality, thermals or battery behavior.

Development builds log speech elapsed time under `android-speech` and text-model loading/generation timings under `android-reasoning`. Prompt-token and decoded-text logs are removed from the native runtime. Native CPU thread selection uses the runtime defaults with strict affinity disabled. Packaged inference has been measured; see the runtime notes for the input-specific results. Cold local loading is slow and some earlier styled cleanup runs timed out. Failed cleanup preserves a recoverable raw transcript in Home. The smaller text model can also miss formatting instructions.

Translate, Write and Edit transcribe the speech unchanged, then run the requested text action once. They skip the ordinary dictation cleanup, agent and snippet passes, whose output those actions would discard. Dictate retains the shared cleanup behavior. Regression checks cover this distinction for local, cloud and BYOK speech; the packaged local Translate, Write and Edit paths also ran on the emulator.

## Checks

```sh
npm run typecheck
npx jest --runInBand
cd android
./gradlew :android-dictation:testDebugUnitTest :app:assembleDebug \
  -PreactNativeArchitectures=arm64-v8a --max-workers=4
```

The native insertion fixture is `scripts/android-smoke/run.py`. It installs only its own disposable test package and writes into two harmless unsent fields. Instrumentation restarts the target app; turn the OpenWhispr accessibility service off in Settings first, start the script, then enable it normally during the 60-second wait. Do not run UIAutomator dumps while that test is active: UIAutomator can suppress the service being tested. It checks cursor/selection preservation, empty hints, changed focus/text and password exclusion. Remove only `com.openwhispr.androidtest` after testing. The script never grants permissions through the shell.

Private competitor analysis, audio, screenshots and logs are intentionally outside this public repository. Remaining account, provider and physical-device gaps are recorded in the acceptance matrix.
