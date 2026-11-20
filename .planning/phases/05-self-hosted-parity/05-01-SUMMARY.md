---
phase: 05-self-hosted-parity
plan: 01
status: partial
repo: finedesignz/openwhispr-stt-api
pr: https://github.com/finedesignz/edgeassistant-stt-api/pull/27
branch: feat/p5-parity
requirements: [STT-05, STT-06, STT-07]
commits: 4
plan_head_before: ecdd53f
---

# Phase 5 Plan 01: Self-hosted parity (server) Summary

Server wire contracts for Phase 5 built and pushed in PR #27 (not merged, not deployed): segment frames behind subprotocol `stt-segments`, `POST /v1/chat/completions`, pinned Scribe desktop contract, prod verify scripts.

## Task status

| Task | Status | Notes |
|------|--------|-------|
| 1 Tracer: segment frames | DONE | `onSegment` from `createOnlineAccumulator`, threaded through `createOnlineStream` and `engine.openStream`; `handleProtocols` selects only exact `stt-segments`. 5 tests pass (with / without / unknown subprotocol, accumulator unit, 960-segment long stream). |
| 2 /v1/chat/completions | DONE | `claudeCli.complete()` sharing `run()` with `cleanup()`; route + 10 route tests + 6 claudeCli tests; existing cleanup tests unmodified and green. |
| 3 Scribe contract + README | DONE | 3 contract tests, no route change needed; README documents all three contracts. |
| 4 Prod readiness | PARTIAL | B1 re-checked and resolved (evidence below). Verify scripts written. B2 (streaming engine on prod) NOT configured: needs env + capacity check at deploy (see PR body). |
| 5 Prove against prod | DEFERRED-TO-ORCHESTRATOR | Runs after merge + deploy with the env below. |

## B1 evidence (2026-11-18, `curl https://stt.titaniumlabs.us/healthz`)
`engines.offline`: model parakeet-unified-en-0.6b, state `warm` (the repo's ready state is `warm`, not `ready`), pool live 1, `crashes_total` 0, `respawn_failures_total` 0. cleanup configured, auth valid; diarization enabled and available. No `engines.online` entry yet (B2). Root cause per orchestrator: Coolify `limits_memory` 256m vs 2048m reservation; set to 4096m. No code change made for B1.

## Deviations from plan
- **Stale checkout:** plan paths verified against the fresh worktree. Test files live in `test/api/` (not `test/`), verify scripts are `.mjs` (repo convention), not `.js`.
- **Scribe diarization-off status is 400, not 503:** actual behavior is `400 diarization_not_enabled`; test pins reality. `speaker_id` is a string like `speaker_0` (matches plan's prod check).
- **No "shared cleanup concurrency limit" existed:** in-band cleanup rides the engine pool's admission. Added a bounded semaphore to `complete()` only (3 running, 8 queued, then 503 `cleanup_busy`).
- **argv left unchanged:** `buildArgv` already has `--tools ""`, `--safe-mode`, `--no-session-persistence` and a throwaway config/home tree (no MCP). The plan said to add restrictions only if missing; the argv is documented as locked, so none added. Asserted in tests (T-05-06).
- **`temperature` / `max_tokens`** are validated and clamped but cannot be enforced (CLI has no such flag). Documented in README and PR.
- **Per-stream cap:** `openStream` has no audio duration/sample cap (recorded as the plan asked); a 960-segment (about 4 h) test proves frames keep flowing.
- **Extra fix (Rule 1):** malformed JSON bodies returned 500; added `FST_ERR_CTP_INVALID_JSON_BODY` to the 400 set in `api/errors.js`.
- **Commit trailer:** Co-Authored-By names Sonnet 5.5 (the actual model), per the harness attribution reminder, not Opus 5.5 from rules.txt.

## Test results
New files: streamSegments 5/5, chatCompletionsRoute 10/10, claudeCliComplete 6/6, scribeDesktopContract 3/3. Related existing suites (cleanupRoute, cleanup.e2e, errorShape, auth, cleanupHealth, statusEndpoints, claudeCli, attribution) green. Full `npm test` on this Windows host has 11 pre-existing failures (queuePolicy x6, startService x3, requestValidation x1-2, etc.); a re-run of service/queuePolicy/requestValidation on a clean `origin/main` worktree failed the same 9 tests, so they are environmental, not from this change. The existing `streamRoute.test.js` e2e tests also need local sherpa binaries/weights and could not be run green here (the local weights dir lost nemotron after test runs); my stream tests are hermetic via an injected availability manager.

## Unverified
- Real sherpa online engine emitting real segment ids end to end (local weights absent at verify time; server logic is covered by the real accumulator with sherpa-shaped messages). Orchestrator prod run of `verify:stream-segments` is the proof.
- Prod memory headroom for the online pool (Coolify MCP gives no live usage).

## Prod config for deploy
`STT_STREAM_MODEL=nemotron-speech-streaming-en-0.6b`, `STT_STREAM_LANGUAGE=en`; weights auto-fetch on boot (about 464 MB); check container memory (currently 4096m) after boot. Titanium product id already set.

## Tickets
None filed (no tool errors beyond local environment issues).

## Self-Check: PASSED (PR exists, 4 commits on feat/p5-parity pushed)
