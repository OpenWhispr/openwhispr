# Contributing to OpenWhispr Mobile

Thanks for your interest in contributing. This guide covers everything you need to fork, build, and submit a PR.

The mobile app is maintained in `openwhispr-mobile/` inside the main OpenWhispr repository, but it has its own dependencies, lockfile, commands, CI checks, and release process. Run the commands below from `openwhispr-mobile/`.

## Prerequisites

All contributors need:

- Git
- Node.js 24.x and npm

For iOS development:

- macOS with [Xcode 26.2 or newer](https://docs.expo.dev/versions/v55.0.0/)
- Ruby and Bundler for the locked CocoaPods dependencies
- An iOS Simulator, or a physical device for device-only testing

The simulator does not require an Apple Developer account. A paid Apple Developer Program membership is required to sign a physical-device build because the keyboard and activity extensions use an App Group capability.

For Android development:

- Android Studio with Android SDK 36
- An Android emulator or physical device

Android development does not require Xcode or an Apple Developer account. The EAS CLI is only required when working with EAS builds or submissions; it is not needed for normal local development.

## First-Time Setup

```bash
git clone https://github.com/<your-fork>/openwhispr.git
cd openwhispr/openwhispr-mobile
npm install
cp .env.example .env.local
```

The example uses the hosted OpenWhispr API and leaves optional integrations disabled. Edit `.env.local` only for the features or local identity values you need. Local environment files are ignored by Git. Personal provider and on-device development need no OpenWhispr production credentials. Enter provider keys only in the app, never in source, fixtures, or `EXPO_PUBLIC_` variables.

Install the locked Ruby dependencies before the first iOS build:

```bash
bundle install
```

If you plan to build on a physical iOS device, configure a unique local identity and signing team first. See [Physical iOS Devices and Forks](#physical-ios-devices-and-forks).

## Development Workflow

```bash
npm start              # Start the Metro/Expo dev server
npm run ios            # Build and run on iOS (uses dev client)
npm run android        # Build and run on Android
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint
npm run format         # Prettier --check
npm run format:write   # Prettier --write
npm run check          # format + lint + typecheck + Expo Doctor
npm run clean          # format + lint + typecheck
```

`npm run ios` runs `expo run:ios`, which executes `expo prebuild` and compiles the native project. The keyboard extension is wired in by the config plugin at `plugins/keyboard-extension/withKeyboardExtension.js` during prebuild.

OpenWhispr uses custom native modules, so Expo Go is not a supported development environment. Use `npm run ios` or `npm run android` to create a development build.

The `android`, `ios`, and `prebuild` npm scripts use POSIX environment-variable syntax. On Windows, put `OPENWHISPR_APP_ENV=development` in `.env.local` and run `npx expo run:android` or `npx expo prebuild` directly. iOS builds still require macOS.

## Environment Variables

Use [.env.example](./.env.example) as the canonical variable reference. It groups configuration into:

- hosted API and transcription settings;
- optional Sentry, AppsFlyer, Superwall, RevenueCat, and Google Calendar integrations;
- keyboard audio behavior; and
- local bundle identifiers, URL schemes, and display names.

Variables prefixed with `EXPO_PUBLIC_` are embedded in the application bundle and must never contain secrets. Keep contributor-specific values in `.env.local`, which is ignored by Git.

## Physical iOS Devices and Forks

The committed configuration contains OpenWhispr's production identifiers. Do not manually replace identifiers throughout the source. For a local physical-device build, set a unique identity in `.env.local`:

```dotenv
OPENWHISPR_IOS_BUNDLE_IDENTIFIER=com.example.openwhispr.dev
OPENWHISPR_SCHEME=example-openwhispr-dev
OPENWHISPR_DISPLAY_NAME=OpenWhispr Dev
OPENWHISPR_KEYBOARD_DISPLAY_NAME=OpenWhispr Dev
```

`app.config.js` derives matching bundle identifiers for the keyboard and activity extensions and an App Group named `group.<bundle identifier>`. Override `OPENWHISPR_APP_GROUP_ID` or `OPENWHISPR_KEYBOARD_BUNDLE_IDENTIFIER` only when your Apple configuration requires different values.

Verify the resolved configuration and generate the native project:

```bash
OPENWHISPR_APP_ENV=development npx expo config --type public
npm run prebuild:dev -- --clean
```

In the generated Xcode workspace, select your Apple development team for the main app, `OpenWhisprKeyboard`, and `OpenWhisprActivity` targets. Your team must own the bundle identifiers and App Group. The generated `ios/` directory is ignored by Git, so these local signing changes should not be committed.

Maintainers shipping a separate fork must also replace the organization-specific Expo owner, Apple team, EAS project, update URL, and App Store submission values in `app.base.json` and `eas.json`. Those release settings are separate from the local identity overrides above.

## Pull Request Checklist

Before submitting:

- [ ] `npm run check` passes
- [ ] `npm test -- --runInBand` passes
- [ ] No secrets, API keys, or credentials committed
- [ ] PR description explains the why, not just the what
- [ ] Screenshots or screen recordings included for UI changes

## Tests

The mobile test suite uses Jest. Run it locally with `npm test -- --runInBand`; the mobile CI workflow runs the same suite for mobile changes.

## Reporting Bugs and Requesting Features

Use the GitHub issue templates. For security issues, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.

## Provider development

Mobile owns its provider code: the catalog is `src/config/providerCatalog.json`, routing is `src/lib/mobileProviders.ts`, and endpoint rules are `src/lib/providerEndpoints.ts`. The catalog is a trimmed copy of the desktop registry's OpenAI and Groq entries; update it by hand when those models change.

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

Build a fresh native iOS app after changing any native module or config plugin. Do not use a JavaScript-only update to introduce the provider request transport.

Provider diagnostics are explicit user actions and may incur provider charges. Tests use mocks and synthetic credentials. Complete the [maintainer smoke-test matrix](./docs/BYOK_SMOKE_TESTS.md) (four providers) using your own provider accounts and a physical device. Never paste keys, tokens, transcript content, or raw provider responses into test artifacts or logs.
