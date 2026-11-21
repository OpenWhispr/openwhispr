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


## Re-verification 2026-11-20

Scope: branch feat/tiwh-v1-gaps (origin/main + PR #28), fix commits dd60d0194, 11b0aba0e, ed1b2d645. Single Claude verifier, goal-backward from the original gap plus the PARTIAL warnings. Tests run one file at a time (`node --import ./test/setup/forkEnv.js --import tsx --test --test-force-exit <file>`); a combined 11-file run showed 17 spurious failures from process contention that all pass alone, so only per-file results are cited.

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 4 (gap) | Sign-out / account switch stops or invalidates warm and live stt-api meeting sockets | PASS (helper-level) | `meetingStreamingProviders.js` adds `licenseFingerprint` (sha256 prefix, never the key) as `credentialIdentity` in the connection key, plus `isSttApiConnectionStale` / `isSttApiConnectionKey`. `ipcHandlers.js:230-236` re-reads the fingerprint per prepare/start, so the warm-reuse compare at `:9289-9298` and `:9403-9430` fails after sign-out and the next start falls to `realtimeTokenProviders.js:92-96`, which returns `TITANIUM_SIGN_IN_REQUIRED` when signed out. `onTitaniumStateChanged(...)` at `ipcHandlers.js:8967` calls `dropSttApiMeetingStreams` (disconnect mic+system, one `signInExpired` fatal for an active recording). `titaniumIpc.js` fans `session.on("changed")` out to main-process listeners. Tests: meetingStreamingProviders 16/16 (incl. "stale after sign-out or an account change", "license fingerprint, never the key"), titaniumStateListeners 3/3. Caveat: the `ipcHandlers` wiring itself (prepare after sign-out rejects) has no integration test; helpers are unit-tested only. |
| P2 | Cancelled prepare leaves keepalive running | PASS | `meeting-transcription-cancel` drops an unrecorded stt-api stream (`ipcHandlers.js ~9283-9290`); `sttApiStreaming.js` open handler refuses to arm keep-alive when `this.ws !== socket` and the interval self-stops when the socket is superseded. sttApiStreaming 12/12. |
| 2 | Key never logged | PASS | `openai.ts` `apiKeyPreview` line removed (dd60d0194). titaniumStateListeners test "cleanup request path never logs any part of the key" passes. |
| 5 | No BYOK regression | PASS (code), test FAILING | Store defaults reverted (`settingsStore.ts` cleanupProvider "openai", OpenAI base URL, model ""). Cleanup moves to our server only via the `forkCleanupSeed.ts` sign-in seed, gated by `shouldSeedSttApiCleanup` (licensed, no stored provider/url/model, mode unset or "providers", no BYOK key across 15+ key fields incl. per-scope custom keys) and only after `areSecretsHydrated()` (11b0aba0e). Wired: `useSettings.ts:144 startCleanupSeeding`. |
| 1,3,6 | Bearer-only/allow-listed, frame contract, i18n | PASS (unchanged) | Not touched by the fixes; `titaniumServiceKey` 6/6. |

Defects found on re-verification:
- WARNING (CI-visible): `test/services/cleanupAuth.test.js` "a fresh signed-in install is seeded onto our server and persists the choice" FAILS (`false !== true` at :169), reproduced alone and consistently. Cause: commit 11b0aba0e added the `areSecretsHydrated()` guard to `seedSttApiCleanup` but did not update the test harness (`loadSeed` never hydrates secrets). Pre-existing on origin/main (PR #28 does not touch these files); NOT in the known-failure list (byokSavedConfig). The sibling tests ("stored provider never overwritten", "BYOK never changed", "signed-out keeps default") now pass vacuously because the seed returns false before any check, so they no longer prove their invariants. No test covers the hydration guard itself.
- Server dependency from the original report (stt-api PR #27 on stt-api main) not re-checked in this pass.

Score: 6/6 truths hold in code; behavior_unverified: 1 (ipcHandlers sign-out wiring, helper-level evidence only).

Ship verdict: PASS-WITH-FIX. The original BLOCKER (sign-out reuse) is closed. Fix the stale cleanupAuth seed test (hydrate secrets in `loadSeed`, add a test that an un-hydrated seed returns false) so the BYOK-invariant tests are meaningful again and CI quality is not red from it.

Verifier: Claude (gsd-verifier), re-verification.
