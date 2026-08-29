import { useState, useCallback, useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useDialogs } from "./useDialogs";
import { useToast } from "../components/ui/useToast";
import type {
  LocalLLMDownloadProgressEvent,
  LocalModelDownloadStatus,
  WhisperDownloadProgressData,
} from "../types/electron";
import { clearMissingLocalModelSelections } from "../stores/settingsStore";
import "../types/electron";

const PROGRESS_THROTTLE_MS = 100;

/**
 * Fired on this window whenever a local model lands on or leaves the disk
 * (download complete, model deleted), so surfaces that mirror disk truth
 * without owning the download — e.g. useRequiredLocalModels — can re-check.
 */
export const LOCAL_MODELS_CHANGED_EVENT = "openwhispr-local-models-changed";

function notifyLocalModelsChanged(): void {
  window.dispatchEvent(new Event(LOCAL_MODELS_CHANGED_EVENT));
}

export interface DownloadProgress {
  percentage: number;
  downloadedBytes: number;
  totalBytes: number;
  speed?: number;
  eta?: number;
}

export type ModelType = "whisper" | "llm" | "parakeet";

interface UseModelDownloadOptions {
  modelType: ModelType;
  onDownloadComplete?: () => void;
  onModelsCleared?: () => void;
}

type LLMDownloadProgressData = LocalLLMDownloadProgressEvent & { sequence?: number };

