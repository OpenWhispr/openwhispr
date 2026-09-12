# Environment & Configuration Reference

## OpenWhispr Settings (`.env`)

File: `%APPDATA%\open-whispr\.env`

| Variable | Purpose |
|----------|---------|
| `DICTATION_KEY` | Hotkey for dictation (recommend `Control+Super` to avoid paste conflict) |
| `ACTIVATION_MODE` | `tap` or `hold` |
| `WHISPER_CUDA_ENABLED` | GPU acceleration for local whisper mode |
| `LOCAL_WHISPER_MODEL` | Model for local whisper mode |
| `OPENWHISPR_LOG_LEVEL` | `debug` for verbose logging |

## OpenWhispr Self-Hosted Settings

Configure in **Settings -> Speech to Text -> Self-hosted server**:

| Setting | Recommended Value |
|---------|------------------|
| Transcription mode | Self-hosted |
| Server URL | `http://localhost:8765` |
| Model | `whisper-large-v3-turbo-fp16-ov-npu` |

## NPU Shim Environment Variables

Set before launching `npu-whisper-shim.py`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `WHISPER_DEVICE` | `NPU` | OpenVINO device: `NPU`, `GPU.0`, `CPU` |
| `WHISPER_PORT` | `8765` | HTTP port |

## CUDA Toolkit

| Detail | Value |
|--------|-------|
| `CUDA_PATH` | Should point to CUDA Toolkit (e.g., `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12`) |

## OpenVINO GenAI

| Package | Required Version |
|---------|-----------------|
| `openvino` | 2026.2.1 |
| `openvino-genai` | 2026.2.1 |
| `openvino-tokenizers` | 2026.2.1 |

All three must match — version mismatch causes ABI crash at startup.

## NPU Driver

| Detail | Value |
|--------|-------|
| Device | Intel AI Boost NPU |
| Driver version | 4.65+ (latest from Windows Update or Intel DSA) |
| NPU cache | UMD driver-level (automatic) + OpenVINO `CACHE_DIR` |
| OpenVINO cache | `%APPDATA%\open-whispr\models\npu-whisper\npu_cache\` |

## File Paths (relative to `%APPDATA%\open-whispr\`)

| Path | Purpose |
|------|---------|
| `models\npu-whisper\npu-whisper-shim.py` | Main server |
| `models\npu-whisper\launch-npu-shim.bat` | Production launcher |
| `models\npu-whisper\launch-npu-shim-hidden.vbs` | VBS wrapper for silent startup |
| `models\npu-whisper\setup-npu-auto-start.ps1` | Scheduled task setup (admin) |
| `models\npu-whisper\whisper-large-v3-turbo-fp16-ov-npu\` | Model files |
| `models\npu-whisper\npu_cache\` | Compiled model cache |
| `logs\npu-shim.log` | Server runtime logs |
| `models\logs\f32_dumps\` | Diagnostic dumps |

## Bundled Dependencies

| Tool | Bundled by | Path |
|------|-----------|------|
| FFmpeg | OpenWhispr | `%LOCALAPPDATA%\Programs\OpenWhispr\resources\app.asar.unpacked\node_modules\ffmpeg-static\ffmpeg.exe` |
