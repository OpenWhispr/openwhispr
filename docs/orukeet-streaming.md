# Orukeet cloud dictation

Orukeet uploads audio during recording and returns one final transcript on release. The desktop uses the existing cloud login, dictation controls, fallback recording, cleanup and paste pipeline. There are no interim words or new settings to configure for managed users.

## Enable the managed route

The desktop supports this server-controlled `/api/stt-config` response for dictation:

```json
{
  "dictation": { "mode": "streaming" },
  "streamingProvider": "orukeet"
}
```

Keep the flag off until the private Cloud backend implements `POST /api/stt/orukeet/session`. That backend is maintained separately from this desktop repository. Before issuing a session, it must apply the existing account authentication, workspace policy, entitlement, allowance, rate and concurrency checks. Return the existing structured error format for denials; the desktop preserves auth refresh, policy and upgrade metadata.

The backend-only [issue-session.cjs](integrations/orukeet/issue-session.cjs) calls the deployed token service and validates its response. Inject `ORUKEET_SERVICE_KEY` from the backend secret manager and return `await issueSession({ serviceKey, accountId: authenticatedUser.id })` with `Cache-Control: no-store`. Use the same opaque account ID across devices, derived from verified authentication, never a desktop-supplied ID. IDs must contain 8–128 letters, digits, underscores or hyphens; do not use an email address. The helper is outside the packaged Electron file allowlist. No service credential belongs in the app, renderer, repository, logs or response. No unauthenticated route is included here.

The response contains `baseUrl`, `websocketUrl`, `clientToken`, `protocol`, `expiresIn`, `singleUse`, and `model`. The main process validates all fields, pins the destination to `https://orukeet.gizmovoice.ai`, and connects using `orukeet.pcm.v1` and `auth.<clientToken>` WebSocket subprotocols. A renderer-selected URL cannot redirect managed credentials. Token issuance and connection are bound to the current account; cancellation or credential changes cannot reopen a stale session.

**Usage enforcement:** current GPU tokens are single-use connection credentials with a 60-second connection expiry, not per-user billing grants. An established socket can last longer. Token issuance checks alone do not enforce paid audio duration. Before a paid rollout, the private backend and gateway must provide trusted user/session metering or proxy sessions through an authenticated metered backend. Client duration telemetry is not a trusted billing receipt. Rebenchmark if a proxy hop is introduced.

**Account concurrency:** account-bound sessions share one active recording and one idle/warm socket across the three regions. The default role is `warm`; receiving audio promotes it to `active`. A second concurrent recording is rejected before transcription, and the desktop retains its audio for the existing authorized fallback. Finishing or clearing returns the connection to `warm`; if another warm socket already exists, the completed connection closes after delivering its final result. A coordinator outage rejects new sessions and closes existing sessions after their lease expires. This bounds concurrency, not billable usage. Calls without `accountId` remain legacy-compatible and do not enforce a per-account cap. The private backend must supply the ID to enable this protection; the desktop PR alone cannot do that.

## Recording lifecycle

The main process creates the adapter before requesting the session so initial PCM is buffered. The existing AudioWorklet emits mono PCM16 at 16 kHz. On release it sends its final PCM and a flush acknowledgement; only then does the desktop commit. Final acknowledgement replaces fixed settling delays. Successful silence is accepted without a second transcription. A flush failure closes the incomplete stream and preserves the existing recording fallback.

The server can accept another recording on a surviving socket after a final resets its audio and language state. The desktop currently closes the used adapter after each recording and creates a new warm connection; it only reuses a socket that has carried no audio. An unused Orukeet connection closes after 60 seconds; recording startup cancels that timer. Cancellation closes without commit. Pending audio is bounded to 2 MiB; setup and final waits are bounded. Application heartbeats run every 15 seconds. The server allows at most 600 seconds of audio and uses overlapped windows above 60 seconds; an individual socket has a 20-minute lifetime.

A `capacity` response means the server retained the audio. Managed Cloud closes that attempt immediately and uploads the complete retained capture through the existing authorized batch fallback, including recordings under two seconds; it does not keep the active socket retrying until the final deadline. A self-hosted BYOK connection still retries only the commit after `retry_after_ms`, within the original final deadline. Connection loss closes the adapter and uses the existing retained-audio fallback. Duplicate final responses are ignored. The fallback does not replace the configured batch model or bypass its account checks.

The rollout applies to dictation. Local Orukeet, meetings and existing BYOK providers retain their behavior. For an operator's custom endpoint, selecting `orukeet-v0.1.0` with a custom URL and key opts into the same PCM transport; other custom models retain their existing route.

## Validation and rollout

Automated tests cover real WebSocket transport, the registered Electron IPC handlers, startup buffering, token authentication, endpoint pinning, allowance and policy denials, account changes, cancellation, duplicate finals, silence, capture flush ordering, retry and timeout. [Streaming benchmark results](orukeet-benchmarks.md) report the deployed infrastructure measurements separately from desktop tests.

Before enabling the flag, accept the private backend route and metering, then verify microphone, hotkey, cleanup and single-paste behavior on signed macOS, Windows and Linux release builds. Automated Electron-boundary tests do not claim native OS acceptance. Roll back by restoring the previous `streamingProvider`; let active recordings finish. Track setup, stop-to-final, release-to-paste, queue time and fallback rate separately.

## Routing policy (OpenWhispr)

Orukeet transcribes 25 languages (`bg cs da de el en es et fi fr hr hu it lt lv mt nl pl pt ro ru sk sl sv uk`) and renders any other language as confident nonsense. Those dictations stay on the existing Cloud batch provider:

- An explicitly selected language outside the 25 never starts an Orukeet stream. The dictation records in batch, tagged `language_unsupported`.
- With the language set to "auto", the desktop reads the estimate in Orukeet's `final` message, never the early `language` events. An estimate outside the 25 with a score of at least 0.90 on at least 3 seconds of audio discards Orukeet's text. This applies to managed OpenWhispr Cloud dictation only.
- The retained recording is then uploaded to `/api/transcribe`, tagged `language_detected_unsupported`. Like any "auto" dictation it sends no `language`, never the detected one, because `/api/transcribe` picks its model by declared language. Cleanup runs once, on the batch transcript.
- If the upload fails, Orukeet's text is kept. If Cloud finds no speech, the dictation ends empty and the recording is kept in History for a retry.
- Every Orukeet dictation reports the final estimate as `sttDetectedLanguage`, `sttDetectedLanguageConfidence`, `sttDetectedLanguageAudioSeconds` and `sttDetectedLanguageStatus` on its usage, cleanup or batch request. A final without a `language` key (an older gateway) reports nothing.
- The backend stores the estimate in `transcription_logs.metadata`. Once enough of a user's recent dictations are outside the 25, `/api/stt-config` stops offering Orukeet and `/api/stt/orukeet/session` refuses with 403 `FEATURE_NOT_ENABLED` and `reason: "language_unsupported"`. The desktop treats that refusal as its `feature_disabled` batch fallback. Allowlisted testers skip this gate. The rule lives in `openwhispr-api` (`lib/orukeet-language.ts`, applied in `lib/orukeet-rollout.ts`).

The 0.90 threshold is Oruk's classifier score, not a calibrated probability. It caught 92% of unsupported FLEURS clips at 6 seconds and 62.5% at 3 seconds, while flagging 0.4% and 1.2% of supported ones. See [streaming language metadata](orukeet-streaming-language.md). The desktop acts from 3 seconds rather than waiting for the 6-second estimate because a false flag costs one batch round trip, while a miss pastes nonsense.
