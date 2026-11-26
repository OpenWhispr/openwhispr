jest.mock('whisper.rn', () => ({
  initWhisper: jest.fn(),
}));

jest.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: jest.fn(),
  deleteAsync: jest.fn(async () => undefined),
  documentDirectory: '/doc/',
  getInfoAsync: jest.fn(async () => ({ exists: true })),
  makeDirectoryAsync: jest.fn(async () => undefined),
}));

jest.mock('@/lib/keyboardLocalEngine', () => ({
  refreshKeyboardLocalEngine: jest.fn(async () => undefined),
}));

import * as FileSystem from 'expo-file-system/legacy';
import { refreshKeyboardLocalEngine } from '@/lib/keyboardLocalEngine';
import { LocalWhisperService } from '../LocalWhisperService';

const mockCreateDownloadResumable = FileSystem.createDownloadResumable as jest.MockedFunction<
  typeof FileSystem.createDownloadResumable
>;
const mockDeleteAsync = FileSystem.deleteAsync as jest.MockedFunction<
  typeof FileSystem.deleteAsync
>;
const mockDownloadAsync = jest.fn();
const mockPauseAsync = jest.fn(async () => undefined);

describe('LocalWhisperService model downloads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateDownloadResumable.mockReturnValue({
      downloadAsync: mockDownloadAsync,
      pauseAsync: mockPauseAsync,
    } as unknown as ReturnType<typeof FileSystem.createDownloadResumable>);
  });

  it('pauses an in-flight download and removes its partial destination', async () => {
    let resolveDownload: (() => void) | undefined;
    mockDownloadAsync.mockImplementation(
      () => new Promise<void>((resolve) => (resolveDownload = resolve)),
    );

    const download = LocalWhisperService.downloadModel('base');
    await Promise.resolve();
    await LocalWhisperService.cancelModelDownload('base');

    expect(mockPauseAsync).toHaveBeenCalledTimes(1);
    expect(mockDeleteAsync).toHaveBeenCalledWith('/doc/whisper-models/base.bin', {
      idempotent: true,
    });

    resolveDownload?.();
    await download;
  });

  it('rejects a non-2xx response and removes the saved body instead of keeping it as the model', async () => {
    // HuggingFace answers a missing file with a 404 HTML page. Saved as base.bin it breaks every
    // local transcription with a confusing error until the user deletes and re-downloads.
    mockDownloadAsync.mockResolvedValue({
      status: 404,
      uri: '/doc/whisper-models/base.bin',
      headers: {},
      mimeType: 'text/html',
    });

    await expect(LocalWhisperService.downloadModel('base')).rejects.toThrow(/HTTP 404/);
    expect(mockDeleteAsync).toHaveBeenCalledWith('/doc/whisper-models/base.bin', {
      idempotent: true,
    });
  });

  it('keeps a 2xx download', async () => {
    mockDownloadAsync.mockResolvedValue({
      status: 200,
      uri: '/doc/whisper-models/base.bin',
      headers: {},
      mimeType: 'application/octet-stream',
    });

    await expect(LocalWhisperService.downloadModel('base')).resolves.toBeUndefined();
    expect(mockDeleteAsync).not.toHaveBeenCalled();
  });

  // Whisper base being on disk changes which engine Local Mode resolves to, so the keyboard's
  // snapshot must follow a download or delete made while the app stays open.
  it("refreshes the keyboard's Local engine after a download and after a delete", async () => {
    mockDownloadAsync.mockResolvedValue({
      status: 200,
      uri: '/doc/whisper-models/base.bin',
      headers: {},
      mimeType: 'application/octet-stream',
    });
    await LocalWhisperService.downloadModel('base');
    expect(refreshKeyboardLocalEngine).toHaveBeenCalledTimes(1);

    jest
      .spyOn(LocalWhisperService, 'getAvailableModels')
      .mockResolvedValue([
        { name: 'base', size: 1, downloaded: true, path: '/doc/whisper-models/base.bin' },
      ]);
    await LocalWhisperService.deleteModel('base');
    expect(refreshKeyboardLocalEngine).toHaveBeenCalledTimes(2);
  });

  it('does not refresh after a failed download', async () => {
    mockDownloadAsync.mockResolvedValue({
      status: 404,
      uri: '/doc/whisper-models/base.bin',
      headers: {},
      mimeType: 'text/html',
    });
    await expect(LocalWhisperService.downloadModel('base')).rejects.toThrow(/HTTP 404/);
    expect(refreshKeyboardLocalEngine).not.toHaveBeenCalled();
  });
});
