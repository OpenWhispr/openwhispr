# Windows tray identity design

Date: 2026-09-21
Branch: `feat/windows-tray-identity`

## Outcome and boundary

Give the signed production Windows tray icon one permanent identifier so Windows can associate the user's visibility and ordering choices with the same icon after relaunches and updates. This improves identity; Windows and the user still control visibility and ordering. The first release adopting this identity may require the user to arrange the icon once again.

macOS has its own tray GUID from #2267; this change does not reuse it. Do not programmatically promote the Windows icon out of overflow or position it beside system controls.

## Decision

Use Electron's supported `new Tray(image, guid)` only when all three conditions hold:

1. `process.platform === "win32"`.
2. The channel already resolved by `main.js` is `process.env.OPENWHISPR_CHANNEL === "production"`.
3. The packaged `package.json` contains `windowsTrayIdentity: true`.

Use the permanent Windows production GUID **`9afd9bd5-53da-42ef-8334-6e2b494c66fe`**. Keep it unchanged across versions and executable paths. Every other Windows case, and Linux, keeps calling `new Tray(image)` with exactly one argument.

`main.js` resolves and sets the channel before loading `TrayManager`, so the tray reuses that value instead of inferring a second one. Development and staging have their own profile and single-instance lock, so they can run beside production. They receive no GUID, even when packaged and signed, so they cannot claim the production identifier.

Installed and portable production builds share this identity. Both use the production profile and the same single-instance lock, so they never run at the same time. Native acceptance must exercise the extracted portable executable, whose temporary path can change between builds.

## Signing contract

The marker tells the runtime that the build came from the signed configuration:

- `electron-builder.json` sets `extraMetadata.windowsTrayIdentity: true` and `win.forceCodeSigning: true`.
- `electron-builder.unsigned-win.json` (PR CI and local unsigned builds) overrides the marker to `false` and `win.forceCodeSigning` to `false`, next to its existing `win.azureSignOptions: null`.
- The source `package.json` never carries the marker, so development runs never see it. Electron-builder injects it into the packaged metadata.

Electron-builder 26 already fails a marked build that would ship unsigned. With Azure configured, its signer returns true or throws, so a failed Trusted Signing call (the PowerShell module exiting nonzero) stops the build. `forceCodeSigning` covers the rest: it fails a default-config build that nulls `win.azureSignOptions` without switching to the unsigned configuration (signtool then finds no certificate and returns false), and it rejects `signExecutable: false` and `signAndEditExecutable: false`. It does not catch deliberate opt-outs that keep the marker: a `signExts` rule excluding the main executable (`signIf()` returns before the `forceCodeSigning` check), a custom signtool `sign` hook that skips signing, or overriding `forceCodeSigning` on the default configuration. Build unsigned Windows packages only with the unsigned configuration; no packaging guard is added for those cases.

A signed build that fails at signing still leaves a `dist/win-unpacked` carrying the marker, and it may be unsigned. Never launch it: an unsigned run binds the production GUID to its path, and the signed install on the same machine may then get no tray icon. Run native acceptance on a clean VM snapshot.

The marker is a build contract, not a runtime tamper detector. Before native acceptance or release, verify that the **running inner executable** has a valid Authenticode signature and a publisher subject containing `O=Gizmo Labs Inc.`. Keep that organization consistent across releases; an Azure account, profile, or publisher change requires fresh identity acceptance.

## Why this approach

| Option                                          | Assessment                                                                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marked package + enforced signing               | Selected. Small runtime change; uses the existing signed and unsigned configurations; supports one identity across signed install and portable paths. Relies on electron-builder's own signing enforcement.    |
| One GUID for every Windows build                | Unsafe for unsigned copies: Windows binds an unsigned GUID to its executable path, and a moved copy may fail to add its icon.                                                                                  |
| Deterministic GUID derived from executable path | Avoids reusing an unsigned identity at a new path, but loses the useful cross-path behavior for signed installs and changing portable extraction paths. Adds identity hashing without satisfying this outcome. |
| Runtime Authenticode check                      | Could check the actual binary, but adds a Windows subprocess, launch delay, timeout/policy failures, and a second identity when verification is unavailable. Unnecessary for the controlled build contract.    |
| Marker written from `afterSign` alone           | Insufficient: builder 26.15.3 `signApp()` can return true on an unsigned build, causing `afterSign` to run. Actual signature verification would need another build process; forcing signing is smaller.        |

