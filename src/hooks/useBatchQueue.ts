import { useState, useRef, useCallback, useEffect } from "react";
import { transcribeFileWithSpeakers } from "../services/fileTranscription";
import type { FileTranscriptionConfig, DiarizationSettings } from "../services/fileTranscription";
import { DOWNLOAD_ERROR_KEYS } from "../components/notes/shared";

export type QueueItemStatus =
  | "queued"
  | "downloading"
  | "transcribing"
  | "done"
  | "error";

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

export function useBatchQueue() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentItemId, setCurrentItemId] = useState<string | null>(null);
  const processingRef = useRef(false);
  const cancelledRef = useRef(false);
  // Source of truth for the drain loop: updated synchronously so items added the
  // instant an item finishes are never missed.
  const queueRef = useRef<QueueItem[]>([]);

  const applyQueue = useCallback(
    (updater: (prev: QueueItem[]) => QueueItem[]) => {
      queueRef.current = updater(queueRef.current);
      setQueue(queueRef.current);
    },
    []
  );

  const addFiles = useCallback(
    (files: Array<{ name: string; path: string; sizeBytes: number }>) => {
      const items: QueueItem[] = files.map((f) => ({
        id: crypto.randomUUID(),
        source: "file" as const,
        name: f.name,
        path: f.path,
        sizeBytes: f.sizeBytes,
        status: "queued" as const,
        progress: 0,
      }));
      applyQueue((prev) => [...prev, ...items]);
      return items;
    },
    [applyQueue]
  );

  const addUrls = useCallback(
    (urls: string[]) => {
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
      applyQueue((prev) => [...prev, ...items]);
      return items;
    },
    [applyQueue]
  );

  const removeItem = useCallback(
    (id: string) => {
      applyQueue((prev) => prev.filter((item) => item.id !== id));
    },
    [applyQueue]
  );

  const updateItem = useCallback(
    (id: string, updates: Partial<QueueItem>) => {
      applyQueue((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...updates } : item))
      );
    },
    [applyQueue]
  );

  const cancelAll = useCallback(() => {
    cancelledRef.current = true;
    window.electronAPI.cancelUrlDownload();
    // The in-flight item flips too: its result is discarded at the next
    // checkpoint, so don't leave it spinning for however long that takes.
    applyQueue((prev) =>
      prev.map((item) =>
        item.status === "done" || item.status === "error"
          ? item
          : { ...item, status: "error" as const, error: "batchCancelled" }
      )
    );
  }, [applyQueue]);

  const clearQueue = useCallback(() => {
    cancelledRef.current = true;
    applyQueue(() => []);
    setCurrentItemId(null);
  }, [applyQueue]);

  const processQueue = useCallback(
    async (transcribeOpts: TranscribeOptions, diarization: DiarizationSettings) => {
      if (processingRef.current) return;
      processingRef.current = true;
      cancelledRef.current = false;
      setIsProcessing(true);

      const snapshotApiKey = transcribeOpts.transcription.getApiKey();
      const transcription: FileTranscriptionConfig = {
        ...transcribeOpts.transcription,
        getApiKey: () => snapshotApiKey,
      };

      const cancelItem = (id: string) => {
        updateItem(id, { status: "error", error: "batchCancelled" });
      };

      const processItem = async (item: QueueItem) => {
        setCurrentItemId(item.id);
        let filePath = item.path;
        let tempPath: string | undefined;
        let noteName = item.name;
        let sizeBytes = item.sizeBytes;
        let durationSeconds: number | null = null;

        try {
          if (item.source === "url" && item.url) {
            updateItem(item.id, { status: "downloading", progress: 0 });

            const cleanupProgress =
              window.electronAPI.onUrlDownloadProgress?.((data) => {
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

          if (cancelledRef.current) {
            cancelItem(item.id);
            return;
          }

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

          if (cancelledRef.current) {
            cancelItem(item.id);
            return;
          }

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
            if (cancelledRef.current) {
              cancelItem(item.id);
              return;
            }
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
          if (tempPath) {
            window.electronAPI.deleteTempFile(tempPath);
          }
        }
      };

      const processed = new Set<string>();
      let next: QueueItem | undefined;
      while (
        !cancelledRef.current &&
        (next = queueRef.current.find((i) => i.status === "queued" && !processed.has(i.id)))
      ) {
        processed.add(next.id);
        await processItem(next);
      }

      setCurrentItemId(null);
      setIsProcessing(false);
      processingRef.current = false;
      cancelledRef.current = false;
    },
    [updateItem]
  );

  useEffect(() => {
    return () => {
      if (processingRef.current) {
        cancelledRef.current = true;
        window.electronAPI.cancelUrlDownload();
      }
    };
  }, []);

  const completedCount = queue.filter((i) => i.status === "done").length;
  const failedCount = queue.filter((i) => i.status === "error").length;
  const totalCount = queue.length;
  const hasQueue = queue.length > 0;

  return {
    queue,
    isProcessing,
    currentItemId,
    hasQueue,
    completedCount,
    failedCount,
    totalCount,
    addFiles,
    addUrls,
    removeItem,
    cancelAll,
    clearQueue,
    processQueue,
  };
}
