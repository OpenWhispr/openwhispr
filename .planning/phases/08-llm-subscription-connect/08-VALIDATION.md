# Phase 8: LLM subscription connect - Validation

**Date:** 2026-11-20
**Branch:** `phase-08-llm-subscription-connect`
**Plans:** 08-01 (policy), 08-02 (main runtime), 08-03 (renderer), 08-04 (proof)

Test runner for every command below: `node --import ./test/setup/forkEnv.js --import tsx --test <file>`.
Repo gates after each plan: `npm run typecheck`, `npm run lint`, `npm run i18n:check`, `npm test`.

## Requirements

ROADMAP.md and REQUIREMENTS.md have no Phase 8 entry, so these IDs are phase-local. Add them to REQUIREMENTS.md when the
roadmap entry is created.

| ID | Requirement | Decision |
|----|-------------|----------|
| LLM-01 | Four seats (Claude, Codex, Grok, Antigravity) are detected on PATH and in known per-user dirs, with version, required-flag probe, and one of missing / outdated / installed / signed-out / signed-in / error | D-01, D-02 |
| LLM-02 | Install is consent-only with the exact vendor url and command shown; verified vendor installers for claude, codex, agy; guided link for grok; never bundled | D-02 |
| LLM-03 | Sign-in through the official CLI (claude setup-token in a pty, codex and grok device-auth, agy run-once guide); tokens never reach logs, renderer, .env or process.env | D-01 |
| LLM-04 | Runs use `claude -p`, `codex exec`, `grok --prompt-file`, `agy -p` with windowsHide, array argv, scrubbed env, timeouts, classified errors, streamed over IPC | D-01, D-03 |
| LLM-05 | Claude seat gated behind a setting, off by default, one-line notice when on, enforced in main | D-04 |
| LLM-06 | Chat and dictation agent can pick a CLI provider; cleanup, vision and note formatting never list them | D-03 |
| LLM-07 | Sign out per seat (delete stored token, CLI logout for grok and codex, guide for agy) with a confirm that warns about the terminal CLI | D-01 |
| LLM-08 | i18n in all 11 locales, IPC in both files, icons from the local set, thin upstream edits | repo hard rules |
| LLM-09 | BYOK provider rows and key IPC are unchanged | D-05 |

## Requirement to test map

