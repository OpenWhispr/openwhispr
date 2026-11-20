# Requirements: Titanium Whisper

**Defined:** 2026-11-08
**Core Value:** A user installs Titanium Whisper, signs in with their Titanium account, and dictates through our servers with no API keys and no OpenWhispr-hosted service.
**Source:** gap analysis https://claude.ai/artifact/XtuxrApjs3KME96u1x6CEw

## v1 Requirements

### Fork CI (CI)

- [x] **CI-01**: A CI build with no repository variables set is cloud-disabled (no `auth.openwhispr.com` or other OpenWhispr-hosted default in any workflow)
- [x] **CI-02**: Upstream-only workflows (winget, nix, llm/stt canaries, mobile CI, macOS/Linux notarize jobs, upstream sidecar release builders not used by the fork) do not run in the fork
- [x] **CI-03**: One Windows workflow runs on every PR and push to main: install (Node 24, Electron present), typecheck, lint, i18n check, full test suite, unsigned installer build
- [x] **CI-04**: The full test suite passes in that workflow (pre-existing "Electron failed to install" failures resolved by installing Electron; flaky tests fixed, never skipped)
- [x] **CI-05**: A smoke test boots the packaged/main entry with cloud disabled and asserts the default transcription route resolves to stt-api

### Rebrand (BRAND)

