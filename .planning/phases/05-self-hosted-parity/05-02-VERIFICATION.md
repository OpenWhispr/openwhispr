---
phase: 05-self-hosted-parity
plan: 05-02
verified: 2026-11-18
status: gaps_found
score: 5/6 must-haves verified
pr: finedesignz/edgeassistant#22 (feat/tiwh-p5-parity-desktop)
seats: claude (verifier) + codex (read-only, responded); agy not run
gaps:
  - truth: "Signing out of Titanium (or switching accounts) stops the meeting stream using the old license"
    status: failed
    reason: "stt-api-realtime is excluded from credentialGeneration and its connection key carries no identity; the prepare 'alreadyPrepared' path (ipcHandlers.js ~9207-9212) and start reuse (~9341-9345) return a warm socket without re-fetching the key. titaniumSession.signOut() (titaniumSession.js:207) only clears local state and nothing tears down the meeting sockets."
    artifacts:
      - path: src/helpers/meetingStreamingProviders.js
        issue: "LICENSE_PROVIDERS skips credentialGeneration; no Titanium session generation in key (line ~45-52)"
      - path: src/helpers/ipcHandlers.js
        issue: "warm-connection reuse never revalidates key; no titanium 'changed' listener disconnects _meetingMicStreaming/_meetingSystemStreaming"
    missing:
      - "On Titanium sign-out/account change (session 'changed' with generation bump) disconnect warm/active stt-api meeting streams"
      - "Include session generation (not the key) in the connection key, or re-check titaniumServiceKeyFor() before reusing warm streams"
      - "Test: sign out after prepare => next prepare/start rejects with TITANIUM_SIGN_IN_REQUIRED"
---

# 05-02 Verification (desktop parity, PR #22)

Verdict: PARTIAL. Do not mark phase 5 desktop done until the sign-out gap is closed.

## Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | License key is bearer only, to allow-listed hosts only | VERIFIED | `sttApiStreaming.js:100-102` Authorization header; URL has no query (`sttApiStreamPolicy.js:20-36`); host gated by `titaniumHosts.js:21-29` + `titaniumIpc.js:62-65`; connection key excludes key (`meetingStreamingProviders.js:45-50`); ws errors log message only (`sttApiStreaming.js:125,136`) |
| 2 | Key never logged | PARTIAL (warning) | New code clean. But cleanup now feeds the license to the Custom provider, and pre-existing `inferenceProviders/openai.ts:234` logs `apiKey.substring(0,8)` (`apiKeyPreview`) at debug. Prefix is the near-constant `key/...` head, low entropy, still violates "never logged" |
| 3 | Subprotocol `stt-segments`, frames match server PR #27 | VERIFIED | client offers/enforces it (`sttApiStreaming.js:99,106`); PR #27 diff has `handleProtocols`, `{type:"segment",index,text,final}`, `POST /v1/chat/completions`; error frame `{type:"error",error:{code,message}}` matches `api/streamRoute.js:69` |
| 4 | Meeting stream reconnect / sign-out | FAILED | see gap. Connection loss notifies `onConnectionLost` (`:179-184`), but sign-out leaves warm socket + 3 s silence keepalive (`:154-170`) alive; account switch reuses the old account's socket. Codex rated P1. Also P2: cancel of a prepared-but-unrecorded stream leaves keepalive running (`ipcHandlers.js ~9240`) |
| 5 | No BYOK regression | VERIFIED w/ warning | stored cleanup key wins (`cleanupAuth.ts:14-18`); stored settings respected. Warning: `settingsStore.ts` defaults `cleanupProvider` to `custom` (our server) when cloud disabled; defaults are not persisted (readString), so an existing install that never chose a cleanup provider and relies on an OpenAI key now routes cleanup to our server and is skipped when signed out (`ReasoningService.ts ~1419-1429`). Same pattern as phase 1a transcription default |
| 6 | i18n all locales | VERIFIED | `notes.meeting.titaniumSignInRequired` present in all 11 locales (ar de en es fr it ja pt ru zh-CN zh-TW); `npm run i18n:check` passes |

## Tests / CI
- 9 changed/related test files: 85 pass, 0 fail (`node --import tsx --test ...`).
- `gh pr checks 22 --repo finedesignz/edgeassistant`: all pass (quality, build-windows, CodeQL, lockfile-lint, coord-integrity).
- No new failures vs origin/main observed. No test covers sign-out-after-prepare (the gap).

## Findings
- BLOCKER (phase goal): sign-out/account-switch reuse of warm stt-api meeting sockets (above).
- WARNING: license prefix in debug log `openai.ts:234`; keepalive survives cancelled prepare; BYOK default flip for untouched cleanup settings.
- Server contract dependency: desktop assumes PR #27 merged (subprotocol, chat/completions); not yet on stt-api main.

Verifier: Claude (gsd-verifier) + codex read-only seat.
