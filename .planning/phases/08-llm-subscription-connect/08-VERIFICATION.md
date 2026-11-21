# Phase 8 Verification (self-gathered, pre rule-13 verifier)

Date: 2026-11-20. Branch `phase-08-llm-subscription-connect`, merged with origin/main (fa95e18f3). Evidence is automated only. No login was run, no token printed.

Test command (all green, 205 tests, 0 fail):
`node --import ./test/setup/forkEnv.js --import tsx --test "test/helpers/llmCli*.test.js" test/services/cliProviderRouting.test.js test/services/cliChatModel.test.js test/components/llmSubscriptionsSection.test.js test/helpers/titaniumOnboardingPolicy.test.js test/helpers/transcriptionAuth.test.js test/services/cleanupAuth.test.js test/utils/connectorEligibility.test.js`
Also: `npm run typecheck` clean, `npm run i18n:check` clean, `npm run lint` exit 0 (6 pre-existing warnings), `npm run format:check` exit 0.

Real-CLI proof: `node --import tsx scripts/fork/prove-llm-cli.mjs` exits 0.

| Seat | State | Version | Outcome | First output |
|------|-------|---------|---------|--------------|
| codex | signed-in | 0.157.0 | ok | 5.3 s |
| agy | installed (auth unknown) | 1.5.13 | ok | 10.0 s |
| grok | signed-in | 1.0.70 | KNOWN-HANG (idle timeout, bounded, 31.8 s) | none |
| claude | signed-out | - | skipped (no stored token) | - |
| Claude gate | pref off: `claude-disabled`; pref on: passes the gate (`not-signed-in`) | - | PASS | - |

Main-process load of the ESM policy module: `require()` of `llmCliProviders.js`, `llmCliDetect.js`, `llmCliIpc.js` under Electron 43.8.3's own Node 24.22 (`ELECTRON_RUN_AS_NODE`) succeeds, and the detector also loads from a packed `.asar`.

| Req | Verdict | Evidence |
|-----|---------|----------|
| LLM-01 detect, states | PASS | llmCliProviders, llmCliDetect, llmSubscriptionsSection tests; real detection of 4 seats in the proof script |
| LLM-02 consent install | PARTIAL | llmCliInstaller tests (fake installer). Real installer never run (see UNVERIFIED) |
| LLM-03 sign-in, tokens never leak | PARTIAL | llmCliParsers, llmCliSignIn, llmCliTokenStore tests (canary token). No real sign-in run, by design |
| LLM-04 runs, timeouts, classified errors | PASS | llmCliRunner tests (12); real runs codex ok, agy ok, grok bounded hang |
| LLM-05 Claude gate | PASS | llmCliIpc tests; proof script drives the real IPC adapter: off refused, on passes the gate |
| LLM-06 scope-gated pickers | PASS (code level) | cliProviderRouting, cliChatModel tests. Rendered picker not seen (see UNVERIFIED) |
| LLM-07 sign-out | PARTIAL | llmCliSignIn tests; `codex logout --help` probe only. Not run live |
| LLM-08 i18n, IPC parity, icons | PASS | i18n:check, llmSubscriptionsSection sweep tests, IPC parity test |
| LLM-09 BYOK unchanged | PASS | sweep test for BYOK parity, secretKeys and inferenceProviderIds tests |

## UNVERIFIED (what was checked and how)

