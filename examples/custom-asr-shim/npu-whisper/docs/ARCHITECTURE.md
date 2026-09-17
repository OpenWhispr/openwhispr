# Architecture: NPU-Integrated Transcription for OpenWhispr

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER INTERACTION                             │
│                                                                      │
│  Press Ctrl+Win → speak → press Ctrl+Win to stop                    │
│                                                                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ Hotkey
┌──────────────────────────────▼──────────────────────────────────────┐
│                    OPENWHISPR (Electron App)                         │
│                                                                      │
│  Renderer Process (React)             Main Process (Node.js)         │
│  ┌────────────────────────┐          ┌──────────────────────────┐   │
│  │ MediaRecorder API      │   IPC    │ audioManager.js          │   │
│  │ audio/webm;codecs=opus │─────────→│   → processAudio()       │   │
│  │                        │          │   → isSelfHosted?         │   │
│  │ Settings Store         │          │   → POST /audio/tran...  │   │
│  │ transcriptionMode:     │          │                          │   │
│  │   "self-hosted"        │          │ fetch() → FormData        │   │
│  │ remoteUrl:             │          │   file: blob (WebM)      │   │
│  │   localhost:8765       │          │   model + language       │   │
│  └────────────────────────┘          └──────────┬───────────────┘   │
│                                                 │                    │
│  TextEditMonitor ←─── paste completed ──────────┘                    │
│  AutoLearn (nircmd.exe sendkey Ctrl+Shift+V)                        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                               │ HTTP POST
                               │ multipart/form-data
                               │ localhost:8765/audio/transcriptions
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   NPU WHISPER SHIM (Python)                           │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │ ThreadingHTTPServer (localhost:8765)                        │     │
│  │                                                              │     │
│  │  do_POST /audio/transcriptions                               │     │
│  │    │                                                         │     │
│  │    ├─ parse_multipart_form()   ← HTTP body → fields + blob │     │
│  │    │                                                         │     │
│  │    ├─ convert_audio()          ← ffmpeg → 16kHz mono WAV   │     │
│  │    │   FFMPEG = bundled in OpenWhispr's app.asar.unpacked   │     │
│  │    │                                                         │     │
│  │    ├─ load_audio_float()       ← numpy → float32 list      │     │
│  │    │   Scans WAV chunks for "data" marker                    │     │
│  │    │                                                         │     │
│  │    ├─ _run_inference()                                       │     │
│  │    │   │                                                     │     │
│  │    │   ├─ Save diagnostic .f32 dump                          │     │
│  │    │   ├─ get_pipeline() → cached OvalGenAI WhisperPipeline │     │
│  │    │   ├─ pipe.generate(audio, max_new_tokens, language)    │     │
│  │    │   └─ Return text string                                 │     │
│  │    │                                                         │     │
│  │    └─ _send_json(200, {"text": "..."})                       │     │
│  │                                                              │     │
│  │  do_GET /health → {"status":"ok"}                            │     │
│  │  do_GET /dumps  → List saved .f32 diagnostics                │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  Pipeline Manager (thread-safe singleton)                            │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │ _pipeline_lock: threading.Lock()                             │     │
│  │ get_pipeline() → lazy init + cache                           │     │
│  │   └─ WhisperPipeline(model_dir, "NPU", CACHE_DIR=cache)     │     │
│  │      First load: ~250s (compile) → Cached: ~4s              │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                      │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ OpenVINO Runtime
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       INTEL NPU HARDWARE                              │
│                                                                      │
│  Intel AI Boost NPU                          │
│  Driver: 4.65+                            │
│                                                                      │
│  openvino_encoder_model.xml/.bin  →  Encoder on NPU                 │
│  openvino_decoder_model.xml/.bin  →  Decoder on NPU                  │
│                                                                      │
│  Caching:                                                            │
│    UMD driver cache (automatic, default)                             │
│    OpenVINO CACHE_DIR (explicit, set in pipeline config)            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Data Flow (One Transcription Request)

```
 1. User presses Ctrl+Win (hotkey)
 2. MediaRecorder starts, capturing audio as Opus/WebM
 3. User presses Ctrl+Win again
 4. MediaRecorder stops → Blob produced
 5. Renderer wraps blob in FormData:
      file: blob, "audio.webm", "audio/webm;codecs=opus"
      model: "whisper-large-v3-turbo-fp16-ov-npu"
      language: "en"
 6. fetch() POST to http://localhost:8765/audio/transcriptions
 7. Shim receives multipart request
 8. Multipart parser extracts: file bytes + field values
 9. FFmpeg converts Opus/WebM → 16kHz mono PCM WAV
10. Numpy loads WAV → float32 list (~16000 samples per second)
11. WhisperPipeline.generate() runs on NPU:
    - Mel spectrogram extraction (CPU)
    - Encoder forward pass (NPU)
    - Decoder autoregressive generation (NPU)
    - Text output
12. Shim returns JSON: {"text": "transcribed text", "object": "transcription"}
13. OpenWhispr parses response, extracts .text
14. windows-fast-paste.exe pastes text at cursor
15. AutoLearn monitors text for corrections
```

