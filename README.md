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

<p align="center">
  The open-source and free alternative to WisprFlow and Granola.<br/>
  Privacy-first voice-to-text dictation with AI agents, meeting transcription, and notes. Cross-platform for macOS, Windows, and Linux.
</p>

<p align="center">
  <a href="https://openwhispr.com">Website</a> &middot;
  <a href="https://docs.openwhispr.com">Docs</a> &middot;
  <a href="https://github.com/OpenWhispr/openwhispr/releases/latest">Download</a> &middot;
  <a href="https://docs.openwhispr.com/api/overview">API</a> &middot;
  <a href="https://github.com/OpenWhispr/openwhispr/blob/main/CHANGELOG.md">Changelog</a>
</p>

---

> **About this fork.** This is a fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr) maintained by [@futuregerald](https://github.com/futuregerald) as a fully local, private **Krisp/Granola replacement with real N-speaker speaker diarization**.
>
> - **Why it was forked:** to run meeting transcription with reliable speaker labels entirely on-device (no cloud, no Krisp), and to add a faster, more accurate on-device diarization engine.
> - **Real N-speaker diarization on the ANE:** adds **[FluidAudio](https://github.com/FluidInference/FluidAudio)** (Swift/CoreML) as an optional macOS diarization backend running pyannote-community-1-class models on the **Apple Neural Engine** — higher accuracy and much lower power/latency than the default sherpa-onnx (CPU) engine. Auto-selected on macOS when installed and **falls back to sherpa-onnx automatically** otherwise, so non-macOS machines are unaffected. Speaker labels are a **post-call pass** (seconds for a typical meeting).
> - **Local-only, no signup:** onboarding has no account/signup step and no "how are you using the app" step — first run goes straight to on-device transcription (default Whisper `turbo`, changeable in Settings). Cloud/BYOK stays available but strictly opt-in.
> - **No phone-home:** this fork disables the little that reached out by default — the Better Auth session ping to `auth.openwhispr.com`, the automatic startup update check, and a Google Fonts fetch. There is no analytics SDK. Nothing leaves your device unless you opt into a cloud provider. See [Privacy](docs/FORK-SETUP.md#privacy--no-phone-home).
> - **Merges stay clean:** changes are isolated (diarization dispatcher in `src/helpers/diarization.js` + small guards, default flips, additive `scripts/setup-fluidaudio.js` and docs), so upstream updates merge without fuss.
> - **How to run it:** `npm install` → `npm run setup:fluidaudio` (optional, macOS) → `npm run dev`.
> - **More:** [Fork setup & sharing guide](docs/FORK-SETUP.md) · [FluidAudio integration notes](docs/FLUIDAUDIO-INTEGRATION.md) · [Research & decision record](docs/LOCAL-DIARIZATION-RESEARCH.md).

OpenWhispr turns your voice into text, notes, and actions from your desktop. Press a hotkey, speak, and your words appear at your cursor. Choose between fully private offline transcription with local speech-to-text engines like Whisper and NVIDIA Parakeet — where your audio never leaves your device — or cloud processing for speed. No data collection, no telemetry, fully open source.

## Download

| Platform              | Download                                                                                                                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple Silicon) | [`.dmg`](https://github.com/OpenWhispr/openwhispr/releases/latest)                                                                                                                                                                                                                        |
| macOS (Intel)         | [`.dmg`](https://github.com/OpenWhispr/openwhispr/releases/latest)                                                                                                                                                                                                                        |
| Windows               | [`.exe`](https://github.com/OpenWhispr/openwhispr/releases/latest)                                                                                                                                                                                                                        |
| Linux                 | [`.AppImage`](https://github.com/OpenWhispr/openwhispr/releases/latest) / [`.deb`](https://github.com/OpenWhispr/openwhispr/releases/latest) / [`.rpm`](https://github.com/OpenWhispr/openwhispr/releases/latest) / [`.tar.gz`](https://github.com/OpenWhispr/openwhispr/releases/latest) |

## Features

- **Voice dictation** — global hotkey to dictate into any app with automatic pasting
- **AI agent** — talk to GPT-5, Claude, Gemini, Groq, Tinfoil, OpenRouter, or local models with a named voice assistant
- **Voice agent hotkey** — dedicated hotkey that sends your dictation straight to your AI agent as a command, no wake word needed and no cleanup pass
- **Meeting transcription** — auto-detect Zoom, Teams, and FaceTime calls with live speaker diarization, voice fingerprinting, and Google Calendar integration
- **Local speaker diarization** — on-device speaker labelling with voice fingerprint recognition across meetings, no cloud required
- **Notes** — create, organize, and search notes with folders, semantic search, cloud sync, and AI actions
- **Local or cloud — your choice** — all core features (transcription, AI reasoning, speaker diarization, semantic search) work with local models or cloud providers
- **Public API & MCP** — manage notes and transcriptions programmatically or connect your AI assistant via the [MCP server](https://docs.openwhispr.com/integrations/mcp)

## Quick start

```bash
git clone https://github.com/futuregerald/openwhispr.git
cd openwhispr
npm install
npm run setup:fluidaudio   # optional (macOS): build the FluidAudio ANE diarization engine
npm run dev
```

Requires Node.js 24+. `npm run setup:fluidaudio` additionally needs the Xcode Command Line Tools (`xcode-select --install`) and is macOS-only — skip it to use the cross-platform sherpa-onnx diarization engine. See [docs/FORK-SETUP.md](docs/FORK-SETUP.md) for the full fork setup, sharing, and upstream-sync guide, or the [upstream documentation](https://docs.openwhispr.com/quickstart) for platform-specific details.

First run starts a **local-only** onboarding — no account or signup. Transcription defaults to on-device Whisper (`turbo` model); you can switch models or enable a cloud provider later in Settings.

## Build a shareable app (macOS)

To hand coworkers a double-clickable app instead of having them run from source:

```bash
npm run build:mac:arm64   # Apple Silicon (use build:mac:x64 for Intel Macs)
```

`prebuild:mac` runs automatically first: it compiles the native helpers, downloads the whisper/sherpa/qdrant binaries, and **builds and bundles the FluidAudio diarization engine** — so the installed app needs no `npm run setup:fluidaudio`. Output `.dmg` and `.zip` land in `dist/`.

These builds are **unsigned and un-notarized** (the fork doesn't ship an Apple Developer ID), so macOS Gatekeeper blocks the app on first launch. Each recipient clears the quarantine flag once after installing:

```bash
xattr -dr com.apple.quarantine "/Applications/OpenWhispr.app"
```

First launch downloads the default `turbo` Whisper model (~1.6 GB); weaker machines can pick `small`/`base` in Settings. To re-enable real signing/notarization with your own Developer ID, see [docs/FORK-SETUP.md](docs/FORK-SETUP.md).

## Documentation

Visit **[docs.openwhispr.com](https://docs.openwhispr.com)** for:

- [Getting started](https://docs.openwhispr.com/quickstart)
- [Platform guides](https://docs.openwhispr.com/platform/macos) (macOS, Windows, Linux)
- [API reference](https://docs.openwhispr.com/api/overview)
- [MCP server setup](https://docs.openwhispr.com/integrations/mcp)
- [Troubleshooting](https://docs.openwhispr.com/troubleshooting)

## Tech stack

React 19, TypeScript, Tailwind CSS v4, Electron 41, better-sqlite3, whisper.cpp, sherpa-onnx, shadcn/ui

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=OpenWhispr/openwhispr&type=date&legend=top-left)](https://www.star-history.com/#OpenWhispr/openwhispr&type=date&legend=top-left)

## Sponsors

<p align="center">
  <a href="https://console.neon.tech/app/?promo=openwhispr">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://neon.com/brand/neon-logo-dark-color.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://neon.com/brand/neon-logo-light-color.svg">
      <img width="250" alt="Neon" src="https://neon.com/brand/neon-logo-light-color.svg">
    </picture>
  </a>
</p>

<p align="center"><a href="https://console.neon.tech/app/?promo=openwhispr">Neon</a> is the serverless Postgres platform powering OpenWhispr Cloud.</p>

## Contributing

We welcome contributions. Fork the repo, create a feature branch, and open a pull request. See the [contributing guide](https://docs.openwhispr.com/contributing) for development setup and guidelines.

## License

[MIT](LICENSE) — free for personal and commercial use.

## Acknowledgments

- **[OpenAI Whisper](https://github.com/openai/whisper)** — speech recognition model powering local and cloud transcription
- **[whisper.cpp](https://github.com/ggerganov/whisper.cpp)** — high-performance C++ implementation for local processing
- **[NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)** — fast multilingual ASR model
- **[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)** — cross-platform ONNX runtime for Parakeet inference
- **[Hugging Face](https://huggingface.co/)** — model hub hosting Whisper, Parakeet, and embedding model weights
- **[llama.cpp](https://github.com/ggerganov/llama.cpp)** — local LLM inference for AI text processing
- **[Electron](https://www.electronjs.org/)** — cross-platform desktop framework
- **[React](https://react.dev/)** — UI component library
- **[shadcn/ui](https://ui.shadcn.com/)** — accessible components built on Radix primitives
- **[Neon](https://console.neon.tech/app/?promo=openwhispr)** — serverless Postgres powering OpenWhispr Cloud
