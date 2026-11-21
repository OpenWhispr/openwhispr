# PR #32 Verification (rule 13): grok seat hang and quota classification

Date: 2026-11-20. Branch `fix/grok-seat`, head 324f6f747 (verifier commit follows). Independent, code read plus one test run plus one live run. No login, no token printed.

## Grades

| # | Goal | Grade | Evidence |
|---|------|-------|----------|
| 1 | Grok child env disables imported Claude/Cursor MCPs, hooks, skills, rules, agents | PASS | `src/helpers/llmCliProviders.js:26-42` builds `GROK_{CLAUDE,CURSOR}_{MCPS,HOOKS,SKILLS,RULES,AGENTS}_ENABLED=0` (10 keys); applied at `:446`. Runner uses it for the spawn at `src/helpers/llmCli/llmCliRunner.js:144,152`. Tests `llmCliProviders.test.js:95-107`, `llmCliRunner.test.js:105-112`. |
| 2 | Overrides apply only to grok; scrubbing intact | PASS | `:446` is gated by `seat === "grok"`; scrub loop (`:424-432`) runs before the override and the new keys are not in `SCRUB_ENV_KEYS` (`:8-24`), so all API-key scrubbing is unchanged. Parent `process.env` is never mutated (`out` is a fresh object). Test asserts claude/codex/agy lack the keys; existing scrub test still green. |
| 3 | 402 "usage balance exhausted" / payment required -> `quota-or-rate-limit`; generic "usage balance" error is not | PASS | `QUOTA_RE` at `:904-905` adds `balance exhausted`, `insufficient (usage )?balance`, `payment required`. Tests `llmCliParsers.test.js:205-221` cover the 402 JSON, insufficient balance, and negatives ("Failed to retrieve usage balance: connection reset", ECONNRESET -> null). Runner close path (`llmCliRunner.js:283-287`) classifies stderr plus stdout tail. |
| 4 | UI never shows a silent hang; quota error is classified and localized | PASS | Runner terminates on first-output/idle/total limits with code `timeout` (`llmCliRunner.js:219-235`, `firstOutputMs` 30 s at `llmCliProviders.js:700`). Codes map via `errorMessageKey` (`llmCliSeatView.js:30-33`) in `cliChatModel.ts:52` and `LlmSubscriptionsSection.tsx:77`. `llmSubscriptions.errors.quota-or-rate-limit` and `timeout` exist in all 11 locale files that carry the block. |

## Commands run

- `node --import ./test/setup/forkEnv.js --import tsx --test llmCliParsers llmCliProviders llmCliRunner`: 76 tests, 76 pass, 0 fail.
- Live check through the repo's `createRunner` + `createDetector.resolveExe` (real `grok.exe`, prompt "Reply PONG", 45 s cap, windowsHide): returned in about 11 s with error class `quota-or-rate-limit`. No hang, no kill needed. (The account's Grok Build balance is exhausted, which is exactly the 402 path; a successful reply could not be observed, so the "structured reply in ~13 s" claim in the code comment is not independently reproduced here, but the no-hang behavior is.)

## Notes

- Non-blocking: the 402 classification was proven live end to end (CLI -> runner -> code), the localized message rendering was verified by code path only, not in a running window.
- Not covered: PRESENT_BEHAVIOR_UNVERIFIED none; the env-disable effect on a successful reply is not reproducible while the balance is exhausted.

## Ship verdict

SHIP. 4/4 PASS, no blockers.
