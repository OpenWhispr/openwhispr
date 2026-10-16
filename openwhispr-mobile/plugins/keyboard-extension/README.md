# keyboard-extension (Expo config plugin + iOS extension target)

A custom iOS keyboard extension that lets the user dictate from any text field system-wide. Its keys look and type like Apple's keyboard; the toolbar above them holds the tone menu, the dictation pill and the agent button, with no suggestions or autocorrect. Tapping **Tap to speak** records in place through the OpenWhispr app's background session; only when that session has gone stale does the pill read **Activate** and hand off to the app.

## What's here

| File                                  | Role                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `withKeyboardExtension.js`            | Expo config plugin. Runs at `expo prebuild` time and adds the keyboard target to the generated Xcode project, links the entitlements, and configures the App Group capability. |
| `ios/KeyboardViewController.swift`    | The keyboard UI and lifecycle. Reads/writes shared state through the App Group `UserDefaults` suite (see [`modules/app-group-storage`](../../modules/app-group-storage/)).     |
| `ios/KeyboardCapitalization.swift`    | When shift turns on by itself, following the field's autocapitalization type. Foundation-only, so it is unit-tested on macOS.                                                  |
| `ios/Info.plist`                      | Extension Info.plist (display name, RequestsOpenAccess, etc.)                                                                                                                  |
| `ios/OpenWhisprKeyboard.entitlements` | App Group capability entitlement                                                                                                                                               |
| `tests/`                              | Swift tests: the capitalization rule, and UIKit touch routing across the real keyboard layout.                                                                                 |
| `__tests__/`                          | Jest tests for the config plugin's Xcode project wiring.                                                                                                                       |

## How it works

1. User installs the keyboard from iOS Settings → General → Keyboard → Keyboards → Add New, and turns on Allow Full Access.
2. User opens any app, switches to the OpenWhispr keyboard and taps the pill.
3. **In place.** When the app's background session is ready (`isBackgroundSessionReady()`), or when the keyboard is inside OpenWhispr itself, the pill reads **Tap to speak**. A tap writes a start request to the App Group and posts a Darwin notification. The app records without leaving the host app, the keyboard shows a recording canvas, and it inserts the transcript when `transcriptReady` arrives.
4. **Handoff.** Only when that session has gone stale does the pill read **Activate**. Its link opens `<scheme>://keyboard-dictation` (handled by [src/hooks/useKeyboardHandoff.ts](../../src/hooks/useKeyboardHandoff.ts)). The app starts a native recording, then sends the user back to the host app (`returnToHost` in [src/lib/handoffReturn.ts](../../src/lib/handoffReturn.ts)). iOS 26.4+ hides the host from the extension, so the containing app learns it from UIKit ([`HostAppObserver.swift`](../../modules/app-group-storage/ios/HostAppObserver.swift)). When no host is found, the app shows the "Swipe back to your app" screen instead. The transcript is pasted on the keyboard's next focus.

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
OPENWHISPR_APP_ENV=development npx expo prebuild --clean
npm run ios
```

## Tests

```bash
npm run test:keyboard-capitalization # capitalization rule (macOS, needs Xcode's swiftc)
npx jest plugins/keyboard-extension # config plugin
```

Mobile CI runs both, and the touch regression tests below, on every pull request.

## Keyboard touch regression tests

On macOS with Xcode:

```bash
python3 openwhispr-mobile/plugins/keyboard-extension/tests/run-keyboard-touch-tests.py
```

Run it from the repository root after changing the keyboard layout, its padding or key targets; mobile CI runs it too. The runner compiles the production keyboard Swift source for Mac Catalyst, so it needs no simulator, signing credentials or Expo build. It tests UIKit hit routing across row gaps, overlapping key targets, unequal key widths, nested stacks, hidden layouts, disabled keys and keyboard boundaries, then lays out the real keyboard at several widths in letters and numbers mode, with and without the globe key, and checks that no tap below the dictation strip is dropped, the keyboard's padding included.

These touch tests do not measure typing latency. Before releasing,
check fast two-thumb typing and repeated letters on an iPhone, near-edge taps,
Shift, 123/ABC, space/return, held delete, keyboard switching, and dictation in
portrait and landscape in Notes and another host app.

## Reference

- [Apple — Custom Keyboard Extensions](https://developer.apple.com/documentation/uikit/keyboards_and_input/creating_a_custom_keyboard)
- [Apple — App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups)
