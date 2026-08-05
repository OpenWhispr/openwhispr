# Plan: P0-2 — Diarization failure never enqueues the post-call pipeline

Date: 2026-08-04
Branch: off `fix/live-diarization-and-local-inference`
Status: revision 2, after adversarial review. Awaiting confirm-only re-review.

Review confirmed the fix itself is correct and complete (it reproduced the bug), and
found: the test plan promised a test that cannot be written, this plan's own answer to
its Open Question 2 was factually wrong, and a pre-existing race worth recording.
Revision 2 corrects all three.

---

## Symptom

When background diarization throws, the meeting note gets **nothing**: no
re-transcription, no title, no meeting-type classification, no notes. The note keeps
whatever generic title it was created with and an empty `enhanced_content`.

The user sees a meeting that "just didn't process", with no error surfaced.

---

## Verified root cause

`ipcHandlers.js:8071-8073`:

```js
      } catch (err) {
        debugLogger.warn("Background diarization failed", { error: err.message });
        send({ segments: [] });
      } finally {
```

The other two exits from `_startOrSkipDiarization` both enqueue the pipeline:

- diarization disabled / unavailable / no PCM — `ipcHandlers.js:7887-7895`:
  ```js
      send({ segments: transcriptSegments.map(...) });
      if (noteId) {
        this._enqueuePostCallPipeline(noteId);
      }
      return;
  ```
- diarization succeeded — `ipcHandlers.js:8067-8070`:
  ```js
      send({ segments: enrichedSegments, speakerEmbeddings: speakerEmbeddingsMap });
      if (noteId) {
        this._enqueuePostCallPipeline(noteId);
      }
  ```

The catch is the only path that does not. `noteId` is in scope — it is the eighth
parameter of `_startOrSkipDiarization` (`:7870-7878`) and is used by both other
branches.

## What is NOT wrong here

`send({ segments: [] })` is safe: the renderer's handler returns early on an empty
list (`NoteEditor.tsx:389`, `if (!data?.segments?.length) return;`), so it does not
overwrite the transcript. Only the missing enqueue needs fixing — the empty send
stays as the signal that clears `isDiarizing` (`:387`).

---

## Fix

Add the same two lines the other branches use, inside the catch — **before** `send`:

```js
      } catch (err) {
        debugLogger.warn("Background diarization failed", { error: err.message });
        if (noteId) {
          this._enqueuePostCallPipeline(noteId);
        }
        send({ segments: [] });
      } finally {
```

Enqueue-before-send costs nothing and closes a narrow re-creation of the same bug: the
`win && !win.isDestroyed()` guard (`ipcHandlers.js:7881`) does not make
`webContents.send` throw-proof, since the window can be destroyed between the check and
the send — and a throw there would once again skip the enqueue.

Review confirmed the fix is otherwise complete: the catch at `:8071-8073` is the only
exit that does not enqueue; there are **no** `return` statements anywhere inside the
`try` (`:7905-8070`); the only other `return` is `:7898` on the skip branch, which does
enqueue; and `noteId` is genuinely in scope as the 8th parameter (`:7878`).

### Why not `finally`

`finally` would be tidier but double-enqueues: `BackgroundJobQueue.enqueue`
(`backgroundJobQueue.js:19-22`) does **no** deduplication by `jobId` — it pushes
unconditionally — so the success path's enqueue plus a `finally` enqueue would run
the whole pipeline twice for every successful meeting, including two large-model
re-transcriptions. Explicit enqueue in the catch only.

### Interaction with P0-1

`_enqueuePostCallPipeline` runs `postCallPipelineManager.run(noteId)`, whose first
step is re-transcription — the flow P0-1a is fixing. This change therefore *increases*
the number of notes reaching that flow, which is exactly why P0-1a lands first. Order
is: P0-1a, then this.

---

## Test plan

