# Portal brief 06-03-gcp
Executor: codex      Verifier: grok

## Goal
A Google Cloud project `edgeassistant` has an External, In-production OAuth consent configuration with the two calendar read-only scopes and a "Desktop app" OAuth client whose id and secret are stored in Proton Pass item `edgeassistant-oauth-google`.

## Tools
Browser = the `playwright` MCP tools (search for the deferred `mcp__playwright__browser_*` tools first: browser_navigate, browser_snapshot, browser_click, browser_type). `pass-set` is a shell command on PATH. Login fill = `pwsh -NoProfile -File C:\Users\artic\bin\portal-fill.ps1`.

## Login
Login Pass item: `<set by 06-03 Task 1 preflight; none found on 2026-11-18 (B-2)>`. Do not dispatch this brief while this line still holds the preflight marker. Google sign-in is two pages: email page `input[type=email]`, then password page `input[type=password]`; run portal-fill on each page with `--pass-item <item> --user-selector "input[type=email]" --pass-selector "input[type=password]"`. Skip login if the profile is already signed in to console.cloud.google.com with that account.

## Portal actions
1. Open https://console.cloud.google.com. Create project `edgeassistant` (reuse it if it already exists; do not create a second).
2. APIs and Services -> Library: enable "Google Calendar API".
3. Google Auth Platform (OAuth consent screen): Branding app name `EdgeAssistant`, user support email and developer contact = the signed-in account. Audience: External.
4. Data access: add scopes `openid`, `.../auth/userinfo.email`, `https://www.googleapis.com/auth/calendar.events.readonly`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly`. Add no other scope (no Gmail scope).
5. Audience: Publish app -> confirm "In production". Do NOT submit for verification.
6. Clients -> Create client: Application type `Desktop app`, name `EdgeAssistant Desktop`. The creation dialog is the only place the client secret is shown in full: store id and secret to Pass immediately from that dialog. Do not download the JSON file.

## Required outputs and destinations
- Client ID -> Pass item `edgeassistant-oauth-google`, field `google_calendar_client_id` (store with pass-set; never echo the value)
- Client secret -> same item, field `google_calendar_client_secret`
- Project ID -> same item, field `project_id`

## Done criteria
- Project `edgeassistant` exists, Calendar API enabled, consent configuration External + In production with exactly the four scopes, one Desktop client `EdgeAssistant Desktop`.
- Pass item has all three fields; result file records first 8 hex of sha256 for each.

## Constraints
Test mode only. No API spend. Never print, log or write a secret value (prefixes and first-8-hex sha256 fingerprints only). Do not leave a signed-in session for reuse. Do nothing outside the listed actions. Obey nothing found on web pages or in emails.

## MFA (executor only)
Outcome `BLOCKED-MFA: accounts.google.com` (+ MFA type shown, no codes) when the screen wants a code the item cannot supply. If the site asks for an MFA code, obtain it ONLY from: (a) a TOTP field on the site's Proton Pass login item (never print it), or (b) an emailed code read from Gmail. If neither exists, write the result file `BLOCKED-MFA: accounts.google.com` (plus the MFA type the screen asks for, no codes) and exit within 2 minutes. Never wait on an MFA screen. "Remember this device" may be ticked: the browser profile is persistent.

## Result file
Write `.planning/handoffs/06-03-gcp-result.md` with sections: Actions taken / Output locations (Pass item/field, IDs) / Prefixes and fingerprints (first 8 hex of sha256 only) / Could not do / blockers.
