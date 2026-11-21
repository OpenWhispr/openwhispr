# Signed fork build: EdgeAssistant (finedesignz/edgeassistant)

`electron-builder.fork.json` extends the upstream `electron-builder.json` and overrides:

- `win.azureSignOptions`: Titanium Labs LLC, Azure Trusted Signing (account `titaniumlabs-signing`, profile `TitaniumLabsLLC`).
- `appId` `com.titaniumlabs.titaniumwhisper`, `productName` "EdgeAssistant", `executableName` `edgeassistant`, URL scheme `titaniumwhisper`, NSIS shortcut, uninstall and installer names (values mirror `src/config/fork.config.json`; `test/config/forkBrand.test.js` keeps them in sync).
- `publish`: GitHub `finedesignz/edgeassistant`.

`electron-builder.fork-unsigned.json` is the same identity without signing (CI pull requests, local test builds).

The appId differs from OpenWhispr's, so EdgeAssistant installs beside OpenWhispr rather than over it. On first launch it copies the OpenWhispr profile (settings, history, notes, keys) into its own userData folder (`src/helpers/legacyUserDataMigration.js`); OpenWhispr's folder is left untouched.

## Build (Node 24)

Put `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` in the build process environment only, and use a valid `GH_TOKEN` for the sidecar downloads. The Proton Pass item `azure-trusted-signing` stores them under lowercase names, so map them explicitly in the same shell as the build. An unset variable makes signing fall back to another identity and fail with 403 Forbidden.

```powershell
$j = pass-get azure-trusted-signing | ConvertFrom-Json
$env:AZURE_TENANT_ID = $j.tenant_id; $env:AZURE_CLIENT_ID = $j.client_id; $env:AZURE_CLIENT_SECRET = $j.client_secret
npm ci
npm run prebuild:win
npm run build:renderer
npx electron-builder --win nsis --publish never --config electron-builder.fork.json
```

Output: `dist/EdgeAssistant-Setup-<version>.exe`. Signing happens during bundling. Verify with `Get-AuthenticodeSignature` on the installer and on `dist/win-unpacked/edgeassistant.exe` (Status Valid, CN=Titanium Labs LLC). Delete `dist/win-unpacked` after any failed signed build.

## Native modules

`npm ci` (postinstall) and packaging (the `beforePack` hook, with `npmRebuild: false`) both rebuild Electron-ABI modules through `scripts/rebuild-native-deps.js`, not `electron-builder install-app-deps`. `node-pty` is Node-API and ships win32/darwin prebuilds that load under Electron, so the script skips it (`NODE_API_PREBUILT_MODULES`). Letting `@electron/rebuild` recompile it needs MSVC with Spectre libs and runs winpty's `GetCommitHash.bat`, which fails with `gyp: Call to 'cmd /c "cd shared && GetCommitHash.bat"' returned exit status 1` in shells that set `NoDefaultCurrentDirectoryInExePath=1` (Claude Code shells do). Check a build with `$env:ELECTRON_RUN_AS_NODE='1'; npx electron -e "require('node-pty'); require('better-sqlite3')"`.

## OAuth client ids (calendars, Slack, Linear)

The Google and Microsoft calendar and the Slack and Linear connectors read their OAuth client ids from `resources/.env`. Write them before `electron-builder` with `scripts/fork-write-env.mjs`. It reads five variables from the build shell, writes them into the repo-root `.env` (packaged as `resources/.env`), keeps every other line, and exits 1 naming any missing or malformed key. It prints key names only, never values. Without client ids the Gmail, GitHub, calendar, Slack and Linear rows hide or report "not configured"; no upstream OpenWhispr client id is ever embedded.

Map the values from the per-provider Pass items (created by the 06-03 portal tasks) in the same shell as the build:

```powershell
$env:GOOGLE_CALENDAR_CLIENT_ID     = pass-field edgeassistant-oauth-google google_calendar_client_id
$env:GOOGLE_CALENDAR_CLIENT_SECRET = pass-field edgeassistant-oauth-google google_calendar_client_secret
$env:MICROSOFT_CALENDAR_CLIENT_ID  = pass-field edgeassistant-oauth-entra microsoft_calendar_client_id
$env:SLACK_CLIENT_ID               = pass-field edgeassistant-oauth-slack slack_client_id
$env:LINEAR_CLIENT_ID              = pass-field edgeassistant-oauth-linear linear_client_id
node scripts/fork-write-env.mjs
```

After `electron-builder`, check that the package carries the key names (names only, no values):

```powershell
Select-String -Path dist/win-unpacked/resources/.env -Pattern '^(GOOGLE_CALENDAR_CLIENT_ID|GOOGLE_CALENDAR_CLIENT_SECRET|MICROSOFT_CALENDAR_CLIENT_ID|SLACK_CLIENT_ID|LINEAR_CLIENT_ID)=' | ForEach-Object { ($_.Line -split '=')[0] }
```

Why the Google client secret may ship: Google issues a "Desktop app" client a secret, but for installed apps it is not confidential (RFC 8252 public client, Google's installed-app guidance), and the flow uses PKCE. The Microsoft, Slack and Linear clients are PKCE public clients with no secret. The Slack and Linear redirect URIs are `${SERVICES_URL}/auth/{slack,linear}/callback` (`SERVICES_URL` is the stt-api host in `src/config/fork.config.json`, overridable with `VITE_SERVICES_URL`).

## Release

Publish to `finedesignz/edgeassistant` as a non-draft release marked latest, with `latest.yml`, the installer and its `.blockmap`. Asset names must match `latest.yml`, which uses the same dashed name (`EdgeAssistant-Setup-<version>.exe`), so upload the installer as built. The app's updater reads the build-generated `app-update.yml` and checks this repo.

Note: `download:brand-fonts` fetches OpenWhispr's licensed Yowza font from the private `OpenWhispr/brand-assets` repo. This account has no access (GitHub API returns 404), and the font license forbids redistribution, so EdgeAssistant intentionally ships the bundled Noto Sans. The step logs "no access" and continues; do not set `BRAND_FONTS_REQUIRED=1` for fork builds, it would fail every one.

## Rebrand to EdgeAssistant: what stays the same

Only the display name changed (from "Titanium Whisper"). To keep the installed build updating in place with its data intact, these are deliberately unchanged: `appId` `com.titaniumlabs.titaniumwhisper` (NSIS uninstall key and install directory lookup), the Windows tray GUID, the AppUserModelID (derived from the appId), the URL scheme `titaniumwhisper`, and the userData folder `%APPDATA%\Titanium Whisper` (`USER_DATA_DIR`, set explicitly in `main.js`, no longer equal to `BRAND_NAME`). The updater still reads `latest.yml` from `finedesignz/edgeassistant` (renamed from `finedesignz/openwhispr`; GitHub redirects the old name, so builds that still check it keep updating).

The icon set is generated by `python scripts/fork-generate-icons.py` from `resources/fork/edgeassistant-icon.svg` and written over `src/assets/icon.{png,ico,icns}`, `brand-mark.png` and `iconTemplate@3x.png`.
