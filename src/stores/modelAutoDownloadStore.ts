import { create } from "zustand";

export interface AutoDownloadProgress {
  percentage: number;
  downloadedBytes: number;
  totalBytes: number;
}

interface ModelAutoDownloadState {
  /** Whether an auto-download is actively running */
  isActive: boolean;
  /** The model being downloaded */
  modelId: string | null;
  /** Human-readable model name */
  modelName: string | null;
  /** Approximate size in MB */
  sizeMb: number | null;
  /** Download progress */
  progress: AutoDownloadProgress;
  /** Whether download completed successfully */
  isComplete: boolean;
  /** Whether the user cancelled the download */
  isCancelled: boolean;
  /** Error message if download failed */
  error: string | null;
  /** Whether the banner has been dismissed */
  isDismissed: boolean;
}

export const useModelAutoDownloadStore = create<ModelAutoDownloadState>()(() => ({
  isActive: false,
  modelId: null,
  modelName: null,
  sizeMb: null,
  progress: { percentage: 0, downloadedBytes: 0, totalBytes: 0 },
  isComplete: false,
  isCancelled: false,
  error: null,
  isDismissed: false,
}));

const PROGRESS_THROTTLE_MS = 100;
let lastProgressUpdate = 0;

/**
 * Initialize IPC listeners for auto-download events.
 * Call once when the ControlPanel mounts.
 * Returns a cleanup function that unsubscribes all listeners.
 */
export function initAutoDownloadListeners(): () => void {
  const disposers: Array<(() => void) | undefined> = [];

  // Status events from main process
  const statusDispose = window.electronAPI?.onModelAutoDownloadStatus?.(
    (_event: unknown, data: { type: string; modelId: string; modelName?: string; sizeMb?: number; error?: string }) => {
      const store = useModelAutoDownloadStore;
      switch (data.type) {
        case "started":
          store.setState({
            isActive: true,
            modelId: data.modelId,
            modelName: data.modelName || null,
            sizeMb: data.sizeMb || null,
            progress: { percentage: 0, downloadedBytes: 0, totalBytes: 0 },
            isComplete: false,
            isCancelled: false,
            error: null,
            isDismissed: false,
          });
          break;
        case "complete":
          store.setState({ isActive: false, isComplete: true });
          break;
        case "cancelled":
          store.setState({ isActive: false, isCancelled: true });
          break;
        case "error":
          store.setState({ isActive: false, error: data.error || "Download failed" });
          break;
        case "not-needed":
          store.setState({ isActive: false, isComplete: true, isDismissed: true });
          break;
      }
    }
  );
  disposers.push(statusDispose);

  // Progress events on dedicated auto-download channel
  const progressDispose = window.electronAPI?.onModelAutoDownloadProgress?.(
    (_event: unknown, data: { type: string; percentage?: number; downloaded_bytes?: number; total_bytes?: number }) => {
      if (data.type !== "progress") return;
      const now = Date.now();
      if (now - lastProgressUpdate < PROGRESS_THROTTLE_MS) return;
      lastProgressUpdate = now;
      useModelAutoDownloadStore.setState({
        progress: {
          percentage: data.percentage || 0,
          downloadedBytes: data.downloaded_bytes || 0,
          totalBytes: data.total_bytes || 0,
        },
      });
    }
  );
  disposers.push(progressDispose);

  // Check if auto-download is already in progress (renderer loaded after it started)
  window.electronAPI?.getModelAutoDownloadStatus?.().then(
    (status: { active: boolean; modelId: string | null; modelName?: string | null; sizeMb?: number | null } | undefined) => {
      if (status?.active) {
        useModelAutoDownloadStore.setState({
          isActive: true,
          modelId: status.modelId,
          modelName: status.modelName || null,
          sizeMb: status.sizeMb || null,
          isDismissed: false,
        });
      }
    }
  );

  return () => {
    for (const d of disposers) d?.();
  };
}

export function dismissAutoDownloadBanner(): void {
  useModelAutoDownloadStore.setState({ isDismissed: true });
}

export async function cancelAutoDownload(): Promise<void> {
  await window.electronAPI?.cancelParakeetDownload?.();
}
