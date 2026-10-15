# keyboard-extension (Expo config plugin + iOS extension target)

A custom iOS keyboard extension that lets the user dictate from any text field system-wide. Tap the mic in the keyboard, the OpenWhispr app opens via the `keyboard-dictation` URL scheme, records, and the transcript is auto-pasted when the user returns to the host app.

## What's here

| File                                  | Role                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `withKeyboardExtension.js`            | Expo config plugin. Runs at `expo prebuild` time and adds the keyboard target to the generated Xcode project, links the entitlements, and configures the App Group capability. |
| `ios/KeyboardViewController.swift`    | The keyboard UI and lifecycle. Reads/writes shared state through the App Group `UserDefaults` suite (see [`modules/app-group-storage`](../../modules/app-group-storage/)).     |
| `ios/Info.plist`                      | Extension Info.plist (display name, RequestsOpenAccess, etc.)                                                                                                                  |
| `ios/OpenWhisprKeyboard.entitlements` | App Group capability entitlement                                                                                                                                               |

## How it works

1. User installs the keyboard from iOS Settings → General → Keyboard → Keyboards → Add New.
2. User opens any app, switches to the OpenWhispr keyboard, taps the mic.
3. Extension writes a flag to the App Group, then opens the configured app scheme at `/keyboard-dictation` (handled by [src/hooks/useKeyboardHandoff.ts](../../src/hooks/useKeyboardHandoff.ts)).
4. The main app starts a native recording, then sends the user back to the host app (`returnToHost` in [src/lib/handoffReturn.ts](../../src/lib/handoffReturn.ts)). iOS 26.4+ hides the host from the extension, so the containing app learns it from UIKit ([`HostAppObserver.swift`](../../modules/app-group-storage/ios/HostAppObserver.swift)). When no host is found, the app shows the "Swipe back to your app" screen instead.
5. Recording continues in the background. When stopped, the main app writes the transcript to `keyboard_pending_transcript` and the extension pastes it on next focus.

## Apple capabilities required

- **App Group** (`group.<ios bundle id>`) — must match between the main app, the extension, and the `app-group-storage` module.
- **Open Access** (`RequestsOpenAccess` in `Info.plist`) — required for the extension to read/write the shared suite.

## Environments

Runtime identifiers are resolved from `config/openwhispr-environments.js` and applied by `app.config.js` plus this plugin during prebuild.

- Production/TestFlight: `OPENWHISPR_APP_ENV=production`
- Development: `OPENWHISPR_APP_ENV=development`
- Local signing override: set `OPENWHISPR_IOS_BUNDLE_IDENTIFIER` and `OPENWHISPR_SCHEME` when needed. The App Group defaults to `group.<OPENWHISPR_IOS_BUNDLE_IDENTIFIER>`.

Verify with:

```bash
OPENWHISPR_APP_ENV=development npx expo config --json
```

After changes, regenerate the native project:

```bash
npx expo prebuild --clean
npm run ios
```

## Keyboard touch regression tests

On macOS with Xcode:

```bash
python3 openwhispr-mobile/plugins/keyboard-extension/tests/run-keyboard-touch-tests.py
```

Run it from the repository root after changing the keyboard layout, its padding or key targets; mobile CI runs it too. The runner compiles the production keyboard Swift source for Mac Catalyst, so it needs no simulator, signing credentials or Expo build. It tests UIKit hit routing across row gaps, overlapping key targets, unequal key widths, nested stacks, hidden layouts, disabled keys and keyboard boundaries, then lays out the real keyboard at several widths in letters and numbers mode, with and without the globe key, and checks that no tap below the dictation strip is dropped, the keyboard's padding included.

The keyboard opens on numbers and punctuation unless **Settings → Keyboard →
Letter keys** is on (App Group key `keyboard_letters_enabled` = `"1"`, read each
time the keyboard appears; a keyboard without Full Access can't read it, so it
opens on numbers too). With letters off, `#+=` is hidden and ABC switches to the
next keyboard, usually Apple's. Turn Letter keys on before the typing check below.

Keys follow the system keyboard's touch rules. Each key forwards its raw touches
to `KeyTouchCoordinator`, which tracks every finger on its own. A key types on
lift, and as soon as another finger lands (rollover), so overlapping two-thumb
typing keeps press order and two fingers on one key type it twice. The key
under the finger at lift types; lifting outside every key types nothing. Shift
and delete act as the finger lands. Delete repeats after a 0.35 s hold unless
the finger slides off first, and keeps repeating until the last finger holding
it lifts. The rules live in `KeyTouchTracker`, which has no UIKit and is
covered by the same test run. The globe key stays a plain `UIControl`, since
the input-mode menu needs its original event.

The tests cannot reproduce real two-thumb typing. Before releasing, on an iPhone,
type the passage below three times as fast as you can, in Notes and in another
host app, in portrait and landscape, and compare the errors with Apple's keyboard:
`Hello all, the quick brown fox jumps over the lazy dog. Will Anna call Bobby tomorrow? Yes, she'll book a room soon.`
Also check Shift, 123/ABC, space/return, held delete, keyboard switching,
VoiceOver typing and dictation. To profile, attach Instruments (Logging, Hangs)
to the `OpenWhisprKeyboard` process: the keyboard emits `keyDown`, `keyClick` and
`keyCancel` Points of Interest and times `textDidChange` and `recordingPoll`.

## Reference

- [Apple — Custom Keyboard Extensions](https://developer.apple.com/documentation/uikit/keyboards_and_input/creating_a_custom_keyboard)
- [Apple — App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups)
