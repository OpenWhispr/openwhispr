# Android local meeting runtime

The Android adapter uses Sherpa-ONNX 1.13.8 with Pyannote segmentation 3.0 int8
and NVIDIA NeMo TitaNet Small on CPU. Model filenames, sizes, sources and SHA-256
digests are in `src/android/meetingModels.ts`; the existing downloader verifies
both files before the adapter runs. Notices are included in Android Licenses.

Android Local Mode setup now offers Start with permission/model preflight. It uses
the durable foreground recorder, saves the managed source path before capture,
and handles notification Stop, failure, duplicate Stop, cancellation and leaving.
Local PCM frames and events are isolated from streaming consumers. Each recording
attempt owns its stop token. The iOS recorder path is retained.

This source integration still needs an installed preview and end-to-end tests.
The existing installed code21 predates it. No physical-phone acceptance is implied.
The adapter returns within-meeting speaker labels, not reusable voice identities.

Private saved-meeting retry now uses the local pipeline, including when the
current processing mode is Cloud or the user is signed out. Job ownership checks
observe account/session and mode transitions (including A -> B -> A), reject stale
transcript/title/summary results, and clean up subscriptions. An explicit abort
leaves a current owner's recording retryable. The screen supplies that abort signal for navigation, account/mode changes and
cancellation. A same-account mode change can mark the saved recording retryable;
account transitions cannot write into the replacement account. After native Stop settles, an interrupted private note becomes retryable when its
original account returns, without a restart. This status-only recovery checks the
saved note identity, privacy and audio path; the cancelled job stays invalid and
never resumes automatically. Installed account-return validation is still pending. No private retry uploads audio.

Preflight requires the user to select and download Parakeet v3 for word timing.
Requests for word timings with Moonshine fail before loading its runtime; ordinary
Moonshine transcription remains available. There is no automatic model switch.
If local note generation is unavailable, the saved transcript remains available
for a later explicit action rather than retaining an automatic cloud-fallback
callback past the job's lifetime. Existing iOS routing and prompts are retained.

The shared inference queue unloads idle text and speech models before speaker
processing. Native decoding creates a temporary 16 kHz mono WAV. The original
recording is never changed or uploaded. A memory preflight includes audio/JNI
copies, the clustering distance matrix and reserved headroom; it is an estimate,
not a demonstrated maximum meeting duration. The shared decoder currently
requires audio shorter than one hour. Local capture stops at 59 minutes, retaining
the recording for retry when the native time-limit event occurs. This cap is not a
phone performance recommendation. Physical-phone memory, heat, latency and
long-session behavior remain unverified.

Cancellation invalidates queued/returned results. The pinned native API does not
interrupt inference immediately: its worker owns and releases the engine after
processing returns. UI cancellation and persistence must respect that distinction.

The Models screen supports downloading, cancelling and removing the 42 MB speaker
package, without offering it as a dictation speech model. Setup explains Parakeet
selection and download size. The download step can be cancelled without starting
from a late completion. Model-serving readiness still needs final review.

## Bounded verification

- TypeScript adapter tests exercise platform routing, timed turns, missing models,
  queued cancellation and stale-result rejection.
- Pipeline/store tests cover private retry, account and mode changes, explicit
  abort, late title/summary writes and required word-timing preflight.
- Screen tests cover permission denial, durable source/Stop, native notification
  events, failed and pending starts, cancellation, account/mode/leave invalidation,
  model download cancellation and late result suppression. Real device behavior
  and UI accessibility remain unverified.
- JVM tests cover memory refusal, including quadratic clustering allocation,
  local/streaming event isolation, attempt ownership and capture duration limits.
- `DiarizationRuntimeTest` runs in the separate `com.openwhispr.dictation.test`
  instrumentation app, with no microphone permission or network needed. It checks
  repeated synthetic voices, silence and original-file preservation after failure.
- `SpeechRuntimeTest` checks the rebuilt shared runtime with Parakeet and both
  Moonshine models, including the existing unpadded final-word regression.

For the diarization instrumentation test, place the two verified model files and
fixtures in that debug test app's `files/fixtures/diarization`. `silence.wav` is
five seconds of 16 kHz mono signed-16-bit PCM zeros. `two-voices.wav` is the
retained 31.4945-second synthetic Samantha/Daniel/Samantha/Daniel fixture with
SHA-256 `9e5ad636d568a769daf6b8221806fbcf7043fd5d97f7bc73fc0480eb5f287ae4`.
Its four speech intervals start at 0, 7.1386875, 15.5620625 and 22.689125 seconds.
The test asserts stable A/B/A/B labels at interior points and unchanged original
bytes. This fixture check does not establish accuracy for real meeting audio.
