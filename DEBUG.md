# Debug Mode

Enable verbose logging to diagnose issues like "no audio detected" or transcription failures.

## Enable Debug Logging

### Option 1: Command Line

```bash
# macOS
/Applications/OpenWhispr.app/Contents/MacOS/OpenWhispr --log-level=debug

# Windows
OpenWhispr.exe --log-level=debug
```

### Option 2: Environment File

Add to your `.env` file and restart:

```
OPENWHISPR_LOG_LEVEL=debug
```

**Env file locations:**

- macOS: `~/Library/Application Support/open-whispr/.env`
- Windows: `%APPDATA%\open-whispr\.env`
- Linux: `~/.config/open-whispr/.env`

### Option 3: In-app toggle

Open **Settings → System → Debug Logging** and turn on **Debug mode**. It takes effect right away, with no restart, and is saved to the `.env` file above. The panel then shows the current log file and an **Open Logs Folder** button.

## Log File Locations

- **macOS**: `~/Library/Application Support/open-whispr/logs/debug-*.log`
- **Windows**: `%APPDATA%\open-whispr\logs\debug-*.log`
- **Linux**: `~/.config/open-whispr/logs/debug-*.log`

These folders are for release builds. Development and staging builds use `OpenWhispr-development` and `OpenWhispr-staging` in the same parent folder instead. The **Open Logs Folder** button (Option 3) always opens the folder for the build you are running.

## What Gets Logged

| Stage                 | Details                                                          |
| --------------------- | ---------------------------------------------------------------- |
| FFmpeg                | Path resolution, permissions, ASAR unpacking                     |
| Audio Recording       | Permission requests, chunk sizes, audio levels                   |
| Audio Processing      | File creation, Whisper command, process output                   |
| IPC                   | Messages between renderer and main process                       |
| Agent Mode            | Streaming responses, conversation management, model selection    |
| Meeting Detection     | Process monitoring, audio activity, calendar event matching      |
| Meeting Transcription | WebSocket connection, Realtime API session, audio buffering      |
| Google Calendar       | OAuth flow, token refresh, event sync                            |
| Media Control         | Pause/resume events, player detection (MediaRemote/GSMTC/MPRIS2) |
| Audio Storage         | File retention, cleanup cycles, storage usage                    |

## Common Issues

### "No Audio Detected"

Look for:

- `maxLevel < 0.01` → Audio too quiet
- `Audio appears to be silent` → Microphone issue
- `FFmpeg not available` → Path resolution failed

### Transcription Fails

Look for:

- `Whisper stderr:` → whisper.cpp/FFmpeg errors
- `Process closed with code: [non-zero]` → Process failure
- `Failed to parse Whisper output` → Invalid JSON

### Permission Issues

Look for:

- `Microphone Access Denied`
- `isExecutable: false` → FFmpeg permission issue

## Sharing Logs

When reporting issues:

1. Enable debug mode and reproduce the issue
2. Locate the log file
3. Redact any sensitive information
4. Include relevant log sections in your issue report

## Disable Debug Mode

Debug mode is off by default. To ensure it's disabled:

- Remove `--log-level=debug` from command
- Remove `OPENWHISPR_LOG_LEVEL` from `.env`
