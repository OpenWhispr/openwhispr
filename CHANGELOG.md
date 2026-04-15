# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.8] - 2026-04-14

### Added

- **Speaker Diarization**: Live speaker identification during meeting recording with post-processing refinement when the call ends (auto-downloaded sherpa-onnx pyannote + voxceleb models)
- **Speaker Reassignment UI**: Click any bubble to assign it to a known speaker, calendar attendee, or contact — with attendee-aware picker and bulk-select reassignment
- **Voice Fingerprint Linking**: Attach voice profiles to contact emails from the speaker picker
- **Meeting AEC Helper**: Native WebRTC AEC3 sidecar for mic echo cancellation when system audio is captured, with graceful fallback to the JS echo leak detector
- **Transcript-Level Dedupe**: Retract events drop mic duplicates once system audio confirms the same speech, cleaning both the live view and the saved transcript
- **Live Accuracy Hint**: Subtle in-view hint during recording indicating that speaker labels will sharpen once the call ends

### Changed

- **Meeting AEC Helper is Prebuilt**: Binaries are built on CI and downloaded like whisper-cpp / qdrant — contributors no longer need cmake, Python 3, or a C++ toolchain for a normal build

### Fixed

- **Speaker Reassignment for Own Bubbles**: Reassigning a left-side (mic) bubble now correctly flips side, name, and color instead of staying locked as "You"
- **Live Speaker Lock Persistence**: Live-assigned speaker names survive across the session and through diarization merge
- **Meeting System Audio Handling**: Restore system audio handling after transcription path refactor
- **Local Whisper Speech Gate**: Stricter silence gate with peak-amplitude fallback to prevent dropped chunks on quiet but non-silent audio
- **Transcript Merge**: Preserve prior transcript when diarization merge arrives

### Security

- **CMake Quoter Escape**: Single-pass backslash + quote escape in `quoteCmake` resolves a CodeQL incomplete-escape warning

## [1.6.7] - 2026-04-02

### Added

