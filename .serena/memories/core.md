# OpenWhispr — Core Memory

Electron desktop dictation app (speech-to-text). Windows-primary dev environment (`C:\dev\openwhispr`), Node 24 required (`.nvmrc` pinned — never regenerate lockfile with different major).

## Entry Points
- `main.js` — Electron main process, initializes all managers
- `preload.js` — IPC bridge (context isolation on); every new IPC channel must be registered in BOTH `src/helpers/ipcHandlers.js` AND `preload.js`
- `src/main.jsx` → React renderer (Vite, URL-based routing for two windows)
- `src/AppRouter.jsx` — routes between main overlay and control panel

## Key Domains
- Transcription engines & models: `mem:tech_stack`
- Build/dev commands: `mem:suggested_commands`
- Code conventions (i18n, IPC, secrets, sidecar binaries): `mem:conventions`
- Task completion checklist: `mem:task_completion`

## Two-Window Architecture
- **Main overlay** (always-on-top, draggable): dictation trigger UI
- **Control panel**: settings, history, model management
Both are the same React app — differentiated by URL path.

## Process Architecture
- Main process: Electron + IPC + SQLite
- Renderer: React 19 + Vite (context isolation)
- ONNX utility process: lazy-spawned worker (`src/helpers/onnxWorkerClient.js` → `src/workers/onnxWorker.js`) for all `onnxruntime-node` inference; respawns on crash
- Sidecar binaries: Qdrant (vector DB), llama.cpp server, whisper.cpp, sherpa-onnx — managed via `sidecarRegistry.js`

## Critical Non-Obvious Facts
- Secrets (12 total: 7 BYOK API keys + 5 enterprise creds) are encrypted via Electron `safeStorage` → per-key files in `userData/secure-keys/`. Non-secret env vars go to `.env` via `saveAllKeysToEnvFile()`.
- AI model registry single source of truth: `src/models/modelRegistryData.json`
- 4 inference scopes (`dictationCleanup`, `dictationAgent`, `noteFormatting`, `chatIntelligence`) each have independent provider/model config — see `src/config/inferenceScopes.ts`
- 8 inference providers: `anthropic`, `enterprise`, `gemini`, `groq`, `lan`, `local`, `openai`, `openwhispr` — registry at `src/services/ai/inferenceProviders/index.ts`
- Anthropic API calls route through IPC (main process) to avoid renderer CORS; all other providers called directly from renderer
