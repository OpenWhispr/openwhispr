# Plan: P0-1 — Re-transcription destroys transcripts (revision 3)

Date: 2026-08-04
Branch: `fix/live-diarization-and-local-inference` (new branch off it for this fix)
Status: revision 3, after two adversarial review rounds. Awaiting confirm-only re-review.
Supersedes the P0-1 section of `2026-08-04-open-issues-plan.md` (revision 3).

Revision 1 came back with two CRITICALs; revision 2 came back with one more CRITICAL
and three IMPORTANTs. I re-verified each against the code myself before accepting.
Revision 2 split the work (P0-1a stops the destruction now; P0-1b adds dual-track).
Revision 3 fixes the preserve gate, which as written would have blocked the mic-only
case outright, and closes three adjacent defects the reviewer proved were real.

---

## Symptom

After every meeting the post-call pipeline re-transcribes with the large Whisper
model and overwrites `notes.transcript` with a plain-text blob. Speaker labels and
names are lost, the renderer can no longer parse segments, and note generation
silently drops from `MEETING_SYSTEM_PROMPT` to `BASE_SYSTEM_PROMPT` — which *forbids*
headings (`parseTranscriptSegments.ts:5` bail → `PersonalNotesView.tsx:1036-1039`
`isMeetingNote=false` → `actionProcessingStore.ts:153`). That is the "rough notes"
the user reported.

Shipped in v1.12.0, runs automatically after every meeting
(`_enqueuePostCallPipeline`, `ipcHandlers.js:7494`). Audio retention deletes the
source `.opus` after 30 days (`ipcHandlers.js:533-536`), after which a flattened
transcript can never be repaired.

---

## Correction to revision 3 of the open-issues plan — flattening is UNCONDITIONAL

Revision 3 says the transcript survives when system audio exists and diarization is
available. **It does not. It flattens 100% of the time.**

`postCallPipelineManager.js:268` and `ipcHandlers.js:869` build segments from
`result.segments`, which `transcribeLocalWhisper` can never return.
`parseWhisperResult` (`whisper.js:454-495`) has three success returns — `:465`,
`:482`, `:491` — all `{ success: true, text }`, none with segments. The server
request hard-codes the format that omits them (`whisperServer.js:690-694`):

```js
`Content-Disposition: form-data; name="response_format"\r\n\r\n` + `json\r\n`
```

So `result.segments` is `undefined` → `whisperSegments` is `[]` →
`mergeWithTranscript` returns `[]` at its first guard (`diarization.js:660`) →
`enriched?.length` falsy → `finalTranscript` stays `rawText` → unconditional write at
`postCallPipelineManager.js:286` / `ipcHandlers.js:895`. **The entire re-diarization
branch in both files is dead code.**

### Empirical verification (measured today, this machine)

Bundled `resources/bin/whisper-server-darwin-arm64` + `ggml-large-v3-turbo.bin`,
generated 8.6s speech wav, port 18099:

| `response_format` | response |
|---|---|
| `json` (what the app sends) | `{"text":" Hello, this is a test…"}` — no segments |
| `verbose_json` | `{task, language, duration, text, segments:[…], …}` |

Segment keys: `id, text, start, end, tokens, words, temperature, avg_logprob,
no_speech_prob`. Three segments, `start`/`end` in **seconds**: `(0.0, 2.7)`,
`(3.08, 5.48)`, `(5.9, 8.5)`.

The LAN/remote worry is moot: `_runServerTranscription` calls
`serverManager.start(modelPath)`, and `start()` tears down any remote connection
(`whisperServer.js:393-397`), so re-transcription always runs against the local
bundled server that was measured.

---

## Root cause, defect by defect

