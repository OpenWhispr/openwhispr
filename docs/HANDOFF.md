# OpenWhispr Fork — Handoff

_Updated 2026-07-17. Pick-up doc for the futuregerald/openwhispr fork. Full narrative in [`DECISIONS-LOG.md`](DECISIONS-LOG.md)._

## Current state

- **`main` @ `1a65e740`**, version **1.8.0**. **PRs #1–#9 all merged. No open PRs.**
- The fork is a fully local, private meeting transcriber: on-device **Parakeet TDT** transcription by default, **FluidAudio (ANE)** / sherpa-onnx **N-speaker diarization**, local-only onboarding (no signup), telemetry off, cloud/account UI removed, opt-in **auto-start/stop recording**, and a hardened build.

## Merged PRs (recent first)
- **#9** diarization quality: FluidAudio → **offline** mode + **auto-detect speaker count** (max-speakers bound instead of a forced count). Fixes remote speakers collapsing into one.
- **#8** build hardening: `verify:binaries` fails the build if a critical sidecar (e.g. llama-server) is missing.
- **#7** dev: `npm run dev` now auto-fetches llama-server/whisper-cpp/diarization models.
- **#6** auto-stop fix: our own recording holds the mic, so end-detection uses **camera release** (video) / **meeting-URL poll** (audio-only) + a 4h cap.
- **#5** opt-in **auto-start** recording: native `macos-call-detector` (camera/mic device-in-use) + AppleScript meeting-URL filter + engine wiring.
- #1–#4: FluidAudio backend + local-only onboarding + telemetry-off + unsigned builds; Parakeet default; local+self-hosted-only STT + removed account/plans/billing/Pro; version 1.8.0.

## Repo / environment
- Local clone: `~/Documents/dev/openwhispr`. `origin` = fork (push here), `upstream` = OpenWhispr/openwhispr (pull only). FluidAudio src for rebuilds: `~/Documents/dev/FluidAudio` (pinned v0.15.5).
- **Workflow policy: open PRs and LEAVE THEM OPEN for review — do NOT auto-merge.** Gerald merges.

