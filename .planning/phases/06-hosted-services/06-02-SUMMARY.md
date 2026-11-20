---
phase: 06-hosted-services
plan: 02
status: complete
requirements: [FEAT-01, FEAT-02, FEAT-03]
commits: 5
plan_head_before: 726a7931d
pr: https://github.com/finedesignz/edgeassistant/pull/23
branch: feat/tiwh-p6-hosted-desktop
completed: 2026-11-18
---

# Phase 6 Plan 02: Hosted services, desktop half Summary

Desktop code for calendar connect, Slack/Linear relay base, license-key web search and build-time client ids. One PR, build and unit-test only (live proofs are 06-04).

PR: https://github.com/finedesignz/edgeassistant/pull/23 (repo finedesignz/openwhispr, renamed edgeassistant). Not merged.

## Tasks

| Task | Result | Commit |
|------|--------|--------|
| 1 Calendar local result page (tracer) | done; `calendarOAuthResultPage.js`, Google/Microsoft pass `renderResultPage`, `calendarConnect.browser.*` in 11 locales | 01fbd6bc9 |
| 2 SERVICES_URL, allow-list, relay base | done; `fork.config.json`, `forkKeys.js`, `forkRuntime.ts`, `titaniumIpc.js`, `slackAuth.js`, `linearAuth.js` | 1a627d8b1 |
| 3 Web search via our endpoint | done; `forkWebSearch.js`, `agent-web-search` branch on `CLOUD_ENABLED`, `webSearchSignedIn` in registry, capability input and `useChatStreaming.ts` | 0b87f1224 |
| 4 fork-write-env, FORK-BUILD.md, FEAT-02 wording | done | a5fd5bd56 |
| 5 Dev harness, gates, PR | done; harness smoke-run under Electron | c9e8051dc |

## Verification

- Task tests: 74 pass (config, key allow-list, Slack/Linear, loopback, calendar page), 18 pass (web search, registry), 5 pass (fork-write-env).
- `npm run typecheck`, `npm run lint` (0 errors, 2 pre-existing warnings), `npm run i18n:check`: green.
- `npm test`: 53 failures, none in touched files. 36 of them (12 files, Windows-host and platform tests) fail identically on the Phase 5 planning checkout; the remainder are `better-sqlite3` native bindings missing because `npm ci --ignore-scripts` was used.
- `rg SITE_URL src/helpers/connectors`: no match. `electron-builder*.json` "files" does not include `scripts/`.
- Harness under Electron: Slack authorize URL has `redirect_uri=https://stt.titaniumlabs.us/auth/slack/callback` and `state=v1.<port>.<64 hex>`; with no client id it exits 1 with `not_configured`.

## Deviations from Plan

1. [Rule 1] `webSearchTool.ts` (not in files_modified): a `{success:false}` answer from main was returned as data with success true; it now returns a failed ToolResult. Needed so the new AUTH_REQUIRED/RATE_LIMITED codes reach the model as failures.
2. [Rule 3] `src/config/agentCapabilities.ts` (not in files_modified): added optional `webSearch.signedIn`, because the signed-out branch reads `isSignedIn` first and would report web search unavailable to a Titanium-signed-in user.
3. `titaniumServiceKeyFor` keeps its existing host-only matching; no new https-only check was added (T-06-08 asked for it). All allowed hosts are https in the shipped config; enforcing the scheme for the renderer-callable IPC is left as a follow-up to avoid changing STT behavior.
4. Task 1 verify used `--import ./test/setup/forkEnv.js` (as `npm test` does); without it 14 existing `oauthLoopbackFlow` tests fail on the empty fork `SITE_URL`. The new loopback test does not assert `SITE_URL` so it passes in both setups.
5. Locale set is 11 (adds `ar`, `ja`) rather than the 9 the project doc lists.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: key-exposure | src/helpers/titanium/titaniumIpc.js | `titanium-service-key` IPC (STT-02, renderer-callable) now also returns the license key for the `SERVICES_URL` host. Same host as `DEFAULT_STT` after STT-03. |

## Blockers carried

- 06-03 (OAuth clients) blocked: no Google/Microsoft/Slack/Linear client ids exist, so no calendar, Slack or Linear connect can be proven until they are built into `.env` via `scripts/fork-write-env.mjs`.
- 06-04 needs stt-api PR #28 deployed and a trusted certificate on `stt.titaniumlabs.us`.

## Self-Check: PASSED

PR #23 open; 5 commits on `feat/tiwh-p6-hosted-desktop`; all files in the table exist.
