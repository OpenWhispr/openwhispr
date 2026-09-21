# OpenWhispr Mobile

Native iOS and Android companion app for [OpenWhispr](https://openwhispr.com). Fast on-device or cloud transcription, AI-powered cleanup, notes, and a system-wide dictation keyboard.

## Highlights

- **Cloud or Private mode** — flip between fast cloud transcription and fully on-device Whisper inference
- **iOS dictation keyboard** — dictate from any text field system-wide via a custom keyboard extension
- **Markdown notes** — folders, full-text search, AI-assisted cleanup
- **Native iOS feel** — Liquid Glass tab bar and headers on iOS 26+, blur fallback on iOS 18

## Tech stack

Expo SDK 55 · React 19 · expo-router (NativeTabs) · NativeWind · Zustand · Drizzle + expo-sqlite · whisper.rn · Sentry

## Quick start

```bash
git clone https://github.com/<your-fork>/openwhispr.git
cd openwhispr/openwhispr-mobile
npm install
cp .env.example .env
npm run ios       # or: npm run android
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for prerequisites, env-var details, and the rebrand steps required to build on a real device.

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

See [.env.example](./.env.example). All client-side variables are prefixed `EXPO_PUBLIC_`.

| Variable                         | Purpose                                  |
| -------------------------------- | ---------------------------------------- |
| `EXPO_PUBLIC_API_URL`            | Backend API base URL                     |
| `EXPO_PUBLIC_OAUTH_CALLBACK_URL` | OAuth callback configured in the backend |
| `EXPO_PUBLIC_SENTRY_DSN`         | Optional. Empty disables error reporting |

## Contributing

Bug reports, PRs, and ideas are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR. For security issues, see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
