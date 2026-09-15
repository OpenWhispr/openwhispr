import { useCallback, useEffect, useState } from "react";
import type { DownloadProgress } from "./useModelDownload";

type WhisperGpuBackend = "cuda" | "vulkan";

const EMPTY_PROGRESS: DownloadProgress = {
  downloadedBytes: 0,
  totalBytes: 0,
  percentage: 0,
};

const RECOVERY_POLL_INTERVAL_MS = 1000;

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

        // Cards below the CUDA build's kernel floor (e.g. Maxwell) crash at the
        // first kernel launch, so they get the Vulkan pack like AMD/Intel GPUs.
        const cudaEligible = !!cuda?.gpuInfo.hasNvidiaGpu && !!cuda.gpuInfo.cudaSupported;
        // Prefer the pack that's already installed: a working Vulkan setup must
        // not be re-prompted to download the CUDA pack (matches the resolver,
        // which only prefers CUDA when it is actually downloaded).
        if (cudaEligible && (cuda.downloaded || !vulkan?.downloaded)) {
          setGpuBackend("cuda");
          setGpuDownloaded(cuda.downloaded);
          setGpuDownloading(!!cuda.downloading);
          setRecoveringDownload(!!cuda.downloading);
          setGpuFailed(!!cuda.gpuFailed);
        } else if (vulkan?.vulkan.available) {
          setGpuBackend("vulkan");
          setGpuDownloaded(vulkan.downloaded);
          setGpuDownloading(!!vulkan.downloading);
          setRecoveringDownload(!!vulkan.downloading);
          setGpuFailed(!!vulkan.gpuFailed);
        }
      } catch {}
    };
    detect();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!gpuDownloading || !gpuBackend) return;
    const subscribe =
      gpuBackend === "cuda"
        ? window.electronAPI?.onCudaDownloadProgress
        : window.electronAPI?.onVulkanWhisperDownloadProgress;
    return subscribe?.((data) => setGpuProgress(data));
  }, [gpuDownloading, gpuBackend]);

  useEffect(() => {
    if (!recoveringDownload || !gpuBackend) return;

    let cancelled = false;
    let checking = false;
    const reconcile = async () => {
      if (checking) return;
      checking = true;
      try {
        const status =
          gpuBackend === "cuda"
            ? await window.electronAPI?.getCudaWhisperStatus?.()
            : await window.electronAPI?.getVulkanWhisperStatus?.();
        if (cancelled || !status || status.downloading) return;

        setGpuDownloaded(status.downloaded);
        setGpuFailed(!!status.gpuFailed);
        setGpuDownloading(false);
        setRecoveringDownload(false);
      } catch {
      } finally {
        checking = false;
      }
    };

    const interval = window.setInterval(reconcile, RECOVERY_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [gpuBackend, recoveringDownload]);

  const startGpuDownload = useCallback(() => {
    setRecoveringDownload(false);
    setGpuDownloading(true);
  }, []);

  const finishGpuDownload = useCallback(() => {
    setRecoveringDownload(false);
    setGpuDownloading(false);
  }, []);

  return {
    gpuBackend,
    gpuDownloaded,
    gpuDownloading,
    gpuProgress,
    gpuFailed,
    setGpuDownloaded,
    setGpuFailed,
    startGpuDownload,
    finishGpuDownload,
  };
}