| # | Defect | Evidence |
|---|---|---|
| a | Plain text overwrites structured segments, unconditionally | `postCallPipelineManager.js:255` → write at `:286` |
| b | The same destroyer exists twice | `ipcHandlers.js:834-908`, write at `:895` |
| c | Only one audio track is transcribed | `postCallPipelineManager.js:110`, `ipcHandlers.js:839` |
| d | Speaker ids not reconciled | no analogue of `_reconcileLiveSpeakerState` (`ipcHandlers.js:7690-7774`) |
| e | Timestamp unit bug | `:272` / `:873` write `(seg.start\|\|0) * 1000` (ms); `mergeWithTranscript` compares against diarization seconds (`diarization.js:705`) |
| f | Mic-only notes mislabelled `source:"system"` | hard-coded at `:271` / `:872` |
| g | **New (review):** stale `speaker_mappings` on already-flattened notes | rows survive the flatten (PK `(note_id, speaker_id)`, `database.js:449`); `mergeWithTranscript` renumbers new clusters to `speaker_0..n` (`diarization.js:667-673`) → old names re-attach to arbitrary new clusters |
| h | **New (review):** `note_speaker_embeddings` never updated after re-transcription | `database.js:2246`, read by `_retroactiveMapping` (`ipcHandlers.js:7546`) — stale rows poison future mapping |

---

## What the review changed

### CRITICAL 2 — the dual-track time-origin assumption was wrong (verified myself)

Revision 1 claimed both audio files share a time origin, citing
`ipcHandlers.js:7852-7860`. That citation is the **opus encode at save time**, not
stream opening. The PCM files are opened **lazily on each source's first chunk**:

- system: `ipcHandlers.js:5695-5698` — `meetingDiarizationStream` created on first
  system chunk, and `meetingDiarizationStartedAt = receivedAt` recorded there
- mic: `ipcHandlers.js:5729-5735` — `meetingMicPcmStream` created on first mic chunk,
  **and no start time is recorded anywhere**

System capture only begins after `startMeetingSystemAudio` (`:5658`), i.e. after mic
streaming is already connected, so the skew is helper-spawn latency — seconds-scale.
Neither start epoch is persisted to the note, so **for existing notes the skew is
unrecoverable**.

Consequence: whisper offsets from the two files are *not* comparable, so interleaving
them is wrong. Old stored seconds are relative to **system** start and new
system-track offsets come from the same file, so old-vs-new **system** matching is
time-base consistent — only mic interleaving is affected.

### CRITICAL 1 — echo dedupe is a no-op for retranscribed segments (verified myself)

`dedupeMicAgainstSystem` (`diarization.js:23-35`) keeps any mic segment that lacks
`likelyRenderBleed` / `hasBleedEvidence` / `suppressionReason === "double_talk"` —
live-capture-only flags that whisper re-transcription segments never carry. On a
dual-track meeting without headphones every remote utterance would appear twice: once
under its speaker, once as "you".

### Therefore: split the work

**P0-1a (this branch, ships now)** — stop the destruction. Defects (a), (b), (d),
(e), (f), (g), (h). Single-track re-transcription only.

**P0-1b (next branch)** — defect (c), dual-track. Needs: per-stream start epochs
recorded and persisted (new columns), plus a real echo dedupe for retranscribed
segments. Only helps recordings made after it ships; existing notes cannot be
repaired for skew.

Until P0-1b, a note whose old transcript contains mic segments is **preserved, not
rewritten** (see "Refuse to destroy"). That is a deliberate downgrade of the feature
in exchange for never losing the user's own side of a conversation.

---

## Fix — P0-1a

### 1. Make timestamped segments obtainable (opt-in)

`whisperServer.js` — add `includeSegments` to `transcribe()`; when set, send
`response_format=verbose_json` instead of `json`. Default unchanged.

`whisper.js` — thread `includeSegments` through `transcribeLocalWhisper` →
`transcribeViaServer` → `_runServerTranscription` → `serverManager.transcribe`. In
`parseWhisperResult`, when the parsed result has an array `segments`, attach:

```js
segments: result.segments
  .map((s) => ({ start: s.start, end: s.end, text: this.normalizeWhitespace(s.text || "") }))
  .filter((s) => s.text)
```

