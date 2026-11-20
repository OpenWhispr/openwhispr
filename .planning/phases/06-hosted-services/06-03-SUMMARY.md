---
phase: 06-hosted-services
plan: 03
status: blocked
blocked_on: "12b gate 4 - own OAuth clients (Google, Microsoft, Slack, Linear) do not exist; Pass items edgeassistant-oauth-{google,entra,slack,linear} are absent"
requirements: [FEAT-02, FEAT-03]
completed: null
checked: 2026-11-20
---

# Phase 6 Plan 03: Own OAuth clients into Pass - BLOCKED

Status: BLOCKED at the 12b gate 4 rule (a credential that exists nowhere). No portal task ran; no Pass item was written.

## Outcome per provider

| Provider | Pass item (planned) | Fields (planned) | Result |
|----------|---------------------|------------------|--------|
| Microsoft Entra | `edgeassistant-oauth-entra` | `microsoft_calendar_client_id` | BLOCKED: item absent; Entra portal login rejected twice (panel seat 1) |
| Google Cloud | `edgeassistant-oauth-google` | `google_calendar_client_id`, `google_calendar_client_secret` | BLOCKED: item absent; no Titanium-owned Desktop client created |
| Slack | `edgeassistant-oauth-slack` | `slack_client_id` | BLOCKED: item absent; no Slack workspace admin login or app config token |
| Linear | `edgeassistant-oauth-linear` | `linear_client_id` | BLOCKED: item absent; no Linear workspace admin login |

## Evidence

Checked 2026-11-20 with `pass-keys` (names only, no values printed):

```
pass-keys edgeassistant-oauth-google  -> pass-get: no active item titled 'edgeassistant-oauth-google'
pass-keys edgeassistant-oauth-entra   -> pass-get: no active item titled 'edgeassistant-oauth-entra'
pass-keys edgeassistant-oauth-slack   -> pass-get: no active item titled 'edgeassistant-oauth-slack'
pass-keys edgeassistant-oauth-linear  -> pass-get: no active item titled 'edgeassistant-oauth-linear'
```

Prior investigation: `06-03-PANEL-seat1.md` (2026-11-18). Its findings: Google and Microsoft have existing clients elsewhere in the portfolio (a loopback-capable Google client in another project, an Entra app used by another service), but redirect and scope edit rights on them are unproven and they are not clients owned by this fork. Slack and Linear are genuine gaps (CANNOT CONCLUDE; need a workspace admin login).

No executor result files (`06-03-*-result.md`) or verifier reports exist, so none of the plan's must_haves (four Pass items, executor results, read-only verifier PASS) are met.

## Plan facts kept (unchanged)

- Slack redirect to register: `https://stt.titaniumlabs.us/auth/slack/callback` (six user scopes, PKCE, token rotation, public distribution).
- Linear callback to register: `https://stt.titaniumlabs.us/auth/linear/callback` (scopes `read`, `issues:create`, `comments:create`).
- Google: Desktop app client, consent screen with the two calendar readonly scopes, In production (B-5: unverified-app screen and 100-user cap until Google verification).
- Entra: multi-tenant plus personal accounts public client, redirect `http://127.0.0.1`, delegated `Calendars.Read`, `User.Read`, `offline_access`, `openid`, `profile`, `email`.
- Routing (D-13): Entra and Google executed by codex, verified by grok; Slack and Linear executed by grok, verified by codex.

## Effect on the shipped build

- v1.10.5 ships with no client ids. `scripts/fork-write-env.mjs` fails closed, so the Google and Microsoft calendar rows show Connect without client ids and the connect attempt reports "not configured"; Slack and Linear rows report "not configured".
- FEAT-03 (calendar connect in a fork build) is not met. FEAT-02 is met on the server half only (the relay on `stt.titaniumlabs.us` answers; see 06-04) but no end-to-end Slack or Linear connect can be proven.

## To unblock

Owner-held inputs only: a Titanium-owned Google account login, Entra tenant admin login, Slack workspace admin login (or app configuration token) and Linear workspace admin login, stored as Pass login items. Then dispatch the existing briefs in `.planning/handoffs/06-03-*-brief.md` and re-run 06-04 tasks 2 and 3.
