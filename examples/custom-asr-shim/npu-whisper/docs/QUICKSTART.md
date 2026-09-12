# Quick Start — NPU Transcription for OpenWhispr

## One-Time Setup

- [ ] Install Python 3.12+ with OpenVINO GenAI 2026.2.1
- [ ] Download model (~1.55 GB)
- [ ] First NPU compilation (~4 min, cached thereafter)
- [ ] Configure OpenWhispr — Self-hosted server at `localhost:8765`

```powershell
# Install dependencies
pip install openvino==2026.2.1 openvino-genai==2026.2.1 openvino-tokenizers==2026.2.1 librosa soundfile huggingface_hub numpy

# Download model
python -c "from huggingface_hub import snapshot_download; snapshot_download('movensys/whisper-large-v3-turbo-fp16-ov-npu', local_dir=r'%APPDATA%\open-whispr\models\npu-whisper\whisper-large-v3-turbo-fp16-ov-npu')"

# Start server (first run compiles ~4 min)
python "%APPDATA%\open-whispr\models\npu-whisper\npu-whisper-shim.py"
```

## Daily Usage

1. Start the shim server (or configure auto-start)
2. OpenWhispr -> Settings -> STT -> Self-hosted -> `http://localhost:8765`
3. Press dictation hotkey -> speak -> press again -> text appears

## Check Status

```powershell
Invoke-RestMethod http://localhost:8765/health
# {"status":"ok","device":"NPU","pipeline_loaded":true}
```

## Manual Start/Stop

```powershell
# Start
Start-Process python -ArgumentList "%APPDATA%\open-whispr\models\npu-whisper\npu-whisper-shim.py" -WindowStyle Hidden

# Stop
Get-Process python* | Stop-Process -Force
```

## Hotkey Recommendation

Use **Ctrl+Win** instead of Ctrl+Shift to avoid conflict with paste operations.

## Performance

| Audio | NPU Time | Speed vs Real-Time |
|-------|----------|-------------------|
| 3s clip | ~1.5s | 2x faster |
| 7s clip | ~1.5s | 5x faster |
| 30s clip | ~2.1s | 14x faster |

## Files

| File | Location |
|------|----------|
| Shim server | `%APPDATA%\open-whispr\models\npu-whisper\npu-whisper-shim.py` |
| Launcher | `%APPDATA%\open-whispr\models\npu-whisper\launch-npu-shim.bat` |
| Logs | `%APPDATA%\open-whispr\logs\npu-shim.log` |
| Model | `%APPDATA%\open-whispr\models\npu-whisper\whisper-large-v3-turbo-fp16-ov-npu\` |
| Cache | `%APPDATA%\open-whispr\models\npu-whisper\npu_cache\` |
