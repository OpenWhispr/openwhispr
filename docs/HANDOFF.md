# OpenWhispr Fork — Handoff

_Updated 2026-07-24. Pick-up doc for the futuregerald/openwhispr fork. Full narrative in [`DECISIONS-LOG.md`](DECISIONS-LOG.md)._

## Current state

- **`main` @ `99848f99`**, version **1.9.0**. **PRs #1–#10 all merged. No open PRs.**
- The fork is a fully local, private meeting transcriber: on-device **Parakeet TDT** transcription by default, **FluidAudio (ANE)** / sherpa-onnx **N-speaker diarization**, local-only onboarding (no signup), telemetry off, cloud/account UI removed, opt-in **auto-start/stop recording**, **meeting audio saving** (Opus, retention-gated), **whisper large-v3 re-transcription**, and a hardened build.
- **Adversarial requirements audit completed** — 22/22 requirements PASS. Full audit table in session history.

## Merged PRs (recent first)
- **#10** meeting audio saving + whisper large-v3 re-transcription + auto-start URL-gate fix + MCP card removal + v1.9.0 bump. Plus code review fixes (opus retention cleanup, tmpWav path safety, _handleAudioRetention dedup, RMS try/catch, modelPath leak, isAvailable guard, require("os") cleanup).
- **Post-PR-10 direct commits:** removed user profile footer + dead upgrade/limit banners from ControlPanelSidebar; fixed broken `expiredIds` variable reference in `cleanupExpiredAudio`.
- **#9** diarization quality: FluidAudio offline mode + auto-detect speaker count.
- **#8** build hardening: `verify:binaries` fails the build if a critical sidecar is missing.
- **#7** dev: `npm run dev` now auto-fetches llama-server/whisper-cpp/diarization models.
- **#6** auto-stop fix: end-detection uses camera release / meeting-URL poll + 4h cap.
- **#5** opt-in auto-start recording: native macos-call-detector + browser URL filter.
- #1–#4: FluidAudio backend + local-only onboarding + telemetry-off + unsigned builds; Parakeet default; local+self-hosted-only STT + removed account/plans/billing/Pro; version 1.8.0.

## Repo / environment
- Local clone: `~/Documents/dev/openwhispr`. `origin` = fork (push here), `upstream` = OpenWhispr/openwhispr (pull only). FluidAudio src for rebuilds: `~/Documents/dev/FluidAudio` (pinned v0.15.5).
- **Workflow policy: open PRs and LEAVE THEM OPEN for review — do NOT auto-merge.** Gerald merges.

## Run / build
```bash
npm install && npm run setup:fluidaudio && npm run dev   # dev
npm run build:mac:arm64                                   # → dist/OpenWhispr-1.9.0-arm64.dmg (unsigned)
# recipients: xattr -dr com.apple.quarantine "/Applications/OpenWhispr.app"
```
Typecheck: `cd src && npx tsc --noEmit`.

## Where data/audio lives (important — confusing)
- **Production userData: `~/Library/Application Support/open-whispr`** (lowercase, uses package `name`, NOT "OpenWhispr"). Dev build: `OpenWhispr-development`.
- **DB:** `open-whispr/transcriptions.db` (better-sqlite3). Notes (meetings) in `notes` table, transcript = JSON in `notes.transcript`. Dictations in `transcriptions` table (`has_audio`).
- **Dictation audio:** saved as `.webm` in `open-whispr/audio/`.
- **Meeting audio (v1.9.0):** saved as `.opus` in `open-whispr/audio/` — separate mic + system tracks. Gated on `dataRetentionEnabled`. Paths in `notes.mic_audio_path` / `notes.system_audio_path`. Included in retention cleanup.

## Key architecture (v1.9.0)

### Meeting audio pipeline
1. Recording captures mic + system as separate PCM streams
2. System PCM written to temp file for diarization; mic PCM written to temp file for retention
3. At stop: system PCM `copyFileSync`'d before diarization cleanup (which deletes original)
4. Both tracks encoded to Opus via `encodePcmToOpus` (FFmpeg, 32 kbps mono voip)
5. Paths stored in DB via `_saveMeetingAudio`; temp PCMs cleaned up
6. `_handleAudioRetention` deduplicates this logic across local-mode and streaming-mode stop branches

### Re-transcription
- `retranscribe-meeting-note` IPC handler reads saved Opus, feeds whisper-server large-v3, re-runs diarization on system track, overwrites `notes.transcript`
- UI button in NoteEditor, conditionally shown for meeting notes with saved audio
- Checks model download via `check-whisper-model-downloaded` before attempting

### Auto-start fix
- `browserMeetingUrlChecker` returns `{ matched: false, unavailable: true }` when all browsers fail
- `meetingDetectionEngine._handleCallActive` trusts device signal when URL check is unavailable/denied

## Open findings / risks to chase
- **Low capture gain:** saved dictation audio measured mean −40 to −50 dB. `meeting-gain` debug tag now logs RMS every 100 system chunks. Verify on a real call.
- **Auto-start/stop unverified on a real call.** URL-gate bug is fixed; needs a real Google Meet call to confirm.
- **Diarization accuracy** only judgeable on a genuine multi-party recording — now possible with saved audio.
- **Dead code remains** (intentionally, for upstream merge compatibility): UpgradePrompt, account/billing settings cases in SettingsPage, cloud STT providers in modelRegistryData.json. All unreachable in the fork.

## Gotchas
- Existing installs keep persisted localStorage; default changes apply to fresh installs. Reset dev profile: `rm -rf ~/Library/"Application Support"/OpenWhispr-development`.
- `resources/bin/` is gitignored (binaries built/downloaded, not committed). FluidAudio auto-selects only if its binary is present.
- `ipcHandlers.js` is 9500+ lines — always re-verify line numbers before editing.
- `gh pr create` defaults to upstream repo for forks — always use `--repo futuregerald/openwhispr`.

---

## Resume prompt (paste into a fresh session)

> I'm continuing work on my OpenWhispr fork at `~/Documents/dev/openwhispr` (a fully local, private meeting transcriber; remotes: origin = my fork futuregerald/openwhispr, upstream = OpenWhispr/openwhispr). Read `docs/HANDOFF.md` first for full context. `main` is at v1.9.0 (`99848f99`) with PRs #1–#10 merged, no open PRs. **Policy: open PRs and leave them open for me to review — never auto-merge.**
>
> All 22 requirements from the fork have been audited and pass (privacy/local-only, diarization, auto-start/stop, meeting audio saving, re-transcription, build hardening, version). The adversarial audit caught and fixed a `cleanupExpiredAudio` variable reference bug. Dead cloud/account code is intentionally kept for upstream merge compatibility.
>
> **Open items needing real-device testing:** (1) meeting audio saving end-to-end, (2) auto-start with revoked Automation permission, (3) re-transcribe button with large-v3 model download, (4) capture gain diagnostic on a real call.