Revision 1 said "the test constructs the object with stubbed collaborators". **That is
impossible** (review IMPORTANT 1): `new IPCHandlers(...)` unconditionally calls
`this.setupHandlers()` (`ipcHandlers.js:279`) — hundreds of `ipcMain.handle` calls —
and under plain Node `require("electron")` resolves to the npm stub where `ipcMain` is
`undefined`, so the constructor throws immediately. No existing test imports
`ipcHandlers.js`, and `test/support/` has no electron stub.

What works instead, which the reviewer ran and used to reproduce the bug: the module
itself loads fine under plain Node, so drive the **real** method via

```js
const handlers = Object.create(IPCHandlers.prototype);
Object.assign(handlers, { diarizationManager, databaseManager, backgroundJobQueue, ... });
```

Also make `_startOrSkipDiarization` **return** its async IIFE promise. The promise is
currently discarded (`ipcHandlers.js:8084`), so assertions would otherwise race; both
callers (`:5913`, `:5941`) ignore the return value, so this is behaviour-neutral.

(The class is `IPCHandlers`, exported at `ipcHandlers.js:8118` — revision 1 wrote
`IpcHandlers`. The skip-branch citation was off by one: guard `:7888`, enqueue
`:7895-7897`, `return` `:7898`.)

Assertions:

1. diarization throws → `_enqueuePostCallPipeline` called once with the note id
2. diarization throws and `noteId` is null → not called (no crash)
3. diarization succeeds → called exactly **once**, not twice (guards the `finally`
   regression)
4. diarization skipped/unavailable → called exactly once (existing behaviour intact)
5. on throw, `send` still receives `{ segments: [] }` so the renderer clears
   `isDiarizing`

Do **not** fall back to a predicate-only test: that is what let two earlier diarization
bugs through.

Gate: `npm run typecheck && npm run lint && npm test`.

---

## Known adjacent issue, accepted here

**Fast failures race `_saveMeetingAudio`** (review IMPORTANT 3). `_handleAudioRetention`
fires `_saveMeetingAudio` fire-and-forget (`ipcHandlers.js:7806`) and
`_startOrSkipDiarization` runs immediately (`:5910-5913`, `:5938-5941`), but the audio
paths are written to the note only after ffmpeg encoding finishes (`updateNote`,
`:7861`). `postCallPipelineManager.run` reads
`note.system_audio_path || note.mic_audio_path` (`:110-111`); if encoding is still in
flight, `hasAudio` is false → retranscribe emits `"skipped"` (`:127`), not `"pending"`,
and only `"pending"` feeds `_pendingRetranscriptionNoteIds` — so nothing retries it.

The likely failures for this catch (missing/corrupt PCM, ffmpeg error) fail within
milliseconds, landing squarely in that window. This race already exists in production on
the skip branch (`:7895-7897`), so the fix does not introduce it — but it does route
more notes through it. Accepted for this change; follow-up is to enqueue the pipeline
**from** `_saveMeetingAudio`'s completion rather than before it. Related: P0-1's finding
that the pending/drain mechanism is itself dead today.

---

## Open questions

1. Should a diarization failure also surface something to the user, rather than only
   `debugLogger.warn`? The note will now process, but with no speaker labels at all.
   Worth folding into P0-1's persisted-outcome mechanism so there is one surface, not
   two.
2. ~~Can diarization throw after partially mutating state?~~ **Answered, and revision 1
   had it wrong on both counts** (review IMPORTANT 2). The embedding loop cannot reach
   the outer catch — it has its own try/catch (`:7975-7998`). And
   `_reconcileLiveSpeakerState`, called unprotected at `:8000`, **does write to the
   database**: `setSpeakerMapping` (`:7753-7758`, `:7761-7766`) and
   `removeSpeakerMapping` (`:7759`). If it throws mid-loop — e.g. `getSpeakerMappings`
   (`:7712`) failing — the outer catch runs with speaker mappings **partially
   migrated**, and this fix then enqueues the pipeline over that half-updated state.
   Still better than not processing at all, so the fix stands, but the record must say
   so rather than claiming no writes precede the catch.
