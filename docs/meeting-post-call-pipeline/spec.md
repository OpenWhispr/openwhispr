# Meeting Post-Call Pipeline & Speaker Management

**Status:** ready-for-agent
**Date:** 2026-07-27
**Author:** Gerald Onyango

---

## Problem Statement

After a meeting ends in OpenWhispr, the user has no idea what's happening. Post-call diarization runs silently in the background with no completion signal. There is no way to see all detected speakers, rename them, merge duplicates, or filter the transcript by speaker. The user must manually click "Re-transcribe (high quality)" and then manually run an AI action to generate a title and notes — all with zero progress feedback. The live speaker identifier is broken for group calls (caps at 1 speaker due to a math error). Meeting notes have no structure — the AI generates generic summaries with no awareness of what kind of meeting it was.

The user wants a fully automated post-call pipeline: call ends, and 5-10 minutes later the meeting note is fully baked — titled, summarized with structured notes, speakers labeled — with progress visible at all times. They want to skim the live transcript immediately, then come back to polished results. They want meeting types with templates so the AI generates notes in the right format for standups vs. architecture reviews vs. 1:1s.

## Solution

A sequential post-call pipeline that runs automatically after every meeting, with a background job queue, global progress UI, and a speaker management panel. Meeting types with note templates guide the AI to produce structured, relevant notes.

### Post-Call Pipeline (sequential, automatic)

1. **Diarization** — refine speaker labels from the full recording (existing, runs today)
2. **Re-transcribe** — re-run transcription with whisper.cpp large-v3 for higher accuracy
3. **Generate title** — AI produces a concise title from the polished transcript
4. **Generate notes** — AI produces structured notes using the meeting type's template

Each step starts only after the previous one completes. No parallel model calls.

### Speaker Management (Concept C: Bottom Panel)

A collapsible bottom panel below the transcript showing all detected speakers as grid cards. Supports renaming, merging duplicates, and filtering the transcript by clicking a speaker. A morph pill in the note metadata shows live pipeline status and speaker count.

### Meeting Types with Templates

User-defined meeting categories with optional note templates. Every template includes an action items section. The AI uses the template to structure its note generation output. Users can re-generate notes on an existing transcript using a different template.

## User Stories

1. As a meeting host, I want the app to automatically re-transcribe my meeting with a high-quality model after the call ends, so that I get accurate results without manual action.
2. As a meeting host, I want the app to automatically generate a meeting title from the transcript, so that my meeting notes have descriptive names without me typing one.
3. As a meeting host, I want the app to automatically generate structured meeting notes after re-transcription, so that I have a polished summary when I come back to the note.
4. As a meeting host, I want to see which pipeline step is currently running (diarizing, re-transcribing, generating title, generating notes), so that I know the app is working and how far along it is.
5. As a meeting host, I want pipeline progress to be visible regardless of which page I'm on in the app, so that I can navigate freely while processing happens.
6. As a meeting host, I want the app to detect if a background model crashes and surface the error, so that failures don't go unnoticed.
7. As a meeting host, I want model-invoking actions to queue up and run one at a time, so that system resources are managed and the app stays responsive.
8. As a meeting host, I want to see all detected speakers in a panel after the call, so that I know how many people were identified and who said what.
9. As a meeting host, I want to rename speakers in the panel (e.g., "Speaker 2" to "Molly"), so that the transcript is readable and attributable.
10. As a meeting host, I want to merge two speakers that the system incorrectly split, so that one person isn't shown as two.
11. As a meeting host, I want to click a speaker to filter the transcript to only their segments, so that I can find what a specific person said.
12. As a meeting host, I want the speaker panel to show segment count and talk-time percentage per speaker, so that I can see participation balance.
13. As a meeting host, I want a morph pill in the note metadata that transitions from "Finalizing speakers..." to "5 speakers detected", so that I have a clear completion signal.
14. As a meeting host, I want to define meeting types (Standup, 1:1, Team Sync, etc.) with note templates, so that AI-generated notes match the meeting's purpose.
15. As a meeting host, I want to assign a meeting type when starting a recording or from the note after, so that the pipeline knows which template to use.
16. As a meeting host, I want calendar events to auto-map to meeting types based on keywords or rules, so that recurring meetings don't need manual type selection each time.
17. As a meeting host, I want every meeting template to include an action items section, so that follow-ups are always captured regardless of meeting type.
18. As a meeting host, I want to re-generate notes on an existing transcript using a different template, so that I can get a standup summary re-formatted as a team sync or vice versa.
19. As a meeting host, I want re-transcribe progress to show stages (converting audio, transcribing, re-diarizing) with elapsed time, so that I know it hasn't stalled.
20. As a meeting host, I want to see a summary of what changed after re-transcription (e.g., "Updated 12 of 47 segments, 3 new speaker splits"), so that I know the re-transcribe was worthwhile.
21. As a meeting host, I want the large whisper model to be pre-downloaded after my first meeting recording, so that auto re-transcribe doesn't block on a 3GB download.
22. As a meeting host, I want the app to remain fully usable while background processing runs, so that I can take other notes or start another meeting.
23. As a group call participant, I want the live speaker identifier to correctly detect multiple remote speakers on system audio, so that the live transcript has accurate speaker labels from the start.
24. As a meeting host, I want to create custom meeting types with my own note template structure, so that I can handle non-standard meeting formats.
25. As a meeting host, I want built-in meeting types for common formats (Standup, 1:1, Team Sync, Project Sync, Sprint Planning, Architecture Review, Customer Call), so that I don't have to write templates from scratch.
26. As a meeting host, I want the diarization "Finalizing speakers..." indicator to always show after a call regardless of whether I dismissed the speaker hint during recording, so that I always know when post-call processing is happening.
27. As a meeting host, I want the speaker count stepper to support up to 15 speakers, so that large group calls are handled properly.

