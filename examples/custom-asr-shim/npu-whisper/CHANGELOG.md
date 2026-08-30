# Changelog

## July 27, 2026 — NPU Integration Complete

### Added
- NPU Whisper Shim server (`npu-whisper-shim.py`) — HTTP server running `whisper-large-v3-turbo` on Intel AI Boost NPU
- Production launcher (`launch-npu-shim.bat`) — silent startup with logging
- Windows auto-start via Startup folder shortcut
- Health check endpoint (`GET /health`)
- Diagnostic dump endpoint (`GET /dumps`) — captures .f32 audio for debugging
- `README.md`, `ARCHITECTURE.md`, `TROUBLESHOOTING.md`, `QUICKSTART.md`

### Fixed
- **Root cause: `initial_prompt` incompatible with NPU** — Passing any `initial_prompt` value (including empty string) to `WhisperPipeline.generate()` on NPU caused `Check '*roi_end <= *max_dim'` tensor error. Fixed by removing `initial_prompt` from generation parameters in `_run_inference()`.
- **WAV header bug** — `load_audio_float()` assumed 44-byte WAV header but FFmpeg produces 78-byte headers with LIST/INFO metadata chunks. Fixed by scanning WAV structure for the `data` chunk marker.
- **Console output leak** — Shim's stdout was shared with OpenWhispr console via `-NoNewWindow`, causing debug text to appear in transcribed text field. Fixed by launching shim hidden with output redirected to log file.
- **Hotkey collision** — `Ctrl+Shift` conflicted with OpenWhispr's `Ctrl+Shift+V` paste mechanism, causing recording restart loop. Fixed by changing hotkey to `Ctrl+Super` (Ctrl+Win).

### Infrastructure
- Python 3.12 with OpenVINO GenAI 2026.2.1
- Model: `movensys/whisper-large-v3-turbo-fp16-ov-npu` (1.55 GB, FP16)
- NPU compilation cached (~4 min first run, ~4 sec subsequent)

### Performance
- Transcription RTF: 0.07x – 0.80x (always faster than real-time)
- ~6.5x faster than CPU-only whisper.cpp

### Known Limitations
- `initial_prompt` (custom dictionary hints) not supported on NPU — OpenVINO static shape constraint
- NPU driver on Windows less tested than Linux — OpenVINO 2026 support is maturing
- Only one NPU pipeline at a time (hardware limitation)