Blank-audio handling and both existing return shapes are untouched. Word-level
`words[]` is not used: segment granularity already matches the stored transcript, and
word timings triple the payload.

### 2. One shared module, not two fixed copies

Defect (b) is duplication; fixing it twice recreates it. Extract into
`src/helpers/retranscribeNoteTranscript.js`:

```js
async function retranscribeNoteTranscript({
  note, whisperManager, diarizationManager, databaseManager,
  convertToWav, model = "large", language = null, onSubStage,
}) → { outcome, transcript, text, segments, reason }
```

Review confirmed no blocker: injection points exist (`postCallPipelineManager`
ctor `:89-96`, wired at `ipcHandlers.js:3760-3767`; the IPC handler's
`require("./ffmpegUtils")` at `:863`), and `onSubStage` covers broadcast-vs-window-send.
Persistence, broadcasting and the pending-tracking emission stay in the callers —
the pending-tracking broadcast wrapper (`ipcHandlers.js:3769-3783`) only observes
*pipeline* broadcasts.

The IPC handler currently skips WAV pre-conversion (the server converts internally,
`whisperServer.js:659`); the shared module standardises on one conversion.

### 3. Explicit three-way outcome contract

Revision 1 had a two-way return, which collides with the existing pending mechanism:
a falsy return from `_retranscribe` currently means "model not downloaded" → status
`pending` → `_pendingRetranscriptionNoteIds.add` (`ipcHandlers.js:3776-3778`) →
retried by `_drainPendingRetranscriptions`. A "preserved" note returning falsy would
be retried forever. So:

| `outcome` | meaning | caller behaviour |
|---|---|---|
| `"written"` | new structured transcript produced | write it, broadcast diff |
| `"preserved"` | could not produce a safe replacement | **do not write**; emit `retranscribe:complete` with `preserved: true` + `reason`; **not** pending |
| `"model-missing"` | large model not downloaded | emit `retranscribe:pending` (existing behaviour) |

"preserved" cannot leak into pending: the wrapper only adds on `status === "pending"`
(`ipcHandlers.js:3776-3777`), and a preserved outcome emits `complete` + a flag.

**But the behaviour this contract promises to preserve is already broken** (review
IMPORTANT B, verified myself). The wrapper adds on `retranscribe:pending`
(`ipcHandlers.js:3776-3777`) and deletes on `pipeline:complete` (`:3779-3781`). In the
model-missing case `run()` broadcasts pending
(`postCallPipelineManager.js:120-124`), then **continues** through title/classify/notes
and unconditionally emits `pipeline:complete` at `:171` — deleting the note from
`_pendingRetranscriptionNoteIds` in the same run. The set is therefore always empty,
`_drainPendingRetranscriptions` (`:7470-7491`) drains nothing, and the
retry-after-model-download feature is **dead today**. `runSingleStep:209` is a second
deletion path.

Fix it here rather than writing a test that enshrines the bug: delete from the set only
when the **retranscribe step itself** reaches a terminal non-pending outcome, not when
the pipeline completes. Test asserts the **set contents** after a full `run()`, not just
the broadcast.

### 4. Timestamps in seconds

Emit `timestamp: seg.start` (seconds), matching what the recording-stop path persists
after normalising (`ipcHandlers.js:7944-7958`). Fixes (e).

Old stored transcripts carry **either** unit — seconds-from-start via the diarization
path, or epoch-ms when diarization was skipped (`segTimestamp = Date.now()`,
`ipcHandlers.js:5076`; skip branch `:7888-7894`). When reading old segments, normalise
with the same rule as `ipcHandlers.js:7949` (`startMs > 1e9` ⇒ epoch). Old mic
segments can be **negative** in seconds (mic spoke before the system stream opened) —
normalisation must tolerate that.

`SpeakerPanel.tsx:55-56` divides by 1000, but `end` is never serialized
(`transcriptSpeakerState.ts:193-208`) nor parsed (`parseTranscriptSegments.ts`), so
that branch is dead and is not evidence of milliseconds.

