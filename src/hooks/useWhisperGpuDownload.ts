import { useCallback, useEffect, useState } from "react";
import type { DownloadProgress } from "./useModelDownload";
import type { CudaWhisperStatus, VulkanWhisperStatus } from "../types/electron";
import logger from "../utils/logger";

type WhisperGpuBackend = "cuda" | "vulkan";

interface WhisperGpuSelection {
  backend: WhisperGpuBackend;
  status: CudaWhisperStatus | VulkanWhisperStatus;
}

interface WhisperGpuActionResult {
  success: boolean;
  willRestart?: boolean;
  error?: string;
}

const EMPTY_PROGRESS: DownloadProgress = {
  downloadedBytes: 0,
  totalBytes: 0,
  percentage: 0,
};

const RECOVERY_POLL_INTERVAL_MS = 1000;

function selectWhisperGpuStatus(
  cuda: CudaWhisperStatus | undefined,
  vulkan: VulkanWhisperStatus | undefined
): WhisperGpuSelection | null {
  // An in-flight operation is authoritative. Hardware preference only decides
  // which idle pack to offer, never which active download the UI should track.
  if (cuda?.downloading) return { backend: "cuda", status: cuda };
  if (vulkan?.downloading) return { backend: "vulkan", status: vulkan };

  const cudaEligible = !!cuda?.gpuInfo.hasNvidiaGpu && !!cuda.gpuInfo.cudaSupported;
  if (cudaEligible && (cuda.downloaded || !vulkan?.downloaded)) {
    return { backend: "cuda", status: cuda };
  }
  if (vulkan?.vulkan.available) return { backend: "vulkan", status: vulkan };
  return null;
}

/**
 * Keeps the renderer's GPU download state aligned with the main-process
 * manager, including when the model picker remounts during an active download.
 */
export function useWhisperGpuDownload(enabled: boolean) {
  const [gpuBackend, setGpuBackend] = useState<WhisperGpuBackend | null>(null);
  const [gpuDownloaded, setGpuDownloaded] = useState(false);
  const [gpuDownloading, setGpuDownloading] = useState(false);
  const [gpuProgress, setGpuProgress] = useState<DownloadProgress>(EMPTY_PROGRESS);
  const [gpuFailed, setGpuFailed] = useState(false);
  const [recoveringDownload, setRecoveringDownload] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const detect = async () => {
      try {
        const [cuda, vulkan] = await Promise.all([
          window.electronAPI?.getCudaWhisperStatus?.(),
          window.electronAPI?.getVulkanWhisperStatus?.(),
        ]);
        if (cancelled) return;

        const selection = selectWhisperGpuStatus(cuda, vulkan);
        if (!selection) return;

        const { backend, status } = selection;
        setGpuBackend(backend);
        setGpuDownloaded(status.downloaded);
        setGpuDownloading(status.downloading);
        setRecoveringDownload(status.downloading);
        setGpuProgress(status.progress ?? EMPTY_PROGRESS);
        setGpuFailed(!!status.gpuFailed);
      } catch (error) {
        logger.error("Failed to detect Whisper GPU download status", { error }, "gpu");
      }
    };
    detect();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !gpuDownloading || !gpuBackend) return;
    const subscribe =
      gpuBackend === "cuda"
        ? window.electronAPI?.onCudaDownloadProgress
        : window.electronAPI?.onVulkanWhisperDownloadProgress;
    return subscribe?.((data) => setGpuProgress(data));
  }, [enabled, gpuDownloading, gpuBackend]);

  useEffect(() => {
    if (!enabled || !recoveringDownload || !gpuBackend) return;

    let cancelled = false;
    let checking = false;
    let recoveryErrorLogged = false;
    const reconcile = async () => {
      if (checking) return;
      checking = true;
      try {
        const status =
          gpuBackend === "cuda"
            ? await window.electronAPI?.getCudaWhisperStatus?.()
            : await window.electronAPI?.getVulkanWhisperStatus?.();
        if (cancelled || !status) return;
        recoveryErrorLogged = false;
        if (status.downloading) {
          if (status.progress) setGpuProgress(status.progress);
          return;
        }

        setGpuDownloaded(status.downloaded);
        setGpuFailed(!!status.gpuFailed);
        setGpuDownloading(false);
        setRecoveringDownload(false);
      } catch (error) {
        if (!cancelled && !recoveryErrorLogged) {
          recoveryErrorLogged = true;
          logger.warn("Failed to reconcile Whisper GPU download status", { error }, "gpu");
        }
      } finally {
        checking = false;
      }
    };

    const interval = window.setInterval(reconcile, RECOVERY_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled, gpuBackend, recoveringDownload]);

  const downloadGpu = useCallback(async (): Promise<WhisperGpuActionResult> => {
    if (!gpuBackend) return { success: false, error: "No GPU backend available" };

    setRecoveringDownload(false);
    setGpuDownloading(true);
    setGpuProgress(EMPTY_PROGRESS);
    try {
      const result =
        gpuBackend === "cuda"
          ? await window.electronAPI?.downloadCudaWhisperBinary?.()
          : await window.electronAPI?.downloadVulkanWhisperBinary?.();
      const normalized = result ?? { success: false, error: "GPU download is unavailable" };
      if (normalized.success) {
        setGpuDownloaded(true);
        setGpuFailed(false);
      }
      return normalized;
    } catch (error) {
      logger.error("Failed to download Whisper GPU package", { backend: gpuBackend, error }, "gpu");
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      setGpuDownloading(false);
    }
  }, [gpuBackend]);

  const cancelGpuDownload = useCallback(async (): Promise<boolean> => {
    if (!gpuBackend) return false;
    try {
      const result =
        gpuBackend === "cuda"
          ? await window.electronAPI?.cancelCudaWhisperDownload?.()
          : await window.electronAPI?.cancelVulkanWhisperDownload?.();
      return !!result?.success;
    } catch (error) {
      logger.error("Failed to cancel Whisper GPU download", { backend: gpuBackend, error }, "gpu");
      return false;
    } finally {
      setRecoveringDownload(false);
      setGpuDownloading(false);
      setGpuProgress(EMPTY_PROGRESS);
    }
  }, [gpuBackend]);

  const deleteGpu = useCallback(async (): Promise<boolean> => {
    if (!gpuBackend) return false;
    try {
      const result =
        gpuBackend === "cuda"
          ? await window.electronAPI?.deleteCudaWhisperBinary?.()
          : await window.electronAPI?.deleteVulkanWhisperBinary?.();
      if (!result?.success) return false;
      setGpuDownloaded(false);
      setGpuFailed(false);
      setGpuProgress(EMPTY_PROGRESS);
      return true;
    } catch (error) {
      logger.error("Failed to delete Whisper GPU package", { backend: gpuBackend, error }, "gpu");
      return false;
    }
  }, [gpuBackend]);

  const retryGpu = useCallback(async (): Promise<WhisperGpuActionResult> => {
    try {
      const result = await window.electronAPI?.whisperGpuRetry?.();
      const normalized = result ?? { success: false, error: "GPU retry is unavailable" };
      if (normalized.success) setGpuFailed(false);
      return normalized;
    } catch (error) {
      logger.error("Failed to retry Whisper GPU activation", { error }, "gpu");
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, []);

  const markGpuFailed = useCallback(() => setGpuFailed(true), []);

  return {
    gpuBackend,
    gpuDownloaded,
    gpuDownloading,
    gpuProgress,
    gpuFailed,
    downloadGpu,
    cancelGpuDownload,
    deleteGpu,
    retryGpu,
    markGpuFailed,
  };
}
