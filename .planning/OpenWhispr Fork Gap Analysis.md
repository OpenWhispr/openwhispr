# OpenWhispr Fork Gap Analysis

finedesignz/openwhispr · main `90b8b5a` (upstream v1.10.4 + Phase 1a) · reviewed Nov 8, 2026 · static code review, app not run

**Bottom line:** Phase 1a removed the cloud dependency, but the plan stops there. The only written plan is the five-bullet "Phase 1b (rebrand)" list in [PR #8](https://github.com/finedesignz/openwhispr/pull/8). No phase covers what replaces the cloud features, how users get a token for our STT API, or how the fork's CI and releases work.

**Do first:** fix the CI defaults that turn the cloud back on and turn off the winget job (#3). They're cheap, and a CI-built release would otherwise ship pointed at `auth.openwhispr.com`. Second: decide how STT tokens are distributed (#2). Without one, a fresh install can't transcribe.

## Decision: sign-in moves to Titanium

Owner direction (Nov 8): the fork signs users in through our own servers, not the OpenWhispr cloud. Titanium licensing already has the pieces. Here is what the switch changes.

| Area | Today in the fork | With Titanium |
| --- | --- | --- |
| Login client | better-auth client against `AUTH_URL` (`src/lib/auth.ts:20`), empty, so always signed out | Replace with Titanium's desktop flow: browser login (magic link, passkey or Google) → one-time token exchange → license key verified offline. Spec: `titanium-licensing/docs/consumer-integration/tauri.md`, same Node SDK (`@titanium-labs/license-client`) run in Electron main |
| "Signed in" state | `useAuth` forced off when `!CLOUD_ENABLED` | Driven by the Titanium session, so the account-gated features in gaps #1 and #8 come back |
| STT access (#2) | One shared `STT_API_TOKEN`, not distributed | stt-api checks each user's Titanium license instead (an stt-api change); no shared secret ships in the installer |
| Paid gating | `isPaid` from OpenWhispr billing | Plan read from the Titanium license (`GET /v1/licenses/lookup`) and Stripe through stripe-sync |
| App registration | none | `POST /v1/apps/provision` creates the slug, Keygen product and policy |

**Dependencies on titanium-licensing:** connectors store logins per account, so they need a stable account id. That is v3.5 Phase 32 (IDP-32), which is not merged (Phase 31 PRs were still in review per STATE.md, Oct 14). Standard OIDC sign-in is the v3.6 plan (Phases 39–48), which is not started. Until then the fork uses Titanium's own exchange flow, not OIDC.

## Plan as written vs. code

| Phase 1b item (PR #8) | Status | Evidence |
| --- | --- | --- |
| Docs `DOCS_ORIGIN` | open | Hardcoded `https://docs.openwhispr.com` in `src/helpers/productHelpFallback.js:3`; `scripts/help-eval.js:65` too |
| Windows AppUserModelID | open + conflict | `com.gizmolabs.openwhispr` in `main.js:52` and `electron-builder.json:2`. FORK-BUILD.md relies on the unchanged appId for in-place upgrade, so changing it breaks upgrades, tray placement and login items. Needs a decision first. |
| 2 en locale strings | open | Not identified in the PR |
| `COMMUNITY_URL`, `REPO_URL` | open | Both empty in `src/config/fork.config.json` (Help entry and support row hidden) |
| Icons and product name | open | `BRAND_NAME: "BRAND_PLACEHOLDER"` is read nowhere outside the config files |

Rebrand items missing from the list: `package.json:95` author email `support@openwhispr.com`; `NixOsPasteInfo.tsx:20` points at the upstream flake; `.github/CONTRIBUTING.md` points upstream; the 6 sidecar download scripts (`scripts/download-windows-*.js`, text-monitor, AEC helper) pull binaries from `OpenWhispr/openwhispr` releases, not the fork's mirrored tags.

## Gaps the plan doesn't cover

1. ### P01 · Connectors and assistant tools are dead, and the UI says to sign in

   Every connector action requires a signed-in OpenWhispr account. Credentials are even stored per account. With cloud off, Gmail, Slack, Linear and GitHub can't work. Integrations → Connectors is still shown, with a paid-plan upsell. The assistant tells users to "sign in" for web search and connectors, which they can't do in this fork.

   `connectorManager.js:124` → `signed_out`; `connectorCredentials.js:34`; `ConnectorsSection.tsx:25-63` (`isPaid`); `agentCapabilities.ts:86,107`; `integrationsSections.ts:16` hides only the developer group. Web search posts to `${apiUrl}/api/agent/web-search` (`ipcHandlers.js:10345`). Slack and Linear OAuth redirect through a relay at `SITE_URL`, which is empty.

   **With Titanium sign-in:** key connector logins to the Titanium account id (needs IDP-32), host the Slack/Linear OAuth relay on our own site (`SITE_URL`), and run web search through our own backend or drop it. Until then, hide connectors and point the "sign in" text at Titanium login.
2. ### P02 · The default STT endpoint needs a token that nothing supplies

   `DEFAULT_STT` sets only a URL and a model. stt-api answers 401 to any request without a bearer token (confirmed in its STATE.md, Oct 7). A fresh install can't transcribe until the user pastes `STT_API_TOKEN` into the Custom key field, and the plan doesn't say how they get one. The URL is also Coolify's generated hostname (`x1gsjcjrmssitgnh7hthg7nd.coolify.titaniumlabs.us`). It gets saved into each user's settings, so changing it later needs a migration.

   **With Titanium sign-in:** stt-api checks each user's Titanium license (key or account token) instead of the shared bearer token. Put a stable domain in front of stt-api before the first release.
3. ### P03 · The fork's CI would build cloud-enabled releases, and the winget job targets upstream's package
   - `release.yml:148,259,386` and `build-and-notarize.yml:152,266,405` default `VITE_AUTH_URL` to `https://auth.openwhispr.com`. A CI build turns cloud back on.
   - `update-winget.yml:61` submits as `OpenWhispr.OpenWhispr`. It ran on both fork releases (v1.10.3, v1.10.4) and failed only because it had no token.
   - Release on tag v1.10.4 failed; scheduled `stt-canary` and `llm-canary` fail (Nov 2); Build and Notarize fails on open PR #6.

   **Add a phase:** fork CI. Disable the upstream-only jobs (winget, nix, canaries, notarize), remove the hosted defaults, and add one Windows build-and-test job. The real release is built by hand today (FORK-BUILD.md).
4. ### P14 · Meetings and live preview can't use our STT API

   stt-api serves `WS /v1/transcriptions/stream`, but the app has no client for it. Meeting streaming accepts only OpenAI, AssemblyAI, Deepgram, Corti, Tinfoil or local. With cloud off, meeting notes need someone's BYOK key or a local model.

   `src/helpers/meetingStreamingProviders.js:7-13`; the Orukeet cloud stream is disabled with cloud off.
5. ### P15 · Uploads through stt-api lose timestamps and speakers

   The Custom route gets no timestamp fields, and diarization is only requested when the endpoint is OpenAI or Mistral. stt-api already diarizes (ERes2Net), but the app never asks it to.

   `uploadTimestamps.js:7-18` returns null for custom; `ipcHandlers.js:10881-10899` drops speakers for other hosts.
6. ### P16 · Cleanup and the assistant have no default with cloud off

   The fork sets inference to `providers`, but no provider is configured, so cleanup and the agent stay off until the user brings an API key or a local model. stt-api already runs Claude-OAuth cleanup. The plan doesn't say whether the app should use it.

   `src/config/forkDefaults.ts`
7. ### P17 · The default model is English-only

   `parakeet-unified-en-0.6b` is English-only, but the language picker still offers 60 languages. Non-English dictation will come back as garbage, with no warning.
8. ### P18 · No decision on lost cloud features

   These are now hidden or broken, with nothing recorded about whether they're dropped for good: notes cloud sync and backup, cloud note search, web search, referral and leaderboard, enterprise console, mobile companion sync, and the API/MCP/CLI developer integrations.
9. ### P19 · Calendar OAuth clients aren't part of the fork build

   Google and Microsoft calendar connect read `GOOGLE_CALENDAR_CLIENT_ID` and `MICROSOFT_CALENDAR_CLIENT_ID` from env. FORK-BUILD.md doesn't set them. Fork builds likely ship with calendar connect unconfigured. Not verified on a built installer.
10. ### P210 · Windows only

    Signing and the release steps cover Windows. Nothing is planned for macOS (signing, notarization, the Accessibility re-grant after a bundle change) or Linux (AppImage).
11. ### P211 · No upstream sync process

    The fork carries a 53-file diff in hot files (`ipcHandlers.js`, `main.js`, onboarding, settings). There's no sync schedule, conflict-hotspot list or re-test checklist. I couldn't check upstream's current version (the GitHub API returned 403 from here).
12. ### P212 · No test baseline or smoke test

    74 test files fail on base (no Electron install) and 2 are flaky, per PR #8. No CI runs the suite, and no end-to-end check covers a fresh install with cloud off: onboarding → dictation through stt-api → paste.
13. ### P213 · The plan lives only in a PR description

    The repo has no `.planning/` directory, no requirements and no acceptance criteria. The phase list exists only in the PR #8 body, unlike the other three repos.

## Suggested phase order

| Phase | Scope | Covers |
| --- | --- | --- |
| 1c · Fork CI | Remove hosted defaults, disable upstream-only jobs, one Windows build-and-test job, smoke test | #3, #12 |
| 1b · Rebrand | As planned, plus the missing items above; decide the AppUserModelID first | table above |
| 1d · Titanium sign-in | Provision the app slug; replace the better-auth client with Titanium login and license; stt-api checks Titanium licenses; plan gating from the license | #1, #2, decision above |
| 2 · Self-hosted parity | Stable STT domain, language guard, streaming client for meetings and preview, diarization and timestamps, cleanup routing | #2, #4–7 |
| 3 · Feature decisions | Connectors rekeyed to Titanium accounts (after IDP-32), web search, sync, calendars, macOS/Linux | #1, #8–10 |
| Ongoing | Upstream sync runbook; move the plan into `.planning/` | #11, #13 |

Not verified: runtime behavior (the app wasn't run), whether guest onboarding asks for the STT key, calendar client IDs in a built installer, upstream's latest release.