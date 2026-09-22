jest.mock('@/services/transcription/LocalWhisperService', () => ({
  LocalWhisperService: {
    isAvailable: jest.fn(() => true),
    downloadModel: jest.fn(async () => undefined),
    cancelModelDownload: jest.fn(async () => undefined),
  },
}));
jest.mock('@/services/transcription/LocalParakeetService', () => ({
  LocalParakeetService: {
    isAvailable: jest.fn(() => true),
    downloadModel: jest.fn(async () => undefined),
    cancelModelDownload: jest.fn(async () => undefined),
    deleteModel: jest.fn(async () => undefined),
    prepare: jest.fn(async () => undefined),
    stagedDownloadBytes: jest.fn(async () => 0),
  },
}));
jest.mock('expo-file-system/legacy', () => ({
  getFreeDiskStorageAsync: jest.fn(async () => 64 * 1024 * 1024 * 1024),
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ updateConfig: jest.fn(async () => undefined) }) },
}));

import * as FileSystem from 'expo-file-system/legacy';
import { LocalWhisperService } from '@/services/transcription/LocalWhisperService';
import { LocalParakeetService } from '@/services/transcription/LocalParakeetService';
import { useModelDownloadStore } from '../useModelDownloadStore';

const mockWhisper = LocalWhisperService as jest.Mocked<typeof LocalWhisperService>;
const mockParakeet = LocalParakeetService as jest.Mocked<typeof LocalParakeetService>;
const mockGetFreeDiskStorage = FileSystem.getFreeDiskStorageAsync as jest.MockedFunction<
  typeof FileSystem.getFreeDiskStorageAsync
>;

/** The store awaits its staged-size and free-space checks before it reaches downloadModel. */
async function untilCalled(mock: { mock: { calls: unknown[] } }): Promise<void> {
  for (let i = 0; i < 20 && mock.mock.calls.length === 0; i += 1) {
    await Promise.resolve();
  }
  expect(mock).toHaveBeenCalled();
}

