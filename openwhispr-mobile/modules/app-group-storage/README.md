# app-group-storage

Native iOS module exposing the App Group `UserDefaults` shared suite. The main app and the keyboard extension use it to share state across processes.

## What it exposes

```ts
import {
  AppGroupStorage,
  APP_GROUP_KEYS,
  addRecordingStoppedListener,
  addRecordingErrorListener,
  addBackgroundRecordingStartedListener,
} from 'modules/app-group-storage/src';
```

- `setItem(key, value)`, `getItem(key)`, `removeItem(key)` — KV access on the shared suite
- `startNativeRecording()`, `stopNativeRecording()`, `endProcessingTask()` — keyboard-extension recording lifecycle bridges
- `convertRecordingToWav(fileUri)` — converts a keyboard recording to `16 kHz` mono WAV for provider-format fallback
- `returnToPreviousApp()` — return-to-host-app deep link after a keyboard handoff
- Three event subscriptions emitted by the iOS keyboard extension when a recording finishes, errors, or starts in the background

## Keys it stores

Defined in [src/index.ts](src/index.ts):

| Key                                           | Purpose                                                          |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `keyboard_pending_transcript`                 | Final transcript text the keyboard extension reads after handoff |
| `keyboard_recording_active`                   | Flag set while the extension is recording                        |
| `keyboard_recording_format`                   | Requested native keyboard recording format: `m4a` or `wav`       |
| `keyboard_compressed_audio_unsupported`       | Persisted downgrade after compressed upload rejection            |
| `keyboard_compressed_audio_unsupported_at_ms` | Timestamp for the compressed-audio recheck cooldown              |
| `keyboard_audio_level`                        | Live amplitude for waveform                                      |
| `keyboard_stop_requested`                     | Stop signal from the host app                                    |
| `background_session_ready`                    | Background audio session readiness                               |

## Android

The module is iOS-only. All methods no-op on Android (`requireNativeModule` is gated behind `Platform.OS === 'ios'`).

## Environments

The App Group identifier is derived at runtime as `group.<main app bundle id>`. `app.config.js` and `plugins/keyboard-extension/withKeyboardExtension.js` apply the matching entitlement during prebuild, and `OPENWHISPR_APP_ENV=development` switches to the dev identifiers defined in `config/openwhispr-environments.js`.

## Build and test

```bash
cd modules/app-group-storage
npm run build
npm run lint
```
