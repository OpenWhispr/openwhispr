---
phase: 05-self-hosted-parity
plan: 01
verified: 2026-11-18T22:30:00Z
status: gaps_found
score: 5/7 must-haves verified
reviewed_sha: d889669f09f4fa1a1099f7ddac980db0ffe1a9eb
pr: https://github.com/finedesignz/edgeassistant-stt-api/pull/27
qc_verdict: CONTENT BLOCK
seats: [claude-verifier, codex (responded, read-only)]
gaps:
  - truth: "POST /v1/chat/completions cannot be used to disable the shared cleanup service"
    status: failed
    reason: "classify() flags any successful CLI output matching AUTH_PHRASE_RE (unauthorized, revoked, not logged in, ...) as cleanup_auth_invalid even with exit 0 and is_error false. complete() reports into shared cleanupHealth (service.js:~68-79), so a licensed caller who asks the model to answer 'unauthorized' sets auth.status=invalid; wrapCleanupRunner.checkPreflight then refuses ALL cleanup and chat completions (503) and nothing can clear it because recovery needs a call that passes preflight. Verified: classify({exitCode:0,json:{result:'... unauthorized',is_error:false}}) returns code cleanup_auth_invalid."
    artifacts:
      - path: "api/claudeCli.js"
        issue: "classify() lines ~74-76: AUTH_PHRASE_RE.test(resultText) applied to successful model text"
      - path: "api/service.js"
        issue: "complete() wrapper ~68-79 records caller-controlled outcome into cleanupHealth"
    missing:
      - "Only treat phrase matches as auth failure when is_error===true or exitCode!==0 (and never from a 200 result text); do not record complete() text-derived outcomes as credential verdicts; add test with exit 0 result 'unauthorized'"
  - truth: "WS subprotocol change is backward compatible for existing clients"
    status: partial
    reason: "handleProtocols returns false for any offer not containing stt-segments. Previously ws selected the first offered protocol. A `ws` client that offers any other subprotocol now rejects the handshake ('Server sent no subprotocol', ws websocket.js:975). Test (c) uses a raw http upgrade, so it does not exercise a real ws client. Clients offering no protocol are unchanged. No in-repo stt-api client offers a protocol today, but orukeetStreaming.js offers [protocol, auth.<token>] on its cloud path."
    artifacts:
      - path: "api/streamRoute.js"
        issue: "lines ~85-92 handleProtocols"
    missing:
      - "Fall back to ws default (first offered) when stt-segments is absent, or document + test with a real ws client offering an unknown protocol"
---

# Phase 5 Plan 05-01 (server): Verification

QC gate + rule-13 verifier for stt-api PR #27 at d889669f0. Verdict: CONTENT BLOCK (1 HIGH, 1 MEDIUM). Focus per brief: security of /v1/chat/completions and WS subprotocol compat.

## Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Route requires auth (operator token or license bearer) | VERIFIED | Route registered after global `onRequest` hook (`app.js:180-205`); `PUBLIC_ROUTES` = only `GET /healthz`; unmatched route cannot masquerade. Test "no bearer or bad bearer -> 401" passes. |
| 2 | Input caps | VERIFIED (LOW note) | `validateChatBody`: exactly system+user string messages, 32,000 char cap, 512 KB bodyLimit, refuses tools/functions/stream/n>1. LOW: NUL byte in content is not rejected; `spawn` throws ERR_INVALID_ARG_VALUE (verified) -> caller gets 503 `cleanup_cli_unavailable` and `lastErrorCode` is written to health. Should be 400. |
| 3 | No tool-use / injection escalation in the CLI call | VERIFIED | `buildArgv`: `--tools ""`, `--safe-mode`, `--no-session-persistence`, caller system prompt is the LAST argv element; env allowlist (PATH/HOME/TMP/CLAUDE_CONFIG_DIR/token only), throwaway config/home/cwd; user text via stdin. Tests assert identical argv/env to cleanup(). |
| 4 | No secret leakage | VERIFIED | `sanitizeCleanupError` returns fixed bodies; logs carry counts/outcome only; test asserts no content or Authorization in logs. |
| 5 | Concurrency / abuse bound | PARTIAL (WARNING) | Semaphore 3 running + 8 queued, slot released on error/timeout/abort (tests). No per-principal quota; any license holder can run arbitrary system prompts on the operator's Claude subscription. `max_tokens` is computed (`parsed.maxTokens`) but never enforced and CLI stdout/stderr buffered without a byte cap (`claudeCli.js:~250-254`); documented in README as unenforceable. |
| 6 | Service-wide availability not controllable by callers | FAILED | See gap 1. |
| 7 | WS subprotocol backward compatible; segment frames only when negotiated | PARTIAL | `segment` frames sent only when `stt-segments` offered (`streamRoute.js:~228-242`); no-protocol clients unchanged; see gap 2 for offered-other-protocol clients. |

## Tests

- New + related suites (chatCompletionsRoute, claudeCliComplete, scribeDesktopContract, streamSegments, cleanupRoute, claudeCli, auth): 66/66 pass.
- Full suite on the PR (500 s cap, 1 cancelled): failures in queuePolicy(6), requestValidation(1), service(3), streamRoute(10), diarizationParse(1). Same files fail on origin/main (queuePolicy 6, requestValidation 1, service 6, streamRoute 13 on re-run), so environmental. diarizationParse differs only because the PR worktree has git-ignored sherpa binaries under `resources/` that the clean main copy lacks (error text 'diarization models not downloaded' vs 'binary not found'); not caused by the diff.
- Existing streamRoute e2e cannot run green on this host, so WS backward compat is proven only by hermetic tests.
- GitHub checks on the PR: only `coord-integrity` (pass). No code CI.

## Codex seat (read-only, responded)

HIGH service.js:78/claudeCli.js:80 (confirmed, gap 1); MEDIUM streamRoute.js:92 (confirmed, gap 2); MEDIUM chatCompletionsRoute.js:134 maxTokens unenforced + unbounded stdout buffer (confirmed, WARNING). Seats: Claude + Codex; agy not run (scope cap).

## Ship verdict

CONTENT BLOCK. Fix gap 1 (health poisoning) and gap 2 (protocol selection or documented break with real-client test), add a NUL-byte 400, then re-QC the new SHA before merge/deploy.
