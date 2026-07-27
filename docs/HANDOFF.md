# OpenWhispr Fork — Handoff

_Updated 2026-07-27. Pick-up doc for the futuregerald/openwhispr fork. Full narrative in [`DECISIONS-LOG.md`](DECISIONS-LOG.md)._

## Current state

- **`main` @ `a96fadf8`**, version **1.9.0**. **4 commits ahead of origin (not pushed). No open PRs.**
- This session: fixed 3 bugs (live diarization 1-speaker cap, max speaker count, pill dismiss), wrote a comprehensive spec for the meeting post-call pipeline feature (`docs/meeting-post-call-pipeline/spec.md`), created an interactive design prototype (Concept C selected), and documented Gatekeeper bypass methods.
- The fork is a fully local, private meeting transcriber: on-device **Parakeet TDT** transcription by default, **FluidAudio (ANE)** / sherpa-onnx **N-speaker diarization**, local-only onboarding (no signup), telemetry off, cloud/account UI removed, opt-in **auto-start/stop recording**, **meeting audio saving** (Opus, retention-gated), **whisper large-v3 re-transcription**, and a hardened build.

## Next: Meeting Post-Call Pipeline (spec ready, needs plan + implementation)

**Spec:** `docs/meeting-post-call-pipeline/spec.md` — 27 user stories, implementation decisions, testing strategy.
**Design:** `docs/meeting-post-call-pipeline/design-prototype.html` — Concept C (bottom panel + morph pill). Open in browser.

### Feature summary

Sequential post-call pipeline that runs automatically after every meeting:
1. **Diarization** → 2. **Re-transcribe** (large-v3) → 3. **Generate title** → 4. **Generate notes** (using meeting type template)

Each step starts after the previous completes. No parallel model calls.

Plus: background job queue with health monitoring, global status UI on every page, speaker management panel (rename/merge/filter), meeting types with note templates (7 built-ins + custom), re-generate notes with different template, auto-download large whisper model.

### Key user preferences driving the design
- Over-separate speakers, let user merge (not the reverse)
- Async background processing — skim live results, come back to polished 5-10 min later
- Every meeting template must include action items
- LLM crashes must be detected and surfaced
- App must remain fully usable during background processing

## Unpushed commits (4, on main)

| Hash | Description |
|------|-------------|
| `e0173c95` | docs: Gatekeeper bypass methods in README + FORK-SETUP |
| `ab39c42d` | fix: live diarization capped at 1 speaker, raise max to 15, fix pill dismiss |
| `d49a46ec` | docs: spec for meeting post-call pipeline and speaker management |
| `a96fadf8` | docs: Concept C design prototype as implementation reference |

## Merged PRs (prior sessions, all on origin/main)
- **#10** meeting audio saving + whisper large-v3 re-transcription + auto-start URL-gate fix + v1.9.0 bump.
- **Post-PR-10 direct commits:** removed user profile footer + dead upgrade banners; fixed `cleanupExpiredAudio` variable reference bug.
- **#9** diarization quality: FluidAudio offline mode + auto-detect speaker count.
- **#8** build hardening: `verify:binaries`.
- **#7** dev: auto-fetch binaries.
- **#6** auto-stop fix.
- **#5** opt-in auto-start recording.
- #1–#4: FluidAudio + local-only onboarding + telemetry-off + Parakeet default + unsigned builds.

## Repo / environment
- Local clone: `~/Documents/dev/openwhispr`. `origin` = fork (push here), `upstream` = OpenWhispr/openwhispr (pull only). FluidAudio src for rebuilds: `~/Documents/dev/FluidAudio` (pinned v0.15.5).
- **Workflow policy: open PRs and LEAVE THEM OPEN for review — do NOT auto-merge.** Gerald merges.
- **Node**: project pins 24 (`.nvmrc`), user has 25.6.0 installed (works for building — do NOT regenerate `package-lock.json`).

## Run / build
```bash
npm install && npm run setup:fluidaudio && npm run dev   # dev
npm run build:mac:arm64                                   # → dist/OpenWhispr-1.9.0-arm64.dmg (unsigned)
# recipients: xattr -dr com.apple.quarantine "/Applications/OpenWhispr.app"
# or: right-click → Open, or System Settings → Privacy & Security → Open Anyway
```
Typecheck: `cd src && npx tsc --noEmit`.