### 5. Preserve speaker identity — embeddings first, overlap as fallback

Review is right that the codebase's identity mechanism is embedding-based and that a
new overlap matcher should not be the primary. Order:

1. **Embeddings (primary).** When re-diarization succeeds, extract per-cluster
   centroids exactly as `ipcHandlers.js:7973-7995` already does, then match them
   against the note's stored `note_speaker_embeddings` (`database.js:2269`) by cosine
   similarity, one-to-one, greedily, using the same `> 0.6` threshold as
   `_reconcileLiveSpeakerState` (`ipcHandlers.js:7690-7774`). Matched clusters take
   the old speaker id. Then **re-save** the new centroids under the resolved ids
   (`saveNoteSpeakerEmbeddings`, `database.js:2246`) — fixes (h).

   Row shape confirmed: `getNoteSpeakerEmbeddings` does `SELECT *`, so `embedding` is
   a `Buffer` needing the same view dance used at `ipcHandlers.js:7539-7543` /
   `:8024-8028`: `new Float32Array(e.embedding.buffer, e.embedding.byteOffset,
   e.embedding.byteLength / 4)`.

   **Ghost rows must be deleted too** (review IMPORTANT D — (h) was only half-fixed).
   `saveNoteSpeakerEmbeddings` is `INSERT OR REPLACE` per `(note_id, speaker_id)`
   (`database.js:2251`) and never deletes. If `speaker_0..2` existed and re-diarization
   resolves only `speaker_0`/`speaker_1`, the stale `speaker_2` row survives;
   `getNotesWithUnmappedSpeakers` (`database.js:2310-2321`) then flags the note as
   unmapped forever and `_retroactiveMapping` (`ipcHandlers.js:7545-7560`) can mint a
   `speaker_mappings` row for an id that no longer exists in the transcript — precisely
   the poisoning (h) is about. There is no per-row delete API (only the note-delete
   cascade), so add one and delete every row whose `speaker_id` is absent from the
   final transcript.

   **Save embeddings from the main process.** Today the save is renderer-mediated
   (`NoteEditor.tsx:384-409` → `save-note-speaker-embeddings`,
   `ipcHandlers.js:7154-7158`), so closing the note or the Control Panel before
   diarization finishes means no embeddings are ever stored. The new module runs in
   main and writes via `databaseManager` directly, closing that gap for retranscribed
   notes going forward.
2. **Temporal overlap (fallback).** When there are no stored embeddings, or
   diarization did not run, match by time overlap against the old segments. Build old
   ranges the way `mergeWithTranscript` does — next **system** segment's timestamp,
   skipping mic segments (`nextSystemTimestampAt`, `diarization.js:675-683`), last one
   `+2.5s`. Not naive next-index.
3. Unmatched new clusters get a fresh id that cannot collide with any old id.

Then copy the identity fields for whichever old id each new segment carries. The
fields are exactly `SPEAKER_STATE_FIELDS` (`transcriptSpeakerState.ts:6-15`):
`speaker, speakerName, speakerIsPlaceholder, suggestedName, suggestedProfileId,
speakerStatus, speakerLocked, speakerLockSource`. Locked speakers
(`speakerAssignmentPolicy.js:30-32`) are user decisions: copied verbatim, never
downgraded.

### 6. Already-flattened notes: clear stale mappings (defect g)

When `note.transcript` does not parse as a segment array, there are no old ids to
preserve, but `speaker_mappings` rows from before the flatten still exist and would
re-attach old names to arbitrary new `speaker_N` clusters. So: if the old transcript
is unparseable **and** no `note_speaker_embeddings` match is available, remove that
note's mappings (`removeSpeakerMapping`, `database.js:2332`) for ids that the new
transcript reuses. Better an unnamed speaker than a confidently wrong name.

### 7. Refuse to destroy — one gate, source-coverage based