- VERIFIED 2026-11-20 (agent-run, dev app on staging channel, Playwright over CDP; no sign-in or install clicked): Subscriptions section lists the four seats with detection state (Claude off/no status, Codex Signed in v0.157.0, Grok Signed in v1.0.70, Antigravity Installed v1.5.13) -> `evidence/01-subscriptions-seats.png`; Claude seat off by default, toggle on shows the Anthropic terms notice and status "Signed out v2.1.330" -> `evidence/02-claude-toggle-on-notice.png`, toggled back off -> `evidence/03-claude-toggle-off-again.png`; Dictation Cleanup provider list shows only OpenAI, Anthropic, Google Gemini, Groq, OpenRouter, Tinfoil, Corti, Custom, no CLI providers -> `evidence/04-cleanup-picker-no-cli.png`; Chat picker carries the "Subscription CLIs" group (text-level check) -> `evidence/05-chat-picker.png`. Setup note: the dev app was launched with `OPENWHISPR_CHANNEL=staging`, `VITE_DEV_SERVER_PORT=5291`, `OW_DEBUG_CDP=9477` because another session's app held the development single-instance lock and port 5183; localStorage `onboardingCompleted` and `authenticationSkipped` were set in the staging profile to reach Settings. Still NOT DONE: a chat answered through a seat, the consent dialog, the Codex sign-out confirm (not exercised, would act on live logins/installs).
- Earlier note (superseded for the items above): in-app proof was NOT DONE because the dev app did not start from this worktree: `better_sqlite3.node` was built for NODE_MODULE_VERSION 137 and Electron 43.8.3 needs 148 (log from `electron . --dev`, channel staging). Rebuilding the native module against Electron would break the system-Node test run, so it was not done. AgentAutofix annotation 3d49c944-3c97-49a8-bf4f-71b93ca6b245. The consent dialog is covered by the view-model test only. LLM-01/06 UI and the chat-through-a-seat path are therefore code-level only.
- Installer run on a clean Windows machine and antivirus behavior: not run (all four CLIs already installed; the run would modify this PC).
- grok `-p` hang root cause: observed hang (no output until the idle limit, 4 runs, about 30 s each); cause not investigated. Bounded by the idle timeout, no workaround added.
- agy headless sign-in: no flag exists; only the run-agy-once guide is implemented. agy answered here because a Google sign-in already exists on this PC.
- Windows publisher check for codex and agy installs: enforced (`publisherCheck: "enforce"`, `llmCliInstaller.js`); the Authenticode subject must have exactly one CN equal to the expected publisher and every O equal to it (`subjectMatchesPublisher`). Not run against a real vendor installer on a clean machine.
- Packaged build loading the ESM module via require(esm) from the real app.asar: only a test asar was checked.

---

## Rule-13 independent verification

Verifier: independent agent (Sonnet 5.5), 2026-11-20. Head `3c0552a24`, `git diff origin/main...HEAD` (78 files). The implementer SUMMARYs and the section above were treated as leads and re-checked against the code.

Test run (once): `node --import ./test/setup/forkEnv.js --import tsx --test` with all `test/helpers/llmCli*.test.js` files listed explicitly: tests 128, pass 128, fail 0 (7.6 s). No better-sqlite3 / Electron-ABI load failure occurred under system Node, so there is nothing to report separately.

### Must-check items

