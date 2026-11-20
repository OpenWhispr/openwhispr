---
phase: 06-hosted-services
plan: 01
subsystem: stt-api hosted services
status: complete
tags: [oauth-relay, web-search, tavily, fastify]
requirements: [FEAT-01, FEAT-02]
repo: finedesignz/edgeassistant-stt-api
branch: feat/p6-hosted-services
commits: 3
plan_head_before: ecdd53f
---

# Phase 6 Plan 01: Hosted services (stt-api) Summary

Slack/Linear OAuth loopback relay and a license-gated Tavily web-search proxy added to stt-api; no new npm package, no production config touched.

PR: https://github.com/finedesignz/edgeassistant-stt-api/pull/28

## Tasks

| Task | Result | Commit |
|------|--------|--------|
| 1 tracer: relay `GET /auth/{slack,linear}/callback` | done, 34 inject tests via buildApp | 5ad1efa |
| 2 web search `POST /v1/agent/web-search` (TDD, red then green) | done, 15 tests, stubbed fetch + injected clock | bf0b38d |
| 3 README + full suite + PR | README done; PR 28 opened; non-e2e suite has identical failure set vs origin/main (pre-existing, engine/asset dependent), no new failures | b69f8ed |

## Deviations

- **[Rule 1 - consistency]** Plan text says error bodies are `{error:<code>}`; the service's single error shape (api/errors.js, API-08) is `{error:{code,message}}`. Routes throw `ApiError`, so codes/statuses match D-05 but the body follows the repo shape. The desktop module (06-02) must read `error.code`.
- **[Rule 2 - correctness]** Added `FST_ERR_CTP_INVALID_JSON_BODY` to `FASTIFY_400_CODES` in api/errors.js so malformed JSON to the new route is 400 not 500. Identical one-line change exists in open PR #27 (same hunk), so it merges cleanly.
- `api/errors.js` is therefore in the diff beyond the plan's files_modified.
- Tavily key kept on a non-enumerable `config.webSearch.apiKey`, so `JSON.stringify(config)` cannot leak it.
- Operator and license principals: rate bucket keyed `license:<licenseId>` or one shared `operator` bucket. Rate limit counts only requests that passed body validation and have a configured key.

## Blockers / prod enable

- Tavily key exists in Proton Pass item `tavily` (field `api_key`). Not set in Coolify (deploy and env belong to 06-04). No credential is missing, so prod enable is NOT blocked, only not done here.
- Prove-in-prod still depends on B-1 (trusted cert on stt.titaniumlabs.us) and B-3 (a license key), per plan.

## Coolify env needed at deploy (app x1gsjcjrmssitgnh7hthg7nd)

- `TAVILY_API_KEY` (from Pass `tavily` `api_key`)
- `WEB_SEARCH_RATE_PER_MIN` optional, default 30

## Threat model

T-06-01..06 mitigations implemented and covered by tests (host fixed to 127.0.0.1, anchored state regex, port range, 4-key allow-list, repeated keys rejected, no-store + no-referrer, route behind authorizer, rate limit/caps/timeout, no query/key logging). No new threat surface beyond the plan.

## Known Stubs

None.
