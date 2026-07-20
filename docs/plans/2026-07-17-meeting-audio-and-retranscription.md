# Meeting Audio Saving + High-Quality Re-Transcription Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** After a meeting ends, save both mic and system audio as separate Opus files (retention-gated), then expose a whisper.cpp large-v3 re-transcription action that replaces the live transcript with a higher-accuracy post-call pass. Also fix the auto-start URL-gate, remove the dead MCP card, and bump to v1.9.0.

**Architecture:** The recording pipeline already captures mic and system as separate PCM streams in `ipcHandlers.js`; the system PCM is written to a temp file for diarization and deleted after. We add a parallel mic PCM write stream, copy both temp files before diarization cleanup, encode to Opus via bundled FFmpeg, and store in `userData/audio/` with paths recorded in two new `notes` table columns. For re-transcription, a new IPC handler reads the saved Opus file, feeds it through whisper-server large-v3, re-runs diarization, and overwrites `notes.transcript`. The renderer passes `saveAudio` (derived from `dataRetentionEnabled`) into `meeting-transcription-stop` since the main process has no direct access to the renderer settings store.

**Tech Stack:** Electron IPC, better-sqlite3, ffmpeg-static (Opus encoding), whisper.cpp whisper-server (Metal on macOS), Node.js fs/streams.

---

## Structural Facts (verified against the real code)

1. **System PCM path:** `meetingDiarizationPath` is a local `let` in `registerHandlers()` (line 5159). Set at first system chunk (line 6207), captured by `captureMeetingDiarizationState()` (line 4684–4696), and deleted in `_startOrSkipDiarization`'s `finally` block (line 9274–9276). We must copy it before `_startOrSkipDiarization` runs.

2. **Mic PCM:** Not persisted anywhere. Raw mic buffers flow through `sendMeetingAudio()` (line 6216+) with three paths: AEC (line 6217), bleed-suppression/dispatch (line 6221–6231), and pending-chunk queue (line 6234–6238). Hook the write at the TOP of the `source === "mic"` block to capture pre-AEC/bleed audio.

3. **Settings access:** `dataRetentionEnabled` lives in the renderer's zustand store (`settingsStore.ts:983`). The main process has NO `_getSettings()` or equivalent. The renderer must pass `saveAudio: boolean` through the `meeting-transcription-stop` IPC.

4. **Stop call sites:** `meetingRecordingStore.ts` lines 884 and 1218. Preload: `preload.js:635`. Type: `src/types/electron.ts:1720`. Main: `ipcHandlers.js:6349` (`async () => { ... }`).

5. **Database:** `getNote()` does `SELECT *` (line 1451) → new columns auto-included. `updateNote()` has `allowedFields` whitelist (line 1487–1503) → must add new column names.

6. **`checkForActiveMeetingUrl`** (browserMeetingUrlChecker.js): returns `{ matched: true, url, browser }` on match, `{ matched: false, denied: true }` on Automation denial, or `{ matched: false }` on timeout/no-match — timeout and "checked, no meeting" are **indistinguishable**. This is the auto-start bug.

---

## Feature Area 1: Meeting Audio Saving

### Task 1.1: Add mic_audio_path / system_audio_path columns to notes table

**Files:**
- Modify: `src/helpers/database.js:494` (after last ALTER TABLE)
- Modify: `src/helpers/database.js:1487` (allowedFields in updateNote)

**Step 1: Add the migration** (after the existing `deleted_at` migration at ~line 494):

```js
try {
  this.db.exec("ALTER TABLE notes ADD COLUMN mic_audio_path TEXT");
} catch (err) {
  if (!err.message.includes("duplicate column")) throw err;
}
try {
  this.db.exec("ALTER TABLE notes ADD COLUMN system_audio_path TEXT");
} catch (err) {
  if (!err.message.includes("duplicate column")) throw err;
}
```

**Step 2: Add to allowedFields** in `updateNote()` (line 1487–1503, after `"cloud_id"`):

```js
"mic_audio_path",
"system_audio_path",
```

**Step 3: Commit**
```bash
git add src/helpers/database.js
git commit -m "feat: add mic_audio_path / system_audio_path columns to notes table"
```

---

### Task 1.2: Add encodePcmToOpus helper to ffmpegUtils.js

**Files:**
- Modify: `src/helpers/ffmpegUtils.js:331` (add function, update exports)

**Step 1: Add the function** before `module.exports` (before line 331):