| # | Check | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | No API-key field on the CLI path | PASS | No `apiKey`/`API_KEY` text in `src/helpers/llmCli/*.js`, `LlmSubscriptionsSection.tsx`, `CliProviderPicker.tsx`, `cliChatModel.ts`. `buildChildEnv` strips all LLM key/gateway vars (`llmCliProviders.js:408-430`, `SCRUB_ENV_KEYS`); codex status refuses API-key login (`:432-436`). Screenshot 01 copy: "No API keys are involved." |
| 2 | Token never reaches renderer or logs | PASS (code and canary tests; no live sign-in) | Token only read in main via `tokenStore.load()` (`llmCliIpc.js:216`) and injected as `CLAUDE_CODE_OAUTH_TOKEN` only for the claude seat (`llmCliProviders.js:408-424`). Sign-in IPC emits only `{seat, ok, code}` (`llmCliIpc.js:92-100`). Log calls carry only an error code (`llmCliSignIn.js:109`, `llmCliIpc.js:176`). No `process.env` write of the token. `llmCliSignIn` and `llmCliTokenStore` tests use a canary and pass. |
| 3 | Claude seat off by default | PASS | Default `claudeEnabled:false` (`llmCliPrefs.js:6`); `isSeatEnabled` (`llmCliProviders.js:537-538`); main-side gate on test, sign-in start and stream (`llmCliIpc.js:42-46,74,94,135`). Screenshots 01-03: toggle off, notice on enable, back off. |
| 4 | CLIs absent from cleanup | PASS | `CLI_SCOPE_ALLOWLIST = [chatIntelligence, dictationAgent]` (`llmCliProviders.js:543`); picker only rendered for those scopes (`InferenceConfigEditor.tsx:272`); cleanup refuses a CLI provider (`ReasoningService.ts:1407`). Screenshot 04: cleanup list has no CLI provider. |
| 5 | IPC in both files | PASS | `preload.js` adds 15 `llmCli*` bridges; `ipcHandlers.js` calls `initLlmCliIpc` (one fork-owned module registering the channels). Parity test in `llmCliIpc.test.js` passes. |
| 6 | 11 locales | PASS | 11 `translation.json` files each +92 lines (ar de en es fr it ja pt ru zh-CN zh-TW). |
| 7 | Install consent-gated, publisher-enforced | PASS | Install runs only if `consentedUrl === spec.url` (`llmCliInstaller.js:64`); URL host allowlist, https only (`llmCliProviders.js:552,577-585`); grok is guide-only (`:593`). Authenticode `Valid` plus exact single-CN/O match enforced for claude, codex and agy (`llmCliProviders.js:559-572`, `llmCliInstaller.js:152-165`; tests `llmCliInstaller.test.js:170,203`). |
| 8 | Timeout and tree-kill | PASS | First-output, idle and total timers (`llmCliRunner.js:219-234`); `taskkill /T /F` tree-kill awaited before resolve (`:16-30,194-197`); `cancelAll` on app quit (`llmCliIpc.js:48-52`). Runner tests pass. |
| 9 | node-pty unpacked and skipped in rebuild | PASS | `electron-builder.json:98` asarUnpack; `scripts/rebuild-native-deps.js:24` `ignoreModules` for node-pty; `npmRebuild:false` plus `beforePack` hook; `package.json:179` pins node-pty 1.1.0. |

### Requirement grades

| Req | Verdict | Evidence |
|-----|---------|----------|
| LLM-01 detect and states | PASS | llmCliDetect and policy tests; screenshot 01 shows real states for four seats |
| LLM-02 consent install | PARTIAL | Code path and fake-installer tests solid. Consent dialog never seen in the real app; real installer never run on a clean machine. |
| LLM-03 sign-in, no token leak | PARTIAL | Leak-proof by code and canary tests. No real sign-in run (by design). |
| LLM-04 runs, timeouts, classified errors | PASS | Runner tests; real runs codex/agy ok, grok bounded hang (known, classified, not fixed). |
| LLM-05 Claude gate | PASS | See must-check 3. |
| LLM-06 scope-gated pickers | PARTIAL | Cleanup exclusion shown (screenshot 04). Screenshot 05 shows the Chat tab with BYOK selected and no "Subscription CLIs" group in frame, so it does not prove the picker. Plan 08-04 truth 3 (a chat answered through a seat in the running app) was not done. Code-level routing tests pass. |
| LLM-07 sign-out | PARTIAL | Tests only; confirm dialog and live sign-out not exercised. |
| LLM-08 i18n, IPC parity, icons | PASS | Must-checks 5 and 6. |
| LLM-09 BYOK unchanged | PASS | BYOK rows visible and unchanged in screenshots 04 and 05. |

Totals: 9/9 must-check items PASS; requirements 5 PASS, 4 PARTIAL, 0 MISSING.

### Findings

- RESOLVED: the UNVERIFIED line on the Windows publisher check said "report-only"; corrected to match the code (exact CN/O match enforced since b4d1d656d).
- WARNING: in-app chat through a seat, consent dialog, sign-out confirm and the chat-picker CLI group are not visually evidenced (see LLM-06).
- INFO: grok `-p` hang remains, bounded by idle timeout; agy headless sign-in is guide-only; clean-machine install and packed-app `require(esm)` unverified.
- No BLOCKER found: no failed truth, no stub, no unwired artifact.

### Ship verdict

SHIP (with caveats). All locked decisions D-01..D-05 hold at code level and every hard-rule check passes. The four PARTIAL items are live-system proofs deliberately not run (they would act on real logins or installs) and are recorded above as UNVERIFIED, not claimed as passing.