## Run / build
```bash
npm install && npm run setup:fluidaudio && npm run dev   # dev
npm run build:mac:arm64                                   # → dist/OpenWhispr-1.8.0-arm64.dmg (unsigned)
# recipients: xattr -dr com.apple.quarantine "/Applications/OpenWhispr.app"
```
Typecheck: `cd src && npx tsc --noEmit`. A freshly rebuilt working `.dmg` exists at `dist/OpenWhispr-1.8.0-arm64.dmg` (now includes llama-server; the earlier installed build was missing it due to a build-time download failure — #8 now guards that).

## Where data/audio lives (important — confusing)
- **Production userData: `~/Library/Application Support/open-whispr`** (lowercase, uses package `name`, NOT "OpenWhispr"). Dev build: `OpenWhispr-development`.
- **DB:** `open-whispr/transcriptions.db` (better-sqlite3). Notes (meetings) in `notes` table, transcript = JSON in `notes.transcript`. Dictations in `transcriptions` table (`has_audio`).
- **Dictation audio:** saved as `.webm` in `open-whispr/audio/`. **Meeting audio is NOT saved** (see PR 2).

## Meeting pipeline facts
- Recording captures **mic + system as separate streams** (`meetingRecordingStore.ts`); the **system channel only** is written to a temp PCM (16-bit mono 24 kHz) for diarization (`ipcHandlers.js` ~6207–6215) and **deleted** after (`_startOrSkipDiarization` ~9075, unlink ~9269). Mic PCM is not persisted.
- **Diarization is already POST-CALL**, system-channel only. Engine dispatch in `src/helpers/diarization.js`. After #9: FluidAudio offline + auto-count. A **live** speaker identifier (`liveSpeakerIdentifier.js`, CAM++ cosine ≥ 0.65) labels in real time during the call.
- Common audio sink: `dispatchMeetingAudioBuffer` (`ipcHandlers.js` ~5261); stop/cleanup ~5743 and ~4685; `meeting-transcription-send` IPC ~6345.

## NEXT UP — PR 2 (the main pending work)
**Meeting-audio saving + whisper large-v3 re-pass.** Deferred from #9 because it touches the delicate recording lifecycle and deserves care. Decisions already made:
1. **Save meeting audio** as **separate mic + system Opus tracks (~24–32 kbps mono)** via the bundled ffmpeg (`ffmpegUtils`, `getFFmpegPath`), into `open-whispr/audio/` (or attached to the note), **gated on `dataRetentionEnabled`** (settingsStore, default true). Separate tracks so diarization can re-run cleanly and "you"=mic is trivial. Hook: system PCM temp file already exists — add mic PCM capture and, on stop, encode both to Opus + reference the note **before** deleting the PCM. Mirror how dictation gates/saves audio (`save-transcription-audio` IPC ~952, `has_audio`).
2. **Whisper large-v3 post-call re-pass** (NOT WhisperX — CTranslate2 has no Metal so it's CPU-slow on Mac, ~6–20 min/30-min call; whisper.cpp large-v3 uses Metal, ~2–5 min, no Python). Run whisper-server large-v3 (`src/helpers/whisper.js`/`whisperServer.js`; ~3 GB `ggml-large-v3` download) on the saved audio, then re-run diarization + `mergeWithTranscript` and rewrite `notes.transcript`. Expose as an on-demand "Re-transcribe (high quality)" action and/or automatic post-call.

## Open findings / risks to chase
- **Low capture gain:** saved dictation audio measured **mean −40 to −50 dB** (normal speech ~−20 to −30). If real meetings are that quiet, it wrecks diarization + STT — verify on a real call and consider a normalization/gain stage before diarization. **Verify this before over-tuning engines.**
- **Auto-start/stop unverified on a real call.** Likely-too-strict gate: `_handleCallActive` requires the URL check to return `matched` OR `denied`; if the AppleScript **times out** (Automation prompt pending) it returns neither → auto-start is blocked. Consider: auto-start on device-in-use whenever the URL check can't run, only skipping when it *reliably* finds no meeting tab. First check the "Auto-start recording in meetings" toggle is even ON (Settings → General, default off) and Automation permission granted.
- Diarization real quality only judgeable on a genuine multi-party recording — which needs PR 2's audio saving to re-run/tune.
- Fable subagent model was returning **529 Overloaded** repeatedly on 2026-07-16 — retry for planning, or plan directly with Opus.

## Gotchas
- Existing installs keep persisted localStorage; default changes apply to fresh installs. Reset dev profile: `rm -rf ~/Library/"Application Support"/OpenWhispr-development`.
- `resources/bin/` is gitignored (binaries built/downloaded, not committed). FluidAudio auto-selects only if its binary is present.

---

## Resume prompt (paste into a fresh session)

> I'm continuing work on my OpenWhispr fork at `~/Documents/dev/openwhispr` (a fully local, private meeting transcriber; remotes: origin=my fork futuregerald/openwhispr, upstream=OpenWhispr/openwhispr). Read `docs/HANDOFF.md` and `docs/DECISIONS-LOG.md` first for full context. `main` is at v1.8.0 with PRs #1–#9 merged. **Policy: open PRs and leave them open for me to review — never auto-merge.** Use a Fable subagent to plan non-trivial work and Opus to execute; investigate the real code before editing. **Next task: PR 2 — save meeting audio (separate mic + system Opus tracks, retention-gated, via bundled ffmpeg) AND add a whisper.cpp large-v3 post-call re-transcription pass that rewrites the note transcript and re-runs diarization** (NOT WhisperX — it's CPU-slow on Mac). Before over-tuning: verify the real meeting capture gain isn't too low (saved test audio was −40 to −50 dB). Also still open: verify/​fix auto-start/stop on a real call (the URL-gate may be too strict when macOS Automation permission isn't granted), and decide on removing the dead MCP settings card. Start by reading the handoff, then have Fable plan PR 2.
