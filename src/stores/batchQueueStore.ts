import { create } from "zustand";
import { transcribeFileWithSpeakers } from "../services/fileTranscription";
import type { FileTranscriptionConfig, DiarizationSettings } from "../services/fileTranscription";
import { DOWNLOAD_ERROR_KEYS } from "../components/notes/shared";

export type QueueItemStatus = "queued" | "downloading" | "transcribing" | "done" | "error";

export interface QueueItem {
  id: string;
  source: "file" | "url";
  name: string;
  path: string;
  url?: string;
  sizeBytes: number;
  status: QueueItemStatus;
  progress: number;
  error?: string;
  // Transcription completed but parts of the audio failed (e.g. failed chunks).
  warning?: boolean;
  noteId?: number;
  tempPath?: string;
}

export interface TranscribeOptions {
  transcription: FileTranscriptionConfig;
  folderId: number | null;
  // Returns an i18n key under notes.upload.* when the file exceeds the
  // mode-aware size limit, null when acceptable.
  validateSize?: (sizeBytes: number) => string | null;
  generateTitle?: (text: string) => Promise<string | null>;
}

interface BatchQueueStoreState {
  queue: QueueItem[];
  isProcessing: boolean;
}

export const useBatchQueueStore = create<BatchQueueStoreState>()(() => ({
  queue: [],
  isProcessing: false,
}));

// Bumping the run id soft-cancels the drain loop: the in-flight transcription
// IPC can't be aborted, so the orphaned run's late results are discarded on
// arrival while the UI unlocks immediately.
let runId = 0;

function updateQueue(updater: (prev: QueueItem[]) => QueueItem[]) {
  useBatchQueueStore.setState((s) => ({ queue: updater(s.queue) }));
}

export function addFiles(files: Array<{ name: string; path: string; sizeBytes: number }>) {
  const items: QueueItem[] = files.map((f) => ({
    id: crypto.randomUUID(),
    source: "file" as const,
    name: f.name,
    path: f.path,
    sizeBytes: f.sizeBytes,
    status: "queued" as const,
    progress: 0,
  }));
  updateQueue((prev) => [...prev, ...items]);
  return items;
}

export function addUrls(urls: string[]) {
  const items: QueueItem[] = urls.map((url) => ({
    id: crypto.randomUUID(),
    source: "url" as const,
    name: url,
    path: "",
    url,
    sizeBytes: 0,
    status: "queued" as const,
    progress: 0,
  }));
  updateQueue((prev) => [...prev, ...items]);
  return items;
}

export function removeQueueItem(id: string) {
  updateQueue((prev) => prev.filter((item) => item.id !== id));
}

export function cancelBatch() {
  runId++;
  window.electronAPI.cancelUrlDownload();
  useBatchQueueStore.setState((s) => ({
    isProcessing: false,
    queue: s.queue.map((item) =>
      item.status === "done" || item.status === "error"
        ? item
        : { ...item, status: "error" as const, error: "batchCancelled" }
    ),
  }));
}

export function clearBatchQueue() {
  runId++;
  useBatchQueueStore.setState({ queue: [], isProcessing: false });
}

/**
 * Drain the queue in the background. Runs detached from React — survives
 * component unmounts and navigation so the user can browse notes mid-batch.
 */
