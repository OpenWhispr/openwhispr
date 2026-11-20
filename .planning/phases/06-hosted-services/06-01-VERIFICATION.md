---
phase: 06-hosted-services
plan: 06-01
verified: 2026-11-18
status: passed
score: all security must-haves verified; 0 blockers
pr: finedesignz/edgeassistant-stt-api#28 (feat/p6-hosted-services)
seats: claude (verifier) + codex (read-only, responded); agy not run
---

# 06-01 Verification (OAuth relay + web search, PR #28)

Verdict: PASS (ship), with non-blocking hardening notes.

## OAuth relay GET /auth/{slack,linear}/callback (public)

| Check | Status | Evidence |
|-------|--------|----------|
| Redirect only to http://127.0.0.1:<port>/<provider>/callback | VERIFIED | host literal, provider from route constant (`api/oauthRelayRoute.js:38`); never from request |
| State format v1.<port>.<64 hex> anchored | VERIFIED | `STATE_RE` line 18; fuzz (app.inject, real buildApp): `v1.0080.`, `v1.1023.`, `v1.65536.`, `v1.99999.`, `v1.1024@evil.com.`, `v1.5.5.5.`, trailing `\n`/`x`, uppercase `V1`/hex, `%35` encodings, leading space, array/duplicate `state`, missing state => all 400, no Location. `01024`, `1024`, `65535`, `51234` => 302 to 127.0.0.1 only |
| Port bounds 1024..65535 | VERIFIED | lines 21-22, 36 |
| Forward only code/state/error/error_description, strings, <=4096, dup keys rejected | VERIFIED | lines 19-20, 39-44; URLSearchParams encodes CR/LF (no header injection) |
| code/state not logged | VERIFIED | fuzz with a real pino stream: sentinel code and nonce absent from log output; `Cache-Control: no-store`, `Referrer-Policy: no-referrer` set (line 52) |
| Public exemption narrow | VERIFIED | `api/app.js` PUBLIC_ROUTES adds exactly the two GETs |

Codex's LOW note that `$` admits a trailing newline is not reproducible in JS (no `m` flag; fuzz returned 400).

## Web search POST /v1/agent/web-search

| Check | Status | Evidence |
|-------|--------|----------|
| Auth required | VERIFIED | not in PUBLIC_ROUTES; unauthenticated => 401 `{"error":{"code":"unauthorized",...}}` |
| Rate limit | VERIFIED | per license id / shared operator bucket, fixed 60 s window (`webSearchRoute.js:46-71`); counted after validation; 429 + Retry-After |
| Tavily key never echoed | VERIFIED | `config.js` non-enumerable `apiKey`; only in outbound Authorization header (line 110); static error messages; logs carry status/name only |
| Error shape | VERIFIED | all via `ApiError` => `{error:{code,message}}`; codes 400/429/502/503/504; `FST_ERR_CTP_INVALID_JSON_BODY` mapped to 400 |
| Tests | VERIFIED | `node --test test/api/oauthRelayRoute.test.js test/api/webSearchRoute.test.js`: 50 pass, 0 fail |

## Non-blocking findings (WARNING)
- `webSearchRoute.js:133` buffers the Tavily body with no byte cap; fields uncapped (codex MEDIUM). Trusted upstream, but add a size limit / truncate `text`.
- `webSearchRoute.js:49-58` bucket map swept only above 1024 entries, no hard cap (LOW, needs many authenticated principals).
- Web search results are untrusted text fed to an LLM tool: desktop must treat as data (prompt injection).
- PR #28 shows only `coord-integrity` as a check; no test CI ran on the PR, tests were run locally here.

Verifier: Claude (gsd-verifier) + codex read-only seat.
