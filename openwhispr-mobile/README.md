# OpenWhispr Mobile

Native iOS and Android companion app for [OpenWhispr](https://openwhispr.com). Fast on-device or cloud transcription, AI-powered cleanup, notes, and a system-wide dictation keyboard.

The mobile app lives in the main [`OpenWhispr/openwhispr`](https://github.com/OpenWhispr/openwhispr) repository under `openwhispr-mobile/`. It currently remains self-contained, with its own dependencies, lockfile, CI checks, and release process. Run all mobile commands from this directory.

## Highlights

- **Cloud, Private, or Bring Your Own Key** — choose hosted transcription, on-device inference, or your own provider key on iOS
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

## Personal provider setup (iOS)

Open **AI Models → Bring Your Own Key** and tap a workflow. Each workflow (dictation/keyboard, uploads, cleanup, note formatting/titles, and chat/voice assistant) has its own mode; choose **Bring Your Own Key**, then a provider and model. The list shows what each workflow currently runs. This release supports OpenAI, Groq, OpenRouter (text), and any OpenAI-compatible Custom server. Other providers are not offered on mobile yet. Actual release readiness is tracked in the [provider smoke-test matrix](./docs/BYOK_SMOKE_TESTS.md).

Enter a provider API key and save. No OpenWhispr account or Pro subscription is required for personal provider use; your provider bills requests separately. Hosted inference and sync retain their existing account requirements. Provider credentials live in device-local secure storage, are not synced, and survive sign-out. Deleting your OpenWhispr account removes them. Remove credential deletes one key; Remove all provider keys deletes every saved key, including keys for Custom endpoints you no longer use. Deleting the app leaves them in the Keychain until the app is installed again; the first launch after a reinstall erases them. After a member of a managed organization signs out, that organization's provider policy keeps applying until another account (not a guest session) signs in and its policy loads, or until Remove all provider keys is used. Removing keys one at a time does not lift it.

**Check connection** uses the entered key without saving it and reports what it verified. Text checks make a small, potentially billable inference request. Transcription checks verify the model catalog; they do not prove transcription access. Custom and OpenRouter configurations also offer model discovery and manual model IDs. Discovery never silently switches your selected model.

For an OpenAI-compatible server, choose **Custom** and enter its base URL and model ID. Credentials are optional. Public servers require HTTPS; private-network HTTP is validated in both the app and the native transport. On an iPhone, `localhost` means that iPhone, not your computer. Use the server's LAN address and allow Local Network access when prompted. If access fails, check **Settings → Privacy & Security → Local Network**, the server binding, firewall, and address. Platform ATS restrictions may still require HTTPS for LAN IP or Tailscale hosts; see the smoke-test matrix.

Bring Your Own Key runs remote inference. Privacy settings and organization policy still apply. Changing settings does not change a job's captured route, and failed cleanup preserves the original transcript. The iOS-first rollout does not enable provider setup on Android.

A developer build that only uses your own keys needs no OpenWhispr production credentials; the `.env.local` copied during setup works as is. Native modules require a development build rather than Expo Go. Configure your own signing identifiers as described in [CONTRIBUTING.md](./CONTRIBUTING.md). Provider keys belong in the app's secure credential fields, never in `EXPO_PUBLIC_` variables.

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
