---
phase: 05-self-hosted-parity
plan: 02
status: partial
repo: finedesignz/edgeassistant
pr: https://github.com/finedesignz/edgeassistant/pull/22
branch: feat/tiwh-p5-parity-desktop
requirements: [STT-05, STT-06, STT-07]
commits: 6
plan_head_before: 726a7931deff17701ebc2f77a645b12fd5c98a5c
---

# Phase 5 Plan 02: Self-hosted parity (desktop) Summary

Desktop wiring for meetings, live preview, uploads with timestamps/speakers and cleanup on our stt-api server, built and tested against local mock servers implementing the 05-01 contracts (PR #22, not merged).

## Task status

| Task | Status | Notes |
|------|--------|-------|
| 1 Tracer | DONE | `titaniumHosts.js`, `sttApiStreamPolicy.js`, `sttApiStreaming.js`, `stt-api-realtime` registration, routing, store, token provider. 50 tests green (mock WS asserts bearer header, `stt-segments`, even-length 16 kHz frames, ordered segment callbacks). |
| 2 Sign-in message | DONE | New key `notes.meeting.titaniumSignInRequired` in all 11 locales; `i18n:check` green. |
| 3 Preview | DONE | Worklet gating + `stt-api` branch in `start-dictation-preview`; batch commit path untouched. |
| 4 Scribe uploads | DONE | `scribeSegments.js` (13 tests with uploadTimestamps), handler branch posts to `<base>/speech-to-text`. |
| 5 Cleanup defaults | DONE | `forkDefaults`, `settingsStore`, `cleanupAuth.ts`, `ReasoningService`; isAvailable tests via the renderer harness. |
| 6 Prove against prod | DEFERRED-TO-ORCHESTRATOR | Needs stt-api #27 merged and deployed, plus B2/B3. `scripts/fork/prove-stt-parity.mjs` not written. |

## Deviations from plan

- **Sentinel name (Rule 1):** the plan reused `signInRequired`, but that sentinel and key already exist for the OpenWhispr cloud account (message "Note Recording requires you to be signed in", action reloads into cloud sign-in). Added a distinct sentinel `titaniumSignInRequired` / key `notes.meeting.titaniumSignInRequired` (text per plan, `{{brand}}` via i18n default variables) whose action calls `titaniumAuthSignIn`. Main raises code `TITANIUM_SIGN_IN_REQUIRED`; `isSignInRefusal` includes it so a mid-recording renewal shows the existing "sign-in expired" message.
- **Routing premise (Rule 1):** the fork default for `meetingTranscriptionMode` is `providers` (not `self-hosted`), so the Custom-on-our-host default threw `unsupportedProvider:custom`. `resolveMeetingTranscriptionOptions` now routes both `self-hosted` and `providers` + `custom` on a Titanium host to `stt-api-realtime`.
- **Connection key:** the plan had `getMeetingConnectionKey` embed `titaniumServiceKeyFor(...)`. That module requires electron (breaks the plain-node test) and would put the license in a comparison string. Instead the key includes `baseUrl`, and `stt-api-realtime` is exempt from credential-generation binding; the license is fetched in `REALTIME_TOKEN_PROVIDERS` (`titaniumServiceKeyFor` injected from ipcHandlers). Known limit: a warm meeting connection opened under an earlier license is not invalidated by sign-out/in until it drops.
- **Preview adapter:** `createSttApiPreviewStream` (in `sttApiStreaming.js`) gives the existing `dictationPreviewStream` slot its `sendPcm16/abort/finish` shape; `finish()` always reports `truncated:false`, which is safe because only `_streamingCommitActive` (false on this route) consumes `streamed`.
- **Closing segment:** a segment the server left open (`final:false`) is committed once at the closing `final` frame so tail words are not lost; the final frame text is never re-emitted.
- **Scribe mapping:** the Scribe response is rewritten to `{text, segments}` so the existing diarize and timestamps branches format it (speaker ids pass through verbatim like the Mistral branch). Only taken when the endpoint ends `/audio/transcriptions` (otherwise the plain POST).
- **openai.ts probe check (D-04):** confirmed a base ending `/chat/completions` yields a single chat candidate and `detectServerType` returns early, so no `/models` or `/responses` request.
- **Test fallout fixed:** `forkRebrand.test.js` pins the exact `import { BRAND_NAME } from "../config/forkRuntime"` line; the new constants use a second import. `meetingStreamingProviders.test.js` closure test updated for the new provider (baseUrl + license dep).
- **Commit trailer:** Sonnet 5.5 (actual model), per the harness attribution reminder, not Opus 5.5 from rules.txt.

## Checks

- Touched test set: 99/99 pass. `typecheck` clean, `lint` 0 errors (4+2 pre-existing warnings), `i18n:check` green.
- Full `npm test`: 54 failures; every one also fails on origin/main (Windows: hotkeyStartup, noteCreateReconciliation, metaActivation, forkWorkflows, tar, cosmic...). One new failure from this branch (forkRebrand import pin) was fixed.

## Unverified / needs orchestrator

- Real end-to-end against prod (meeting segments, preview, upload, cleanup): blocked on #27 deploy, streaming engine (B2), Titanium license (B3).
- UI flows not driven in the running app (no Task 6).

## Tickets

None filed. A PostToolUse circuit-breaker fired on lint output "(0 errors, N warnings)"; not an error, ignored.

## Self-Check: PASSED (PR #22 exists, 6 commits pushed on feat/tiwh-p5-parity-desktop)
