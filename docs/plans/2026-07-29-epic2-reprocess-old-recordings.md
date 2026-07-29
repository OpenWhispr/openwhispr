# Epic 2: Re-Process Old Meeting Recordings

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to re-run the post-call pipeline (diarization, retranscription, title, classify, notes) on old meeting recordings with updated settings — e.g., after downloading Gemma, fixing speaker detection, or improving note templates.

**Architecture:** A "Re-process" button on meeting notes that have saved audio triggers the existing `retry-pipeline-step` IPC from step 0 (retranscribe). For bulk re-processing, a "Re-process All" action in the notes list re-queues all meetings with saved audio through the background job queue. The pipeline indicator already shows progress.

**Tech Stack:** Existing `retry-pipeline-step` IPC, `backgroundJobQueue`, `PostCallPipelineIndicator`.

---

## Structural Facts

1. **`retry-pipeline-step` IPC** already exists (ipcHandlers.js:9001). Accepts `(noteId, fromStep)`. Calls `postCallPipelineManager.run(noteId, { fromStep })`.

2. **`postCallPipelineManager.run(noteId, { fromStep })` already supports re-running from any step** via the `fromIndex` logic (lines 39-96). Passing `fromStep: "retranscribe"` re-runs the full pipeline.

3. **`backgroundJobQueue`** (backgroundJobQueue.js) processes one job at a time. Jobs are enqueued via `enqueue(id, fn)`.

4. **Saved audio check:** `note.system_audio_path || note.mic_audio_path` — if either exists on disk, the note can be retranscribed.

5. **Notes query:** `databaseManager.getNote(noteId)` returns a single note. For bulk queries, check if there's a `getNotes` or `searchNotes` method that can filter by `note_type = "meeting"` and `system_audio_path IS NOT NULL`.

---

## Task 1: Add "Re-process" button to meeting note UI

**Files:**
- Modify: `src/components/notes/NoteEditor.tsx` — add button near existing note actions

**Step 1:** Find where note action buttons are rendered (edit, delete, re-transcribe, etc.). Add a "Re-process" button that:
- Only shows for meeting notes (`note.note_type === "meeting"`)
- Only shows when saved audio exists (`note.system_audio_path || note.mic_audio_path`)
- Calls `window.electronAPI?.retryPipelineStep?.(noteId, "retranscribe")`
- Shows disabled state while pipeline is running for this note (check `selectPipelineForNote` store selector)

**Step 2:** Add i18n key: `"notes.reprocess.label": "Re-process meeting"` (all 10 locales).

**Step 3: Commit**

---

## Task 2: Add "Re-process All Meetings" IPC handler

**Files:**
- Modify: `src/helpers/ipcHandlers.js` — add `reprocess-all-meetings` handler
- Modify: `preload.js` — add bridge
- Modify: `src/types/electron.ts` — add type

**Step 1:** Add IPC handler that finds all meeting notes with saved audio and enqueues them:

```js
ipcMain.handle("reprocess-all-meetings", async () => {
  const notes = this.databaseManager.db
    .prepare("SELECT id FROM notes WHERE note_type = 'meeting' AND (system_audio_path IS NOT NULL OR mic_audio_path IS NOT NULL)")
    .all();

  let queued = 0;
  for (const note of notes) {
    this.backgroundJobQueue.enqueue(
      `reprocess-${note.id}`,
      () => this.postCallPipelineManager.run(note.id)
    );
    queued++;
  }

  debugLogger.info("Queued all meetings for re-processing", { count: queued }, "meeting");
  return { success: true, count: queued };
});
```

**Step 2:** Add to preload + types.

**Step 3: Commit**

---

## Task 3: Add "Re-process All" button to notes UI

**Files:**
- Modify: `src/components/notes/PersonalNotesView.tsx` or the meetings folder view — add a button in the folder header or action menu

**Step 1:** Add a button in the Meetings folder view that calls `window.electronAPI?.reprocessAllMeetings?.()`. Show a toast with the count of queued notes.

**Step 2:** Add i18n keys: `"notes.reprocessAll.label": "Re-process all meetings"`, `"notes.reprocessAll.queued": "Queued {{count}} meetings for re-processing"` (all 10 locales).

**Step 3: Commit**

---

## Execution Order

1. Task 1 (single note re-process button)
2. Task 2 (bulk IPC handler)
3. Task 3 (bulk UI button)

Tasks are sequential — each builds on the previous.

---

## Critical Warnings

1. **Bulk re-processing can be expensive.** 10 meetings × 5 minutes each = 50 minutes of background processing. The pipeline indicator already shows queue count, so the user knows how many are pending.

2. **Re-transcription requires saved audio.** If `dataRetentionEnabled` was off when the meeting was recorded, there's no audio to re-transcribe. The retranscribe step will skip (emit "skipped") and the pipeline continues with the original transcript for title/classify/notes.

3. **Re-processing overwrites existing notes.** The pipeline's `_generateNotes` writes to `note.enhanced_content`, overwriting any previous AI-generated notes. If the user has manually edited notes, those edits will be lost. Consider adding a confirmation dialog.