Revision 2 said "preserve when the old transcript contains `source: "mic"` segments".
**That was wrong and self-contradictory** (review CRITICAL A, accepted): a *mic-only*
note's live transcript is entirely mic segments, so the literal rule preserves every
mic-only note forever — while test 1 expects exactly that note to be rewritten. Tests
1 and 5 could not both pass.

The correct gate is the one already used for downstream text adoption. Let
`sources(t)` be the set of `source` values in a transcript:

> **Write iff `sources(old) ⊆ sources(new)`. Otherwise preserve.**

| old transcript | track transcribed | `sources` | outcome |
|---|---|---|---|
| mic-only | mic | `{mic} ⊆ {mic}` | **written** |
| dual-track | system only (P0-1a) | `{mic,system} ⊄ {system}` | **preserved** |
| already flattened | whichever | `∅ ⊆ anything` | **written** |
| any | whisper returned no segments | — | **preserved** |

Corollary the reviewer is right to draw: the module must **pick the track that covers
the old sources**, not the hard-coded `system || mic`. A mic-only note with both files
on disk transcribes the **mic** file.

The same rule gates downstream text adoption. `run()` consumes the return value in
memory (`postCallPipelineManager.js:117-119`), but a system-only text is *worse* input
for title/classify/notes than the full interleaved old transcript, so on a preserved
outcome the old transcript keeps being used. `_flattenTranscript` (`:411-425`) handles
plain text fine either way.

Already-flattened dual-track notes are safe to rewrite (review Q2, verified): the flat
blob was itself produced from `system_audio_path || mic_audio_path`, so it is *already*
system-only — the mic side was destroyed by the original bug, not by the rewrite. A
structured system-only transcript strictly improves on a flat system-only one. Expiry
cannot create a trap either, since `cleanupExpiredAudio` nulls both paths together
(`audioStorage.js:144-147`), as does `delete-note-audio` (`ipcHandlers.js:830`).

### 7b. The warning must be durable — the store would silently drop it

**Open question 2, decided: warn, do not skip silently.** But revision 2's mechanism
would have shipped an i18n key that nothing renders — the exact failure that has
shipped here before. Verified (review IMPORTANT C, re-checked myself):

- `handlePipelineStatus` (`postCallPipelineStore.ts:32-40`) destructures a **fixed**
  field set — `preserved`/`reason` would be dropped on the floor
- it **deletes the note's entire entry** on `pipeline:complete`
  (`postCallPipelineStore.ts:42-47`), seconds after the retranscribe step
- the only listener is `usePostCallPipelineListener`, mounted solely at
  `ControlPanel.tsx:375` — with the Control Panel closed (the normal state during a
  meeting) the event is lost entirely

So the outcome is **persisted on the note**, not merely broadcast:

1. New nullable column `retranscribe_outcome TEXT` on `notes`, added with the
   established pattern (`ALTER TABLE notes ADD COLUMN …` in a guarded block, as at
   `database.js:396`, `:482`, `:487`, `:617`). `NULL` = nothing to say; otherwise the
   reason code.
2. The payload still gains `preserved` + `reason`, and `handlePipelineStatus` is
   extended to carry them and to **not** erase a preserved outcome on
   `pipeline:complete`.
3. `NoteEditor` renders the banner — it already consumes `selectPipelineForNote`
   (`:169`) — reading the persisted column so it survives a closed window.
4. One new i18n key under the existing `pipeline.*` namespace in all **10** locale
   dirs (`de, en, es, fr, it, ja, pt, ru, zh-CN, zh-TW`). Revision 1 said "11 … — 10
   dirs"; it is 10.

Expect `reprocess-all-meetings` to re-emit the preserved outcome for every dual-track
note on every invocation. UX noise, not a safety issue; it disappears when P0-1b lands.

### 8. Snapshot the old transcript late

