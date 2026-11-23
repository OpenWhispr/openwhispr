const mockDownload = jest.fn(async () => undefined);
const mockReady = jest.fn(async () => false);
jest.mock('@/android/models', () => ({
  downloadAndroidModel: (...args: unknown[]) => mockDownload(...(args as [])),
  modelReady: () => mockReady(),
  useModelDownloads: { getState: () => ({ progress: {} }) },
}));

import { RETRY_FIRST_MS, prefetchSpeakerModel } from '@/android/liveSpeakers/speakerModel';

beforeEach(() => {
  mockDownload.mockClear();
  mockReady.mockResolvedValue(false);
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

it('swallows a failed download and quietly tries again later', async () => {
  jest.useFakeTimers();
  mockDownload.mockRejectedValueOnce(new Error('offline'));
  await expect(prefetchSpeakerModel()).resolves.toBeUndefined();
  expect(mockDownload).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(RETRY_FIRST_MS);
  expect(mockDownload).toHaveBeenCalledTimes(2);
  jest.useRealTimers();
});
