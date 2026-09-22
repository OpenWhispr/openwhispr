# OpenWhispr Mobile

Native iOS and Android companion app for [OpenWhispr](https://openwhispr.com). Fast on-device or cloud transcription, AI-powered cleanup, notes, and a system-wide dictation keyboard.

## Highlights

- **Cloud, Private, or Providers** — choose hosted transcription, on-device inference, or your own provider on iOS
- **iOS dictation keyboard** — dictate from any text field system-wide via a custom keyboard extension
- **Markdown notes** — folders, full-text search, AI-assisted cleanup
- **Native iOS feel** — Liquid Glass tab bar and headers on iOS 26+, blur fallback on iOS 18

## Tech stack

Expo SDK 55 · React 19 · expo-router (NativeTabs) · NativeWind · Zustand · Drizzle + expo-sqlite · whisper.rn · Sentry

## Quick start

```bash
git clone https://github.com/<your-fork>/openwhispr.git
cd openwhispr/openwhispr-mobile
npm ci
npm run ios       # or: npm run android
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for prerequisites, env-var details, and the rebrand steps required to build on a real device.

## Personal provider setup (iOS)

Open **AI Models → Providers**, choose a workflow, then select a provider and model. Dictation/keyboard, uploads, live meetings, cleanup, note formatting/titles, and chat/agents keep separate selections. Available models follow the shared desktop catalog; actual release readiness is tracked in the [provider smoke-test matrix](./docs/BYOK_SMOKE_TESTS.md).

Enter a provider API key, or a Corti client ID and secret, and save. No OpenWhispr account or Pro subscription is required for personal provider use; your provider bills requests separately. Hosted inference and sync retain their existing account requirements. Provider credentials live in device-local secure storage, are not synced, survive sign-out, and can be explicitly removed. Full app-data reset clears them.

**Check connection** stores the entered credential and reports what it verified. Text checks make a small, potentially billable inference request. Transcription checks verify credentials or a model catalog; they do not prove transcription access. Custom and OpenRouter configurations also offer model discovery and manual model IDs. Discovery never silently switches your selected model.

For an OpenAI-compatible server, choose **Custom** and enter its base URL and model ID. Credentials are optional. Public servers require HTTPS; private-network HTTP is validated separately in both shared code and the native transport. On an iPhone, `localhost` means that iPhone, not your computer. Use the server's LAN address and allow Local Network access when prompted. If access fails, check **Settings → Privacy & Security → Local Network**, the server binding, firewall, and address. Platform ATS restrictions may still require HTTPS for LAN IP or Tailscale hosts; see the smoke-test matrix.

Providers are remote inference. Privacy settings and organization policy still apply. Changing settings does not change a job's captured route, and failed cleanup preserves the original transcript. The iOS-first rollout does not enable provider setup on Android.

A providers-only developer build does not require OpenWhispr production credentials or a `.env` file. Native modules require a development build rather than Expo Go. Configure your own signing identifiers as described in [CONTRIBUTING.md](./CONTRIBUTING.md). Provider keys belong in the app's secure credential fields, never in `EXPO_PUBLIC_` variables.

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
