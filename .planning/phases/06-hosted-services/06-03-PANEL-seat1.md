# 06-03 Panel seat 1 - non-owner OAuth client paths (checked live 2026-11-18)

Claim refuted in part: "credential exists nowhere" is FALSE for Google and Microsoft. Slack and Linear are true gaps.

## Google Calendar - VIABLE PATH (conditional)
- Pass "Claude Secrets" item `google` holds client_id/client_secret (GCP project 366094867049 = pure-respect-217716 "Calcom-").
- Live probe of accounts.google.com authorize with this client_id: loopback redirect `http://127.0.0.1:54321/callback` and `http://localhost:54321` do NOT return redirect_uri_mismatch; `https://example.com/cb` does. => installed/Desktop-type client (any loopback port), which is what EdgeAssistant's loopback PKCE flow needs.
- Same project's clients are also in Coolify env of 1mcp-factory, calpicker, developer-portal, how-dashboard (GOOGLE_CLIENT_ID/SECRET names).
- Open: consent-screen publishing status/verification for calendar scopes (Testing mode = 7-day refresh tokens, 100 test users). google-cloud MCP has no OAuth-client/consent API (tool list checked: none). Owner-only fact ONLY if shipping to public users: Google verification.

## Microsoft Calendar - VIABLE PATH (needs one check)
- Coolify app `calpicker` env has MS_CLIENT_ID / MS_CLIENT_SECRET / MS_TENANT (names only). Existing Entra app we own.
- Pass `tasklens-entra` (clientId, clientSecret, objectId, redirectUri=localhost:3000, tenantId) - client-credentials token attempt failed, so no Graph app-registration right proven.
- MCP Factory microsoft creds (onenote/onedrive/planner/teams/word, tenants common/consumers) show an existing multi-tenant client exists in MCP Factory server; the teams/mcp-factory tools list NO app-registration action (only install_app_to_team, list/delete_microsoft_credentials).
- Next step (not done, 40-call cap): read calpicker MS app's platform config; needs a public-client "Mobile and desktop" redirect `http://localhost` + Calendars.Read delegated. Editing redirect URIs on that app = needs tenant admin Graph rights (UNVERIFIED). CANNOT CONCLUDE on edit rights; the Pass `microsoft` login (username rejected) is the only portal route.

## Slack - CANNOT CONCLUDE (genuine gap)
- No Pass item titled slack; no SLACK_* env in Coolify apps scanned (scan partial, background job still running at write time). apps.manifest.create needs an app configuration token, obtainable only from an authenticated Slack workspace admin session. Owner-only fact: a Slack workspace + admin login/config token.

## Linear - CANNOT CONCLUDE (genuine gap)
- No Pass item or env matching linear. Linear OAuth app creation has no public API (settings UI only). Owner-only fact: Linear workspace admin login (or portal-executor with Linear creds in Pass).

## Incident note
My Pass probe of item `google` printed its note JSON to the transcript (redaction regex missed GOCSPX/AIza/refresh tokens). Exposure in this session transcript only; per 7f no rotation done - owner decision.
