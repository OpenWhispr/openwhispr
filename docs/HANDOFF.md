# OpenWhispr Fork — Handoff

_Updated 2026-07-20. Pick-up doc for the futuregerald/openwhispr fork. Full narrative in [`DECISIONS-LOG.md`](DECISIONS-LOG.md)._

## Current state

- **`main` @ `a5a84fda`**, version **1.8.0**. **PRs #1–#9 all merged. No open PRs.**
- The fork is a fully local, private meeting transcriber: on-device **Parakeet TDT** transcription by default, **FluidAudio (ANE)** / sherpa-onnx **N-speaker diarization**, local-only onboarding (no signup), telemetry off, cloud/account UI removed, opt-in **auto-start/stop recording**, and a hardened build.
- **PR 2 plan is written and ready to execute** at `docs/plans/2026-07-17-meeting-audio-and-retranscription.md`. Plan file is untracked (not yet committed). 18 tasks across 6 feature areas.

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

## PR 2 — Plan ready, execution pending

**Plan file:** `docs/plans/2026-07-17-meeting-audio-and-retranscription.md`
**Execution mode:** Subagent-driven development (Opus subagents per task batch, review between batches).

### 6 feature areas (18 tasks total):

1. **Meeting audio saving** (Tasks 1.1–1.9): DB migration (`mic_audio_path`/`system_audio_path` on `notes`), `encodePcmToOpus` ffmpeg helper, mic PCM write stream in recording pipeline, `_saveMeetingAudio` class method, renderer passes `saveAudio` flag via IPC, wire into stop flow with system PCM copy, note audio IPC handlers.
2. **Whisper large-v3 re-transcription** (Tasks 2.1–2.3): `retranscribe-meeting-note` IPC handler (reads saved Opus, feeds whisper-server large-v3, re-runs diarization, overwrites transcript), model download check, "Re-transcribe (high quality)" UI button.
3. **Capture gain diagnostic** (Task 3.1): RMS level logging at system PCM write point. If dBFS < −40, add loudnorm in follow-up.
4. **Auto-start URL-gate fix** (Tasks 4.1–4.3): `browserMeetingUrlChecker.js` now distinguishes timeout from "no meeting" via `unavailable` flag; `_handleCallActive` trusts device signal when URL check is unavailable.
5. **MCP card removal** (Task 5.1): Remove dead `McpIntegrationCard` import/usage from `IntegrationsView.tsx`.
6. **Version bump** (Task 6.1): 1.8.0 → 1.9.0 + CHANGELOG.

### Key code facts verified during planning:
- Main process has **no** `_getSettings()` — renderer must pass `saveAudio: dataRetentionEnabled` through `meeting-transcription-stop` IPC (update 4 files: ipcHandlers.js, preload.js, types/electron.ts, meetingRecordingStore.ts)
- `_startOrSkipDiarization` deletes `rawPcmPath` in its `finally` block (line 9274) — must `fs.copyFileSync` before passing to both diarization and audio encoding
- `checkForActiveMeetingUrl` returns `{ matched: false }` identically for timeout AND "no meeting found" — this is the auto-start bug root cause
- `ipcHandlers.js` is 9300+ lines — all line numbers are approximate, re-verify before each edit

## Open findings / risks to chase
- **Low capture gain:** saved dictation audio measured **mean −40 to −50 dB** (normal speech ~−20 to −30). Verify on a real call (Task 3.1 adds diagnostic logging).
- **Auto-start/stop unverified on a real call.** Tasks 4.1–4.3 fix the URL-gate bug; still need a real Google Meet call to confirm.
- Diarization real quality only judgeable on a genuine multi-party recording — which needs PR 2's audio saving to re-run/tune.

## Gotchas
- Existing installs keep persisted localStorage; default changes apply to fresh installs. Reset dev profile: `rm -rf ~/Library/"Application Support"/OpenWhispr-development`.
- `resources/bin/` is gitignored (binaries built/downloaded, not committed). FluidAudio auto-selects only if its binary is present.
- `package-lock.json` has a stale diff (unrelated) — ignore or reset before committing PR 2 work.

---

## Resume prompt (paste into a fresh session)

> I'm continuing work on my OpenWhispr fork at `~/Documents/dev/openwhispr` (a fully local, private meeting transcriber; remotes: origin = my fork futuregerald/openwhispr, upstream = OpenWhispr/openwhispr). Read `docs/HANDOFF.md` first for full context. `main` is at v1.8.0 with PRs #1–#9 merged, no open PRs. **Policy: open PRs and leave them open for me to review — never auto-merge.**
>
> **The PR 2 implementation plan is already written** at `docs/plans/2026-07-17-meeting-audio-and-retranscription.md` — read it. It has 18 tasks across 6 feature areas: (1) save meeting audio as separate mic + system Opus tracks (retention-gated), (2) whisper.cpp large-v3 post-call re-transcription, (3) capture gain diagnostic, (4) auto-start URL-gate fix, (5) MCP card removal, (6) v1.9.0 version bump.
>
> **Execute the plan now using subagent-driven development.** Create a feature branch from main, commit the plan file first, then dispatch Opus subagents per task batch (the plan has a dependency graph and recommended parallel batches at the bottom). Review between batches. `ipcHandlers.js` is 9300+ lines — always re-verify line numbers before editing. After all tasks: open a PR and leave it open for me. Do not wait for my input between batches unless you hit a blocking issue.
