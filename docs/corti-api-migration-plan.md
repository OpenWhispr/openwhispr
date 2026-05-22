# Plan: Corti STT API Migration for OpenWhispr

## Context

OpenWhispr currently supports Whisper (local), NVIDIA Parakeet (local), OpenAI/Groq/Mistral (BYOK cloud), and its own hosted cloud for transcription. This plan adds **Corti AI** as a first-class transcription backend, supporting two modes:

1. **Real-time WebSocket streaming** via `/transcribe` — stateless dictation, streams audio as recording happens, delivers interim + final results. This is the primary use case and integrates with OpenWhispr's existing live-preview infrastructure.
2. **Batch REST transcription** via `/recordings` + `/transcripts` — upload-then-poll workflow for post-recording transcription. This is the "offline" mode the user asked about.

Corti uses OAuth 2.0 client credentials (not API keys) — tokens last 5 minutes and must be auto-refreshed.

---

## Architecture: How Corti Fits In

### Mode 1 — Real-time WebSocket (`/transcribe`)

**Existing pattern to follow exactly:** `src/helpers/deepgramStreaming.js` (887 lines).

**WebSocket URL:**
```
wss://api.{eu|us}.corti.app/audio-bridge/v2/transcribe?tenant-name={tenant}&token=Bearer%20{access_token}
```

**Session flow:**
1. Connect → send config within 10s:
```json
{
  "type": "config",
  "configuration": {
    "primaryLanguage": "en",
    "interimResults": true,
    "automaticPunctuation": true,
    "audioFormat": "audio/webm; codecs=opus"
  }
}
```
2. Wait for `{ "type": "CONFIG_ACCEPTED" }` before sending audio
3. Stream binary `audio/webm; codecs=opus` frames (already what MediaRecorder produces)
4. Server sends `{ "type": "transcript", "transcript": { "text": "...", "isFinal": false|true } }`
5. On recording stop: send `{ "type": "flush" }` → wait for `{ "type": "flushed" }` → close WebSocket
6. Collect all `isFinal: true` transcript fragments, join to final text

**Audio note:** MediaRecorder already outputs `audio/webm; codecs=opus` — no re-encoding needed. For the preview path (AudioWorklet PCM), declare `audioFormat: "audio/pcm; rate=16000; channels=1; bits=16"` instead.

### Mode 2 — Batch REST

Multi-step REST flow handled in main process:
1. `POST /v2/interactions` → `interactionId`
2. `POST /v2/interactions/{id}/recordings/` with raw audio binary → `recordingId`
3. `POST /v2/interactions/{id}/transcripts/` with `{ recordingId, primaryLanguage }` → starts job
4. Poll `GET /v2/interactions/{id}/transcripts/{transcriptId}/status` (max 25s sync, then async polling every 2s, timeout 120s)
5. `GET /v2/interactions/{id}/transcripts/{transcriptId}` → extract text

Headers for all REST calls:
```
Authorization: Bearer {access_token}
Tenant-Name: {tenant}
```

---

## Files to Create

### 1. `src/helpers/cortiTranscribeStreaming.js` (NEW)

Modeled on `deepgramStreaming.js`. Key differences from Deepgram:
- No pre-warming (stateless WSS)
- OAuth token fetch before each connection (with 30s-before-expiry refresh)
- Config message must be sent before audio, must wait for CONFIG_ACCEPTED
- Handles message types: `CONFIG_ACCEPTED`, `CONFIG_DENIED`, `CONFIG_TIMEOUT`, `transcript` (isFinal=false/true), `flushed`, `error`
- On stop: send `flush` message → wait for `flushed` → close; collect all final transcript parts

```js
class CortiTranscribeStreaming {
  constructor(environmentManager) { ... }
  async connect(options) { ... }         // fetch token, open WSS, send config, await CONFIG_ACCEPTED
  sendAudio(buffer) { ... }              // send binary frame
  async stop() { ... }                   // send flush, await flushed, close
  _onMessage(rawMsg) { ... }             // route by type
  async _fetchToken() { ... }            // OAuth2 client_credentials, cache with expiry
}
```

### 2. `src/helpers/cortiManager.js` (NEW)

Handles the batch REST mode. Token cache is shared with streaming module (extract token logic to a helper or expose from cortiManager).

```js
class CortiManager {
  async transcribeRecording(audioBlob, options) {
    // token → interaction → upload → create transcript → poll → return text
  }
  async _ensureToken() { ... }   // cache + refresh
  async _createInteraction() { ... }
  async _uploadRecording(interactionId, audioBuffer) { ... }
  async _createTranscript(interactionId, recordingId, language) { ... }
  async _pollTranscriptStatus(interactionId, transcriptId) { ... }
  async _getTranscript(interactionId, transcriptId) { ... }
}
```

---

## Files to Modify

### 3. `src/helpers/environment.js`

Add to `SECRET_KEYS` array:
- `"CORTI_CLIENT_ID"`
- `"CORTI_CLIENT_SECRET"`

Add getter/setter methods (following existing pattern for `DEEPGRAM_API_KEY`):
```js
getCortiClientId() { return this._getKey("CORTI_CLIENT_ID"); }
saveCortiClientId(v) { return this._saveKey("CORTI_CLIENT_ID", v); }
getCortiClientSecret() { return this._getKey("CORTI_CLIENT_SECRET"); }
saveCortiClientSecret(v) { return this._saveKey("CORTI_CLIENT_SECRET", v); }
```

Add non-secret env vars (stored in `.env` via `saveAllKeysToEnvFile()`):
- `CORTI_REGION` — `"eu"` or `"us"`
- `CORTI_TENANT` — tenant name (default `"base"`)