No retry with a different GUID is added. Electron 41.10.5 logs a failed native `Shell_NotifyIcon(NIM_ADD)` call without throwing to JavaScript, so the existing `try/catch` cannot detect or repair it. A broken identity means no tray icon at all, which is why native acceptance gates the release.

## Constraints

- Windows identity/persistence only; visibility and exact placement remain controlled by Windows and the user.
- No new native helpers, dependencies, runtime subprocesses, registry edits, shell restarts, private APIs, or simulated dragging.
- Preserve existing icon loading, menu actions, tooltip, click handling, error handling, and macOS/Linux behavior.
- Native acceptance scope: Windows 10 x64 and Windows 11 x64, with exact OS builds and app/artifact versions recorded.
- Run native acceptance before the first release that ships this identity.

## Validation and acceptance

Automated tests (`test/helpers/trayPlacement.test.js`, shared with the macOS GUID) pin the GUID for marked production Windows builds and check that Linux, development, staging, and a missing or `false` marker keep the one-argument constructor. They cannot prove the signature of a build artifact.

Native evidence, for each Windows version:

1. Record the existing released app's tray state, adopt the candidate signed installer, and record whether first adoption preserves or resets it.
2. Manually promote/reorder the icon, quit normally, relaunch twice, reboot, then upgrade to a second candidate signed on a different day. Azure Trusted Signing issues short-lived certificates that rotate daily, so this pair checks that Windows keys the GUID to the publisher rather than to one certificate. Record visibility and order after each step.
3. End the app from Task Manager, then relaunch. A failed icon add is only logged, so confirm the icon returns after a process that never removed it, not only after a normal quit.
4. Put the icon back in overflow and repeat relaunch/update checks to prove the user's hidden choice is respected.
5. Repeat at another installation path and with two signed portable versions. Record each running inner executable's path, signature status, subject, version, and SHA; moving only the outer portable launcher is insufficient.
6. Run unsigned production packages and development/staging variants from two paths. Their tray must remain usable, and a separately runnable channel must not take over production's identity.
7. Check left-click toggle, right-click menu, quick actions, quit, and no extra icons. Record actual ordering without claiming guaranteed adjacency to Windows controls.

Identify the running executable and its signature in PowerShell, choosing the main process id from the first command:

```powershell
Get-Process OpenWhispr | Select-Object Id, Path
$trayProcessId = Read-Host 'OpenWhispr main process id'
$trayExePath = (Get-Process -Id $trayProcessId).Path
$traySignature = Get-AuthenticodeSignature -LiteralPath $trayExePath
$traySignature | Select-Object Status, Path, @{Name='Subject';Expression={$_.SignerCertificate.Subject}}
Get-FileHash -LiteralPath $trayExePath -Algorithm SHA256
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
```

Require `Status: Valid` and a subject containing `O=Gizmo Labs Inc.` before treating a build as the signed case. Do not edit the registry, restart Explorer, or force icon placement to manufacture a passing result.

Status: no native Windows session, signed candidate, or update pair has been exercised yet. Every step above is unverified.

## Evidence

- [Electron 41.10.5 tray contract](https://github.com/electron/electron/blob/v41.10.5/docs/api/tray.md#new-trayimage-guid) and [native add implementation](https://github.com/electron/electron/blob/v41.10.5/shell/browser/ui/win/notify_icon.cc).
- [Microsoft notification identity rules](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-notifyicondataw#troubleshooting) and [preference retention](https://devblogs.microsoft.com/oldnewthing/20171027-00/?p=97296).
- [Electron-builder v26 metadata/signing configuration](https://www.electron.build/v26/docs/configuration/) and [Windows options](https://www.electron.build/v26/docs/win/). Current v27 documentation has different signing option names; use v26 here.
- [Microsoft Authenticode inspection](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature?view=powershell-7.5).
- Installed builder sources (26.15.3): `node_modules/app-builder-lib/out/winPackager.js:106-132,234-239` (signing and `forceCodeSigning` checks), `platformPackager.js:610-613` (`forceCodeSigning` resolution), `packager.js:276-277` and `fileTransformer.js:88-91` (`extraMetadata` merged and written into the packaged `package.json`), `codeSign/windowsSignAzureManager.js:46-69` (Trusted Signing).
