# Local Whisper Setup

OpenWhispr supports local speech-to-text processing using whisper.cpp. This keeps your audio completely private—nothing leaves your device.

## Quick Start

1. Open the **Control Panel** (right-click tray icon or click the overlay)
2. Go to **Settings** → **Speech to Text Processing**
3. Enable **Use Local Whisper**
4. Select a model (recommended: `base`)
5. Click **Save**

The first transcription will download the model automatically.

## Model Selection

| Model  | Size  | Speed   | Quality | RAM   | Best For         |
| ------ | ----- | ------- | ------- | ----- | ---------------- |
| tiny   | 75MB  | Fastest | Basic   | ~1GB  | Quick notes      |
| base   | 142MB | Fast    | Good    | ~1GB  | **Recommended**  |
| small  | 466MB | Medium  | Better  | ~2GB  | Professional use |
| medium | 1.5GB | Slow    | High    | ~5GB  | High accuracy    |
| large  | 3GB   | Slowest | Best    | ~10GB | Maximum quality  |
| turbo  | 1.6GB | Fast    | High    | ~6GB  | Fast + accurate  |

## GPU Acceleration

Local Whisper can run on your GPU for much faster transcription:

- **macOS**: Metal acceleration is built in — no setup needed on Apple Silicon
- **NVIDIA (Windows/Linux)**: one-click CUDA runtime download from the GPU card in the transcription model picker
- **AMD / Intel (Windows/Linux)**: one-click Vulkan runtime download from the same GPU card — covers Radeon and Arc/integrated GPUs

The GPU runtime is downloaded on demand with SHA-256-verified checksums. If the GPU server crashes or fails to start (unsupported GPU, out of VRAM), OpenWhispr automatically falls back to CPU transcription and shows a notice — dictation keeps working.

## How It Works

OpenWhispr uses whisper.cpp, a high-performance C++ implementation of OpenAI's Whisper model:

1. whisper.cpp binary is bundled with the app (or uses system installation as fallback)
2. GGML models are downloaded on first use to `~/.cache/openwhispr/whisper-models/`
3. Audio is processed locally using FFmpeg (bundled with the app)

## Requirements

- **Disk Space**: 75MB–3GB depending on model
- **RAM**: 1GB–10GB depending on model
- **No additional dependencies required** - whisper.cpp is bundled in packaged builds

## Running From Source

If you're running OpenWhispr locally from a git checkout (not a packaged app), download the whisper.cpp binary for your current platform:

```bash
npm run download:whisper-cpp
```

This puts the binary in `resources/bin/`. For multi-platform packaging from a single machine, use:

```bash
npm run download:whisper-cpp:all
```

## File Locations

| Data   | macOS                                 | Windows                                           | Linux                                 |
| ------ | ------------------------------------- | ------------------------------------------------- | ------------------------------------- |
| Models | `~/.cache/openwhispr/whisper-models/` | `%USERPROFILE%\.cache\openwhispr\whisper-models\` | `~/.cache/openwhispr/whisper-models/` |

## Troubleshooting

### "Not Found" Status

1. Click **Recheck Installation** in Control Panel
2. Restart the app
3. If bundled binary fails, install via package manager:
   - macOS: `brew install whisper-cpp`
   - Linux: Build from source at https://github.com/ggml-org/whisper.cpp

### Transcription Fails

1. Verify microphone permissions
2. Try a smaller model (tiny/base)
3. Check disk space for model downloads

### Slow Performance

1. Use smaller models (tiny or base)
2. Close resource-intensive apps
3. Consider using cloud mode for large files

## Privacy Comparison

| Mode  | Audio Leaves Device | Internet Required       | Cost      |
| ----- | ------------------- | ----------------------- | --------- |
| Local | No                  | Only for model download | Free      |
| Cloud | Yes (to OpenAI)     | Yes                     | API usage |
