# OpenWhispr Technical Reference for AI Assistants

This document provides comprehensive technical details about the OpenWhispr project architecture for AI assistants working on the codebase.

## Response Style

Keep responses focused, brief, and concise. Keep disclaimers and caveats short, and spend most of the response on the main answer. When asked to explain something, give a high-level summary unless an in-depth explanation is specifically requested.

## Project Overview

OpenWhispr is an Electron-based desktop dictation application that uses whisper.cpp for speech-to-text transcription. It supports both local (privacy-focused) and cloud (OpenAI API) processing modes.

## Architecture Overview

### Core Technologies

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite
- **Desktop Framework**: Electron 41 with context isolation
- **Database**: better-sqlite3 for local transcription history
- **UI Components**: shadcn/ui with Radix primitives
- **Speech Processing**: whisper.cpp + NVIDIA Parakeet (via sherpa-onnx) + OpenAI API
- **Audio Processing**: FFmpeg (bundled via ffmpeg-static)
- **Node.js**: 24 (pinned in `.nvmrc` — CI uses Node 24, do NOT regenerate `package-lock.json` with a different major version)

### Key Architectural Decisions

1. **Dual Window Architecture**:
   - Main Window: Minimal overlay for dictation (draggable, always on top)
   - Control Panel: Full settings interface (normal window)
   - Both use same React codebase with URL-based routing

2. **Process Separation**:
   - Main Process: Electron main, IPC handlers, database operations
   - Renderer Process: React app with context isolation
   - Preload Script: Secure bridge between processes
   - ONNX Utility Process: hosts all `onnxruntime-node` inference (text embeddings, speaker embeddings, fbank). Lazy-spawned on first use via `src/helpers/onnxWorkerClient.js` → `src/workers/onnxWorker.js`. Native crashes (e.g., ORT `bad_alloc`) confine to the worker; main process rejects in-flight requests and respawns with backoff. Stopped in `will-quit`.

3. **Audio Pipeline**:
   - MediaRecorder API → Blob → ArrayBuffer → IPC → File → whisper.cpp
   - Automatic cleanup of temporary files after processing

## File Structure and Responsibilities

### Main Process Files

- **main.js**: Application entry point, initializes all managers
- **preload.js**: Exposes safe IPC methods to renderer via window.api

### Native Resources (resources/)