- **Calendar Participants on Meeting Notes**: Automatically link Google Calendar attendees to meeting notes when recording starts from a calendar event, with domain-grouped display and Gravatar avatars
- **Save Notes as Files**: Export notes to the local filesystem as Markdown files, mirroring folder hierarchy
- **Responsive Settings Dialog**: Settings dialog adapts to narrow windows — sidebar collapses to icon rail, rows stack vertically, plan grid reflows
- **Chat Sidebar**: Full sidebar chat tab with conversation history, cloud sync, and semantic search
- **Chat UX Polish**: Empty state with illustration, shimmer thinking/streaming indicator, stop button, action buttons and search dialog
- **Local Semantic Search**: Always-on Qdrant vector DB sidecar for offline semantic search across notes — hybrid FTS5 + vector with Reciprocal Rank Fusion
- **Agent Tool Calling**: Agentic tool-calling system with note management tools (get, create, update, search), cloud agent support with NDJSON streaming, and local model tool calling with RAG context injection
- **Embedded Chat in Notes**: Embedded chat panel in the note editor with floating and sidebar modes
- **Per-GPU Device Selector**: Choose a specific GPU for transcription and intelligence processing (#539)
- **Settings Keyboard Shortcut**: Cmd+, / Ctrl+, keyboard shortcut to open Settings
- **Notes Actions Button**: Actions sidebar button with redesigned action editor dialog
- **Notes Folder Picker**: Folder picker in the note metadata row with cleaned-up input styles
- **Notes Sidebar Buttons**: New note and search notes buttons in the sidebar
- **Meeting Echo Cancellation**: Echo cancellation on mic input and note metadata chips in meeting view
- **Linux Wrapper Script**: Wrapper script to force XWayland and support user flags (#507)

### Changed

- **Vercel AI SDK Migration**: Agent mode migrated from raw API calls to Vercel AI SDK
- **Notes Bottom Bar Redesign**: Redesigned bottom bar with compact action picker
- **Dialog Design System Alignment**: All dialogs aligned with design system guidelines
- **Removed Note Word Count**: Removed word count from note editor
- **Cloud Agent Streaming**: Stream cloud agent responses directly from the renderer via IPC

### Fixed

- **Meeting Auto-Detection**: Fix auto-detection not firing for browser meetings
- **Meeting Transcription Provider**: Use local transcription provider for notes/meeting recording (#530)
- **Meeting Partial Transcript Spam**: Prevent partial transcript spam and duplicate final segments
- **Meeting Notification Timing**: Resolve notification popup timing and detection lifecycle bugs
- **Folder/Note Race Conditions**: Resolve race conditions when switching folders quickly, prevent meeting view from exiting when changing folder, fix rapid delete/switch state management
- **Clipboard Preservation**: Preserve images and HTML in clipboard during paste-and-restore (#381)
- **Transcription Retry Provider**: Retry transcription uses configured provider instead of forcing Parakeet
- **JSON Parse Validation**: Validate JSON.parse result type before calling .replace() in prompts (#541)
- **GPU Selector Polish**: Address code review feedback, rename Intelligence GPU label, fix dropdown chevron padding (#539)
- **Meeting Participant Saves**: Fix calendar attendees not syncing to store and manual participant adds overwriting calendar data
- **Chat Duplicate Conversations**: Fix duplicate conversations — includeArchived filter returned all instead of only archived
- **Linux Wayland Fixes**: Force XWayland on KDE/GNOME Wayland, fix hotkey startup race; use uinput before portal on GNOME Wayland (#468, #494)
- **Mic Permission Gate**: Remove mic permission gate, fix system audio detection
- **Windows Build Signing**: Fix Windows build signing on PRs, add missing mic-listener download, add missing publisherName to Azure signing config
- **Dead optimizeAudio Crash**: Remove dead optimizeAudio call that crashes on recordings over 90 seconds (#524)
- **Download URL Logging**: Remove URL truncation from download log and add failure logging (#540)

### Security

- **Google Calendar Scopes**: Narrow OAuth scope from `calendar.readonly` to `calendar.events.readonly` + `calendar.calendarlist.readonly` for minimal privilege
- **picomatch**: Bump to 4.0.4
- **brace-expansion**: Bump to 1.1.13 (security backport)
- **yaml**: Bump to 2.8.3
- **tar**: Bump to 7.5.13

## [1.6.6] - 2026-03-19

### Added

- **Native macOS System Audio Tap**: CoreAudio Tap API for direct system audio capture — eliminates the need for screen recording permission on macOS 14.2+
- **TipTap Rich Text Editor**: Migrated notes editor from plain Markdown to TipTap with Obsidian-style live preview — hides Markdown syntax except on the cursor line, with rich text rendering for enhanced and transcript views
- **Dual-Channel Meeting Transcription**: Separate mic and system audio channels with chat bubble UI for speaker-differentiated meeting transcripts
- **Meeting Segment Timestamps**: Persist segment timestamps in saved meeting transcripts with chronological ordering
- **Meeting-Specific AI Prompts**: Meeting notes generation now uses speaker-aware prompts for better context in generated summaries
- **KDE Wayland Native Shortcuts**: Native global shortcut support for KDE Plasma on Wayland using D-Bus, matching the existing GNOME and Hyprland approach (#486)
- **Mistral Nemo 12B and Gemma 3 12B**: Added to local model registry for on-device inference (#483)
- **Post-Login Permissions Gate**: Returning users now see a permissions check after login to ensure mic and system audio access

### Changed

- **Unified Notes Recording**: All notes now use dual-stream transcription with simplified recording UX — always saves to transcript
- **Notes Tab Rename**: Renamed "Raw" tab to "Notes" and default to it during meetings
- **Shared Note Title Generation**: Extracted `generateNoteTitle` utility for consistent auto-titling across meeting and regular notes
- **Simplified Permission Buttons**: Consolidated permission prompts to a single "Grant Access" action (#490)
- **screenRecording → systemAudio Rename**: Renamed `screenRecording` references to `systemAudio` across the codebase for clarity
- **macOS 15+ System Audio Consent**: Trigger the native system audio consent dialog on macOS 15+ instead of the legacy screen recording prompt
- **Improved Notes Output**: Better generate notes output format and auto-title generation
- **Update Notification Polish**: Improved update notification transparency, icon, and copy
- **Permission Re-validation**: Re-validate mic and system audio permissions against the OS on component mount

### Fixed

- **Gemini Agent Streaming**: Route Gemini agent streaming to the correct API endpoint
- **Windows Mic Volume Mutation**: Disable browser AGC to prevent Windows mic volume being permanently altered (#476)
- **Linux Mono Transcription**: Request stereo recording to prevent mono transcription failure on Linux
- **Meeting Bluetooth Audio**: Detach meeting AudioContexts from output device for Bluetooth compatibility; fix system audio loopback silence
- **Meeting Detection Suppression**: Suppress meeting detection notifications when meeting mode is already active
- **Windows Paste Modifier Keys**: Release held modifier keys before `SendInput` paste on Windows
- **Meeting Session Reset**: Reset meeting audio send counts between sessions
- **Meeting Hotkey Behavior**: Meeting hotkey always opens a new meeting regardless of current view
- **STT Config Auth Timing**: Retry STT config fetch before recording when auth isn't ready on mount
- **Hotkey Restore on Failure**: Restore previous hotkey on registration failure
- **KDE Wayland Hotkeys**: Force XWayland on KDE Wayland to fix hotkey registration
- **Streaming Dictation Commands**: Use TipTap editor commands for streaming dictation input
- **Google OAuth Onboarding**: Fix Google OAuth users skipping onboarding flow
- **Realtime Dictation Default**: Default streaming provider to openai-realtime for dictation; respect sttConfig dictation mode for realtime models
- **KDE Plasma Overlay**: Fix KDE Plasma hotkey and overlay window behavior — scoped window type changes to KDE only, preserving GNOME behavior (#491)
- **Cleanup Prompt Refusal**: Fix cleanup prompt refusing to output command-like transcriptions (#478)
- **KDE Wayland Clipboard Paste**: Replaced busy-wait with sleep and clean up temp file for KDE Wayland paste (#455)
- **GNOME Agent Hotkey**: Register agent hotkey as independent GNOME Wayland keybinding slot (#436)
- **Agent Hotkey Conflict Warning**: Show conflict warning when agent hotkey duplicates another mode
- **Meeting Hotkey Registration**: Await async `registerSlot` for meeting hotkey registration
- **Media Pause During Dictation**: Prevent paused media from being unpaused during dictation (#419)
- **Meeting Chat Scroll Overlap**: Fix meeting system audio transcription and chat scroll overlap
- **macOS Media Remote Bundle**: Include macos-media-remote in extraResources (#487)
- **NSAudioCaptureUsageDescription**: Restore plist entry and increase audio probe timeout

### Security

- **undici CVE-2026-1526**: Bump undici to 6.24.1 to fix request smuggling vulnerability

## [1.6.5] - 2026-03-17

### Added

- **Data Retention Toggle**: New privacy setting to control whether transcription text is retained in history (Privacy & Data settings)

### Fixed

- **Meeting Detection Reset**: Fix meeting detection not properly resetting after a meeting ends

## [1.6.4] - 2026-03-15

### Added

- **Meeting Mode Hotkey**: Dedicated hotkey to start/stop meeting transcription directly from the keyboard, independent of the dictation hotkey
- **Account Deletion**: Users can now delete their account from within the app
- **Qwen3.5 Local Models**: Added Qwen3.5 local models to the model registry; removed sub-1B models that were too small for practical use
- **Model Descriptions in Picker**: Local model picker now shows model descriptions to help users choose the right model
- **Meeting Detection Toggle**: New setting to enable/disable automatic meeting detection
- **Dependabot**: Automated weekly npm dependency updates via Dependabot
- **CodeQL Static Analysis**: GitHub Actions workflow for automated security scanning
- **Zod Dependency**: Added Zod for input validation and sanitization

### Changed

- **Multi-Monitor Floating Icon**: The dictation floating icon now appears on the monitor where the cursor is, instead of always on the primary display
- **Persistent Panel Position**: Panel start position now persists across app restarts
- **Compact Hotkey Tooltip**: Overlay tooltip uses compact modifier symbols (e.g., ⌘⇧K instead of Cmd+Shift+K), wraps for long combos, and aligns to window edge based on panel position
- **Cross-Window Settings Sync**: Settings changes now sync across all open windows in real time
- **Agent Chat Title**: Renamed agent mode window title from "Agent Mode" to "Agent Chat"
- **Windows Model Preservation**: Local LLM models are now preserved during Windows app updates instead of being deleted

### Fixed

- **Meeting Hotkey Overwrite**: Fixed meeting hotkey accidentally overwriting the dictation hotkey on save
- **Meeting Snap Timing (macOS)**: Fixed meeting mode snap timing on macOS causing incorrect window positioning
- **Meeting Detection False Positives**: Reduced false-positive meeting detection notifications
- **Hotkey Tooltip Display**: Fixed hotkey tooltip not updating after changing the hotkey in settings
- **Silence Detection Threshold**: Lowered silence detection threshold to avoid rejecting valid speech that was previously considered too quiet (#411)

## [1.6.3] - 2026-03-12

### Changed

- **System Audio Permission Clarity**: Renamed "Screen Recording" to "System Audio" across all permission prompts, onboarding, and settings — makes it clear that OpenWhispr captures other participants' audio, not your screen
- **Improved Permission Copy**: Microphone permission now reads "Captures your voice for transcription"; System Audio reads "Captures other participants' audio from calls and meetings. We never record your screen."
- **Electron 39**: Upgraded from Electron 36 to 39, which uses the CoreAudio Tap API by default on macOS 14.2+ — eliminates the purple "screen recording" indicator, the "Your screen is being observed" lock screen message, and the misleading "Screen & System Audio Recording" permission prompt. Users now see "System Audio Recording Only" instead
- **NSAudioCaptureUsageDescription**: Added the new macOS 14.2+ audio capture usage description to Info.plist, enabling the separate system audio permission dialog
- **better-sqlite3 12**: Upgraded from v11 to v12 for Electron 39 V8 compatibility
- **Localized in all 10 languages**: All permission copy changes translated across en, pt, de, es, fr, it, ru, ja, zh-CN, zh-TW

### Added

- **Hyprland Wayland Support**: Native global shortcut support for Hyprland using `hyprctl` keybindings + D-Bus, matching the existing GNOME Wayland approach (#416)

### Fixed

- **Soft Voice Recognition**: Enabled Auto Gain Control (AGC) for dictation microphone input to automatically boost quiet speech — previously disabled, now matches meeting mode behavior
- **OpenAI Realtime VAD Sensitivity**: Lowered voice activity detection threshold from 0.5 to 0.3 (both client and API) so soft-spoken audio is no longer missed
- **Speech Onset Clipping**: Increased VAD prefix padding from 300ms to 500ms to capture the quiet beginning of soft speech that was previously cut off
- **Wayland Clipboard Paste**: Fixed `wl-copy` failing silently due to 1ms `spawnSync` timeout killing the fork before it completed — increased to 50ms (#416)
- **Streaming Media Resume**: Fixed media staying paused after recording silence with "Pause media on dictation" enabled — streaming path now fires the completion callback even when no speech is detected (#429)

## [1.6.2] - 2026-03-11

### Added

- **System Audio for Notes**: Mix system audio (via getDisplayMedia loopback) with microphone input for note recordings, enabling capture of meeting audio, YouTube lectures, and other system sounds
- **Event-Driven Meeting Detection**: Replaced polling-based meeting detection with native OS event APIs (CoreAudio on macOS, WASAPI on Windows, pactl on Linux) — reduces background CPU from 5–9% to near-zero (#404)
- **Notes Onboarding**: Added screen recording permission step to the notes onboarding wizard (macOS) so users can grant permission before their first recording

### Changed

- **Auto-Enable System Audio**: System audio is now automatically enabled when screen recording permission is granted — removed the separate toggle button for a simpler recording experience
- **Deferred Transcript Display**: Recording transcript is no longer shown live during notes dictation; it appears after recording stops, matching the meeting notes flow for a cleaner experience

### Fixed

- **Windows Hotkey Stability**: Track modifier state in native keyboard hook so modifier-only shortcuts (e.g. Control+Super) are detected reliably on Windows 11; keep floating recorder interactive; prefer compiling current key-listener source over downloaded binaries
- **macOS Accessibility Permission Prompt**: Detect missing accessibility trust after startup and notify users with auto-opened Privacy settings and toast guidance — fixes silent Globe key failures on fresh installs
- **Realtime Streaming Warmup**: Fix warmup gating so initial audio is no longer silently dropped; skip redundant session config in cloud mode; handle empty-buffer commit on disconnect gracefully
- **Custom Dictionary Prompt Truncation**: Truncate custom dictionary to respect Groq's 896-char limit, preventing 400 errors on large dictionaries (#405)
- **Parakeet bzip2 on Windows 10**: Add JS fallback for bzip2 extraction when native tar fails (#406)
- **Business Plan Past-Due Check**: Include business plan in past-due subscription check

### Removed

- Removed the Monitor toggle button from the dictation widget (system audio mode is now automatic)

## [1.6.1] - 2026-03-08

### Added

- **WebSocket Streaming for BYOK Dictation**: OpenAI Realtime API streaming now works for standard dictation mode (not just meetings), enabling real-time transcription for Bring Your Own Key users
- **Unified Streaming Path**: Extended OpenAI Realtime WebSocket streaming to normal dictation, sharing the same streaming infrastructure as meeting transcription

### Fixed

- **Transcript Loss on Disconnect**: Commit audio buffer before closing WebSocket and wait for final transcript before closing, preventing lost transcriptions during disconnects
- **Dictation IPC Callbacks**: Send plain strings from streaming IPC callbacks instead of objects, fixing downstream consumers
- **Accessibility Permission Detection (macOS)**: Fix onboarding flow not detecting macOS accessibility permission correctly (#394)
- **Custom Cloud Provider Classification**: Treat Custom Cloud endpoints as self-hosted rather than third-party (#384)
- **Blocking `execSync` in Meeting Detection**: Replaced synchronous process detection with async alternative to prevent UI freezes on Windows
- **BYOK Onboarding Override**: Guard BYOK override for signed-in users and fix missing deps during onboarding (#397)
- **Windows Media Pause Toggle**: Check audio state before sending media key on Windows (#402)
- **Linux Wayland Portal Permissions**: Set desktop name on Linux for Wayland portal permissions (#389)
- **Chrome Sandbox Permissions (Linux)**: Set SUID bit on chrome-sandbox during deb/rpm install

### Changed

- Eliminated duplication and fixed style inconsistencies in dictation streaming helpers
- Cleaned up meeting detection code after the Windows input fix

## [1.6.0] - 2026-03-06

### Added

- **Agent Mode**: Glassmorphism chat overlay with real-time AI streaming — resizable window (8 edge/corner handles), dedicated hotkey, conversation history stored in SQLite, customizable system prompt, and support for all cloud/local AI providers
- **Google Calendar Integration**: Connect multiple Google accounts via OAuth 2.0 (PKCE), view upcoming meetings in the sidebar, and receive notifications when meetings are detected
- **Meeting Recording & Live Transcription**: Automatic meeting detection via process monitoring (Zoom, Teams, FaceTime) and sustained audio activity, with live transcription powered by OpenAI Realtime API over WebSocket
- **Cloud Notes with Sync**: Local-first note storage with FTS5 full-text search, folder organization, cloud sync, and semantic search — all notes are instantly searchable across title, content, and enhanced content
- **Audio Retention & Retry**: Transcription audio is now saved locally with configurable retention (default 30 days), enabling playback from history and one-click retry of failed transcriptions through the full pipeline
- **Cmd+K Command Search**: Global command palette to search across notes, transcripts, and folders with real-time results, keyboard navigation, and type-grouped display
- **Auto-Pause Media Playback**: Automatically pauses media (Spotify, Apple Music, etc.) during dictation and resumes afterward — uses MediaRemote framework on macOS, GSMTC on Windows, and MPRIS2 on Linux
- **Screen Recording Permission Flow (macOS)**: Optional onboarding step and in-app prompts for screen recording permission, required for meeting audio capture on macOS
- **Configurable Recorder Position**: Choose where the voice recorder panel appears on screen (top, bottom, center)
- **Auto-Paste Toggle**: New toggle in clipboard settings to enable/disable automatic pasting after transcription
- **Prompt Architecture Overhaul**: Centralized prompt definitions in `src/config/prompts.ts` with customizable agent system prompts
- **Dynamic Agent Window**: Agent overlay starts at full screen height with drag-to-resize support, persisted window bounds across sessions
- **Save Failed Transcriptions**: Failed transcriptions are now saved with their audio for later retry instead of being lost
- **Cloud Backup Toggle**: Unified cloud backup into a single toggle for simpler settings

### Changed

- **Removed Input Monitoring Requirement (macOS)**: Replaced CGEvent tap with NSEvent monitor for Globe/Fn key detection, eliminating the need for Input Monitoring privacy permission
- **Unified Screen Recording Permission UX**: Consolidated screen recording permission prompts across onboarding, meetings, and integrations into a consistent experience

### Fixed

- **Agent Panel Readability**: Made agent panel fully opaque for better text readability
- **Local Model Streaming**: Fixed local model support in agent streaming and resolved Metal OOM crash on macOS
- **Mic Auto-Gain**: Enabled microphone auto-gain and skip silent system audio chunks during meeting recording
- **Meeting Audio**: Fixed simultaneous system and mic audio capture for meetings
- **KDE Wayland Paste**: Fixed portal exit code 0 with no token being treated as success on KDE Wayland
- **Meeting Detection**: Suppressed false meeting detection when no active calendar meeting exists
- **OpenAI Realtime Session**: Fixed session configuration timing — now sends config after session created event with pcm16 format and VAD
- **Agent Hotkey Persistence**: Agent hotkey now properly persists to `.env` file across restarts
- **Sidebar Height**: Fixed sidebar not extending full window height
- **Empty Transcription Handling**: Silent return on empty transcription instead of pasting fallback string
- **Command Search Styling**: Fixed input styling, note type icons, sidebar spacing, and added deleted_at column support
- **Onboarding Accessibility UX**: Show device name in mic settings and improve accessibility permission guidance
- **Orphaned Trial Note**: Removed orphaned trialNote reference from free plan pricing
- **Portal-Based Tooltips**: Fixed tooltip positioning and replaced download action with reveal-in-folder
- **State-Aware Media Pause**: Don't unpause media that was already paused before dictation started
- **WebSocket Audio Buffering**: Parallelized WebSocket connection and audio capture, buffer early audio to prevent data loss at meeting start
- **Video Track Loopback**: Keep video tracks alive for loopback audio capture, remove invalid dispose call

## [1.5.5] - 2026-03-01

### Added

- **Mode-Aware File Size Validation**: Upload UI now enforces file size limits per transcription mode — local is unlimited, BYOK and Cloud free are capped at 25 MB, Cloud pro at 500 MB — with contextual messaging and CTA buttons (Create Account, Upgrade, Switch to Cloud)
- **Large File Chunking**: Files over 25 MB are automatically split via FFmpeg and transcribed in parallel with per-chunk progress reporting
- **Gemma 3 Local Models**: Added Gemma 3 (1B, 4B, 12B, 27B) to the local model registry with provider icon
- **Groq Model Updates**: Added new Groq models and removed deprecated ones (Maverick, Kimi K2 Instruct)
- **Notes Editor Formatting Shortcuts**: Cmd+B (bold), Cmd+I (italic), Cmd+E (code) keyboard shortcuts in the notes editor
- **Linux Wayland Paste Improvements**: Added ydotool support and improved wl-copy reliability for Wayland paste
- **Granular Build Scripts**: Added individual build target scripts for more flexible CI/CD

### Fixed

- **Fn/Globe Hotkey**: Fn key now correctly treated as equivalent to Globe key on macOS
- **GPU Activation**: Fixed GPU activation flow and Vulkan fallback behavior
- **Groq i18n**: Updated Groq model descriptions and added missing translations across all locales

## [1.5.4] - 2026-02-25

### Added

- **Auto-Learn Correction Monitoring**: Detects user edits after paste and automatically updates the custom dictionary with learned corrections; native text monitor binaries for macOS (AXObserver with PID-based AX targeting), Windows, and Linux (with download-first strategy and CI workflow for prebuilt binaries); undo button on auto-learned dictionary toast; dictionary settings UI with translations across all locales
- **Config-Driven STT Routing**: STT mode (batch vs streaming) now driven by `/api/stt-config` per context (dictation vs notes); streaming provider adapter map supports Deepgram and AssemblyAI, replacing hardcoded Deepgram IPC calls with a generic interface
- **Live Toggle in Notes**: "Live" toggle in NoteEditor lets users override between streaming and batch transcription for notes

### Fixed

- **STT Metadata Forwarding**: Forward complete STT metadata (`sttWordCount`, `sttLanguage`, actual Deepgram model, audio bytes, `stt_processing_ms`) and client end-to-end latency (`client_total_ms`) to API logging
- **BYOK Transcription Logging**: Fixed BYOK reasoning incorrectly suppressing transcribe logs

## [1.5.3] - 2026-02-24

### Added

- **Unified GPU Banners**: Replaced dual CUDA/Vulkan banners on the home screen with a single GPU acceleration banner; added GPU banners to Transcription Settings and AI Text Enhancement Settings
- **GpuStatusBadge Redesign**: Auto-retry flow (download → activating → GPU active) with 15s timeout, replacing confusing "CPU Only" and "Re-detect GPU" states; swapped hardcoded hex colors for `bg-success`/`bg-warning` design tokens
- **Streaming Usage Tracking**: Wired up the previously-uncalled `/api/streaming-usage` endpoint so Deepgram streaming transcriptions report word counts to the server
- **Cloud API Telemetry**: Forward STT metadata (`sttProvider`, `sttModel`, processing time, audio duration/size/format) and `clientVersion`/`clientType`/`appVersion` to all cloud API requests
- **Internationalization**: Added 15 missing i18n keys (`app.mic.*`, `app.commandMenu.*`, `app.toasts.*`, `app.oauth.*`, `notes.enhance.title`) across all 10 locale files

### Fixed

- **Windows Blank Screen**: Fixed blank screen on return from sleep/minimize by adding `render-process-gone` handler, `isCrashed()` health checks on show/tray/second-instance paths, `backgroundColor` and `backgroundThrottling` to window config, and `disable-gpu-compositing` for win32
- **IPC Echo Loop**: Broke infinite IPC bounce in floating icon auto-hide toggle by guarding the setter with an early return when the value hasn't changed
- **GPU Banner Navigation**: GPU banner "Enable GPU" button now navigates to the correct `"intelligence"` settings section instead of invalid `"reasoning"` ID
- **AI CTA Deep Link**: Replaced legacy `"aiModels"` alias with canonical `"intelligence"` section ID in the AI enhancement CTA button
- **Custom Endpoint Routing** (#311): Moved `reasoningProvider === "custom"` check to the top of `getModelProvider()` so custom endpoint models are never misrouted through built-in providers; custom models now show a neutral Globe icon
- **KDE Wayland Terminal Detection**: Detect Konsole via `kdotool` (fast path) or KWin `supportInformation` via `qdbus` (zero-install fallback) so terminals receive `Ctrl+Shift+V` instead of `Ctrl+V`
- **RAM Leak on Provider Switch**: Whisper, Parakeet, and llama-server processes now stop when switching to cloud providers, freeing loaded models from RAM
- **Streaming Usage Session Refresh**: Wrapped `cloudStreamingUsage` in `withSessionRefresh` so expired sessions auto-refresh instead of silently dropping word counts
- **Duplicate Transcription Logs**: Skip telemetry logging in streaming-usage and transcribe endpoints when reasoning is enabled (the `/api/reason` endpoint already creates the combined row)
- **Usage Cache Invalidation**: `useUsage` hook now listens for `usage-changed` events to invalidate its cache and refetch immediately after transcription
- **macOS Binary Architecture**: Added Mach-O header verification to globe-listener and fast-paste build scripts; force rebuild when architecture-specific hash file is missing; runtime architecture check before spawning binary
- **Globe Key Listener Resilience**: Auto-restart globe key listener on unexpected exit code 0 (sleep/wake invalidation); reset restart counter after sustained uptime; only treat "Failed to create event tap" as fatal
- **Parakeet Long Recordings**: Lowered max segment duration from 30s to 15s for more reliable chunked transcription; downgraded reasoning failure log from error to warn

## [1.5.2] - 2026-02-24

### Fixed

- **Reasoning Output**: Resolved empty output for Qwen3/GPT-OSS models by raising local inference minimum tokens from 100 to 512; fixed custom endpoint models misrouting by checking `reasoningProvider` setting before name heuristics
- **Google OAuth**: Added `newUserCallbackURL` to desktop Google OAuth flow for proper new user registration
- **Linux KDE Taskbar**: Prevented dictation panel from appearing in KDE taskbar
- **Intel Mac CI Builds**: Fixed binary architecture mismatch by installing x64 ffmpeg-static binary and preventing prebuild hooks from deleting x64 binaries on arm64 CI runners (#196)

## [1.5.1] - 2026-02-23

### Added

- **GPU-Accelerated Local Inference**: Vulkan (Windows/Linux) and Metal (macOS) support for llama-server with automatic CPU fallback and GPU status badge in the reasoning model selector
- **CUDA GPU Acceleration for Whisper**: NVIDIA GPU acceleration for local Whisper transcription with automatic GPU detection, upgrade banner for existing users, and shared download progress UI
- **On-Demand Vulkan Download**: Vulkan llama-server binary downloads on-demand when the user opts in, saving 40-46MB from the app installer

### Changed

- **Vulkan Llama-Server Architecture**: Switched from bundling the Vulkan binary to on-demand download into userData, mirroring the Whisper CUDA download pattern

### Fixed

- **macOS Paste Failure**: Replaced osascript-based accessibility check with Electron's native `isTrustedAccessibilityClient()` and fixed focus transfer using hide()+showInactive() instead of blur() on NSPanel (#313)
- **Windows Sherpa-onnx Extraction**: Fixed tar extraction failing on Windows due to GNU tar interpreting drive letter colons as remote host separators — now uses relative paths (#284)
- **macOS Auto-Update Architecture**: Detect Rosetta translation via `sysctl.proc_translated` so Apple Silicon users stuck on an x64 build from older releases self-heal to the native arm64 build on next update

## [1.5.0] - 2026-02-23

### Added

- **Notes System**: Full-featured note-taking built into the control panel
  - Create, edit, and organize notes with a rich Markdown editor
  - Organize notes into custom folders with a default Personal folder
  - Upload audio files for transcription directly into notes
  - Real-time dictation widget for transcribing directly into a note
  - Drag-and-drop to reorder notes and move between folders
  - Guided onboarding flow for first-time notes users
- **AI Actions on Notes**: Apply AI-powered actions to note content
  - Action picker with customizable processing prompts
  - Action manager dialog for creating and editing action templates
  - Processing overlay with live progress feedback
- **Sidebar Navigation**: Redesigned control panel with persistent sidebar
  - New `ControlPanelSidebar` replaces the old tab-based layout
  - Dedicated views for History, Notes, Dictionary, and Settings
  - Collapsible sidebar for more content space
- **Referral Program**: Invite friends to earn free Pro months
  - Referral dashboard with invite tracking and status badges
  - Email invitation flow
  - Animated spectrogram share card with unique referral code
- **New AI Models**: Added Claude 4.6 (Opus), Gemini 3 Flash, and Gemini 3.1 Pro to the model registry
- **Settings Store**: Migrated settings state management to Zustand store for better performance and shared access across components
- **Note Store & Action Store**: New Zustand stores for notes and AI action state

### Changed

- **Control Panel Architecture**: Extracted History, Dictionary, and Settings into standalone views, reducing ControlPanel complexity
- **Settings Refactor**: Extracted bulk of `useSettings` hook logic into `settingsStore.ts` for cleaner separation of concerns
- **UI Polish**: Updated numerous components with improved dark mode support, consistent spacing, and refined typography
- **Locale Updates**: Extended all 10 language files with notes, referral, and sidebar translation keys

### Fixed

- **macOS Auto-Update Architecture**: Detect Rosetta translation via `sysctl.proc_translated` so Apple Silicon users stuck on an x64 build from older releases self-heal to the native arm64 build on next update
- **Linux GTK Crash**: Force GTK3 on Linux startup to avoid GTK symbol crash on systems with GTK4 installed (#291)
- **CI Pipeline**: Added Windows paste binary and key listener download steps to the build workflow (#298)
- **Buy Me a Coffee**: Updated funding link username

## [1.4.11] - 2026-02-13

### Added

- **Japanese Locale**: Full Japanese UI and prompt translations
- **Windows Paste Terminal Detection**: Added kitty to the Windows fast paste binary's terminal class list

### Changed

- **Windows Push-to-Talk Refactor**: Moved PTT state management (hold timing, recording tracking, cooldown) from main process into `windowManager` for cleaner separation and consistency with macOS PTT patterns
- **Audio Recording Reentrancy Guards**: Added lock refs to `useAudioRecording` start/stop to prevent concurrent calls from rapid key presses
- **Synchronous Activation Mode**: `getActivationMode()` is now synchronous (reads from cache), removing unnecessary async overhead in all PTT and hotkey handlers
- **Default Agent Name**: Set default agent name to OpenWhispr

### Fixed

- **Hide vs Minimize**: Dictation panel now consistently hides (rather than minimizing on Windows/Linux) for uniform cross-platform behavior
- **Minimized Window Restore**: Dictation panel restores from minimized state before showing, preventing invisible panel on Windows

## [1.4.10] - 2026-02-13

### Added

- **Deepgram Streaming Liveness Check**: Detects unresponsive warm connections within 2.5s and transparently reconnects with audio replay
- **Batch Transcription Fallback**: If streaming produces no text, automatically falls back to batch transcription via OpenWhispr Cloud
- **Full Locale Codes**: Pass full locale codes (e.g. en-US, zh-CN) to Deepgram instead of stripping to base codes, preserving dialect precision

### Fixed

- **Deepgram Token Expiry**: Fixed token expiry clock resetting on every re-warm cycle, which prevented detection of expired tokens and caused persistent 401 errors
- **Deepgram 401 Recovery**: Invalidate cached tokens on authentication failures so subsequent attempts fetch fresh tokens instead of retrying stale ones

## [1.4.9] - 2026-02-12

### Fixed

- **Deepgram Nova-3 Language Fallback**: Automatically fall back to Nova-2 for languages not yet supported by Nova-3 (e.g., Chinese, Thai), preventing 400 Bad Request errors. Also switches from `keyterm` to `keywords` parameter when using Nova-2.

## [1.4.8] - 2026-02-12

### Added
- **Referral Program**: Invite friends to earn free Pro months with referral dashboard, email invitations, invite tracking with status badges, and animated spectrogram share card with unique referral code
- **Notes System**: Added sidebar navigation with notes system and dictionary view for organizing transcriptions
- **Folder Organization**: Notes can be organized into custom folders with a default Personal folder, folder management UI, and folder-aware note filtering. Upload flow now includes folder selection
- **Internationalization v1**: Full desktop localization across auth, settings, hooks, and UI with centralized renderer locale resources (#258)
- **Chinese Language Split**: Split Chinese into Simplified (zh-CN) and Traditional (zh-TW) with tailored AI instructions and one-time migration for existing users (#267)
- **Russian Interface Language**: Added Russian to interface language options
- **Deepgram Token Refresh & Keyterms**: Proactive token rotation for warm connections before expiry and keyterms pass-through for improved transcription accuracy

### Fixed

- **macOS Non-English Keyboard Paste**: Fixed paste not working on non-English keyboard layouts (Russian, Ukrainian, etc.) by using physical key code instead of character-based keystroke in AppleScript fallback
- **Whisper Language Auto-Detection**: Pass `--language auto` to whisper.cpp explicitly so non-English audio isn't forced to English (#260)
- **Model Download Pipeline**: Inline redirect handling, deferred write stream creation, indeterminate progress bar for unknown sizes, and Parakeet ONNX file validation after extraction
- **Sherpa-onnx Shared Libraries**: Always overwrite shared libraries during download to prevent stale architecture-mismatched binaries, with `--force` support
- **Chinese Translation Fixes**: Minor translation corrections for Chinese interface strings
- **Neon Auth Build Config**: Fixed auth build configuration

## [1.4.7] - 2026-02-11

### Added

- **Deepgram Streaming Transcription**: Migrated real-time streaming transcription from AssemblyAI to Deepgram for improved reliability and accuracy (#249)

### Fixed

- **BYOK After Upgrade**: Prefer localStorage API keys over process.env so Bring Your Own Key mode works correctly after upgrading (#263)
- **PTT Double-Fire Prevention**: Applied post-stop cooldown and press-identity checks to both macOS and Windows push-to-talk handlers
- **Archive Extraction Retry**: Reuse existing archive on extraction retry with improved error handling
- **Email Verification Polling**: Pass email param in verification polling and stop on 401 responses
- **Auth Build Bundling**: Added @neondatabase/auth packages to rollup externals for correct production bundling (#256)
- **Neon Auth Build Config**: Fixed Vite build configuration for Neon Auth packages (#266)

### Changed

- **Build System**: Bumped Node version in build files

## [1.4.6] - 2026-02-10

### Added

- **Robust Model Downloads**: Hardened download pipeline with stall detection, disk space checks, and file validation for more reliable model installs
- **Prompt Handling Improvements**: Improved agent name resolution, prompt studio enhancements, and smarter prompt context assembly
- **Past-Due Subscription Handling**: Users with past-due subscriptions now see clear messaging and recovery options

### Fixed

- **Parakeet Long Audio**: Fixed empty transcriptions for long audio by segmenting input before sending to Parakeet
- **Plus-Addressed Emails**: Reject plus-addressed emails (e.g., user+tag@example.com) during authentication
- **Double-Click Prevention**: Prevent duplicate requests when double-clicking checkout and billing buttons
- **Auth Initialization Race**: Await init-user before completing auth flow and fix missing user dependency

### Changed

- **Startup Performance**: Preload lazy chunks during auth initialization for faster page transitions
- **Code Cleanup**: Removed excess comments and simplified window management logic

## [1.4.5] - 2026-02-09

### Added

- **Dictation Sound Effects Toggle**: New setting to enable/disable dictation audio cues with refined tones (warmer, softer frequencies, gentler attack, distinct start/stop)
- **Toast Notification Redesign**: Redesigned toast notifications as dark HUD surfaces for a more polished look
- **Floating Icon Auto-Hide**: New setting to auto-hide the floating dictation icon
- **Loading Screen Redesign**: Branded loading screen with logo and spinner
- **Discord Support Link**: Added Discord link to the support menu
- **Auth-Aware Routing**: Returning signed-out users now see a re-authentication screen instead of a broken state

### Fixed

- **Dropdown Dark Mode**: Fixed dropdown styling in dark mode
- **Toast Dark Mode**: Fixed toast colouring in dark mode
- **Globe Key Persistence**: Globe key now persists to .env and dictation key syncs to localStorage
- **Globe Listener Cross-Compilation**: Cross-compiled globe listener for x64

### Changed

- **Startup Performance**: Deferred non-critical manager initialization after window creation, lazy-loaded ControlPanel/OnboardingFlow/SettingsModal, converted env file writes to async, extracted SettingsProvider context, and split Radix/lucide into separate vendor chunks
- **Scrollbar Styling**: Subtle transparent-track scrollbar with thinner floating thumb

## [1.4.4] - 2026-02-08

### Fixed

- **AI Enhancement CTA Persistence**: Dismissing the "Enable AI Enhancement" banner now persists to localStorage so it stays hidden across sessions

### Changed

- **Code Cleanup**: Removed excess comments and section dividers in ControlPanel

## [1.4.3] - 2026-02-08

### Added

- **Mistral Voxtral Transcription**: Added Mistral as a cloud transcription provider with Voxtral Mini model and custom dictionary support via context_bias
- **TypeScript Compilation**: Added TypeScript as an explicit dev dependency with project-level `tsconfig.json`

### Fixed

- **Linux Wayland Clipboard**: Persistent clipboard ownership on Wayland so Ctrl+V works reliably after transcription
- **Linux Window Flickering**: Fixed transparent window flickering on Wayland and X11 compositors
- **Windows Modifier-Only Hotkeys**: Support modifier-only hotkeys on Windows via native keyboard hook
- **Update Installation**: Resolved quitAndInstall hang by removing close listeners that block window shutdown during updates
- **Custom System Prompts**: Pass custom system prompt to local and Anthropic BYOK reasoning
- **Audio Cue Audibility**: Improved dictation start/stop audio cue volume
- **Language Selector**: Fixed dropdown positioning and sizing inside settings modal
- **Type Safety**: Tightened Electron IPC callback return types, model picker styles, toast variant types, and event handler signatures across the codebase

### Changed

- **Code Cleanup**: Removed excess comments, section dividers, and redundant JSDoc across components, hooks, and utilities

## [1.4.2] - 2026-02-07

### Fixed

- **AssemblyAI Streaming Reliability**: Fixed real-time WebSocket going silent after idle periods by adding keep-alive pings, readyState validation, re-warm recovery, and connection death handling

## [1.4.1] - 2026-02-07

### Added

- **Runtime .env Configuration**: Environment variables now reload at runtime without requiring app restart
- **Settings Retention on Pro**: Pro subscribers retain their settings when managing their subscription

### Fixed

- **macOS Microphone Permission**: Resolved hardened-runtime mic permission prompt by routing through main-process IPC and unifying API key cache invalidation with event-based AudioManager sync
- **AudioWorklet ASAR Loading**: Inlined AudioWorklet as blob URL to fix module loading failure in packaged ASAR builds
- **Google OAuth Flow**: OAuth now opens in the system browser with deep link callback instead of navigating the Electron window
- **Auth Security Hardening**: Safe JSON parsing, guarded URL constructor, and fixed error information leaks in auth code
- **Deep Link Focus**: Control panel now correctly receives focus when opened via deep link
- **Neon Auth Electron Compatibility**: Routed auth flows through API proxy and fixed Origin header rejection for desktop app
- **Billing Error Visibility**: Checkout and billing errors now surface as toast notifications instead of failing silently
- **Hotkey Persistence**: Added file-based hotkey storage for reliable startup persistence (#181)
- **Email Verification**: Disabled Neon Auth email verification step for smoother onboarding

### Changed

- **Build Optimization**: Binary dependencies are now cached during build for faster CI
- **UI Polish**: Fixed scrollbar styling, provider button styling, and voice recorder icon fill

## [1.4.0] - 2026-02-06

### Added

- **OpenWhispr Cloud**: Cloud-native transcription service — sign in and transcribe without managing API keys
  - Google OAuth and email/password authentication via Neon Auth
  - Email verification flow with polling and resend support
  - Password reset via email magic links
- **Subscription & Billing**: Free and Pro plans with Stripe-powered payments
  - Free plan with rolling weekly word limits (2,000 words/week)
  - Pro plan with unlimited transcriptions
  - 7-day free trial for new accounts with countdown display
  - In-app upgrade prompts when approaching or reaching usage limits
  - Stripe billing portal access for Pro subscribers
- **Usage Tracking**: Real-time usage display with progress bar, color-coded thresholds, and next billing date
- **Account Section in Settings**: Profile display, plan status badge, usage bar, billing management, and sign out
- **Upgrade Prompt Dialog**: When usage limit is reached, offers three paths — upgrade to Pro, bring your own key, or switch to local
- **Cancel Processing Button**: Cancel ongoing transcription processing mid-flight
- **Dynamic Window Resizing**: Window automatically resizes based on command menu and toast visibility
- **Dark Mode Icon Inversion**: Monochrome provider icons now automatically invert in dark mode for better visibility

### Changed

- **Onboarding Redesign**: Auth-first onboarding flow
  - Signed-in users get a streamlined 3-step flow (Welcome → Setup → Activation)
  - Non-signed-in users get a 4-step flow with transcription mode selection
  - Permissions merged into Setup step for signed-in users
- **Transcription Mode Architecture**: Unified mode selection across OpenWhispr Cloud, Bring Your Own Key (BYOK), and Local
  - Signed-in users default to OpenWhispr Cloud
  - Non-signed-in users choose between BYOK and Local
- **Design System Overhaul**: Complete refactor of styling to use design tokens throughout the codebase
  - Button component now uses `text-foreground`, `bg-muted`, `border-border` instead of hardcoded hex values
  - Removed hardcoded classes and inline styles across components
  - Improved button and badge consistency
- **Settings UI Redesign**: Overhauled all settings pages with unified panel system, redesigned sidebar, and extracted permissions section
- **Dark Mode Polish**: Premium button styling, glass morphism toasts, and streamlined visuals
- **App Channel Isolation**: Development, staging, and production channels now use isolated user data directories

### Fixed

- **Light Mode UI Visibility**: Fixed multiple UI elements that were invisible or hard to see in light mode:
  - Settings gear icon in permission cards now uses `text-foreground`
  - Troubleshoot button uses proper foreground color
  - Reset button in developer settings now correctly shows destructive color
  - Settings and Help icons in the toolbar are now properly visible
  - Check for Updates button now renders correctly in light mode
- **Provider Tab Flashing**: Resolved TranscriptionModelPicker tab flashing by extracting ModeToggle component and syncing internal state with props
- **Local Reasoning Model Persistence**: Fixed local reasoning model selection not persisting correctly
- **Parakeet Model Status**: Added dedicated IPC channel for Parakeet model status checks
- **Groq Qwen3 Models**: Removed thinking tokens from Qwen3 models on Groq provider
- **OAuth Session Grace Period**: Automatic session refresh with exponential backoff retry during initial OAuth establishment

## [1.3.3] - 2026-01-28

### Added

- **ONNX Warm-up Inference**: Parakeet server now runs warm-up inference on start to eliminate first-request latency from JIT compilation
- **Startup Preferences Sync**: Renderer startup preferences are now synced to `.env` for server pre-warming on restart

### Changed

- **macOS Tray Behavior**: Hide to tray on macOS for consistent cross-platform behavior

### Fixed

- **macOS Launch Crash**: Added `disable-library-validation` entitlement to resolve macOS launch crash (#120)
- **Reasoning Model Default**: Fixed `useReasoningModel` not correctly defaulting to enabled by persisting useLocalStorage defaults and aligning direct reads
- **Windows Non-ASCII Usernames**: Resolved whisper-server crash on Windows with non-ASCII usernames by pre-converting audio to WAV and routing temp files through ASCII-safe directory
- **Windows Paths with Spaces**: Fixed temp directory fallback to also detect paths with spaces on Windows

## [1.3.2] - 2026-01-27

### Changed

- **Linux Paste Tools**: Prefer xdotool over ydotool for better compatibility

### Fixed

- **Windows Zip Extraction**: Use tar instead of PowerShell Expand-Archive for zip extraction on Windows to avoid issues with special characters

## [1.3.1] - 2026-01-27

### Changed

- **Download System Refactor**: Consolidated model download logic into shared utilities with resume support, retry logic, abort signals, and improved installing state UI
- **Throttled Progress Display**: Whisper model download progress updates are now throttled for smoother UI

## [1.3.0] - 2026-01-26

### Added

- **NVIDIA Parakeet Support**: Fast local transcription via sherpa-onnx runtime with INT8 quantized models
  - `parakeet-tdt-0.6b-v3`: Multilingual (25 languages), ~680MB
- **Windows Push-to-Talk**: Native Windows key listener with low-level keyboard hook for true push-to-talk functionality
  - Supports compound hotkeys like `Ctrl+Shift+F11` or `CommandOrControl+Space`
  - Prebuilt binary automatically downloaded from GitHub releases
  - Fallback to tap mode if binary unavailable
- **Custom Dictionary**: Improve transcription accuracy for specific words, names, and technical terms
  - Add custom words through Settings → Custom Dictionary
  - Words are passed as hints to Whisper for better recognition
  - Works with both local and cloud transcription
- **GitHub Actions Workflow**: Automated CI workflow to build and release Windows key listener binary
- **Shared Download Utilities**: New `scripts/lib/download-utils.js` module with reusable download, extraction, and GitHub release fetching functions

### Changed

- **Download Scripts Refactored**: All download scripts now use shared utilities for consistency
- **GitHub API Authentication**: Download scripts support `GITHUB_TOKEN` to avoid API rate limits in CI
- **Debug Logging Cleanup**: Extracted common window loading code and cleaned up debug logging

### Fixed

- **GNOME Wayland Hotkey Improvements**: Improved hotkey handling on GNOME Wayland
- **Hotkey Persistence**: Fixed hotkey selection not persisting correctly
- **Custom Endpoint API Keys**: Fixed custom endpoint API keys not persisting to `.env` file
- **Custom Endpoint State**: Fixed custom endpoint using shared state instead of its own
- **Linux Stale Hotkey Registrations**: Clear stale hotkey registrations on startup on Linux
- **Wayland XWayland Paste**: Try xdotool on Wayland when XWayland is available
- **llama-server Libraries**: Bundle llama-server shared libraries and search from extract root for varying archive structures
- **STT/Reasoning Debug Logging**: Added missing debug logging for STT and reasoning pipelines

## [1.2.16] - 2026-01-24

### Fixed

- **App Startup Hang**: Fixed app initialization timing issues with Electron 36+
- **Manager Initialization**: Deferred manager initialization until after `app.whenReady()` to prevent hangs
- **Debug Logger Initialization**: Deferred debugLogger file initialization until `app.whenReady()`
- **Config Bundling**: Fixed missing config files in production builds
- **whisper.cpp Binary Version**: Updated whisper.cpp release names and bumped binary version

## [1.2.15] - 2026-01-22

### Added

- **ydotool Fallback for Linux**: Added ydotool as additional fallback option for clipboard paste operations on Linux systems

### Changed

- **Unified Prompt System**: Refactored to single intelligent prompt system for improved consistency and maintainability
- **whisper.cpp Remote**: Refactored remote whisper.cpp integration for better reliability

## [1.2.14] - 2026-01-22

### Added

- **Troubleshooting Mode**: New debug logging section in settings with toggle for detailed diagnostic logs, log file path display, and direct folder access for easier support
- **Custom Transcription Endpoint**: Support for custom OpenAI-compatible transcription endpoints with configurable base URLs
- **Enhanced Clipboard Debugging**: Detailed clipboard operation logging for diagnosing paste issues across platforms

### Changed

- **API Key Management**: Consolidated and refactored API key persistence with improved .env file handling and recovery mechanisms
- **Local Network Detection**: Refactored URL detection into reusable utility for better code organization
- **Electron Builder**: Updated to latest version for improved build performance

### Fixed

- **Windows/Linux Taskbar**: Prevented dual taskbar entries on Windows and Linux by properly configuring window behavior
- **Single Instance Lock**: Enforced single instance lock with cleaner window state checks
- **Model Provider Consistency**: Removed redundant fallbacks and ensured consistent use of getModelProvider()
- **Cross-env Support**: Fixed Windows compatibility in pack script using cross-env
- **Linux X11 Paste**: Improved paste reliability by capturing target window ID upfront with windowactivate --sync, added xdotool type fallback for terminals
- **Tray Minimize**: Fixed minimize to tray functionality

## [1.2.12] - 2026-01-20

### Added

- **LLM Download Cancellation**: Added ability to cancel in-progress local LLM model downloads with throttled progress updates to prevent UI flashing

### Changed

- **Gemini Model Updates**: Updated Gemini models to latest versions
- **Linux Wayland Improvements**: Improved Wayland paste detection with GNOME-specific handling and XWayland fallback support
- **whisper.cpp CUDA Support**: Updated whisper.cpp download script to include CUDA-enabled binaries

### Fixed

- **Windows Paste Delay**: Adjusted paste delay timing on Windows for more reliable text insertion
- **Blank Audio Prevention**: Fixed issue where blank/silent audio recordings would paste empty text
- **Newline Handling**: Fixed newline formatting issues in transcribed text

## [1.2.11] - 2026-01-18

### Fixed

- **ASAR Path Resolution**: Fixed path resolution issues for bundled resources in packaged builds
- **Update Checker**: Fixed auto-update checker initialization
- **Build Includes**: Ensured services and models are properly included in production builds
- **OS Module Import**: Fixed OS module import ordering

## [1.2.10] - 2026-01-17

### Fixed

- **Streaming Backpressure**: Fixed proper streaming backpressure handling in audio processing
- **Quit and Install**: Fixed update installation on app quit

## [1.2.9] - 2026-01-17

### Fixed

- **Path Resolution**: Improved path resolution for better cross-platform compatibility

## [1.2.8] - 2026-01-16

### Added

- **Microphone Input Selection**: Choose your preferred microphone input device in settings, with built-in mic preference to prevent Bluetooth audio interruptions
- **Push to Talk Mode**: New recording mode option alongside the existing toggle mode
- **Hotkey Listening Mode**: Prevents conflicts when capturing new hotkeys by temporarily disabling the global hotkey
- **Hotkey Fallback System**: Automatic fallback with user notifications when preferred hotkey is unavailable
- **Cross-Platform Accessibility Settings**: Quick access to system accessibility settings on macOS

### Changed

- **Streamlined Onboarding**: Removed redundant "How it Works" section, success dialogs, and manual save buttons for a smoother setup experience
- **Improved Select Styling**: Enhanced dropdown select component appearance

### Fixed

- **FFmpeg Availability Types**: Corrected type definitions and optimized whisper-cpp download process
- **Whisper Models Path**: Fixed model storage path resolution
- **Better Path Resolution**: Improved error handling for file paths
- **Open Mic Settings**: Fixed system settings link for microphone configuration

## [1.2.7] - 2026-01-13

### Added

- **Whisper Server HTTP Mode**: Added persistent whisper-server for faster repeated transcriptions with automatic CLI fallback
- **Pipeline Timing Instrumentation**: Added detailed timing logs for each stage of the transcription pipeline
- **Whisper Server Pre-warming**: Server pre-warms on startup for faster first transcription

### Changed

- **Windows Clipboard**: Reduced clipboard delays for faster text pasting on Windows

### Fixed

- **Windows Update Install**: Simplified Windows update installation by using silent mode and removing redundant before-quit handling
- **Mac Build Workflows**: Fixed CI/CD to run separate workflows for Mac builds
- **Mac DMG Build Race Condition**: Fixed release workflow DMG build failure caused by concurrent arm64/x64 builds mounting same volume
- **Windows Download Script**: Fixed PowerShell Expand-Archive failure with bracket characters in directory names

## [1.2.6] - 2026-01-13

### Changed

- **Settings Layout**: Moved settings navigation to left side on Windows and Linux for improved consistency

### Fixed

- **Linux Whisper Detection**: Fixed issue where Python-based Whisper could be used instead of whisper.cpp on Linux systems

## [1.2.5] - 2026-01-13

### Added

- **Model Validation**: Added validation when deleting or loading Whisper models to ensure model integrity
- **Download Cancellation**: Added ability to cancel in-progress model downloads in whisper pickers
- **Windows Paste Performance**: Added nircmd for faster text pasting on Windows

### Fixed

- **EventEmitter Memory Leak**: Fixed memory leak caused by duplicate listener registration in useUpdater hook across ControlPanel and SettingsPage components
- **FFmpeg Path Resolution**: Fixed FFmpeg path resolution in unpacked ASAR for local whisper.cpp transcription

### Changed

- **UI Cleanup**: Removed redundant UI elements for a cleaner interface

## [1.2.4] - 2026-01-13

### Changed

- **whisper.cpp Packaging**: Moved whisper.cpp binaries from ASAR to extraResources for improved reliability and faster startup

### Fixed

- **Package Lock Sync**: Fixed package-lock.json synchronization with package.json dependencies

## [1.2.3] - 2026-01-13

### Added

- **Extended Hotkey Support**: Added numpad keys, media keys, and additional special keys (Pause, ScrollLock, PrintScreen, NumLock) for hotkey selection
- **Improved Hotkey Error Messages**: Registration failures now include helpful suggestions for alternative hotkeys

### Changed

- **Linux Paste Tools**: Only show paste tools installation prompt on Linux when tools are not available

### Fixed

- **Hotkey Debugging**: Added comprehensive debug logging to hotkey manager for troubleshooting registration issues

## [1.2.2] - 2026-01-13

### Fixed

- **React Version Mismatch**: Fixed blank screen caused by incompatible React and React-DOM versions in package-lock.json

## [1.2.1] - 2026-01-13

### Fixed

- **Blank Screen on Upgrade**: Fixed white screen issue for users upgrading from older versions with different onboarding step counts. The onboarding step index is now properly clamped to valid range.

## [1.2.0] - 2026-01-13

### Added

- **Delete All Whisper Models**: New option to delete all downloaded Whisper models at once
- **Model Deletion Confirmation**: Added confirmation dialog when deleting models in settings

### Changed

- **Migrated to whisper.cpp**: Replaced Python-based Whisper with native whisper.cpp for faster, more reliable transcription
  - No longer requires Python installation
  - WebM-to-WAV audio conversion built-in
  - Significantly improved startup and transcription speed
- **Streamlined Onboarding**: Simplified setup flow with fewer steps now that Python is not required
- **Download Cancellation**: Added ability to cancel in-progress model downloads
- **CI/CD Updates**: Updated build and release workflows

### Fixed

- **IPC Handler**: Fixed broken IPC handler for model operations
- **Logging**: Standardized logging across the application
- **React Hook Dependencies**: Improved React hook dependency arrays for better performance
- **Button Styling**: Fixed button styling consistency across the application

### Removed

- **Python Dependency**: Removed Python requirement and all related installation code
- **whisper_bridge.py**: Removed Python-based Whisper bridge in favor of native whisper.cpp

## [1.1.2] - 2026-01-12

### Added

- **Linux Package Dependencies**: Recommended xdotool, wtype, and python3 packages for Linux users

### Fixed

- **Python Installation Race Condition**: Fixed race condition in Python installation check that could cause installation to fail or hang

## [1.1.1] - 2026-01-12

### Added

- **Cross-Platform Paste Tools Detection**: Onboarding now detects and guides users through installing paste tools on Linux and Windows with auto-grant accessibility

### Changed

- **Qwen Model Compatibility**: Disabled thinking mode for Qwen models on Groq to prevent compatibility issues
- **Model Registry Refactor**: disableThinking flag now uses the centralized model registry
- **Consolidated ColorScheme Types**: Removed redundant default exports and cleaned up inline font styles
- **Provider Icons**: Use static imports for provider icons to fix Vite bundling issues

### Fixed

- **Recording Cancellation**: Restored cancel recording functionality that was accidentally removed
- **Model Downloads**: Implemented atomic downloads with temp file pattern and robust cleanup handling for cross-platform reliability
- **Incomplete Download Prevention**: Model file size validation now prevents incomplete downloads from showing as complete
- **Windows PowerShell Performance**: Optimized paste startup time on Windows

## [1.1.0] - 2026-01-10

### Added

- **Compound Hotkey Support**: Use multi-key combinations like `Cmd+Shift+K` or `Ctrl+Alt+D` for dictation
- **Groq API Integration**: Ultra-fast AI inference with Groq's cloud API
- **Auto-Update UI**: Download progress bars and install button in settings
- **Recording Cancellation**: Cancel an in-progress recording without transcribing
- **Release Notes Viewer**: Markdown-rendered release notes in settings

### Changed

- **Major Hotkey Refactor**: Complete rewrite of hotkey selection with improved reliability and validation
- **Consolidated Model Registry**: Single source of truth for all AI models (`modelRegistryData.json`)
- **Unified Model Picker**: Reusable component for both transcription and reasoning model selection
- **Improved Latency Logging**: Numbered stage logs for recording, transcription, reasoning, and paste timing
- **Reduced Paste Delay**: Lowered from 100ms to 50ms for faster text insertion
- **Code Quality**: Added ESLint, Prettier for JS/TS, and Ruff for Python

### Fixed

- **Windows 11 Compatibility**: Fixed PATH separator, cache directories, and process termination
- **Python Virtual Environment**: Fixed race condition and added Arch Linux venv support
- **Microphone Detection**: Improved onboarding flow for missing inputs with deep-linking to system settings
- **Recording State Alignment**: Recording now aligns to MediaRecorder's actual start/stop events
- **Caching Optimizations**: Cached accessibility, paste tool, and FFmpeg checks to reduce process spawns
- **Window Titles**: Electron window titles now set correctly after page load

## [1.0.15] - 2026-01-05

### Added

- Button to fully quit OpenWhispr processes from the application
- Linux terminal detection with automatic paste key switching (Ctrl+Shift+V for terminals)

### Changed

- Standardized logging on log levels with renderer IPC and `.env` refresh for consistent debug output

### Fixed

- Use `kdotool` for Wayland terminal detection, improving clipboard paste reliability
- Increased delay before restoring clipboard to avoid race conditions during paste operations
- Persist OpenAI key before onboarding test to prevent key loss during setup
- Windows Python discovery now correctly handles output parsing
- Keep FFmpeg debug schema as boolean type
- Fixed OpenWhispr documentation paths
- Windows: Resolved issue #16 with WAV validation, registry-based Python detection, and normalized FFmpeg paths

## [1.0.13] - 2025-12-24

### Added

- Enhanced Linux support with Wayland compatibility, multiple package formats (AppImage, deb, rpm, Flatpak), and native window controls
- Auto-detect existing Python during onboarding and gate the installer with a recheck option
- "Use Existing Python" skip flow to onboarding with confirmation dialog

### Changed

- Reuse audio manager and stabilize dictation toggle callback to fix recording latency
- Add cleanup functions to IPC listeners to prevent memory leaks
- Make Flatpak opt-in for local builds only

### Fixed

- Optimized transcription pipeline with caching, batched reads, and non-blocking operations for improved performance
- Reference error in settings page
- Removed redundant audio listener causing unnecessary processing
- Added IPC listener cleanup to prevent memory leaks
- Performance improvements: removed duplicate useEffect, fixed blur causing re-renders

### CI/CD

- Add caching for Electron and Flatpak downloads
- Add Flatpak runtime installation to workflow
- Add Linux packaging dependencies to GitHub Actions workflow

## [1.0.12] - 2025-11-13

### Added

- Added `scripts/complete-uninstall.sh` plus a new TROUBLESHOOTING guide so you can collect arch diagnostics, clean caches, and reset permissions before reinstalling stubborn builds.
- Control Panel history now auto-refreshes through a shared store and IPC events, so new, deleted, or cleared transcripts sync instantly without a manual refresh.
- Distribution artifacts now include both Apple Silicon and Intel macOS DMG/ZIP outputs, and the README documents Debian/Ubuntu packaging along with optional `xdotool` support.

### Changed

- The onboarding flow now validates dictation hotkeys before letting you continue, remembers whether cloud auth was skipped, and only persists sanitized API keys once supplied.
- History entries normalize timestamps and no longer run the removed legacy text cleanup helper, so the UI shows the exact Whisper output that was saved.

### Fixed

- Local Whisper now finds Python on Windows more reliably by scanning typical install paths, honoring `OPENWHISPR_PYTHON`, and surfacing actionable ENOENT guidance.
- Whisper installs automatically retry pip operations that hit PEP‑668, TOML, or permission errors, sanitizing the output and falling back to `--user` + legacy resolver when needed.

## [1.0.11] - 2025-10-13

### Added

- Settings, onboarding, and the AI model selector now accept OpenAI-compatible custom base URLs for both transcription and reasoning providers, complete with validation and reset helpers.
- Windows now gets full tray behavior: closing the control panel hides it to the tray, left-click reopens it, and the UI adds a native close button.

### Changed

- ReasoningService sends both `input` and `messages` payloads and automatically falls back between `/responses` and `/chat/completions` so older OpenAI-compatible endpoints keep working.

### Fixed

- Successful endpoint detection is cached per base URL, so the app remembers whether to call `/responses` or `/chat/completions` instead of retrying the wrong path forever.
- Custom endpoint fields now enforce HTTPS (with localhost as the lone exception) across the UI and services, preventing API keys from ever leaving over plain HTTP.

## [1.0.10] - 2025-10-07

### Added

- Added a `compile:globe` build step that emits a macOS Globe listener binary into `resources/bin` before every dev, pack, or dist command so the hotkey ships with all builds.

### Fixed

- Globe key failures now raise a macOS dialog, verify the bundled binary is executable, and kill/restart the listener cleanly so the shortcut survives packaging.

## [1.0.9] - 2025-10-07

### Changed

- Simplified the release workflow by removing the bespoke GitHub release job and letting electron-builder upload draft releases directly.

## [1.0.8] - 2025-10-03

### Fixed

- Globe/Fn hotkey reliability improved by showing the dictation panel before toggling, making focus optional, and surfacing listener spawn errors instead of failing silently.

## [1.0.7] - 2025-10-03

### Added

- Settings update controls now show download progress bars, install countdowns, and clearer messaging while fetching or installing new builds.

### Changed

- Auto-update internals now track listeners, cache the last release metadata, and keep auto-download/auto-install disabled until the user explicitly triggers an update, eliminating the previous memory leaks.

### Fixed

- `Install & Restart` now emits `before-quit`, enables `autoInstallOnAppQuit`, logs progress, and calls `quitAndInstall(false, true)` so updates actually apply when quitting or pressing the button.

## [1.0.6] - 2025-09-11

### Added

- **Dictation Panel Command Menu**: Clicking the floating panel reveals quick actions, including a one-click "Hide this for now" option.
- **macOS Globe Key Support**: Added a lightweight Swift listener so the Globe/Fn key can toggle dictation across the system.
- **Globe Key Selection UI**: Settings and onboarding keyboards now include a dedicated Globe key option.
- **Hotkey Validation**: Settings and onboarding now verify shortcut registration immediately, alerting users when a key can’t be bound.
- **Model Cache Cleanup**: Added an in-app command (and installer/uninstaller hooks) to delete all cached Whisper models.
- **Tray Controls**: macOS tray menu gained quick actions to show or hide the dictation panel.

### Changed

- **Dictation Overlay Placement**: Window now anchors to the active workspace's bottom-right corner with a safety margin, preventing it from sliding off-screen on multi-monitor setups.
- **Dictation Overlay Canvas**: Enlarged the floating window so tooltips, menus, and error states render without being clipped while keeping click-through behaviour outside interactive elements.
- **Keyboard UX**: Virtual keyboard hides macOS-exclusive keys on Windows/Linux and standardises hotkey labels.

### Fixed

- **macOS Window Lifecycle**: Ensured the dictation panel keeps the app visible in Dock and Command-Tab while retaining floating behaviour across spaces.
- **Control Panel Stability**: Reworked close/minimize handling so the panel stays interactive when switching apps and reopens cleanly without spawning duplicate windows.
- **Always-On-Top Enforcement**: Centralised the logic that reapplies floating window levels, eliminating redundant timers and focus quirks.
- **Menu Labelling**: macOS application menu items now display the correct OpenWhispr casing instead of "open-whispr".
- **Non-mac Hotkey Guard**: Prevented the mac-only Globe shortcut from being saved on Windows/Linux.

## [1.0.5] - 2025-09-10

### Fixed

- **Build System**: Fixed native module signing conflicts on macOS
  - Added `npmRebuild: true` to force rebuild of native modules during packaging
  - Added `buildDependenciesFromSource: true` to compile native dependencies from source
  - Added `better-sqlite3` to `asarUnpack` array to properly unpack SQLite3 native module
  - Resolves "different Team IDs" error when launching notarized macOS apps
- **CI/CD Pipeline**: Fixed automated release workflow issues
  - Removed automatic version update step from release workflow (version should be set before tagging)
  - Added `contents: write` permission to allow workflow to create GitHub releases
  - Fixes "Resource not accessible by integration" error during releases

### Technical Details

- This is a maintenance release focusing on build reliability and deployment infrastructure
- No feature changes or user-facing functionality updates
- All changes related to packaging, signing, and automated release processes

## [1.0.4] - 2025-09-09

### Added

- **Multi-Provider AI Support**: Integrated three major AI providers for text processing
  - OpenAI: Complete model suite including:
    - GPT-5 Series (Nano/Mini/Full) - Latest generation with deep reasoning
    - GPT-4.1 Series (Nano/Mini/Full) - Enhanced coding, 1M token context, June 2024 knowledge
    - o-series (o3/o3-pro/o4-mini) - Advanced reasoning models with extended thinking time
    - GPT-4o/4o-mini - Multimodal models with vision support
  - Anthropic: Claude Opus 4.1, Sonnet 4, and 3.5 variants for frontier intelligence
  - Google: Gemini 2.5 Pro/Flash/Flash-Lite and 2.0 Flash for advanced processing
- **OpenAI Responses API Integration**: Migrated from Chat Completions to the new Responses API
  - Simplified request format with `input` array instead of `messages`
  - New response parsing for `output` items with typed content
  - Automatic handling of model-specific requirements
  - Better support for GPT-5 and o-series reasoning models
- **Enhanced Reasoning Service**: Complete TypeScript rewrite with provider abstraction
  - Automatic provider detection based on selected model
  - Secure API key caching with TTL
  - Unified retry strategies across all providers
  - Provider-specific token optimization (up to 8192 for Gemini)
- **Comprehensive Debug Logging**: Enhanced reasoning pipeline with stage-by-stage logging
  - Provider selection and routing logs
  - API key retrieval and validation logs
  - Request/response details for all providers
  - Error tracking with full stack traces
- **Improved Settings UI**: Comprehensive API key management for all providers
  - Color-coded provider sections (OpenAI=green, Anthropic=purple, Gemini=blue)
  - Inline API key validation and secure storage
  - Provider-specific model selection with descriptions

### Changed

- **Default AI Model**: Updated from GPT-3.5 Turbo to GPT-4o Mini for cost-efficient multimodal support
- **Model Updates**: Refreshed all AI models to their latest 2025 versions
  - OpenAI: Added GPT-5 family (released August 2025), migrated to Responses API
  - Anthropic: Updated to Claude Opus 4.1 and Sonnet 4, fixed model naming
  - Gemini: Added latest 2.5 series models, increased token limits
- **ReasoningService**: Migrated from JavaScript to TypeScript for better type safety
- **API Endpoint Updates**:
  - OpenAI: Migrated from `/v1/chat/completions` to `/v1/responses`
  - Request format simplified for better performance
  - Response parsing updated for new output structure
- **Model Configuration Improvements**:
  - Fixed Anthropic model names (using hyphens instead of dots)
  - Increased Gemini 2.5 Pro token limits (2000 minimum)
  - Removed temperature parameter for GPT-5 and o-series models
- **Documentation**: Updated CLAUDE.md, README.md with comprehensive provider information

### Fixed

- **API Key Persistence**: All provider keys now properly save to `.env` file
  - Added `saveAllKeysToEnvFile()` method for consistent persistence
  - Keys reload automatically on app restart
  - Fixed Gemini and Anthropic key storage issues
- **CORS Issues**: Anthropic API calls now route through IPC handler
  - Avoids browser CORS restrictions in renderer process
  - Proper error handling in main process
- **Empty Response Handling**: Fixed "No text transcribed" error when AI returns empty
  - Falls back to original text when API returns nothing
  - Properly handles edge cases in response parsing
- **Parameter Compatibility**: Fixed OpenAI API parameter errors
  - GPT-5 models use simplified parameters (no max_tokens)
  - o-series models configured without temperature
  - Older models retain full parameter support

### Technical Improvements

- Added Gemini API integration with proper authentication flow
- Implemented SecureCache utility for API key management
- Enhanced IPC handlers for multi-provider support
- Updated environment manager with Gemini key storage
- Improved error handling with provider-specific messages
- Added comprehensive retry logic with exponential backoff
- Enhanced error messages with detailed logging
- Better fallback strategies for API failures
- Improved response validation and parsing
- Centralized API configuration in constants file
- Unified debugging system across all providers

## [1.0.3] - 2024-12-20

### Added

- **Local AI Models**: Integration with community models for complete privacy
  - Support for Llama, Mistral, and other open-source models
  - Local model management UI with download progress
  - Automatic model validation and testing
- **Enhanced Security**: Improved API key storage and management
  - System keychain integration where available
  - Encrypted localStorage fallback
  - Automatic key rotation support

### Fixed

- Resolved issues with Whisper model downloads on slow connections
- Fixed clipboard pasting reliability on Windows 11
- Improved error messages for better debugging
- Fixed memory leaks in long-running sessions

### Changed

- Optimized audio processing pipeline for 30% faster transcription
- Reduced app bundle size by 15MB through dependency optimization
- Improved startup time by lazy-loading heavy components

## [1.0.2] - 2024-12-19

### Added

- **Automatic Python Installation**: The app now detects and offers to install Python automatically
  - macOS: Uses Homebrew if available, falls back to official installer
  - Windows: Downloads and installs official Python with proper PATH configuration
  - Linux: Uses system package manager (apt, yum, or pacman)
- **Enhanced Developer Experience**:
  - Added MIT LICENSE file
  - Improved documentation for personal vs distribution builds
  - Added FAQ section to README
  - Added security information section
  - Clearer prerequisites and setup instructions
  - Added comprehensive CLAUDE.md technical reference
- **Dock Icon Support**: App now appears in the dock with activity indicator
  - Changed LSUIElement from true to false in electron-builder.json
  - App shows in dock on macOS with the standard dot indicator when running

### Changed

- Updated supported language count from 90+ to 58 (actual count in codebase)
- Improved README structure for better open source experience

## [1.0.1] - 2024-XX-XX

### Added

- **Agent Naming System**: Personalize your AI assistant with a custom name for more natural interactions
  - Name your agent during onboarding (step 6 of 8)
  - Address your agent directly: "Hey [AgentName], make this more professional"
  - Update agent name anytime through settings
  - Smart AI processing distinguishes between commands and regular dictation
  - Clean output automatically removes agent name references
- **Draggable Interface**: Click and drag the dictation panel to any position on screen
- **Dynamic Hotkey Display**: Tooltip shows your actual hotkey setting instead of generic text
- **Flexible Hotkey System**: Fixed hardcoded hotkey limitation - now fully respects user settings

### Changed

- **[BREAKING]** Removed click-to-record functionality to prevent conflicts with dragging
- **UI Behavior**: Recording is now exclusively controlled via hotkey (no accidental triggering)
- **Tooltip Text**: Shows "Press {your-hotkey} to speak" with actual configured hotkey
- **Cursor Styles**: Changed to grab/grabbing cursors to indicate draggable interface

### Fixed

- **Hotkey Bug**: Fixed issue where hotkey setting was stored but not actually used by global shortcut
- **Documentation**: Updated all docs to reflect current UI behavior and hotkey system
- **User Experience**: Eliminated confusion between drag and click actions

### Technical Details

- **Agent Naming Implementation**:
  - Added centralized agent name utility (`src/utils/agentName.ts`)
  - Enhanced onboarding flow with agent naming step
  - Updated ReasoningService with context-aware AI processing
  - Added agent name settings section with comprehensive UI
  - Implemented smart prompt generation for agent-addressed vs regular text
- Added IPC handlers for dynamic hotkey updates (`update-hotkey`)
- Implemented window-level dragging using screen cursor tracking
- Added real-time hotkey loading from localStorage in main dictation component
- Updated WindowManager to support runtime hotkey changes
- Added proper drag state management with smooth 60fps window positioning
- **Code Organization**: Extracted functionality into dedicated managers and React hooks:
  - HotkeyManager, DragManager, AudioManager, MenuManager, DevServerManager
  - useAudioRecording, useWindowDrag, useHotkey React hooks
  - WindowConfig utility for centralized window configuration
  - Reduced WindowManager from 465 to 190 lines through composition pattern

## [0.1.0] - 2024-XX-XX

### Added

- Initial release of OpenWhispr (formerly OpenWispr)
- Desktop dictation application using OpenAI Whisper
- Local and cloud-based speech-to-text transcription
- Real-time audio recording and processing
- Automatic text pasting via accessibility features
- SQLite database for transcription history
- macOS tray icon integration
- Global hotkey support (backtick key)
- Control panel for settings and configuration
- Local Whisper model management
- OpenAI API integration
- Cross-platform support (macOS, Windows, Linux)

### Features

- **Speech-to-Text**: Convert voice to text using OpenAI Whisper
- **Dual Processing**: Choose between local processing (private) or cloud processing (fast)
- **Model Management**: Download and manage local Whisper models (tiny, base, small, medium, large)
- **Transcription History**: View, copy, and delete past transcriptions
- **Accessibility Integration**: Automatic text pasting with proper permission handling
- **API Key Management**: Secure storage and management of OpenAI API keys
- **Real-time UI**: Live feedback during recording and processing
- **Global Hotkey**: Quick access via customizable keyboard shortcut
- **Database Storage**: Persistent storage of transcriptions with SQLite
- **Permission Management**: Streamlined macOS accessibility permission setup

### Technical Stack

- **Frontend**: React 19, Vite, TailwindCSS, Shadcn/UI components
- **Backend**: Electron 36, Node.js
- **Database**: better-sqlite3 for local storage
- **AI Processing**: OpenAI Whisper (local and API)
- **Build System**: Electron Builder for cross-platform packaging

### Security

- Local-first approach with optional cloud processing
- Secure API key storage and management
- Sandboxed renderer processes with context isolation
- Proper clipboard and accessibility permission handling
