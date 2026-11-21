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

- In-app proof (screenshots of Subscriptions section, Claude toggle, pickers, a chat answered through a seat, consent dialog, Codex sign-out confirm): NOT DONE. The dev app does not start from this worktree: `better_sqlite3.node` was built for NODE_MODULE_VERSION 137 and Electron 43.8.3 needs 148 (log from `electron . --dev`, channel staging). Rebuilding the native module against Electron would break the system-Node test run, so it was not done. AgentAutofix annotation 3d49c944-3c97-49a8-bf4f-71b93ca6b245. The consent dialog is covered by the view-model test only. LLM-01/06 UI and the chat-through-a-seat path are therefore code-level only.
- Installer run on a clean Windows machine and antivirus behavior: not run (all four CLIs already installed; the run would modify this PC).
- grok `-p` hang root cause: observed hang (no output until the idle limit, 4 runs, about 30 s each); cause not investigated. Bounded by the idle timeout, no workaround added.
- agy headless sign-in: no flag exists; only the run-agy-once guide is implemented. agy answered here because a Google sign-in already exists on this PC.
- Windows publisher check for codex and agy installs: report-only; vendors publish no signer name.
- Packaged build loading the ESM module via require(esm) from the real app.asar: only a test asar was checked.
