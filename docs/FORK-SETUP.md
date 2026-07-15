# OpenWhispr (FluidAudio fork) — Setup & Sharing Guide

A local, private meeting transcriber with **real N-speaker diarization** — a Krisp/Granola
alternative that runs entirely on your machine. This fork adds an optional, faster/more-accurate
diarization engine (**FluidAudio**, on the Apple Neural Engine) on top of upstream OpenWhispr.

Diarization here is a **post-call pass**: transcription happens live during the meeting, and
speaker labels are computed right after it ends (seconds for a typical meeting).

## Quick start (macOS, Apple Silicon)

Prerequisites:
- **Node.js ≥ 24** (`node -v`)
- **Xcode Command Line Tools** (for the FluidAudio build): `xcode-select --install`

```bash
git clone https://github.com/futuregerald/openwhispr.git
cd openwhispr
npm install
npm run setup:fluidaudio     # builds the FluidAudio CLI into resources/bin (optional but recommended)
npm run dev                  # first run downloads whisper/sherpa/model binaries, then launches
```

That's it. First run walks a **local-only onboarding — no account or signup**. Transcription
defaults to on-device Whisper (`turbo` model, downloaded on first use); grant the mic/accessibility
permissions it asks for and start a meeting. Speaker diarization runs automatically after the
meeting; you can rename/lock speakers in the transcript, and named speakers persist across meetings.
(You can still switch models or enable a cloud provider later in Settings.)

If you skip `npm run setup:fluidaudio` (or you're not on a Mac), the app still works — it falls
back to the cross-platform **sherpa-onnx** diarization engine automatically.

## Choosing / forcing the diarization engine

FluidAudio is auto-selected on macOS when installed. To override:

```bash
OPENWHISPR_DIARIZATION_ENGINE=sherpa npm run dev      # force the cross-platform engine
OPENWHISPR_DIARIZATION_ENGINE=fluidaudio npm run dev  # force FluidAudio (macOS)
```

See `docs/FLUIDAUDIO-INTEGRATION.md` for all options.

## Sharing with coworkers

**Option A — they run from source (simplest, fully transparent).**
Send them this repo URL; they follow the Quick start above. Everything is local; no accounts.

**Option B — build a `.dmg` to hand them.**
```bash
npm run build:mac:arm64      # Apple Silicon (build:mac:x64 for Intel); .dmg + .zip land in dist/
```
`prebuild:mac` runs automatically and now **builds + bundles FluidAudio into the app**, so you no
longer run `npm run setup:fluidaudio` by hand and recipients get ANE diarization out of the box.

This fork ships with signing/notarization **disabled** in `electron-builder.json` (`"identity": null`,
`"notarize": false`) so it builds without upstream's Apple Developer ID. Because the app is therefore
unsigned, macOS Gatekeeper blocks it on first launch until each recipient clears the quarantine flag once:
```bash
xattr -dr com.apple.quarantine "/Applications/OpenWhispr.app"
```
To distribute without that step, set `"identity"` to your own Developer ID and `"notarize": true` in
`electron-builder.json`, then export `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` before building.
Note: unsigned macOS apps can't auto-update, so coworkers reinstall newer `.dmg`s manually.

> **Before building a shareable `.dmg`:** the build bundles the repo's `.env` (`extraResources`). Make
> sure it contains no personal API keys, or build from a sanitized copy.

## Staying in sync with upstream OpenWhispr

This fork keeps changes isolated (two files + additive script/docs), so upstream updates merge
cleanly:

```bash
git remote add upstream https://github.com/OpenWhispr/openwhispr.git   # one-time
git fetch upstream
git merge upstream/main        # or: git rebase upstream/main
```

## Privacy / no phone-home

This fork is built to send **nothing off-device by default**. OpenWhispr already has no
analytics SDK (no PostHog/Sentry/Mixpanel/etc.); on top of that, the fork disables the few
things that still reached out:

- **Auth session ping** — Better Auth defaulted to pinging `auth.openwhispr.com/api/auth/get-session`
  on every window mount (even signed out). `AUTH_URL` now defaults empty, so the auth client is
  disabled unless you set `VITE_AUTH_URL`.
- **Automatic update check** — the startup ping to GitHub releases is disabled (a manual check
  still works if you ask for it). Unsigned fork builds can't auto-update anyway.
- **Google Fonts** — the onboarding `<link>` to `fonts.googleapis.com` is removed (system font
  fallback).
- **Onboarding intent** — the removed use-case step no longer POSTs your selections anywhere.

What still makes network calls, only when you ask: local model downloads (HuggingFace/GitHub) on
first use, and cloud STT/LLM providers **only** if you enter your own API keys (BYOK). To re-enable
OpenWhispr accounts/cloud, set `VITE_AUTH_URL` / the API URL back to the hosted endpoints.

## What's in this fork vs upstream

| | Upstream OpenWhispr | This fork |
|---|---|---|
| First-run onboarding | Account / signup + use-case survey | **Local-only, no signup, no survey** |
| Default transcription | Cloud (account) | **On-device Whisper `turbo`** |
| Telemetry / phone-home | Auth ping + update check + fonts fetch | **Disabled by default** |
| Local transcription (whisper.cpp) | ✅ | ✅ |
| N-speaker diarization (sherpa-onnx) | ✅ | ✅ |
| FluidAudio (ANE) diarization backend | — | ✅ auto-selected on macOS; **bundled into builds** |
| Editable/persistent speaker profiles | ✅ | ✅ |
| Cloud / account features | Default | Optional, opt-in via Settings |

Full technical detail: `docs/FLUIDAUDIO-INTEGRATION.md`. Research/rationale:
`docs/LOCAL-DIARIZATION-RESEARCH.md`.
