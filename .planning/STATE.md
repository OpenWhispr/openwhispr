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
last_activity_desc: "Phases 1-7 merged; v1.10.5 signed draft release; gaps in v1.0-MILESTONE-AUDIT.md"
progress:
  total_phases: 7
  completed_phases: 7
  total_plans: 14
  completed_plans: 13
  percent: 93
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-08)

**Core value:** A user installs Titanium Whisper, signs in with their Titanium account, and dictates through our servers with no API keys and no OpenWhispr-hosted service.
**Current focus:** Close phase 3-4 leftovers (PRs #17, #18, #19), then execute Phase 5

## Current Position

- Phase 1 (Fork CI) merged: PR #10. Leftover in review: PR #17 (CI-02 mobile CI gated; CI-04 tests fixed at the root: CRLF on Windows checkouts, `.gitattributes`; PR #4 cherry-picked and closed).
- Phase 2 (rebrand) complete: PR #11 and PR #12. Visible brand EdgeAssistant; appId `com.titaniumlabs.titaniumwhisper`, scheme `titaniumwhisper://`, userData "Titanium Whisper" kept.
- Phases 3-4 code merged: PR #11 (Titanium sign-in, app side of stt-api auth), PR #15 (CLAUDE.md exclude), stt-api PR #26 (license-key bearer).
- In review: PR #18 (AUTH-01: `titanium-whisper` provisioned, product id bbe843ac-4de5-486c-85e2-1a1b7e533e5f, `titaniumwhisper://auth` return origin allowed, proven by API 200 vs 400 for other schemes; stt-api Coolify env set), PR #19 (STT-03: `stt.titaniumlabs.us` live with valid TLS, old Coolify host kept, saved-URL migration).
- stt-api prod fix: `limits_memory` 256m was below the 2048m reservation, causing failed deploys and an engine restart loop; set to 4096m, healthz warm with 0 crashes.
- Phases 5, 6, 7 planned (2, 4 and 3 plans); not started. No fork release since v1.10.4.
- PR #14 (milestone summary) merging.

## Not yet verified

- End-to-end sign-in round trip through the UI.
- Dictation with a license key end to end (pending PR #18/#19 merges).

## Blockers / External dependencies

- Phase 7 dependency titanium-licensing v3.5 Phase 32 (IDP-32) is merged (PR #304, 2026-10-14); no longer a blocker.
- Phase 6 needs our own Google/Microsoft/Slack/Linear OAuth apps and a web-search provider key (plan 06-03 provisions the OAuth clients into Pass).
- AUTH-05 (plan lookup) was moved to Phase 6 but is in no Phase 6 plan; needs a plan or a re-home.
- Woodpecker API access is failing (401) - not needed by this roadmap (GitHub Actions is the fork's CI).

## Decisions

See PROJECT.md Key Decisions.
