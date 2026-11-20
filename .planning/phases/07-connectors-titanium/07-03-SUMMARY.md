---
phase: 07-connectors-titanium
plan: 03
status: complete
requirements: [FEAT-06]
commits: 1
plan_head_before: 726a7931d
pr: https://github.com/finedesignz/edgeassistant/pull/21
---

# Phase 7 Plan 3: Dropped cloud features hidden Summary

One registry (`src/config/cloudFeatures.ts`, `cloudFeatureVisible(id, cloudEnabled)`) now gates every dropped-feature entry point (db168d922).

## Gated mount sites
referral (sidebar row, ProfileMenu item, ReferralModal, onOpenReferrals), workspaceSwitcher, upgradePrompt (modal + onLimitReached), teamJoin (JoinYourTeamModal, AcceptInvitationModal, useJoinableWorkspaces), leaderboard (Insights tab trigger/content, active tab falls back to usage; Settings row), cloudBackup (Settings backup block + Insights sync row), enterpriseCheckout, signInCloudNudge (`decideSignInCloudNudge` takes `cloudEnabled`), plus added id `shareLink` (note copy-link button).

## Guard and audit
- `test/config/droppedFeatureGuard.test.js`: source-level table of 17 mount sites; fails if a gate call stops preceding an anchor.
- Task 3 audit: mobile sync/pairing grep (`mobile.?(sync|pair)|qr.?pair|pairMobile` over src) = 0 hits; developer API/MCP/CLI group already `CLOUD_ENABLED`-gated (integrationsSections.ts:16); enterprise console only via hidden settings sections; no cloud-search UI toggle.
- Residual (not hidden): the note Share button opens `ShareNoteDialog`, which also hosts local export; its link section is unavailable without a session. ProfileMenu signed-out "Sign in" still targets the hidden `account` section (gated to General); out of FEAT-06 scope.

## Deviations
- Added `shareLink` id (plan said eight ids; Task 3 permits additions).
- `test/hooks/signInCloudNudge.test.js` now runs as a cloud-enabled build via VITE env (it tests the upstream nudge); fork case covered in the util test.