| Req | Test file | Command (after the shared prefix) | Plan and task |
|-----|-----------|-----------------------------------|---------------|
| LLM-01 | `test/helpers/llmCliProviders.test.js` (table, detection candidates, version parse, flag probe, reducer) | `test/helpers/llmCliProviders.test.js` | 08-01 T1, T3 |
| LLM-01 | `test/helpers/llmCliDetect.test.js` (known-dir detect, shim to native exe, quarantine, auth probes) | `test/helpers/llmCliDetect.test.js` | 08-02 T2 |
| LLM-01 | `test/components/llmSubscriptionsSection.test.js` (view model per state) | `test/components/llmSubscriptionsSection.test.js` | 08-03 T1, T2 |
| LLM-02 | `test/helpers/llmCliProviders.test.js` (installSpec, installCommand, url allowlist) | `test/helpers/llmCliProviders.test.js` | 08-01 T3 |
| LLM-02 | `test/helpers/llmCliInstaller.test.js` (url byte-equality, grok guided, timeout, quarantine, signature) | `test/helpers/llmCliInstaller.test.js` | 08-02 T4 |
| LLM-03 | `test/helpers/llmCliParsers.test.js` (extractSetupToken wrapped, device code, sign-in url host) | `test/helpers/llmCliParsers.test.js` | 08-01 T4 |
| LLM-03 | `test/helpers/llmCliSignIn.test.js`, `test/helpers/llmCliTokenStore.test.js` (canary token never emitted, no plaintext file) | `test/helpers/llmCliSignIn.test.js test/helpers/llmCliTokenStore.test.js` | 08-02 T5 |
| LLM-04 | `test/helpers/llmCliProviders.test.js` (argv, env scrub, model id, prompt) | `test/helpers/llmCliProviders.test.js` | 08-01 T1, T2 |
| LLM-04 | `test/helpers/llmCliParsers.test.js` (fixture-driven per CLI) | `test/helpers/llmCliParsers.test.js` | 08-01 T4, T5 |
| LLM-04 | `test/helpers/llmCliRunner.test.js` (stdin not argv, idle timeout kill, cancel, busy, redaction) | `test/helpers/llmCliRunner.test.js` | 08-02 T1 |
| LLM-04 | `scripts/fork/prove-llm-cli.mjs` (real CLIs) | `node --import tsx scripts/fork/prove-llm-cli.mjs` | 08-04 T1 |
| LLM-05 | `test/helpers/llmCliProviders.test.js` (isSeatEnabled) and `test/helpers/llmCliIpc.test.js` (gate in main on all three claude entry points) | `test/helpers/llmCliProviders.test.js test/helpers/llmCliIpc.test.js` | 08-01 T3, 08-02 T6 |
| LLM-05 | `test/components/llmSubscriptionsSection.test.js` (toggle and notice) | `test/components/llmSubscriptionsSection.test.js` | 08-03 T2 |
| LLM-06 | `test/helpers/llmCliProviders.test.js` (scope enumeration over INFERENCE_SCOPES) | `test/helpers/llmCliProviders.test.js` | 08-01 T3 |
| LLM-06 | `test/services/cliProviderRouting.test.js`, `test/services/cliChatModel.test.js` | `test/services/cliProviderRouting.test.js test/services/cliChatModel.test.js` | 08-03 T3 |
| LLM-07 | `test/helpers/llmCliSignIn.test.js` (sign-out per seat, codex logout verified or guided) | `test/helpers/llmCliSignIn.test.js` | 08-02 T5 |
| LLM-07 | `test/components/llmSubscriptionsSection.test.js` (confirm text, affectsTerminalCli) | `test/components/llmSubscriptionsSection.test.js` | 08-03 T2 |
| LLM-08 | `npm run i18n:check`, sweep in `test/components/llmSubscriptionsSection.test.js` (11 locales, no lucide, no /assets/), `test/helpers/llmCliIpc.test.js` (preload parity) | `npm run i18n:check` and the two test files | 08-02 T6, 08-03 T4 |
| LLM-09 | `test/helpers/secretKeys.test.js` (unchanged) and the LLM_POLICY_PROVIDER_IDS assertion in `test/services/cliProviderRouting.test.js` | `test/helpers/secretKeys.test.js test/services/cliProviderRouting.test.js` | 08-03 T3, T4 |

Nyquist: every task in every plan has an `<automated>` command; no manual-only verification except the 08-04 screenshots,
which are evidence for the verifier and not the only check.

## Open-item resolutions (planner, 2026-11-20, read-only checks)

| Open item (CONTEXT) | Resolution | Evidence |
|---------------------|------------|----------|
| agy sign-in and headless flow | No login subcommand and no headless sign-in flag exist. Sign-in is the browser OAuth the user completes by running agy once. The seat is detect plus guide (launch agy in its own terminal, then Test). Print mode is `-p` with `--output-format json` and `--print-timeout`. Headless sign-in is UNVERIFIED (Google CLI docs page names auth types but no no-browser option). | `agy --help` (subcommands: acp, agent, changelog, install, mcp, mic-serve, models, plugin, remote-control, update; flags `-p`, `--output-format`, `--print-timeout`, `--model`); WebFetch `antigravity.google/docs/getting-started?tab=cli` |
| grok `-p` hang | Plan carries first-output, idle (60 s) and total timeouts, a credential-file presence check (grok has no status command), and a per-CLI parse contract. Grok `-p` uses `--prompt-file` and `--output-format json`. The hang itself is recorded as a known external defect; no workaround. | `grok --help` (`-p/--single`, `--prompt-file`, `--output-format plain|json|streaming-json|streaming-messages-json`, `--permission-mode`, `--no-subagents`, `--max-turns`); `grok login --help`; `grok models --help` |
| Claude token capture and env var | `claude setup-token` has no options, needs a terminal (pty), prints the token and saves nothing. The env var is `CLAUDE_CODE_OAUTH_TOKEN` (one year, model requests only). It ranks below `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and `apiKeyHelper`, so all are scrubbed. `--bare` ignores it, so it is never used. | `claude setup-token --help`; `claude --help` (`--bare` text); WebFetch `https://code.claude.com/docs/en/authentication` ("Generate a long-lived token", "Authentication precedence") |
| Version floors | Floors are a required-flag probe against each CLI's `--help`, not a hard-coded version; tested versions recorded: claude 2.1.330, codex-cli 0.157.0, grok 1.0.70, agy 1.5.13. | `claude --version`, `codex --version`, `grok --version`, `agy --version`; `codex exec --help` |
| Installer URLs | claude `https://claude.ai/install.ps1` / `install.sh` (verified, Windows binary signed "Anthropic, PBC", signed manifest); codex `https://chatgpt.com/codex/install.ps1` (openai/codex README) and `install.sh` (learn.chatgpt.com/docs/codex/cli); agy `https://antigravity.google/cli/install.ps1` / `install.sh` (antigravity.google/docs/getting-started?tab=cli). Grok: NO installer URL found on reachable xAI pages (docs.x.ai pages 404 or show no install command, x.ai/cli returned 403), so guided-only with link `https://docs.x.ai/build/cli/reference`. Signing: only claude documents a signer; codex and agy are report-only. | WebFetch of the URLs above; `https://raw.githubusercontent.com/openai/codex/main/README.md`; `https://docs.x.ai/llms.txt` |
| Codex status and logout | `codex login status` exits 0 with `Logged in using ChatGPT`. `codex login --device-auth` exists. `codex login --with-api-key` exists and is refused. `codex logout` is NOT verified (login help lists only `status`), so 08-02 checks `codex logout --help` and falls back to a guide. | `codex login --help`; `codex login status` (exit 0) |

