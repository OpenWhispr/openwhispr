# Tech Stack

## Core
- Electron 41, React 19, TypeScript, Tailwind CSS v4, Vite, Node 24
- better-sqlite3 (local transcription history), shadcn/ui + Radix primitives
- react-i18next v15 / i18next v25 (9 languages; `src/locales/{lang}/translation.json`)

## Transcription Engines
| Engine | Binary location | Model cache |
|--------|----------------|-------------|
| whisper.cpp (local) | `resources/bin/whisper-cpp-{platform}-{arch}` | `~/.cache/openwhispr/whisper-models/` |
| NVIDIA Parakeet (sherpa-onnx) | `resources/bin/sherpa-onnx-{platform}-{arch}` | `~/.cache/openwhispr/parakeet-models/` |
| OpenAI Whisper API | cloud | — |
| Corti (EU healthcare) | cloud/enterprise | — |
| AssemblyAI, Deepgram | cloud streaming | — |

`LOCAL_TRANSCRIPTION_PROVIDER` env var selects engine (`nvidia` = Parakeet).

## AI Inference
- OpenAI: Responses API (`/v1/responses`), NOT Chat Completions — `input` array not `messages`
- Anthropic: via IPC bridge (CORS workaround), model IDs use alias format (e.g., `claude-sonnet-4-6`)
- Local: llama.cpp server (`src/helpers/llamaServer.js`), GGUF models from HuggingFace
- Model registry: `src/models/modelRegistryData.json` (single source of truth)

## Vector/Semantic Search
- Qdrant sidecar (Rust binary, ports 6333–6350), managed by `src/helpers/qdrantManager.js`
- Embeddings: all-MiniLM-L6-v2 via ONNX Runtime, 384-dim, cosine distance
- Hybrid search: FTS5 + Qdrant → Reciprocal Rank Fusion (K=60, 0.3 cosine threshold)
- Embedding model cache: `~/.cache/openwhispr/embedding-models/all-MiniLM-L6-v2/`

## Audio Pipeline
MediaRecorder (renderer) → Blob → ArrayBuffer → IPC → temp file → whisper.cpp → result → IPC → renderer → clipboard

## Native Binaries (platform-specific)
- Windows: `windows-key-listener.exe`, `windows-mic-listener.exe`, `windows-system-audio-helper.exe`, `nircmd.exe`, `windows-fast-paste.exe`
- macOS: compiled from Swift/C source during `compile:native`
- Linux: compiled from C source during `compile:native`; clipboard uses `xdotool`/`wtype`/`ydotool` chain

## Database
SQLite via better-sqlite3. Schema: `transcriptions` table (id, timestamp, original_text, processed_text, is_processed, processing_method, agent_name, error).