- **windows-key-listener.c**: C source for Windows low-level keyboard hook (Push-to-Talk)
- **windows-mic-listener.c**: C source for WASAPI mic session monitor (event-driven mic detection)
- **windows-system-audio-helper.c**: C source for WASAPI process-loopback system audio capture (meeting transcription). Excludes OpenWhispr's own process tree, so it hears every app on every output device. Requires Windows 10 2004+; falls back to Chromium display-media loopback when unavailable, and mid-session when the helper emits a `capture_silent` warning (its own stream is silent while a render endpoint is metering output — activation success cannot detect that). Outputs 24 kHz mono s16le PCM on stdout, line-delimited JSON events on stderr (same protocol as linux-system-audio-helper)
- **macos-mic-listener.swift**: Swift source for CoreAudio mic property listener (event-driven mic detection)
- **globe-listener.swift**: Swift source for macOS Globe/Fn key detection
- **bin/**: Directory for compiled native binaries (whisper-cpp, nircmd, key/mic listeners)

### Helper Modules (src/helpers/)

- **audioManager.js**: Handles audio device management
- **clipboard.js**: Cross-platform clipboard operations
  - macOS: AppleScript-based paste with accessibility permission check
  - Windows: PowerShell SendKeys with nircmd.exe fallback
  - Linux: compositor-aware Wayland paste (Hyprland sendshortcut, wlroots wtype, GNOME/KDE portal keysyms) with native uinput/XTest and system-tool fallbacks
- **database.js**: SQLite operations for transcription history
- **debugLogger.js**: Debug logging system with file output
- **devServerManager.js**: Vite dev server integration
- **dockManager.js**: Single owner of the macOS Dock icon
  - The icon follows the control panel: it appears when the panel opens and goes away when the panel closes to the tray, so no other caller (in particular the dictation panel's hide path) can resurrect it
  - Every path that surfaces or hides the control panel (tray, app menu, deep links, `activate`, `ready-to-show`, `hideControlPanelToTray`) reports that state explicitly
  - Never derive that state from the window's `show`/`hide` events: on macOS those are occlusion events, so they also fire when the panel is merely covered by another window, minimized, or on another Space, and the icon flickers as the user switches windows
  - Decision logic lives in `dockPolicy.js` (pure, unit-tested in `test/helpers/dockPolicy.test.js`)
- **dragManager.js**: Window dragging functionality
- **environment.js**: Environment variable and OpenAI API management
- **hotkeyManager.js**: Global hotkey registration and management
  - Named hotkey slots: `dictation`, `voiceAgent` (voice assistant — dictation routed to the assistant panel), `translation`, `meeting`
  - Handles platform-specific defaults (GLOBE on macOS, Control+Super on Windows/Linux)
  - Auto-fallback to F8/F9 if default hotkey is unavailable
  - Notifies renderer via IPC when hotkey registration fails
  - Integrates with GnomeShortcutManager for GNOME Wayland support
  - Integrates with HyprlandShortcutManager for Hyprland Wayland support
  - Integrates with KDEShortcutManager for KDE Wayland support
- **gnomeShortcut.js**: GNOME Wayland global shortcut integration
  - Uses D-Bus service to receive hotkey toggle commands
  - Registers shortcuts via gsettings (visible in GNOME Settings → Keyboard → Shortcuts)
  - Converts Electron hotkey format to GNOME keysym format
  - Only active on Linux + Wayland + GNOME desktop
  - D-Bus transport: `@homebridge/dbus-native` (pure JavaScript, no native addons)
- **hyprlandShortcut.js**: Hyprland Wayland global shortcut integration
  - Uses D-Bus service to receive hotkey toggle commands (same `com.openwhispr.App` service)
  - Registers shortcuts via `hyprctl keyword bind` (runtime keybinding)
  - Converts Electron hotkey format to Hyprland bind format (`MODS, key`)
  - Only active on Linux + Wayland + Hyprland (detected via `HYPRLAND_INSTANCE_SIGNATURE`)
  - D-Bus transport: `@homebridge/dbus-native` (pure JavaScript, no native addons)
- **kdeShortcut.js**: KDE Wayland global shortcut integration
  - Uses D-Bus to communicate with KGlobalAccel for global hotkey registration
  - Registers hotkeys via `setShortcut`/`doRegister` D-Bus calls on the KGlobalAccel interface
  - Listens for `globalShortcutPressed` signals to trigger callbacks
  - Converts Electron hotkey format to Qt key codes
  - Only active on Linux + KDE desktop (detected via `XDG_CURRENT_DESKTOP`)
  - D-Bus transport: `@homebridge/dbus-native` (pure JavaScript, no native addons)
- **autoStart.js**: Single entry point for launch at login, used by `ipcHandlers.js` and `main.js`
  - Dispatches to `setLoginItemSettings()` on macOS/Windows and to `linuxAutostart.js` on Linux
  - `getAutoStartState()` returns `{ enabled, requiresApproval }`; `requiresApproval` is macOS-only and means SMAppService registered the item but the user has not allowed it under System Settings → General → Login Items yet
  - `wasLaunchedAtLoginHidden()` decides whether this launch should go straight to the tray
  - `syncAutoStartEntry()` runs from `initializeCoreManagers()` and repairs entries written by older builds
  - Decision logic lives in `autoStartPolicy.js` (pure, unit-tested in `test/helpers/autoStartPolicy.test.js`)
- **autoStartPolicy.js**: Electron-free launch-at-login decisions
  - `HIDDEN_LAUNCH_FLAG` (`--hidden`) is how a login launch tells the app to start in the tray. Windows has no native equivalent (`openAsHidden` is macOS-only and a no-op on macOS 13+), so the flag rides on the login item's `args`; Linux puts it on the autostart entry's `Exec`; macOS uses `wasOpenedAtLogin` instead
  - On Windows, read the state from `executableWillLaunchAtLogin`, never from `openAtLogin`: `openAtLogin` only compares the `Run` value against the current executable and args and ignores the `StartupApproved` key that Task Manager and Settings write when a user disables a startup app
  - Reads and writes must pass identical `args`, or `openAtLogin` always reports false
- **linuxAutostart.js**: Launch-at-login on Linux via an XDG autostart entry
  - `app.setLoginItemSettings()` is a no-op on Linux, so the entry is written directly to `$XDG_CONFIG_HOME/autostart/open-whispr.desktop`, matching the executable name electron-builder packages under
  - `Exec` resolves from `$APPIMAGE` first: `process.execPath` is the ephemeral AppImage FUSE mount
  - `isAutostartEnabled()` honors `X-GNOME-Autostart-enabled=false` and `Hidden=true`, which GNOME Tweaks and KDE's autostart editor write in place instead of deleting the file
  - `Exec` carries `--hidden` (see `autoStartPolicy.js`), and `syncAutostartEntry()` compares against the full value including that flag — comparing against the bare path would make every launch look stale
  - `syncAutostartEntry()` runs from `autoStart.syncAutoStartEntry()` in `initializeCoreManagers()` and re-points a stale `Exec` after the executable moves (renamed or auto-updated AppImage); it never re-enables an entry the user disabled, and no-ops in development
  - Unit-tested in `test/helpers/linuxAutostart.test.js`
- **ipcHandlers.js**: Centralized IPC handler registration
- **windowsKeyManager.js**: Windows Push-to-Talk support with native key listener
  - Spawns native `windows-key-listener.exe` binary for low-level keyboard hooks
  - Supports compound hotkeys (e.g., `Ctrl+Shift+F11`, `CommandOrControl+Space`)
  - Emits `key-down` and `key-up` events for push-to-talk functionality
  - Graceful fallback if binary unavailable
- **meetingDetectionEngine.js**: Orchestrates meeting detection from all sources
  - Gates notifications during recording (tap-to-talk and push-to-talk)
  - Post-recording cooldown (2.5s) before showing queued notifications
  - Priority-based coalescing (process > audio) — one notification, not three
- **meetingProcessDetector.js**: Detects running meeting apps
  - macOS: Event-driven via `systemPreferences.subscribeWorkspaceNotification` (zero CPU)
  - Windows/Linux: Shared `processListCache` polling (30s interval)
- **audioActivityDetector.js**: Detects microphone usage for unscheduled meetings
  - macOS: Event-driven via `macos-mic-listener` binary (CoreAudio property listeners)
  - Windows: Event-driven via `windows-mic-listener.exe` (WASAPI sessions, self-PID exclusion)
  - Linux: Event-driven via `pactl subscribe` (PulseAudio source-output events)
  - All platforms: Graceful fallback to polling if native approach fails
- **processListCache.js**: Shared singleton process list cache (5s TTL, `ps-list` npm)
- **meetingEchoLeakDetector.js**: Audio-layer echo analysis for meeting recordings — correlates each mic chunk against the recent system-audio tap (lag search 0–500 ms in 5 ms steps) and classifies it `clean_local` / `suspected_render_bleed` / `double_talk`; drives chunk muting and per-segment suppression flags. PCM-driven tests in `test/helpers/meetingEchoLeakDetector.test.js`
- **meetingMicGate.js**: Pure RMS/peak chunk stats + the meeting mic gate verdict (`send` / `zero` for streaming, `send` / `skip` for local) with the exported silence and bleed thresholds; `ipcHandlers.js` (`dispatchMeetingAudioBuffer`, `transcribeLocalMeetingChunk`) only applies the verdict. Unit-tested in `test/helpers/meetingMicGate.test.js`
- **meetingMicHoldback.js**: Pure holdback/retract policy for risky mic finals — pending-final partition, retract window, risky-profile classifier, text-layer duplicate check, racing-retract candidate selection, pending-overlap partition. `ipcHandlers.js` keeps thin adapters over its closure state (`meetingDiarizationSegments`, `meetingPendingMicFinals`, `hasNearbyTranscriptMatch`). Unit-tested in `test/helpers/meetingMicHoldback.test.js`
- **googleCalendarManager.js**: Google Calendar sync (REST, OAuth via `googleCalendarOAuth.js`)
  - 10s socket timeout on API requests
  - Incremental sync via `syncToken`; full re-sync on 410 prunes stale events (note-linked rows retained)
  - Sync tokens pin the `timeMin`/`timeMax` window of the full sync that created them (incremental syncs never roll it forward), so tokens are discarded after 1 day to keep the 33-day lookahead covering the availability tool's 31-day horizon
- **microsoftCalendarManager.js**: Microsoft Calendar sync via Graph API (OAuth via `microsoftCalendarOAuth.js`)
  - `calendarView/delta` incremental sync over a 38-day window; delta token discarded after 7 days (Graph delta links never roll their window forward)
  - Delta can return recurring-series occurrences as bare stubs (no subject/attendees/meeting link); they're backfilled from their series master, one `GET /me/calendars/{calendarId}/events/{id}` per series (calendar-scoped: `/me/events/{id}` 404s for shared calendars). A failed backfill shortens the delta token TTL to 10 min so an early full sync retries instead of leaving untitled blocks
  - Full re-sync (410 or expired token) prunes stale events like Google
- **appleCalendarManager.js**: Apple Calendar (EventKit) via the `macos-calendar-listener` Swift helper — macOS only, snapshot-push over stdout, no tokens ("connected" = `apple_calendars` has rows)
- **calendarReminderScheduler.js**: Provider-agnostic meeting reminder scheduling over the shared `calendar_events` table (provider-scoped reset keys, so one provider's disconnect doesn't re-fire another's reminders)
- **calendarSyncInterval.js**: Shared interval runner for the REST providers — exponential backoff (2min → 4min → 8min → cap 30min on consecutive failures, reset on success) and 30s focus-sync throttle
- **oauthLoopbackFlow.js**: Shared PKCE auth-code flow over an ephemeral 127.0.0.1 server, used by both calendar OAuth helpers
- Events from all providers land in the shared `calendar_events` table with a `provider` column; queries suppress the Apple copy of a meeting when a REST row occupies the same time slot + title (Calendar.app mirrors the same accounts)
- **menuManager.js**: Application menu management
- **tray.js**: System tray icon and menu
- **whisper.js**: Local whisper.cpp integration and model management
- **parakeet.js**: NVIDIA Parakeet model management via sherpa-onnx
- **parakeetServer.js**: sherpa-onnx CLI wrapper for transcription
- **qdrantManager.js**: Qdrant vector DB sidecar process lifecycle (spawn, health check, shutdown)
- **localEmbeddings.js**: Local text embedding via ONNX Runtime + all-MiniLM-L6-v2 (384-dim vectors)
- **vectorIndex.js**: Qdrant collection management — upsert, delete, search, batch reindex
- **windowConfig.js**: Centralized window configuration
- **windowManager.js**: Window creation and lifecycle management
- **cliBridge.js**: Loopback HTTP server on ports 8200–8219, bearer-token auth (token at `~/.openwhispr/cli-bridge.json`), 127.0.0.1-only. Used by the unified CLI to talk to a running desktop app.
- **postMigrationDetector.js**: Detects users returning from the pre-Gizmo bundle ID via a `.bundle-migrated` sentinel in userData; consumed by `ipcHandlers.js` to drive the `PostMigrationOnboarding` modal

### React Components (src/components/)

- **App.jsx**: Main dictation interface with recording states
- **ControlPanel.tsx**: Settings, history, model management UI
- **OnboardingFlow.tsx**: First-time setup wizard over a versioned, route-based step machine (`src/components/onboarding/flow.ts`; session persisted in `onboardingSessionV2`). Routes vary by auth path (account vs guest), policy (agent allowed), and setup mode (cloud / BYOK / local / enterprise); step components live in `src/components/onboarding/`
- **PostMigrationOnboarding.tsx**: One-time modal for users returning from the pre-Gizmo bundle ID; reuses `PermissionsSection` to walk through re-granting Microphone, Accessibility, and System Audio. Triggered by `postMigrationDetector.js` (see Helper Modules)
- **SettingsPage.tsx**: Comprehensive settings interface
- **WhisperModelPicker.tsx**: Model selection and download UI
- **ui/**: Reusable UI components (buttons, cards, inputs, etc.)

### React Hooks (src/hooks/)

- **useAudioRecording.js**: MediaRecorder API wrapper with error handling
- **useAssistantPanel.js**: Assistant panel lifecycle (open/close choreography, thinking flourish, footer phases, pending voice commands, conversation session boundaries)
- **useLiveTranscriptPanel.js**: Live transcript panel lifecycle (entrance choreography, buffered text scheduler, measure-then-reveal resize pipeline, preview IPC wiring)
- **useMainWindowSizeOwner.js**: Single owner of the main window size ladder (panel > menu > toast > pill > base) and the dictation-error pill handoff
- **useWindowResizeCompensation.js**: Masks split native setBounds frames via CSS-variable counter-translation
- **useMainProcessNotifications.tsx**: Main-process notifications (hotkey fallback, GPU fallback, learned corrections) as toasts
- **useClipboard.ts**: Clipboard operations hook
- **useDialogs.ts**: Electron dialog integration
- **useHotkey.js**: Hotkey state management
- **useLocalStorage.ts**: Type-safe localStorage wrapper
- **usePermissions.ts**: System permission checks and settings access
  - `openMicPrivacySettings()`: Opens OS microphone privacy settings
  - `openSoundInputSettings()`: Opens OS sound input device settings
  - `openAccessibilitySettings()`: Opens OS accessibility settings (macOS only)
- **useSettings.ts**: Application settings management
- **useWhisper.ts**: Whisper binary availability check

### Services

- **ReasoningService.ts**: AI processing for agent-addressed commands
  - Detects when user addresses their named agent and removes the agent name from final output
  - Provider implementations live in a registry at `src/services/ai/inferenceProviders/index.ts` covering 8 providers (`anthropic`, `enterprise`, `gemini`, `groq`, `lan`, `local`, `openai`, `openwhispr`), each implementing the `InferenceProvider` interface from `types.ts`
  - Per-scope LLM config: 4 scopes (`dictationCleanup`, `dictationAgent`, `noteFormatting`, `chatIntelligence`) defined in `src/config/inferenceScopes.ts`
  - `selectResolvedLLMConfig(state, scope)` in `settingsStore.ts` resolves provider/model per scope with fallback chains

### whisper.cpp Integration

- **whisper.js**: Native binary wrapper for local transcription
  - Bundled binaries in `resources/bin/whisper-cpp-{platform}-{arch}`
  - Falls back to system installation (`brew install whisper-cpp`)
  - GGML model downloads from HuggingFace
  - Models stored in `~/.cache/openwhispr/whisper-models/`

### NVIDIA Parakeet Integration (via sherpa-onnx)

- **parakeet.js**: Model management for NVIDIA Parakeet ASR models
  - Uses sherpa-onnx runtime for cross-platform ONNX inference
  - Bundled binaries in `resources/bin/sherpa-onnx-{platform}-{arch}`
  - INT8 quantized models for efficient CPU inference
  - Models stored in `~/.cache/openwhispr/parakeet-models/`
  - Server pre-warming on startup when `LOCAL_TRANSCRIPTION_PROVIDER=nvidia` is set
  - Provider preference persisted to `.env` via `saveAllKeysToEnvFile()` on server start/stop

- **Available Models**:
  - `parakeet-tdt-0.6b-v3`: Multilingual (25 languages), ~680MB
  - `parakeet-unified-en-0.6b`: English-only, ~631MB, state-of-the-art EN accuracy (5.91% avg WER on Open ASR Leaderboard)
  - `nemotron-speech-streaming-en-0.6b`: English-only, ~632MB, cache-aware streaming FastConformer (`"runtime": "online"` in the registry)
  - `nemotron-3.5-asr-streaming-0.6b`: Multilingual (15 transcription-ready languages, auto detection), ~650MB, cache-aware streaming FastConformer (`"runtime": "online"`)
  - `cohere-transcribe-03-2026`: Multilingual (14 languages, NO auto detection — one language per server start), ~1.7GB download / ~2.7GB on disk, Conformer encoder-decoder (`"modelType": "cohere-transcribe"`), most accurate local model (5.42% avg WER). Exposed as the `"cohere"` local provider in settings/UI but served by the same ParakeetManager/sherpa-onnx offline WS server; the dictation language is part of the server identity, so changing it restarts the server. Segments long audio at 30s (model max ~35s)

- **Runtimes**: Models are `offline` (default) or `online` per their registry `runtime` field. Offline models use the bundled `sherpa-onnx-ws-{platform}-{arch}` (offline websocket server); online models use `sherpa-onnx-online-ws-{platform}-{arch}` (online websocket server). Both are downloaded by `scripts/download-sherpa-onnx.js`. Partial/final JSON results are merged by `parakeetWsResult.js`.

- **Streaming Commit (online models)**: For online-runtime models, dictation streams worklet PCM to a persistent websocket stream during capture (regardless of the preview toggle) and commits the flushed text at stop as the final transcript — no second decode of the recording. The stop flush is truncation-aware (`finish()` extends its deadline while results keep arriving and flags `truncated`); anything but a clean flush falls back to the record-then-transcribe path (`transcribe-local-parakeet`), which for online models decodes the whole recording over a single stream (no 15s segmentation; segments only bound memory for very long files).

- **Live Transcription Preview**: When the preview toggle is on and an online-runtime model is selected, the preview shares the streaming-commit websocket: partial results update the preview window live (replacing text via `showTranscriptionPreview`). Offline models keep the 1.5s buffered-chunk path (appending via `appendTranscriptionPreview`). If the stream can't start or dies mid-dictation, the preview falls back to the chunked path and the final transcript falls back to the full decode. Tests: `test/helpers/parakeetOnlineStream.test.js` (mock websocket server).

- **Download URLs**: Models from sherpa-onnx ASR models release on GitHub

### Local Semantic Search (Qdrant + MiniLM)

Always-on offline semantic search that finds notes by meaning, not just keywords. Used by the AI agent's `search_notes` tool. Qdrant starts automatically on app launch; embedding model auto-downloads on first run if missing.

**Architecture**:

- **Qdrant sidecar**: Rust binary spawned as child process (`qdrantManager.js`), port 6333–6350
- **Embedding model**: `all-MiniLM-L6-v2` via ONNX Runtime (`localEmbeddings.js`), 384-dim vectors
- **Vector index**: Qdrant collection management (`vectorIndex.js`), cosine distance
- **Hybrid search**: FTS5 + Qdrant in parallel → Reciprocal Rank Fusion (K=60) with 0.3 cosine score threshold

**Pipeline**:

1. App launches → Qdrant binary starts → collection created. Embedding model auto-downloads if missing (~22MB)
2. Note create/update/delete → SQLite write → background vector upsert/delete via `_asyncVectorUpsert()`/`_asyncVectorDelete()`
3. Agent searches → `db-semantic-search-notes` IPC → parallel FTS5 + vector search → RRF merge → ranked results

**Search fallback chain** (in `searchNotesTool.ts`): cloud search → local semantic → FTS5 keyword

**Storage**:

- Qdrant data: `~/.cache/openwhispr/qdrant-data/` (`qdrant-data-dev/` in development)
- Qdrant binary: `resources/bin/qdrant-{platform}-{arch}` (bundled — downloaded during `prebuild` / `predev:main`)
- Embedding model: `~/.cache/openwhispr/embedding-models/all-MiniLM-L6-v2/` (auto-downloaded on first launch)

**Dependencies**: `@qdrant/js-client-rest`, `onnxruntime-node`

**Dev setup**: The Qdrant binary downloads automatically via `predev`/`prestart`. The embedding model auto-downloads on first app launch. To manually download: `npm run download:qdrant` and `npm run download:embedding-model`.

### Build Scripts (scripts/)

- **download-whisper-cpp.js**: Downloads whisper.cpp binaries from GitHub releases
- **download-llama-server.js**: Downloads llama.cpp server for local LLM inference
- **download-nircmd.js**: Downloads nircmd.exe for Windows clipboard operations
- **download-windows-key-listener.js**: Downloads prebuilt Windows key listener binary
- **download-windows-mic-listener.js**: Downloads prebuilt Windows mic listener binary
- **download-sherpa-onnx.js**: Downloads sherpa-onnx binaries for Parakeet support
- **download-qdrant.js**: Downloads Qdrant vector DB binary for local semantic search
- **download-minilm.js**: Downloads all-MiniLM-L6-v2 ONNX model + tokenizer for local embeddings
- **build-globe-listener.js**: Compiles macOS Globe key listener from Swift source
- **build-macos-mic-listener.js**: Compiles macOS mic listener from Swift source
- **build-windows-key-listener.js**: Compiles Windows key listener (for local development)
- **run-electron.js**: Development script to launch Electron with proper environment
- **lib/download-utils.js**: Shared utilities for downloading and extracting files
  - `fetchLatestRelease(repo, options)`: Fetches latest release from GitHub API
  - `downloadFile(url, dest)`: Downloads file with progress and retry logic
  - `extractZip(zipPath, destDir)`: Cross-platform zip extraction
  - `parseArgs()`: Parses CLI arguments for platform/arch targeting
  - Supports `GITHUB_TOKEN` for authenticated requests (higher rate limits)

## Key Implementation Details

### 1. FFmpeg Integration

FFmpeg is bundled with the app and doesn't require system installation:

```javascript
// FFmpeg is unpacked from ASAR to app.asar.unpacked/node_modules/ffmpeg-static/
```

### 2. Audio Recording Flow

1. User presses hotkey → MediaRecorder starts
2. Audio chunks collected in array
3. User presses hotkey again → Recording stops
4. Blob created from chunks → Converted to ArrayBuffer
5. Sent via IPC
6. Main process writes to temporary file
7. whisper.cpp processes file → Result sent back
8. Temporary file deleted

### 3. Local Whisper Models (GGML format)

Models stored in `~/.cache/openwhispr/whisper-models/`:

- tiny: ~75MB (fastest, lowest quality)
- base: ~142MB (recommended balance)
- small: ~466MB (better quality)
- medium: ~1.5GB (high quality)
- large: ~3GB (best quality)
- turbo: ~1.6GB (fast with good quality)

### 4. Database Schema

```sql
CREATE TABLE transcriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  original_text TEXT NOT NULL,
  processed_text TEXT,
  is_processed BOOLEAN DEFAULT 0,
  processing_method TEXT DEFAULT 'none',
  agent_name TEXT,
  error TEXT
);
```

### 5. Settings Storage

Settings stored in localStorage with these keys:

- `whisperModel`: Selected Whisper model
- `useLocalWhisper`: Boolean for local vs cloud
- `language`: Selected language code
- `agentName`: User's custom agent name
- `reasoningModel`: Selected AI model for processing
- `reasoningProvider`: AI provider (openai/anthropic/gemini/local)
- `hotkey`: Custom hotkey configuration
- `hasCompletedOnboarding`: Onboarding completion flag
- `customDictionary`: JSON array of words/phrases for improved transcription accuracy

Secret env vars (12 total: 7 BYOK API keys + 5 enterprise cloud creds — see `SECRET_KEYS` in `environment.js`) are encrypted at rest via Electron `safeStorage` and stored as per-key files under `userData/secure-keys/`. They are loaded into `process.env` at startup by `EnvironmentManager.init()`. Renderer reads them via IPC (`get-*-key`) and writes via debounced IPC (`save-*-key`). On Linux without a keyring, secrets fall back to plaintext.

Non-secret env vars persisted to `.env` (via `saveAllKeysToEnvFile()`):

- `LOCAL_TRANSCRIPTION_PROVIDER`: Transcription engine (`nvidia` for Parakeet)
- `PARAKEET_MODEL`: Selected Parakeet model name (e.g., `parakeet-tdt-0.6b-v3`)

### 6. Language Support

58 languages supported (see src/utils/languages.ts):

- Each language has a two-letter code and label
- "auto" for automatic detection
- Passed to whisper.cpp via -l parameter

### 7. Agent Naming System

- User names their agent during onboarding (step 6/8)
- Name stored in localStorage and database
- ReasoningService detects "Hey [AgentName]" patterns
- Standalone wake-word commands stream into the assistant panel (the address is stripped first, `stripAgentAddress`); a highlighted selection is edited in place by the dictation agent
- Supports multiple AI providers (all models defined in `src/models/modelRegistryData.json`):
  - **OpenAI** (Responses API):
    - GPT-5.5 (`gpt-5.5`) - Latest flagship frontier model, 1M context
    - GPT-5.2 (`gpt-5.2`) - Strong reasoning model
    - GPT-5 Mini (`gpt-5-mini`) - Fast and cost-efficient
    - GPT-5 Nano (`gpt-5-nano`) - Ultra-fast, low latency
    - GPT-4.1 Series (`gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`) - Strong baseline with 1M context
  - **Anthropic** (Via IPC bridge to avoid CORS):
    - Claude Opus 4.7 (`claude-opus-4-7`) - Most capable Claude model, 1M context
    - Claude Sonnet 4.6 (`claude-sonnet-4-6`) - Balanced performance
    - Claude Haiku 4.5 (`claude-haiku-4-5`) - Fast with near-frontier intelligence
    - Claude Opus 4.6 (`claude-opus-4-6`) - Previous Opus generation, 1M context
    - Claude Sonnet 4.5 (`claude-sonnet-4-5`) - Previous Sonnet generation
    - Claude Opus 4.5 (`claude-opus-4-5`) - Earlier Opus model
  - **Google Gemini** (Direct API integration):
    - Gemini 3.5 Flash (`gemini-3.5-flash`) - Latest fast, high-capability Gemini model
    - Gemini 3.5 Flash Lite (`gemini-3.5-flash-lite`) - Fastest, most cost-effective 3.5 model
    - Gemini 3.1 Pro (`gemini-3.1-pro-preview`) - Most capable Gemini model
    - Gemini 3.1 Flash Lite (`gemini-3.1-flash-lite`) - Frontier-class performance at low cost (no thinking support, so no `supportsThinking` flag)
    - Gemini 3 Flash (`gemini-3-flash-preview`) - Ultra-fast, high-capability next-gen model
    - Gemini 2.5 Flash Lite (`gemini-2.5-flash-lite`) - Lowest latency and cost (retired for new API keys; kept for existing ones)
    - Gemma 4 (`gemma-4-31b-it`, `gemma-4-26b-a4b-it`) - Google's open Gemma 4 models served through the Gemini API
  - **Local**: GGUF models via llama.cpp (Qwen, Llama, Mistral, GPT-OSS)

### 8. Model Registry Architecture

All AI model definitions are centralized in `src/models/modelRegistryData.json` as the single source of truth:

```json
{
  "cloudProviders": [...],   // OpenAI, Anthropic, Gemini API models
  "localProviders": [...]    // GGUF models with download URLs
}
```

**Key files:**

- `src/models/modelRegistryData.json` - Single source of truth for all models
- `src/models/ModelRegistry.ts` - TypeScript wrapper with helper methods
- `src/config/aiProvidersConfig.ts` - Derives AI_MODES from registry
- `src/utils/languages.ts` - Derives REASONING_PROVIDERS from registry
- `src/helpers/modelManagerBridge.js` - Handles local model downloads

**Local model features:**

- Each model has `hfRepo` for direct HuggingFace download URLs
- Chat formatting comes from the GGUF's embedded template (llama-server runs with `--jinja`); the registry carries no prompt templates
- Download URLs constructed as: `{baseUrl}/{hfRepo}/resolve/main/{fileName}`

### 9. API Integrations and Updates

**OpenAI Responses API (September 2025)**:

- Migrated from Chat Completions to new Responses API
- Endpoint: `https://api.openai.com/v1/responses`
- Simplified request format with `input` array instead of `messages`
- New response format with `output` array containing typed items
- Automatic handling of GPT-5 and o-series model requirements
- No temperature parameter for newer models (GPT-5, o-series)

**Anthropic Integration**:

- Routes through IPC handler to avoid CORS issues in renderer process
- Uses main process for API calls with proper error handling
- Model IDs use alias format (e.g., `claude-sonnet-4-6` not date-suffixed versions)

**Gemini Integration**:

- Direct API calls from renderer process
- Increased token limits for Gemini 3.1 Pro (2000 minimum)
- Proper handling of thinking process in responses
- Error handling for MAX_TOKENS finish reason

**API Key Persistence**:

- All API keys now properly persist to `.env` file
- Keys stored in environment variables and reloaded on app start
- Centralized `saveAllKeysToEnvFile()` method ensures consistency

### 10. System Settings Integration

The app can open OS-level settings for microphone permissions, sound input selection, and accessibility:

**IPC Handlers** (in `ipcHandlers.js`):

- `open-microphone-settings`: Opens microphone privacy settings
- `open-sound-input-settings`: Opens sound/audio input device settings
- `open-accessibility-settings`: Opens accessibility privacy settings (macOS only)
- `open-login-items-settings`: Opens the login/startup items pane (macOS Login Items, Windows Startup Apps)

**Platform-specific URLs**:

| Platform | Microphone Privacy                                                           | Sound Input                                                  | Accessibility                                                                   | Login Items                                                         |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| macOS    | `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` | `x-apple.systempreferences:com.apple.preference.sound?input` | `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` | `x-apple.systempreferences:com.apple.LoginItems-Settings.extension` |
| Windows  | `ms-settings:privacy-microphone`                                             | `ms-settings:sound`                                          | N/A                                                                             | `ms-settings:startupapps`                                           |
| Linux    | Manual (no URL scheme)                                                       | Manual (e.g., pavucontrol)                                   | N/A                                                                             | N/A (XDG autostart entry, see `linuxAutostart.js`)                  |

**UI Component** (`MicPermissionWarning.tsx`):

- Shows platform-appropriate buttons and messages
- Linux only shows "Open Sound Settings" (no separate privacy settings)
- macOS/Windows show both sound and privacy buttons

### 11. Debug Mode

Enable with `--log-level=debug` or `OPENWHISPR_LOG_LEVEL=debug` (can be set in `.env`):

- Logs saved to platform-specific app data directory
- Comprehensive logging of audio pipeline
- FFmpeg path resolution details
- Audio level analysis
- Complete reasoning pipeline debugging with stage-by-stage logging

Packaged Windows builds keep logger output off stdout/stderr by default. Launch with
`--console-logs` to opt into terminal output independently of the configured log level.
Default INFO entries are not persisted in this mode; enabling debug logging retains them
in the existing log file without enabling terminal output.

### 12. Windows Push-to-Talk

Native Windows support for true push-to-talk functionality using low-level keyboard hooks:

**Architecture**:

- `resources/windows-key-listener.c`: Native C program using Windows `SetWindowsHookEx` for keyboard hooks
- `src/helpers/windowsKeyManager.js`: Node.js wrapper that spawns and manages the native binary
- Binary outputs `KEY_DOWN` and `KEY_UP` to stdout when target key is pressed/released

**Compound Hotkey Support**:

- Parses hotkey strings like `CommandOrControl+Shift+F11`
- Maps modifiers: `CommandOrControl`/`Ctrl` → VK_CONTROL, `Alt`/`Option` → VK_MENU, `Shift` → VK_SHIFT
- Verifies all required modifiers are held before emitting key events

**Binary Distribution**:

- Prebuilt binary downloaded from GitHub releases (`windows-key-listener-v*` tags)
- Download script: `scripts/download-windows-key-listener.js`
- CI workflow: `.github/workflows/build-windows-key-listener.yml`
- Fallback to tap mode if binary unavailable

**IPC Events**:

- `windows-key-listener:key-down`: Fired when hotkey pressed (start recording)
- `windows-key-listener:key-up`: Fired when hotkey released (stop recording)

### 13. Custom Dictionary

Improve transcription accuracy for specific words, names, or technical terms:

**How it works**:

- User adds words/phrases through Settings → Custom Dictionary
- Words stored as JSON array in localStorage (`customDictionary` key)
- On transcription, words are joined and passed as `prompt` parameter to Whisper
- Works with both local whisper.cpp and cloud OpenAI Whisper API

**Implementation**:

- `src/hooks/useSettings.ts`: Manages `customDictionary` state
- `src/components/SettingsPage.tsx`: UI for adding/removing dictionary words
- `src/helpers/audioManager.js`: Reads dictionary and adds to transcription options
- `src/helpers/whisperServer.js`: Includes dictionary as `prompt` in API request

**Whisper Prompt Parameter**:

- Whisper uses the prompt as context/hints for transcription
- Words in the prompt are more likely to be recognized correctly
- Useful for: uncommon names, technical jargon, brand names, domain-specific terms

### 14. GNOME Wayland Global Hotkeys

On GNOME Wayland, Electron's `globalShortcut` API doesn't work due to Wayland's security model. OpenWhispr uses native GNOME shortcuts:

**Architecture**:

1. `main.js` enables `GlobalShortcutsPortal` feature flag for Wayland
2. `hotkeyManager.js` detects GNOME + Wayland and initializes `GnomeShortcutManager`
3. `gnomeShortcut.js` creates D-Bus service at `com.openwhispr.App`
4. Shortcuts registered via `gsettings` as custom GNOME keybindings
5. GNOME triggers `dbus-send` command which calls the D-Bus `Toggle()` method

**Key Constants**:

- D-Bus service: `com.openwhispr.App`
- D-Bus path: `/com/openwhispr/App`
- gsettings path: `/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr/`

**IPC Integration**:

- `get-hotkey-mode-info`: Returns `{ isUsingGnome, isUsingHyprland, isUsingNativeShortcut }` to renderer
- UI hides activation mode selector when `isUsingNativeShortcut` is true
- Forces tap-to-talk mode (push-to-talk not supported)

**Hotkey Format Conversion**:

- Electron format: `F8`, `CommandOrControl+Shift+Space`
- GNOME format: `F8`, `<Control><Shift>space`
- Backtick (`) → `grave` in GNOME keysym format

### 15. Hyprland Wayland Global Hotkeys

On Hyprland (wlroots Wayland compositor), Electron's `globalShortcut` API and the `GlobalShortcutsPortal` feature don't work reliably. OpenWhispr uses native Hyprland keybindings:

**Architecture**:

1. `main.js` enables `GlobalShortcutsPortal` feature flag for Wayland (fallback)
2. `hotkeyManager.js` detects Hyprland + Wayland and initializes `HyprlandShortcutManager`
3. `hyprlandShortcut.js` creates D-Bus service at `com.openwhispr.App` (same as GNOME)
4. Shortcuts registered via `hyprctl keyword bind` (runtime keybinding)
5. Hyprland triggers `dbus-send` command which calls the D-Bus `Toggle()` method

**Detection**:

- Primary: `HYPRLAND_INSTANCE_SIGNATURE` environment variable (set by Hyprland)
- Fallback: `XDG_CURRENT_DESKTOP` contains "hyprland"

**Hotkey Format Conversion**:

- Electron format: `Control+Super`, `CommandOrControl+Shift+Space`
- Hyprland format: `CTRL, Super_L`, `CTRL SHIFT, space`
- Modifier-only combos (e.g., `Control+Super`) → `CTRL, Super_L`

**Bind/Unbind Commands**:

- Register: `hyprctl keyword bind "ALT, R, exec, dbus-send --session ..."`
- Unregister: `hyprctl keyword unbind "ALT, R"`
- Bindings are ephemeral (don't survive Hyprland restart) but re-registered on app startup

**Limitations**:

- Push-to-talk not supported (Hyprland `bind` fires a single exec, not key-down/key-up)
- Requires `hyprctl` on PATH (ships with Hyprland)

### 16. Meeting Detection (Event-Driven)

Detects meetings via three independent sources, orchestrated by `MeetingDetectionEngine`:

**Architecture**:

- `MeetingDetectionEngine` listens to events from `MeetingProcessDetector` and `AudioActivityDetector`
- `CalendarReminderScheduler` provides calendar context (imminent events, active meetings) from the shared `calendar_events` table, fed by the Google/Microsoft/Apple calendar managers
- All three sources feed into a unified notification pipeline

**Process Detection** (known meeting apps — Zoom, Teams, Webex, FaceTime):

- macOS: `systemPreferences.subscribeWorkspaceNotification` — zero CPU, instant detection
- Windows/Linux: `processListCache` shared polling (30s interval, `ps-list` npm)

**Microphone Detection** (unscheduled/browser meetings like Google Meet):

- macOS: `macos-mic-listener` binary — CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` property listeners with hot-plug support
- Windows: `windows-mic-listener.exe` — WASAPI `IAudioSessionManager2` session monitoring, `--exclude-pid` for self-mic exclusion
- Linux: `pactl subscribe` — PulseAudio source-output events
- All platforms: Graceful fallback to polling if native binary/command unavailable

**Calendar Reminders** (scheduled meetings):

- `CalendarReminderScheduler` fires `meetingDetectionEngine.handleCalendarReminder(event)` 1 minute before the scheduled start (`MEETING_REMINDER_LEAD_MS`) — no native OS notifications; all meeting prompts use the in-app overlay so they survive Focus/DND and screen-share notification muting
- Calendar-sourced prompts show a Join primary action when the event has a meeting link (`getMeetingJoinUrl` in `src/helpers/meetingJoinUrl.js`, shared with the renderer's Upcoming Meetings join button) — Join opens the link and starts the note

**UX Rules**:

- All prompts render in one always-on-top overlay window (`MeetingNotificationCard`), content-protected so it never appears in screen shares
- Prompt copy is derived in the renderer from `{ variant, event, joinUrl }` (`meetingNotification.*` i18n keys); variants: `detected` (mic evidence), `starting` (calendar event not yet started), `underway` (event in progress)
- Per-source notification prefs: `notifyCalendarReminders` gates calendar prompts, `notifyMeetingDetection` gates mic/process prompts
- During recording (tap-to-talk or push-to-talk): ALL notifications suppressed
- After recording: 2.5s cooldown before showing queued notifications
- Multiple signals coalesced: one overlay at a time; a newer prompt replaces the current one
- Calendar-aware: if an ongoing or imminent calendar event exists, the prompt shows the event name and links the note to the event
- Active meeting recording (meeting mode): all detections suppressed

**Binary Distribution**:

- macOS: Compiled from Swift source via `scripts/build-macos-mic-listener.js` during `compile:native`
- Windows: Prebuilt binary downloaded via `scripts/download-windows-mic-listener.js` during `prebuild:win`
- CI workflow: `.github/workflows/build-windows-mic-listener.yml` auto-builds on push to main

**Calendar Sync Resilience**:

- 10s socket timeout on all Google Calendar API requests
- Exponential backoff on consecutive failures: 2min → 4min → 8min → cap 30min
- Reset to normal 2min interval on any successful sync

### 17. Voice Assistant Hotkey

A dedicated global hotkey that starts a dictation whose transcript is sent straight to the voice assistant as a command — no wake word ("Hey [AgentName]") needed — and that always bypasses the cleanup model. Standalone commands never type at an unverified cursor: with auto-paste enabled and a writable caret verified at capture time (an opaque `caret` session in `selectionManager.js`, revalidated before pasting; terminals and fields with a live selection excluded — the native probes check the focused element's own selection state, closing the clipboard-capture blind spots), the completed answer pastes at that caret and the pill returns to idle. Otherwise the answer streams into a floating assistant panel attached to the dictation pill (there is no separate assistant window) and, with auto-paste enabled, is also copied to the clipboard for manual paste (the Copy button confirms for six seconds). The pill window is content-protected while the panel is open (the panel never appears in screen shares).

**Flow**:

1. Hotkey pressed → `voiceAgent` slot callback in `main.js` → `windowManager.sendToggleVoiceAgent()` → `toggle-voice-agent` IPC to the main window → recording capsule appears
2. `useAudioRecording.js` starts a recording with `audioManager.setVoiceAgentRequested(true)` (any other start resets it to `false`)
3. On transcription, `resolveReasoningRoute` consults `resolveDictationRouteKind()` (`src/helpers/dictationRouting.js`): a voice assistant recording always takes the agent route and never falls back to cleanup. The dictation agent's reachability only gates selection edits — a selection with the dictation agent unconfigured routes to the panel with the selected text quoted instead of editing in place
4. Standalone commands (no text selected) run through the chat pipeline (`src/components/dictation/AssistantPanel.tsx`): chat tools (notes search/create/update, calendar, web search, clipboard), RAG memory, and the custom dictionary injected into the system prompt. Conversations persist in the `agent_conversations` table and are browsable from the ControlPanel chat
5. Response delivery: a capture with `status: "editable"` (a focused writable non-terminal field with no selection) plus auto-paste banks a `deliverySessionId`; the completed answer is pasted via `paste-at-captured-target`, which revalidates the target and fails closed to the panel + clipboard on any change (`assistantResponseDelivery.ts`, `pasteAtCapturedTarget` in `selectionManager.js`). A follow-up spoken while the panel is already open stays panel-first. Cancelled or empty responses never paste and never touch the clipboard
6. Selection edits are unchanged: highlighted text goes through the `dictationAgent` scope and is safely replaced in place — it never opens the panel

**Storage & IPC**:

- Env var: `VOICE_AGENT_KEY` (persisted via `environment.js`), store key: `voiceAgentKey` (no default — user opt-in)
- IPC handlers: `update-voice-agent-hotkey`, `get-voice-agent-key`
- Hotkey slot: `voiceAgent` (tap-to-toggle; GNOME-native slot via `ToggleVoiceAgent` D-Bus method, KDE via KGlobalAccel, otherwise `globalShortcut`)

**Panel**:

- Esc collapses the panel; a Copy button copies the answer; a follow-up input takes typed questions. Esc while the command is still thinking cancels it; a command whose stream ends without content settles as `agentMode.chat.emptyResponse`
- Pressing the hotkey again while the panel is open records a follow-up into the same conversation

**UI**:

- Settings → Hotkeys → "Voice Assistant Hotkey" (with cross-slot conflict validation)
- Onboarding: optional step right after the dictation hotkey (activation) step
- Panel conversations run on the `chatIntelligence` scope (the chat's brain); in-place selection edits require the dictation agent (Settings → AI Models) and its `dictationAgent`/`dictationAgentVision` scopes

**Screen Context (opt-in)**:

When "Share screen context" is enabled (Settings → AI Models → Voice Assistant → Screen Context, store key `voiceAgentScreenContext`, default off), each voice-assistant recording start captures the display the cursor is on and attaches it to the request as a base64 JPEG (long edge ≤ 1568 px).

- Capture: `src/helpers/screenContextCapture.js` (main process; `screen.getCursorScreenPoint` + `desktopCapturer`). macOS requires the Screen Recording TCC permission (`useScreenRecordingPermission` hook + `PermissionCard` in `DictationAgentSettings`); Windows/Linux X11 need no permission; Linux Wayland is unsupported (capture silently skipped)
- Encoding: `encodeWithinBudget()` walks a JPEG quality ladder (82 → 70 → 55), then falls back to a 1024 px resize, keeping the payload under `MAX_ENCODED_BYTES` (1.5 MB ≈ 2.05M base64 chars, inside the API's 2.8M cap). Each rung re-encodes the original bitmap, so quality drops never compound. A screen that still won't fit is dropped
- Trigger: `useAudioRecording.js` calls `audioManager.beginScreenContextCapture()` at recording start (fire-and-forget); `consumeScreenContext()` (3s guard) is awaited when the request is built. The dictation overlay gets `setContentProtection` while the setting is on so the pill never appears in captures
- Routing: the press-time screenshot is re-decided against the model that will actually answer. On BYOK, it attaches only when the chat model's provider client is image-wired (`supportsImages` on the `InferenceProvider`) and the model has `supportsVision` in `modelRegistryData.json`; on OpenWhispr Cloud, attachment is pending API vision routing for the chat path. Dropping the image never fails the command
- Privacy: screenshots live only in renderer memory for one request — never written to disk, stored in history, or logged (loggers emit `hasScreenContext` booleans only)
- IPC: `capture-screen-context`, `check-screen-recording-access`, `request-screen-recording-access`, `open-screen-recording-settings`, `screen-context-set-enabled`

**Tests**: `test/helpers/dictationRouting.test.js`, `test/helpers/screenContextCapture.test.js` (run with `node --test`)

### 18. Meeting Transcription: Echo, Duplicate, and Segment Pipeline

Live meeting transcription runs two streams (mic + system-audio tap) and must keep the remote party's voice, as heard through the local speakers, out of the mic transcript. The policy lives in pure, unit-tested seams so it can be tuned without touching the IPC plumbing:

- **Audio layer**: `meetingEchoLeakDetector.js` correlates mic chunks against recent system audio; `meetingMicGate.js` turns chunk RMS/peak (+ a "system speaking" lookback) into a `send` / `zero` / `skip` verdict that `ipcHandlers.js` applies in `dispatchMeetingAudioBuffer` (streaming) and `transcribeLocalMeetingChunk` (local)
- **Text layer**: `meetingMicHoldback.js` decides whether a mic final is risky (held back), a duplicate of recent system text (dropped), or racing an arriving system final (retracted); the `ipcHandlers.js` adapters (`shouldSkipDuplicateMicSegment`, `hasRiskyMicDuplicateProfile`, `removeRacingMicEntriesFor`, `removePendingMicFinalsFor`) apply the results to closure state and emit `meeting-transcription-segment` events (`partial` / `final` / `retract`)
- **Renderer**: `src/stores/meetingSegmentReducer.ts` is the pure `(state, event, deps) → reduction` transition for those events (timestamp-sorted insert, retract by exact match, per-source partial slots); `meetingRecordingStore.ts` supplies `mintSegmentId` / `decorateFinal` (speaker identifications, provisional speaker, locks — must not write to the store) and applies the reduction. Tests: `test/stores/meetingSegmentReducer.test.js`, `test/stores/meetingRecordingStoreImports.test.js`
- **Regression pins**: BYOK `session.update` payload and the disconnect-commit callback (`test/helpers/openaiRealtimeStreaming.test.js`, `tinfoilRealtimeStreaming.test.js`), token-endpoint wire bodies (`test/helpers/realtimeTokenProviders.test.js`). Tests named `characterization: …` pin known oddities on purpose — flip them deliberately when changing policy
- **Fixtures**: `test/helpers/harness/pcmFixtures.js` — deterministic 24 kHz PCM generators (`makeSine`, `makeSeededNoise`, `mix`, `delayBy`, `toInt16Buffer`, `chunkBuffer`, …) used by the gate and echo-detector tests

## Development Guidelines

### Internationalization (i18n) — REQUIRED

All user-facing strings **must** use the i18n system. Never hardcode UI text in components.

**Setup**: react-i18next (v15) with i18next (v25). Translation files in `src/locales/{lang}/translation.json`.

**Supported languages**: en, es, fr, de, pt, it, ru, zh-CN, zh-TW

**How to use**:

```tsx
import { useTranslation } from "react-i18next";

const { t } = useTranslation();
// Simple: t("notes.list.title")
// With interpolation: t("notes.upload.using", { model: "Whisper" })
```

**Rules**:

1. Every new UI string must have a translation key in `en/translation.json` and all other language files
2. Use `useTranslation()` hook in components and hooks
3. Keep `{{variable}}` interpolation syntax for dynamic values
4. Do NOT translate: brand names (OpenWhispr, Pro), technical terms (Markdown, Signal ID), format names (MP3, WAV), AI system prompts
5. Group keys by feature area (e.g., `notes.editor.*`, `referral.toasts.*`)

### Image and Icon Assets — REQUIRED

Raster UI assets live in `src/assets/` (onboarding ones are named `onboarding-*`). Vector provider/brand marks live in `src/assets/icons/`.

**Rules**:

1. **Always `import` the asset**; never write a literal path like `/assets/foo.webp`. Packaged builds load the renderer from a `file://` origin, so root-relative paths resolve to nothing. Importing lets Vite fingerprint the file and rewrite the URL:

   ```tsx
   import microphoneIcon from "@/assets/onboarding-permission-microphone.webp";
   <img src={microphoneIcon} ... />;
   ```

2. **WebP, lossless** for UI art with hard edges or alpha — `cwebp -lossless -z 9 -alpha_q 100 in.png -o out.webp` (roughly 40–55% smaller than PNG). Reserve lossy for photographic art.
3. **Author at 2x the CSS slot** and no larger (a 44px slot gets an 88px asset). Retina-sharp without paying for pixels that get downscaled away.
4. **Bake rounded corners into the artwork as transparency** rather than adding a CSS `rounded-*` on the `<img>` — CSS rounding on top of already-rounded art clips the corners twice.
5. **Decorative images take `alt=""` plus `aria-hidden="true"`.** Most icons sit beside a visible label that already names them (e.g. the permission rows), so a descriptive `alt` makes screen readers announce the same thing twice. Only write real `alt` text when the image is the _only_ source of that information.
6. **Always set explicit `width`/`height`** matching the CSS size, to reserve layout space before decode. Add `decoding="async"` and `draggable={false}` (in Electron a draggable image can be dragged out of the window).
7. **Assets under 4 KB are inlined** by Vite as base64 data URIs, so they will not appear in `dist/assets/`. Grep the JS chunks for `data:image/webp;base64,` before concluding an asset went missing.

### Adding New Features

1. **New IPC Channel**: Add to both ipcHandlers.js and preload.js
2. **New Setting**: Update useSettings.ts and SettingsPage.tsx
3. **New UI Component**: Follow shadcn/ui patterns in src/components/ui
4. **New Manager**: Create in src/helpers/, initialize in main.js
5. **New UI Strings**: Add translation keys to all 10 language files (see i18n section above)
6. **New Sidecar Binary**: Add download script in `scripts/`, add to `prebuild*` scripts in package.json, add manager in `src/helpers/`, initialize in `main.js`. Spawn the child with `detached: process.platform !== "win32"` so it has its own process group on Unix. Right after spawn call `sidecarPidFile.write(name, child.pid)` and on `close` call `sidecarPidFile.clear(name)`. Add the binary fragment to `EXPECTED_BINARY_FRAGMENTS` in `sidecarReaper.js`. Register a stop function via `sidecarRegistry.register(name, () => manager.stop())` in `registerSidecars()` — that single registration replaces the old `will-quit` line.

### Testing Checklist

- [ ] Test both local and cloud processing modes
- [ ] Verify hotkey works globally
- [ ] Check clipboard pasting on all platforms
- [ ] Test with different audio input devices
- [ ] Verify whisper.cpp binary detection
- [ ] Test all Whisper models
- [ ] Check agent naming functionality
- [ ] Test custom dictionary with uncommon words
- [ ] Verify Windows Push-to-Talk with compound hotkeys
- [ ] Test GNOME Wayland hotkeys (if on GNOME + Wayland)
- [ ] Test Hyprland Wayland hotkeys (if on Hyprland + Wayland)
- [ ] Verify activation mode selector is hidden on GNOME Wayland and Hyprland Wayland
- [ ] Verify meeting detection works with event-driven mode (check debug logs for "event-driven")
- [ ] Test meeting notification suppression during recording
- [ ] Test post-recording cooldown (notifications shouldn't flash immediately)
- [ ] Create a note about "quarterly revenue projections", search via agent for "financial forecast" — should match semantically
- [ ] Verify Qdrant starts on app launch (check debug logs for "qdrant started successfully")
- [ ] Kill Qdrant process manually — verify FTS5 keyword search still works as fallback

### Common Issues and Solutions

1. **No Audio Detected**:
   - Check FFmpeg path resolution
   - Verify microphone permissions
   - Check audio levels in debug logs

2. **Transcription Fails**:
   - Ensure whisper.cpp binary is available
   - Check model is downloaded
   - Check temporary file creation
   - Verify FFmpeg is executable

3. **Clipboard Not Working**:
   - macOS: Check accessibility permissions (required for AppleScript paste)
   - Linux: Native `linux-fast-paste` binary (XTest) is tried first, works for X11 and XWayland apps
     - X11: xdotool fallback if native binary unavailable
     - Hyprland Wayland: wtype → sendshortcut → uinput/ydotool
     - Sway/wlroots Wayland: wtype → uinput/ydotool
     - GNOME/KDE Wayland: portal keysyms → uinput/ydotool
     - Physical Wayland fallbacks use Shift+Insert to avoid layout-sensitive KEY_V
   - Windows: PowerShell SendKeys (built-in) or nircmd.exe (bundled)

4. **Build Issues**:
   - Use `npm run pack` for unsigned builds (CSC_IDENTITY_AUTO_DISCOVERY=false)
   - Signing requires Apple Developer account
   - ASAR unpacking needed for FFmpeg
   - Run `npm run download:whisper-cpp` before packaging (current platform)
   - Use `npm run download:whisper-cpp:all` for multi-platform packaging
   - afterSign.js automatically skips signing when CSC_IDENTITY_AUTO_DISCOVERY=false
   - **Lockfile**: Always use Node 24 when running `npm install` (matches CI). If your local Node version differs, use `nvm exec 24 npm install`. Running `npm install` with a different major version will produce an incompatible `package-lock.json` that breaks `npm ci` in CI.

5. **Windows Push-to-Talk Binary**:
   - Prebuilt binary downloaded automatically on Windows during build
   - If download fails, push-to-talk falls back to tap mode
   - To compile locally: install Visual Studio Build Tools or MinGW-w64
   - CI workflow (`.github/workflows/build-windows-key-listener.yml`) auto-builds on push to main

6. **Meeting Detection Not Working**:
   - Check debug logs for "event-driven" vs "polling" mode
   - macOS: Verify `macos-mic-listener` binary exists in `resources/bin/` (compiled during `npm run compile:native`)
   - Windows: Verify `windows-mic-listener.exe` exists in `resources/bin/` (downloaded during `prebuild:win`)
   - Linux: Verify `pactl` is installed (`pulseaudio-utils` or `pipewire-pulse` package)
   - If event-driven binary is missing, detection falls back to polling automatically

7. **Local Semantic Search Not Working**:
   - Qdrant binary should be in `resources/bin/qdrant-{platform}-{arch}` (auto-downloaded during `predev`/`prebuild`)
   - Embedding model should be in `~/.cache/openwhispr/embedding-models/all-MiniLM-L6-v2/model.onnx` (auto-downloaded on first app launch)
   - Run `npm run download:qdrant` and `npm run download:embedding-model` manually if missing
   - Check debug logs for "qdrant" entries (port, health check, errors)
   - If Qdrant fails to start, search still works via FTS5 keyword fallback
   - Semantic search is only available through the AI agent's `search_notes` tool, not the manual search UI

### Platform-Specific Notes

**macOS**:

- Requires accessibility permissions for clipboard (auto-paste)
- Requires microphone permission (prompted by system)
- Uses AppleScript for reliable pasting
- Notarization needed for distribution
- Shows in dock with indicator dot when running (LSUIElement: false)
- whisper.cpp bundled for both arm64 and x64
- System settings accessible via `x-apple.systempreferences:` URL scheme
- **Launch at login**: `setLoginItemSettings()`, which routes through `SMAppService` on macOS 13+. `openAsHidden` is deprecated and does nothing, so `wasOpenedAtLogin` is what sends a login launch to the tray. An item can register and still report `status: "requires-approval"` until the user allows it under System Settings → General → Login Items

**Windows**:

- No special accessibility permissions needed
- Microphone privacy settings at `ms-settings:privacy-microphone`
- Sound settings at `ms-settings:sound`
- NSIS installer for distribution
- whisper.cpp bundled for x64
- **Launch at login**: `HKCU\...\Run` entry written by Electron, named after the AppUserModelId, carrying `--hidden` so a login launch goes to the tray
  - Read the state from `executableWillLaunchAtLogin`; `openAtLogin` misses a startup app disabled from Task Manager or Settings
  - `resources/nsis/installer.nsh` removes the `Run` and `StartupApproved\Run` values on uninstall (but not on update), which Electron itself never cleans up
- **Push-to-Talk**: Native key listener binary (`windows-key-listener.exe`) enables true push-to-talk
  - Uses Windows Low-Level Keyboard Hook (`WH_KEYBOARD_LL`)
  - Supports compound hotkeys (e.g., `Ctrl+Shift+F11`)
  - Prebuilt binary auto-downloaded from GitHub releases
  - Falls back to tap mode if unavailable

**Linux**:

- Multiple package manager support
- Standard XDG directories
- AppImage for distribution
- whisper.cpp bundled for x64
- No standardized URL scheme for system settings (user must open manually)
- Privacy settings button hidden in UI (not applicable on Linux)
- Recommend `pavucontrol` for audio device management
- **Launch at login**: XDG autostart entry at `~/.config/autostart/open-whispr.desktop` (see `linuxAutostart.js`), since Electron's `setLoginItemSettings()` does nothing on Linux
  - Disabling it from GNOME Tweaks or KDE's autostart editor is reflected in the Settings toggle
  - "Start minimized" is handled app-side by the `startMinimized` setting, not by the desktop entry
- **Clipboard paste tools** (at least one required for auto-paste):
  - **X11**: `xdotool` (recommended)
  - **Hyprland Wayland**: `wtype`, then `hyprctl` sendshortcut (avoids the sendshortcut stuck-modifier bug when wtype is installed)
  - **Sway/wlroots Wayland**: `wtype` (requires the virtual keyboard protocol)
  - **GNOME/KDE Wayland**: RemoteDesktop portal keysyms, then uinput/ydotool
  - **Wayland physical fallback**: Shift+Insert avoids layout-sensitive KEY_V; `ydotool` requires the `ydotoold` daemon
  - Terminal detection: Auto-detects terminal emulators and uses Ctrl+Shift+V
  - Fallback: Text copied to clipboard with manual paste instructions
- **GNOME Wayland global hotkeys**:
  - Uses native GNOME shortcuts via D-Bus and gsettings (no special permissions needed)
  - Hotkeys visible in GNOME Settings → Keyboard → Shortcuts → Custom
  - Default fallback: `F8` when `Control+Super` cannot be registered
  - Push-to-talk unavailable (GNOME shortcuts only fire single toggle event)
  - Falls back to X11/globalShortcut if GNOME integration fails
  - D-Bus transport: `@homebridge/dbus-native` (pure JavaScript, no native addons)

## Code Style and Conventions

- Use TypeScript for new React components
- Follow existing patterns in helpers/
- Descriptive error messages for users
- Comprehensive debug logging
- Clean up resources (files, listeners)
- Handle edge cases gracefully

## Performance Considerations

- Whisper model size vs speed tradeoff
- Audio blob size limits for IPC (10MB)
- Temporary file cleanup
- Memory usage with large models
- Process timeout protection (5 minutes)
- Meeting detection uses event-driven OS APIs (near-zero CPU) with polling fallback
- Process list cache shared between detectors to avoid duplicate `tasklist`/`pgrep` calls
- Calendar sync (Google/Microsoft) uses exponential backoff to avoid hammering APIs on network failures

## Security Considerations

- API keys and enterprise cloud creds (12 secrets total) encrypted at rest via Electron `safeStorage` → OS keychain (Keychain / DPAPI / libsecret), stored as per-key files in `userData/secure-keys/`. Linux without a keyring falls back to plaintext (Electron default). Closed in #629.
- Context isolation enabled
- No remote code execution
- Sanitized file paths
- Limited IPC surface area

## Future Enhancements to Consider

- Streaming transcription support
- Custom wake word detection
- ~~Multi-language UI~~ (implemented — 9 languages via react-i18next)
- Cloud model selection
- Batch transcription
- Export formats beyond clipboard
