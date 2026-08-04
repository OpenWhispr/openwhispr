# Plan: all open issues (revision 3)

Date: 2026-08-04
Status: reviewed twice; ready to implement in the stated order
Supersedes: revisions 1 and 2 of this file

Revision 1 missed the worst bug entirely. Revision 2 found it but got the fix
and the ordering wrong. Revision 3 adopts the second review's prescriptions
rather than inventing new designs. Every claim carries a `file:line`.

**Ordering changed on evidence:** data loss is already shipped and is running on
users' machines automatically; the diarization regression is local-only and
unreleased. Data loss goes first.

---

## P0-1 — Re-transcription destroys transcripts (SHIPPED IN v1.12.0, ACTIVE)

Four distinct defects in one flow. This runs automatically after every meeting
(`_enqueuePostCallPipeline`, `ipcHandlers.js:7494`), so released users hit it
with no action of their own.

### (a) Plain text overwrites structured segments
`postCallPipelineManager.js:255` `let finalTranscript = rawText;` — JSON only in
the `systemPath && diarization.isAvailable()` branch (`:276`) — then written
unconditionally (`:286`). Mic-only notes and any diarization failure flatten the
transcript irreversibly.

### (b) The same destroyer exists a second time
`ipcHandlers.js:834-900` (`retranscribe-meeting-note`) is a copy of the same
logic with the same unconditional write (`:859`, `:897`). Fixing only the
pipeline leaves the manual path destroying transcripts. **This is a second file;
revision 2 wrongly said R-2 shared a file with the title guard.**

### (c) Only one audio track is transcribed
`postCallPipelineManager.js:110` and `ipcHandlers.js:839`:
`const audioPath = note.system_audio_path || note.mic_audio_path;`
Both tracks are stored (`ipcHandlers.js:7852-7860`) and the live transcript
interleaves `source: "mic" | "system"` (`meetingRecordingStore.ts:29`). So
whenever system audio exists, re-transcription keeps only the **remote** side —
everything the user said is discarded, and title/classify/notes are then built
from half the conversation.

### (d) Speaker ids are not reconciled even on the success path
The diarization branch re-clusters from scratch (`:267-277`) with no
reconciliation against prior ids — unlike the recording-stop path, which calls
`_reconcileLiveSpeakerState` (`ipcHandlers.js:8000-8003`). User names live in
the transcript JSON (`NoteEditor.tsx:459`, persisted `:432-437`) **and** in
`speaker_mappings` (`database.js:449-457`). The table survives the overwrite, so
unreconciled ids can **misattribute** names to the wrong speakers.

### Fix
1. Build new segments from `result.segments` — per-segment whisper timestamps
   are already in hand at `:268` even without diarization — and assign speakers
   by timestamp overlap with the old segments, **preserving speaker ids** so
   `speaker_mappings` re-applies for free.
2. If segments cannot be produced, **skip the transcript write**. Nearly free:
   `run()` consumes `result.value` in memory (`:117-119`), so title/classify/
   notes still use the improved text; only the persisted upgrade and diff
   broadcast are lost. Refuse-and-warn beats destroy.
3. Transcribe **both** tracks when both exist, preserving `source`.
4. Apply all of the above to `ipcHandlers.js:834-900` too.

### Urgency
Audio retention defaults to 30 days (`ipcHandlers.js:533-536`,
`audioStorage.js:102`), after which the source `.opus` is deleted. Every week of
delay shrinks the window in which a flattened transcript could be repaired by a
corrected re-transcription. Worst case is `_drainPendingRetranscriptions`
(`:7470-7490`) firing hours later, once the large-model download finishes, over
speakers the user has already named and locked.

### Tests
Named speakers survive re-transcription; a mic-only note keeps its segments; a
failed diarization does not flatten; a dual-stream meeting retains both sides;
`speaker_mappings` still resolves to the right people afterwards.

---

## P0-2 — Diarization: the correction (local-only regression)

`1.12.1` is built but unreleased. Its force-merge backstop
(`liveSpeakerIdentifier.js:725`) merges into the nearest cluster above 0.65 with
no margin, which makes `MATCH_MARGIN` and most of `CONFIDENT_MATCH_THRESHOLD`
dead and risks collapsing distinct speakers.

