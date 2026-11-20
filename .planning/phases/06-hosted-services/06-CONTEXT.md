# Phase 6: Hosted services - Context

**Gathered:** 2026-11-18 (auto-decided by planner, discuss mode = auto, no owner questions)
**Status:** Ready for execution
**Requirements:** FEAT-01, FEAT-02, FEAT-03
**Repos:** `finedesignz/openwhispr` (desktop, this repo) and `finedesignz/openwhispr-stt-api` (server, own PR)

## Phase Boundary

Web search, the Slack/Linear OAuth relay and Google/Microsoft calendar connect run on Titanium Labs infrastructure in a fork (EdgeAssistant) build.

In scope: our web-search endpoint, the relay routes, our own OAuth clients (Google, Microsoft, Slack, Linear), build-time injection of their client ids, and the desktop changes that use them.

Out of scope (other phases): connector logins keyed to the Titanium account id and connector paid/sign-in gating (Phase 7, FEAT-04, blocked on IDP-32); any wording change in capability/"sign in" text (Phase 7, FEAT-05); hiding dropped features (Phase 7, FEAT-06); the stable stt-api domain itself (Phase 4, STT-03, branch `feat/tiwh-stt03-stable-domain`).

## Live findings (checked 2026-11-18 in this session)

| # | Finding | How checked |
|---|---------|-------------|
| F-1 | `agent-web-search` IPC posts to `${apiUrl}/api/agent/web-search` with better-auth cookies; in the fork `getApiUrl()` is empty, so it throws "OpenWhispr API URL not configured" | `src/helpers/ipcHandlers.js:10339-10373` |
| F-2 | The tool expects `{ results: [{ title, url, text, publishedDate }] }` | `src/services/tools/webSearchTool.ts:29-40` |
| F-3 | The tool registers only when `settings.isSignedIn && webSearchEnabled`; `isSignedIn` comes from better-auth `useAuth`, which does not read the Titanium session (no `titanium` reference in `src/hooks/useAuth.ts`), so it is always false in the fork | `src/services/tools/index.ts:60`, `src/components/chat/useChatStreaming.ts:452,476` |
| F-4 | Slack and Linear relay redirect = `${forkConfig.SITE_URL}/auth/{slack,linear}/callback`; `SITE_URL` is `""`, so the redirect URI is empty | `slackAuth.js:19-21`, `linearAuth.js:33-35`, `fork.config.json` |
| F-5 | Relay contract: the loopback flow sets `state = v1.<port>.<nonce>` (nonce = 32 random bytes hex = 64 chars) and listens on `127.0.0.1:<port>` at `/slack/callback` and `/linear/callback` | `oauthLoopbackFlow.js:96-100,216-218`, `slackAuth.js:22`, `linearAuth.js:22-24` |
| F-6 | `SITE_URL` also builds the terms/privacy links, contact-sales, reset-password and the hosted `/auth/desktop-callback` page | `rg SITE_URL src` |
| F-7 | Calendar connect (Google, Microsoft) passes no `renderResultPage`, so the loopback server 302s to `${SITE_URL}/auth/desktop-callback`; with `SITE_URL` empty, `new URL("")` throws after the token exchange, so calendar connect cannot complete in a fork build even with client ids. Connectors already use a local page (`connectors/oauthResultPage.js`) | `oauthLoopbackFlow.js:7-47,102-109`, `rg renderResultPage src/helpers` |
| F-8 | Client ids reach packaged builds through `resources/.env` (`electron-builder.json` extraResources `.env`; `environment.js:84-87`). Upstream `release.yml` writes them from GitHub secrets, but every release job is gated to `OpenWhispr/openwhispr`; the fork release is hand-built per `FORK-BUILD.md`, which writes no `.env` | `release.yml:22,63,155,270`, `FORK-BUILD.md` |
| F-9 | `titaniumServiceKeyFor(url)` hands the license key only to the `DEFAULT_STT` host plus `TITANIUM.serviceHosts` | `src/helpers/titanium/titaniumIpc.js:66-77` |
| F-10 | stt-api (Fastify) already authorizes every non-public route with operator token OR Titanium license key (`api/licenseAuth.js`, PR #26 merged); `PUBLIC_ROUTES = {"GET /healthz"}`; request log drops the query string | `git show origin/main:api/app.js` |
| F-11 | stt-api Coolify app `x1gsjcjrmssitgnh7hthg7nd` has fqdn `stt.titaniumlabs.us` attached, but HTTPS fails: `curl: (60) schannel: SEC_E_UNTRUSTED_ROOT` (default Traefik cert). Coolify hostname answers `/healthz` 200 | `coolify-api GET /applications`, `curl` |
| F-12 | stt-api env has no web-search key (names: STT_API_TOKEN, CLAUDE_CODE_OAUTH_TOKEN(+_EXPIRES_AT), STT_MODEL, PORT, STT_DIARIZATION, TITANIUM_KEYGEN_PRODUCT_ID, TITANIUM_KEYGEN_PUBLIC_KEY) | `coolify-api ... /envs -Keys` |
| F-13 | Proton Pass has `tavily` (fields `api_key`, `account`, `note`), `firecrawl` (`api_key`), `serpdog` (login only). No Brave, Exa or SearXNG | `pass-get --list`, `pass-keys` (names only) |
| F-14 | Pass has no login item for Slack, Linear, or a Titanium-owned Google account (`gmail` item holds only TLP/zenexa/realpatientportal addresses; `google` holds API client fields, not a login). `microsoft` has `username`/`password`; an Entra tenant exists (`tasklens-entra`, `azure-trusted-signing` tenant ids) | `pass-get --list`, `pass-keys` |
| F-15 | Scopes in code: Google `openid email calendar.events.readonly calendar.calendarlist.readonly`; Microsoft `openid profile email offline_access User.Read Calendars.Read` on the `common` authority, PKCE, no secret; Slack user scopes `chat:write channels:read groups:read im:write users:read users:read.email` (PKCE, rotating tokens); Linear `read issues:create comments:create` (PKCE, no secret) | `googleCalendarOAuth.js:6-7`, `microsoftCalendarOAuth.js:6-11`, `slackAuth.js:3-11`, CLAUDE.md Linear bullet |

## Implementation Decisions

- **D-01 Host:** the web-search proxy and the Slack/Linear relay live in the existing stt-api service, on its stable domain `https://stt.titaniumlabs.us` (STT-03). No new service. Rationale: it already has license-key auth, a Coolify app, CI and a domain; two small route modules is the smallest footprint.
- **D-02 Config key:** new fork key `SERVICES_URL` = `https://stt.titaniumlabs.us` in `src/config/fork.config.json`, added to `OVERRIDE_KEYS` in `src/config/forkKeys.js` (so `VITE_SERVICES_URL` overrides it in main, renderer and `runtime-env.json`). Web search and both relays use it. `SITE_URL` stays the website base (F-6); pointing it at an API host would turn the terms/privacy/contact-sales links into 404s. FEAT-02's "`SITE_URL` configured" is met by `SERVICES_URL`; 06-02 updates the FEAT-02 wording in REQUIREMENTS.md to say so.
- **D-03 License key host allow-list:** `titaniumServiceKeyFor` also allows the `SERVICES_URL` host, so the key reaches web search even before STT-03 changes `DEFAULT_STT`. Any other host still gets no key.
- **D-04 Search provider: Tavily.** Server-held key (`TAVILY_API_KEY` in stt-api Coolify env, value from Pass `tavily` `api_key`); no per-user BYOK. Tavily returns `title/url/content/published_date`; the server maps to F-2's shape so `webSearchTool.ts` stays unchanged. Rejected: SearXNG self-host (new service, upstream engines rate-limit/block), Firecrawl (scrape-first, not a search ranking API), serpdog (no API key in Pass), Brave/Exa (no key exists).
- **D-05 Endpoint:** `POST /v1/agent/web-search`, body `{ query, numResults }`, behind the existing onRequest authorizer (license key or operator token). `query` 1..400 chars after trim; `numResults` integer clamped to 1..10 (default 5). Per-principal fixed-window rate limit, default 30/min (`WEB_SEARCH_RATE_PER_MIN`), keyed by `licenseId` (operator shares one bucket). Tavily call timeout 15 s. Errors: 400 `invalid_request`, 429 `rate_limited`, 502 `search_upstream_error`, 503 `web_search_unconfigured` (no key), 504 `search_timeout`. Never log the query text or the Tavily key.
- **D-06 Desktop IPC:** when `forkConfig.CLOUD_ENABLED` is false (always, in the fork), `agent-web-search` delegates to a new pure module `src/helpers/forkWebSearch.js`: URL `${SERVICES_URL}/v1/agent/web-search`, bearer = `titaniumServiceKeyFor(url)`. No key -> `{ success:false, code:"AUTH_REQUIRED" }`; 401 -> `AUTH_EXPIRED`; 429 -> `RATE_LIMITED`; 5xx -> `SERVER_ERROR`; 200 -> `{ success:true, results }`. This is mode selection on the fork's existing `CLOUD_ENABLED` seam, not an error fallback: the fork module never retries through another endpoint. The license key never reaches the renderer.
- **D-07 Tool gating:** `web_search` registers when the Titanium session is signed in with a license (renderer gets a boolean only) and the policy allows it (`isWebSearchAllowed`, unmanaged = allowed). The same boolean feeds the `webSearch` capability input, so the model is not told web search is unavailable. Sign-in wording stays for Phase 7 (FEAT-05). `settings.isSignedIn` (better-auth) is not changed, so connector gating is untouched (Phase 7).
- **D-08 Relay routes (stt-api):** public `GET /auth/slack/callback` and `GET /auth/linear/callback`. `state` must match `^v1\.(\d{1,5})\.([0-9a-f]{64})$` with port 1024..65535; then 302 to `http://127.0.0.1:<port>/<provider>/callback` forwarding only `code`, `state`, `error`, `error_description`. Anything else: 400 static HTML, no redirect. Headers on both: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. Host is the literal `127.0.0.1` (the loopback server binds only there), so no open redirect.
- **D-09 Desktop relay base:** `SLACK_RELAY_REDIRECT_URI` / `LINEAR_RELAY_REDIRECT_URI` read `SERVICES_URL` instead of `SITE_URL`. The `SLACK_OAUTH_REDIRECT_URI` / `LINEAR_OAUTH_REDIRECT_URI` dev overrides stay as they are.
- **D-10 Calendar result page:** Google and Microsoft calendar flows pass `renderResultPage` built on `renderOAuthResultPage` (from `connectors/oauthResultPage.js`) with new i18n keys `calendarConnect.browser.{connectedTitle,connectedBody,failedTitle,failedBody}` in every locale, so the loopback server answers the browser itself (F-7). No hosted desktop-callback page is built.
- **D-11 Own OAuth clients (portal, 06-03):** all four are created by a portal executor; outputs go to one Pass item per provider, `edgeassistant-oauth-{google,entra,slack,linear}` (separate items, so one task's pass-set never overwrites another task's fields):
  - Google Cloud: project `edgeassistant`, "Desktop app" OAuth client, consent screen External, scopes per F-15, publishing status In production (Testing would expire refresh tokens after 7 days). Fields `google_calendar_client_id`, `google_calendar_client_secret`.
  - Microsoft Entra: app `EdgeAssistant Calendar` in the existing tenant, "Accounts in any organizational directory and personal Microsoft accounts", platform "Mobile and desktop applications" redirect `http://127.0.0.1`, public client flows on, delegated permissions per F-15, no secret. Field `microsoft_calendar_client_id`.
  - Slack: app `EdgeAssistant`, redirect URL `https://stt.titaniumlabs.us/auth/slack/callback`, user scopes per F-15, PKCE and token rotation on, public distribution activated (no App Directory listing). Field `slack_client_id`.
  - Linear: OAuth app `EdgeAssistant`, callback `https://stt.titaniumlabs.us/auth/linear/callback`, scopes per F-15, public/PKCE client. Field `linear_client_id`.
- **D-12 Build injection:** new `scripts/fork-write-env.mjs` writes the repo-root `.env` (packaged as `resources/.env`) from process env keys `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `MICROSOFT_CALENDAR_CLIENT_ID`, `SLACK_CLIENT_ID`, `LINEAR_CLIENT_ID`; exits non-zero naming any missing key, never prints values. `FORK-BUILD.md` maps the Pass fields into the build shell with `pass-field`. The Google "Desktop app" secret is not confidential by Google's definition for installed apps (RFC 8252 public client), so shipping it in `.env` does not breach the "no secret in the installer" constraint; Microsoft, Slack and Linear are PKCE public clients with no secret.
- **D-13 Portal routing:** Entra and Google are `executor: codex-portal` (verifier Grok; Codex has passed the pilots). Slack and Linear are `executor: grok-portal` (verifier Codex), because their sign-in usually needs an emailed code and only the grok dispatch carries the read-only `google-gmail` tool; their briefs name the playwright tools and say `pass-set` is a shell command, per the open Grok stall note. Executor and verifier always differ. Tasks run one at a time (shared executor browser profile lock). Each brief's login item line is resolved by the 06-03 Task 1 preflight before dispatch.
- **D-14 Build vs prove split:** 06-01..06-03 build and unit-test with no production access; 06-04 proves in production only after the stable domain answers with a trusted certificate and the Pass outputs exist.

### Claude's discretion (decided)

- Rate limit 30/min per principal (cost cap vs. normal assistant use of a few searches per turn).
- Route modules `api/webSearchRoute.js` and `api/oauthRelayRoute.js`, registered like `registerScribeRoute`.
- OAuth end-to-end proof uses a dev harness (`scripts/fork-oauth-e2e.js`, run under the repo's Electron) that runs the real auth modules with the browser-open step redirected to a handoff file, so the portal executor's browser completes consent and the real relay reaches the harness's loopback server on the same machine. The harness is dev tooling only and is not packaged.

## Blocker candidates

| ID | Blocker | Evidence | Affects | Gate |
|----|---------|----------|---------|------|
| B-1 | `stt.titaniumlabs.us` serves an untrusted certificate | F-11 | 06-03 Slack/Linear redirect URIs are registered against it (strings only, no fetch); 06-04 all proofs | Resolved by STT-03 (`feat/tiwh-stt03-stable-domain`, uncommitted on 2026-11-18). 06-04 precondition |
| B-2 | No Pass login item for Slack, Linear or a Titanium-owned Google account | F-14 | 06-03 Google, Slack, Linear portal tasks | 12b gate 4 if the executor run confirms no item and no persistent-profile session exists. Entra has `microsoft` |
| B-3 | A valid Titanium license key for product `titanium-whisper` is needed to prove FEAT-01 as a signed-in user | AUTH-01 PR #18 (keygen product id) open on 2026-11-18 | 06-04 Task 1 | Resolve via titanium-licensing admin API (Claude, read-only issuance for the test account per `~/.claude/reference/test-login.md`); BLOCKED if no admin credential exists anywhere |
| B-4 | Entra multi-tenant app from an unverified publisher: work/school tenants that allow consent only to verified publishers refuse it | Microsoft default consent policy | Criterion 3 for work accounts | 06-04 proves with the `microsoft` account; publisher verification (needs a Partner Network ID) recorded as a release risk |
| B-5 | Google sensitive scopes on an unverified app: "unverified app" screen and a 100-user cap | Google OAuth policy | Scale beyond 100 users, not criterion 3 | Release risk; verification submission is a later portal task |
| B-6 | Tavily plan quota unknown (free tier 1,000 credits/month) | `tavily` item has a `note` field, not read | FEAT-01 at scale | 06-04 reads the plan via Tavily API usage endpoint or the note field (names only in logs) |

## Cross-phase notes

- **Phase 7:** once `GOOGLE_CALENDAR_CLIENT_ID/SECRET` ship, `gmailAuth` falls back to the calendar client and the Gmail connector row becomes "configured". Our Google project will not carry `gmail.send` (restricted scope). Phase 7 must give Gmail its own client or hide the row (FEAT-04/FEAT-06).
- **Phase 4 (STT-03):** when `DEFAULT_STT.baseUrl` moves to `stt.titaniumlabs.us`, `SERVICES_URL` and `DEFAULT_STT` share a host; D-03 keeps both allowed either way.

## Canonical References

- `.planning/REQUIREMENTS.md` (FEAT-01..03), `.planning/ROADMAP.md` (Phase 6), `.planning/PROJECT.md`, `.planning/OpenWhispr Fork Gap Analysis.md` (P01, P19)
- `C:\Users\artic\.claude\reference\portal-executor.md` (portal routing, brief template, QC)
- Desktop: `src/helpers/ipcHandlers.js` (`agent-web-search`), `src/services/tools/webSearchTool.ts`, `src/services/tools/index.ts`, `src/components/chat/useChatStreaming.ts`, `src/config/agentCapabilities.ts`, `src/hooks/useTitaniumAuth.ts`, `src/helpers/titanium/titaniumIpc.js`, `src/config/{fork.config.json,forkKeys.js,forkConfig.js,forkRuntime.ts}`, `src/helpers/connectors/{slackAuth,linearAuth,oauthResultPage}.js`, `src/helpers/{oauthLoopbackFlow,googleCalendarOAuth,microsoftCalendarOAuth}.js`, `src/helpers/environment.js`, `FORK-BUILD.md`
- Server (read-only here, changed by 06-01): `C:\Users\artic\GitHub\edgeassistant-openwhispr-stt-api` `origin/main`: `api/app.js`, `api/licenseAuth.js`, `api/config.js`, `api/scribeRoute.js`, `test/api/auth.test.js`, `README.md`

## Deferred Ideas

None raised. (Google app verification and Entra publisher verification are release risks B-4/B-5, not FEAT-01..03 scope.)
