# Milestone v1.0 - Project Summary

**Generated:** 2026-11-18
**Purpose:** Team onboarding and project review
**Milestone:** v1.0 "Titanium Whisper on Titanium servers" (code TIWH), in progress
**Repo:** `finedesignz/openwhispr` (fork of `OpenWhispr/openwhispr`), local dir `edgeassistant`

> Planning docs (`STATE.md`, `ROADMAP.md`, `REQUIREMENTS.md`) were last updated 2026-11-09 and are behind the code. This summary reconciles them with the live repo as checked on 2026-11-18 (git `origin/main` 13e8adafe, `gh pr list`, `src/config/fork.config.json`). Where they disagree, the live state is used and the difference is noted.

---

## 1. Project Overview

The fork ships OpenWhispr's Electron dictation app (local dictation, notes, meetings, assistant) as a Titanium Labs Windows product where every hosted service is ours: sign-in and entitlement through Titanium licensing, transcription and cleanup through `openwhispr-stt-api`, and our own endpoints for web search and OAuth relays.

**Core value:** a user installs the app, signs in with a Titanium account, and dictates through our servers with no API keys and no OpenWhispr-hosted service.

**Name change after planning:** the roadmap calls the product "Titanium Whisper". PR #12 (merged 2026-11-11) renamed the visible product to **EdgeAssistant** (`BRAND_NAME`, installer `EdgeAssistant-Setup-<version>.exe`, executable `edgeassistant`, new icon set). The internal identity was deliberately kept: appId `com.titaniumlabs.titaniumwhisper`, URL scheme `titaniumwhisper://`, userData folder `%APPDATA%\Titanium Whisper`, tray GUID. Installs upgrade in place.

**Target users:** Titanium Labs staff first, then clients, Windows only.

**Position:** phases 1-4 merged in code; phases 5-7 not started. Three Phase 3/4 items still wait on configuration outside this repo (see section 4).

## 2. Architecture & Technical Decisions

