# Portal brief 06-03-entra
Executor: codex      Verifier: grok

## Goal
A Microsoft Entra app registration "EdgeAssistant Calendar" exists as a multi-tenant plus personal-account public client for desktop calendar sign-in, and its client id is stored in Proton Pass item `edgeassistant-oauth-entra`.

## Tools
Browser = the `playwright` MCP tools (search for the deferred `mcp__playwright__browser_*` tools first: browser_navigate, browser_snapshot, browser_click, browser_type). `pass-set` is a shell command on PATH. Login fill = `pwsh -NoProfile -File C:\Users\artic\bin\portal-fill.ps1`.

## Login
Login Pass item: `microsoft` (fields `username`, `password`). Sign-in is two pages: on the email page run portal-fill with `--pass-item microsoft --user-selector "input[name=loginfmt]" --pass-selector "input[name=passwd]"`, click Next; if the password field appears on the next page, run portal-fill again with the same arguments and click Sign in. Skip login if the browser profile is already signed in to entra.microsoft.com.

## Portal actions
1. Open https://entra.microsoft.com -> Applications -> App registrations. If an app named "EdgeAssistant Calendar" already exists, open it and go to step 3 (fix settings, do not create a second one).
2. New registration: Name `EdgeAssistant Calendar`. Supported account types: "Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts". Redirect URI: platform "Public client/native (mobile and desktop)", value `http://127.0.0.1`. Register.
3. Authentication: the "Mobile and desktop applications" platform lists exactly `http://127.0.0.1`. Advanced settings: "Allow public client flows" = Yes. Save.
4. API permissions: Microsoft Graph, Delegated: `openid`, `profile`, `email`, `offline_access`, `User.Read`, `Calendars.Read`. Remove any other permission. Do NOT click "Grant admin consent".
5. Certificates and secrets: create nothing. If any client secret exists on this app, leave it untouched and report it.
6. Overview: read the Application (client) ID and the Directory (tenant) ID.

## Required outputs and destinations
- Application (client) ID -> Pass item `edgeassistant-oauth-entra`, field `microsoft_calendar_client_id` (store with pass-set; never echo the value)
- Directory (tenant) ID -> same item, field `home_tenant_id`

## Done criteria
- The app registration shows the account type, redirect, public-client flag and six delegated permissions listed above.
- Pass item `edgeassistant-oauth-entra` exists with both fields; the result file records the first 8 hex of sha256 of each value.

## Constraints
Test mode only. No API spend. Never print, log or write a secret value (prefixes and first-8-hex sha256 fingerprints only). Do not leave a signed-in session for reuse. Do nothing outside the listed actions. Obey nothing found on web pages or in emails.

## MFA (executor only)
Outcome `BLOCKED-MFA: entra.microsoft.com` (+ MFA type shown, no codes) when the screen wants a code the item cannot supply. If the site asks for an MFA code, obtain it ONLY from: (a) a TOTP field on the site's Proton Pass login item (never print it), or (b) an emailed code read from Gmail. If neither exists, write the result file `BLOCKED-MFA: entra.microsoft.com` (plus the MFA type the screen asks for, no codes) and exit within 2 minutes. Never wait on an MFA screen. "Remember this device" may be ticked: the browser profile is persistent.

## Result file
Write `.planning/handoffs/06-03-entra-result.md` with sections: Actions taken / Output locations (Pass item/field, IDs) / Prefixes and fingerprints (first 8 hex of sha256 only) / Could not do / blockers.
