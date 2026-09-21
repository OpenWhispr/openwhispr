import { create } from 'zustand';
import * as FileSystem from 'expo-file-system/legacy';
import { LocalWhisperService } from '../services/transcription/LocalWhisperService';
import { LocalParakeetService } from '../services/transcription/LocalParakeetService';
import { LOCAL_MODEL_SIZE_BYTES, type LocalModelKey } from '../lib/localModelCatalog';
import { useConfigStore } from './useConfigStore';

export type { LocalModelKey } from '../lib/localModelCatalog';

// 'preparing' = Parakeet's post-download load, where CoreML's one-time ANE compile happens.
// It's part of the download flow on purpose so a dictation tap never pays that wait.
export type ModelDownloadStatus = 'idle' | 'downloading' | 'preparing' | 'completed' | 'error';

export interface ModelDownloadEntry {
  status: ModelDownloadStatus;
  progress: number;
  error?: string;
}

interface ModelDownloadState {
  downloads: Record<LocalModelKey, ModelDownloadEntry>;
  /** Monotonic counter of finished downloads — a change-signal for readiness refreshes. */
  completedCount: number;
  startDownload: (key?: LocalModelKey) => Promise<void>;
  cancelDownload: (key: LocalModelKey) => Promise<void>;
  reset: (key?: LocalModelKey) => void;
}

const idleEntry = (): ModelDownloadEntry => ({ status: 'idle', progress: 0, error: undefined });

const idleDownloads = (): Record<LocalModelKey, ModelDownloadEntry> => ({
  'whisper-base': idleEntry(),
  'parakeet-v2': idleEntry(),
  'parakeet-v3': idleEntry(),
});

// Downloads leave ~20% of the model size as headroom so finishing one doesn't wedge the device
// at 0 bytes free.
const FREE_SPACE_HEADROOM = 0.2;