### 4. `src/helpers/ipcHandlers.js`

Following the existing Deepgram/AssemblyAI streaming handler pattern:

**Add import:**
```js
const CortiTranscribeStreaming = require("./cortiTranscribeStreaming");
```

**Register provider in streaming map** (near line where `"assemblyai-realtime"` / `"deepgram-realtime"` are registered):
```js
"corti-realtime": CortiTranscribeStreaming,
```

**Add REST batch handler** (following `"transcribe-local-whisper"` pattern):
```js
ipcMain.handle("transcribe-corti-rest", async (event, audioBlob, options = {}) => {
  const result = await this.cortiManager.transcribeRecording(audioBlob, options);
  if (!result.success && result.message === "No audio detected") {
    event.sender.send("no-audio-detected");
  }
  return result;
});
```

**Add credential IPC handlers** (following `"getDeepgramKey"` pattern):
- `"get-corti-client-id"` / `"save-corti-client-id"`
- `"get-corti-client-secret"` / `"save-corti-client-secret"`

### 5. `preload.js`

Following the Deepgram API surface:
```js
getCortiClientId: () => ipcRenderer.invoke("get-corti-client-id"),
saveCortiClientId: (v) => ipcRenderer.invoke("save-corti-client-id", v),
getCortiClientSecret: () => ipcRenderer.invoke("get-corti-client-secret"),
saveCortiClientSecret: (v) => ipcRenderer.invoke("save-corti-client-secret", v),
transcribeCortiRest: (audioBlob, opts) => ipcRenderer.invoke("transcribe-corti-rest", audioBlob, opts),
```

### 6. `src/helpers/audioManager.js`

**In `shouldUseStreaming()`**: add `"corti-realtime"` to the set of providers that trigger streaming mode.

**In `processAudio()` routing block**: add a `"corti"` REST branch:
```js
} else if (cloudTranscriptionProvider === "corti") {
  result = await this.processWithCortiREST(audioBlob, metadata);
}
```

**Add `processWithCortiREST()` method** (following `processWithOpenAIAPI()` pattern):
```js
async processWithCortiREST(audioBlob, metadata) {
  const arrayBuffer = await audioBlob.arrayBuffer();
  const result = await window.electronAPI.transcribeCortiRest(arrayBuffer, {
    language: metadata.language || settings.preferredLanguage,
  });
  return { ...result, source: "corti-rest" };
}
```

**In `getStreamingProvider()`**: ensure `"corti-realtime"` is returned when `sttConfig.streamingProvider === "corti-realtime"`.

### 7. `src/hooks/useSettings.ts`

Add to settings interface and defaults:
```ts
cortiRegion: "eu" | "us";          // default "eu"
cortiTenant: string;               // default "base"
cortiTranscriptionMode: "websocket" | "rest";  // default "websocket"
```

Extend `cloudTranscriptionProvider` enum to include `"corti"` and `"corti-realtime"`.

### 8. `src/components/SettingsPage.tsx`

Add a Corti section within the cloud provider settings (following the existing Deepgram settings pattern):
- Region selector: EU / US
- Tenant name input (text field)
- Client ID input (password field, masked)
- Client Secret input (password field, masked)
- Mode toggle: Real-time Streaming / Batch REST

### 9. `src/locales/*/translation.json` (all 9 language files)

Add keys under `settings.corti.*`:
```json
"corti": {
  "title": "Corti",
  "region": "Region",
  "tenant": "Tenant Name",
  "clientId": "Client ID",
  "clientSecret": "Client Secret",
  "mode": "Transcription Mode",
  "modeWebsocket": "Real-time Streaming",
  "modeRest": "Batch REST"
}
```
(English values only; other languages can machine-translate or use English as fallback initially.)

### 10. `main.js`

Instantiate `CortiManager` and pass it to `IpcHandlers`:
```js
const CortiManager = require("./src/helpers/cortiManager");
this.cortiManager = new CortiManager(this.environmentManager);
// pass to ipcHandlers constructor or setter
```

---

## Token Management Detail

Corti tokens expire in 300 seconds. Shared cache object:
```js
const tokenCache = { token: null, expiresAt: 0 };

async function ensureToken(clientId, clientSecret, region, tenant) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 30_000) {
    return tokenCache.token;
  }
  const res = await fetch(
    `https://auth.${region}.corti.app/realms/${tenant}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "openid",
      }),
    }
  );
  const data = await res.json();
  tokenCache.token = data.access_token;
  tokenCache.expiresAt = Date.now() + data.expires_in * 1000;
  return tokenCache.token;
}
```

The `cortiTranscribeStreaming.js` and `cortiManager.js` both call this shared helper.

---

## Verification

1. **Unit-style smoke test**: In `cortiManager.js`, add a `testConnection()` method that fetches a token and checks the HTTP status — call from settings UI "Test Connection" button.
2. **REST path**: Record a short clip with `cloudTranscriptionProvider = "corti"` and `cortiTranscriptionMode = "rest"` → transcript should appear in history within ~10s.
3. **WebSocket path**: Set `streamingProvider = "corti-realtime"` → start recording → confirm interim preview text updates in the overlay → stop → final text pasted to clipboard.
4. **Token refresh**: Set system clock forward (or unit-test the cache) to verify re-fetch before expiry.
5. **Settings persistence**: Save Client ID + Secret → restart app → verify re-loaded from `safeStorage`.
6. **i18n**: Switch app language to French → confirm Corti settings labels appear (even if English fallback is used initially).
