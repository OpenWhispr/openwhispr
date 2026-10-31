jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  getInfoAsync: jest.fn(),
  getFreeDiskStorageAsync: jest.fn(async () => 4_000_000_000),
  makeDirectoryAsync: jest.fn(async () => undefined),
  createDownloadResumable: jest.fn(),
  moveAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async () => undefined),
}));
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: { sha256: jest.fn() },
}));
import * as FileSystem from 'expo-file-system/legacy';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import {
  ANDROID_MODELS,
  cancelAndroidDownload,
  downloadAndroidModel,
  modelPath,
  modelReady,
  useModelDownloads,
} from '../models';
import i18n from '../strings';

const id = 'qwen-small';
const model = ANDROID_MODELS[id];
let modified = 0;
beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(FileSystem.getFreeDiskStorageAsync).mockReset().mockResolvedValue(4_000_000_000);
  jest.mocked(FileSystem.createDownloadResumable).mockReset();
  jest.mocked(FileSystem.deleteAsync).mockReset().mockResolvedValue(undefined);
  jest.mocked(FileSystem.moveAsync).mockReset().mockResolvedValue(undefined);
  await i18n.changeLanguage('en');
  modified++;
  jest.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri) => ({
    exists: true,
    isDirectory: false,
    size: model.bytes,
    modificationTime: modified,
    uri,
  }));
  jest.mocked(AndroidDictation!.sha256).mockResolvedValue(model.sha256);
  jest.mocked(FileSystem.createDownloadResumable).mockReturnValue({
    downloadAsync: jest.fn(async () => ({ status: 200 })),
  } as never);
});

it('rejects same-sized corrupt weights during readiness', async () => {
  jest.mocked(AndroidDictation!.sha256).mockResolvedValue('corrupt');
  await expect(modelReady(id)).resolves.toBe(false);
});
it('reuses a checksum only while file metadata is unchanged', async () => {
  await expect(modelReady(id)).resolves.toBe(true);
  await expect(modelReady(id)).resolves.toBe(true);
  expect(AndroidDictation!.sha256).toHaveBeenCalledTimes(1);
  modified++;
  jest.mocked(AndroidDictation!.sha256).mockResolvedValue('corrupt');
  await expect(modelReady(id)).resolves.toBe(false);
});
it('repairs same-sized corrupt files and verifies their replacement', async () => {
  jest
    .mocked(AndroidDictation!.sha256)
    .mockResolvedValueOnce('corrupt')
    .mockResolvedValue(model.sha256);
  await downloadAndroidModel(id);
  expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(1);
  expect(FileSystem.moveAsync).toHaveBeenCalledWith({
    from: `${modelPath(id)}.part`,
    to: modelPath(id),
  });
});
it('never installs a downloaded file with the wrong checksum', async () => {
  jest.mocked(AndroidDictation!.sha256).mockResolvedValue('corrupt');
  await expect(downloadAndroidModel(id)).rejects.toThrow();
  expect(FileSystem.moveAsync).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(`${modelPath(id)}.part`, {
    idempotent: true,
  });
});
it('does not require free space to reuse already verified weights', async () => {
  jest.mocked(FileSystem.getFreeDiskStorageAsync).mockResolvedValueOnce(0);
  await downloadAndroidModel(id);
  expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
});

it.each([
  {
    title: 'reclaims an interrupted download so a low-space retry can finish',
    budget: 1_100_000_000,
    ready: true,
  },
  {
    title: 'still refuses a download when reclaiming its partial file is insufficient',
    budget: 700_000_000,
    ready: false,
  },
])('$title', async ({ budget, ready }) => {
  const destination = modelPath(id);
  const partial = `${destination}.part`;
  const otherPartial = `${modelPath('parakeet-v3')}/encoder.int8.onnx.part`;
  const preservedModel = ANDROID_MODELS['qwen-balanced'];
  const preservedPath = modelPath('qwen-balanced');
  const files = new Map([
    [partial, { size: 400_000_000, sha256: 'incomplete' }],
    [otherPartial, { size: 200_000_000, sha256: 'other-incomplete' }],
    [preservedPath, { size: preservedModel.bytes, sha256: preservedModel.sha256 }],
  ]);
  jest.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri) => {
    const file = files.get(uri);
    return file
      ? { exists: true, isDirectory: false, size: file.size, modificationTime: modified, uri }
      : { exists: false, isDirectory: false, uri };
  });
  jest
    .mocked(FileSystem.getFreeDiskStorageAsync)
    .mockImplementation(
      async () =>
        budget +
        preservedModel.bytes -
        [...files.values()].reduce((total, file) => total + file.size, 0),
    );
  jest.mocked(FileSystem.deleteAsync).mockImplementation(async (uri) => {
    files.delete(uri);
  });
  jest.mocked(FileSystem.moveAsync).mockImplementation(async ({ from, to }) => {
    const file = files.get(from);
    if (!file) throw new Error('Cannot move a missing file');
    files.set(to, file);
    files.delete(from);
  });
  jest.mocked(AndroidDictation!.sha256).mockImplementation(async (uri) => {
    const file = files.get(uri);
    if (!file) throw new Error('Cannot hash a missing file');
    return file.sha256;
  });
  jest.mocked(FileSystem.createDownloadResumable).mockImplementation(
    (_url, uri) =>
      ({
        downloadAsync: jest.fn(async () => {
          files.set(uri, { size: model.bytes, sha256: model.sha256 });
          return { status: 200 };
        }),
      }) as never,
  );

  const downloading = downloadAndroidModel(id);
  if (ready) await expect(downloading).resolves.toBeUndefined();
  else {
    await expect(downloading).rejects.toThrow(i18n.t('downloadStorage'));
    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
  }
  await expect(modelReady(id)).resolves.toBe(ready);
  expect(files.has(partial)).toBe(false);
  expect(files.get(otherPartial)).toEqual({ size: 200_000_000, sha256: 'other-incomplete' });
  expect(files.get(preservedPath)).toEqual({
    size: preservedModel.bytes,
    sha256: preservedModel.sha256,
  });
  expect(useModelDownloads.getState().progress[id]).toBeUndefined();
});

