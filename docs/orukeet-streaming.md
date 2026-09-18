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

The backend-only [issue-session.cjs](integrations/orukeet/issue-session.cjs) calls the deployed token service and validates its response. Inject `ORUKEET_SERVICE_KEY` from the backend secret manager and return `await issueSession({ serviceKey })` with `Cache-Control: no-store`. The helper is outside the packaged Electron file allowlist. No service credential belongs in the app, renderer, repository, logs or response. No unauthenticated route is included here.

The response contains `baseUrl`, `websocketUrl`, `clientToken`, `protocol`, `expiresIn`, `singleUse`, and `model`. The main process validates all fields, pins the destination to `https://orukeet.gizmovoice.ai`, and connects using `orukeet.pcm.v1` and `auth.<clientToken>` WebSocket subprotocols. A renderer-selected URL cannot redirect managed credentials. Token issuance and connection are bound to the current account; cancellation or credential changes cannot reopen a stale session.

**Usage enforcement:** current GPU tokens are single-use connection credentials with a 60-second connection expiry, not per-user billing grants. An established socket can last longer. Token issuance checks alone do not enforce paid audio duration. Before a paid rollout, the private backend and gateway must provide trusted user/session metering or proxy sessions through an authenticated metered backend. Client duration telemetry is not a trusted billing receipt. Rebenchmark if a proxy hop is introduced.

## Recording lifecycle

The main process creates the adapter before requesting the session so initial PCM is buffered. The existing AudioWorklet emits mono PCM16 at 16 kHz. On release it sends its final PCM and a flush acknowledgement; only then does the desktop commit. Final acknowledgement replaces fixed settling delays. Successful silence is accepted without a second transcription. A flush failure closes the incomplete stream and preserves the existing recording fallback.

Each recording uses a fresh adapter, with an optional warm connection from the existing dictation warmup. Cancellation closes without commit. Pending audio is bounded to 2 MiB; setup and final waits are bounded. Application heartbeats run every 15 seconds. The server allows at most 600 seconds of audio and uses overlapped windows above 60 seconds.

A `capacity` response means the server retained the audio: retry only the commit after `retry_after_ms`, within the original final deadline. Connection loss closes the adapter and uses the existing retained-audio fallback. Duplicate final responses are ignored. The fallback remains the existing authorized OpenWhispr Cloud path; this PR does not replace its model configuration.

The rollout applies to dictation. Local Orukeet, meetings and existing BYOK providers retain their behavior. For an operator's custom endpoint, selecting `orukeet-v0.1.0` with a custom URL and key opts into the same PCM transport; other custom models retain their existing route.

## Validation and rollout

Automated tests cover real WebSocket transport, the registered Electron IPC handlers, startup buffering, token authentication, endpoint pinning, allowance and policy denials, account changes, cancellation, duplicate finals, silence, capture flush ordering, retry and timeout. [Streaming benchmark results](orukeet-benchmarks.md) report the deployed infrastructure measurements separately from desktop tests.

Before enabling the flag, accept the private backend route and metering, then verify microphone, hotkey, cleanup and single-paste behavior on signed macOS, Windows and Linux release builds. Automated Electron-boundary tests do not claim native OS acceptance. Roll back by restoring the previous `streamingProvider`; let active recordings finish. Track setup, stop-to-final, release-to-paste, queue time and fallback rate separately.
