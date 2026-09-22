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
npm ci
```

For hosted-service development, optionally copy `.env.example` to `.env` and configure the values described in [Environment Variables](#environment-variables). Personal provider and on-device development require no OpenWhispr production credentials. Enter provider keys only in the app, never in source, fixtures, or `EXPO_PUBLIC_` variables.

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

Only non-secret client configuration belongs in `EXPO_PUBLIC_` variables. Provider credentials must never use this prefix. See `.env.example` for the full list:

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

## Shared provider development

Keep the repository checkout intact: mobile imports dependency-free TypeScript and JSON from `../shared/ai`. Metro watches that explicit directory and resolves React dependencies from the mobile app. Install mobile dependencies in `openwhispr-mobile`; no npm workspace or root dependency installation is needed to bundle mobile. Shared changes trigger both desktop and mobile validation in CI.

From `openwhispr-mobile`, run:

```bash
npm test -- --runInBand
npm run typecheck
npm run lint
npm run format
EXPO_NO_DOTENV=1 SENTRY_DISABLE_AUTO_UPLOAD=true OPENWHISPR_APP_ENV=production npx expo export --platform ios --output-dir /tmp/openwhispr-mobile-export
python3 modules/background-uploader/tests/run-provider-transport-tests.py
```

The native transport regression requires macOS, Python 3, and Xcode Command Line Tools. It compiles Foundation-only Swift and uses local HTTP servers with synthetic credentials to check redirect refusal, response redaction, private-host rules, and secret-free recovery metadata. It does not replace compiling the Expo module for iOS or testing background URLSession on a device.

For desktop regression checks, install root dependencies separately and run the root test/typecheck/renderer-build commands. Run `node --test .github/scripts/ci-scope.test.cjs` from the repository root to check application CI classification.

Before shipping, inspect an EAS archive from the mobile directory and verify it includes `shared/ai` beside `openwhispr-mobile`; builds must preserve those relative paths. Build a fresh native iOS app after changing any native module or config plugin. Do not use a JavaScript-only update to introduce the provider request transport.

Provider diagnostics are explicit user actions and may incur provider charges. Tests use mocks and synthetic credentials. Complete the [maintainer smoke-test matrix](./docs/BYOK_SMOKE_TESTS.md) using your own provider accounts and a physical device. Never paste keys, tokens, transcript content, or raw provider responses into test artifacts or logs.
