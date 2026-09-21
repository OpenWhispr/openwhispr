# Windows tray identity design

Date: 2026-09-21
Branch: `feat/windows-tray-identity`
Base: `6d56d75e7e13ec47009e573e9ff4cded0d0ccc61`

## Outcome and boundary

Give the signed production Windows tray icon one permanent identifier so Windows can associate the user's visibility and ordering choices with the same icon after relaunches and updates. This improves identity; Windows and the user still control visibility and ordering. The first release adopting this identity may require the user to arrange the icon once again.

This is independent of macOS PR #2267. Do not copy its implementation, reuse its GUID, or modify its worktree. Do not programmatically promote the Windows icon out of overflow or position it beside system controls.

## Decision

Use Electron's supported `new Tray(image, guid)` only when all four conditions hold:

1. `process.platform === "win32"`.
2. `app.isPackaged === true`.
3. The channel already resolved by `main.js` is `process.env.OPENWHISPR_CHANNEL === "production"`.
4. Packaged `package.json` contains `windowsTrayIdentity: "signed-production-v1"`.

Use the permanent Windows production GUID **`9afd9bd5-53da-42ef-8334-6e2b494c66fe`**. Keep it unchanged across versions and executable paths. All other cases continue to call `new Tray(image)` with exactly one argument.

`main.js:82-83` resolves and sets the channel before loading `TrayManager` at line 274. Reuse that resolved value; do not infer a second channel inside the tray code. A missing or unknown channel receives no GUID. Development and staging channels receive no new explicit identity, even when packaged and signed, so they cannot claim the production identifier.

Installed and portable production builds share this one identity. Today both use the production app profile and the same single-instance lock (`main.js:85-93,238`). They represent the same app, rather than independently runnable channels. No new portable identity or runtime path-derived identity is needed. Native acceptance must exercise the extracted portable executable, whose temporary path can change between builds.

## Signing contract

`app.isPackaged` and a production channel do not establish signing. Couple the marker to the existing build system:

- In `electron-builder.json`, add `extraMetadata.windowsTrayIdentity: "signed-production-v1"` and `win.forceCodeSigning: true`.
- In `electron-builder.unsigned-win.json`, override the marker to `null` and `win.forceCodeSigning` to `false`, retaining its existing `win.azureSignOptions: null`.
- Keep the source `package.json` free of the marker. Electron-builder injects it into packaged metadata.
- Add `verifyWindowsTraySigning(context)` to the existing `scripts/afterPack.js` hook. For marked Windows output only, require `context.packager.forceCodeSigning === true`, neither `signExecutable` nor `signAndEditExecutable` to be `false`, and `context.packager.shouldSignFile(productFilename + ".exe", true)` to return true. Throw an actionable build error otherwise. Read the **effective merged metadata** from `context.packager.info.metadata`, not merely `config.extraMetadata`.
- Invoke this guard first in the existing `afterPack` hook. Export it for the focused packaging test, matching the existing named-test-export convention in that file.

The guard closes a specific builder 26.15.3 gap: `signIf()` returns early when `signExts` excludes the executable, before reaching the `forceCodeSigning` check in `_sign()`. Existing normal signing failures abort the build. Marked builds cannot opt out of executable signing while retaining the identity marker. Unsigned/local builds must use the existing unsigned configuration; no runtime signature subprocess is added.

The marker is a build contract, not a runtime tamper detector. Configuration plus unit tests do not prove the signature of an output artifact. Before native acceptance/release, verify that the **running inner executable** has a valid Authenticode signature and a publisher subject containing `O=Gizmo Labs Inc.`. Keep that organization consistent across releases; an Azure account/profile or publisher change requires fresh identity acceptance. The Azure `publisherName` configuration is not itself a certificate verification result.

## Why this approach

| Option                                          | Assessment                                                                                                                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marked package + enforced signing               | Selected. Small runtime change; uses current release/PR configuration; supports one identity across signed install and portable paths. The narrow packaging guard covers the known signing exclusion bypass.                  |
| One GUID for every Windows build                | Unsafe for unsigned copies: Windows binds an unsigned GUID to its executable path, and a moved copy may fail to add its icon.                                                                                                 |
| Deterministic GUID derived from executable path | Avoids reusing an unsigned identity at a new path, but loses the useful cross-path behavior for signed installs and changing portable extraction paths. Adds identity hashing without satisfying this outcome.                |
| Runtime Authenticode check                      | Could check the actual binary, but adds a Windows subprocess, launch delay, timeout/policy failures, and a second identity when verification is unavailable. Unnecessary for the controlled build contract.                   |
| Marker written from `afterSign` alone           | Insufficient: builder 26.15.3 `signApp()` can return true on an unsigned build, causing `afterSign` to run. Actual signature verification would need another build process; forcing signing plus the narrow guard is smaller. |

No retry with a different GUID is added. Electron 41.10.5 logs a failed native `Shell_NotifyIcon(NIM_ADD)` call without reliably throwing to JavaScript; the existing outer `try/catch` cannot detect and repair that failure.