The pipeline is enqueued at the same moment the diarization result is sent
(`ipcHandlers.js:8068-8070`) while the renderer persists the enriched transcript
asynchronously (`NoteEditor.tsx:391-405`). Re-read `note.transcript` **after** the
minutes-long transcription completes, as `postCallPipelineManager.js:252` already
does, not at module entry.

---

## Plan — P0-1b (follow-up branch, after P0-1a is green)

1. Record `meetingMicPcmStartedAt` alongside the existing `meetingDiarizationStartedAt`
   (`ipcHandlers.js:5695-5698` / `:5729-5735`).
2. Persist both epochs on the note (new columns + migration) at `_saveMeetingAudio`.
3. Re-transcribe both tracks; shift each track's whisper offsets into the system time
   base using the persisted epochs.
4. Real echo dedupe for retranscribed mic-vs-system segments: text similarity within a
   time window, reusing `transcriptsOverlap` / `buildMergedCandidates`
   (`transcriptText.js:176-182`) — **converting units**, since those helpers assume
   milliseconds (`POST_MERGE_CONTEXT_WINDOW_MS = 6000`) and the new timestamps are
   seconds.
5. Lift the dual-track "preserved" gate from P0-1a, but only for notes that carry both
   epochs. Older notes stay preserved — their skew is unrecoverable.

---

## Review notes carried into implementation

Revision 3 was confirmed implementable. Three things the reviewer required that are
easy to lose while coding:

1. **`updateNote` has an allowlist** (`database.js:1144-1161`). `retranscribe_outcome`
   must be added to `allowedFields` or every write is a silent no-op returning
   `{success: false}` — exactly the silent-failure genre that has shipped here before.
   A test asserts the column round-trips through `updateNote`/`getNote`.
2. **Do not depend on event ordering for the model-missing case.** Today `_runStep`
   emits `retranscribe:complete` when `_retranscribe` resolves null, *before* `run()`
   broadcasts `retranscribe:pending` — a contradictory stream that the new deletion
   rule survives only by accident. Restructure so the model-missing outcome does not
   emit `complete` at all.
3. **Free safety property, worth keeping:** an old segment with a missing or undefined
   `source` makes `sources(old)` a subset of nothing, so the note is preserved. The
   gate fails in the safe direction. Also verified: `_saveMeetingAudio`'s `encode()`
   swallows per-track failures (`ipcHandlers.js:7838-7848`), so a note really can hold
   a dual-source transcript with only one file on disk — the gate handles it.

---

## Alternatives considered

1. **Keep old segments, replace only their text.** Rejected: the large model
   re-segments the audio, so there is no stable 1:1 mapping; text would land on the
   wrong speakers.
2. **Fix both copies in place.** Rejected: that is what created defect (b).
3. **Dual-track now, aligning by cross-correlating old mic segment times against new
   mic offsets.** Rejected: fragile heuristic on top of unrecoverable data, and it
   would ship the echo-duplication bug (CRITICAL 1) at the same time.
4. **Estimate the skew from PCM durations** (`dur_mic - dur_sys`, both streams ending
   together). Rejected: assumes gapless writes on both streams, which mic holdback
   (`meetingMicHoldback`) breaks.
5. **Stop re-transcribing entirely until fixed.** Rejected as the shipped fix, but it
   is what P0-1a effectively does for dual-track notes — deliberately.

---

## Test plan

New `test/helpers/retranscribeNoteTranscript.test.js` — integrated against the real
module with mocked whisper/diarization (not predicate-only; predicate tests missed the
diarization bug twice):

