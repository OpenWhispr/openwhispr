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
import { ANDROID_MODELS, downloadAndroidModel, modelPath, modelReady } from '../models';

const id = 'qwen-small';
const model = ANDROID_MODELS[id];
let modified = 0;
beforeEach(() => {
  jest.clearAllMocks();
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