## Implementation Decisions

### Post-Call Pipeline Manager

- New module `PostCallPipelineManager` in `src/helpers/` that orchestrates the sequential pipeline.
- Fires automatically from the existing `_startOrSkipDiarization` completion point (ipcHandlers.js, after diarization sends `meeting-diarization-complete`).
- Each step is a discrete async function. The manager runs them sequentially: diarization (existing) -> re-transcribe -> generate title -> generate notes.
- The manager emits IPC events for each state transition: `post-call-pipeline-status` with `{ noteId, step, status, detail }` where step is `diarization | retranscribe | title | notes` and status is `pending | running | complete | error`.
- On error at any step, the pipeline stops, surfaces the error via IPC, and the user can retry from the failed step.

### Background Job Queue

- Model-invoking actions (re-transcribe, title generation, note generation, user-triggered AI actions) go through a shared queue.
- The queue processes one job at a time to manage system resources (whisper.cpp and LLM inference are both CPU/GPU intensive).
- Health monitoring: the queue polls the active model process at a regular interval. If the process exits unexpectedly or stops responding, the queue marks the job as failed and emits an error event.
- Jobs are scoped to the main process. The renderer subscribes to status events via IPC.

### Global Status UI

- A persistent, minimal status indicator visible on every page (not just the note being processed).
- Renders in the app's chrome (e.g., bottom bar or top-right corner), not inside the note editor.
- Shows: which note is processing, which step, elapsed time. Clicking it navigates to the note.
- Disappears when the pipeline completes (or collapses to a "done" state that auto-dismisses).
- Multiple notes can be queued (e.g., two meetings back-to-back) — the indicator shows the active one and a queue count.

### Speaker Management Panel (Concept C)

- Collapsible bottom panel below the transcript view, toggled by a morph pill in the note metadata.
- Grid layout showing each detected speaker as a card with: color-coded avatar, name (editable), segment count, talk-time percentage.
- Click a speaker card to filter the transcript (dim non-matching segments).
- Multi-select for merging: select two speakers, click "Merge" to combine their segments and embeddings.
- The morph pill transitions through states: spinning "Finalizing speakers..." -> checkmark "N speakers detected - View all".
- The "Finalizing speakers..." state is non-dismissable (separate from the recording hint dismiss state).

### Re-Transcription

- Auto-triggered as pipeline step 2 after diarization completes.
- Uses whisper.cpp large-v3 model with Metal acceleration on Apple Silicon.
- Requires saved Opus audio files (system or mic track) — gated on `dataRetentionEnabled`.
- The large model (~3GB) should be auto-downloaded in the background after the user's first meeting recording, so it's ready for future auto re-transcriptions.
- The existing 5-minute HTTP timeout on whisper-server may need to be raised for longer meetings.
- After completion, a diff summary is computed: segments changed count, new speaker splits, word error rate estimate if feasible.

### Title & Notes Generation

- Pipeline steps 3 and 4, using the user's configured AI model/provider for the `noteFormatting` inference scope.
- Title generation: same as existing `generateNoteTitle` — 3-8 word concise title from the transcript.
- Notes generation: uses the meeting type's template as the system prompt structure. If no meeting type is set, falls back to a generic summary (current behavior).
- Re-generation with a different template: a "Regenerate Notes" action in the UI lets the user pick a different meeting type and re-run step 4 on the existing transcript. This does not re-run steps 1-3.
- The notes generation receives the full polished transcript (from step 2) with speaker labels (from step 1).

