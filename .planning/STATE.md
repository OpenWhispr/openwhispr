---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: "Titanium Whisper on Titanium servers"
project_code: TIWH
current_phase: 7
current_phase_name: "Connectors on Titanium accounts"
status: milestone_complete_with_gaps
last_updated: "2026-11-20"
last_activity: 2026-11-20
last_activity_desc: "Phases 1-7 merged; v1.10.5 signed draft release; open gaps: 06-03 blocked (gate 4), 06-04 partial, AUTH-01 dev/staging schemes, E2E sign-in unproven"
progress:
  total_phases: 7
  completed_phases: 7
  total_plans: 14
  completed_plans: 12
  percent: 86
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-08)

**Core value:** A user installs Titanium Whisper, signs in with their Titanium account, and dictates through our servers with no API keys and no OpenWhispr-hosted service.
**Current focus:** Close the v1.0 gaps below. Publishing the v1.10.5 draft release (12b gate 2, owner action) is separate.

## Current Position

- Phases 1-7 merged. Plans: 12 of 14 complete; 06-03 BLOCKED (gate 4), 06-04 PARTIAL (server proofs only). Requirements checked: CI-02, CI-04, AUTH-01, STT-03 (PRs #17, #18, #19 merged), AUTH-05 re-homed to Phase 7 (fork `isPaid` = offline Titanium license; lookup endpoint not built, tiers deferred to v2 AUTH-08).
- Phase 6 production proof (2026-11-20, https://stt.titaniumlabs.us, Coolify deploy xgi4idzkb1hny6prghtlazeb): `/healthz` 200, `verify-stream-segments` PASS, `verify-chat-completions` PASS, web search 200, OAuth relay 302 (valid state) / 400 (malformed). See `phases/06-hosted-services/06-04-SUMMARY.md`.
- Release: v1.10.5 signed DRAFT on `finedesignz/edgeassistant`.
- stt-api prod fix kept: `limits_memory` 4096m (was 256m below the 2048m reservation).

## Open gaps

- 06-03 own OAuth clients (Google, Microsoft, Slack, Linear): BLOCKED at 12b gate 4; Pass items `edgeassistant-oauth-{google,entra,slack,linear}` absent (confirmed 2026-11-20 with `pass-keys`). Build ships without client ids; calendars show Connect without client ids. FEAT-03 unmet, FEAT-02 end-to-end unproven. See `06-03-SUMMARY.md`.
- 06-04 not run: Slack/Linear/Google/Microsoft end-to-end OAuth, signed build with client ids, packaged-app web search turn. `verify-http-api` and `verify-scribe` are local-engine gates, not run against prod by design.
- AUTH-01 open item: `titaniumwhisper-dev://auth` and `titaniumwhisper-staging://auth` not yet allowed in the titanium-licensing app row (memlog request 1795213470930-0).
- End-to-end sign-in round trip and dictation with a real license key in the packaged app: UNPROVEN (needs a test license key).
- Phase 1 criterion 3 PARTIAL: 20 Windows-only local test failures (`phases/04-leftovers-VERIFICATION.md`).
- Phase 7 residual: note Share button still opens `ShareNoteDialog` with sync/link controls (FEAT-06 partial, `07-VERIFICATION.md`).

## Blockers / External dependencies

- Phase 6 needs our own Google/Microsoft/Slack/Linear OAuth apps (owner-held admin logins); web-search provider key is set in prod.
- Phase 7 dependency IDP-32 merged (titanium-licensing PR #304, 2026-10-14); not a blocker.
- Woodpecker API access is failing (401) - not needed by this roadmap (GitHub Actions is the fork's CI).

## Decisions

See PROJECT.md Key Decisions. AUTH-05: valid offline Titanium license = paid plan in a fork build (Phase 7, 07-01).