## Global constraints

- Windows identity/persistence only; visibility and exact placement remain controlled by Windows and the user.
- Permanent Windows production GUID: `9afd9bd5-53da-42ef-8334-6e2b494c66fe`.
- Packaged metadata marker: `windowsTrayIdentity: "signed-production-v1"`; unsigned override: `null`.
- Only Windows + packaged + resolved production channel + exact marker may receive the GUID.
- Marked Windows builds must enforce signing of the main executable; unsigned builds use `electron-builder.unsigned-win.json`.
- Keep `package.json`, `package-lock.json`, dependencies, `main.js`, and both workflow files unchanged.
- No new native helpers, dependencies, runtime subprocesses, registry edits, shell restarts, private APIs, or simulated dragging.
- Preserve existing icon loading, menu actions, tooltip, click handling, error handling, and macOS/Linux behavior.
- Do not touch macOS PR #2267, its worktree, or its GUID `eb809902-04b5-5b08-b12a-f81d6f27e185`.
- Toolchain: Node 24; locked Electron 41.10.5 and electron-builder/app-builder-lib 26.15.3; no version changes.
- Native acceptance scope: Windows 10 x64 and Windows 11 x64, with exact OS builds and app/artifact versions recorded.
- Preserve the selected sequence: planning, TDD/code-quality implementation, independent deep review, separate fixes.
- No merge or release is authorized; keep a resulting PR draft while native Windows acceptance remains unverified.

## Validation and acceptance

Automated tests must pin the GUID and constructor argument count, exercise every runtime gate, preserve menu/click behavior, resolve both builder configurations using the installed builder's real inheritance logic, and reject marked output with executable signing disabled or excluded. Test effective metadata inherited from source package metadata as well as build metadata. Existing focused tray/Dock tests remain in the verification command. Run the repository quality check and full test suite after the integrated change; distinguish inherited failures from regressions.

Native evidence remains separate from those tests. For each Windows version:

1. Record the existing released app's tray state, adopt the candidate signed installer, and record whether first adoption preserves or resets it.
2. Manually promote/reorder the icon, quit normally, relaunch twice, reboot, then upgrade to a second candidate signed by the same organization. Record visibility and order after each step.
3. Put the icon back in overflow and repeat relaunch/update checks to prove the user's hidden choice is respected.
4. Repeat at another installation path and with two signed portable versions. Record each running inner executable's path, signature status, subject, version, and SHA; moving only the outer portable launcher is insufficient.
5. Run unsigned production packages and development/staging variants from two paths. Their tray must remain usable, and a separately runnable channel must not take over production's identity.
6. Check left-click toggle, right-click menu, quick actions, quit, and no extra icons. Record actual ordering without claiming guaranteed adjacency to Windows controls.

Implementation evidence from 2026-09-21 covers the automated contract only. Runtime RED ran 5 tests with the expected missing-GUID failure and 4 passes. Build-contract RED loaded both real builder configurations and ran 6 tests, all failing on the absent marker, unsigned override, or guard. The integrated focused suite passed 22/22 tests, and `npm run quality-check` passed with the 6 pre-existing warnings. The full suite ran 4,715 tests: 4,701 passed, 1 failed, 12 skipped, and 1 remained todo. Its sole failure was an unrelated `ENOTEMPTY` temporary-directory cleanup in `modelManagerBridgeDownloadStatus.test.js`; that file passed 11/11 on an immediate isolated rerun.

No native Windows session, signed candidate artifact, update pair, publisher verification, or visibility/order persistence observation was produced. The parent found no local UTM VM or self-hosted Windows runner. Leave every unexecuted native row explicitly unverified and keep the PR draft.

## Evidence

- [Electron 41.10.5 tray contract](https://github.com/electron/electron/blob/v41.10.5/docs/api/tray.md#new-trayimage-guid) and [native add implementation](https://github.com/electron/electron/blob/v41.10.5/shell/browser/ui/win/notify_icon.cc).
- [Microsoft notification identity rules](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-notifyicondataw#troubleshooting) and [preference retention](https://devblogs.microsoft.com/oldnewthing/20171027-00/?p=97296).
- [Electron-builder v26 metadata/signing configuration](https://www.electron.build/v26/docs/configuration/) and [Windows options](https://www.electron.build/v26/docs/win/). Current v27 documentation has different signing option names; use v26 here.
- [Microsoft Authenticode inspection](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature?view=powershell-7.5).
- Installed, lock-matched builder sources: `node_modules/app-builder-lib/out/winPackager.js:103-131,234-279`; `platformPackager.js:321-340,610-613`; `packager.js:264-277`; `codeSign/windowsSignAzureManager.js:61-82`; `util/config/config.js:36-79,167-177`.
- Source research: `/Users/joshuadavidpadoa/dev/titan-menu-bar-handoff-20260921/artefacts/reports/2026-09-21-windows-tray-feasibility.md`.
