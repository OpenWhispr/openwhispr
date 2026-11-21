---
phase: 08-llm-subscription-connect
plan: 02
subsystem: llm-cli-runtime
tags: [main-process, ipc, cli, pty, safeStorage, subscription-oauth]
status: complete
requires: ["08-01"]
provides:
  - "src/helpers/llmCli/*: runner, detector, installer, sign-in, token store, prefs, IPC adapter"
  - "IPC contract for 08-03 (channel list below)"
affects: [08-03]
tech-stack:
  added: ["node-pty@1.1.0"]
  patterns: ["injected side effects, fake-CLI tests", "thin IPC adapter over policy module", "main-owned gate"]
key-files:
  created:
    - src/helpers/llmCli/llmCliRunner.js
    - src/helpers/llmCli/llmCliDetect.js
    - src/helpers/llmCli/llmCliInstaller.js
    - src/helpers/llmCli/llmCliSignIn.js
    - src/helpers/llmCli/llmCliTokenStore.js
    - src/helpers/llmCli/llmCliPrefs.js
    - src/helpers/llmCli/llmCliIpc.js
    - test/fixtures/llm-cli/fake-cli.js
    - test/helpers/llmCliRunner.test.js
    - test/helpers/llmCliDetect.test.js
    - test/helpers/llmCliInstaller.test.js
    - test/helpers/llmCliSignIn.test.js
    - test/helpers/llmCliTokenStore.test.js
    - test/helpers/llmCliIpc.test.js
  modified:
    - src/helpers/ipcHandlers.js
    - preload.js
    - src/types/electron.ts
    - electron-builder.json
    - package.json
    - package-lock.json
decisions:
  - "node-pty accepted (Microsoft-maintained, MIT, VS Code dependency); piped stdio printed nothing from `claude setup-token`, node-pty prints the sign-in URL"
  - "Claude token store is its own safeStorage file, never in SECRET_KEYS or process.env"
  - "Gate (claude-disabled) enforced in handlers for stream-start, test and signin-start"
metrics:
  commits: 7
  plan_head_before: 0a9b5ceec
  tests: "111 pass across llmCli*.test.js (48 from 08-01, 63 new)"
actuals:
  tokens: 0
  tasks: 8
  commits: 7
---

# Phase 8 Plan 02: Main-process CLI runtime Summary

Main now detects, installs (consent), signs in and out of, and streams a prompt through the claude, codex, grok and agy
CLIs, as thin adapters over the 08-01 policy module, behind one validated IPC contract.

## Tasks and commits

| Task | Commit | Result |
|------|--------|--------|
| 3 (done first) node-pty gate | 344679301 | node-pty 1.1.0, `asarUnpack` entry |
| 1 Tracer: codex streams through runner and IPC | e78caf9cd | 15 tests |
| 2 Detection, probes, Test, Re-detect | 9130fae6f | 12 detector tests, wired from ipcHandlers.js |
| 4 Consent install | 59e895239 | 9 tests |
| 5 Sign-in, sign-out, token store | 63f69bc31 | 19 tests, canary token never leaves the store |
| 6 Claude gate, prefs, typings, quit hook | 13ed0f46f | gate on 3 entry points, typecheck clean |
| 7 e2e regression | 2592cc351 | codex flow through real modules |

## node-pty outcome

Orchestrator decision applied, no panel run. Probe: `claude setup-token` over piped stdio printed nothing in 6 s (killed,
never completed); under node-pty (500 cols, ConPTY) it printed the welcome banner and "Browser didn't open? Use the URL
below", so a TTY is required. Installed `node-pty@1.1.0` exact (maintainers include Microsoft; prebuilt N-API
win32-x64/arm64 and darwin binaries ship in the package; the repo's `allowScripts` gate did not run its install scripts
and none were needed). `**/node_modules/node-pty/**/*` added to `asarUnpack`. There is no separate signing glob in
`electron-builder.json`: `win.azureSignOptions` signs unpacked native binaries during bundling. Linux has no prebuilds, so
a Linux build compiles it (node-gyp); not exercised here. `.pdb` files ship inside the package.
Audit row: node-pty | npm | 1.1.0 | Microsoft (microsoft/node-pty) | MIT | long-established, VS Code dependency | ACCEPTED by orchestrator.