## Key Design Decisions

### Why Python Instead of C++

| Factor | Python | C++ |
|--------|--------|-----|
| NPU inference time | 1-10s (dominates latency) | 1-10s (same) |
| HTTP overhead | ~1-5ms | ~0.1-0.5ms |
| Development speed | Hours | Days |
| Dependency management | pip | CMake + system libs |
| Windows deployment | Simple | Complex (MSVC, DLLs) |

NPU inference time accounts for >95% of total latency, making Python's HTTP overhead negligible. Python was chosen for rapid development and simpler deployment.

### Why Self-Hosted Mode (Not Direct Integration)

| Approach | Effort | Maintenance |
|----------|--------|-------------|
| Modify OpenWhispr source | Days, app.asar patching | Breaks on updates |
| **Self-hosted shim** | Hours, standalone | Survives updates |
| CUDA build replacement | Days, ABI issues | Needs rebuild per version |

The self-hosted shim approach requires zero changes to OpenWhispr, using its existing "Self-hosted server" provider. This makes it resilient to app updates.

### Why whisper-large-v3-turbo (Not large-v3)

| Model | Size | NPU Fit | OV 2026 Compatible |
|-------|------|---------|-------------------|
| large-v3-turbo FP16 | 1.55 GB | Yes | Yes (movensys export) |
| large-v3 INT8 | ~1.6 GB | Maybe | No pre-converted model |
| large-v3 FP16 | 3.1 GB | Borderline | OpenVINO org export (old format) |

The `movensys/whisper-large-v3-turbo-fp16-ov-npu` model is the only one tested and confirmed working with OpenVINO 2026 NPU. Older models use `--disable-stateful` exports that lack the required `beam_idx` input.

## NPU Static Shape Constraint

### The `beam_idx` Compatibility Issue

OpenVINO 2026 NPU plugin applies a `StatefulToStateless` transform requiring the decoder model to have a `beam_idx` input tensor. Models exported with:
- **OV 2026 + `optimum-intel >= 1.20`**: Single-file stateful decoder with `beam_idx` — COMPATIBLE
- **OV 2025.x or `--disable-stateful`**: Two-file decoder without `beam_idx` — INCOMPATIBLE

### The `initial_prompt` Incompatibility

Passing `initial_prompt` to `WhisperPipeline.generate()` prepends context tokens to the decoder input sequence. On NPU, the compiled model uses static decoder input shapes. The added prompt tokens shift the sequence length, causing `Check '*roi_end <= *max_dim'` — the Region of Interest end coordinate exceeds the statically-allocated tensor dimension.

This is a fundamental limitation of NPU static shapes. The fix is to omit `initial_prompt` from the generation parameters.

## Process Lifecycle

```
Windows Login
  └─ Startup folder shortcut → VBS → batch file
      └─ python npu-whisper-shim.py
          ├─ main()
          │   ├─ validate environment
          │   ├─ find ffmpeg (bundled or PATH)
          │   ├─ get_pipeline() → pre-warm (compile or load cache)
          │   └─ ThreadingHTTPServer.serve_forever()
          │
          └─ Request handler (per-request thread)
              ├─ do_POST /audio/transcriptions
              │   ├─ parse multipart
              │   ├─ ffmpeg convert
              │   ├─ WAV load
              │   └─ inference
              └─ do_GET /health → status check

OpenWhispr App Start
  └─ Reads self-hosted config from localStorage
  └─ Routes transcriptions to localhost:8765

OpenWhispr App Close
  └─ (No action needed — shim runs independently)
```

## Error Recovery

| Error | Recovery Strategy |
|-------|------------------|
| NPU tensor error (`roi_end <= max_dim`) | Omit `initial_prompt` from gen_args (fixed in code) |
| FFmpeg conversion failure | Returns HTTP 500 with error detail |
| Pipeline not loaded | Lazy-load on first request (cached thereafter) |
| NPU driver unavailable | Returns clear error; fallback to DGPU via CUDA |
| Port conflict | Uses fixed port 8765; can be changed via `WHISPER_PORT` env var |
| Process crash | Windows startup shortcut relaunches at next login |

## Security

- All audio processing is local — nothing leaves the device
- Shim binds to `127.0.0.1` only — no network exposure
- No authentication required (localhost-only access)
- Multipart body limit: 25 MB
- Audio via HTTP is ephemeral (temp files cleaned after each request)