1. mic-only note keeps structured segments; result is JSON, not plain text
2. diarization unavailable → segments still produced from whisper timestamps
3. diarization throws → segments preserved, no flattening
4. whisper returns no `segments` → `outcome === "preserved"`, caller does not write
5. dual-track note (old sources `{mic, system}`, only system transcribable) →
   `outcome === "preserved"`; and the mic-only note in test 1 → **written**, proving
   the source-coverage gate discriminates the two (revision 2's rule failed this)
5b. mic-only note with both files on disk → the **mic** file is the one transcribed
5c. new segments carry the `source` of the track they came from, and mic segments get
    speaker `"you"` — defect (f), which had no test
6. named speaker survives: old `speaker_0` = "Alice", locked → new overlapping segments
   still carry `speaker_0` + "Alice" + lock fields
7. embedding match wins over temporal overlap when both are available, and re-saves
   centroids under the resolved ids
8. diarization emits clusters in a different order → old ids re-applied by identity,
   not index
9. old transcript in epoch-ms → normalised; negative mic offsets tolerated
10. timestamps emitted in seconds
11. already-flattened note → stale `speaker_mappings` for reused ids are removed
11b. embeddings-present variant of §6's condition (mappings kept when an embedding
     match resolves the id)
11c. **ghost rows** — `note_speaker_embeddings` rows whose ids are absent from the
     final transcript are deleted (defect (h)'s actual poisoning path, untested in
     revision 2)

`test/helpers/postCallPipelineManager.test.js`:

12. `preserved` → no `updateNote({transcript})`, and **not** added to
    `_pendingRetranscriptionNoteIds`
13. `model-missing` → note is in `_pendingRetranscriptionNoteIds` **after a full
    `run()` completes** — asserting the set, not the broadcast, since the broadcast
    assertion would pass against today's broken drain
14. preserved → title/classify/notes run against the **old** transcript
15. written → downstream steps use the new text

`retranscribe-meeting-note` IPC handler (defect (b) — no coverage in revision 2):

15b. the handler delegates to the shared module and cannot write a non-JSON transcript

Renderer:

15c. `handlePipelineStatus` carries `preserved`/`reason` through and does not erase a
     preserved outcome on `pipeline:complete`

Whisper tests:

16. `parseWhisperResult` passes segments through when present, ignores when absent
17. `includeSegments` flips the request to `verbose_json`; default stays `json`

Defect-to-test map, so nothing ships untested: (a) 1/4/15 · (b) 15b · (c) deferred to
P0-1b, gate covered by 5 · (d) 6/7/8 · (e) 9/10 · (f) 5c · (g) 11/11b · (h) 7/11c.

Gate: `npm run typecheck && npm run lint && npm test`, ~5 skipped.

Manual verification before any tag: a real 3-person call — 3 speakers, names survive
re-transcription, title and meeting type populate. Note that "both sides present"
moves to P0-1b's verification.

---

## Versioning

**Open question 3, decided: fold into `1.13.0`.** `1.12.1` was built but never
released; this is user-visible behaviour change, so minor per `CLAUDE.md` → Versioning.
One version, one CHANGELOG entry covering the 1.12.1 fixes plus these. No artifact is
re-cut.

---

## Open questions — still unverified

1. **Threshold 0.6 for cluster-to-stored-embedding matching** is inherited from
   `_reconcileLiveSpeakerState` and `ipcHandlers.js:8036`. It is not independently
   validated for the re-transcription case (different audio window, same model). Using
   the established value rather than inventing one; worth a histogram later.
2. ~~How often do notes actually have `note_speaker_embeddings`?~~ **Answered by
   review, and the answer is "often not".** Four gates must all pass: diarization ran
   (mic-only notes: never); the CAM++ model is present (usually true — bundled in
   `resources/bin/diarization-models/`); a cluster segment ≥ 1.5s exists
   (`ipcHandlers.js:7985`); and `NoteEditor` was mounted with the matching
   `diarizationSessionId` when the result arrived (`NoteEditor.tsx:384-409`). So the
   **temporal fallback carries most real cases** and gets the heavier testing. §5's
   main-process save closes the fourth gate going forward.
3. **`cleanupExpiredAudio` nulls both audio paths when either expires**
   (`audioStorage.js:144-149`). Tracked, not fixed here; matters more once P0-1b lands.
4. Should the "preserved" warning offer a one-click retry after P0-1b ships for notes
   that were preserved for the dual-track reason? Deferred.