## Real results on this PC (read-only, no login run)

- Vendored codex native exe found by detection (no bounded search needed; the known-dir candidate hit):
  `%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`
- Detection: codex 0.157.0 signed-in (`codex login status` prints "Logged in using ChatGPT", exit 0); claude 2.1.330
  signed-out (no stored token); grok 1.0.70 signed-in (`~/.grok/auth.json` exists, never read); agy 1.5.13 installed,
  `authKnown: false`. All required flags present for all four.
- `codex logout --help`: exit 0, first line "Remove stored authentication credentials". Codex sign-out is WIRED, gated at
  runtime on that probe (checked once, cached; guided if it ever fails).

## IPC contract for 08-03 (all in both llmCliIpc.js and preload.js; parity test guards drift)

Invoke (preload name): `llm-cli-detect` (llmCliDetect) returns `{claude,codex,grok,agy}` states;
`llm-cli-test` (seat) -> `{ok}|{ok:false,code}`; `llm-cli-install-start` (seat, consentedUrl) -> `{ok,state,publisher,lines}`
or `{ok:false,code,messageKey?,lines}` or `{ok:false,guided:true,url}` (grok); `llm-cli-install-cancel` (seat);
`llm-cli-signin-start` (seat) -> `{ok}|{ok,kind:"terminal-guide"}|{ok:false,code}`; `llm-cli-signin-submit-code` (seat, code);
`llm-cli-signin-cancel` (seat); `llm-cli-signout` (seat) -> `{ok,affectsTerminalCli}` or `{ok:false,guided:true,...}`;
`llm-cli-get-prefs` -> `{claudeEnabled}`; `llm-cli-set-pref` (key, value) -> `{success,prefs}`;
`llm-cli-stream-start` ({streamId,seat,modelId?,prompt}) -> `{success}|{success:false,code,error}`; `llm-cli-stream-cancel` (streamId).
Events: `llm-cli-event` = `state | install-progress | signin-prompt | signin-result`;
`llm-cli-stream-part` = `{streamId, part}` (AI SDK v3 text-start, text-delta, text-end, finish with
`finishReason {unified:"stop",raw:"stop"}`) then `{streamId, done:true}` or `{streamId, error, code}`.
Typed in `src/types/electron.ts` (`LlmCli*`).

## Deviations from Plan

1. **[Order] Task 3 before Task 1.** The orchestrator required the pty TTY probe first; the dependency commit therefore
   precedes the tracer.
2. **[Wiring] ipcHandlers.js hook landed in Task 2, not Task 1.** The tracer had no real exe resolver until the detector
   existed, so the one `initLlmCliIpc` call was added with it (no half-working production wiring in between).
3. **[Rule 2] `totalMs` option on `runStream`** so Test caps at 60 s per plan without a second runner.
4. **[Rule 2] Quit also cancels the claude run/sign-in when `claudeEnabled` is set to false.**
5. **No `npm test` / `npm run lint` full runs** (orchestrator: targeted tests only, one typecheck). ESLint on the new test
   files, fake CLI, preload and electron.ts is clean; `src/helpers` is covered by the repo ignore pattern.
6. **Plan Task 3 panel not invoked**; orchestrator accepted node-pty (recorded above).
7. **Buffers "zeroed"** is best effort: JS strings are immutable, so the token and pty buffer references are dropped
   (`buffer = ""`, `token = null`) rather than overwritten.
8. **Unverified live:** a real `claude setup-token` capture, real vendor installs, `agy` terminal launch and the
   Electron-packaged node-pty load were not run (no real logins, no installs, no packaging).

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. New surface: `llm-cli-*` IPC channels (validated, size-capped, redacted). T-08-01, 03, 04,
05, 06, 07, 08, 10, 11 mitigations are implemented and tested; T-08-SC resolved by orchestrator acceptance.

## Self-Check: PASSED

All created files exist; commits 344679301, e78caf9cd, 9130fae6f, 59e895239, 63f69bc31, 13ed0f46f, 2592cc351 exist on
`phase-08-llm-subscription-connect`; 111 targeted tests pass; `npm run typecheck` clean.
