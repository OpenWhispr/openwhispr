# Roadmap: Titanium Whisper v1.0

**Milestone:** v1.0 "Titanium Whisper on Titanium servers" (code TIWH)
**Granularity:** standard · **Platform:** Windows only

## Phases

- [x] **Phase 1: Fork CI & sync runbook** — CI builds are cloud-disabled, upstream-only jobs off, one green Windows build+test job
- [x] **Phase 2: Titanium Whisper rebrand** — name, identity, icons, links, userData migration
- [ ] **Phase 3: Titanium sign-in** — browser login → deep link → exchange → offline license in Electron main (code merged, PRs #11/#18; dev/staging return URLs allowed 2026-11-20; live UI round trip pending dev-mode E2E)
- [ ] **Phase 4: stt-api on Titanium auth** — license-key bearer on stt-api, stable domain, app sends key, language guard (code merged, stable domain PR #19 merged; end-to-end dictation pending dev-mode E2E)
- [x] **Phase 5: Self-hosted transcription parity** — WS streaming client, diarization/timestamps, cleanup via stt-api (2/2 plans; re-verified 2026-11-20)
- [ ] **Phase 6: Hosted services** — web search endpoint, Slack/Linear OAuth relay, calendar OAuth clients (2/4 complete; 06-03 BLOCKED at 12b gate 4, 06-04 PARTIAL)
- [x] **Phase 7: Connectors on Titanium accounts** — connectors keyed to Titanium account id; capability text; dropped features hidden (3/3 plans; gaps PR #28)
- [ ] **Phase 8: LLM subscription connect** — Claude, Codex, Grok and Gemini (agy) connect through each vendor's official CLI on the user's PC; no API keys (3/4 plans; 08-04 proof in progress)

## Phase Details

### Phase 1: Fork CI & sync runbook

**Goal:** The fork's CI can never produce a cloud-enabled build, and every PR gets a real Windows build + full test run.
**Depends on:** nothing
**Requirements:** CI-01, CI-02, CI-03, CI-04, CI-05, OPS-01
**Success criteria:**

1. `grep` finds no OpenWhispr-hosted default in `.github/workflows/`
2. winget/nix/canary/mobile/notarize workflows do not trigger in the fork
3. A Windows workflow passes on a PR with the full suite (no skips added)
4. Smoke test asserts the default route is stt-api with cloud disabled
5. `docs/UPSTREAM-SYNC.md` exists with hotspots and checklist

### Phase 2: Titanium Whisper rebrand

**Goal:** The installed app is Titanium Whisper everywhere a user looks, and existing OpenWhispr users keep their data.
**Depends on:** Phase 1 (CI catches regressions)
**Requirements:** BRAND-01..BRAND-07
**Status:** Complete (PR #11, PR #12). Visible product name is "EdgeAssistant" (PR #12); appId `com.titaniumlabs.titaniumwhisper`, scheme `titaniumwhisper://` and the userData folder "Titanium Whisper" are kept.
**Success criteria:**

1. Built installer and window titles read "Titanium Whisper"; appId `com.titaniumlabs.titaniumwhisper`
2. First launch with an existing `OpenWhispr` userData copies settings, history, notes and models (tested)
3. Guard test: no runtime reference to OpenWhispr-hosted domains
4. i18n check passes in all locales

### Phase 3: Titanium sign-in

**Goal:** Users sign in with their Titanium account and the app holds a verified license offline.
**Depends on:** Phase 2 (deep-link scheme and appId are final)
**Requirements:** AUTH-01..AUTH-06
**Cross-repo:** titanium-licensing (provision slug, allow `titaniumwhisper://auth`)
**Success criteria:**

1. Sign-in round trip works end to end against the live portal
2. Restart offline keeps the user signed in within hard TTL
3. `licenseKey: null` shows the no-license state
4. Sign out clears the cache

### Phase 4: stt-api on Titanium auth

**Goal:** Each signed-in user transcribes through stt-api with their own license; nothing secret ships in the installer.
**Depends on:** Phase 3
**Requirements:** STT-01..STT-04
**Cross-repo:** openwhispr-stt-api (license bearer), Coolify/Cloudflare (stable domain)
**Success criteria:**

1. stt-api accepts a valid license key, rejects tampered/expired/blocklisted/wrong-product keys (tests)
2. Fresh install → sign in → dictation succeeds with no manual configuration
3. Default STT URL is the stable domain

### Phase 5: Self-hosted transcription parity

**Goal:** Meetings, live preview, uploads and cleanup work on our servers without BYOK keys.
**Depends on:** Phase 4
**Requirements:** STT-05, STT-06, STT-07
**Success criteria:**

1. A meeting records with live transcript from stt-api WS
2. An uploaded file gets timestamps and speaker labels
3. Cleanup runs via stt-api by default when signed in

**Plans:** 2 plans

Plans:
- [x] 05-01-PLAN.md - stt-api: WS streaming, diarization/timestamps and cleanup wire contracts, served in prod (wave 1)
- [x] 05-02-PLAN.md - desktop: stt-api streaming client for meetings and live preview, upload timestamps/speakers, cleanup via stt-api by default (wave 2)

### Phase 6: Hosted services

**Goal:** Web search, Slack/Linear OAuth and calendars work on our infrastructure.
**Depends on:** Phase 3
**Requirements:** FEAT-01, FEAT-02, FEAT-03
**Success criteria:**

1. `web_search` returns results for a signed-in user via our endpoint
2. Slack/Linear connect completes through our relay
3. Google/Microsoft calendar connect works in a fork build

**Plans:** 4 plans

Plans:
- [x] 06-01-PLAN.md - stt-api: Slack/Linear OAuth relay routes + license-gated Tavily web search (wave 1)
- [x] 06-02-PLAN.md - desktop: calendar local result page, SERVICES_URL relay base, fork web search, build-time client ids (wave 1)
- [ ] 06-03-PLAN.md - portal: Entra, Google, Slack, Linear OAuth clients into Pass (wave 1)
- [ ] 06-04-PLAN.md - prove in production: deploy, signed fork build, live OAuth round trips, packaged web search (wave 2)

### Phase 7: Connectors on Titanium accounts

**Goal:** Connectors and capability messaging work on Titanium accounts; dropped features leave no dead ends.
**Depends on:** Phase 6; titanium-licensing v3.5 Phase 32 (IDP-32) merged (PR #304, 2026-10-14)
**Requirements:** FEAT-04, FEAT-05, FEAT-06, AUTH-05 (re-homed from Phase 6: fork `isPaid` is the offline-verified Titanium license, `src/utils/connectorEligibility.ts:50-60` and `src/helpers/titanium/titaniumSession.js:178-197`, shipped by 07-01 in PR #21; the `/v1/licenses/lookup` call was not built, plan tiers deferred to v2 AUTH-08)
**Success criteria:**

1. Connector logins stored under the Titanium account id
2. No UI or assistant text tells users to sign in to OpenWhispr
3. No entry point to a dropped feature remains

**Plans:** 3 plans

Plans:
- [x] 07-01-PLAN.md - main: Titanium accountId + app_slug in session, fork connector policy (license = paid plan), account-change reset, keygenProductId (wave 1)
- [x] 07-02-PLAN.md - renderer: Titanium connector eligibility, capability text to Titanium account, 9-locale copy, sign-in copy guard test, Gmail row (wave 2)
- [x] 07-03-PLAN.md - dropped features: cloudFeatures registry, gate every entry point, mount-site guard test (wave 1)

### Phase 8: LLM subscription connect

**Goal:** EdgeAssistant connects to LLM providers through the user's own subscription, with no API keys: Claude, Codex, Grok and Gemini (Antigravity) sign in through each vendor's official CLI, hosted locally by the Electron main process.
**Depends on:** Phase 7
**Requirements:** LLM-01..LLM-09
**Success criteria:**

1. Settings has a Subscriptions section showing the four seats with detect, consent install, sign-in and sign-out; tokens never reach the renderer, logs or `.env`
2. Chat and the dictation agent can pick a signed-in seat; dictation cleanup, vision and note formatting cannot (scope allowlist)
3. The Claude seat is off until its setting is on, enforced in main
4. Real CLIs answer through the real runner, or fail with a classified, bounded outcome (timeout, signed-out, quota)

**Plans:** 4 plans

Plans:
- [x] 08-01-PLAN.md - pure policy module: provider table, detection, argv, state machine, parsing (wave 1)
- [x] 08-02-PLAN.md - main-process runtime: detect, consent install, sign-in, sign-out, streaming runner, IPC (wave 2)
- [x] 08-03-PLAN.md - renderer: Subscriptions section, CLI provider shim and scope-gated picker, 11 locales (wave 3)
- [ ] 08-04-PLAN.md - prove against the real CLIs and the running app; verification (wave 4)

## Progress

| Phase | Status | Plans | Progress |
| ----- | ------ | ----- | -------- |
| 1     | ✓      | 1/1   | 100%     |
| 2     | ✓      | 1/1   | 100%     |
| 3     | ◆      | 1/1   | code merged (PR #11); AUTH-01 in review (PR #18), UI round trip pending |
| 4     | ◆      | 1/2   | code merged (PR #11, stt-api PR #26); STT-03 in review (PR #19), end-to-end dictation pending |
| 5     | ○      | 0/2   | 0%       |
| 6     | ○      | 0/4   | 0%       |
| 7     | ○      | 0/3   | 0%       |
| 8     | ◆      | 3/4   | 75%      |
