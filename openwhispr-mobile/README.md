# OpenWhispr Mobile

Native iOS and Android companion app for [OpenWhispr](https://openwhispr.com). Fast on-device or cloud transcription, AI-powered cleanup, notes, and a system-wide dictation keyboard.

The mobile app lives in the main [`OpenWhispr/openwhispr`](https://github.com/OpenWhispr/openwhispr) repository under `openwhispr-mobile/`. It currently remains self-contained, with its own dependencies, lockfile, CI checks, and release process. Run all mobile commands from this directory.

## Highlights

- **Cloud or Private mode** — flip between fast cloud transcription and fully on-device Whisper inference
- **iOS dictation keyboard** — dictate from any text field system-wide via a custom keyboard extension
- **Markdown notes** — folders, full-text search, AI-assisted cleanup
- **Native iOS feel** — Liquid Glass tab bar and headers on iOS 26+, blur fallback on iOS 18

## Tech stack

Expo SDK 55 · React 19 · expo-router (NativeTabs) · NativeWind · Zustand · Drizzle + expo-sqlite · whisper.rn · Sentry

## Platform status

- **iOS** is the active release target. The keyboard extension and several native features require a development build; they do not run in Expo Go.
- **Android** can be built locally from the checked-in source, but native Android build and release validation are not yet part of CI.

## Quick start

```bash
git clone https://github.com/<your-fork>/openwhispr.git
cd openwhispr/openwhispr-mobile
npm install
cp .env.example .env.local
```

For iOS, install the locked Ruby dependencies before building:

```bash
bundle install
npm run ios
```

For Android:

```bash
npm run android
```

The npm script above uses POSIX environment-variable syntax. On Windows, add
`OPENWHISPR_APP_ENV=development` to `.env.local`, then run `npx expo run:android` from
PowerShell or Command Prompt.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for platform prerequisites, configuration details, and the signing steps required to build on a physical iOS device.

## Project layout

```
app/                      Expo Router routes (NativeTabs root + 5 group stacks)
src/
  components/{ui,features,notes}   Reusable components
  screens/                Screen-level components
  hooks/                  Custom React hooks
  store/                  Zustand stores
  services/               Transcription, reasoning, storage
  lib/                    Auth, API clients, helpers
  data/, db/              Drizzle SQLite schema and repository
  config/                 Constants
modules/app-group-storage iOS native module bridging the keyboard extension and the main app
plugins/keyboard-extension Expo config plugin + iOS keyboard target
```

## Native modules

- [`modules/app-group-storage`](./modules/app-group-storage/README.md) — iOS App Group `UserDefaults` bridge
- [`plugins/keyboard-extension`](./plugins/keyboard-extension/README.md) — system-wide iOS dictation keyboard

## Environment variables

Copy [.env.example](./.env.example) to `.env.local`. It documents the hosted-service defaults, optional integrations, and local app-identity overrides. Optional services remain disabled when their values are empty.

Variables prefixed with `EXPO_PUBLIC_` are bundled into the application. Never put secrets in them or commit local environment files.

## Contributing

Bug reports, PRs, and ideas are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR. For security issues, see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
