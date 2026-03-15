<p align="center">
  <img src="src/assets/logo.svg" alt="OpenWhispr" width="120" />
</p>

<h1 align="center">OpenWhispr</h1>

<p align="center">
  <a href="https://github.com/OpenWhispr/openwhispr/blob/main/LICENSE"><img src="https://img.shields.io/github/license/OpenWhispr/openwhispr?style=flat" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat" alt="Platform" />
  <a href="https://github.com/OpenWhispr/openwhispr/releases/latest"><img src="https://img.shields.io/github/v/release/OpenWhispr/openwhispr?style=flat&sort=semver" alt="GitHub release" /></a>
  <a href="https://github.com/OpenWhispr/openwhispr/releases"><img src="https://img.shields.io/github/downloads/OpenWhispr/openwhispr/total?style=flat&color=blue" alt="Downloads" /></a>
  <a href="https://github.com/OpenWhispr/openwhispr/stargazers"><img src="https://img.shields.io/github/stars/OpenWhispr/openwhispr?style=flat" alt="GitHub stars" /></a>
</p>

<p align="center">Voice-to-text dictation and productivity app with AI agents, meeting transcription, notes, and local/cloud speech recognition.<br/>Privacy-first and available cross-platform.</p>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=OpenWhispr/openwhispr&type=date&legend=top-left)](https://www.star-history.com/#OpenWhispr/openwhispr&type=date&legend=top-left)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details. This means you can freely use, modify, and distribute this software for personal or commercial purposes.

## Features

### Dictation & Transcription

- 🎤 **Global Hotkey**: Customizable hotkey to start/stop dictation from anywhere (default: backtick `)
- ⚡ **Automatic Pasting**: Transcribed text automatically pastes at your cursor location (with toggle to disable)
- 🔒 **Privacy-First**: Local processing keeps your voice data completely private
- ⚡ **NVIDIA Parakeet**: Fast local transcription via sherpa-onnx (multilingual, 25 languages)
- 🔧 **Model Management**: Download and manage local Whisper models (tiny, base, small, medium, large, turbo)
- 📖 **Custom Dictionary**: Add words, names, and technical terms to improve transcription accuracy, with auto-learn that detects your corrections and updates the dictionary automatically
- 🗄️ **Transcription History**: SQLite database stores all your transcriptions locally with audio retention and retry
- 🎵 **Auto-Pause Media**: Automatically pauses media playback (Spotify, Apple Music, etc.) during dictation and resumes afterward

### AI Agent Mode

- 🤖 **Agent Overlay**: Glassmorphism chat overlay with real-time AI streaming, resizable window, and conversation history
- 🎯 **Agent Naming**: Personalize your AI assistant with a custom name — say "Hey [AgentName]" to give commands
- 🧠 **Multi-Provider AI**:
  - **OpenAI**: GPT-5, GPT-4.1, o-series reasoning models
  - **Anthropic**: Claude Opus 4.6, Claude Sonnet 4.6
  - **Google**: Gemini 3.1 Pro, Gemini 3 Flash, Gemini 2.5 Flash Lite
  - **Groq**: Ultra-fast inference with Llama and Mixtral models
  - **Local**: Qwen, LLaMA, Mistral, Gemma models via llama.cpp
- 🤖 **AI Actions**: Apply AI-powered actions to notes with customizable processing templates

### Meeting Transcription

- 📅 **Google Calendar Integration**: Connect multiple Google accounts, view upcoming meetings in the sidebar, and receive auto-detection prompts
- 🎙️ **Live Meeting Transcription**: Record and transcribe meetings in real-time via OpenAI Realtime API with automatic meeting detection (Zoom, Teams, FaceTime)
- ⚡ **WebSocket Streaming for BYOK**: Real-time OpenAI Realtime API streaming for standard dictation mode, not just meetings — unified streaming path for all transcription
- ⌨️ **Meeting Hotkey**: Dedicated hotkey to start/stop meeting transcription independently from dictation
- 🔍 **Smart Detection**: Combines process monitoring, sustained audio detection, and calendar awareness to detect meetings automatically

### Notes

- 📝 **Notes System**: Create, edit, and organize notes with folders, audio upload, and real-time dictation
- 🔎 **Full-Text Search**: FTS5-powered search across all note content with Cmd+K command palette
- ☁️ **Cloud Sync**: Local-first storage with cloud backup and semantic search
- 📁 **Folder Organization**: Organize notes into custom folders with drag-and-drop

### Cloud & Account

- ☁️ **OpenWhispr Cloud**: Sign in and transcribe instantly — no API keys needed, with free and Pro plans
- 🔐 **Account System**: Google OAuth and email/password sign-in with email verification
- 💳 **Subscription Management**: Free tier (2,000 words/week), Pro tier (unlimited), 7-day free trial
- 🔗 **Referral Program**: Invite friends and earn free Pro months with shareable referral cards

### Platform & UI

- 🌐 **Cross-Platform**: Works on macOS, Windows, and Linux
- 🎨 **Modern UI**: Built with React 19, TypeScript, and Tailwind CSS v4
- 🖱️ **Draggable Interface**: Move the dictation panel anywhere on your screen with configurable start position
- 🌐 **Globe Key Toggle (macOS)**: Optional Fn/Globe key listener for a hardware-level dictation trigger — no Input Monitoring permission required
- ⌨️ **Compound Hotkeys**: Support for multi-key combinations like `Cmd+Shift+K`
- 🎙️ **Push-to-Talk (Windows)**: Native low-level keyboard hook for true push-to-talk with compound hotkey support
- 🐧 **GNOME Wayland Support**: Native global shortcuts via D-Bus for GNOME Wayland users
- 🐧 **Hyprland Wayland Support**: Native global shortcuts via `hyprctl` keybindings + D-Bus for Hyprland users
- 🖥️ **Multi-Monitor**: Floating dictation icon follows your cursor across monitors
- 🧹 **Model Cleanup**: One-click removal of cached models with uninstall hooks to keep disks tidy

## Prerequisites

- **Node.js 22+** and npm (Download from [nodejs.org](https://nodejs.org/))
- **macOS 12+**, **Windows 10+**, or **Linux**
- On macOS, Globe key support requires the Xcode Command Line Tools (`xcode-select --install`) so the bundled Swift helper can run

## Quick Start

### For Personal Use (Recommended)

1. **Clone the repository**:

   ```bash
   git clone https://github.com/OpenWhispr/openwhispr.git
   cd openwhispr
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Optional: Set up API keys** (only needed for cloud processing):

   **Method A - Environment file**:

   ```bash
   cp .env.example .env
   # Edit .env and add your API keys:
   # OPENAI_API_KEY=your_openai_key
   # ANTHROPIC_API_KEY=your_anthropic_key
   # GEMINI_API_KEY=your_gemini_key
   # GROQ_API_KEY=your_groq_key
   # MISTRAL_API_KEY=your_mistral_key
   ```

   **Method B - In-app configuration**:
   - Run the app and configure API keys through the Control Panel
   - Keys are automatically saved and persist across app restarts

4. **Build the application**:

   ```bash
   npm run build
   ```

5. **Run the application**:

   ```bash
   npm run dev  # Development mode with hot reload
   # OR
   npm start    # Production mode
   ```

6. **Optional: Local Whisper from source** (only needed if you want local processing):
   ```bash
   npm run download:whisper-cpp
   ```
   This downloads the whisper.cpp binary for your current platform into `resources/bin/`.

### Building for Personal Use (Optional)

If you want to build a standalone app for personal use:

```bash
# Build without code signing (no certificates required)
npm run pack

# The unsigned app will be in: dist/mac-arm64/OpenWhispr.app (macOS)
# or dist/win-unpacked/OpenWhispr.exe (Windows)
# or dist/linux-unpacked/open-whispr (Linux)
```

**Note**: On macOS, you may see a security warning when first opening the unsigned app. Right-click and select "Open" to bypass this.

#### Windows

**Native Paste Binary (`windows-fast-paste`)**:

OpenWhispr ships a native C binary for pasting text on Windows, using the Win32 `SendInput` API. This is the **primary** paste mechanism — `nircmd` and PowerShell are only used as fallbacks if the native binary fails.

How it works:

- **Normal applications**: Simulates `Ctrl+V` via `SendInput` with virtual key codes (`VK_CONTROL` + `V`)
- **Terminal emulators**: Detects the foreground window's class name and simulates `Ctrl+Shift+V` instead
- **Terminal detection**: Recognizes Windows Terminal, cmd.exe, PowerShell, mintty (Git Bash), PuTTY, Alacritty, WezTerm, kitty, Hyper, MobaXterm, and ConEmu/Cmder
- **Detect-only mode**: Supports `--detect-only` flag to report the foreground window class without sending keystrokes

Compilation (handled automatically by the build system):

```bash
# MSVC
cl /O2 windows-fast-paste.c /Fe:windows-fast-paste.exe user32.lib

# MinGW
gcc -O2 windows-fast-paste.c -o windows-fast-paste.exe -luser32
```

The build script (`scripts/build-windows-fast-paste.js`) first attempts to download a prebuilt binary from GitHub releases. If unavailable, it compiles from source using MSVC, MinGW-w64, or Clang. Falls back to `nircmd` or PowerShell `SendKeys` if neither option works.

> ℹ️ **Note**: `CASCADIA_HOSTING_WINDOW_CLASS` covers all shells running inside Windows Terminal (PowerShell, CMD, WSL, etc.), so most modern Windows terminal usage is covered by a single class entry.

#### Linux (Multiple Package Formats)

OpenWhispr now supports multiple Linux package formats for maximum compatibility:

**Available Formats**:

- `.deb` - Debian, Ubuntu, Linux Mint, Pop!\_OS
- `.rpm` - Fedora, Red Hat, CentOS, openSUSE
- `.tar.gz` - Universal archive (works on any distro)
- `.flatpak` - Sandboxed cross-distro package
- `AppImage` - Portable single-file executable

**Building Linux Packages**:

```bash
# Build default Linux package formats (AppImage, deb, rpm, tar.gz)
npm run build:linux

# Find packages in dist/:
# - OpenWhispr-x.x.x-linux-x64.AppImage
# - OpenWhispr-x.x.x-linux-x64.deb
# - OpenWhispr-x.x.x-linux-x64.rpm
# - OpenWhispr-x.x.x-linux-x64.tar.gz
```

**Optional: Building Flatpak** (requires additional setup):

```bash
# Install Flatpak build tools
sudo apt install flatpak flatpak-builder  # Debian/Ubuntu
# OR
sudo dnf install flatpak flatpak-builder  # Fedora/RHEL

# Add Flathub repository and install runtime
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y flathub org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08

# Add "flatpak" to linux.target in electron-builder.json, then build
npm run build:linux
```

**Installation Examples**:

```bash
# Debian/Ubuntu
sudo apt install ./dist/OpenWhispr-*-linux-x64.deb

# Fedora/RHEL
sudo dnf install ./dist/OpenWhispr-*-linux-x64.rpm

# Universal tar.gz (no root required)
tar -xzf dist/OpenWhispr-*-linux-x64.tar.gz
cd OpenWhispr-*/
./openwhispr

# Flatpak
flatpak install --user ./dist/OpenWhispr-*-linux-x64.flatpak

# AppImage (existing method)
chmod +x dist/OpenWhispr-*.AppImage
./dist/OpenWhispr-*.AppImage
```

**Native Paste Binary (`linux-fast-paste`)**:

OpenWhispr ships a native C binary for pasting text on Linux, compiled automatically at build time. This is the **primary** paste mechanism — external tools like `xdotool` and `wtype` are only used as fallbacks if the native binary fails.

How it works:

- **X11**: Uses the XTest extension to synthesize `Ctrl+V` (or `Ctrl+Shift+V` in terminals) directly, with no external dependencies beyond X11 itself
- **Wayland**: Uses the Linux `uinput` subsystem to create a virtual keyboard and inject keystrokes. Falls back to XTest via XWayland if uinput is unavailable
- **Terminal detection**: Recognizes 20+ terminal emulators (kitty, alacritty, gnome-terminal, wezterm, ghostty, etc.) and automatically uses `Ctrl+Shift+V` instead of `Ctrl+V`
- **Window targeting**: Can target a specific window ID via `--window` to ensure keystrokes reach the correct application

Build dependencies (for compiling from source):

```bash
# Debian/Ubuntu
sudo apt install gcc libx11-dev libxtst-dev

# Fedora/RHEL
sudo dnf install gcc libX11-devel libXtst-devel

# Arch
sudo pacman -S gcc libx11 libxtst
```

The build script (`scripts/build-linux-fast-paste.js`) runs during `npm run compile:linux-paste` and:

1. Detects whether `linux/uinput.h` headers are available
2. Compiles with `-DHAVE_UINPUT` if so (enables Wayland uinput support)
3. Caches the binary and skips rebuilds unless the source or flags change
4. Gracefully falls back to system tools if compilation fails

If the native binary isn't available, OpenWhispr falls back to external paste tools in this order:

**Fallback Dependencies for Automatic Paste**:

The following tools are used as fallbacks when the native paste binary is unavailable or fails:

**X11 (Traditional Linux Desktop)**:

```bash
# Debian/Ubuntu
sudo apt install xdotool

# Fedora/RHEL
sudo dnf install xdotool

# Arch
sudo pacman -S xdotool
```

**Wayland (Modern Linux Desktop)**:

**Recommended:** Install `wl-clipboard` for reliable clipboard sharing between Wayland apps:

```bash
sudo apt install wl-clipboard    # Debian/Ubuntu
sudo dnf install wl-clipboard    # Fedora/RHEL
sudo pacman -S wl-clipboard      # Arch
```

Choose **one** of the following paste tools:

**Option 1: wtype** (requires virtual keyboard protocol support)

```bash
# Debian/Ubuntu
sudo apt install wtype

# Fedora/RHEL
sudo dnf install wtype

# Arch
sudo pacman -S wtype
```

**Option 2: ydotool** (works on more compositors, requires daemon)

```bash
# Debian/Ubuntu
sudo apt install ydotool
sudo systemctl enable --now ydotoold

# Fedora/RHEL
sudo dnf install ydotool
sudo systemctl enable --now ydotoold

# Arch
sudo pacman -S ydotool
sudo systemctl enable --now ydotoold
```

**Terminal Detection** (Optional - for KDE Wayland users):

```bash
# On KDE Wayland, kdotool enables automatic terminal detection
# to paste with Ctrl+Shift+V instead of Ctrl+V
sudo apt install kdotool  # Debian/Ubuntu
sudo dnf install kdotool  # Fedora/RHEL
sudo pacman -S kdotool    # Arch
```

> ℹ️ **Note**: OpenWhispr automatically tries paste methods in this order: native `linux-fast-paste` binary (XTest or uinput) → `wtype` → `ydotool` → `xdotool` (for XWayland apps). If no paste method works, text will still be copied to the clipboard - you'll just need to paste manually with Ctrl+V.

> ⚠️ **ydotool Requirements**: The `ydotoold` daemon must be running for ydotool to work. Start it manually with `sudo ydotoold &` or enable the systemd service as shown above.

**GNOME Wayland Global Hotkeys**:

On GNOME Wayland, Electron's standard global shortcuts don't work due to Wayland's security model. OpenWhispr automatically uses native GNOME keyboard shortcuts via D-Bus and gsettings:

- Hotkeys are registered as GNOME custom shortcuts (visible in Settings → Keyboard → Shortcuts)
- Default hotkey is `Alt+R` (backtick not supported on GNOME Wayland)
- **Push-to-talk mode is not available** on GNOME Wayland (only tap-to-talk)
- Falls back to X11/XWayland shortcuts if GNOME integration fails
- No additional dependencies required - uses `dbus-next` npm package

> ℹ️ **GNOME Wayland Limitation**: GNOME system shortcuts only fire a single toggle event (no key-up detection), so push-to-talk mode cannot work. The app automatically uses tap-to-talk mode on GNOME Wayland.

> 🔒 **Flatpak Security**: The Flatpak package includes sandboxing with explicit permissions for microphone, clipboard, and file access. See [electron-builder.json](electron-builder.json) for the complete permission list.

### Building for Distribution

For maintainers who need to distribute signed builds:

```bash
# Requires code signing certificates and notarization setup
npm run build:mac    # macOS (requires Apple Developer account)
npm run build:win    # Windows (requires code signing cert)
npm run build:linux  # Linux
```

### First Time Setup

1. **Choose Processing Method**:
   - **OpenWhispr Cloud**: Sign in for instant cloud transcription with free and Pro plans
   - **Bring Your Own Key**: Use your own OpenAI/Groq/AssemblyAI API keys
   - **Local Processing**: Download Whisper or Parakeet models for completely private transcription

2. **Grant Permissions**:
   - **Microphone Access**: Required for voice recording
   - **Accessibility Permissions**: Required for automatic text pasting (macOS)
   - **Screen Recording** (optional, macOS): Required for meeting audio capture — prompted during onboarding if you want meeting features

3. **Name Your Agent**: Give your AI assistant a personal name (e.g., "Assistant", "Jarvis", "Alex")
   - Makes interactions feel more natural and conversational
   - Helps distinguish between giving commands and regular dictation
   - Can be changed anytime in settings

4. **Configure Global Hotkey**: Default is backtick (`) but can be customized

## Usage

### Basic Dictation

1. **Start the app** - A small draggable panel appears on your screen
2. **Press your hotkey** (default: backtick `) - Start dictating (panel shows recording animation)
3. **Press your hotkey again** - Stop dictation and begin transcription (panel shows processing animation)
4. **Text appears** - Transcribed text is automatically pasted at your cursor location
5. **Drag the panel** - Click and drag to move the dictation panel anywhere on your screen

### Control Panel

- **Access**: Right-click the tray icon (macOS) or through the system menu
- **Configure**: Choose between local and cloud processing
- **History**: View, copy, and delete past transcriptions — with audio playback and retry for failed transcriptions
- **Notes**: Create, edit, and organize notes with folders, AI actions, and full-text search
- **Integrations**: Connect Google Calendar accounts for meeting detection and transcription
- **Models**: Download and manage local Whisper and Parakeet models
- **Storage Cleanup**: Remove downloaded models from cache to reclaim space
- **Settings**: Configure API keys, customize hotkeys, manage permissions, and set up Agent Mode
- **Cmd+K Search**: Quick search across notes and transcripts from anywhere in the app

### Uninstall & Cache Cleanup

- **In-App**: Use _Settings → General → Local Model Storage → Remove Downloaded Models_ to clear cached Whisper and Parakeet models from `~/.cache/openwhispr/` (or `%USERPROFILE%\.cache\openwhispr\` on Windows).
- **Audio Files**: Retained audio files are stored in your app data directory and cleaned up automatically after 30 days. Clear manually via Settings if needed.
- **Windows Uninstall**: The NSIS uninstaller automatically deletes the cache directory.
- **Linux Packages**: `deb`/`rpm` post-uninstall scripts also remove cached models.
- **macOS**: If you uninstall manually, remove `~/Library/Caches` or `~/.cache/openwhispr/` if desired.

### Agent Naming & AI Processing

Once you've named your agent during setup, you can interact with it using multiple AI providers:

**🎯 Agent Commands** (for AI assistance):

- "Hey [AgentName], make this more professional"
- "Hey [AgentName], format this as a list"
- "Hey [AgentName], write a thank you email"
- "Hey [AgentName], convert this to bullet points"

**🤖 AI Provider Options**:

- **OpenAI**: GPT-5, GPT-4.1, o-series reasoning models
- **Anthropic**: Claude Opus 4.6, Sonnet 4.6, Haiku 4.5
- **Google**: Gemini 3.1 Pro, Gemini 3 Flash, Gemini 2.5 Flash Lite
- **Groq**: Ultra-fast Llama and Mixtral inference
- **Local**: Qwen, LLaMA, Mistral, Gemma models via llama.cpp

**📝 Regular Dictation** (for normal text):

- "This is just normal text I want transcribed"
- "Meeting notes: John mentioned the quarterly report"
- "Dear Sarah, thank you for your help"

The AI automatically detects when you're giving it commands versus dictating regular text, and removes agent name references from the final output.

### Custom Dictionary

Improve transcription accuracy for specific words, names, or technical terms:

1. **Access Settings**: Open Control Panel → Settings → Custom Dictionary
2. **Add Words**: Enter words, names, or phrases that are frequently misrecognized
3. **How It Works**: Words are provided as context hints to the speech recognition model

**Examples of words to add**:

- Uncommon names (e.g., "Sergey", "Xanthe")
- Technical jargon (e.g., "Kubernetes", "OAuth")
- Brand names (e.g., "OpenWhispr", "whisper.cpp")
- Domain-specific terms (e.g., "amortization", "polymerase")

### Agent Mode

Agent Mode opens a resizable glassmorphism chat overlay for interactive AI conversations:

1. **Enable**: Go to Settings → Agent Mode and toggle it on
2. **Set a Hotkey**: Assign a dedicated hotkey to open the agent overlay
3. **Chat**: Press the hotkey to open the overlay, dictate your message, and receive streaming AI responses
4. **Customize**: Set a custom system prompt, choose your preferred AI provider and model
5. **History**: All conversations are saved and can be resumed

### Meeting Transcription

Automatically detect and transcribe meetings with Google Calendar integration:

1. **Connect Calendar**: Go to Integrations → Google Calendar and sign in
2. **Grant Screen Recording** (macOS): Required to capture meeting audio
3. **Auto-Detection**: When a meeting starts (Zoom, Teams, FaceTime), a notification appears asking to record
4. **Live Transcription**: Meeting audio is transcribed in real-time via OpenAI Realtime API
5. **Review**: Meeting transcriptions are saved as notes for later review and AI enhancement

### Processing Options

- **OpenWhispr Cloud**:
  - Sign in with Google or email — no API keys needed
  - Free plan: 2,000 words/week with 7-day Pro trial for new accounts
  - Pro plan: unlimited transcriptions
- **Bring Your Own Key (BYOK)**:
  - Use your own API keys from OpenAI, Groq, Mistral, AssemblyAI, or custom endpoints
  - Full control over provider and model selection
- **Local Processing**:
  - Install Whisper or NVIDIA Parakeet through the Control Panel
  - Download models: tiny (fastest), base (recommended), small, medium, large (best quality)
  - Complete privacy - audio never leaves your device

## Project Structure

```
open-whispr/
├── main.js              # Electron main process & IPC handlers
├── preload.js           # Electron preload script & API bridge
├── setup.js             # First-time setup script
├── package.json         # Dependencies and scripts
├── env.example          # Environment variables template
├── CHANGELOG.md         # Project changelog
├── src/
│   ├── App.jsx          # Main dictation interface
│   ├── main.jsx         # React entry point
│   ├── index.html       # Vite HTML template
│   ├── index.css        # Tailwind CSS v4 configuration
│   ├── vite.config.js   # Vite configuration
│   ├── components/
│   │   ├── ControlPanel.tsx     # Settings and history UI
│   │   ├── OnboardingFlow.tsx   # First-time setup wizard
│   │   ├── SettingsPage.tsx     # Settings interface
│   │   ├── AgentOverlay.tsx     # Agent mode chat overlay
│   │   ├── CommandSearch.tsx    # Cmd+K command palette
│   │   ├── IntegrationsView.tsx # Google Calendar & integrations
│   │   ├── UpcomingMeetings.tsx # Sidebar meeting list
│   │   ├── agent/               # Agent mode components
│   │   │   ├── AgentChat.tsx
│   │   │   ├── AgentInput.tsx
│   │   │   ├── AgentMessage.tsx
│   │   │   └── AgentTitleBar.tsx
│   │   ├── notes/               # Notes system components
│   │   │   ├── NoteEditor.tsx
│   │   │   ├── ActionPicker.tsx
│   │   │   ├── ActionManagerDialog.tsx
│   │   │   └── ...
│   │   ├── settings/            # Settings sub-components
│   │   │   └── AgentModeSettings.tsx
│   │   ├── ui/                  # shadcn/ui components
│   │   └── lib/
│   │       └── utils.ts         # Utility functions
│   ├── config/
│   │   └── prompts.ts           # Centralized AI prompt definitions
│   ├── services/
│   │   └── ReasoningService.ts  # Multi-provider AI processing with streaming
│   ├── hooks/
│   │   ├── useMeetingTranscription.ts  # Meeting audio capture
│   │   ├── useUpcomingEvents.ts        # Calendar event fetching
│   │   ├── useScreenRecordingPermission.ts  # macOS permission
│   │   └── ...
│   ├── helpers/
│   │   ├── googleCalendarManager.js    # Calendar sync & events
│   │   ├── googleCalendarOAuth.js      # OAuth 2.0 PKCE flow
│   │   ├── meetingDetectionEngine.js   # Smart meeting detection
│   │   ├── audioStorage.js             # Audio file retention
│   │   ├── mediaPlayer.js             # Cross-platform media control
│   │   └── ...
│   ├── utils/
│   │   └── agentName.ts         # Agent name management utility
│   └── components.json          # shadcn/ui configuration
├── resources/
│   └── bin/                     # Native binaries (whisper-cpp, sherpa-onnx, etc.)
└── assets/                      # App icons and resources
```

## Technology Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4
- **Build Tool**: Vite with optimized Tailwind plugin
- **Desktop**: Electron 39 with context isolation
- **UI Components**: shadcn/ui with Radix primitives
- **Database**: better-sqlite3 with FTS5 for local storage (transcriptions, notes, agents, calendar)
- **Speech-to-Text**: OpenAI Whisper (whisper.cpp) + NVIDIA Parakeet (sherpa-onnx) for local, OpenAI API for cloud
- **Live Transcription**: OpenAI Realtime API over WebSocket for meeting transcription
- **AI Processing**: Multi-provider streaming (OpenAI, Anthropic, Gemini, Groq, local llama.cpp)
- **Calendar**: Google Calendar API with OAuth 2.0 PKCE
- **Icons**: Lucide React for consistent iconography

## Development

### Scripts

- `npm run dev` - Start development with hot reload
- `npm run start` - Start production build
- `npm run setup` - First-time setup (creates .env file)
- `npm run build:renderer` - Build the React app only
- `npm run download:whisper-cpp` - Download whisper.cpp for the current platform
- `npm run download:whisper-cpp:all` - Download whisper.cpp for all platforms
- `npm run download:llama-server` - Download llama.cpp server for local LLM inference
- `npm run download:llama-server:all` - Download llama.cpp server for all platforms
- `npm run download:sherpa-onnx` - Download sherpa-onnx for Parakeet local transcription
- `npm run download:sherpa-onnx:all` - Download sherpa-onnx for all platforms
- `npm run compile:native` - Compile native helpers (Globe key listener and media remote for macOS, key listener and fast paste for Windows, fast paste for Linux, text monitor for auto-learn)
- `npm run build` - Full build with signing (requires certificates)
- `npm run build:mac` - macOS build with signing
- `npm run build:win` - Windows build with signing
- `npm run build:linux` - Linux build
- `npm run pack` - Build without signing (for personal use)
- `npm run dist` - Build and package with signing
- `npm run lint` - Run ESLint
- `npm run format` - Format code with Prettier
- `npm run clean` - Clean build artifacts
- `npm run preview` - Preview production build

### Architecture

The app consists of two main windows:

1. **Main Window**: Minimal overlay for dictation controls
2. **Control Panel**: Full settings and history interface

Both use the same React codebase but render different components based on URL parameters.

### Key Components

- **main.js**: Electron main process, IPC handlers, database operations
- **preload.js**: Secure bridge between main and renderer processes
- **App.jsx**: Main dictation interface with recording controls
- **ControlPanel.tsx**: Settings, history, notes, integrations, and model management
- **AgentOverlay.tsx**: Agent mode chat overlay with streaming AI responses
- **CommandSearch.tsx**: Cmd+K command palette for searching notes and transcripts
- **IntegrationsView.tsx**: Google Calendar connection and meeting settings
- **src/helpers/whisper.js**: whisper.cpp integration for local processing
- **src/helpers/googleCalendarManager.js**: Calendar sync and event management
- **src/helpers/meetingDetectionEngine.js**: Smart meeting detection orchestrator
- **src/helpers/audioStorage.js**: Audio file retention and management
- **src/helpers/mediaPlayer.js**: Cross-platform media pause/resume
- **src/services/ReasoningService.ts**: Multi-provider AI processing with streaming
- **better-sqlite3**: Local database for transcriptions, notes, agents, and calendar data

### Tailwind CSS v4 Setup

This project uses the latest Tailwind CSS v4 with:

- CSS-first configuration using `@theme` directive
- Vite plugin for optimal performance
- Custom design tokens for consistent theming
- Dark mode support with `@variant`

## Building

The build process creates a single executable for your platform:

```bash
# Development build
npm run pack

# Production builds
npm run dist           # Current platform
npm run build:mac      # macOS DMG + ZIP
npm run build:win      # Windows NSIS + Portable
npm run build:linux    # AppImage + DEB
```

Note: build/pack/dist scripts automatically download whisper.cpp, llama-server, and sherpa-onnx for the current platform. For multi-platform packaging from one host, run the `:all` variants first (`npm run download:whisper-cpp:all`, `npm run download:llama-server:all`, `npm run download:sherpa-onnx:all`).

## Configuration

### Environment Variables

Create a `.env` file in the root directory (or use `npm run setup`):

```env
# OpenAI API Configuration (optional - only needed for cloud processing)
OPENAI_API_KEY=your_openai_api_key_here

# Optional: Customize the Whisper model
WHISPER_MODEL=whisper-1

# Optional: Set language for better transcription accuracy
LANGUAGE=

# Optional: Anthropic API Configuration
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Optional: Google Gemini API Configuration
GEMINI_API_KEY=your_gemini_api_key_here

# Optional: Groq API Configuration (ultra-fast inference)
GROQ_API_KEY=your_groq_api_key_here

# Optional: Mistral API Configuration (Voxtral transcription)
MISTRAL_API_KEY=your_mistral_api_key_here

# Optional: Debug mode
DEBUG=false
```

### Local Whisper Setup

For local processing, OpenWhispr uses OpenAI's Whisper model via whisper.cpp - a high-performance C++ implementation:

1. **Bundled Binary**: whisper.cpp is bundled with the app for all platforms
2. **GGML Models**: Downloads optimized GGML models on first use to `~/.cache/openwhispr/whisper-models/`
3. **No Dependencies**: No Python or other runtime required

**System Fallback**: If the bundled binary fails, install via package manager:

- macOS: `brew install whisper-cpp`
- Linux: Build from source at https://github.com/ggml-org/whisper.cpp

**From Source**: When running locally (not a packaged build), download the binary with `npm run download:whisper-cpp` so `resources/bin/` has your platform executable.

**Requirements**:

- Sufficient disk space for models (75MB - 3GB depending on model)

**Upgrading from Python-based version**: If you previously used the Python-based Whisper, you'll need to re-download models in GGML format. You can safely delete the old Python environment (`~/.openwhispr/python/`) and PyTorch models (`~/.cache/whisper/`) to reclaim disk space.

### Local Parakeet Setup (Alternative)

OpenWhispr also supports NVIDIA Parakeet models via sherpa-onnx - a fast alternative to Whisper:

1. **Bundled Binary**: sherpa-onnx is bundled with the app for all platforms
2. **INT8 Quantized Models**: Efficient CPU inference
3. **Models stored in**: `~/.cache/openwhispr/parakeet-models/`

**Available Models**:

- `parakeet-tdt-0.6b-v3`: Multilingual (25 languages), ~680MB

**When to use Parakeet vs Whisper**:

- **Parakeet**: Best for speed-critical use cases or lower-end hardware
- **Whisper**: Best for quality-critical use cases or when you need specific model sizes

### Customization

- **Hotkey**: Change in the Control Panel (default: backtick `) - fully customizable
- **Panel Position**: Drag the dictation panel to any location on your screen`
- **Processing Method**: Choose local or cloud in Control Panel
- **Whisper Model**: Select quality vs speed in Control Panel
- **UI Theme**: Edit CSS variables in `src/index.css`
- **Window Size**: Adjust dimensions in `main.js`
- **Database**: Transcriptions stored in user data directory

## Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Run `npm run lint` before committing
- Follow the existing code style
- Update documentation as needed
- Test on your target platform before submitting

## Security

OpenWhispr is designed with privacy and security in mind:

- **Local Processing Option**: Keep your voice data completely private
- **No Analytics**: We don't collect any usage data or telemetry
- **Open Source**: All code is available for review
- **Secure Storage**: API keys are stored securely in your system's keychain/credential manager
- **Minimal Permissions**: Only requests necessary permissions (microphone, accessibility, screen recording for meetings)
- **OAuth 2.0 PKCE**: Google Calendar uses secure PKCE flow — no client secrets stored
- **Local-First Notes**: Notes are stored locally in SQLite; cloud sync is optional

## Troubleshooting

### Common Issues

1. **Microphone permissions**: Grant permissions in System Preferences/Settings
2. **Accessibility permissions (macOS)**: Required for automatic text pasting
   - Go to System Settings → Privacy & Security → Accessibility
   - Add OpenWhispr and enable the checkbox
   - Use "Fix Permission Issues" in Control Panel if needed
3. **API key errors** (cloud processing only): Ensure your OpenAI API key is valid and has credits
   - Set key through Control Panel or .env file
   - Check logs for "OpenAI API Key present: Yes/No"
4. **Local Whisper issues**:
   - whisper.cpp is bundled with the app
   - If bundled binary fails, install via `brew install whisper-cpp` (macOS)
   - Check available disk space for models
5. **Global hotkey conflicts**: Change the hotkey in the Control Panel - any key can be used
   - GNOME Wayland: Hotkeys are registered via gsettings; check Settings → Keyboard → Shortcuts for conflicts
6. **Text not pasting**:
   - macOS: Check accessibility permissions (System Settings → Privacy & Security → Accessibility)
   - Linux X11: Install `xdotool`
   - Linux Wayland: Install `wtype` or `ydotool` for paste simulation (ensure `ydotoold` daemon is running)
   - All platforms: Text is always copied to clipboard - use Ctrl+V (Cmd+V on macOS) to paste manually
7. **Panel position**: If the panel appears off-screen, restart the app to reset position
8. **Meeting detection not working**:
   - macOS: Grant screen recording permission in System Settings → Privacy & Security → Screen Recording
   - Ensure Google Calendar is connected in Integrations
   - Check that meeting detection is enabled in settings
9. **Agent Mode issues**:
   - Ensure Agent Mode is enabled in Settings → Agent Mode
   - Verify you have a valid API key for your selected AI provider
   - Check that the agent hotkey doesn't conflict with other shortcuts

### Getting Help

- Check the [Issues](https://github.com/OpenWhispr/openwhispr/issues) page
- Review the console logs for debugging information
- For local processing: Ensure whisper.cpp is accessible and models are downloaded
- For cloud processing: Verify your OpenAI API key and billing status
- Check the Control Panel for system status and diagnostics

### Performance Tips

- **Local Processing**: Use "base" model for best balance of speed and accuracy
- **Cloud Processing**: Generally faster but requires internet connection
- **Model Selection**: tiny (fastest) → base (recommended) → small → medium → large (best quality)
- **Permissions**: Ensure all required permissions are granted for smooth operation

## FAQ

**Q: Is OpenWhispr really free?**
A: Yes! OpenWhispr is open source and free to use. The free plan includes 2,000 words/week of cloud transcription, and local processing is completely free with no limits. Paid plans start from as little as $8/month.

**Q: Which processing method should I use?**
A: Use local processing for privacy and offline use. Use cloud processing for speed and convenience.

**Q: Can I use this commercially?**
A: Yes! The MIT license allows commercial use.

**Q: How do I change the hotkey?**
A: Open the Control Panel (right-click tray icon) and go to Settings. You can set any key as your hotkey.

**Q: Is my data secure?**
A: With local processing, your audio never leaves your device. With cloud processing, audio is sent to OpenAI's servers (see their privacy policy).

**Q: What languages are supported?**
A: OpenWhispr supports 58 languages including English, Spanish, French, German, Chinese, Japanese, and more. Set your preferred language in the .env file or use auto-detect.

**Q: What is Agent Mode?**
A: Agent Mode opens a chat overlay where you can have interactive AI conversations using voice. It supports streaming responses from all providers (OpenAI, Anthropic, Gemini, Groq, local) and saves conversation history.

**Q: How does meeting transcription work?**
A: Connect your Google Calendar in Integrations. When a meeting starts (Zoom, Teams, FaceTime), OpenWhispr detects it and offers to record. Audio is transcribed in real-time via OpenAI Realtime API. On macOS, screen recording permission is required to capture meeting audio.

**Q: Where are my notes stored?**
A: Notes are stored locally in SQLite with optional cloud sync. They support full-text search (FTS5), folder organization, and AI-powered enhancement actions.

**Q: Does OpenWhispr require Input Monitoring on macOS?**
A: No. As of v1.6.0, OpenWhispr uses NSEvent monitors instead of CGEvent taps, eliminating the Input Monitoring permission requirement. Only Microphone and Accessibility permissions are needed (plus Screen Recording for meeting features).

## Project Status

OpenWhispr is actively maintained and ready for production use. Current version: 1.6.4

- ✅ Core dictation with local and cloud processing
- ✅ Cross-platform support (macOS, Windows, Linux)
- ✅ OpenWhispr Cloud with account system, usage tracking, and Stripe billing
- ✅ Multi-provider AI (OpenAI, Anthropic, Gemini, Groq, Mistral, Local)
- ✅ Agent Mode with streaming chat overlay and conversation history
- ✅ Google Calendar integration with automatic meeting detection
- ✅ Live meeting transcription via OpenAI Realtime API
- ✅ Notes system with FTS5 search, cloud sync, folders, and AI actions
- ✅ Audio retention with playback and retry for failed transcriptions
- ✅ Cmd+K command search across notes and transcripts
- ✅ Auto-pause media playback during dictation
- ✅ Custom dictionary with auto-learn correction monitoring
- ✅ NVIDIA Parakeet support via sherpa-onnx
- ✅ Compound hotkeys and Windows Push-to-Talk
- ✅ GNOME Wayland and Hyprland native global shortcuts
- ✅ Referral program with shareable invite cards
- ✅ Dedicated meeting mode hotkey
- ✅ CodeQL static analysis and Dependabot dependency updates

## Acknowledgments

- **[OpenAI Whisper](https://github.com/openai/whisper)** - The speech recognition model that powers both local and cloud transcription
- **[whisper.cpp](https://github.com/ggerganov/whisper.cpp)** - High-performance C++ implementation of Whisper for local processing
- **[NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)** - Fast ASR model for efficient local transcription
- **[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)** - Cross-platform ONNX runtime for Parakeet model inference
- **[Electron](https://www.electronjs.org/)** - Cross-platform desktop application framework
- **[React](https://react.dev/)** - UI component library
- **[shadcn/ui](https://ui.shadcn.com/)** - Beautiful UI components built on Radix primitives
- **[Hugging Face](https://huggingface.co/)** - Model hosting platform for our local speech recognition and language models
- **[llama.cpp](https://github.com/ggerganov/llama.cpp)** - Local LLM inference for AI-powered text processing