export function processBatchQueue(
  transcribeOpts: TranscribeOptions,
  diarization: DiarizationSettings
): void {
  if (useBatchQueueStore.getState().isProcessing) return;
  const run = ++runId;
  useBatchQueueStore.setState({ isProcessing: true });

  const snapshotApiKey = transcribeOpts.transcription.getApiKey();
  const transcription: FileTranscriptionConfig = {
    ...transcribeOpts.transcription,
    getApiKey: () => snapshotApiKey,
  };

  // Run-scoped writer: a cancelled run's late IPC results must not touch items.
  const updateItem = (id: string, updates: Partial<QueueItem>) => {
    if (run !== runId) return;
    updateQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...updates } : item)));
  };

  const processItem = async (item: QueueItem) => {
    let filePath = item.path;
    let tempPath: string | undefined;
    let noteName = item.name;
    let sizeBytes = item.sizeBytes;
    let durationSeconds: number | null = null;

    try {
      if (item.source === "url" && item.url) {
        updateItem(item.id, { status: "downloading", progress: 0 });

        const cleanupProgress = window.electronAPI.onUrlDownloadProgress?.((data) => {
          if (data.downloadId && data.downloadId !== item.id) return;
          updateItem(item.id, {
            progress: data.percent,
            name: data.title || item.name,
          });
        });

        try {
          const res = await window.electronAPI.downloadUrlAudio(item.url, item.id);
          if (!res.success) {
            const fail = res as { success: false; error: string; code?: string };
            const key =
              fail.code === "DOWNLOAD_CANCELLED"
                ? "batchCancelled"
                : DOWNLOAD_ERROR_KEYS[fail.code || ""];
            updateItem(item.id, { status: "error", error: key || fail.error });
            return;
          }
          filePath = res.tempPath;
          tempPath = res.tempPath;
          noteName = res.title || item.name;
          sizeBytes = res.sizeBytes;
          durationSeconds = res.durationSeconds;
          updateItem(item.id, {
            path: res.tempPath,
            tempPath: res.tempPath,
            name: noteName,
            sizeBytes: res.sizeBytes,
          });
        } finally {
          cleanupProgress?.();
        }
      }

      if (run !== runId) return;

      const sizeError = transcribeOpts.validateSize?.(sizeBytes) ?? null;
      if (sizeError) {
        updateItem(item.id, { status: "error", error: sizeError });
        return;
      }

      updateItem(item.id, { status: "transcribing", progress: 0 });

      const transcriptionResult = await transcribeFileWithSpeakers(
        filePath,
        transcription,
        diarization,
        durationSeconds
      );

      if (run !== runId) return;

      if (!transcriptionResult.success || !transcriptionResult.text) {
        updateItem(item.id, {
          status: "error",
          error:
            transcriptionResult.code === "NO_SPEECH_DETECTED"
              ? "noSpeechDetected"
              : transcriptionResult.error || "batchTranscriptionFailed",
        });
        return;
      }

      const finalText = transcriptionResult.text;

      // URL notes keep the video title; file notes get the same generated
      // titles as the single-file flow.
      let noteTitle = noteName;
      if (item.source === "file") {
        const words = finalText.trim().split(/\s+/);
        const fallback =
          words.slice(0, 6).join(" ") + (words.length > 6 ? "..." : "") ||
          noteName.replace(/\.[^.]+$/, "");
        noteTitle = (await transcribeOpts.generateTitle?.(finalText)) || fallback;
        if (run !== runId) return;
      }

      const noteRes = await window.electronAPI.saveNote(
        noteTitle,
        finalText,
        "upload",
        noteName,
        null,
        transcribeOpts.folderId
      );

      if (noteRes.success && noteRes.note) {
        updateItem(item.id, {
          status: "done",
          progress: 100,
          warning: !!transcriptionResult.warning,
          noteId: noteRes.note.id,
        });
      } else {
        updateItem(item.id, { status: "error", error: "batchSaveFailed" });
      }
    } catch (err) {
      updateItem(item.id, {
        status: "error",
        error: err instanceof Error ? err.message : "batchUnknownError",
      });
    } finally {
      // Nothing else owns the temp file, so delete it even for a stale run.
      if (tempPath) {
        window.electronAPI.deleteTempFile(tempPath);
      }
    }
  };

  (async () => {
    const processed = new Set<string>();
    let next: QueueItem | undefined;
    while (
      run === runId &&
      (next = useBatchQueueStore
        .getState()
        .queue.find((i) => i.status === "queued" && !processed.has(i.id)))
    ) {
      processed.add(next.id);
      await processItem(next);
    }
    if (run === runId) {
      useBatchQueueStore.setState({ isProcessing: false });
    }
  })();
}

// Same composed shape the queue UI consumed when this lived in a hook.
export function useBatchQueue() {
  const { queue, isProcessing } = useBatchQueueStore();

  return {
    queue,
    isProcessing,
    hasQueue: queue.length > 0,
    completedCount: queue.filter((i) => i.status === "done").length,
    failedCount: queue.filter((i) => i.status === "error").length,
    totalCount: queue.length,
    addFiles,
    addUrls,
    removeItem: removeQueueItem,
    cancelAll: cancelBatch,
    clearQueue: clearBatchQueue,
    processQueue: processBatchQueue,
  };
}
