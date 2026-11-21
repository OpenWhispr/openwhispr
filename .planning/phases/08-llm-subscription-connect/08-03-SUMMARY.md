---
phase: 08-llm-subscription-connect
plan: 03
subsystem: llm-cli-renderer
tags: [renderer, settings, i18n, ai-sdk, subscription-oauth]
status: complete
requires: ["08-01", "08-02"]
provides:
  - "Subscriptions settings section for claude, codex, grok, agy"
  - "LanguageModelV3 shim and non-streaming provider over llm-cli-stream IPC"
  - "Scope-gated CLI picker for chat and the dictation agent"
affects: [08-04]
tech-stack:
  patterns: ["pure ESM view-model, thin component", "scope allowlist, not denylist"]
key-files:
  created:
    - src/helpers/llmCli/llmCliSeatView.js
    - src/helpers/llmCli/llmCliRouting.js
    - src/hooks/useLlmCliProviders.ts
    - src/components/settings/LlmSubscriptionsSection.tsx
    - src/components/settings/CliProviderPicker.tsx
    - src/services/ai/cliChatModel.ts
    - src/services/ai/inferenceProviders/cliSubscription.ts
    - test/components/llmSubscriptionsSection.test.js
    - test/services/cliChatModel.test.js
    - test/services/cliProviderRouting.test.js
  modified:
    - src/helpers/llmCliProviders.js
    - src/helpers/chatRouting.js
    - src/models/ModelRegistry.ts
    - src/services/ReasoningService.ts
    - src/services/ai/inferenceProviders/index.ts
    - src/components/SettingsModal.tsx
    - src/components/SettingsPage.tsx
    - src/components/settings/InferenceConfigEditor.tsx
    - src/locales/*/translation.json (11 locales)
decisions:
  - "llmCliProviders.js converted from CommonJS to ESM so the Vite renderer can import the shared policy; main still loads it with require(esm) on Node 24"
  - "CLI providers join the picker through a separate CliProviderPicker mounted behind CLI_SCOPE_ALLOWLIST; LLM_POLICY_PROVIDER_IDS untouched (D-05)"
  - "New chat route kind cli in chatRouting.js; the agent branch passes no tools and resolves no key or base URL"
metrics:
  commits: 5
  plan_head_before: 74917061b
  tests: "targeted: 24 section and sweep + 10 shim and provider + 11 routing (all pass); 111 llmCli helper tests still pass"
actuals:
  tokens: 0
  tasks: 4
  commits: 5
---

# Phase 8 Plan 03: Renderer Subscriptions, CLI provider routing Summary

Settings now has a Subscriptions section for the four CLI seats, chat and the dictation agent can pick a signed-in seat, and dictation cleanup, vision and note formatting cannot.

## Tasks and commits

| Task | Commit | Result |
|------|--------|--------|
| prerequisite: ESM policy module | b73e30529 | `llmCliProviders.js` importable from the renderer; 111 llmCli tests green |
| 1 Tracer: codex row over IPC | ed6a6ba3d | seat view-model, hook, nav entry, i18n (11 locales), 6 tests |
| 2 All seats, consent, prompts, gate | a4dc826a0 | 17 view-model tests |
| 3 CLI provider routing | dd6de7af5 | shim, provider, registry, route, picker; 10 + 12 tests |
| 4 Hard-rule sweep | 9dd3053b2 | 7 sweep tests (locales, icons, assets, BYOK parity, token isolation) |

## Verification

- Targeted tests: `llmSubscriptionsSection` 24, `cliChatModel` 10, `cliProviderRouting` 11, `secretKeys` and `inferenceProviderIds` pass.
- `npm run typecheck` clean. `npm run i18n:check` clean (11 locales).
- ESLint clean on all touched renderer and test files.
- Not run, by orchestrator order: full `npm test`, `npm run lint`, `npm run format:check`.

## Deviations from Plan

1. **[Rule 3 - Blocking] `llmCliProviders.js` converted to ESM.** The plan imports it from the renderer, but the file was CommonJS and Vite does not transform CJS source. Replaced `module.exports = Object.freeze({...})` with `export {...}`. Verified `require()` under plain Node 24.19 and all 111 llmCli tests. Unverified: the packaged Electron main loading it via require(esm) from asar.
2. **[Rule 3] Chat route kind `cli`.** `resolveChatRoute` classified any non-cloud id as `local`; added `isCliProvider` so `cli-*` ids never reach llama.cpp. Also `isProviderValidForMode` accepts CLI ids in providers mode (otherwise the stored provider is dropped). Files outside the plan list: `chatRouting.js`, `ModelRegistry.ts`.
3. **[Scope] Picker lives in `CliProviderPicker.tsx`**, mounted from `InferenceConfigEditor.tsx` in 3 lines (thin upstream-file change). The editor hides the BYOK selector while a CLI provider is active and offers "Use an API provider instead".
4. **[Gap] No "Open agy" button.** No IPC channel exists to launch a terminal; the agy guide shows a copyable `agy` command instead.
5. **`isAvailable()`** returns false for any `cli-*` cleanup provider (cleanup never runs on a CLI, D-03); seat availability for the allowed scopes is `isCliProviderAvailable`.
6. Prompt flattening drops images and tool results (CLIs answer text only); the agent branch passes no `tools` for `cli-*` ids, as planned.

## Deferred Issues

- `src/helpers/ipcHandlers.js` and `src/types/electron.ts` fail `prettier --check` (from 08-02, not touched here).
- Live verification not done: real sign-in, real install, a rendered Settings screen, a real chat through a CLI seat.

## Known Stubs

None.

## Threat Flags

None beyond the plan register. T-08-01 (no token in renderer, sweep-tested), T-08-04 (consent dialog echoes the table url, tested), T-08-05 (open-in-browser only for allowlisted hosts, plain-text render, tested), T-08-08 (sign-out confirms), T-08-10 and T-08-12 hold.

## Self-Check: PASSED

All created files exist; commits b73e30529, ed6a6ba3d, a4dc826a0, dd6de7af5, 9dd3053b2 exist on `phase-08-llm-subscription-connect`.
