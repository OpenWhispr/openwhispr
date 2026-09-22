# Contributing to OpenWhispr Mobile

Thanks for your interest in contributing. This guide covers everything you need to fork, build, and submit a PR.

## Prerequisites

- **Node.js** 24.x and npm
- **Xcode** 16+ (for iOS builds; required even if you only ship Android because the keyboard extension is iOS-only)
- An **Apple Developer account** (free is fine for local simulator; paid is required to install on a physical device because the iOS keyboard extension uses an App Group capability)
- **EAS CLI**: `npm install -g eas-cli`
- iOS Simulator and/or Android Emulator

## First-Time Setup

```bash
git clone https://github.com/<your-fork>/openwhispr.git
cd openwhispr/openwhispr-mobile
npm install
cp .env.example .env
```

Edit `.env` and fill in the values described in [Environment Variables](#environment-variables) below.

If you plan to build on a real iOS device, you must rebrand the bundle identifiers and App Group — see [Rebranding for Forks](#rebranding-for-forks).

## Development Workflow

```bash
npm start              # Start the Metro/Expo dev server
npm run ios            # Build and run on iOS (uses dev client)
npm run android        # Build and run on Android
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint
npm run format         # Prettier --check
npm run format:write   # Prettier --write
npm run clean          # format + lint + typecheck
```

`npm run ios` runs `expo run:ios`, which executes `expo prebuild` and compiles the native project. The keyboard extension is wired in by the config plugin at `plugins/keyboard-extension/withKeyboardExtension.js` during prebuild.

## Environment Variables

All client-facing variables must be prefixed with `EXPO_PUBLIC_`. See `.env.example` for the full list:

| Variable                         | Purpose                                          |
| -------------------------------- | ------------------------------------------------ |
| `EXPO_PUBLIC_API_URL`            | Backend API base URL                             |
| `EXPO_PUBLIC_OAUTH_CALLBACK_URL` | OAuth redirect URL configured in the backend     |
| `EXPO_PUBLIC_SENTRY_DSN`         | Optional. Leave empty to disable error reporting |

## Rebranding for Forks

The repo is hard-coded to Gizmo Labs Inc. identifiers. If you fork and want to build on a real device or ship your own version, change these references to your own org:

1. **`app.base.json`** — `expo.owner`, `expo.ios.bundleIdentifier`, `expo.android.package`, `expo.ios.appleTeamId`, and the keyboard extension entry under `expo.extra.eas.build.experimental.ios.appExtensions[0].bundleIdentifier` and its `entitlements["com.apple.security.application-groups"]`.
2. **`plugins/keyboard-extension/withKeyboardExtension.js`** — `APP_GROUP_ID` constant near the top of the file.
3. **`modules/app-group-storage/ios/AppGroupStorageModule.swift`** — `appGroupId` property and the Darwin notification names.
4. **`plugins/keyboard-extension/ios/KeyboardViewController.swift`** and **`plugins/keyboard-extension/ios/OpenWhisprKeyboard.entitlements`** — the App Group identifier string.

Confirm with:

```bash
grep -rn 'group.com.gizmolabs' modules/ plugins/
grep -rn 'com.gizmolabs.openwhispr' app.base.json
```

After rebranding, run `npm run ios` again to regenerate the native project.

## Pull Request Checklist

Before submitting:

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm run format` passes (run `npm run format:write` to fix)
- [ ] `npm test -- --runInBand` passes
- [ ] `npm run doctor` passes
- [ ] No secrets, API keys, or credentials committed
- [ ] PR description explains the why, not just the what
- [ ] Screenshots or screen recordings included for UI changes

## Tests

The mobile test suite uses Jest. Run it locally with `npm test -- --runInBand`; the mobile CI workflow runs the same suite for mobile changes.

## Reporting Bugs and Requesting Features

Use the GitHub issue templates. For security issues, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.
