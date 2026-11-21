---
phase: 08-llm-subscription-connect
plan: 01
subsystem: llm-cli-policy
tags: [policy, cli, subscription-oauth, parsers, fixtures]
status: complete
requires: []
provides:
  - "src/helpers/llmCliProviders.js: pure policy for the claude, codex, grok and agy seats"
  - "Pinned, scrubbed live CLI fixtures and a read-only capture script"
affects: [08-02, 08-03]
tech-stack:
  added: []
  patterns: ["pure CommonJS policy module, Electron-free, I/O injected", "table-driven seat rows", "fixture-pinned parsers"]
key-files:
  created:
    - src/helpers/llmCliProviders.js
    - test/helpers/llmCliProviders.test.js
    - test/helpers/llmCliParsers.test.js
    - test/fixtures/llm-cli/README.md
    - test/fixtures/llm-cli/claude-stream.ndjson
    - test/fixtures/llm-cli/codex-last-message.txt
    - test/fixtures/llm-cli/grok-json.txt
    - test/fixtures/llm-cli/agy-json.txt
    - scripts/fork/capture-llm-cli-fixtures.mjs
  modified: []
decisions:
  - "Seat rows are data (exe names, known install paths, version regex, required flags, models); behavior switches live in the builders"
  - "AUTH reducer event shape is {type:'AUTH', result:'signed-in'|'signed-out'}"
  - "Parsers return {type:'text-delta'|'final'|'error'} data and never throw; builders throw an Error with code 'invalid-input' for bad model, prompt or file arguments"
  - "Wrapped token and URL lines are re-joined only when a line ends in an unbroken token of 20+ characters"
  - "setup token must be sk-ant-oat01- and at least 100 characters; API keys are never returned"
metrics:
  commits: 5
  plan_head_before: 8d224d262f043ada05808de4072fea33c9ed62d4
  tests: "48 pass (31 policy, 17 parser and fixture)"
actuals:
  tokens: 0
  tasks: 5
  commits: 5
---

# Phase 8 Plan 01: Subscription-CLI policy layer Summary

One pure module (`src/helpers/llmCliProviders.js`) now carries every decision for the four CLI seats: detection, version and
flag probe, run argv, scrubbed child env, state machine, Claude gate, scope allowlist, install and sign-in specs, error
codes, timeouts, output parsers and redaction, all pinned to real captured CLI output.

## Tasks and commits

| Task | Commit | Result |
|------|--------|--------|
| 1 Tracer: codex through every policy function | f90ed5f53 | 11 tests; re-verified green before expanding |
| 2 claude, grok, agy rows, env scrub, model-id and prompt safety | 0e7cf8166 | 22 tests; canary test proves no token in argv, no scrub key in env |
| 3 reducer, gates, scopes, installer and sign-in specs, timeouts | cd900dd38 | 31 tests; scope test enumerates `INFERENCE_SCOPES` |
| 4 parsers, token and device-flow extraction, classifiers | 1a8fea55a | 42 tests incl. wrapped token, look-alike host, 1 MB hostile inputs under 500 ms |
| 5 live fixtures, capture script, model lists | 5b66c0ffe | 48 tests; `--verify-only` prints no missing flag for any seat |

## Live capture results (2026-11-20)

claude 12.8 s ok, codex 8.0 s ok, agy 9.0 s ok, grok 31.7 s idle-timeout (the expected known hang, recorded as
`{"timeout":true}`, no workaround). All four CLIs have every `requiredFlags` entry. Parsers needed no field-order change:
agy answers in `response`, claude in `stream_event` text deltas plus a `result` event, codex in the `-o` file.

## Deviations from Plan

**1. [Rule 1 - Correctness] Codex native package is a spawnable candidate, not a marker.** Disk check found a real
`codex.exe` under `%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\...\bin\`. It is
returned as `kind: "native-package"`, `spawnable: true`; the `codex.cmd` shim stays `isShim: true`, `spawnable: false`.
This is what makes codex spawnable on a machine that installed it through npm.

**2. [Rule 3 - Blocking] AgentAutofix repo slug.** `autofix-report edgeassistant ...` failed (no site key for that slug),
so the grok-hang ticket was filed once under the owning slug `openwhispr` (annotation
`c11db263-bb89-45b8-8c8d-2abab35cc11f`).

**3. [Rule 2 - Privacy] Claude fixture trimmed.** The raw stream held this machine's hook output and tool inventory.
`trimClaudeStream` in the capture script drops `system/hook_*` events and reduces `system` init and status to type,
subtype, model and session id. Every event the parsers read is kept verbatim. Documented in the fixture README.

**4. Model lists.** claude uses the `haiku|sonnet|opus` aliases; grok and agy arrays come from `grok models` and
`agy models` on the capture machine; codex exposes no listing, so its array stays `[]` (UI omits `-m`).

**5. Verification scope.** Ran only the two targeted test files, `eslint` (the `src/helpers` file is covered by the
repo's ignore pattern, the other three are clean) and `prettier --write` on the four new JS files. `npm run typecheck`
was not run: no TypeScript was touched and the new files are plain JS.

STATE.md, ROADMAP.md and REQUIREMENTS.md were not updated; the orchestrator owns those for this worktree.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-08-01, 03, 04, 05, 06 and 07 mitigations are implemented and tested.

## Open items for 08-02

- `codex logout` is `verified: false`; confirm with `codex logout --help` before wiring.
- The grok idle timeout (30 s) classifies the known hang; the runner must kill the process tree on `idleMs` and `totalMs`.
- agy takes the prompt as one argv value (24000-character cap); long prompts are rejected with `invalid-input`.

## Self-Check: PASSED

All nine files exist, commits f90ed5f53, 0e7cf8166, cd900dd38, 1a8fea55a and 5b66c0ffe exist on
`phase-08-llm-subscription-connect`, and the 48 targeted tests pass.
