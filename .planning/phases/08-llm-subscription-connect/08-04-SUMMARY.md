---
phase: 08-llm-subscription-connect
plan: 04
subsystem: llm-cli-proof
tags: [proof, runner, windows, tree-kill, verification]
status: partial
requires: ["08-01", "08-02", "08-03"]
provides:
  - "scripts/fork/prove-llm-cli.mjs: runner-level proof against the installed CLIs"
  - "Runner teardown fix: awaited tree-kill, resolve after close, awaited run-dir removal"
  - "08-VERIFICATION.md with per-requirement verdicts and an UNVERIFIED list"
key-files:
  created:
    - scripts/fork/prove-llm-cli.mjs
    - .planning/phases/08-llm-subscription-connect/08-VERIFICATION.md
  modified:
    - src/helpers/llmCli/llmCliRunner.js
    - test/helpers/llmCliRunner.test.js
    - test/fixtures/llm-cli/README.md
    - .planning/ROADMAP.md
decisions:
  - "No change to the CJS/ESM split: Electron's own Node loads the ESM policy module via require(esm), also from an asar"
metrics:
  commits: 4
  plan_head_before: 9a57b3ae2
  tests: "205 pass across llmCli*, routing, shim, section and the merge-touched tests"
actuals:
  tokens: 0
  tasks: 1.5
  commits: 4
---

# Phase 8 Plan 04: Proof against real CLIs Summary

Task 1 done (the runner proves out against codex and agy, bounds the grok hang, and the Claude gate holds). Task 2 is PARTIAL: the in-app screenshots could not be produced because the dev app does not start here (native module ABI), so VERIFICATION records those items as UNVERIFIED. The rule-13 verifier and the PR are the orchestrator's next step.

## Commits

| Commit | Change |
|--------|--------|
| c1471b04e | Merge origin/main (fa95e18f3) into the branch, clean, no conflicts |
| 2fcb12cba | prettier on the fixture README (the only phase-8 file failing the check) |
| e6405fe33 | Runner teardown fix (below) with 2 new tests |
| 6773ecf6f | `scripts/fork/prove-llm-cli.mjs` |

## Real results (no login run, no token printed)

codex 0.157.0 signed-in: ok, first output 5.3 s. agy 1.5.13: ok, 10.0 s. grok 1.0.70 signed-in: KNOWN-HANG, killed at the idle limit (about 30 s), 4 of 4 runs. claude signed-out: skipped. Claude gate: pref off gives `claude-disabled`, pref on passes the gate. The script exits 0.

ESM load proof: `require()` of the policy, detector and IPC modules works under Electron 43.8.3's Node 24.22, and from a packed `.asar`. No fix needed.

## Deviations from Plan

1. **[Rule 1 - Bug] Runner left its run dir and could orphan descendants on Windows.** Found during Task 1: the script's final `rmSync` threw EPERM after the grok kill. Root cause (panel ruling): `defaultKillTree` started an async `taskkill` and then killed the parent, so taskkill could miss the tree, and `runStream` resolved before teardown finished. Fix in `llmCliRunner.js`: win32 `taskkill /T /F` is awaited and `child.kill()` is not called first (POSIX unchanged); a terminated run settles only after the kill and the child `close` (bounded 5 s); the run dir is removed with `await fs.promises.rm(..., {maxRetries:10, retryDelay:100})`. The proof script uses the same awaited remove. Tests: killTree awaited before resolve and run dir gone; win32 taskkill order. AAF annotation 6ba2c520-1c54-43ef-a9d2-53d5fee6e845. Verified: no orphan CLI processes after the run, leftover temp dirs removed.
2. **[Blocker, recorded] In-app proof not produced.** `electron . --dev` fails: `better_sqlite3.node` is NODE_MODULE_VERSION 137, Electron 43.8.3 needs 148. A rebuild would break the system-Node test run, so it was not done. AAF annotation 3d49c944-3c97-49a8-bf4f-71b93ca6b245. An earlier CDP attempt hit port 9333, which belongs to another app; nothing was sent to it.
3. **[Scope] Prettier:** only the fixture README needed a write. `preload.js` and `electron.ts` showed as modified after the write with no content diff and were restored. `npm run format:check` and `npm run lint` exit 0.
4. **ROADMAP:** Phase 8 entry added (list line, detail section, progress row 3/4).
5. **SUMMARY and VERIFICATION are from one agent run**; the independent rule-13 verifier has not run.

## Deferred / UNVERIFIED

See `08-VERIFICATION.md`: in-app screenshots and chat through a seat, clean-machine installer and antivirus, grok hang root cause, agy headless sign-in, publisher check, packaged-app require(esm).

## Known Stubs

None.

## Threat Flags

None. The script prints codes and timings only and uses the scrubbed env builder (T-08-01, T-08-06 hold).

## Self-Check: PASSED

Files exist: scripts/fork/prove-llm-cli.mjs, 08-VERIFICATION.md. Commits c1471b04e, 2fcb12cba, e6405fe33, 6773ecf6f exist on the branch.