## Where data/audio lives
- **Production userData: `~/Library/Application Support/open-whispr`** (lowercase). Dev build: `OpenWhispr-development`.
- **DB:** `open-whispr/transcriptions.db` (better-sqlite3). Notes in `notes` table, transcript = JSON in `notes.transcript`.
- **Meeting audio (v1.9.0):** `.opus` in `open-whispr/audio/` — mic + system tracks. Gated on `dataRetentionEnabled`. Paths in `notes.mic_audio_path` / `notes.system_audio_path`.

## Key code locations

| What | Where |
|------|-------|
| Speaker detection constants | `src/constants/speakerDetection.json` |
| Live speaker identifier | `src/helpers/liveSpeakerIdentifier.js` |
| resolveSessionMaxSpeakers | `src/helpers/ipcHandlers.js:5331` |
| Post-call diarization | `src/helpers/ipcHandlers.js:9284` (`_startOrSkipDiarization`) |
| Re-transcribe handler | `src/helpers/ipcHandlers.js:1000` (`retranscribe-meeting-note`) |
| Diarization pill UI | `src/components/notes/MeetingTranscriptChat.tsx:687` |
| Note generation (current) | `src/stores/actionProcessingStore.ts:157` + `src/utils/generateTitle.ts` |
| Notes schema | `src/helpers/database.js:105` |
| Whisper server timeout | `src/helpers/whisperServer.js:712` (300000ms) |
| Meeting detection engine | `src/helpers/meetingDetectionEngine.js` |

## Open findings / risks
- **Custom dictionary doesn't work with Parakeet** — words only passed to Whisper. sherpa-onnx `--hotwords-file` not wired up. Dictionary tab shows regardless of engine (misleading UX). Not in scope for the pipeline spec.
- **Re-transcribe 5-min timeout** may be too short for meetings >45 min with the large model. Consider making it proportional to audio duration.
- **Large whisper model (~3GB)** currently download-on-demand only. Auto pipeline needs background pre-download.
- **Low capture gain:** mean −40 to −50 dB on saved dictation audio. Needs verification on a real call.

## Gotchas
- `ipcHandlers.js` is 9500+ lines — always re-verify line numbers before editing.
- `resources/bin/` is gitignored (binaries built/downloaded, not committed).
- `gh pr create` defaults to upstream repo for forks — always use `--repo futuregerald/openwhispr`.
- Existing installs keep persisted localStorage; default changes apply to fresh installs.

## Suggested skills

| Skill | When to Use |
|-------|-------------|
| `writing-plans` | Write the implementation plan from the spec before coding |
| `subagent-driven-development` | Execute independent tasks in parallel |
| `test-driven-development` | TDD for PostCallPipelineManager, job queue, meeting types CRUD |
| `javascript-testing-patterns` | Node built-in test runner patterns (prior art: `test/helpers/dictationRouting.test.js`) |
| `comprehensive-code-review` | Review all changes before committing |
| `pull-request-description` | When creating the PR |
| `sql-optimization-patterns` | If meeting_types schema needs indexing decisions |

---

## Resume prompt (paste into a fresh session)

> I'm continuing work on my OpenWhispr fork at `~/Documents/dev/openwhispr` (a fully local, private meeting transcriber; remotes: origin = my fork futuregerald/openwhispr, upstream = OpenWhispr/openwhispr). Read `docs/HANDOFF.md` first for full context. `main` has 4 unpushed commits with bug fixes + a feature spec. **Policy: open PRs and leave them open for me to review — never auto-merge.**
>
> **Next step:** Read `docs/meeting-post-call-pipeline/spec.md` (27 user stories) and `docs/meeting-post-call-pipeline/design-prototype.html` (Concept C design). Write an implementation plan using the `writing-plans` skill, then execute it. The spec covers: sequential post-call pipeline (diarize → re-transcribe → title → notes), background job queue, global status UI, speaker management panel, meeting types with templates. Three bug fixes are already committed (live diarization 1-speaker cap, max speakers 15, pill dismiss).
