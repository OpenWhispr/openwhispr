---
phase: 07-connectors-titanium
plan: gaps (PR #28, feat/tiwh-v1-gaps)
verified: 2026-11-20
status: human_needed
score: 7/7 must-haves verified
behavior_unverified: 2
seats: claude (single verifier). Codex/agy not run (scope cap).
---

# PR #28 (v1.0 gap closure: E2 / E4 / E5 + repo links) Verification

Branch feat/tiwh-v1-gaps = origin/main + PR #28. Evidence from code reads and per-file node tests (`node --import ./test/setup/forkEnv.js --import tsx --test --test-force-exit <file>`).

| # | Goal (from PR body) | Status | Evidence |
|---|---------------------|--------|----------|
| E2a | Onboarding auth step shows "Sign in with Titanium" instead of "Cloud Not Configured" | PASS | `AuthenticationStep.tsx`: `resolveAuthStepMode({authConfigured, titaniumEnabled})`; "titanium" branch renders sign-in button (`titanium.signIn()`), signed-in email + Continue, pending hint, localized error via `titaniumAccount.errors.*`; "unconfigured" notice kept only when neither backend exists. `OnboardingFlow.tsx` uses `shouldOfferAuthStep` so the guest-forcing effect no longer skips the step. Tests: titaniumOnboardingPolicy 6/6, authenticationStep 2/2. |
| E2b | AppRouter needsReauth follows Titanium state, no flash for signed-in users | PASS | `AppRouter.jsx`: waits for `titanium.loaded` when `TITANIUM_ENABLED && !CLOUD_ENABLED`; `resolveNeedsReauth` returns `titaniumLoaded && !titaniumSignedIn` in that mode, `authSkipped` short-circuits; `useTitaniumAuth.ts` adds `loaded` (false until first main-process answer; errors publish SIGNED_OUT). |
| E4 | On the Titanium STT host a signed-out 401/403 shows Sign in to Titanium + action, not API-key advice | PASS | `TranscriptionModelPicker.tsx`: `resolveSttEndpointNotice` ("titaniumSignIn" only when refused AND `isTitaniumServiceUrl(baseUrl)` AND TITANIUM_ENABLED AND signed out; otherwise key advice unchanged), message `transcription.titaniumSignIn.message` and a button calling `titaniumAuth.signIn()`. Policy tests cover each branch. |
| E5 | Onboarding setup offers "EdgeAssistant cloud (Titanium)" | PASS | `SetupChoiceStep.tsx`: card offered via `shouldOfferTitaniumSetup`; action `resolveTitaniumSetupAction` = sign in when signed out, else `onSelectTitanium`. `OnboardingFlow.tsx handleTitaniumSetup` sets Custom provider to `DEFAULT_STT.baseUrl/model` for all scopes (`cloudTranscriptionMode: "byok"`) then finalizes. |
| Gate | E2/E5 gated on TITANIUM_ENABLED (portal URL + app slug), not CLOUD_ENABLED | PASS | `forkRuntime.ts` `TITANIUM_ENABLED = isTitaniumCloudEnabled(TITANIUM)` (portalUrl && appSlug); used by AuthenticationStep, SetupChoiceStep, AppRouter, OnboardingFlow, TranscriptionModelPicker. |
| Repo links | Links/sidecar downloads/REPO_URL point at finedesignz/edgeassistant | PASS | `fork.config.json` REPO_URL = `https://github.com/finedesignz/edgeassistant`; the six `scripts/download-*.js` and `SupportDropdown.tsx` changed; no `openwhispr/openwhispr` match remains in `scripts/download-*.js`; forkRebrand test 7/7. |
| i18n | New keys in all 11 locales | PASS | 11 locale files in the PR diff (ar de en es fr it ja pt ru zh-CN zh-TW); PR reports i18n:check exit 0 (not re-run here). |

Planning-doc claims: PR changes REQUIREMENTS.md, ROADMAP.md, STATE.md, 06-03-SUMMARY (BLOCKED, 12b gate 4) and 06-04-SUMMARY; not audited line by line here. Consistent with the 06-03 panel finding already in the repo.

Behavior-unverified (present and wired, no test exercises the runtime path): (1) the React components (AuthenticationStep titanium branch beyond the stubbed harness, SetupChoiceStep card, picker sign-in button) are covered only by pure-policy tests plus a harness render; (2) the `titaniumwhisper-dev://` / `-staging://` return-URL allow-listing in titanium-licensing (memlog request 1795213470930-0) is outside this repo, so real sign-in cannot be proven here.

Test gates: titaniumOnboardingPolicy 6/6, authenticationStep 2/2, forkRebrand 7/7, droppedFeatureGuard 20/20, useChatStreamingConnectors 4/4. `test/components/byokSavedConfig.test.js` 3 failures are pre-existing on main (not re-run). Additional pre-existing red on main (not caused by PR #28): `test/services/cleanupAuth.test.js` seed test, see 05-02 re-verification. CI `quality` for PR #28 was pending at check time.

Ship verdict: PASS (code), human_needed for live sign-in. PR #28 delivers E2, E4, E5 and the repo-link fix as described. Do not claim end-to-end sign-in works until titanium-licensing allows the dev/staging return URLs.

Verifier: Claude (gsd-verifier).
