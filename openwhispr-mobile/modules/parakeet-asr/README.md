# Local Parakeet and Orukeet

Orukeet is an opt-in local model. The existing FluidAudio `AsrManager` receives
16 kHz mono audio after recording finishes, preserving its word-timing API.
Installing Orukeet selects it for explicitly supported languages. Automatic and
unsupported-language routing keeps the app's existing policy.

The Swift package plugin pins OrukeetCoreML and its compatible FluidAudio fork
to immutable commits. Keep the FluidAudio commit aligned with the exact version
in Orukeet's `Package.swift`; diarization shares that package instance.

## Installation and iOS updates

The 554,985,744-byte archive is authenticated before extraction. The SDK compiles
models locally and retains a verified archive for offline recompilation after an
iOS update. Installed storage is approximately 1.19 GB; first-install peak is
approximately 1.82 GB, before the app's free-space margin. Actual compilation
size varies by device and OS. Existing compiled-only installs need one fresh
download on their first OS migration.

Startup recovery is tracked like an install. Dictation availability probes return
promptly while it runs; the model picker waits with its loading indicator so it
does not offer another download. Delete cancels and joins recovery before removing
the model and staging directory. Failed recovery preserves its source for retry.

## Verification

Run `python3 scripts/check-orukeet-installer.py --mutation-check` from the mobile
root on macOS. This compiles the actual installer with a controlled SDK test
double to exercise recovery, cancellation, deletion, retry and UI waiting. It
does not perform model inference.

The native CI workflow generates the Expo project and compiles the complete
unsigned iOS Simulator app. The SDK's separate simulator workflow authenticates
the real portable model, transcribes short/multilingual/long fixtures, and checks
offline recovery after a simulated OS cache change.

Before public rollout, test a signed build on the supported physical iPhone floor:
cold download/compile/load, airplane-mode relaunch, short and long microphone
recordings, cancellation/retry/delete/reinstall, repeated sessions, and two-speaker
diarization. Record peak RAM, thermals and latency against the existing Parakeet
models. Simulator builds and Mac timings do not establish those device results.
Keep Orukeet opt-in while model accuracy and physical-device acceptance are open.
