---
phase: 07-connectors-titanium
verified: 2026-11-18T22:00:00Z
status: gaps_found
score: 4/6 must-haves verified
reviewed_sha: 7f55c53ea4d09c280d57f913bf875abdfd13c999
pr: https://github.com/finedesignz/edgeassistant/pull/21
qc_verdict: CONTENT BLOCK
seats: [claude-verifier, codex (responded, read-only)]
gaps:
  - truth: "npm test is green for the phase (implementer claimed 37 failures are pre-existing)"
    status: failed
    reason: "36 of the 37 are pre-existing (identical on origin/main). One is NEW in #21 and also fails CI job quality."
    artifacts:
      - path: "test/helpers/useChatStreamingConnectors.test.js"
        issue: "'a send that throws withdraws a pending approval (fork build)' fails under npm test (assert.equal(sawSlackTool,true) at :82, actual false). The fork-mode case sets env {} but test/setup/forkEnv.js (loaded by npm test) pre-sets VITE_OPENWHISPR_API_URL/VITE_AUTH_URL, so CLOUD_ENABLED is true in the 'fork' case and connector tools are not offered (OpenWhispr signed out). Passes only when run without --import ./test/setup/forkEnv.js."
    missing:
      - "In the fork-mode config, blank every VITE_* cloud URL set by forkEnv.js (setEnv with empty string) so CLOUD_ENABLED is false, then re-run npm test and CI quality"
  - truth: "No entry point to dropped features is reachable in a fork build (FEAT-06)"
    status: partial
    reason: "Share button still opens ShareNoteDialog, which exposes 'Sync note' / cloud link controls (cloud sync is a dropped feature). Implementer listed it as residual."
    artifacts:
      - path: "src/components/notes/NoteEditor.tsx"
        issue: "~1308 openShare('open') button and ShareNoteDialog mounted ungated (only the adjacent copy-link button uses cloudFeatureVisible('shareLink'))"
      - path: "src/components/notes/ShareNoteDialog.tsx"
        issue: "~741-748 handleSyncAndShare button shown whenever !sharingRestrictedByPolicy (fork policy is unmanaged)"
    missing:
      - "Gate the Share button / ShareNoteDialog sync+link sections behind cloudFeatureVisible; keep local export only"
---

# Phase 7: Connectors on Titanium accounts - Verification

QC gate + rule-13 verifier for PR #21 at 7f55c53ea. Verdict: CONTENT BLOCK (1 new red test that also fails CI, 1 partial FEAT-06 gap).

## Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Connector logins stored under the Titanium account id | VERIFIED | `titaniumSession.js` stores `accountId` from exchange (`cleanAccountId`), `getAccountScope()` returns `{accountId, authGeneration}`; `main.js:~541-551` selects `titaniumAccountScope(getTitaniumSession())` when `CLOUD_ENABLED` is false; `ipcHandlers.js:~6592-6615` uses `createTitaniumConnectorBindings`; credential slot hash fed that scope (wiring test with real manager + credential store passes). No email fallback: unbound session = `reauth_required`. Raw id not in `getState()` (only `accountBound`). `app_slug` sent and appSlug mismatch/missing rejected (`titaniumSession.js` exchange). |
| 2 | No UI / assistant text says sign in to OpenWhispr | PASS with WARNING | en `connectors.*.errors.{signed_out,reauth_required,plan_required}`, `upsell`, `locked` all Titanium/license wording. `agentCapabilities.ts:155-166` branches on `titanium` flag; locations point at Titanium account (`useChatStreaming.ts:506-507`). Guard test titaniumSignInCopyGuard passes. WARNING: `ProfileMenu.tsx:48` signed-out Sign in and `ControlPanel.tsx:1167,1257` (Insights `onSignIn`) call `setSettingsSection("account")`, a hidden section in a fork (dead end to General, not text naming OpenWhispr). `ConnectorsSection` UpsellBar button label is "View Plans" (target is Titanium account). |
| 3 | No entry point to dropped features | PARTIAL | `cloudFeatures.ts` registry + gates verified at ControlPanelSidebar:173,202, SettingsPage:2972,4162,4254,4289, ControlPanel (referral, upgrade, teamJoin), NoteEditor copy-link. Mobile sync / cloud-search UI grep: none. GAP: Share button + ShareNoteDialog "Sync note" (see gaps). |
| 4 | Fork policy fails closed | VERIFIED | `titaniumConnectorPolicyState`: signedIn!==true -> signed_out; accountBound!==true -> reauth_required; licensed!==true -> plan_required; `policyRefusal` unknown -> policy_unavailable. Upstream resolver retained when CLOUD_ENABLED. |
| 5 | Account change resets connectors | VERIFIED | `watchTitaniumAccount` installed in ipcHandlers (session created earlier at main.js:474, so non-null at registration); calls `accountChanged()` + `notifyStatusChanged()` only on sign-in/out/account switch. |
| 6 | Test suite introduces no new failure vs main | FAILED | See gap 1. |