## Source audit

| Source | Item | Covered by |
|--------|------|-----------|
| GOAL | Connect through the user's subscription, no API keys, CLIs hosted by main, tokens local | 08-01 to 08-04 |
| CONTEXT D-01 | CLIs driven by main, sign-in flows, `-p` calls with windowsHide streamed over IPC, safeStorage token, pure policy module with test, thin IPC in both files, 11 locales | 08-01 T1-T4, 08-02 T1, T5, T6, 08-03 |
| CONTEXT D-02 | Detect on PATH and known dirs, version, Re-detect, consent install from verified URLs, guided otherwise, never bundle, never a .ps1 shim, version floor, AV quarantine, installed-not-signed-in | 08-01 T1-T3, 08-02 T2, T4 |
| CONTEXT D-03 | CLIs serve chat and agent only; cleanup picker does not list them; timeouts for slow or hung CLIs | 08-01 T3, T5, 08-03 T3 |
| CONTEXT D-04 | Claude seat behind a setting, off by default, one-line notice, other seats ungated | 08-01 T3, 08-02 T6, 08-03 T2 |
| CONTEXT D-05 | BYOK rows unchanged | 08-03 T3, T4 |
| CONTEXT open items | agy sign-in, grok timeout and parse contract, claude token capture and env var, version floors | resolutions above; 08-01, 08-02 |
| RESEARCH 3 and 4 | Local CLI-mediated, no hosted broker, do not use `oauthLoopbackFlow.js`, Windows pty needed, new IPC channels, `cliSubscription` provider, UI, i18n | 08-02 (pty via node-pty behind a supply-chain gate), 08-03 |
| RESEARCH 4 item 5 | Add registry model entries and retire BYOK | Deliberately not done: D-05 keeps BYOK, and CLI model lists live in the policy table to keep CLI providers out of `modelRegistryData.json` and out of the cleanup picker (D-03). Removal of BYOK is out of scope per D-05. |
| RESEARCH 5 risks | Raw-API token use entitlement-limited so go through the CLI; no usage UI from the setup token; codex refresh token single-use; shared quota; agy auth layout drift; ToS | CLI-only calls (08-01 T2), no usage UI planned, no auth.json copy and one codex run at a time (08-02 T1, T5), agy state is `authKnown: false` until Test (08-02 T2), ToS in D-04 |

No item is unplanned. Nothing from Deferred Ideas appears (CONTEXT lists none).

## Known UNVERIFIED (carried into 08-04)

- Real installer runs on a clean Windows machine and antivirus behavior (not run on this PC).
- Exact vendored codex native exe path under the npm shim (a listing was blocked by a local guard; 08-02 T2 finds it with a bounded search).
- `codex logout` existence; grok `-p` hang cause; agy headless sign-in; Windows signer names for codex and agy installs.
- Claude stream-json and grok and agy json field names are pinned by live capture in 08-01 T5, not assumed.