export function formatETA(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function getDownloadErrorMessage(t: TFunction, error: string, code?: string): string {
  if (code === "EXTRACTION_FAILED" || error.includes("installation failed")) {
    return t("hooks.modelDownload.errors.extractionFailed");
  }
  if (code === "TLS_ERROR" || error.includes("certificate") || error.includes("issuer")) {
    return t("hooks.modelDownload.errors.tlsError");
  }
  if (code === "ETIMEDOUT" || error.includes("timeout") || error.includes("stalled")) {
    return t("hooks.modelDownload.errors.timeout");
  }
  if (code === "ENOTFOUND" || error.includes("ENOTFOUND")) {
    return t("hooks.modelDownload.errors.notFound");
  }
  if (error.includes("disk space")) return error;
  if (error.includes("corrupted") || error.includes("incomplete") || error.includes("too small")) {
    return t("hooks.modelDownload.errors.corrupted");
  }
  if (error.includes("HTTP 429") || error.includes("rate limit")) {
    return t("hooks.modelDownload.errors.rateLimited");
  }
  if (error.includes("HTTP 4") || error.includes("HTTP 5")) {
    return t("hooks.modelDownload.errors.server", { error });
  }
  return t("hooks.modelDownload.errors.generic", { error });
}

function isCancellation(error?: string, code?: string) {
  return (
    code === "DOWNLOAD_CANCELLED" ||
    error?.includes("interrupted by user") ||
    error?.includes("cancelled by user") ||
    error?.includes("Download cancelled")
  );
}

export function useModelDownload({
  modelType,
  onDownloadComplete,
  onModelsCleared,
}: UseModelDownloadOptions) {
  const { t } = useTranslation();
  const { showAlertDialog } = useDialogs();
  const { toast } = useToast();
  const [downloads, setDownloads] = useState<Record<string, LocalModelDownloadStatus>>({});
  const [cancellingModels, setCancellingModels] = useState<Set<string>>(new Set());
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
  const ownedRequestsRef = useRef(new Set<string>());
  const settlingDownloadsRef = useRef(new Set<string>());
  const terminalSequencesRef = useRef<Record<string, number>>({});
  const lastProgressUpdateRef = useRef<Record<string, number>>({});
  const onDownloadCompleteRef = useRef(onDownloadComplete);
  const onModelsClearedRef = useRef(onModelsCleared);

  useEffect(() => {
    onDownloadCompleteRef.current = onDownloadComplete;
  }, [onDownloadComplete]);

  useEffect(() => {
    onModelsClearedRef.current = onModelsCleared;
  }, [onModelsCleared]);

  useEffect(() => {
    const handleModelsCleared = () => onModelsClearedRef.current?.();
    window.addEventListener("openwhispr-models-cleared", handleModelsCleared);
    return () => window.removeEventListener("openwhispr-models-cleared", handleModelsCleared);
  }, []);

  const updateDownload = useCallback(
    (status: LocalModelDownloadStatus) => {
      if (status.modelType !== modelType) return;
      setDownloads((current) => {
        const terminalSequence = terminalSequencesRef.current[status.modelId] || 0;
        if (status.sequence !== 0 && status.sequence <= terminalSequence) return current;
        const existing = current[status.modelId];
        if (existing && existing.sequence > status.sequence) return current;
        return { ...current, [status.modelId]: status };
      });
    },
    [modelType]
  );

  const removeDownload = useCallback((modelId: string, sequence?: number) => {
    setDownloads((current) => {
      const existing = current[modelId];
      if (!existing || (sequence !== undefined && existing.sequence > sequence)) return current;
      const { [modelId]: _removed, ...remaining } = current;
      return remaining;
    });
  }, []);

  const clearCancelling = useCallback((modelId: string) => {
    setCancellingModels((current) => {
      if (!current.has(modelId)) return current;
      const next = new Set(current);
      next.delete(modelId);
      return next;
    });
  }, []);

  const settleDownload = useCallback(
    async (modelId: string, sequence?: number) => {
      if (settlingDownloadsRef.current.has(modelId)) return;
      settlingDownloadsRef.current.add(modelId);
      try {
        await onDownloadCompleteRef.current?.();
      } catch {
        // The model is already on disk even if the UI refresh fails.
      } finally {
        removeDownload(modelId, sequence);
        clearCancelling(modelId);
        settlingDownloadsRef.current.delete(modelId);
      }
    },
    [clearCancelling, removeDownload]
  );

  const handleTerminalDownload = useCallback(
    (
      modelId: string,
      type: "complete" | "error",
      error?: string,
      code?: string,
      sequence?: number
    ) => {
      if (sequence !== undefined) {
        terminalSequencesRef.current[modelId] = Math.max(
          terminalSequencesRef.current[modelId] || 0,
          sequence
        );
      }
      if (ownedRequestsRef.current.has(modelId)) return;
      if (type === "complete") notifyLocalModelsChanged();
      if (type === "error" && !isCancellation(error, code)) {
        const message = getDownloadErrorMessage(
          t,
          error || t("hooks.modelDownload.errors.unknown"),
          code
        );
        setDownloadErrors((current) => ({ ...current, [modelId]: message }));
        showAlertDialog({
          title:
            code === "EXTRACTION_FAILED"
              ? t("hooks.modelDownload.installationFailed.title")
              : t("hooks.modelDownload.downloadFailed.title"),
          description: message,
        });
      }
      void settleDownload(modelId, sequence);
    },
    [settleDownload, showAlertDialog, t]
  );

  const handleNativeProgress = useCallback(
    (data: WhisperDownloadProgressData) => {
      if (data.type === "complete" || data.type === "error") {
        handleTerminalDownload(data.model, data.type, data.error, data.code, data.sequence);
        return;
      }
      if (data.type !== "progress" && data.type !== "installing") return;

      const isInstalling = data.type === "installing";
      if (!isInstalling) {
        const now = Date.now();
        const lastUpdate = lastProgressUpdateRef.current[data.model] || 0;
        if (now - lastUpdate < PROGRESS_THROTTLE_MS) return;
        lastProgressUpdateRef.current[data.model] = now;
      }
      updateDownload({
        modelType,
        modelId: data.model,
        phase: isInstalling ? "installing" : "downloading",
        progress: isInstalling ? data.percentage || 100 : data.percentage || 0,
        downloadedBytes: isInstalling ? 0 : data.downloaded_bytes || 0,
        totalBytes: isInstalling ? 0 : data.total_bytes || 0,
        sequence: data.sequence || 0,
      });
    },
    [handleTerminalDownload, modelType, updateDownload]
  );

  const handleLLMProgress = useCallback(
    (_event: unknown, data: LLMDownloadProgressData) => {
      if (data.type === "complete") {
        handleTerminalDownload(data.modelId, data.type, undefined, undefined, data.sequence);
        return;
      }
      if (data.type === "error") {
        handleTerminalDownload(data.modelId, data.type, data.error, data.code, data.sequence);
        return;
      }
      const now = Date.now();
      const lastUpdate = lastProgressUpdateRef.current[data.modelId] || 0;
      if ((data.progress || 0) < 100 && now - lastUpdate < PROGRESS_THROTTLE_MS) return;
      lastProgressUpdateRef.current[data.modelId] = now;
      updateDownload({
        modelType: "llm",
        modelId: data.modelId,
        phase: "downloading",
        progress: data.progress || 0,
        downloadedBytes: data.downloadedSize || 0,
        totalBytes: data.totalSize || 0,
        sequence: data.sequence || 0,
      });
    },
    [handleTerminalDownload, updateDownload]
  );

  useEffect(() => {
    const dispose =
      modelType === "whisper"
        ? window.electronAPI?.onWhisperDownloadProgress((_event, data) =>
            handleNativeProgress(data)
          )
        : modelType === "parakeet"
          ? window.electronAPI?.onParakeetDownloadProgress((_event, data) =>
              handleNativeProgress(data)
            )
          : window.electronAPI?.onModelDownloadProgress(handleLLMProgress);
    return () => dispose?.();
  }, [handleLLMProgress, handleNativeProgress, modelType]);

  useEffect(() => {
    let disposed = false;
    window.electronAPI
      ?.modelGetActiveDownloads?.()
      .then((activeDownloads) => {
        if (!disposed) activeDownloads.forEach(updateDownload);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [updateDownload]);

  const downloadModel = useCallback(
    async (modelId: string, onSelectAfterDownload?: (id: string) => void) => {
      if (downloads[modelId] || (modelType !== "llm" && Object.keys(downloads).length > 0)) {
        toast({
          title: t("hooks.modelDownload.downloadInProgress.title"),
          description: t("hooks.modelDownload.downloadInProgress.description"),
        });
        return;
      }

      ownedRequestsRef.current.add(modelId);
      setDownloadErrors((current) => {
        if (!(modelId in current)) return current;
        const { [modelId]: _removed, ...remaining } = current;
        return remaining;
      });
      updateDownload({
        modelType,
        modelId,
        phase: "downloading",
        progress: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        sequence: 0,
      });
      lastProgressUpdateRef.current[modelId] = 0;

      let keepActiveDownloadState = false;

      try {
        const result =
          modelType === "whisper"
            ? await window.electronAPI?.downloadWhisperModel(modelId)
            : modelType === "parakeet"
              ? await window.electronAPI?.downloadParakeetModel(modelId)
              : await window.electronAPI?.modelDownload?.(modelId);

        if (result?.success) {
          notifyLocalModelsChanged();
          onSelectAfterDownload?.(modelId);
        } else if (result?.code === "DOWNLOAD_IN_PROGRESS") {
          const activeDownloads = await window.electronAPI?.modelGetActiveDownloads?.();
          const activeDownload = activeDownloads?.find(
            (status) => status.modelType === modelType && status.modelId === modelId
          );
          if (activeDownload) {
            updateDownload(activeDownload);
            keepActiveDownloadState = true;
          }
          toast({
            title: t("hooks.modelDownload.downloadInProgress.title"),
            description: t("hooks.modelDownload.downloadInProgress.description"),
          });
        } else if (!isCancellation(result?.error, result?.code)) {
          const message = getDownloadErrorMessage(
            t,
            result?.error || t("hooks.modelDownload.errors.unknown"),
            result?.code
          );
          setDownloadErrors((current) => ({ ...current, [modelId]: message }));
          showAlertDialog({
            title:
              result?.code === "EXTRACTION_FAILED"
                ? t("hooks.modelDownload.installationFailed.title")
                : t("hooks.modelDownload.downloadFailed.title"),
            description: message,
          });
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!isCancellation(errorMessage)) {
          const message = getDownloadErrorMessage(t, errorMessage);
          setDownloadErrors((current) => ({ ...current, [modelId]: message }));
          showAlertDialog({
            title: t("hooks.modelDownload.downloadFailed.title"),
            description: message,
          });
        }
      } finally {
        ownedRequestsRef.current.delete(modelId);
        if (!keepActiveDownloadState) {
          await settleDownload(modelId);
        }
      }
    },
    [downloads, modelType, settleDownload, showAlertDialog, t, toast, updateDownload]
  );

  const deleteModel = useCallback(
    async (modelId: string, onComplete?: () => void) => {
      try {
        if (modelType === "whisper") {
          const result = await window.electronAPI?.deleteWhisperModel(modelId);
          if (result?.success) {
            toast({
              title: t("hooks.modelDownload.modelDeleted.title"),
              description: t("hooks.modelDownload.modelDeleted.descriptionWithSpace", {
                sizeMb: result.freed_mb,
              }),
            });
          }
        } else if (modelType === "parakeet") {
          const result = await window.electronAPI?.deleteParakeetModel(modelId);
          if (result?.success) {
            toast({
              title: t("hooks.modelDownload.modelDeleted.title"),
              description: t("hooks.modelDownload.modelDeleted.descriptionWithSpace", {
                sizeMb: result.freed_mb,
              }),
            });
          }
        } else {
          // model-delete reports failure by resolving, not throwing — leaving the
          // model on disk, so the scopes pointing at it must stay untouched.
          const result = await window.electronAPI?.modelDelete?.(modelId);
          if (!result?.success) throw new Error(result?.error ?? "");
          clearMissingLocalModelSelections((id) => id !== modelId);
          toast({
            title: t("hooks.modelDownload.modelDeleted.title"),
            description: t("hooks.modelDownload.modelDeleted.description"),
          });
        }
        notifyLocalModelsChanged();
        onComplete?.();
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showAlertDialog({
          title: t("hooks.modelDownload.deleteFailed.title"),
          description: t("hooks.modelDownload.deleteFailed.description", { error: errorMessage }),
        });
      }
    },
    [modelType, showAlertDialog, t, toast]
  );

  const cancelDownload = useCallback(
    async (modelId?: string) => {
      const targetModel = modelId || Object.keys(downloads)[0];
      if (!targetModel || cancellingModels.has(targetModel)) return;
      if (downloads[targetModel]?.phase === "installing") return;

      setCancellingModels((current) => new Set(current).add(targetModel));
      try {
        const result =
          modelType === "whisper"
            ? await window.electronAPI?.cancelWhisperDownload()
            : modelType === "parakeet"
              ? await window.electronAPI?.cancelParakeetDownload()
              : await window.electronAPI?.modelCancelDownload?.(targetModel);
        if (result?.success) {
          toast({
            title: t("hooks.modelDownload.downloadCancelled.title"),
            description: t("hooks.modelDownload.downloadCancelled.description"),
          });
          return;
        }
      } catch (error) {
        console.error("Failed to cancel download:", error);
      }
      clearCancelling(targetModel);
    },
    [cancellingModels, clearCancelling, downloads, modelType, t, toast]
  );

  const downloadingModel = Object.keys(downloads)[0] || null;
  const activeDownload = downloadingModel ? downloads[downloadingModel] : null;
  const errorMessages = Object.values(downloadErrors);

  return {
    downloads,
    downloadErrors,
    downloadingModel,
    downloadProgress: {
      percentage: activeDownload?.progress || 0,
      downloadedBytes: activeDownload?.downloadedBytes || 0,
      totalBytes: activeDownload?.totalBytes || 0,
    },
    downloadError: errorMessages[errorMessages.length - 1] || null,
    isDownloading: downloadingModel !== null,
    isInstalling: activeDownload?.phase === "installing",
    isCancelling: downloadingModel ? cancellingModels.has(downloadingModel) : false,
    isDownloadingModel: (modelId: string) => !!downloads[modelId],
    isCancellingModel: (modelId: string) => cancellingModels.has(modelId),
    downloadModel,
    deleteModel,
    cancelDownload,
    formatETA,
  };
}
