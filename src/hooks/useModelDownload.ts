import { useState, useCallback, useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useDialogs } from "./useDialogs";
import { useToast } from "../components/ui/useToast";
import type { WhisperDownloadProgressData } from "../types/electron";
import "../types/electron";

const PROGRESS_THROTTLE_MS = 100;

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

interface LLMDownloadProgressData {
  modelId: string;
  progress: number;
  downloadedSize: number;
  totalSize: number;
}

export function formatETA(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function getDownloadErrorMessage(t: TFunction, error: string, code?: string): string {
  if (code === "EXTRACTION_FAILED" || error.includes("installation failed"))
    return t("hooks.modelDownload.errors.extractionFailed");
  if (code === "TLS_ERROR" || error.includes("certificate") || error.includes("issuer"))
    return t("hooks.modelDownload.errors.tlsError");
  if (code === "ETIMEDOUT" || error.includes("timeout") || error.includes("stalled"))
    return t("hooks.modelDownload.errors.timeout");
  if (code === "ENOTFOUND" || error.includes("ENOTFOUND"))
    return t("hooks.modelDownload.errors.notFound");
  if (error.includes("disk space")) return error;
  if (error.includes("corrupted") || error.includes("incomplete") || error.includes("too small"))
    return t("hooks.modelDownload.errors.corrupted");
  if (error.includes("HTTP 429") || error.includes("rate limit"))
    return t("hooks.modelDownload.errors.rateLimited");
  if (error.includes("HTTP 4") || error.includes("HTTP 5"))
    return t("hooks.modelDownload.errors.server", { error });
  return t("hooks.modelDownload.errors.generic", { error });
}

// ---------------------------------------------------------------------------
// Module-level persistent download state.
// IPC listeners register once and keep updating this cache regardless of
// whether a React component is mounted. When a hook mounts it reads from
// here, so progress survives full section navigation (not just tab switches).
// ---------------------------------------------------------------------------

interface PersistentEntry {
  modelId: string | null;
  progress: DownloadProgress;
  installing: boolean;
  cancelling: boolean;
  pendingError: { error: string; code?: string } | null;
}

const ZERO_PROGRESS: DownloadProgress = { percentage: 0, downloadedBytes: 0, totalBytes: 0 };

const persistentState: Record<ModelType, PersistentEntry> = {
  whisper: { modelId: null, progress: { ...ZERO_PROGRESS }, installing: false, cancelling: false, pendingError: null },
  parakeet: { modelId: null, progress: { ...ZERO_PROGRESS }, installing: false, cancelling: false, pendingError: null },
  llm: { modelId: null, progress: { ...ZERO_PROGRESS }, installing: false, cancelling: false, pendingError: null },
};

type UpdateCallback = (entry: PersistentEntry) => void;
const activeCallbacks = new Map<ModelType, UpdateCallback>();
let listenersReady = false;

function ensurePersistentListeners() {
  if (listenersReady || typeof window === "undefined" || !window.electronAPI) return;
  listenersReady = true;

  const throttle: Record<string, number> = {};

  function onWhisperLike(type: ModelType, _e: unknown, data: WhisperDownloadProgressData) {
    const entry = persistentState[type];
    if (entry.cancelling) return;

    if (data.type === "progress") {
      const now = Date.now();
      if (now - (throttle[type] || 0) < PROGRESS_THROTTLE_MS) return;
      throttle[type] = now;
      entry.progress = {
        percentage: data.percentage || 0,
        downloadedBytes: data.downloaded_bytes || 0,
        totalBytes: data.total_bytes || 0,
      };
    } else if (data.type === "installing") {
      entry.installing = true;
    } else if (data.type === "complete") {
      entry.installing = false;
    } else if (data.type === "error") {
      entry.pendingError = { error: data.error || "Unknown error", code: data.code };
      entry.installing = false;
      entry.modelId = null;
      entry.progress = { ...ZERO_PROGRESS };
    }
    activeCallbacks.get(type)?.(entry);
  }

  window.electronAPI.onWhisperDownloadProgress(
    (e: unknown, d: WhisperDownloadProgressData) => onWhisperLike("whisper", e, d)
  );
  window.electronAPI.onParakeetDownloadProgress(
    (e: unknown, d: WhisperDownloadProgressData) => onWhisperLike("parakeet", e, d)
  );
  window.electronAPI.onModelDownloadProgress((_e: unknown, data: LLMDownloadProgressData) => {
    const entry = persistentState.llm;
    if (entry.cancelling) return;
    const now = Date.now();
    const isComplete = data.progress >= 100;
    if (!isComplete && now - (throttle.llm || 0) < PROGRESS_THROTTLE_MS) return;
    throttle.llm = now;
    entry.progress = {
      percentage: data.progress || 0,
      downloadedBytes: data.downloadedSize || 0,
      totalBytes: data.totalSize || 0,
    };
    activeCallbacks.get("llm")?.(entry);
  });
}

// ---------------------------------------------------------------------------

export function useModelDownload({
  modelType,
  onDownloadComplete,
  onModelsCleared,
}: UseModelDownloadOptions) {
  const { t } = useTranslation();
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress>({
    percentage: 0,
    downloadedBytes: 0,
    totalBytes: 0,
  });
  const [isCancelling, setIsCancelling] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const isCancellingRef = useRef(false);
  const lastProgressUpdateRef = useRef(0);

  const { showAlertDialog } = useDialogs();
  const { toast } = useToast();
  const showAlertDialogRef = useRef(showAlertDialog);
  const onDownloadCompleteRef = useRef(onDownloadComplete);
  const onModelsClearedRef = useRef(onModelsCleared);

  useEffect(() => {
    showAlertDialogRef.current = showAlertDialog;
  }, [showAlertDialog]);

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

  // Persistent IPC listeners + restore from cache on mount
  useEffect(() => {
    ensurePersistentListeners();

    // Restore progress from persistent cache (survives unmount/remount)
    const cached = persistentState[modelType];
    if (cached.modelId) {
      setDownloadingModel(cached.modelId);
      setDownloadProgress({ ...cached.progress });
      setIsInstalling(cached.installing);
    }

    // Register callback so the persistent listener can push updates
    activeCallbacks.set(modelType, (entry) => {
      if (isCancellingRef.current) return;
      setDownloadProgress({ ...entry.progress });
      setIsInstalling(entry.installing);
      if (!entry.modelId) {
        setDownloadingModel(null);
        setDownloadProgress({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });
      }
      if (entry.pendingError) {
        const err = entry.pendingError;
        entry.pendingError = null;
        const msg = getDownloadErrorMessage(
          t,
          err.error,
          err.code
        );
        const title = err.code === "EXTRACTION_FAILED"
          ? t("hooks.modelDownload.installationFailed.title")
          : t("hooks.modelDownload.downloadFailed.title");
        setDownloadError(msg);
        showAlertDialogRef.current({ title, description: msg });
      }
    });

    return () => {
      activeCallbacks.delete(modelType);
    };
  }, [modelType, t]);

  const downloadModel = useCallback(
    async (modelId: string, onSelectAfterDownload?: (id: string) => void) => {
      if (downloadingModel) {
        toast({
          title: t("hooks.modelDownload.downloadInProgress.title"),
          description: t("hooks.modelDownload.downloadInProgress.description"),
        });
        return;
      }

      try {
        setDownloadingModel(modelId);
        setDownloadError(null);
        setDownloadProgress({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });
        lastProgressUpdateRef.current = 0; // Reset throttle timer

        // Write to persistent cache so progress survives navigation
        const pe = persistentState[modelType];
        pe.modelId = modelId;
        pe.progress = { ...ZERO_PROGRESS };
        pe.installing = false;
        pe.pendingError = null;

        let success = false;

        if (modelType === "whisper") {
          const result = await window.electronAPI?.downloadWhisperModel(modelId);
          if (!result?.success && !result?.error?.includes("interrupted by user")) {
            const msg = getDownloadErrorMessage(
              t,
              result?.error || t("hooks.modelDownload.errors.unknown"),
              result?.code
            );
            setDownloadError(msg);
            showAlertDialog({
              title: t("hooks.modelDownload.downloadFailed.title"),
              description: msg,
            });
          } else {
            success = result?.success ?? false;
          }
        } else if (modelType === "parakeet") {
          const result = await window.electronAPI?.downloadParakeetModel(modelId);
          if (!result?.success && !result?.error?.includes("interrupted by user")) {
            const msg = getDownloadErrorMessage(
              t,
              result?.error || t("hooks.modelDownload.errors.unknown"),
              result?.code
            );
            const title =
              result?.code === "EXTRACTION_FAILED"
                ? t("hooks.modelDownload.installationFailed.title")
                : t("hooks.modelDownload.downloadFailed.title");
            setDownloadError(msg);
            showAlertDialog({ title, description: msg });
          } else {
            success = result?.success ?? false;
          }
        } else {
          const result = (await window.electronAPI?.modelDownload?.(modelId)) as unknown as
            | { success: boolean; error?: string; code?: string }
            | undefined;
          if (result && !result.success && result.error) {
            const msg = getDownloadErrorMessage(t, result.error, result.code);
            setDownloadError(msg);
            showAlertDialog({
              title: t("hooks.modelDownload.downloadFailed.title"),
              description: msg,
            });
          } else {
            success = result?.success ?? false;
          }
        }

        if (success) {
          onSelectAfterDownload?.(modelId);
        }

        // Await the refresh so the model list is updated before we clear
        // the downloading state in `finally`. This prevents a flash where
        // the model briefly appears "not downloaded".
        try {
          await onDownloadCompleteRef.current?.();
        } catch {
          // Non-fatal — the model is on disk regardless
        }
      } catch (error: unknown) {
        if (isCancellingRef.current) return;

        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          !errorMessage.includes("interrupted by user") &&
          !errorMessage.includes("cancelled by user") &&
          !errorMessage.includes("DOWNLOAD_CANCELLED")
        ) {
          const msg = getDownloadErrorMessage(t, errorMessage);
          setDownloadError(msg);
          showAlertDialog({
            title: t("hooks.modelDownload.downloadFailed.title"),
            description: msg,
          });
        }
      } finally {
        setIsInstalling(false);
        setDownloadingModel(null);
        setDownloadProgress({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });

        // Clear persistent cache
        const pe = persistentState[modelType];
        pe.modelId = null;
        pe.progress = { ...ZERO_PROGRESS };
        pe.installing = false;
      }
    },
    [downloadingModel, modelType, showAlertDialog, toast, t]
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
          await window.electronAPI?.modelDelete?.(modelId);
          toast({
            title: t("hooks.modelDownload.modelDeleted.title"),
            description: t("hooks.modelDownload.modelDeleted.description"),
          });
        }
        onComplete?.();
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showAlertDialog({
          title: t("hooks.modelDownload.deleteFailed.title"),
          description: t("hooks.modelDownload.deleteFailed.description", { error: errorMessage }),
        });
      }
    },
    [modelType, toast, showAlertDialog, t]
  );

  const cancelDownload = useCallback(async () => {
    if (!downloadingModel || isCancelling) return;

    setIsCancelling(true);
    isCancellingRef.current = true;
    persistentState[modelType].cancelling = true;
    try {
      if (modelType === "whisper") {
        await window.electronAPI?.cancelWhisperDownload();
      } else if (modelType === "parakeet") {
        await window.electronAPI?.cancelParakeetDownload();
      } else {
        await window.electronAPI?.modelCancelDownload?.(downloadingModel);
      }
      toast({
        title: t("hooks.modelDownload.downloadCancelled.title"),
        description: t("hooks.modelDownload.downloadCancelled.description"),
      });
    } catch (error) {
      console.error("Failed to cancel download:", error);
    } finally {
      setIsCancelling(false);
      isCancellingRef.current = false;
      setDownloadingModel(null);
      setDownloadProgress({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });

      const pe = persistentState[modelType];
      pe.cancelling = false;
      pe.modelId = null;
      pe.progress = { ...ZERO_PROGRESS };
      pe.installing = false;

      onDownloadCompleteRef.current?.();
    }
  }, [downloadingModel, isCancelling, modelType, toast, t]);

  const isDownloading = downloadingModel !== null;
  const isDownloadingModel = useCallback(
    (modelId: string) => downloadingModel === modelId,
    [downloadingModel]
  );

  return {
    downloadingModel,
    downloadProgress,
    downloadError,
    isDownloading,
    isDownloadingModel,
    isInstalling,
    isCancelling,
    downloadModel,
    deleteModel,
    cancelDownload,
    formatETA,
  };
}