describe('useModelDownloadStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useModelDownloadStore.getState().reset();
    useModelDownloadStore.setState({ completedCount: 0 });
    mockWhisper.isAvailable.mockReturnValue(true);
    mockParakeet.isAvailable.mockReturnValue(true);
    mockGetFreeDiskStorage.mockResolvedValue(64 * 1024 * 1024 * 1024);
    mockParakeet.stagedDownloadBytes.mockResolvedValue(0);
    // clearAllMocks keeps implementations; undo the rejecting cancel a test below installs.
    mockParakeet.cancelModelDownload.mockResolvedValue(undefined);
  });

  it('tracks whisper downloads under their own key', async () => {
    mockWhisper.downloadModel.mockImplementation(async (_name, onProgress) => {
      onProgress?.(0.4);
    });
    await useModelDownloadStore.getState().startDownload();

    const { downloads, completedCount } = useModelDownloadStore.getState();
    expect(mockWhisper.downloadModel).toHaveBeenCalledWith('base', expect.any(Function));
    expect(downloads['whisper-base'].status).toBe('completed');
    expect(downloads['parakeet-v2'].status).toBe('idle');
    expect(completedCount).toBe(1);
  });

  it('runs parakeet downloads through downloading → preparing → completed', async () => {
    const seenStatuses: string[] = [];
    mockParakeet.downloadModel.mockImplementation(async (_version, onProgress) => {
      onProgress?.(0.5);
      seenStatuses.push(useModelDownloadStore.getState().downloads['parakeet-v3'].status);
    });
    mockParakeet.prepare.mockImplementation(async () => {
      seenStatuses.push(useModelDownloadStore.getState().downloads['parakeet-v3'].status);
    });

    await useModelDownloadStore.getState().startDownload('parakeet-v3');

    expect(seenStatuses).toEqual(['downloading', 'preparing']);
    expect(useModelDownloadStore.getState().downloads['parakeet-v3'].status).toBe('completed');
    expect(mockParakeet.prepare).toHaveBeenCalledWith('v3');
  });

  it('rejects parakeet downloads without enough free space', async () => {
    mockGetFreeDiskStorage.mockResolvedValue(100 * 1024 * 1024);
    await useModelDownloadStore.getState().startDownload('parakeet-v2');

    const entry = useModelDownloadStore.getState().downloads['parakeet-v2'];
    expect(entry.status).toBe('error');
    expect(entry.error).toMatch(/free space/i);
    expect(mockParakeet.downloadModel).not.toHaveBeenCalled();
  });

  it('only requires space for the bytes a previous attempt has not already staged', async () => {
    // 445 MB of the 461 MB v3 model survived an interrupted attempt. Demanding the full 1.2×
    // model size again would lock a phone with 600 MB free out of ever finishing.
    mockParakeet.stagedDownloadBytes.mockResolvedValue(445 * 1024 * 1024);
    mockGetFreeDiskStorage.mockResolvedValue(600 * 1024 * 1024);
    await useModelDownloadStore.getState().startDownload('parakeet-v3');

    expect(mockParakeet.stagedDownloadBytes).toHaveBeenCalledWith('v3');
    expect(mockParakeet.downloadModel).toHaveBeenCalledWith(
      'v3',
      expect.any(Function),
      expect.any(Function),
    );
    expect(useModelDownloadStore.getState().downloads['parakeet-v3'].status).toBe('completed');
  });

  it('keeps the headroom of the full model size even when everything is staged', async () => {
    mockParakeet.stagedDownloadBytes.mockResolvedValue(461 * 1024 * 1024);
    mockGetFreeDiskStorage.mockResolvedValue(50 * 1024 * 1024);
    await useModelDownloadStore.getState().startDownload('parakeet-v3');

    const entry = useModelDownloadStore.getState().downloads['parakeet-v3'];
    expect(entry.status).toBe('error');
    expect(entry.error).toMatch(/free space/i);
    expect(mockParakeet.downloadModel).not.toHaveBeenCalled();
  });

  it('falls back to the full requirement when the staged size cannot be read', async () => {
    mockParakeet.stagedDownloadBytes.mockRejectedValue(new Error('modelSpec failed'));
    mockGetFreeDiskStorage.mockResolvedValue(500 * 1024 * 1024);
    await useModelDownloadStore.getState().startDownload('parakeet-v3');

    expect(useModelDownloadStore.getState().downloads['parakeet-v3'].error).toMatch(/free space/i);
    expect(mockParakeet.downloadModel).not.toHaveBeenCalled();
  });

  it('drops a download whose request was cancelled during the pre-flight checks', async () => {
    // The staged-size and free-space reads are awaited before the transfer starts. A cancel that
    // lands in that window (the user taps "Don't use Private") must not be followed by a 445 MB
    // transfer plus prepare() running invisibly behind an idle row.
    let releaseStaged: ((bytes: number) => void) | undefined;
    mockParakeet.stagedDownloadBytes.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          releaseStaged = resolve;
        }),
    );

    const start = useModelDownloadStore.getState().startDownload('parakeet-v3');
    await untilCalled(mockParakeet.stagedDownloadBytes);
    await useModelDownloadStore.getState().cancelDownload('parakeet-v3');
    releaseStaged?.(0);
    await start;

    expect(mockParakeet.downloadModel).not.toHaveBeenCalled();
    expect(useModelDownloadStore.getState().downloads['parakeet-v3'].status).toBe('idle');
  });

  it('allows only one download at a time', async () => {
    let resolveDownload: (() => void) | undefined;
    mockParakeet.downloadModel.mockImplementation(
      () => new Promise<void>((resolve) => (resolveDownload = resolve)),
    );

    const first = useModelDownloadStore.getState().startDownload('parakeet-v2');
    await untilCalled(mockParakeet.downloadModel);
    await useModelDownloadStore.getState().startDownload('whisper-base');
    expect(mockWhisper.downloadModel).not.toHaveBeenCalled();

    resolveDownload?.();
    await first;
  });

  it('surfaces download failures as per-key errors', async () => {
    mockParakeet.downloadModel.mockRejectedValue(new Error('network down'));
    await useModelDownloadStore.getState().startDownload('parakeet-v3');

    const entry = useModelDownloadStore.getState().downloads['parakeet-v3'];
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('network down');
    expect(useModelDownloadStore.getState().completedCount).toBe(0);
  });

  it('cancels Parakeet and ignores completion that arrives after cancellation', async () => {
    let resolveDownload: (() => void) | undefined;
    mockParakeet.downloadModel.mockImplementation(
      () => new Promise<void>((resolve) => (resolveDownload = resolve)),
    );

    const start = useModelDownloadStore.getState().startDownload('parakeet-v3');
    await untilCalled(mockParakeet.downloadModel);
    await useModelDownloadStore.getState().cancelDownload('parakeet-v3');

    expect(mockParakeet.cancelModelDownload).toHaveBeenCalledWith('v3');
    expect(useModelDownloadStore.getState().downloads['parakeet-v3']).toMatchObject({
      status: 'idle',
      progress: 0,
    });

    resolveDownload?.();
    await start;
    expect(useModelDownloadStore.getState().downloads['parakeet-v3'].status).toBe('idle');
    expect(useModelDownloadStore.getState().completedCount).toBe(0);
  });

  it('cancels the Whisper resumable instead of only resetting UI state', async () => {
    let resolveDownload: (() => void) | undefined;
    mockWhisper.downloadModel.mockImplementation(
      () => new Promise<void>((resolve) => (resolveDownload = resolve)),
    );

    const start = useModelDownloadStore.getState().startDownload('whisper-base');
    await Promise.resolve();
    await useModelDownloadStore.getState().cancelDownload('whisper-base');

    expect(mockWhisper.cancelModelDownload).toHaveBeenCalledWith('base');
    resolveDownload?.();
    await start;
    expect(useModelDownloadStore.getState().downloads['whisper-base'].status).toBe('idle');
  });

  it('keeps the cancelled state even when native cancellation reports an error', async () => {
    let resolveDownload: (() => void) | undefined;
    mockParakeet.downloadModel.mockImplementation(
      () => new Promise<void>((resolve) => (resolveDownload = resolve)),
    );
    mockParakeet.cancelModelDownload.mockRejectedValue(new Error('already cancelled'));

    const start = useModelDownloadStore.getState().startDownload('parakeet-v2');
    await untilCalled(mockParakeet.downloadModel);
    await useModelDownloadStore.getState().cancelDownload('parakeet-v2');

    expect(useModelDownloadStore.getState().downloads['parakeet-v2'].status).toBe('idle');
    resolveDownload?.();
    await start;
    expect(useModelDownloadStore.getState().downloads['parakeet-v2'].status).toBe('idle');
  });

  describe('Orukeet', () => {
    const MB = 1024 * 1024;

    it('runs downloading → preparing (install phases, then warm-up) → completed under its own key', async () => {
      const seen: Array<{ status: string; installPhase?: string }> = [];
      const snapshot = (): void => {
        const { status, installPhase } = useModelDownloadStore.getState().downloads.orukeet;
        seen.push({ status, installPhase });
      };
      mockParakeet.downloadModel.mockImplementation(
        async (_version, onProgress, onInstallPhase) => {
          onProgress?.(0.5);
          snapshot();
          onInstallPhase?.('verifying');
          snapshot();
          onInstallPhase?.('compiling');
          snapshot();
        },
      );
      mockParakeet.prepare.mockImplementation(async () => snapshot());

      await useModelDownloadStore.getState().startDownload('orukeet');

      expect(mockParakeet.downloadModel).toHaveBeenCalledWith(
        'orukeet',
        expect.any(Function),
        expect.any(Function),
      );
      expect(seen).toEqual([
        { status: 'downloading', installPhase: undefined },
        { status: 'preparing', installPhase: 'verifying' },
        { status: 'preparing', installPhase: 'compiling' },
        { status: 'preparing', installPhase: undefined },
      ]);
      expect(mockParakeet.prepare).toHaveBeenCalledWith('orukeet');
      const { downloads } = useModelDownloadStore.getState();
      expect(downloads.orukeet.status).toBe('completed');
      expect(downloads['parakeet-v3'].status).toBe('idle');
    });

    it('requires room for the whole install, not just the installed model', async () => {
      // Enough for the ~600 MB installed model, not for the zip + extraction + compile peak.
      mockGetFreeDiskStorage.mockResolvedValue(1200 * MB);
      await useModelDownloadStore.getState().startDownload('orukeet');

      const entry = useModelDownloadStore.getState().downloads.orukeet;
      expect(entry.status).toBe('error');
      expect(entry.error).toMatch(/free space/i);
      expect(mockParakeet.downloadModel).not.toHaveBeenCalled();
    });

    it('credits an archive a previous attempt already staged against that peak', async () => {
      // The whole pinned zip is staged, so only extraction + compile (~1.2 GB) still needs room.
      mockParakeet.stagedDownloadBytes.mockResolvedValue(554_985_744);
      mockGetFreeDiskStorage.mockResolvedValue(1400 * MB);
      await useModelDownloadStore.getState().startDownload('orukeet');

      expect(mockParakeet.stagedDownloadBytes).toHaveBeenCalledWith('orukeet');
      expect(useModelDownloadStore.getState().downloads.orukeet.status).toBe('completed');
    });

    it('removes a model cancelled while it was being installed', async () => {
      let finishInstall: (() => void) | undefined;
      mockParakeet.downloadModel.mockImplementation(
        (_version, _onProgress, onInstallPhase) =>
          new Promise<void>((resolve) => {
            onInstallPhase?.('compiling');
            finishInstall = resolve;
          }),
      );

      const start = useModelDownloadStore.getState().startDownload('orukeet');
      await untilCalled(mockParakeet.downloadModel);
      expect(useModelDownloadStore.getState().downloads.orukeet.status).toBe('preparing');
      await useModelDownloadStore.getState().cancelDownload('orukeet');

      expect(mockParakeet.cancelModelDownload).toHaveBeenCalledWith('orukeet');
      expect(mockParakeet.deleteModel).toHaveBeenCalledWith('orukeet');
      finishInstall?.();
      await start;
      expect(useModelDownloadStore.getState().downloads.orukeet.status).toBe('idle');
    });

    it('never loads a model whose download was cancelled as its install finished', async () => {
      let finishInstall: (() => void) | undefined;
      mockParakeet.downloadModel.mockImplementation(
        () => new Promise<void>((resolve) => (finishInstall = resolve)),
      );

      const start = useModelDownloadStore.getState().startDownload('orukeet');
      await untilCalled(mockParakeet.downloadModel);
      await useModelDownloadStore.getState().cancelDownload('orukeet');
      finishInstall?.();
      await start;

      expect(mockParakeet.prepare).not.toHaveBeenCalled();
    });

    it('drops the install phase when the install fails', async () => {
      mockParakeet.downloadModel.mockImplementation(
        async (_version, _onProgress, onInstallPhase) => {
          onInstallPhase?.('compiling');
          throw new Error('Orukeet couldn’t be set up on this device.');
        },
      );

      await useModelDownloadStore.getState().startDownload('orukeet');

      expect(useModelDownloadStore.getState().downloads.orukeet).toEqual({
        status: 'error',
        progress: 1,
        error: 'Orukeet couldn’t be set up on this device.',
        installPhase: undefined,
      });
    });

    it('drops the install phase when the install is cancelled', async () => {
      mockParakeet.downloadModel.mockImplementation(
        (_version, _onProgress, onInstallPhase) =>
          new Promise<void>(() => {
            onInstallPhase?.('extracting');
          }),
      );

      useModelDownloadStore.getState().startDownload('orukeet');
      await untilCalled(mockParakeet.downloadModel);
      await useModelDownloadStore.getState().cancelDownload('orukeet');

      expect(useModelDownloadStore.getState().downloads.orukeet.installPhase).toBeUndefined();
    });
  });

  it.each(['parakeet-v3', 'orukeet'] as const)(
    'removes whatever a %s download installed when it is cancelled before any install phase',
    async (key) => {
      mockParakeet.downloadModel.mockImplementation(() => new Promise<void>(() => undefined));

      useModelDownloadStore.getState().startDownload(key);
      await untilCalled(mockParakeet.downloadModel);
      expect(useModelDownloadStore.getState().downloads[key].status).toBe('downloading');
      await useModelDownloadStore.getState().cancelDownload(key);

      expect(mockParakeet.deleteModel).toHaveBeenCalledWith(key === 'orukeet' ? 'orukeet' : 'v3');
    },
  );

  it('clearing what a failed download staged never deletes the model itself', async () => {
    mockParakeet.downloadModel.mockRejectedValue(new Error('HTTP 500'));
    await useModelDownloadStore.getState().startDownload('parakeet-v3');
    expect(useModelDownloadStore.getState().downloads['parakeet-v3'].status).toBe('error');

    await useModelDownloadStore.getState().cancelDownload('parakeet-v3');

    expect(mockParakeet.cancelModelDownload).toHaveBeenCalledWith('v3');
    expect(mockParakeet.deleteModel).not.toHaveBeenCalled();
  });
});
