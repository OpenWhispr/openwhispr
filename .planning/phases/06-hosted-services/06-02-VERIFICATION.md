---
phase: 06-hosted-services
plan: 02
verified: 2026-11-18
status: gaps_found
verdict: CONTENT BLOCK (NEEDS-WORK)
reviewed: PR #23 head c9e8051dc (branch feat/tiwh-p6-hosted-desktop), base 726a7931d
seats: Claude verifier (this), Codex (responded, read-only). Grok and agy NOT run (time budget) = MISSING, not pass. 2 families responded.
gaps:
  - truth: "The license key is sent only to the DEFAULT_STT host and the SERVICES_URL host (plus TITANIUM.serviceHosts) and never over plaintext (D-03, D-06; threat T-06-08 mitigation: exact-host allow-list, https only)"
    status: failed
    reason: "titaniumServiceKeyFor matches hostname only. Scheme and port ignored. Reproduced: http://stt.titaniumlabs.us/..., https://stt.titaniumlabs.us:8443/..., ftp://stt.titaniumlabs.us/... all return the key. Allow-list also adds hostOf(forkConfig.SERVICES_URL), and SERVICES_URL is overridable (VITE_SERVICES_URL via env or dist/runtime-env.json, forkConfig.js resolveForkConfig), so config authorizes its own credential destination: SERVICES_URL=http://attacker.example makes web search send Bearer <license key> in cleartext to attacker.example. SUMMARY deviation 3 admits the https-only check was skipped."
    artifacts:
      - path: "src/helpers/titanium/titaniumIpc.js"
        issue: "line 71 host-only check, line 76 SERVICES_URL host self-authorizes; no protocol check"
      - path: "src/helpers/forkWebSearch.js"
        issue: "builds URL from servicesUrl with no https assertion before attaching Authorization"
    missing:
      - "In titaniumServiceKeyFor require new URL(url).protocol === 'https:' (reject http/ftp) and compare origin (host + default port) not bare hostname"
      - "Do not derive the allow-list from the overridable SERVICES_URL; pin owned hosts (DEFAULT_STT, TITANIUM.serviceHosts) or validate SERVICES_URL itself as https and in a fixed owned set; forkWebSearch should refuse a non-https servicesUrl"
      - "Tests: http://, :8443, ftp:// and non-owned SERVICES_URL override return null (plan behavior bullet 'https only' has no test)"
---

# Phase 6 Plan 06-02 Verification (desktop half)

**Goal:** calendars finish OAuth locally, Slack/Linear use our relay, web search uses our endpoint with the Titanium license key for Titanium-signed-in users, fork builds carry our client ids at build time. Code readiness only (client ids blocked on portal, 06-03).

**Status: gaps_found. One CONTENT BLOCK (license key transport). Everything else verified.**

## Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Calendar flow completes with SITE_URL empty, local 200 HTML page | VERIFIED | calendarOAuthResultPage.js:1-23; googleCalendarOAuth.js:27, microsoftCalendarOAuth.js:48 pass `renderResultPage`; oauthLoopbackFlow.js:7 SITE_URL desktop-callback only used when no renderResultPage; loopback test with empty SITE_URL passes (85/85 touched tests pass) |
| 2 | Slack/Linear redirect = SERVICES_URL/auth/{slack,linear}/callback, state v1.<port>.<nonce> | VERIFIED | slackAuth.js:19-20, linearAuth.js:33-34; state built at oauthLoopbackFlow.js:217; server stt-api PR #28 oauthRelayRoute STATE_RE `v1.<1024-65535>.<64 lowercase hex>` matches (nonce is 64 hex per harness smoke run). SERVICES_URL empty -> "" (not configured) |
| 3 | web_search POSTs ${SERVICES_URL}/v1/agent/web-search with license bearer; error codes | VERIFIED (path/codes) | forkWebSearch.js:28-47: POST, Bearer, `{query,numResults}`, no key -> AUTH_REQUIRED w/o fetch, 401/403 AUTH_EXPIRED, 429 RATE_LIMITED, 5xx/network SERVER_ERROR, no retry/second URL. Matches server errors (400/429/502/503/504). ipcHandlers.js:10343 branch on `!CLOUD_ENABLED`, cloud path untouched |
| 4 | Web search offered only when Titanium signed in | VERIFIED | tools/index.ts webSearchSignedIn gate; useChatStreaming.ts:429,460,488; agentCapabilities.ts `webSearch.signedIn`; webSearchRegistration tests pass |
| 5 | License key only to owned hosts, https only, never renderer | **FAILED** | See gap above. Key stays in main for web search (ok) but `titanium-service-key` IPC (preload.js:791) is renderer-callable and returns key for http/ftp/any-port on an allowed host |
| 6 | fork-write-env.mjs writes 5 keys, fail-closed, no values printed | VERIFIED | scripts/fork-write-env.mjs: stdout/stderr print key names only; missing/empty/unsafe -> exit 1, no write; preserves other lines; 5 tests pass |
| 7 | No upstream OpenWhispr client ids embedded | VERIFIED | git grep for googleusercontent/GOCSPX/xox/UUID-style ids in non-test, non-mobile source: no hits (only upstream-owned openwhispr-mobile, untouched). No .env committed (only .env.example) |

Score: 6/7. behavior_unverified: 0.

## Requirements

| Req | Status | Note |
|-----|--------|------|
| FEAT-01 (calendars) | PASS (code) | local result page; live proof needs client ids (06-03/04) |
| FEAT-02 (Slack/Linear relay) | PASS (code) | relay base + state format match server; live proof blocked on client ids |
| FEAT-03 (web search) | PARTIAL | functionally correct; credential-transport gap above blocks ship |

## Gates

- Touched tests: 85/85 pass (with `--import ./test/setup/forkEnv.js`).
- Full suite: 53 failures on PR head vs 53 on merge-base 726a7931d (same set, zero new, zero fixed); failures are Windows/platform + better-sqlite3 env.
- `npm run i18n:check`: consistent across all 11 locales.
- `gh pr checks 23`: CodeQL, lockfile-lint, coord-integrity, Mobile CI pass; `quality` was pending at check time.

## Other findings (WARNING, non-blocking)

- forkWebSearch.js does not validate that servicesUrl is https (same root cause as the block).
- Plan T-06-08 mitigation was declared "mitigate" and silently downgraded in SUMMARY deviation 3 ("follow-up"); a high-severity declared mitigation must not be deferred.

## Decision

CONTENT BLOCK. Fix titaniumServiceKeyFor (https-only, origin match, allow-list not derived from overridable config) with tests, push, re-QC. Not owner sign-off territory.
