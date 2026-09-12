# NPU Whisper Shim for OpenWhispr

Intel AI Boost NPU-accelerated speech-to-text shim for OpenWhispr's Self-Hosted transcription mode. Runs `whisper-large-v3-turbo` on the NPU via OpenVINO GenAI, providing 2-14x faster-than-real-time transcription with full local privacy.

## Architecture

```
OpenWhispr (Electron)                NPU Whisper Shim (Python)
+-------------------------+          +------------------------------+
| Settings -> Self-Hosted |  HTTP    | ThreadingHTTPServer :8765    |
| URL: localhost:8765     |--------->|                              |
|                         |<---------| multipart/form-data -> WAV   |
| Audio -> fetch() -> POST|   JSON   | OpenVINO GenAI -> NPU        |
+-------------------------+          +------------------------------+
```

## Requirements

| Component | Detail |
|-----------|--------|
| **CPU** | Intel Core Ultra (Arrow Lake / Meteor Lake / Lunar Lake) with AI Boost NPU |
| **NPU Driver** | Version 4.65+ (via Windows Update or Intel DSA) |
| **Python** | 3.12+ |
| **OpenVINO** | openvino, openvino-genai, openvino-tokenizers (all 2026.2.1) |
| **Disk** | ~3 GB (model ~1.55 GB + OpenVINO runtime) |
| **GPU Fallback** | NVIDIA or other GPU — DGPU path works for CUDA-accelerated whisper.cpp |

## Quick Start

### 1. Install OpenVINO GenAI

```powershell
pip install openvino==2026.2.1 openvino-genai==2026.2.1 openvino-tokenizers==2026.2.1
pip install librosa soundfile huggingface_hub numpy

# Verify NPU detected
python -c "import openvino as ov; print('NPU' in ov.Core().available_devices)"
```

### 2. Download Model

```powershell
python -c "from huggingface_hub import snapshot_download; snapshot_download('movensys/whisper-large-v3-turbo-fp16-ov-npu', local_dir=r'%APPDATA%\open-whispr\models\npu-whisper\whisper-large-v3-turbo-fp16-ov-npu')"
```

### 3. First-Run Compilation

```powershell
python npu-whisper-shim.py
# First load: ~4 min (NPU compilation) -> cached
# Subsequent: ~4 sec
```

### 4. Configure OpenWhispr

Settings -> Speech to Text -> **Self-hosted server**:
- Server URL: `http://localhost:8765`

### 5. Auto-Start

```powershell
# Copy shortcut to Startup folder
# Or use: setup-npu-auto-start.ps1 (run as Administrator for scheduled task)
```

### 6. Hotkey Recommendation

Use **Ctrl+Win** (Ctrl+Super) as the dictation hotkey to avoid conflict with Ctrl+Shift+V paste.

## Model Information

| Attribute | Value |
|-----------|-------|
| **Model** | `whisper-large-v3-turbo` |
| **Format** | OpenVINO IR (stateful, `beam_idx` compatible) |
| **Precision** | FP16 |
| **Size** | ~1.55 GB |
| **Source** | `movensys/whisper-large-v3-turbo-fp16-ov-npu` (HuggingFace) |
| **Cached load** | ~4 sec |
| **First compilation** | ~4 min |

## Performance

Typical Real-Time Factor (RTF) on Intel Core Ultra with AI Boost NPU:

| Audio Length | NPU (OpenVINO) | Speed vs Real-Time |
|-------------|----------------|-------------------|
| 3 seconds   | ~1.5 seconds   | 2x faster |
| 7 seconds   | ~1.5 seconds   | 5x faster |
| 30 seconds  | ~2.1 seconds   | 14x faster |

## Known Limitations

- **`initial_prompt` not supported**: The `initial_prompt` parameter is incompatible with NPU static shapes. Custom dictionary prompts from OpenWhispr are silently dropped (runtime warning logged).
- **FP8/INT8 quantization**: Not available for Whisper in OpenVINO. Model uses FP16.
- **NPU on Windows**: Less tested than Linux — OpenVINO 2026 NPU support on Windows is maturing.

## Diagnostics

```powershell
# Health check
Invoke-RestMethod http://localhost:8765/health

# View logs
Get-Content "$env:APPDATA\open-whispr\logs\npu-shim.log" -Tail 20

# Test transcription
python scripts/test_shim.py
```

## File Layout

```
%APPDATA%\open-whispr\models\npu-whisper\
  npu-whisper-shim.py          # Main server
  launch-npu-shim.bat          # Production launcher
  whisper-large-v3-turbo-fp16-ov-npu/  # Model files
  npu_cache/                   # Compiled model cache
```

## License

This shim is provided under the same license as the OpenWhispr project.