```js
/**
 * Encode a raw PCM file (16-bit signed LE, mono) to Opus.
 * @param {string} inputPath  - raw PCM path
 * @param {string} outputPath - .opus output path
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=24000]
 * @param {number} [opts.bitrate=32] kbps
 * @param {boolean} [opts.loudnorm=false] apply loudnorm filter
 * @returns {Promise<void>}
 */
function encodePcmToOpus(inputPath, outputPath, opts = {}) {
  const { sampleRate = 24000, bitrate = 32, loudnorm = false } = opts;
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) {
      reject(new Error("FFmpeg not found — cannot encode Opus audio"));
      return;
    }
    const audioFilter = loudnorm ? ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"] : [];
    const args = [
      "-f", "s16le",
      "-ar", String(sampleRate),
      "-ac", "1",
      "-i", inputPath,
      ...audioFilter,
      "-c:a", "libopus",
      "-b:a", `${bitrate}k`,
      "-application", "voip",
      "-y",
      outputPath,
    ];
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", (e) => reject(new Error(`FFmpeg Opus error: ${e.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg Opus exited ${code}: ${stderr.slice(-300)}`));
        return;
      }
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        reject(new Error("FFmpeg Opus produced no output"));
        return;
      }
      debugLogger.debug("Opus encode complete", { output: outputPath, bitrate });
      resolve();
    });
  });
}
```

**Step 2: Add to exports** (line 331):

```js
module.exports = {
  getFFmpegPath,
  isWavFormat,
  convertToWav,
  splitAudioFile,
  wavToFloat32Samples,
  computeFloat32RMS,
  encodePcmToOpus,
  clearCache,
};
```

**Step 3: Commit**
```bash
git add src/helpers/ffmpegUtils.js
git commit -m "feat: add encodePcmToOpus helper to ffmpegUtils"
```

---

### Task 1.3: Add mic PCM write stream to the recording pipeline

**Files:**
- Modify: `src/helpers/ipcHandlers.js` — three locations:
  - ~line 5159: declare mic state vars
  - ~line 5726: cleanup in `resetMeetingLocalState`
  - ~line 6216: write mic chunks in `sendMeetingAudio`

**Step 1: Declare mic state vars** alongside existing diarization state (after line 5161):

```js
let meetingMicPcmStream = null;
let meetingMicPcmPath = null;
```

**Step 2: Add mic cleanup to `resetMeetingLocalState`** (after line 5750, alongside the existing diarization cleanup):

```js
if (meetingMicPcmStream) {
  meetingMicPcmStream.end();
  meetingMicPcmStream = null;
}
if (meetingMicPcmPath) {
  fs.unlink(meetingMicPcmPath, () => {});
  meetingMicPcmPath = null;
}
```

**Step 3: Write mic chunks** — at the TOP of the `if (source === "mic")` block (line 6216), before any AEC/bleed processing:

```js
if (source === "mic") {
  // Accumulate raw mic PCM for audio retention
  if (!meetingMicPcmStream) {
    const os = require("os");
    meetingMicPcmPath = path.join(os.tmpdir(), `ow-mic-raw-${Date.now()}.pcm`);
    meetingMicPcmStream = fs.createWriteStream(meetingMicPcmPath);
  }
  meetingMicPcmStream.write(outboundBuffer);

  // ... existing AEC/bleed/dispatch logic below unchanged ...
```

**IMPORTANT:** `outboundBuffer` for mic is 16-bit signed LE mono 24 kHz PCM — same format as the system diarization stream. This captures the raw microphone signal before AEC/bleed zeroes it out.

**Step 4: Commit**
```bash
git add src/helpers/ipcHandlers.js
git commit -m "feat: accumulate raw mic PCM during meeting recording"
```

---

### Task 1.4: Capture mic PCM path at stop time

**Files:**
- Modify: `src/helpers/ipcHandlers.js:4684` — `captureMeetingDiarizationState()`

**Step 1: Extend the capture function** to include mic state:

```js
const captureMeetingDiarizationState = async () => {
  const diarizationPcmPath = meetingDiarizationPath;
  const diarizationSegments = meetingDiarizationSegments;
  const diarizationStartedAt = meetingDiarizationStartedAt;
  const micPcmPath = meetingMicPcmPath;       // NEW
  meetingMicPcmPath = null;                    // Clear so resetMeetingLocalState doesn't double-unlink

  if (meetingDiarizationStream) {
    await new Promise((resolve) => meetingDiarizationStream.end(resolve));
    meetingDiarizationStream = null;
  }
  if (meetingMicPcmStream) {                   // NEW
    await new Promise((resolve) => meetingMicPcmStream.end(resolve));
    meetingMicPcmStream = null;
  }
  meetingDiarizationPath = null;
  meetingDiarizationStartedAt = null;
  meetingDiarizationSegments = [];
  return { diarizationPcmPath, diarizationSegments, diarizationStartedAt, micPcmPath };
};
```

**Step 2:** Update both destructuring sites in `meeting-transcription-stop` (lines 6381 and 6406) to include `micPcmPath`:

```js
const { diarizationPcmPath, diarizationSegments, diarizationStartedAt, micPcmPath } =
  await captureMeetingDiarizationState();
```

**Step 3: Commit**
```bash
git add src/helpers/ipcHandlers.js
git commit -m "feat: capture mic PCM path at meeting stop for audio retention"
```

---

### Task 1.5: Add _saveMeetingAudio class method

**Files:**
- Modify: `src/helpers/ipcHandlers.js` — add method near `_startOrSkipDiarization`

**Step 1: Add the method** (near `_startOrSkipDiarization`, which is a class method):

```js
/**
 * Encode PCM tracks to Opus and store in userData/audio/.
 * Returns { micPath, systemPath } or null if retention disabled / nothing to save.
 */
async _saveMeetingAudio(noteId, micPcmPath, systemPcmPath) {
  const { encodePcmToOpus } = require("./ffmpegUtils");
  const audioDir = this.audioStorageManager.audioDir;

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

  const saved = { micPath: null, systemPath: null };

  const encode = async (pcmPath, track) => {
    if (!pcmPath || !fs.existsSync(pcmPath)) return null;
    const outFile = path.join(audioDir, `OpenWhispr-meeting-${noteId}-${stamp}-${track}.opus`);
    try {
      await encodePcmToOpus(pcmPath, outFile, { sampleRate: 24000, bitrate: 32 });
      return outFile;
    } catch (err) {
      debugLogger.warn(`Meeting ${track} audio encode failed`, { error: err.message }, "meeting");
      return null;
    } finally {
      try { fs.unlinkSync(pcmPath); } catch (_) {}
    }
  };

  [saved.micPath, saved.systemPath] = await Promise.all([
    encode(micPcmPath, "mic"),
    encode(systemPcmPath, "system"),
  ]);

  if ((saved.micPath || saved.systemPath) && noteId) {
    try {
      const updates = {};
      if (saved.micPath)    updates.mic_audio_path = saved.micPath;
      if (saved.systemPath) updates.system_audio_path = saved.systemPath;
      this.databaseManager.updateNote(noteId, updates);
    } catch (err) {
      debugLogger.warn("Failed to update note audio paths", { error: err.message }, "meeting");
    }
  }

  return saved;
}
```

**Step 2: Commit**
```bash
git add src/helpers/ipcHandlers.js
git commit -m "feat: add _saveMeetingAudio method for Opus encoding + DB update"
```

---

### Task 1.6: Pass saveAudio from renderer through meeting-transcription-stop

**Files:**
- Modify: `src/helpers/ipcHandlers.js:6349` — IPC handler signature
- Modify: `preload.js:635` — pass through options
- Modify: `src/types/electron.ts:1720` — update type
- Modify: `src/stores/meetingRecordingStore.ts:884,1218` — pass saveAudio

**Step 1: Update main handler** (line 6349):

```js
ipcMain.handle("meeting-transcription-stop", async (_event, options = {}) => {
```

The `options` parameter is used later in this task.

**Step 2: Update preload** (line 635):

```js
meetingTranscriptionStop: (options) => ipcRenderer.invoke("meeting-transcription-stop", options),
```

**Step 3: Update type** (line 1720):

```ts
meetingTranscriptionStop?: (options?: { saveAudio?: boolean }) => Promise<{
```

**Step 4: Update renderer call sites** in `meetingRecordingStore.ts`:

Line 884:
```ts
await window.electronAPI?.meetingTranscriptionStop?.({
  saveAudio: useSettingsStore.getState().dataRetentionEnabled,
});
```

Line 1218:
```ts
const result = await window.electronAPI?.meetingTranscriptionStop?.({
  saveAudio: useSettingsStore.getState().dataRetentionEnabled,
});
```

**Step 5: Commit**
```bash
git add src/helpers/ipcHandlers.js preload.js src/types/electron.ts src/stores/meetingRecordingStore.ts
git commit -m "feat: pass saveAudio flag through meeting-transcription-stop IPC"
```

---

### Task 1.7: Wire _saveMeetingAudio into the stop flow

**Files:**
- Modify: `src/helpers/ipcHandlers.js` — both stop branches (lines ~6381 and ~6406)

**Step 1: Add audio saving after `captureMeetingDiarizationState()`** in BOTH branches (local-mode ~line 6382, streaming ~line 6406). Insert AFTER destructuring `captureMeetingDiarizationState()` and BEFORE `_startOrSkipDiarization()`:

```js
// --- Audio retention: copy system PCM before diarization deletes it ---
const saveAudio = options?.saveAudio !== false;
let systemPcmCopy = null;
if (saveAudio && diarizationPcmPath && noteIdSnapshot) {
  const copyPath = diarizationPcmPath + `.save-${Date.now()}.pcm`;
  try {
    fs.copyFileSync(diarizationPcmPath, copyPath);
    systemPcmCopy = copyPath;
  } catch (err) {
    debugLogger.warn("Could not copy system PCM for audio save", { error: err.message }, "meeting");
  }
}

// Fire-and-forget audio retention (non-blocking, parallel with diarization)
if (saveAudio && noteIdSnapshot) {
  this._saveMeetingAudio(noteIdSnapshot, micPcmPath, systemPcmCopy)
    .catch(err => debugLogger.warn("Meeting audio save failed", { error: err.message }, "meeting"));
} else {
  // Retention off: clean up mic PCM
  if (micPcmPath) {
    try { fs.unlinkSync(micPcmPath); } catch (_) {}
  }
  if (systemPcmCopy) {
    try { fs.unlinkSync(systemPcmCopy); } catch (_) {}
  }
}
```

**CRITICAL:** `_startOrSkipDiarization` gets the ORIGINAL `diarizationPcmPath` and deletes it in its `finally` block (line 9274). `_saveMeetingAudio` gets `systemPcmCopy` (the copy). Both can run in parallel without race conditions.

**Step 2: Commit**
```bash
git add src/helpers/ipcHandlers.js
git commit -m "feat: wire meeting audio save into stop flow with PCM copy"
```

---

### Task 1.8: Add IPC handlers for note audio access

**Files:**
- Modify: `src/helpers/ipcHandlers.js` — near `get-audio-path` handler (~line 969)
- Modify: `preload.js` — add new API methods
- Modify: `src/types/electron.ts` — add types

**Step 1: Add IPC handlers** in `ipcHandlers.js`:

```js
ipcMain.handle("get-note-audio-paths", async (_event, noteId) => {
  const note = this.databaseManager.getNote(noteId);
  return {
    micPath: note?.mic_audio_path || null,
    systemPath: note?.system_audio_path || null,
  };
});

ipcMain.handle("delete-note-audio", async (_event, noteId) => {
  const note = this.databaseManager.getNote(noteId);
  for (const p of [note?.mic_audio_path, note?.system_audio_path]) {
    if (p && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
  }
  this.databaseManager.updateNote(noteId, { mic_audio_path: null, system_audio_path: null });
  return { success: true };
});
```

**Step 2: Add to preload.js:**

```js
getNoteAudioPaths: (noteId) => ipcRenderer.invoke("get-note-audio-paths", noteId),
deleteNoteAudio: (noteId) => ipcRenderer.invoke("delete-note-audio", noteId),
```

**Step 3: Add types** to `src/types/electron.ts`:

```ts
getNoteAudioPaths?: (noteId: number) => Promise<{ micPath: string | null; systemPath: string | null }>;
deleteNoteAudio?: (noteId: number) => Promise<{ success: boolean }>;
```

**Step 4: Commit**
```bash
git add src/helpers/ipcHandlers.js preload.js src/types/electron.ts
git commit -m "feat: add get-note-audio-paths and delete-note-audio IPC handlers"
```

---

### Task 1.9: Manual test — meeting audio saving

```
1. npm run dev
2. Start a meeting recording (mic + system audio), speak 30+ seconds
3. Stop recording
4. In DevTools console: window.electronAPI.getNoteAudioPaths(<noteId from the note>)
   Expected: { micPath: "/.../audio/OpenWhispr-meeting-...-mic.opus", systemPath: "...-system.opus" }
5. Verify both files exist: ls ~/Library/Application\ Support/OpenWhispr-development/audio/
6. Play both files: afplay <path-to-mic.opus>  and  afplay <path-to-system.opus>
7. Toggle Settings > Privacy > "Save audio recordings" OFF
8. Repeat steps 2-4
   Expected: getNoteAudioPaths returns { micPath: null, systemPath: null }
9. Confirm no .opus files were created and temp PCM files cleaned up (ls /tmp/ow-*)
```

---

## Feature Area 2: Whisper large-v3 Re-Transcription

### Task 2.1: Add retranscribe-meeting-note IPC handler

**Files:**
- Modify: `src/helpers/ipcHandlers.js` — add handler near note-related IPC section

**Step 1: Add the handler:**

```js
ipcMain.handle("retranscribe-meeting-note", async (event, noteId, options = {}) => {
  const { BrowserWindow } = require("electron");
  const note = this.databaseManager.getNote(noteId);
  if (!note) return { success: false, error: "Note not found" };

  const audioPath = note.system_audio_path || note.mic_audio_path;
  if (!audioPath || !fs.existsSync(audioPath)) {
    return { success: false, error: "No saved audio found for this note" };
  }

  try {
    // 1. Read saved Opus and transcribe with whisper-server large-v3
    const audioBuffer = fs.readFileSync(audioPath);
    const model = options.model || "large";

    const transcriptionResult = await this.whisperManager.transcribeLocalWhisper(audioBuffer, {
      model,
      language: options.language || null,
    });

    const rawText = transcriptionResult?.text || "";
    if (!rawText.trim()) {
      return { success: false, error: "Re-transcription produced empty output" };
    }

    // 2. Re-run diarization if system audio available
    let finalTranscript = rawText;
    const systemPath = note.system_audio_path;
    if (systemPath && fs.existsSync(systemPath) && this.diarizationManager) {
      try {
        const { convertToWav } = require("./ffmpegUtils");
        const tmpWav = systemPath.replace(/\.opus$/, `-retranscribe-${Date.now()}.wav`);
        await convertToWav(systemPath, tmpWav, { sampleRate: 16000, channels: 1 });

        const diarResult = await this.diarizationManager.diarize(tmpWav, {});
        if (diarResult?.segments?.length) {
          // Build transcript segments from whisper result
          const whisperSegments = (transcriptionResult.segments || []).map((seg, i) => ({
            id: `retranscribe-${i}`,
            text: seg.text,
            source: "system",
            timestamp: (seg.start || 0) * 1000,
          }));
          const enriched = this.diarizationManager.mergeWithTranscript(whisperSegments, diarResult.segments);
          if (enriched?.length) {
            finalTranscript = JSON.stringify(enriched);
          }
        }
        try { fs.unlinkSync(tmpWav); } catch (_) {}
      } catch (diarErr) {
        debugLogger.warn("Re-transcription diarization failed, using raw text", { error: diarErr.message }, "meeting");
      }
    }

    // 3. Overwrite note transcript
    this.databaseManager.updateNote(noteId, { transcript: finalTranscript });
    const updatedNote = this.databaseManager.getNote(noteId);

    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.webContents.send("note-updated", updatedNote);
    }

    return { success: true, noteId };
  } catch (err) {
    debugLogger.error("Re-transcription failed", { error: err.message, noteId }, "meeting");
    return { success: false, error: err.message };
  }
});
```

**Note:** `transcribeLocalWhisper` will auto-start/restart whisper-server with the large model. Model must be downloaded first — the `getModelPath` check in whisper.js throws if the model file doesn't exist.

**Step 2: Commit**
```bash
git add src/helpers/ipcHandlers.js
git commit -m "feat: add retranscribe-meeting-note IPC handler (whisper large-v3)"
```

---

### Task 2.2: Add check-whisper-model-downloaded IPC handler

**Files:**
- Modify: `src/helpers/ipcHandlers.js`

**Step 1:** Check if a handler like this already exists. Search for `download-whisper-model` or `check-model` patterns. The existing `download-whisper-model` handler handles downloads. Add a simple check:

```js
ipcMain.handle("check-whisper-model-downloaded", async (_event, modelName) => {
  try {
    const modelPath = this.whisperManager.getModelPath(modelName);
    return { downloaded: fs.existsSync(modelPath), modelPath };
  } catch {
    return { downloaded: false };
  }
});
```

**Step 2: Wire in preload + types:**

preload.js:
```js
retranscribeMeetingNote: (noteId, options) => ipcRenderer.invoke("retranscribe-meeting-note", noteId, options),
checkWhisperModelDownloaded: (model) => ipcRenderer.invoke("check-whisper-model-downloaded", model),
```

src/types/electron.ts:
```ts
retranscribeMeetingNote?: (noteId: number, options?: { model?: string; language?: string }) => Promise<{ success: boolean; error?: string; noteId?: number }>;
checkWhisperModelDownloaded?: (model: string) => Promise<{ downloaded: boolean; modelPath?: string }>;
```

**Step 3: Commit**
```bash
git add src/helpers/ipcHandlers.js preload.js src/types/electron.ts
git commit -m "feat: add retranscribe + check-whisper-model preload/IPC wiring"
```

---

### Task 2.3: Add "Re-transcribe (high quality)" button to note UI

**Files:**
- Modify: The component that renders individual meeting notes — find by grepping for `note_type.*meeting` or `PersonalNotesView` in `src/components/notes/`. The handoff says `PersonalNotesView.tsx`.
- Modify: `src/locales/en/translation.json` — add i18n keys

**Step 1: Investigate** the note detail component to find where action buttons live. Look for `note.transcript` rendering and existing action buttons (edit, delete, share, etc.).

**Step 2: Add state and handler:**

```tsx
const [retranscribing, setRetranscribing] = useState(false);

const handleRetranscribe = async (noteId: number) => {
  const modelCheck = await window.electronAPI?.checkWhisperModelDownloaded?.("large");
  if (!modelCheck?.downloaded) {
    // Trigger model download — use existing download flow
    toast({ title: t("notes.retranscribe.downloadNeeded"), variant: "default" });
    await window.electronAPI?.downloadWhisperModel?.("large");
    return;
  }

  setRetranscribing(true);
  try {
    const result = await window.electronAPI?.retranscribeMeetingNote?.(noteId, { model: "large" });
    if (!result?.success) {
      toast({ title: t("notes.retranscribe.failed", { error: result?.error }), variant: "destructive" });
    } else {
      toast({ title: t("notes.retranscribe.success") });
    }
  } finally {
    setRetranscribing(false);
  }
};
```

**Step 3: Add button** (conditionally shown when note has saved audio):

```tsx
{selectedNote?.note_type === "meeting" &&
  (selectedNote?.system_audio_path || selectedNote?.mic_audio_path) && (
    <Button
      variant="outline"
      size="sm"
      onClick={() => handleRetranscribe(selectedNote.id)}
      disabled={retranscribing}
    >
      {retranscribing ? t("notes.retranscribe.inProgress") : t("notes.retranscribe.label")}
    </Button>
  )}
```

**Step 4: Add i18n keys** to `src/locales/en/translation.json` (under `notes`):

```json
"retranscribe": {
  "label": "Re-transcribe (high quality)",
  "inProgress": "Re-transcribing...",
  "success": "Transcript updated with high-quality model",
  "failed": "Re-transcription failed: {{error}}",
  "downloadNeeded": "Downloading large-v3 model (~3 GB). Try again after download completes."
}
```

Add equivalent keys to the other 8 language files (es, fr, de, pt, it, ru, zh-CN, zh-TW).

**Step 5: Commit**
```bash
git add src/components/notes/ src/locales/
git commit -m "feat: add Re-transcribe button to meeting note UI"
```

---

## Feature Area 3: Capture Gain Diagnostic

### Task 3.1: Add RMS level logging at system PCM write point

**Files:**
- Modify: `src/helpers/ipcHandlers.js:6211` — after `meetingDiarizationStream.write(outboundBuffer)`

**Step 1: Add sampled RMS measurement** (log every 100th system chunk to avoid spam):

```js
meetingDiarizationStream.write(outboundBuffer);

// Diagnostic: measure system audio level (sample every 100 chunks)
if (meetingSendCounts.system % 100 === 0 && meetingSendCounts.system > 0) {
  const samples = new Int16Array(outboundBuffer.buffer, outboundBuffer.byteOffset, outboundBuffer.length >> 1);
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const n = samples[i] / 0x7fff;
    sumSq += n * n;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  debugLogger.debug("System audio level", { dbfs: dbfs.toFixed(1), chunks: meetingSendCounts.system }, "meeting-gain");
}
```

**Step 2: Verify** by running a meeting recording with `--log-level=debug` and checking the debug log for `meeting-gain` entries. If dBFS is consistently below −40, the captured audio is too quiet for reliable STT/diarization.

**Step 3: Commit**
```bash
git add src/helpers/ipcHandlers.js
git commit -m "feat: add system audio RMS level diagnostic logging"
```

**Note:** If measurements confirm low gain, the `encodePcmToOpus` helper already supports `loudnorm: true`. Add a pre-diarization normalization step in a follow-up — not part of this PR unless measurements confirm the problem.

---

## Feature Area 4: Auto-Start URL-Gate Fix

### Task 4.1: Fix browserMeetingUrlChecker to distinguish timeout from "no meeting"

**Files:**
- Modify: `src/helpers/browserMeetingUrlChecker.js:79`

**Problem:** When the osascript call fails (timeout at 4s, or other non-denied error), the raw helper returns `{ ok: false, denied: false }`. But `checkForActiveMeetingUrl()` falls through to line 79 and returns `{ matched: false }` — the same as "successfully checked, no meeting found". The caller can't distinguish the two.

**Step 1: Add `unavailable` flag** to the timeout/error path. Change line 79 from:

```js
return { matched: false };
```

To check whether any browser successfully responded:

```js
// If we got here, no browser had a matching URL.
// BUT if all browsers failed (res.ok === false for every app), the check was
// inconclusive — not a confident "no meeting".
const anySucceeded = results.some(r => r.ok);
return anySucceeded ? { matched: false } : { matched: false, unavailable: true };
```

This requires accumulating results. Wrap the existing for-loop to collect them. Currently the function iterates `BROWSERS` and calls `runOsascript` per browser. Adjust:

```js
async function checkForActiveMeetingUrl() {
  if (process.platform !== "darwin") return { matched: false };
  if (automationDenied) return { matched: false, denied: true };

  let anyBrowserResponded = false;
  for (const app of BROWSERS) {
    const res = await runOsascript(urlScript(app));
    if (res.denied) {
      automationDenied = true;
      debugLogger.info(
        "Browser tab check blocked (Automation permission denied); using device-in-use only",
        { browser: app },
        "meeting"
      );
      return { matched: false, denied: true };
    }
    if (res.ok) {
      anyBrowserResponded = true;
      // ... existing URL matching logic ...
      for (const line of res.output.split("\n")) {
        const url = line.trim();
        if (MEETING_URL_PATTERNS.some((rx) => rx.test(url))) {
          return { matched: true, url, browser: app };
        }
      }
    }
  }
  // No match — but was it a confident "no meeting" or an inconclusive failure?
  return anyBrowserResponded
    ? { matched: false }
    : { matched: false, unavailable: true };
}
```

**Step 2: Commit**
```bash
git add src/helpers/browserMeetingUrlChecker.js
git commit -m "fix: distinguish URL check timeout from 'no meeting found'"
```

---

### Task 4.2: Update _handleCallActive to trust device signal when URL check is unavailable

**Files:**
- Modify: `src/helpers/meetingDetectionEngine.js:93-102`

**Step 1: Replace the binary `confirmed` check** (lines 93-102):

```js
const urlMatch = data?.urlMatch;
// Three outcomes:
// 1. matched=true → definitely a meeting → auto-start
// 2. denied=true or unavailable=true → can't check → trust device signal → auto-start
// 3. matched=false (no denied, no unavailable) → successfully found no meeting → skip
// 4. urlMatch is null (urlChecker threw) → can't check → trust device signal → auto-start
const urlCheckRan = urlMatch && !urlMatch.denied && !urlMatch.unavailable;
const noMeetingFound = urlCheckRan && !urlMatch.matched;

if (noMeetingFound) {
  debugLogger.info(
    "Camera/mic in use but browser check found no meeting URL; not auto-starting",
    { devices: data?.devices },
    "meeting"
  );
  return;
}

if (!urlMatch?.matched) {
  debugLogger.info(
    "Camera/mic in use; URL check unavailable — trusting device signal for auto-start",
    { devices: data?.devices, reason: urlMatch?.denied ? "denied" : urlMatch?.unavailable ? "unavailable" : "no-checker" },
    "meeting"
  );
}
```

This replaces lines 93–102. The `auto-start` block at lines 103+ stays as-is.

**Step 2: Commit**
```bash
git add src/helpers/meetingDetectionEngine.js
git commit -m "fix: auto-start trusts device signal when URL check is unavailable"
```

---

### Task 4.3: Manual test — auto-start with revoked Automation

```
1. System Settings > Privacy & Security > Automation > remove OpenWhispr entries
2. Settings > General > "Auto-start recording in meetings" → ON
3. Join a Google Meet call (camera + mic will activate)
   Expected: auto-start fires (device-in-use trusted, URL check unavailable)
   Check debug log for: "trusting device signal for auto-start" with reason "unavailable"
4. Re-grant Automation permission, rejoin call
   Expected: auto-start fires with url matched
5. Open Photo Booth (camera in use but no meeting) WITH Automation granted
   Expected: auto-start does NOT fire ("found no meeting URL")
```

---

## Feature Area 5: Remove Dead MCP Settings Card

### Task 5.1: Remove McpIntegrationCard from IntegrationsView

**Files:**
- Modify: `src/components/IntegrationsView.tsx:21,254-255`

**Step 1: Remove import** (line 21):
```tsx
// DELETE: import McpIntegrationCard from "./McpIntegrationCard";
```

**Step 2: Remove usage** (lines 253-256 — the div wrapping the MCP section):
```tsx
// DELETE this block:
// <div>
//   <SectionLabel>{t("integrations.sections.mcp")}</SectionLabel>
//   <McpIntegrationCard isPaid={isPaid} onUpgrade={onUpgrade} />
// </div>
```

**Do NOT delete `McpIntegrationCard.tsx`** — leave the file on disk so upstream merges stay clean.

**Step 3: Commit**
```bash
git add src/components/IntegrationsView.tsx
git commit -m "chore: remove dead MCP integration settings card"
```

---

## Feature Area 6: Version Bump to v1.9.0

### Task 6.1: Bump version + CHANGELOG

**Files:**
- Modify: `package.json` — `"version": "1.8.0"` → `"version": "1.9.0"`
- Modify: `CHANGELOG.md` — add v1.9.0 entry (check if file exists first)

**Step 1: Update package.json version:**
```json
"version": "1.9.0",
```

**Step 2: Add CHANGELOG entry** at the top:

```markdown
## v1.9.0 — 2026-07-17

### Added
- **Meeting audio saving:** After a call ends, mic and system audio are encoded to separate Opus files (~32 kbps mono) in `userData/audio/`. Gated on Settings > Privacy > "Save audio recordings" (`dataRetentionEnabled`). Paths stored in `notes.mic_audio_path` / `notes.system_audio_path`.
- **High-quality re-transcription:** "Re-transcribe (high quality)" button on meeting notes runs a post-call whisper.cpp large-v3 pass (Metal-accelerated, ~2–5 min for 30 min) + diarization re-run, replacing the live transcript. Requires ~3 GB large-v3 model download.
- System audio RMS level diagnostic logging (`meeting-gain` debug tag).

### Fixed
- Auto-start recording no longer silently fails when macOS Automation permission is pending or denied. The URL check now distinguishes "timeout/error" from "no meeting found" — device-in-use signal is trusted when the check can't run.

### Removed
- Dead MCP integration settings card (cloud feature, non-functional in fork).
```

**Step 3: Commit**
```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump version to 1.9.0"
```

---

## Execution Order and Dependencies

```
Task 1.1 (DB migration)           ─── independent, safe to run first
Task 1.2 (ffmpegUtils)            ─── independent
Task 1.3 (mic PCM stream)         ─── independent
Task 1.4 (capture mic at stop)    ─── depends on 1.3
Task 1.5 (_saveMeetingAudio)      ─── depends on 1.1, 1.2
Task 1.6 (pass saveAudio flag)    ─── depends on 1.4, 1.5
Task 1.7 (wire into stop flow)    ─── depends on 1.5, 1.6
Task 1.8 (note audio IPC)         ─── depends on 1.1
Task 1.9 (manual test)            ─── depends on 1.1–1.8
Task 2.1 (retranscribe handler)   ─── depends on 1.8
Task 2.2 (check model IPC)        ─── depends on 2.1
Task 2.3 (UI button)              ─── depends on 2.2
Task 3.1 (gain diagnostic)        ─── independent, any time after 1.3
Task 4.1 (URL checker fix)        ─── independent
Task 4.2 (_handleCallActive fix)  ─── depends on 4.1
Task 4.3 (manual test)            ─── depends on 4.2
Task 5.1 (MCP card removal)       ─── fully independent
Task 6.1 (version bump)           ─── last
```

Recommended parallel batches:
1. **Batch A** (independent): Tasks 1.1, 1.2, 1.3, 3.1, 4.1, 5.1
2. **Batch B** (depends on A): Tasks 1.4, 1.5, 4.2
3. **Batch C** (depends on B): Tasks 1.6, 1.7, 1.8
4. **Batch D** (depends on C): Tasks 2.1, 2.2
5. **Batch E** (depends on D): Task 2.3
6. **Batch F** (last): Tasks 1.9, 4.3 (manual tests), 6.1

---

## Critical Warnings

1. **ipcHandlers.js is 9300+ lines.** Every edit must be surgically targeted. Read the surrounding 20 lines before any change. Line numbers in this plan are approximate — re-verify before editing.

2. **PCM lifecycle:** `_startOrSkipDiarization` owns `rawPcmPath` and deletes it in `finally` (line 9274). The system PCM copy (Task 1.7) is mandatory — never pass the original path to both `_startOrSkipDiarization` and `_saveMeetingAudio`.

3. **Mic PCM disk usage:** For a 1-hour call at 24 kHz mono 16-bit, the temp PCM is ~172 MB. Encoded Opus is ~14 MB. The temp file is deleted after encoding. This is bounded and temporary.

4. **Whisper-server restart:** Re-transcription with `large` may require restarting the whisper-server if a different model is loaded. `transcribeLocalWhisper` handles this automatically, but it takes 10–30 seconds. The UI should show a spinner.

5. **Model download:** The large-v3 model is ~3 GB. The first re-transcription attempt will fail with "model not downloaded" if the user hasn't downloaded it. The UI checks this first and triggers the existing download flow.

6. **Recording lifecycle:** Tasks 1.3, 1.4, and 1.7 touch the recording stop flow. Test thoroughly after each change — a broken stop flow means meetings can't end cleanly.

7. **TypeScript types:** The `NoteItem` type in `src/types/electron.ts` must be updated to include `mic_audio_path?: string` and `system_audio_path?: string` or the UI button logic will have TypeScript errors. Check where `NoteItem` or the note type is defined and add the fields.