it('requires the current balanced artifact rather than accepting cached Qwen2.5 weights', async () => {
  jest.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri) => ({
    exists: true,
    isDirectory: false,
    size: 1117320736,
    modificationTime: modified,
    uri,
  }));
  jest
    .mocked(AndroidDictation!.sha256)
    .mockResolvedValue('6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e');
  await expect(modelReady('qwen-balanced')).resolves.toBe(false);
});

it.each([
  'Software caused connection abort',
  'Connection reset',
  'Unable to resolve host "model.example.invalid": No address associated with hostname',
  'Failed to connect to model.example.invalid/192.0.2.1:443',
  'Network is unreachable',
  'Read timed out',
])('explains an interrupted download and permits retry after %s', async (message) => {
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
    exists: false,
    isDirectory: false,
    uri: modelPath(id),
  });
  jest.mocked(FileSystem.createDownloadResumable).mockReturnValueOnce({
    downloadAsync: jest.fn().mockRejectedValue(new Error(message)),
  } as never);

  await expect(downloadAndroidModel(id)).rejects.toThrow(
    'The model download was interrupted. Check your connection and try again.',
  );
  expect(useModelDownloads.getState().progress[id]).toBeUndefined();
  expect(FileSystem.moveAsync).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(`${modelPath(id)}.part`, {
    idempotent: true,
  });

  jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
    exists: false,
    isDirectory: false,
    uri: modelPath(id),
  });
  await expect(downloadAndroidModel(id)).resolves.toBeUndefined();
  expect(FileSystem.moveAsync).toHaveBeenCalledWith({
    from: `${modelPath(id)}.part`,
    to: modelPath(id),
  });
});

it('localizes an interrupted model download in Arabic', async () => {
  await i18n.changeLanguage('ar');
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
    exists: false,
    isDirectory: false,
    uri: modelPath(id),
  });
  jest.mocked(FileSystem.createDownloadResumable).mockReturnValueOnce({
    downloadAsync: jest.fn().mockRejectedValue(new Error('Software caused connection abort')),
  } as never);
  await expect(downloadAndroidModel(id)).rejects.toThrow(
    'انقطع تنزيل النموذج. تحقق من اتصالك بالإنترنت وحاول مرة أخرى.',
  );
});

it.each(['Software caused connection abort', 'write failed: ENOSPC (No space left on device)'])(
  'keeps explicit cancellation separate from %s',
  async (message) => {
    let rejectTransfer!: (error: Error) => void;
    const transfer = new Promise<never>((_, reject) => {
      rejectTransfer = reject;
    });
    let started!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
      exists: false,
      isDirectory: false,
      uri: modelPath(id),
    });
    jest.mocked(FileSystem.createDownloadResumable).mockReturnValueOnce({
      downloadAsync: jest.fn(() => {
        started();
        return transfer;
      }),
      pauseAsync: jest.fn(async () => undefined),
    } as never);

    const downloading = downloadAndroidModel(id);
    const outcome = downloading.catch((error: Error) => error);
    await downloadStarted;
    await cancelAndroidDownload(id);
    rejectTransfer(new Error(message));
    expect(await outcome).toEqual(expect.objectContaining({ message: 'Download cancelled.' }));
    expect(useModelDownloads.getState().progress[id]).toBeUndefined();
    expect(FileSystem.moveAsync).not.toHaveBeenCalled();
  },
);

it.each([
  [
    'en',
    'write failed: ENOSPC (No space left on device)',
    'Free some storage before downloading this model.',
  ],
  [
    'ar',
    'write failed: ENOSPC (No space left on device)',
    'أفرغ بعض مساحة التخزين قبل تنزيل هذا النموذج.',
  ],
  ['en', 'No space left on device', 'Free some storage before downloading this model.'],
])(
  'explains exhausted storage in %s and permits a clean retry',
  async (language, message, expected) => {
    await i18n.changeLanguage(language);
    jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
      exists: false,
      isDirectory: false,
      uri: modelPath(id),
    });
    jest.mocked(FileSystem.createDownloadResumable).mockReturnValueOnce({
      downloadAsync: jest.fn().mockRejectedValue(new Error(message)),
    } as never);
    await expect(downloadAndroidModel(id)).rejects.toThrow(expected);
    expect(useModelDownloads.getState().progress[id]).toBeUndefined();
    expect(FileSystem.moveAsync).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(`${modelPath(id)}.part`, {
      idempotent: true,
    });
    jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
      exists: false,
      isDirectory: false,
      uri: modelPath(id),
    });
    await expect(downloadAndroidModel(id)).resolves.toBeUndefined();
    await expect(modelReady(id)).resolves.toBe(true);
  },
);

it('preserves an unrelated filesystem error rather than claiming storage is exhausted', async () => {
  const error = new Error('Permission denied');
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
    exists: false,
    isDirectory: false,
    uri: modelPath(id),
  });
  jest.mocked(FileSystem.createDownloadResumable).mockReturnValueOnce({
    downloadAsync: jest.fn().mockRejectedValue(error),
  } as never);
  await expect(downloadAndroidModel(id)).rejects.toBe(error);
});
