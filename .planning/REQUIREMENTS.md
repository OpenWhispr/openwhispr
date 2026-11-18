# Requirements: Titanium Whisper

**Defined:** 2026-11-08
**Core Value:** A user installs Titanium Whisper, signs in with their Titanium account, and dictates through our servers with no API keys and no OpenWhispr-hosted service.
**Source:** gap analysis https://claude.ai/artifact/XtuxrApjs3KME96u1x6CEw

## v1 Requirements

### Fork CI (CI)

- [ ] **CI-01**: A CI build with no repository variables set is cloud-disabled (no `auth.openwhispr.com` or other OpenWhispr-hosted default in any workflow)
- [ ] **CI-02**: Upstream-only workflows (winget, nix, llm/stt canaries, mobile CI, macOS/Linux notarize jobs, upstream sidecar release builders not used by the fork) do not run in the fork
- [ ] **CI-03**: One Windows workflow runs on every PR and push to main: install (Node 24, Electron present), typecheck, lint, i18n check, full test suite, unsigned installer build
- [ ] **CI-04**: The full test suite passes in that workflow (pre-existing "Electron failed to install" failures resolved by installing Electron; flaky tests fixed, never skipped)
- [ ] **CI-05**: A smoke test boots the packaged/main entry with cloud disabled and asserts the default transcription route resolves to stt-api

### Rebrand (BRAND)

- [ ] **BRAND-01**: Installer, executable, window titles, tray, menus and About show "Titanium Whisper"; `BRAND_NAME` is the single source for the product name in UI strings
- [ ] **BRAND-02**: New appId / Windows AppUserModelID (`com.titaniumlabs.titaniumwhisper`) and a new tray GUID; uninstall/startup entries use the new identity
- [ ] **BRAND-03**: On first launch, settings, history, notes and downloaded models from an existing OpenWhispr install are migrated (copy, never move) into the new userData
- [ ] **BRAND-04**: App, tray and installer icons replaced with Titanium Whisper art
- [ ] **BRAND-05**: Docs, support, community, repo URLs and package author email point to Titanium Labs; `DOCS_ORIGIN` comes from fork config; a test fails if runtime code references an OpenWhispr-hosted domain
- [ ] **BRAND-06**: Product-name strings in all locale files use the brand (credits/attribution to OpenWhispr kept where required by license)
- [ ] **BRAND-07**: Sidecar download scripts fetch from `finedesignz/openwhispr` releases; NixOS info and CONTRIBUTING point at the fork

### Titanium sign-in (AUTH)

- [ ] **AUTH-01**: App slug `titanium-whisper` is provisioned in Titanium (Keygen product + policy, `apps` row) with return origin `titaniumwhisper://auth` allowed
- [ ] **AUTH-02**: User signs in from the app: browser opens Titanium hosted login (magic link / passkey / Google), returns via `titaniumwhisper://auth?act=…`, app exchanges `act` for `{licenseKey, email}`
- [ ] **AUTH-03**: License key is verified offline in the Electron main process with `@titanium-labs/license-client` (no Redis on the client), cached under userData, and re-checked on launch (offline-first)
- [ ] **AUTH-04**: Renderer auth state (`useAuth`) reflects Titanium sign-in: signed in, email, sign out (clears cache), replacing the better-auth client
- [ ] **AUTH-05**: Plan/paid state comes from Titanium (`GET /v1/licenses/lookup` via a server we own) and drives existing `isPaid` gating
- [ ] **AUTH-06**: An authenticated user with `licenseKey: null` sees a clear "no license" state with a link to get one; the app never crashes

### Transcription on our servers (STT)

- [ ] **STT-01**: stt-api accepts a Titanium license key as bearer (offline Ed25519 verify, product match, expiry, blocklist check server-side) on all routes including WS; shared `STT_API_TOKEN` kept only as operator credential
- [ ] **STT-02**: The app sends the signed-in user's license key to stt-api automatically; no STT key field is needed
- [ ] **STT-03**: stt-api is reachable on a stable domain and the fork default uses it (no Coolify-generated hostname)
- [ ] **STT-04**: With an English-only STT model, the language picker can't silently produce non-English dictation (restricted or warned)
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

- [ ] **OPS-01**: Upstream sync runbook: cadence, conflict-hotspot list, re-test checklist

## v2 Requirements

- **PLAT-01**: macOS build, signing and notarization
- **PLAT-02**: Linux AppImage
- **AUTH-07**: Sign in via Titanium OIDC (after Titanium v3.6)

## Out of Scope

| Feature                                                                  | Reason                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| macOS/Linux                                                              | Owner: Windows only this milestone                            |
| Notes cloud sync, referral, leaderboard, enterprise console, mobile sync | No backend of ours; dropped                                   |
| Redis access from the desktop                                            | Credentials can't ship to clients; servers enforce revocation |

## Traceability

| Requirement  | Phase   | Status                                                                                                     |
| ------------ | ------- | ---------------------------------------------------------------------------------------------------------- |
| CI-01..CI-05 | Phase 1 | Complete (PR #10, merged 2026-11-09)                                                                       |
| OPS-01       | Phase 1 | Complete (PR #10, `docs/UPSTREAM-SYNC.md`)                                                                 |
| BRAND-01..06 | Phase 2 | In review                                                                                                  |
| BRAND-07     | Phase 2 | In review (sidecars + CONTRIBUTING); NixOS info left upstream: Linux out of scope                          |
| AUTH-01      | Phase 3 | Blocked: owner provisions `titanium-whisper` in Titanium, allows `titaniumwhisper://auth`, sets product id |
| AUTH-02..04  | Phase 3 | In review (AUTH-04 as a separate `useTitaniumAuth`; `useAuth` stays the cloud session)                     |
| AUTH-05      | Phase 6 | Moved: plan lookup needs a server we own (portal token can't ship in the app)                              |
| AUTH-06      | Phase 3 | In review                                                                                                  |
| STT-01       | Phase 4 | In review (stt-api PR); deploy needs TITANIUM_KEYGEN_* env on the stt-api Coolify app                      |
| STT-02, 04   | Phase 4 | In review                                                                                                  |
| STT-03       | Phase 4 | Blocked: owner DNS + Coolify domain for stt-api                                                            |
| STT-05..07   | Phase 5 | Pending                                                                                                    |
| FEAT-01..03  | Phase 6 | Pending                                                                                                    |
| FEAT-04..06  | Phase 7 | Pending (FEAT-04 blocked on titanium-licensing IDP-32)                                                     |

**Coverage:**

- v1 requirements: 36 total
- Mapped to phases: 36
- Unmapped: 0 ✓

---

_Requirements defined: 2026-11-08_
_Last updated: 2026-11-08 after initial definition_
