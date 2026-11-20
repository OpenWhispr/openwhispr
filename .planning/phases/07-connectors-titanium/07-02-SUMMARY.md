---
phase: 07-connectors-titanium
plan: 02
status: complete
requirements: [FEAT-04, FEAT-05]
commits: 1
plan_head_before: 726a7931d
pr: https://github.com/finedesignz/edgeassistant/pull/21
---

# Phase 7 Plan 2: Renderer eligibility, Titanium copy, Gmail client Summary

Renderer and assistant now agree with the 07-01 policy (7f55c53ea).

## Tasks
1. `connectorEligibilityFor` (pure; fork = Titanium signedIn/accountBound/licensed, upstream = existing plan/policy helpers) used by `useConnectorAccess` and `useChatStreaming` (tool offer + cache key). `agentCapabilities`: `reauthRequired` reason, Titanium-aware signedOut/planRequired text, `titanium` input flag; locations point at Settings > Titanium account in a fork. Tests: connectorEligibility, agentCapabilities, useChatStreamingConnectors (upstream, fork licensed, fork unlicensed, fork unbound).
2. Copy: connector errors `signed_out` reworded, `reauth_required` / `plan_required` added for slack/github/gmail/linear, `upsell`/`locked` reworded, in all 11 locale dirs (en, es, fr, de, pt, it, ru, zh-CN, zh-TW, ja, ar; i18n:check passes). `ConnectorLoginRow` handles both new codes; connectors upsell opens Settings > Titanium account in a fork.
3. `titaniumSignInCopyGuard.test.js`: every locale's `connectors.*` plus fork capability text; bite proof: reintroducing "Sign in to OpenWhispr to connect Slack." in en made the guard fail (pass 11/fail 1 -> pass 10/fail 2), then reverted.
4. Gmail: `gmailClientCredentials(env, {allowCalendarClient})`; `main.js` passes `allowCalendarGmailClient: CLOUD_ENABLED`; fork needs a dedicated `GMAIL_CLIENT_ID/SECRET` pair. Tests added.

## Deviations
- Locale count is 11, not 9 (ja, ar exist); all updated.
- `connectorErrorCopy.ts` unchanged: refusals reach the UI as `unavailable` results / row error codes, which already fall to existing generic tool-status copy; no new copy key needed there.
- Web search "signedOut" capability text in a fork now says Titanium sign-in; its gating itself remains Phase 6.
- `format:check` fails on ~1100 untouched files (CRLF working copies on this host); touched files were formatted with prettier.

## Known issues
- `npm test`: 37 pre-existing environmental failures (workflow guards, COSMIC/Linux, better-sqlite3 ABI, windowManager panel); none in touched areas.