- [x] **BRAND-01**: Installer, executable, window titles, tray, menus and About show the product name (shipped as "EdgeAssistant", PR #12); `BRAND_NAME` is the single source for the product name in UI strings
- [x] **BRAND-02**: New appId / Windows AppUserModelID (`com.titaniumlabs.titaniumwhisper`) and a new tray GUID; uninstall/startup entries use the new identity
- [x] **BRAND-03**: On first launch, settings, history, notes and downloaded models from an existing OpenWhispr install are migrated (copy, never move) into the new userData
- [x] **BRAND-04**: App, tray and installer icons replaced with Titanium Whisper art
- [x] **BRAND-05**: Docs, support, community, repo URLs and package author email point to Titanium Labs; `DOCS_ORIGIN` comes from fork config; a test fails if runtime code references an OpenWhispr-hosted domain
- [x] **BRAND-06**: Product-name strings in all locale files use the brand (credits/attribution to OpenWhispr kept where required by license)
- [x] **BRAND-07**: Sidecar download scripts fetch from `finedesignz/openwhispr` releases; NixOS info and CONTRIBUTING point at the fork

### Titanium sign-in (AUTH)

- [x] **AUTH-01**: App slug `titanium-whisper` is provisioned in Titanium (Keygen product + policy, `apps` row) with return origin `titaniumwhisper://auth` allowed (open item: dev/staging schemes `titaniumwhisper-dev://auth` and `titaniumwhisper-staging://auth` are not yet allowed in the titanium-licensing app row; ticketed to titanium-licensing via memlog request 1795213470930-0)
- [x] **AUTH-02**: User signs in from the app: browser opens Titanium hosted login (magic link / passkey / Google), returns via `titaniumwhisper://auth?act=…`, app exchanges `act` for `{licenseKey, email}`
- [x] **AUTH-03**: License key is verified offline in the Electron main process with `@titanium-labs/license-client` (no Redis on the client), cached under userData, and re-checked on launch (offline-first)
- [x] **AUTH-04**: Renderer auth state (`useAuth`) reflects Titanium sign-in: signed in, email, sign out (clears cache), replacing the better-auth client
- [x] **AUTH-05**: Plan/paid state comes from Titanium and drives existing `isPaid` gating. Re-homed to Phase 7 (07-01, PR #21): in a fork build a valid offline-verified Titanium license is the paid plan (`connectorEligibility.ts:50-60`, `titaniumSession.js:178-197`, `titaniumConnectorPolicy.js:15`). Deviation: `GET /v1/licenses/lookup` via a server we own is not used (no such call in `src/` or `scripts/`); plan-tier granularity is deferred to v2 (AUTH-08)
- [x] **AUTH-06**: An authenticated user with `licenseKey: null` sees a clear "no license" state with a link to get one; the app never crashes

### Transcription on our servers (STT)

- [x] **STT-01**: stt-api accepts a Titanium license key as bearer (offline Ed25519 verify, product match, expiry, blocklist check server-side) on all routes including WS; shared `STT_API_TOKEN` kept only as operator credential
- [x] **STT-02**: The app sends the signed-in user's license key to stt-api automatically; no STT key field is needed
- [x] **STT-03**: stt-api is reachable on a stable domain and the fork default uses it (no Coolify-generated hostname)
- [x] **STT-04**: With an English-only STT model, the language picker can't silently produce non-English dictation (restricted or warned)
- [ ] **STT-05**: Meeting transcription and the live dictation preview can stream to stt-api's WS endpoint
- [ ] **STT-06**: File uploads through stt-api return segment timestamps and speaker labels
- [ ] **STT-07**: Dictation cleanup can run through stt-api's cleanup with no BYOK key, and is the default when signed in

### Hosted features (FEAT)

- [ ] **FEAT-01**: Agent web search works for signed-in users through our own endpoint (gated by license key)
- [ ] **FEAT-02**: Slack and Linear OAuth relay hosted on our services host; relay base `SERVICES_URL` configured (`SITE_URL` stays the website base)
- [ ] **FEAT-03**: Google and Microsoft calendar connect work in fork builds (our OAuth client ids supplied at build)
- [ ] **FEAT-04**: Connector logins are keyed to the Titanium account (stable id, IDP-32) and connectors work when signed in on a paid plan
- [ ] **FEAT-05**: Assistant capability messages tell users to sign in with Titanium (not OpenWhispr) and never offer an action the user can't take
- [ ] **FEAT-06**: Dropped cloud features (sync, cloud search, referral, leaderboard, enterprise console, mobile sync, developer integrations) are hidden with no dead entry points

### Operations (OPS)

- [x] **OPS-01**: Upstream sync runbook: cadence, conflict-hotspot list, re-test checklist

## v2 Requirements

- **PLAT-01**: macOS build, signing and notarization
- **PLAT-02**: Linux AppImage
- **AUTH-07**: Sign in via Titanium OIDC (after Titanium v3.6)
- **AUTH-08**: Plan tier (trial / pro / business) from `GET /v1/licenses/lookup` via a server we own, if a feature needs more than "has a valid license"

## Out of Scope

| Feature                                                                  | Reason                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| macOS/Linux                                                              | Owner: Windows only this milestone                            |
| Notes cloud sync, referral, leaderboard, enterprise console, mobile sync | No backend of ours; dropped                                   |
| Redis access from the desktop                                            | Credentials can't ship to clients; servers enforce revocation |

## Traceability

| Requirement  | Phase   | Status                                                                                                                              |
| ------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| CI-01, 03, 05 | Phase 1 | Complete (PR #10, merged 2026-11-09)                                                                                               |
| CI-02        | Phase 1 | Complete (PR #17 merged 2026-11-18: mobile CI gated; PR #4 cherry-picked and closed)                                                |
| CI-04        | Phase 1 | Complete (PR #17 merged 2026-11-18; PR checks `quality` and `build-windows` passed; root cause CRLF, fixed by `.gitattributes`). Caveat: 20 Windows-only local test failures remain (see `phases/04-leftovers-VERIFICATION.md`, v1.0 audit) |
| OPS-01       | Phase 1 | Complete (PR #10, `docs/UPSTREAM-SYNC.md`)                                                                                          |
| BRAND-01..07 | Phase 2 | Complete (PR #11, PR #12). Visible name is "EdgeAssistant"; appId `com.titaniumlabs.titaniumwhisper`, userData "Titanium Whisper" kept |
| AUTH-01      | Phase 3 | Complete (PR #18 merged 2026-11-20): `titanium-whisper` provisioned (product id bbe843ac-4de5-486c-85e2-1a1b7e533e5f), `titaniumwhisper://auth` allowed. OPEN: dev/staging return_url schemes not yet allowed in the titanium-licensing app row (memlog request 1795213470930-0) |
| AUTH-02..04  | Phase 3 | Complete in code (PR #11; AUTH-04 as a separate `useTitaniumAuth`); end-to-end UI sign-in round trip not yet run                     |
| AUTH-05      | Phase 7 | Complete in code (re-homed from Phase 6, PR #21): fork `isPaid` = valid offline Titanium license (see AUTH-05 evidence). Lookup endpoint not built; tiers deferred to AUTH-08 |
| AUTH-06      | Phase 3 | Complete in code (PR #11)                                                                                                           |
| STT-01       | Phase 4 | Complete (stt-api PR #26 merged; prod `TITANIUM_KEYGEN_PRODUCT_ID`/`PUBLIC_KEY` set)                                                |
| STT-02, 04   | Phase 4 | Complete in code (PR #11); end-to-end dictation with a license key pending PR #18/#19 merges                                        |
| STT-03       | Phase 4 | Complete (PR #19 merged 2026-11-18): `stt.titaniumlabs.us` live with valid TLS, old Coolify host kept, saved-URL migration         |
| STT-05..07   | Phase 5 | Planned (05-01, 05-02)                                                                                                              |
| FEAT-01..03  | Phase 6 | Planned (06-01..06-04)                                                                                                              |
| FEAT-04..06  | Phase 7 | Planned (07-01..07-03); FEAT-04 dependency IDP-32 merged (titanium-licensing PR #304, 2026-10-14)                                   |

**Coverage:**

- v1 requirements: 36 total
- Mapped to phases: 36
- Unmapped: 0 ✓

---

_Requirements defined: 2026-11-08_
_Last updated: 2026-11-20 after verifying merged PRs for CI-02, CI-04, AUTH-01, STT-03 and re-homing AUTH-05_
