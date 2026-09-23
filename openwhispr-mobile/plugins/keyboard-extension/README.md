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
3. Extension writes a flag to the App Group, then opens the configured app scheme at `/keyboard-dictation` (handled by [src/screens/HomeScreen.tsx](../../src/screens/HomeScreen.tsx)).
4. The main app starts a native recording, then calls `AppGroupStorage.returnToPreviousApp()` to swap back to the host.
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

## Reference

- [Apple — Custom Keyboard Extensions](https://developer.apple.com/documentation/uikit/keyboards_and_input/creating_a_custom_keyboard)
- [Apple — App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups)
