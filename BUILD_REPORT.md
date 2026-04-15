# Build Report: Deepgram BYOK Integration

**Date:** 2026-04-13 10:47 CEST
**Branch:** main
**Base Commit:** 5ada3dc (Merge pull request #576)
**Node.js:** v22.22.2
**Electron:** 39.8.1
**electron-builder:** 26.8.1

## Implementation Summary

Added Deepgram as a first-class native transcription provider with BYOK (Bring Your Own Key) support. Deepgram uses its own REST API shape (raw audio body + query parameters) rather than being forced through the OpenAI-compatible multipart endpoint.

### What was added

**Provider registration:**
- Deepgram added to `modelRegistryData.json` with Nova 3 (default) and Nova 2 models
- Base URL: `https://api.deepgram.com/v1`

**API key management (full BYOK pipeline):**
- `DEEPGRAM_API_KEY` added to environment persistence (`environment.js`)
- `deepgramApiKey` state + setter in settings store (`settingsStore.ts`)
- IPC handlers: `get-deepgram-key`, `save-deepgram-key` (`ipcHandlers.js`)
- Preload bridge: `getDeepgramKey`, `saveDeepgramKey` (`preload.js`)
- Key synced from `.env` on startup via `initializeSettings()`
- Included in `byokDetection.ts` for auto-detection of stored keys

**File/batch transcription (native Deepgram API):**
- New IPC handler `transcribe-audio-file-deepgram` using Deepgram's native REST API
- Sends raw audio body with `Content-Type` header (not multipart form)
- Response parsed from `results.channels[0].alternatives[0].transcript`
- Supports files up to 2 GB (Deepgram's limit)
- Smart formatting enabled by default

**Dictation transcription (live recording path):**
- Deepgram branch added to `processWithOpenAIAPI()` in `audioManager.js`
- Uses `Token` auth header (Deepgram's format) instead of `Bearer`
- Custom dictionary terms sent as `keywords` query parameters
- Model validation and default selection (`nova-3`) in `getTranscriptionModel()`
- API key retrieval with fallback in `getAPIKey()`

**Retry transcription path:**
- Deepgram routing added to the retry handler in `ipcHandlers.js`
- `_resolveByokModel()` updated to validate and default Deepgram models

**Settings UI:**
- Deepgram added as a tab in `TranscriptionModelPicker` (between Mistral and Custom)
- API key input with link to `https://console.deepgram.com/`
- Model selection cards for Nova 3 and Nova 2
- Props plumbed through `SettingsPage`, `OnboardingFlow`, `UploadAudioView`
- Provider readiness check includes `deepgramApiKey`
- Onboarding step completion validates Deepgram key presence

**Streaming transcription:**
- Already fully implemented (877 lines in `deepgramStreaming.js`)
- No changes needed — Deepgram was already the default streaming provider for notes

**Provider icon:**
- New `deepgram.svg` icon added to `src/assets/icons/providers/`
- Registered in `providerIcons.ts`

### Files Changed

| File | Change |
|------|--------|
| `src/models/modelRegistryData.json` | Added Deepgram provider with Nova 3/2 models |
| `src/helpers/environment.js` | Added `DEEPGRAM_API_KEY` to persisted keys + get/save methods |
| `src/helpers/ipcHandlers.js` | Added key handlers, file transcription handler, BYOK dispatch |
| `preload.js` | Added Deepgram key + file transcription IPC bridge |
| `src/types/electron.ts` | Added type declarations for Deepgram APIs |
| `src/stores/settingsStore.ts` | Added `deepgramApiKey` state, setter, initialization |
| `src/hooks/useSettings.ts` | Added `deepgramApiKey` to `ApiKeySettings` interface + hook |
| `src/utils/byokDetection.ts` | Added `deepgramApiKey` to stored key detection |
| `src/utils/providerIcons.ts` | Added Deepgram icon mapping |
| `src/assets/icons/providers/deepgram.svg` | New Deepgram brand icon |
| `src/components/TranscriptionModelPicker.tsx` | Added Deepgram tab + API key input |
| `src/components/SettingsPage.tsx` | Plumbed Deepgram props through TranscriptionSection |
| `src/components/OnboardingFlow.tsx` | Added Deepgram key validation in onboarding |
| `src/components/notes/UploadAudioView.tsx` | Added Deepgram file transcription dispatch |
| `src/helpers/audioManager.js` | Added Deepgram to API key, model, and transcription paths |

## Build Result

- **TypeScript:** PASS (0 errors)
- **ESLint:** PASS (0 errors)
- **Vite build:** PASS (built in 1m 29s)
- **electron-builder:** App bundle created successfully
- **Code signing:** Ad-hoc signed with `codesign --sign - --force --deep`

**Note:** electron-builder's automated signing hit a "resource fork detritus" error during DMG packaging, which caused `extraResources` (native macOS binaries) to be missing from the initial bundle. Fix: native binaries (`macos-globe-listener`, `macos-fast-paste`, `macos-mic-listener`, `macos-text-monitor`, `macos-media-remote`, `macos-audio-tap`) were manually copied from `resources/bin/` into the app bundle at `Contents/Resources/resources/bin/`, then re-signed with `codesign --sign - --force --deep`.

## Build Command

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac
```

## App Install Result

- **Previous app backed up to:** `/Applications/OpenWhispr-backup-20260413-104551.app`
- **New app installed to:** `/Applications/OpenWhispr.app` (681 MB)
- **App launch:** Verified successful

## Rollback

To restore the previous version:
```bash
rm -rf /Applications/OpenWhispr.app
mv "/Applications/OpenWhispr-backup-20260413-104551.app" /Applications/OpenWhispr.app
```

## Deepgram API Key Configuration

In the app, go to **Settings > Transcription > Providers** and select the **Deepgram** tab. Enter your Deepgram API key from [console.deepgram.com](https://console.deepgram.com/). Select Nova 3 (recommended) or Nova 2 as the model.

## Known Limitations

1. **No Deepgram-specific language selection UI** — uses the app's existing language preference
2. **Ad-hoc code signing** — the app is not notarized, so macOS Gatekeeper may require manual override on first launch (`System Settings > Privacy & Security > Open Anyway`)
3. **Optional base URL override** — supported via the custom endpoint field when Deepgram is selected, but not exposed as a dedicated field (works the same as other providers)
