import { useState, useRef, useCallback, useEffect } from "react";

export type QueueItemStatus =
  | "queued"
  | "downloading"
  | "transcribing"
  | "diarizing"
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
  useLocalWhisper: boolean;
  localTranscriptionProvider: string;
  whisperModel: string;
  parakeetModel: string;
  isOpenWhisprCloud: boolean;
  getActiveApiKey: () => string;
  cloudTranscriptionBaseUrl: string;
  cloudTranscriptionModel: string;
  folderId: number | null;
}

export interface DiarizationOptions {
  enabled: boolean;
  numSpeakers: number | null;
}

export function useBatchQueue() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentItemId, setCurrentItemId] = useState<string | null>(null);
  const processingRef = useRef(false);
  const cancelledRef = useRef(false);
  const queueRef = useRef<QueueItem[]>([]);

  queueRef.current = queue;

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
      setQueue((prev) => [...prev, ...items]);
      return items;
    },
    []
  );

  const addUrls = useCallback((urls: string[]) => {
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
    setQueue((prev) => [...prev, ...items]);
    return items;
  }, []);

  const removeItem = useCallback((id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const updateItem = useCallback((id: string, updates: Partial<QueueItem>) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...updates } : item))
    );
  }, []);

  const cancelAll = useCallback(() => {
    cancelledRef.current = true;
    window.electronAPI.cancelUrlDownload();
    setQueue((prev) =>
      prev.map((item) =>
        item.status === "queued"
          ? { ...item, status: "error" as const, error: "Cancelled" }
          : item
      )
    );
  }, []);

  const clearQueue = useCallback(() => {
    setQueue([]);
    setIsProcessing(false);
    setCurrentItemId(null);
    processingRef.current = false;
    cancelledRef.current = false;
  }, []);

  const processQueue = useCallback(
    async (
      transcribeOpts: TranscribeOptions,
      diarizationOpts: DiarizationOptions
    ) => {
      if (processingRef.current) return;
      processingRef.current = true;
      cancelledRef.current = false;
      setIsProcessing(true);

      const processItem = async (item: QueueItem) => {
        setCurrentItemId(item.id);
        let filePath = item.path;
        let tempPath: string | undefined;

        try {
          if (item.source === "url" && item.url) {
            updateItem(item.id, { status: "downloading", progress: 0 });

            const cleanupProgress =
              window.electronAPI.onUrlDownloadProgress?.((data) => {
                updateItem(item.id, {
                  progress: data.percent,
                  name: data.title || item.name,
                });
              });

            try {
              const res = await window.electronAPI.downloadUrlAudio(item.url);
              if (!res.success) {
                const fail = res as { success: false; error: string };
                updateItem(item.id, { status: "error", error: fail.error });
                return;
              }
              filePath = res.tempPath;
              tempPath = res.tempPath;
              updateItem(item.id, {
                path: res.tempPath,
                tempPath: res.tempPath,
                name: res.title || item.name,
                sizeBytes: res.sizeBytes,
              });
            } finally {
              cleanupProgress?.();
            }
          }

          if (cancelledRef.current) return;

          updateItem(item.id, { status: "transcribing", progress: 0 });

          const transcribePromise = (async () => {
            if (transcribeOpts.isOpenWhisprCloud) {
              return window.electronAPI.transcribeAudioFileCloud!(filePath);
            } else if (transcribeOpts.useLocalWhisper) {
              return window.electronAPI.transcribeAudioFile(filePath, {
                provider: transcribeOpts.localTranscriptionProvider as
                  | "whisper"
                  | "nvidia",
                model:
                  transcribeOpts.localTranscriptionProvider === "nvidia"
                    ? transcribeOpts.parakeetModel
                    : transcribeOpts.whisperModel,
              });
            } else {
              const byokUseDiarize = diarizationOpts.enabled &&
                (transcribeOpts.cloudTranscriptionBaseUrl?.includes("openai.com") ||
                 transcribeOpts.cloudTranscriptionBaseUrl?.includes("mistral"));
              return window.electronAPI.transcribeAudioFileByok!({
                filePath,
                apiKey: transcribeOpts.getActiveApiKey(),
                baseUrl: transcribeOpts.cloudTranscriptionBaseUrl || "",
                model: transcribeOpts.cloudTranscriptionModel,
                diarize: byokUseDiarize || undefined,
              });
            }
          })();

          const skipLocalDiarize = !transcribeOpts.useLocalWhisper &&
            !transcribeOpts.isOpenWhisprCloud;

          const diarizePromise = diarizationOpts.enabled && filePath && !skipLocalDiarize
            ? window.electronAPI.diarizeAudioFile?.(filePath, {
                numSpeakers: diarizationOpts.numSpeakers ?? undefined,
              }).catch(() => null)
            : Promise.resolve(null);

          const [transcriptionResult, diarResult] = await Promise.all([
            transcribePromise,
            diarizePromise,
          ]);

          if (!transcriptionResult.success || !transcriptionResult.text) {
            updateItem(item.id, {
              status: "error",
              error: transcriptionResult.error || "Transcription failed",
            });
            return;
          }

          let finalText = transcriptionResult.text;

          if ((transcriptionResult as any).diarized) {
            // Cloud diarization already applied, skip local
          } else if (
            diarResult?.success &&
            diarResult.segments &&
            diarResult.segments.length > 0
          ) {
            try {
              const { mergeSpeakersWithText, formatSpeakerTranscript } =
                await import("../helpers/speakerMerge.js");
              const duration =
                diarResult.segments[diarResult.segments.length - 1]?.end || 0;
              const merged = mergeSpeakersWithText(
                diarResult.segments,
                finalText,
                duration
              );
              finalText = formatSpeakerTranscript(merged);
            } catch {
              // Merge failed, save without speaker labels
            }
          }

          const noteRes = await window.electronAPI.saveNote(
            item.name,
            finalText,
            "upload",
            item.name,
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
            updateItem(item.id, { status: "error", error: "Failed to save note" });
          }
        } catch (err) {
          updateItem(item.id, {
            status: "error",
            error: err instanceof Error ? err.message : "Unknown error",
          });
        } finally {
          if (tempPath) {
            window.electronAPI.deleteTempFile(tempPath);
          }
        }
      };

      const snapshot = [...queueRef.current];

      for (const item of snapshot) {
        if (cancelledRef.current) break;
        if (item.status !== "queued") continue;
        await processItem(item);
      }

      setCurrentItemId(null);
      setIsProcessing(false);
      processingRef.current = false;
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
  const totalCount = queue.length;
  const hasQueue = queue.length > 0;

  return {
    queue,
    isProcessing,
    currentItemId,
    hasQueue,
    completedCount,
    totalCount,
    addFiles,
    addUrls,
    removeItem,
    cancelAll,
    clearQueue,
    processQueue,
  };
}