**Revision 2's proposed replacement was also wrong.** `shouldForceMerge(best,
second) = best >= 0.72 && second >= 0.65` re-opens the runaway in
**[0.65, 0.72)** — exactly the band the original bug lived in — and contradicts
the shipped test at `liveSpeakerMatching.test.js:48-49`, which asserts
`acceptsMatch(0.72, 0.70) === false`.

**Adopted rule (from review):** `(best, second)` alone cannot separate "two
similar people" from "one person's duplicates". The discriminating signal is the
similarity **between the top two clusters themselves** — which
`_performRecluster` (`:246-247`) already uses at ≥ 0.65.

On margin failure with `best >= MATCH_THRESHOLD`:
- compute `similarity(clusterBest, clusterSecond)`
- if ≥ `MATCH_THRESHOLD`: merge the two clusters (duplicates confirmed), assign
- otherwise: assign to `best` anyway
- **never mint a new speaker when `best >= MATCH_THRESHOLD`**

Merging the clusters, rather than only absorbing the embedding, stops the
duplicate pair re-triggering on every later utterance.

Also: `_assignOrForceCluster` is reached from the stored-profile path too
(`:696`), after which the profile name is stamped on whatever was merged into
(`:701-702`) — a distinct speaker's cluster can be hijacked and renamed. The
redesign must cover that path.

`maxSpeakers` is write-only (`:144/189/329`, never read) — dead since
`a8f70284`. Remove it or note it, so "3 clusters from 3 speakers" tests cannot
mask unbounded growth.

**Tests must interleave** a duplicate-heavy voice with a third distinct speaker
mid-stream, against the real identifier — not just the predicate.

**Threshold evidence:** run stored profile embeddings and saved meeting audio
through the real CAM++ model (`speakerEmbeddings.js:13`) and read the similarity
histograms. Current numbers are guesses.

---

## P0-3 — Pipeline never runs when diarization throws

`ipcHandlers.js:~8072-8075`: the catch does `send({ segments: [] })` and does
**not** call `_enqueuePostCallPipeline`, while both the no-diarization and
success branches do. A meeting whose diarization throws gets no retranscribe,
no title, no classify, no notes. Found by review; in no plan before now.

---

## P1-1 — Title guard

Title is written unconditionally in `run()` step 2
(`postCallPipelineManager.js:138`) and in `runSingleStep`
(`:199-207` — revision 2 cited `:341-346`, which is `_classifyMeetingType`).

Guard belongs in `run()` step 2 only; explicit regeneration must always
regenerate. Note `run()` is also reached by two explicit user actions —
`retry-pipeline-step` (`ipcHandlers.js:7171-7173`) and `reprocess-all-meetings`
(`:7178-7189`) — so bulk reprocess will no longer refresh an
already-LLM-generated title. Accepted.

**ESM/CJS settled:** `await import("./regenerableNoteTitle.js")` works from CJS
main, including inside a packaged asar (verified against the shipped 1.12.1 asar
under Electron 41 / Node 24.18; precedent at `ipcHandlers.js:3795`, `:6192`).
Do not convert the module — `PersonalNotesView.tsx:83` imports it as ESM.

**Wire `calendarEventName`.** It is reachable from main via
`notes.calendar_event_id` (`database.js:401`) → `calendar_events` (`:379`), and
covers calendar-created notes, which is the case the module was written for.
Accept English-only for locale placeholders (`regenerableNoteTitle.js:5`) —
that already covers the reported "New note".

---

## P1-2 — Provider-field corruption (live writer)

`ReasoningModelSelector.tsx:503` writes a **model family** id into a provider
field (`getAllProviders()`, `:364-366`; families `qwen`, `mistral`, `llama`,
`openai-oss`, `gemma`, `liquidai`), wired to `setCleanupProvider`
(`NotesOnboarding.tsx:164`). `noteFormatting` inherits it via `fallbackScope`
(`settingsStore.ts:1870`), `ControlPanel.tsx:173-178` syncs it, and
`ipcHandlers.js:7232-7236` writes `NOTE_FORMATTING_PROVIDER=gemma`.

Second breakage: `useSettings.ts:182`
(`cleanupProvider === "local" ? cleanupModel : undefined`) means the local model
never reaches env, so `main.js:564`'s pre-warm silently skips.

Fix: write `provider = "local"`, carry the family as the model. Add a store
migration mapping known family ids → `local`. Keep 1.12.1's recovery in
`MainProcessInference` as a safety net, not the fix.

---

## P1-3 — Chat default, gated

`chatAgentProvider` defaults to `"groq"` (`settingsStore.ts:1171`) with model
`"openai/gpt-oss-120b"` (`:1170`) while `chatAgentMode` defaults to `"local"`
(`:46-49`) — UI shows the local card, runtime calls groq.

**Do not default to local unconditionally.** `BUILTIN_LOCAL_MODEL_ID`
(`ModelRegistry.ts:444`) is neither bundled nor auto-downloaded — it is a
declinable opt-in modal (`GemmaDownloadPrompt.tsx:48-57`,
`ControlPanel.tsx:670`) that nothing in the chat flow triggers. Absent, the user
gets `Model file not found: <path>` (`llamaServer.js:126`) — worse than a
comprehensible 401.

Fix: default to `local` + `BUILTIN_LOCAL_MODEL_ID` **only when
`modelCheck(BUILTIN_LOCAL_MODEL_ID)` passes**, mirroring
`ControlPanel.tsx:196-204`; otherwise leave groq. With that gate the move is
silent and needs no notice.

---

## P2 — Notes prompt sharing (after P0-1)

Two prompts legitimately differ (pipeline has meeting types and speaker names;
renderer serves personal notes and custom actions). The renderer's is **not**
thinner — `MEETING_SYSTEM_PROMPT` (`actionProcessingStore.ts:67-104`) has all
six headings. The rough notes were caused by P0-1: with segments destroyed,
`parseTranscriptSegments` bails (`parseTranscriptSegments.ts:5`) and the
renderer falls to `BASE_SYSTEM_PROMPT` (`:57-65`), which **forbids** headings.

So P0-1 is the fix. Afterwards: extract the shared structure into one constant
used by both `MEETING_SYSTEM_PROMPT` and `GENERIC_NOTES_PROMPT`. Note the
built-in action prompt is a DB row (`database.js:296-302`, migration `:304-317`
fires once), so code-side edits never reach existing installs — resolve built-in
prompts at runtime or key the migration on content.

---

## P2 — Migrations, reduced scope

Rebase `feature/graceful-db-migrations` onto merged work **first** — it was cut
before `e21d91ea` and would delete `liveSpeakerMatching.js` and revert
`liveSpeakerIdentifier.js` and `mainProcessInference.js`, reinstating both bugs.

Then, per review: keep the versioned runner and the pre-migration backup; stamp
`user_version = SCHEMA_VERSION` on a freshly-created database so fresh installs
skip the runner (removing the first-run flash and pointless backup); **drop the
progress window**, which removes the async `initializeCoreManagers` refactor and
its `second-instance`/no-IPC race by construction.

Leave `node-abi` undeclared (declaring it forces a lockfile regeneration that
strips `libc` fields on a mismatched Node major).

---

## Order

1. **P0-1** re-transcription data loss — shipped, active, retention clock running
2. **P0-3** diarization-failure branch never enqueues (one line, same area)
3. **P0-2** diarization correction — unreleased, so no user is affected yet
4. **Verify on a real call**: 3 people → 3 speakers; names survive re-transcribe; both sides present; title and type populate
5. **Then** bump, push, PR, tag — never tag before verification
6. **P1-1** title guard
7. **P1-2 + P1-3** together (same store, both provider-integrity)
8. **P2** prompt sharing, then migrations

Each item: own branch, own version bump per CLAUDE.md, own PR, plan-and-review
per CLAUDE.md.

---

## Minor, tracked

- `cleanupExpiredAudio` nulls both audio paths when either expires
  (`audioStorage.js:144-149`) — relevant once P0-1 depends on which are non-null.
- `_resolveSpeakerForEmbedding:709` has a provably-null left operand — dead.
