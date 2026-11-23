const mockStorage: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockStorage[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStorage[key] = value;
    }),
    removeItem: jest.fn(async (key: string) => {
      delete mockStorage[key];
    }),
  },
}));
const mockDownload = jest.fn(async () => undefined);
const mockReady = jest.fn(async () => false);
jest.mock('@/android/models', () => ({
  downloadAndroidModel: (...args: unknown[]) => mockDownload(...(args as [])),
  modelReady: () => mockReady(),
  useModelDownloads: { getState: () => ({ progress: {} }) },
}));

import {
  prefetchSpeakerModel,
  speakerModelRemovedByUser,
} from '@/android/liveSpeakers/speakerModel';

beforeEach(() => {
  mockDownload.mockClear();
  mockReady.mockResolvedValue(false);
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
});

it('downloads the speaker model when it is missing', async () => {
  await prefetchSpeakerModel();
  expect(mockDownload).toHaveBeenCalledWith('meeting-speakers');
});

it('does nothing once the model is on the phone', async () => {
  mockReady.mockResolvedValue(true);
  await prefetchSpeakerModel();
  expect(mockDownload).not.toHaveBeenCalled();
});

it('never fetches it again after the person removed it, until they download it themselves', async () => {
  speakerModelRemovedByUser(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await prefetchSpeakerModel();
  expect(mockDownload).not.toHaveBeenCalled();
  speakerModelRemovedByUser(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await prefetchSpeakerModel();
  expect(mockDownload).toHaveBeenCalledTimes(1);
});

it('swallows a failed download', async () => {
  mockDownload.mockRejectedValueOnce(new Error('offline'));
  await expect(prefetchSpeakerModel()).resolves.toBeUndefined();
});