## Failure comparison (npm test, Node 24.19, Windows host)

- #21 full `npm test` (`--import ./test/setup/forkEnv.js`): 8906 tests, 37 fail.
- origin/main (726a7931d, `git archive` copy, same 15 failing files re-run): 36 fail. Identical sets in forkWorkflows(6), cosmicToplevel(2), extractArchive(1), linuxKeyManager(3), linuxUrlSchemeHandler(1), localContextBudgetIpc(1), metaActivation(15), noteCreateReconciliation(30 reported by TAP nesting), parakeetDeploymentTarget(1), permissionGuideManager(1), systemTar(2), windowManagerAssistantPanel(1), assistantNoteUndo(1), noteEditPersistence(1).
- NEW in #21: `useChatStreamingConnectors.test.js` "(fork build)" (1 fail; passes 4/4 without forkEnv import, fails under npm test).
- CI: `gh pr checks 21`: job `quality` FAIL (run 44392897415), log shows `ℹ pass 8912 / ℹ fail 1` = exactly this test. All other checks pass or skipped.
- The implementer claim "none in touched areas" is false: this failing test is in a touched file.

## Codex seat (read-only, responded) findings, adjudicated

- MEDIUM ProfileMenu.tsx:48 hidden-section sign-in: confirmed (WARNING above).
- MEDIUM NoteEditor.tsx:1308 / ShareNoteDialog.tsx:744 Share + Sync: confirmed (gap 2).
- MEDIUM ConnectorsSection UpsellBar "View Plans" label in fork: confirmed, cosmetic (WARNING).
- No finding against account keying or fail-closed policy.

Seats: Claude verifier + Codex responded. agy not run (scope cap). Min 2 families met.

## Ship verdict

CONTENT BLOCK. Fix the fork-mode test env (one-line scope: blank VITE_* in that case), gate the Share dialog sync/link sections, re-run `npm test` and CI `quality`, re-QC the new SHA.


## Re-verification 2026-11-20

Scope: branch feat/tiwh-v1-gaps (origin/main + PR #28), fix commit 39eb26aaf. Tests run per file with `--import ./test/setup/forkEnv.js --import tsx --test --test-force-exit` (the import list `npm test` uses).

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 6 (gap 1) | New red test `useChatStreamingConnectors` "(fork build)" | PASS | Fork case env is now `{ VITE_OPENWHISPR_API_URL: "", VITE_AUTH_URL: "" }`, so CLOUD_ENABLED is false under forkEnv.js. Under the `npm test` import: 4/4 pass. |
| 3 (gap 2) | No entry point to dropped features (Share dialog) | PASS | `ShareNoteDialog.tsx` sync/link block wrapped in `cloudFeatureVisible("shareLink", CLOUD_ENABLED)`; local export stays outside. `droppedFeatureGuard.test.js` gained a `syncAndShare` mount-site assertion: 20/20 pass. |
| 2 (warning) | Sign-in routes to a hidden section | PASS | `ProfileMenu.tsx` signed-out button and `ControlPanel.tsx` Insights `onSignIn` use `CLOUD_ENABLED ? "account" : "titaniumAccount"`. Remaining `setSettingsSection("account")` at `ControlPanel.tsx:1167` is the past-due billing banner gated by cloud `usage.isPastDue` (unreachable in a fork). |
| 2 (warning) | "View Plans" label in fork | PASS | `ConnectorsSection.tsx` passes `actionLabel={CLOUD_ENABLED ? undefined : t("connectors.upsellAction")}`; key added in 11 locales (commit stat). |
| 1,4,5 | Titanium account scoping, fail-closed policy, account-change reset | PASS (unchanged) | Not touched by the fix. |
| 6 (rest) | No new failure vs main | PASS (targeted) | Full suite not re-run by design. One unrelated pre-existing red on main found: `test/services/cleanupAuth.test.js` seed test (see 05-02 re-verification); not introduced by phase 7. |

Score: 6/6. behavior_unverified: 0.

Ship verdict: PASS. Both original gaps and the warnings are closed in code and the red CI test now passes. Confirm CI `quality` on the merged SHA (pending for PR #28 at check time; the cleanupAuth seed test may keep it red independent of phase 7).

Verifier: Claude (gsd-verifier), re-verification.
