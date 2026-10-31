# Android native paywall presenter regression

Superwall's on-device draft preview opens `DebugViewActivity`, while Expo's
`currentActivity` still points at the stopped React activity. SDK 2.8.3 obtains
its presenter from that provider and rejects the stopped screen with presentation
error 103, even though the preview screen is visible.

The `expo-superwall+1.2.0.patch` patch uses the SDK's `CurrentActivityTracker`
for native foreground screens, with Expo's activity as a fallback for initial
configuration after the app has already resumed. It is Android-only and leaves
the purchase controller, products, identity and native SDK/Billing pins unchanged.

The probe compiles the actual patched provider and checksum-pinned SDK 2.8.3
tracker source. Android/Expo lifecycle classes and logging are host stubs. It
checks startup, opening a native preview while React stops, destruction of an
older screen, backgrounding, resume, native-screen destruction and return to the
app. The unpatched bridge fails the native-preview case. **This is a lifecycle
regression fixture, not installed paywall, purchase or accessibility acceptance.**

With Python 3, a JDK 17+ selected through `JAVA_HOME`, and the Kotlin 2.1.20 Gradle
compiler dependencies already cached by the Android toolchain:

```sh
python3 scripts/android-superwall-activity/run.py
```

The runner fetches only the two pinned public SDK source files and checks their
hashes. For an offline run, pass `--sdk-source-dir` pointing to a directory with
`ActivityProvider.kt` and `CurrentActivityTracker.kt` from the pinned release.
`--provider` accepts an alternate original or patched bridge source for a
before/after check. Generated sources and classes are removed on exit.

Keep the probe's SDK version and checksums aligned with the Android billing
plugin's pin when upgrading. Run the installed draft preview and normal
paywall/purchase/Restore flows on the next approved candidate.

References: [SDK presenter selection](https://github.com/superwall/Superwall-Android/blob/2.8.3/superwall/src/main/java/com/superwall/sdk/paywall/presentation/internal/GetPaywallComponentsFactory.kt#L95),
[foreground tracker](https://github.com/superwall/Superwall-Android/blob/2.8.3/superwall/src/main/java/com/superwall/sdk/misc/CurrentActivityTracker.kt).