export const useModelDownloadStore = create<ModelDownloadState>((set, get) => {
  const requestIds: Record<LocalModelKey, number> = {
    'whisper-base': 0,
    'parakeet-v2': 0,
    'parakeet-v3': 0,
  };

  const beginRequest = (key: LocalModelKey): number => {
    requestIds[key] += 1;
    return requestIds[key];
  };

  const isCurrentRequest = (key: LocalModelKey, requestId: number): boolean =>
    requestIds[key] === requestId;

  const patchEntry = (
    key: LocalModelKey,
    entry: Partial<ModelDownloadEntry>,
    requestId?: number,
  ): void => {
    if (requestId !== undefined && !isCurrentRequest(key, requestId)) return;
    set((state) => ({
      downloads: { ...state.downloads, [key]: { ...state.downloads[key], ...entry } },
    }));
  };

  const markCompleted = (key: LocalModelKey, requestId: number): void => {
    if (!isCurrentRequest(key, requestId)) return;
    set((state) => ({
      completedCount: state.completedCount + 1,
      downloads: {
        ...state.downloads,
        [key]: { status: 'completed', progress: 1, error: undefined },
      },
    }));
    if (key !== 'whisper-base') {
      // A completed Parakeet download permanently satisfies the "faster model available"
      // nudge — even if the model is later deleted to free space.
      useConfigStore
        .getState()
        .updateConfig({ parakeetUpgradeNudgeDismissedAt: new Date().toISOString() })
        .catch(() => undefined);
    }
  };

  const downloadWhisper = async (key: LocalModelKey, requestId: number): Promise<void> => {
    if (!LocalWhisperService.isAvailable()) {
      patchEntry(
        key,
        {
          status: 'error',
          error:
            'Local Whisper is not available. Build the app with `npx expo run:ios` to enable private mode.',
        },
        requestId,
      );
      return;
    }
    patchEntry(key, { status: 'downloading', progress: 0, error: undefined }, requestId);
    try {
      await LocalWhisperService.downloadModel('base', (progress) =>
        patchEntry(key, { progress }, requestId),
      );
      markCompleted(key, requestId);
    } catch (error) {
      patchEntry(key, { status: 'error', error: (error as Error).message }, requestId);
    }
  };

  const downloadParakeet = async (
    key: LocalModelKey,
    version: 'v2' | 'v3',
    requestId: number,
  ): Promise<void> => {
    if (!LocalParakeetService.isAvailable()) {
      patchEntry(
        key,
        {
          status: 'error',
          error: 'Parakeet needs a native iOS build. Run the app with `npx expo run:ios`.',
        },
        requestId,
      );
      return;
    }
    patchEntry(key, { status: 'downloading', progress: 0, error: undefined }, requestId);
    try {
      const nominalBytes = LOCAL_MODEL_SIZE_BYTES[key];
      // Files a previous attempt already staged are reused, so only the rest still needs room.
      // Demanding the full model size again after one interrupted attempt (up to ~445 MB staged)
      // would lock a phone with, say, 600 MB free out of ever finishing.
      const stagedBytes = await LocalParakeetService.stagedDownloadBytes(version).catch(() => 0);
      const requiredBytes =
        Math.max(nominalBytes - stagedBytes, 0) + nominalBytes * FREE_SPACE_HEADROOM;
      const freeBytes = await FileSystem.getFreeDiskStorageAsync().catch(() => null);
      // A cancel that landed during those reads must not be followed by a 445 MB transfer plus
      // prepare() running behind an idle row.
      if (!isCurrentRequest(key, requestId)) return;
      if (freeBytes !== null && freeBytes < requiredBytes) {
        const requiredMb = Math.round(requiredBytes / (1024 * 1024));
        patchEntry(
          key,
          {
            status: 'error',
            error: `Not enough free space — this model needs about ${requiredMb} MB. Free up storage and try again.`,
          },
          requestId,
        );
        return;
      }

      await LocalParakeetService.downloadModel(version, (progress) =>
        patchEntry(key, { progress }, requestId),
      );
      patchEntry(key, { status: 'preparing', progress: 1 }, requestId);
      await LocalParakeetService.prepare(version);
      markCompleted(key, requestId);
    } catch (error) {
      patchEntry(key, { status: 'error', error: (error as Error).message }, requestId);
    }
  };

  return {
    downloads: idleDownloads(),
    completedCount: 0,

    startDownload: async (key = 'whisper-base') => {
      const busy = Object.values(get().downloads).some(
        (entry) => entry.status === 'downloading' || entry.status === 'preparing',
      );
      if (busy) {
        return;
      }
      const requestId = beginRequest(key);
      if (key === 'whisper-base') {
        await downloadWhisper(key, requestId);
      } else {
        await downloadParakeet(key, key === 'parakeet-v2' ? 'v2' : 'v3', requestId);
      }
    },

    cancelDownload: async (key) => {
      const status = get().downloads[key].status;
      // Invalidate first so progress/completion/error callbacks racing cancellation are ignored.
      beginRequest(key);
      try {
        if (key === 'whisper-base') {
          await LocalWhisperService.cancelModelDownload('base');
        } else {
          await LocalParakeetService.cancelModelDownload(key === 'parakeet-v2' ? 'v2' : 'v3');
          // If the transfer already completed and CoreML preparation started, remove the newly
          // downloaded model as well; choosing “Don't use Private” should reclaim that storage.
          if (status === 'preparing') {
            await LocalParakeetService.deleteModel(key === 'parakeet-v2' ? 'v2' : 'v3');
          }
        }
      } catch {
        // Cancellation is best-effort at the native transport boundary. The user's mode switch
        // must still proceed, and the invalidated request id prevents stale callbacks from
        // restoring a completed/error state in the UI.
      } finally {
        patchEntry(key, idleEntry());
      }
    },

    reset: (key) => {
      if (key) {
        beginRequest(key);
      } else {
        (Object.keys(requestIds) as LocalModelKey[]).forEach(beginRequest);
      }
      set((state) => ({
        downloads: key ? { ...state.downloads, [key]: idleEntry() } : idleDownloads(),
      }));
    },
  };
});
