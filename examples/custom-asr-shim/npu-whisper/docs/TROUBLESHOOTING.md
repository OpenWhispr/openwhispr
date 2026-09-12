# Troubleshooting Guide

## Quick Diagnostic Commands

```powershell
# Check NPU availability
python -c "import openvino as ov; core = ov.Core(); print(core.available_devices)"
# Expected: ['CPU', 'GPU.0', 'GPU.1', 'NPU']

# Check shim health
Invoke-RestMethod http://localhost:8765/health
# Expected: {"status":"ok","device":"NPU","pipeline_loaded":true}

# View shim logs
Get-Content "$env:APPDATA\open-whispr\logs\npu-shim.log" -Tail 30

# View OpenWhispr debug logs
Get-ChildItem "$env:APPDATA\open-whispr\logs\debug-*.log" | Sort-Object LastWriteTime -Desc | Select -First 1 | Get-Content -Tail 60

# Check if port is in use
netstat -ano | findstr ":8765"
```

## Common Issues

### "Transcription failed: API Error 500"

**Cause:** Shim returned a server error.

**Check:** Shim logs at `%APPDATA%\open-whispr\logs\npu-shim.log`

| Error in log | Likely cause | Fix |
|---|---|---|
| `Check '*roi_end <= *max_dim' failed` | `initial_prompt` incompatibility | Already fixed in current shim — ensure latest version |
| `No 'file' field in request` | OpenWhispr sent bad multipart request | Verify self-hosted URL is `http://localhost:8765` |
| `ffmpeg not found on PATH` | Bundled ffmpeg not discovered | Shim auto-finds bundled ffmpeg. Restart shim. |
| `ffmpeg failed to transcode audio` | Corrupted audio or unsupported format | Audio should be WebM/Opus from OpenWhispr |

### "Transcription failed: No text transcribed"

**Cause:** Shim returned HTTP 200 but with empty text.

**Check:** The incoming audio RMS and duration in shim log:
```
[request] 123456B hash=abc... -> 5.2s rms=0.045678
```

| rms value | Meaning | Action |
|---|---|---|
| `< 0.0001` | Silent recording (no speech) | Speak clearly into microphone |
| `< 0.001` | Very quiet | Increase microphone gain in Windows |
| `> 0.001` | Normal speech but empty output | Check shim log for inference errors |

### "Connection refused / Unable to connect"

**Cause:** Shim is not running.

**Fix:**
```powershell
# Check if Python process is running
Get-Process python* -ErrorAction SilentlyContinue

# Start the shim
Start-Process -FilePath python -ArgumentList "$env:APPDATA\open-whispr\models\npu-whisper\npu-whisper-shim.py" -WindowStyle Hidden

# Wait 10s for pipeline warm-up, then verify
Start-Sleep 10
Invoke-RestMethod http://localhost:8765/health
```

### Recording starts again immediately after stopping

**Cause:** Hotkey conflict with paste mechanism.

**Fix:** The hotkey has been changed from `Control+Shift` to `Control+Super` (Ctrl+Win). Verify:
```powershell
Get-Content "$env:APPDATA\open-whispr\.env" | Select-String "DICTATION_KEY"
# Should show: DICTATION_KEY=Control+Super
```

If you changed it back to `Control+Shift`, use `Control+Win` instead. The `Ctrl+Shift` combination conflicts with OpenWhispr's `Ctrl+Shift+V` paste shortcut.

### NPU Not Detected

**Symptom:** `python -c "import openvino as ov; ..."` shows only `['CPU']`

**Check:**
```powershell
# Check NPU device in Device Manager
Get-PnpDevice | Where-Object {$_.FriendlyName -like "*AI Boost*"} | Select Status, FriendlyName
# Should show: OK, Intel(R) AI Boost
```

| Status | Action |
|--------|--------|
| OK, driver present | Check OpenVINO version matches NPU driver (2026.2.1 recommended) |
| No device found | Install Intel NPU driver from Windows Update or Intel DSA |
| Status shows error | Update NPU driver: https://www.intel.com/content/www/us/en/download/794734 |

### Shim uses CPU instead of NPU

**Symptom:** Transcription works but is slow (similar to CPU speeds).

**Check the device in shim log:**
```
Device : NPU    ← should show NPU, not CPU
```

**To force NPU:** Set environment variable before starting shim:
```powershell
$env:WHISPER_DEVICE = "NPU"
```

**To test on GPU (Intel iGPU) as fallback:**
```powershell
$env:WHISPER_DEVICE = "GPU.0"
```

### OpenWhispr keeps starting/stopping the CUDA whisper-server

**Symptom:** In debug log, you see `whisper-server started` then `Stopping whisper-server` repeatedly.

**Cause:** When "Self-hosted" mode is active, OpenWhispr stops the local whisper server. This is expected — the app should NOT be in "Local" mode when using the NPU shim.

**Check:** Settings → Speech to Text → should show "Self-hosted server" selected.

### Transcription takes too long

| Expected time | Audio length | RTF |
|--------------|-------------|-----|
| ~1.5s | 2-7s | 0.2-0.8x |
| ~2.0s | 8-30s | 0.07-0.25x |
| ~10s | 100s+ | ~0.1x |

If transcription takes significantly longer, the pipeline may have lost its cache:
```powershell
# Check cache directory
Get-ChildItem "$env:APPDATA\open-whispr\models\npu-whisper\npu_cache" -Recurse | Measure-Object | Select Count
# If empty (Count=0): cache was lost, next run will recompile (~4 min)
```

### "Model directory not found"

**Symptom:** Shim exits immediately with error.

**Cause:** Model not downloaded.

**Fix:**
```powershell
python -c "from huggingface_hub import snapshot_download; snapshot_download('movensys/whisper-large-v3-turbo-fp16-ov-npu', local_dir=r'%APPDATA%\open-whispr\models\npu-whisper\whisper-large-v3-turbo-fp16-ov-npu')"
```

## Recovery Procedures

### Full Reset

```powershell
# 1. Kill all processes
Get-Process python*, whisper-server* -ErrorAction SilentlyContinue | Stop-Process -Force

# 2. Clear NPU cache (forces recompilation)
Remove-Item -Recurse -Force "$env:APPDATA\open-whispr\models\npu-whisper\npu_cache"

# 3. Start fresh
Start-Process -FilePath python -ArgumentList "$env:APPDATA\open-whispr\models\npu-whisper\npu-whisper-shim.py" -WindowStyle Hidden

# 4. Wait for compilation (check log)
Get-Content "$env:APPDATA\open-whispr\logs\npu-shim.log" -Wait  # Ctrl+C when ready

# 5. Verify
Invoke-RestMethod http://localhost:8765/health
```

### Switch to DGPU Fallback

```powershell
# Stop shim
Get-Process python* | Stop-Process -Force

# In OpenWhispr: Settings → STT → switch from "Self-hosted" to "Local"
# Select model: large
# Enable GPU acceleration
```

### Reinstall OpenVINO

```powershell
pip uninstall openvino openvino-genai openvino-tokenizers -y
pip install openvino==2026.2.1 openvino-genai==2026.2.1 openvino-tokenizers==2026.2.1
```

## Log Locations

| Log | Path | Purpose |
|-----|------|---------|
| Shim runtime | `%APPDATA%\open-whispr\logs\npu-shim.log` | Inference, errors, request tracing |
| OpenWhispr debug | `%APPDATA%\open-whispr\logs\debug-*.log` | App state, transcription flow, CUDA info |
| Diagnostic dumps | `%APPDATA%\open-whispr\models\logs\f32_dumps\` | Raw .f32 audio + .json config for debugging |