### Meeting Types

- New SQLite table `meeting_types`: `id, name, template, is_builtin, created_at, updated_at`.
- Built-in types seeded on first run (not editable, but can be duplicated-then-customized):
  - **Standup**: Per speaker: yesterday, today, blockers. Action items.
  - **1:1**: Discussion topics, feedback given/received, decisions. Action items.
  - **Team Sync**: Highlights/personal updates, announcements, what each person worked on (past week). Action items.
  - **Project Sync**: Project status updates, milestones hit/missed, risks/blockers, decisions. Action items.
  - **Sprint Planning**: Stories discussed, estimates agreed, sprint goals, carryover. Action items.
  - **Architecture Review**: Decisions made, alternatives considered, risks. Action items.
  - **Customer Call**: Customer pain points, feature requests, commitments made. Action items.
- Every template includes an "Action Items" section — this is mandatory and appended automatically if the user omits it from a custom template.
- Notes table gets a new column: `meeting_type_id INTEGER REFERENCES meeting_types(id)`.
- Calendar event auto-mapping: optional rules (keyword in event title -> meeting type) stored in a `meeting_type_rules` table or as a JSON field on the meeting type.
- UI: meeting type picker in the note header (next to "Add attendees") and in the meeting start flow.

### Bug Fixes (already applied in this session)

- `resolveSessionMaxSpeakers()`: removed the `- 1` subtraction that capped live diarization at 1 speaker by default. System audio never contains the local mic speaker, so the full expected count is the correct cap.
- `MAX_SPEAKER_COUNT`: raised from 8 to 15 in `speakerDetection.json`.
- Diarization pill: `isDiarizing` state now always shows regardless of `hintDismissed`, and the dismiss button is hidden during the diarizing state.

## Testing Decisions

### What makes a good test

Tests should verify external behavior through the IPC boundary — call the handler, assert the response and emitted events. Do not mock internal modules unless they make network calls or spawn child processes (whisper-server, diarization binaries). The IPC boundary is the primary seam.

### Modules to test

1. **PostCallPipelineManager** — test the sequential execution: mock each step's async function, verify they run in order, verify error at step N stops the pipeline, verify IPC status events are emitted at each transition.
2. **Background job queue** — test FIFO ordering, single-concurrency enforcement, health check failure detection, error propagation.
3. **Meeting types CRUD** — test SQLite operations: create, read, update, delete, seed built-ins on first run, auto-map from calendar event keywords.
4. **`resolveSessionMaxSpeakers`** — test that default returns 2 (not 1), that user-set counts are respected, that MAX_SPEAKER_COUNT caps correctly.
5. **Re-transcription diff** — test segment comparison logic: count changed segments, detect new speaker splits.
6. **Template-based note generation** — test that the meeting type's template is passed as the system prompt structure, that re-generation with a different template works on existing transcript.

### Prior art

- `test/helpers/dictationRouting.test.js` — Node built-in test runner, mocking IPC and settings.
- `test/helpers/parakeetOnlineStream.test.js` — mock websocket server pattern.
- Tests use `node --test` runner, not Jest.

## Out of Scope

- **Real-time streaming transcription** — live transcript is chunked, not true streaming. No changes to the live transcription pipeline.
- **Cloud-based re-transcription** — auto re-transcribe uses local whisper.cpp only. Cloud Whisper API is not part of the auto pipeline.
- **Speaker voice training / enrollment** — the existing speaker profile system handles voice fingerprinting. This spec does not add explicit training flows.
- **Collaborative editing of meeting notes** — notes are local-only in this fork. No multi-user editing.
- **Custom dictionary support for Parakeet** — the sherpa-onnx hotwords integration is a separate feature.
- **Push notifications / OS-level alerts** — the global status indicator is in-app only.

## Further Notes

- The large whisper model auto-download should respect network conditions — don't start a 3GB download on metered connections without warning.
- The 5-minute HTTP timeout on whisper-server (`whisperServer.js:712`) may need to be raised for meetings longer than ~45 minutes when using the large model. Consider making it proportional to audio duration.
- The morph pill design and speaker panel layout are prototyped in `_temp/design-demos/meeting-post-call-ux.html` (Concept C).
- Meeting type templates are plain text instructions to the AI, not structured schemas. This keeps them simple to create and edit. Example: "For each speaker, summarize: what they did last week, what they're working on this week, any blockers. End with a consolidated Action Items section."
- The pipeline should be opt-out — a setting to disable auto re-transcribe and/or auto note generation for users who prefer manual control. Default is on.
