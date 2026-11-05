import { create } from "zustand";
import i18n from "../i18n";
import { transcribeFileWithSpeakers } from "../services/fileTranscription";
import type { FileTranscriptionConfig, DiarizationSettings } from "../services/fileTranscription";
import {
  DOWNLOAD_ERROR_KEYS,
  isUploadPolicyRefusal,
  transcriptionErrorKey,
  uploadRestrictionKey,
} from "../components/notes/shared";
import { saveUploadNote, uploadTitleFallback } from "../services/uploadNotes";
import { getSettings } from "./settingsStore";
import { isAudioFeatureAllowed, isTranscriptionContextAllowed } from "./policyRules";
import { usePolicyStore } from "./policyStore";
import { isManagedTranscriptionActive } from "../services/managedTranscription";
import { describeProviderError } from "../utils/describeProviderError";

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
  // Transcription completed, but requested speaker labels could not be applied.
  diarizationWarning?: boolean;
  noteId?: number;
  tempPath?: string;
  // Stopped by org policy, showing why in `error`; the next run retries it.
  stoppedByPolicy?: boolean;
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

// Bumping the run id soft-cancels the drain loop; active uploads
// additionally get a true backend abort via cancel-upload-transcription. The
// orphaned run's late results are discarded on arrival while the UI unlocks
// immediately.
let runId = 0;
let activeUploadRequestId: string | null = null;
let activeUploadProgressCleanup: (() => void) | undefined;

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

function abortRun() {
  runId++;
  activeUploadProgressCleanup?.();
  activeUploadProgressCleanup = undefined;
  if (activeUploadRequestId) {
    window.electronAPI.cancelUploadTranscription?.(activeUploadRequestId);
    activeUploadRequestId = null;
  }
  window.electronAPI.cancelUrlDownload();
}

export function cancelBatch() {
  abortRun();
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
  activeUploadProgressCleanup?.();
  activeUploadProgressCleanup = undefined;
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
  if (
    !isAudioFeatureAllowed(usePolicyStore.getState(), "upload") ||
    (!isManagedTranscriptionActive() &&
      !isTranscriptionContextAllowed(usePolicyStore.getState(), getSettings(), "upload"))
  )
    return;
  const run = ++runId;
  useBatchQueueStore.setState((s) => ({
    isProcessing: true,
    queue: s.queue.map((item) =>
      item.stoppedByPolicy
        ? { ...item, status: "queued", progress: 0, error: undefined, stoppedByPolicy: undefined }
        : item
    ),
  }));

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

  // A policy refusal would meet every later item too, so it ends the run and
  // leaves the rest queued for when policy allows uploads again.
  let refusedByPolicy = false;
  const failItem = (id: string, error: string, failure: unknown) => {
    const byPolicy = isUploadPolicyRefusal(failure);
    if (byPolicy) refusedByPolicy = true;
    updateItem(id, { status: "error", error, ...(byPolicy ? { stoppedByPolicy: true } : {}) });
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
            failItem(item.id, key || fail.error, fail);
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

      const requestId = crypto.randomUUID();
      activeUploadRequestId = requestId;
      let cleanupTranscriptionProgress: (() => void) | undefined;
      if (isManagedTranscriptionActive()) {
        cleanupTranscriptionProgress = window.electronAPI.onUploadTranscriptionProgress?.(
          ({ chunksCompleted, chunksTotal }) => {
            if (chunksTotal > 0)
              updateItem(item.id, { progress: (chunksCompleted / chunksTotal) * 90 });
          }
        );
        activeUploadProgressCleanup = cleanupTranscriptionProgress;
      }
      const transcriptionResult = await transcribeFileWithSpeakers(
        filePath,
        transcription,
        diarization,
        durationSeconds,
        { requestId, timestamps: true }
      ).finally(() => {
        cleanupTranscriptionProgress?.();
        if (activeUploadProgressCleanup === cleanupTranscriptionProgress)
          activeUploadProgressCleanup = undefined;
        if (activeUploadRequestId === requestId) activeUploadRequestId = null;
      });

      if (run !== runId) return;

      if (!transcriptionResult.success || !transcriptionResult.text) {
        failItem(
          item.id,
          transcriptionErrorKey(transcriptionResult) ||
            (transcriptionResult.messageKey
              ? describeProviderError(
                  { ...transcriptionResult, message: transcriptionResult.error },
                  i18n.t
                ).description
              : undefined) ||
            transcriptionResult.error ||
            "batchTranscriptionFailed",
          transcriptionResult
        );
        return;
      }

      const finalText = transcriptionResult.text;

      // URL notes keep the video title; file notes get the same generated
      // titles as the single-file flow.
      let noteTitle = noteName;
      if (item.source === "file") {
        noteTitle =
          (await transcribeOpts.generateTitle?.(finalText)) ||
          uploadTitleFallback(finalText, noteName);
        if (run !== runId) return;
      }

      const noteRes = await saveUploadNote({
        title: noteTitle,
        text: finalText,
        sourceName: noteName,
        folderId: transcribeOpts.folderId,
        diarization,
        durationSeconds: transcriptionResult.durationSeconds,
        segments: transcriptionResult.segments,
      });

      if (noteRes.success && noteRes.note) {
        updateItem(item.id, {
          status: "done",
          progress: 100,
          warning: !!transcriptionResult.warning,
          diarizationWarning: !!transcriptionResult.diarizationWarning,
          noteId: noteRes.note.id,
        });
      } else {
        updateItem(item.id, { status: "error", error: "batchSaveFailed" });
      }
    } catch (err) {
      failItem(
        item.id,
        transcriptionErrorKey(err) ||
          (err instanceof Error
            ? describeProviderError(err, i18n.t).description
            : "batchUnknownError"),
        err
      );
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
      !refusedByPolicy &&
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

// Policy refusing uploads stops the run: the item in flight shows the same
// reason as the page banner, and Transcribe retries it with the rest once allowed.
usePolicyStore.subscribe((policy) => {
  if (!useBatchQueueStore.getState().isProcessing || isAudioFeatureAllowed(policy, "upload"))
    return;
  abortRun();
  const error = i18n.t(uploadRestrictionKey(policy));
  useBatchQueueStore.setState((s) => ({
    isProcessing: false,
    queue: s.queue.map((item) =>
      item.status === "downloading" || item.status === "transcribing"
        ? { ...item, status: "error" as const, error, stoppedByPolicy: true }
        : item
    ),
  }));
});

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
    // Queued items, or ones a policy stopped, that Transcribe would run.
    hasPending: queue.some((i) => i.status === "queued" || i.stoppedByPolicy),
    addFiles,
    addUrls,
    removeItem: removeQueueItem,
    cancelAll: cancelBatch,
    clearQueue: clearBatchQueue,
    processQueue: processBatchQueue,
  };
}
