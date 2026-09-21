# macOS Menu-Bar Placement Design

**Date:** 2026-09-20

**Status (2026-09-21):** Implemented and independently reviewed in draft [PR #2267](https://github.com/OpenWhispr/openwhispr/pull/2267). Josh confirmed the macOS dev build works. The detailed Command-drag/relaunch sequence and official-installer acceptance remain unrecorded; see the implementation plan's execution status. Windows feasibility is the next requested investigation, outside this macOS design.

**Branch:** `feat/macos-menu-bar-placement`

**Base:** `6d56d75e7e13ec47009e573e9ff4cded0d0ccc61`

## Request and intended behavior

The [Slack request](https://openwhispr.slack.com/archives/C0AQXA4C03V/p1789826980313799) proposes placing OpenWhispr near Wi-Fi and Search so it feels like part of the Mac's core experience. The attached reference shows the Wispr Flow icon between those two system items; replies support doing this promptly. The local reference captured for this task is `/tmp/ow-menu-bar-placement-20260920/slack-reference.png`.

Give the macOS menu-bar icon a rightward starting preference, then let macOS retain the position the user chooses by Command-dragging it. Exact adjacency to Wi-Fi or Search is not a supported promise: system-item order, available space, displays, and menu-bar managers affect the result.

## Baseline before this change

`TrayManager.createTray()` in `src/helpers/tray.js` loads an icon and calls `new Tray(trayIcon)` on every platform. On macOS it disables double-click handling; all platforms then build the existing menu and attach the existing handlers. The application initializes this manager in `main.js` after Electron is ready.

The lockfile resolves Electron to `41.10.5` from the package range `^41.2.0`; `.nvmrc` requires Node `24`. `test/helpers/trayQuickActions.test.js` already exercises the tray menu with Electron mocked. Full-module VM boundary harnesses also exist, for example `test/helpers/preloadOnboardingBridge.test.js`.

## Feasibility and source evidence

1. Electron documents the optional macOS tray GUID as the identity used to retain an icon's position between launches. This is a supported persistence API. [Pinned Electron 41.10.5 tray documentation](https://github.com/electron/electron/blob/v41.10.5/docs/api/tray.md#new-trayimage-guid)
2. The pinned implementation converts that GUID to its lowercase UUID spelling before calling `SetAutoSaveName`; Cocoa assigns it to `NSStatusItem.autosaveName`. Therefore the preference key must use the lowercase spelling even if a caller supplies uppercase characters. [Tray constructor source](https://github.com/electron/electron/blob/v41.10.5/shell/browser/api/electron_api_tray.cc), [Cocoa adapter source](https://github.com/electron/electron/blob/v41.10.5/shell/browser/ui/tray_icon_cocoa.mm)
3. Apple documents `autosaveName` for saving and restoring status-item information. Without an explicit value, AppKit selects an automatic name. [Apple NSStatusItem documentation](https://developer.apple.com/documentation/appkit/nsstatusitem/autosavename-swift.property)
4. Electron exposes `systemPreferences.registerDefaults()` and implements it through the application's standard `NSUserDefaults`. Apple describes the registration domain as volatile and normally last in the preference lookup order. Registering a fallback each launch therefore leaves an existing application preference in control. [Pinned Electron API documentation](https://github.com/electron/electron/blob/v41.10.5/docs/api/system-preferences.md#systempreferencesregisterdefaultsdefaults-macos), [Pinned Electron implementation](https://github.com/electron/electron/blob/v41.10.5/shell/browser/api/electron_api_system_preferences_mac.mm), [Apple registration-domain documentation](<https://developer.apple.com/documentation/foundation/userdefaults/register(defaults:)>)
5. `NSStatusItem Preferred Position <autosaveName>` is an AppKit preference convention seen in real native implementations, including Hammerspoon. It is not a documented Apple positioning API, and neither Electron nor Apple promises adjacency to named system items. [Hammerspoon's native implementation](https://github.com/Hammerspoon/hammerspoon/blob/master/extensions/menubar/libmenubar.m)
6. A real Electron `41.10.5` probe on this Mac compared an untreated tray with a separate tray whose test-only GUID had a registered preferred position of `0`. On a `1440 × 900` display, their bounds were respectively `x=979, width=32` and `x=1194, width=32`. This establishes that the convention moved a real status item rightward in the tested environment. It does not establish packaged OpenWhispr behavior, exact neighboring icons, or user-drag persistence. The probe is `/tmp/ow-menu-bar-placement-20260920/placement-probe.cjs`; it used temporary GUIDs and cleaned up only its own preference keys.

The approach uses public Electron APIs without native additions. The initial-position preference remains an undocumented AppKit convention. That residual compatibility risk is acceptable for a best-effort visual improvement which leaves ordinary tray functionality intact.

## Architecture

Keep the behavior in `src/helpers/tray.js`; no new helper or exported test-only API is needed. Add a fixed lowercase UUID constant and the preference key derived from it. After validating the tray image and before constructing the native tray on macOS, register preferred position `0`. Construct the macOS tray with the same UUID every launch. Keep the existing one-argument constructor on Windows and Linux.

Catch registration errors locally, write one existing-style warning, and continue constructing the macOS tray with its stable GUID. Leave the existing outer creation error handler, icon handling, menu construction, and event wiring intact.

Registration runs on each launch because its values are not persisted. OpenWhispr must never write or remove a stored position, poll positions, move the icon after launch, or reorder another application's icons. The normal macOS preference lookup and stable GUID own restoration.

## Global constraints

- Apply the new placement behavior only when `process.platform === "darwin"`.
- Keep the macOS tray GUID exactly `eb809902-04b5-5b08-b12a-f81d6f27e185` across launches and future releases.
- Before constructing the macOS tray, register `NSStatusItem Preferred Position eb809902-04b5-5b08-b12a-f81d6f27e185` with the numeric fallback value `0` through `systemPreferences.registerDefaults()`.
- Never call `setUserDefault()`, `removeUserDefault()`, shell preference commands, or native positioning bridges to implement this feature.
- If default registration throws, log a warning and continue creating the macOS tray with the same stable GUID.
- Preserve Windows and Linux one-argument tray construction and all existing icon, menu, tooltip, click, and double-click behavior.
- Add no dependencies, native helpers, renderer changes, settings, permissions, or user-facing strings; leave `package.json` and `package-lock.json` unchanged.
- Use Node `24` and the lockfile's Electron `41.10.5` for validation.
- Treat initial placement as best effort; do not claim guaranteed Wi-Fi/Search adjacency or infer native persistence from mocks.
- Follow TDD: observe the expected regression-test failure before changing production code, then run the focused tests and required quality checks.

## First adoption and later launches

The current unnamed tray may have an AppKit-generated saved identity. This change deliberately establishes a new fixed identity, so the first launch of the changed application may use the new rightward default even if the old icon was moved previously. Do not guess or migrate `Item-0` or other automatic keys: their ownership is not established by the public API.

Once this GUID is in use, every later user-selected position must take precedence over the registered default. Keep the GUID unchanged in future refactors. A user's installed app, a differently bundled development app, and a probe may have different preference domains; evidence from one must not be described as proof of another.

## Acceptance and evidence boundaries

Automated tests must exercise the real `TrayManager.createTray()` with mocked Electron boundaries, covering registration before construction, the fixed lowercase GUID, identical identity after an independent module reload, no persistent preference mutations, registration failure, unchanged Windows/Linux constructor arguments, existing menu/event wiring, and the existing empty-image guard. They must not mock `createTray()` itself or pretend to emulate AppKit's placement algorithm.

Native acceptance must use the changed OpenWhispr build: check a new identity's initial position, Command-drag the icon to a different position, quit normally, and relaunch twice to check restoration. Verify menu actions still open and the icon remains visible. Record the actual macOS/build identity, observed neighboring icons, and each result. If that check is unavailable, report it as unverified; the probe and unit tests are narrower evidence.

The parent already recorded a passing baseline of eight focused tray/dock tests and a passing `npm run quality-check`, with existing module-type and React fast-refresh warnings. Preserve this baseline distinction when reporting new results.

## Out of scope

Guaranteed placement between two particular system icons, automatic icon dragging, taking control of another app's menu items, a menu-bar settings screen, migrating guessed legacy positions, and Windows/Linux placement changes.

## Authorized execution sequence

The user requested separate sequential agents for planning, implementation using TDD and code-quality, deep review, and any review fixes. The parent coordinates those agents. This document authorizes the small implementation described above; it does not establish successful native acceptance or authorize publishing a release.