- **Fork config seam instead of scattered edits.** `src/config/fork.config.json` + `forkConfig.js` / `forkRuntime.ts` / `forkKeys.js` hold every fork-specific value; a `CLOUD_ENABLED` gate turns OpenWhispr cloud off when the hosted URLs are empty.
  - **Why:** the fork carries a 53-file diff on hot upstream files; one seam keeps upstream syncs feasible. **Phase:** 1a (PR #8).
- **Root `CLAUDE.md` stays upstream-owned.** Fork notes live in `.claude/CLAUDE.md`; the 124 KB root file is excluded from session load. **Why:** avoid conflicts on every upstream sync. **PR:** #6.
- **Sign-in through Titanium licensing, not OpenWhispr cloud or OIDC.** Browser login -> `titaniumwhisper://auth?act=...` deep link -> `POST /api/exchange` -> license key verified offline in Electron main with `@titanium-labs/license-client`. **Why:** "our own servers" (owner, 2026-11-08); Titanium OIDC (v3.6) is not built. **Phase:** 3.
- **Separate `useTitaniumAuth` hook.** `useAuth` stays the (disabled) cloud session rather than being replaced. **Why:** smaller diff against upstream. **Phase:** 3 (deviation from AUTH-04 wording).
- **License key is the single bearer for our servers.** stt-api verifies it offline (Ed25519, product match, expiry) and checks the blocklist server-side; the shared `STT_API_TOKEN` stays operator-only. **Why:** one credential, nothing secret in the installer. **Phase:** 4 (stt-api PR #26).
- **No Redis on the desktop.** Revocation is enforced by servers. **Why:** Redis credentials can't ship to clients.
- **Plan/paid lookup moved to Phase 6.** **Why:** `GET /v1/licenses/lookup` needs a portal token that can't ship in the app, so it needs a server we own.
- **Windows only, signed with Azure Trusted Signing (Titanium Labs LLC).** **Why:** owner scope decision 2026-11-08; signing per PR #7.
- **Keep appId/userData stable across the EdgeAssistant rename.** **Why:** in-place upgrades, tray placement and login items survive. **PR:** #12.

## 3. Phases Delivered

| Phase | Name                             | Status (live)                                 | One-liner                                                                                                  |
| ----- | -------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1     | Fork CI & sync runbook           | Merged (PR #10, 2026-11-09)                   | Cloud-disabled CI builds, upstream-only jobs guarded, Windows build + smoke check, `docs/UPSTREAM-SYNC.md` |
| 2     | Rebrand                          | Merged (PR #11, then renamed by PR #12)       | Brand from config, new appId, userData migration from `OpenWhispr`, sidecars from fork releases            |
| 3     | Titanium sign-in                 | Merged in code (PR #11); not live             | Deep-link exchange + offline license; blocked on app provisioning                                          |
| 4     | stt-api on Titanium auth         | Merged (app PR #11, stt-api PR #26); not live | App sends license key; stt-api accepts it; stable domain still missing                                     |
| 5     | Self-hosted transcription parity | Not started                                   | WS streaming for meetings/preview, diarization + timestamps on upload, cleanup via stt-api                 |
| 6     | Hosted services                  | Not started                                   | Web search, Slack/Linear OAuth relay, calendar OAuth clients, plan lookup                                  |
| 7     | Connectors on Titanium accounts  | Not started                                   | Connectors keyed to Titanium account id; needs titanium-licensing IDP-32                                   |

No per-phase `SUMMARY.md`, `CONTEXT.md` or `VERIFICATION.md` files exist; phases 1-4 were delivered as PRs straight from the roadmap. Phase status above comes from PR merge state.

## 4. Requirements Coverage

36 v1 requirements across 7 phases.

**Phase 1**

- ✅ CI-01..CI-05, OPS-01 - merged in PR #10.
- ⚠️ CI-02 regression signal: `Mobile CI` still runs on `main` (runs 2026-11-11 and 2026-11-15). Canaries now show `skipped`, so the guard works for them.
- ⚠️ CI-04: PR #12 reported 7 failing tests on clean `origin/main` (`forkWorkflows` x6, `leaderboardNavigation` x1). The requirement is a green full suite.

**Phase 2**

- ✅ BRAND-01..BRAND-06 - merged (brand now EdgeAssistant, not "Titanium Whisper").
- ⚠️ BRAND-05: `DOCS_URL` and `COMMUNITY_URL` are still empty in `fork.config.json`.
- ⚠️ BRAND-07: sidecars and CONTRIBUTING done; NixOS info left upstream (Linux out of scope).

**Phase 3**

- ❌ AUTH-01 - `titanium-whisper` app not provisioned: `TITANIUM.keygenProductId` is still `""` on `origin/main`, so keys report "unconfigured".
- ✅ AUTH-02, AUTH-03, AUTH-04 (as `useTitaniumAuth`), AUTH-06 - in code; not proven end to end because AUTH-01 is open.
- ➡️ AUTH-05 - moved to Phase 6.

**Phase 4**

- ✅ STT-01 - stt-api PR #26 merged 2026-11-09. Unverified here: whether the stt-api Coolify app has `TITANIUM_KEYGEN_*` env set.
- ✅ STT-02, STT-04 - merged in PR #11.
- ❌ STT-03 - `DEFAULT_STT.baseUrl` is still the Coolify hostname `x1gsjcjrmssitgnh7hthg7nd.coolify.titaniumlabs.us`; it is saved into user settings, so changing it after a release needs a migration.

**Phases 5-7**

- ❌ STT-05..07, FEAT-01..06 - not started. FEAT-04 also blocked on titanium-licensing IDP-32.

No milestone audit file exists.

## 5. Key Decisions Log

| ID  | Decision                                                                                                                        | Source             | Rationale                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| D1  | Run with OpenWhispr cloud disabled via config seam                                                                              | Phase 1a, PR #8    | Remove the hosted dependency without forking hot files further |
| D2  | Default STT = Custom provider pointed at stt-api                                                                                | Phase 1a           | Works with no BYOK key                                         |
| D3  | Product name "Titanium Whisper"                                                                                                 | Owner, 2026-11-08  | Superseded by D10                                              |
| D4  | New appId + userData migration (copy, never move)                                                                               | Owner, 2026-11-08  | Accept reinstall; keep user data                               |
| D5  | Sign in through Titanium exchange flow                                                                                          | Owner, 2026-11-08  | Our own servers; OIDC not built                                |
| D6  | Host our own web search, gated by sign-in                                                                                       | Owner, 2026-11-08  | Replace OpenWhispr cloud search                                |
| D7  | Windows only this milestone                                                                                                     | Owner, 2026-11-08  | macOS/Linux deferred to v2                                     |
| D8  | Desktop omits Redis blocklist                                                                                                   | Planning           | Credentials can't ship to clients                              |
| D9  | License key as bearer for stt-api and search                                                                                    | Planning           | One credential, verifiable offline server-side                 |
| D10 | Visible brand EdgeAssistant, internal identity unchanged                                                                        | PR #12, 2026-11-11 | Rename without breaking in-place upgrades                      |
| D11 | Dropped cloud features: notes sync, cloud search, referral, leaderboard, enterprise console, mobile sync, developer API/MCP/CLI | PROJECT.md         | No backend of ours                                             |

`PROJECT.md` still lists D3-D9 as "Pending"; phases 1-4 shipped on them.

## 6. Tech Debt & Deferred Items

- **Planning docs out of date:** `STATE.md` says "phases 2-4 in review" and uses the name Titanium Whisper; both are wrong as of 2026-11-11. ROADMAP progress table and REQUIREMENTS checkboxes also need updating.
- **Failing tests on main:** 7 failures per PR #12 (`forkWorkflows` x6, `leaderboardNavigation` x1).
- **Mobile CI still runs in the fork** despite CI-02.
- **No fork release since v1.10.4** (2026-10-26). Nothing from phases 1-4 or the EdgeAssistant rename has shipped to users.
- **Open PR #4** (`computeChunkStats` odd-offset Buffer crash), open since 2026-10-20.
- **Default model is English-only** (`parakeet-unified-en-0.6b`); STT-04 guards the language picker.
- **Gaps from the 2026-11-15 gap analysis not yet in the roadmap:** calendar OAuth client ids absent from fork builds (P19, now FEAT-03), upstream sync cadence (OPS-01 covers the runbook only).
- **Deferred to v2:** macOS build/signing/notarization (PLAT-01), Linux AppImage (PLAT-02), Titanium OIDC sign-in (AUTH-07).
- **External dependencies:** titanium-licensing IDP-32 (Phase 7); own Google/Microsoft/Slack/Linear OAuth apps and a web-search provider (Phase 6).

## 7. Getting Started

- **Run:** `npm run dev` (Vite renderer + Electron main; `predev` downloads sidecars). Use Node 24 (`.nvmrc`); for installs use `nvm exec 24 npm install`.
- **Test:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run i18n:check`. One file: `node --import tsx --test test/helpers/<name>.test.js`.
- **Build:** see `FORK-BUILD.md` (signed Windows build, Azure Trusted Signing). Unsigned local: `npm run pack`.
- **Fork seam:** `src/config/fork.config.json` and `src/config/forkDefaults.ts` first; then `forkConfig.js` / `forkRuntime.ts`.
- **Titanium sign-in:** `useTitaniumAuth` (renderer) and the license/exchange code in Electron main.
- **Reference:** `.claude/CLAUDE.md` (fork index) -> root `CLAUDE.md` (upstream technical reference, grep by heading). Upstream syncs: `docs/UPSTREAM-SYNC.md`.
- **Planning:** `.planning/PROJECT.md`, `ROADMAP.md`, `REQUIREMENTS.md`, `OpenWhispr Fork Gap Analysis.md`.

---

## Stats

- **Timeline:** 2026-10-13 (first fork PR merged) -> 2026-11-15 (last merge); milestone defined 2026-11-08
- **Phases:** 4 merged in code / 7 total (1 fully live; 3 and 4 wait on config outside the repo)
- **Fork PRs:** 12 merged, 1 open (#4); stt-api: PR #26 for this milestone
- **Commits since v1.10.3 sync (6f9b55185):** 68 non-merge, 552 files changed (+35,594 / -6,233). Includes the upstream v1.10.4 sync, so most lines are upstream.
- **Fork contributors:** Michael, Claude (rest of the authors in that range are upstream contributors brought in by the sync)
