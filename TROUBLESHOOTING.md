# Troubleshooting

## Quick Diagnostics

| Check | Command |
|-------|---------|
| Host architecture | `uname -m` |
| Node architecture | `node -p "process.arch"` |
| whisper.cpp install | `which whisper` or `which whisper-cpp` |
| FFmpeg availability | `ffmpeg -version` |

## Common Issues

### Architecture Mismatch (Apple Silicon)

**Symptoms:** Crashes on launch, "wrong architecture" errors

**Fix:**
1. Check if Node is x86_64 on arm64: `node -p "process.arch"` vs `uname -m`
2. Uninstall mismatched Node and reinstall native build
3. Run `rm -rf node_modules package-lock.json && npm ci`
4. Rebuild the app

### Microphone Permission Issues

**Symptoms:** "Permission denied", microphone prompt doesn't appear, or "No microphones detected"

**Platform-specific fixes:**

**macOS:**
1. Open System Settings → Privacy & Security → Microphone
2. Ensure OpenWhispr is listed and enabled
3. If not listed, click "Grant Access" in the app to trigger the permission prompt
4. You can also click "Open Microphone Privacy" button in the app

**Windows:**
1. Open Settings → Privacy → Microphone
2. Ensure "Allow apps to access your microphone" is ON
3. Ensure OpenWhispr is listed and enabled
4. You can also click "Open Privacy Settings" button in the app

**Linux:**
1. Check your audio settings (e.g., `pavucontrol`)
2. Ensure the correct input device is selected
3. Linux doesn't have app-level microphone permissions like macOS/Windows

### Empty Transcriptions

**Symptoms:** History shows "you" or empty entries

**Causes:**
- Microphone permission revoked mid-session
- Stale Whisper cache with corrupted clips
- Hotkey triggering without audio input
- Wrong audio input device selected

**Fix:**
1. Check microphone permissions (see above)
2. Open sound settings and verify the correct input device is selected
3. Clear caches: `rm -rf ~/.cache/whisper`
4. Try a different hotkey
5. Re-run onboarding

### FFmpeg Not Found

**Symptoms:** "FFmpeg not found" error, transcription fails immediately

**Fix:**
1. Reinstall dependencies: `rm -rf node_modules && npm ci`
2. If using packaged app, try reinstalling
3. **Windows:** check that antivirus / Windows Defender hasn't quarantined the bundled FFmpeg binary

### whisper.cpp Issues

**Symptoms:** Local transcription fails, "whisper.cpp not found"

**Fix:**
1. The whisper.cpp binary is bundled with the app
2. If running from source, download the current-platform binary: `npm run download:whisper-cpp`
3. If bundled binary fails, install via package manager:
   - macOS: `brew install whisper-cpp`
   - Linux: Build from source at https://github.com/ggml-org/whisper.cpp
4. Clear model cache: `rm -rf ~/.cache/openwhispr/whisper-models`
5. Try cloud transcription as fallback

### Wayland Clipboard Issues (Linux)

**Symptoms:** Paste simulation succeeds but target app shows "clipboard is empty", "no image on clipboard", or "contents not available in the requested format"

**Cause:** Electron's main-process clipboard API uses X11 selections (via XWayland), which native Wayland apps cannot read.

**Fix:**
1. Install `wl-clipboard` for the most reliable Wayland clipboard support:
   - Debian/Ubuntu: `sudo apt install wl-clipboard`
   - Fedora/RHEL: `sudo dnf install wl-clipboard`
   - Arch: `sudo pacman -S wl-clipboard`
2. Ensure a paste tool is installed (`xdotool` recommended, or `wtype` for Sway/Hyprland, or `ydotool` with daemon)
3. Restart OpenWhispr after installing

OpenWhispr tries clipboard methods in order: `wl-copy` (most reliable) → renderer `navigator.clipboard` → X11 fallback.

### Linux System Audio Portal Issues

**Symptoms:** The Linux share dialog keeps appearing, system audio does not stay granted, or onboarding does not show a system-audio grant step.

**Fix:**
1. Update `xdg-desktop-portal` and the matching desktop backend for your session (`xdg-desktop-portal-gnome`, `xdg-desktop-portal-kde`, `xdg-desktop-portal-wlr`, etc.)
2. Sign out and back in after updating portal packages
3. Re-run system audio capture and complete the chooser again
4. Expect the chooser to appear on Linux while OpenWhispr is using the standard browser portal path; some desktops may support more persistent portal behavior later, but fallback capture should still work

### Meeting Transcription Issues

**Symptoms:** Meeting detection not working, no transcription, audio not captured

**macOS:**
1. Grant Screen Recording permission: System Settings → Privacy & Security → Screen Recording → enable OpenWhispr
2. Restart the app after granting permission
3. Ensure Google Calendar is connected in Integrations

**All Platforms:**
1. Check that meeting detection is enabled in settings
2. Verify your OpenAI API key is valid (required for Realtime API transcription)
3. Ensure your meeting app (Zoom, Teams, FaceTime) is running — process detection looks for known meeting applications
4. If auto-detection fails, you can manually start recording from the meeting notification

### Agent Mode Issues

**Symptoms:** Agent overlay not appearing, no AI responses, streaming errors

**Fix:**
1. Ensure Agent Mode is enabled in Settings → Agent Mode
2. Check that you have a valid API key for your selected provider
3. Verify the agent hotkey doesn't conflict with other global shortcuts
4. For local models: ensure the model is downloaded and llama-server is running
5. For Metal OOM on macOS: try a smaller local model

### Windows-Specific Issues

**No window appears (process running in Task Manager but invisible):**
1. Check the system tray (click the `^` caret) for the OpenWhispr icon
2. Run with debug logging: `OpenWhispr.exe --log-level=debug`
3. Try disabling GPU acceleration: `OpenWhispr.exe --disable-gpu`

**Antivirus / Windows Defender blocking binaries:**

whisper.cpp and FFmpeg may be quarantined silently. Add OpenWhispr to exclusions: Settings → Virus & threat protection → Exclusions.

**Permission errors:**

Right-click OpenWhispr → Run as administrator (or set permanently in Properties → Compatibility).

**Firewall blocking cloud mode:**

Allow OpenWhispr through Windows Firewall when using cloud transcription providers.

**Complete reset (after uninstalling):**

```batch
rd /s /q "%APPDATA%\OpenWhispr"
rd /s /q "%LOCALAPPDATA%\OpenWhispr"
```

Then reinstall.

**Logs location:** `%APPDATA%\OpenWhispr\logs\`

## Enable Debug Mode

For detailed diagnostics, see [DEBUG.md](DEBUG.md).

## Getting Help

1. Enable debug mode and reproduce the issue
2. Collect diagnostic output from commands above
3. Open an issue at https://github.com/OpenWhispr/openwhispr/issues with:
   - OS version
   - OpenWhispr version
   - Relevant log sections
   - Steps to reproduce
