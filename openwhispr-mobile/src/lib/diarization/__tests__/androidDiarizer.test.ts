jest.mock('../../../../modules/android-dictation/src', () => ({
  AndroidDictation: {
    diarize: jest.fn(),
    cancelDiarization: jest.fn(),
    releaseParakeet: jest.fn(async () => undefined),
    releaseMoonshine: jest.fn(async () => undefined),
  },
}));
jest.mock('@/android/models', () => ({
  modelReady: jest.fn(async () => true),
  modelPath: () => 'file:///models/meeting-speakers',
  downloadAndroidModel: jest.fn(),
  removeAndroidModel: jest.fn(),
}));
jest.mock('@/android/LocalTextModel', () => ({
  LocalTextModel: { release: jest.fn(async () => undefined) },
}));
jest.mock('@/android/strings', () => ({ __esModule: true, default: { t: (key: string) => key } }));
jest.mock('../../../../modules/speaker-diarization/src', () => ({
  SpeakerDiarization: {
    isAvailable: () => false,
    diarize: async () => {
      throw new Error('SpeakerDiarization is only available on iOS 17+.');
    },
  },
}));

import { Platform } from 'react-native';
import { getDiarizer } from '../getDiarizer';
import { FluidAudioDiarizer } from '../fluidAudioDiarizer';
import { AndroidDictation } from '../../../../modules/android-dictation/src';
import { modelReady } from '@/android/models';
import { withAndroidInference } from '@/android/inferenceQueue';

const result = {
  speakerCount: 2,
  segments: [
    { start: 0.25, end: 2.5, speakerId: 0 },
    { start: 2.4, end: 4.75, speakerId: 1 },
  ],
  embeddings: {},
};
beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  jest.mocked(modelReady).mockResolvedValue(true);
  jest.mocked(AndroidDictation!.diarize).mockResolvedValue(result);
});
afterEach(() => {
  Platform.OS = 'ios';
});

it('makes the installed Android speaker runtime available while preserving iOS routing', () => {
  expect(getDiarizer().isAvailable()).toBe(true);
  Platform.OS = 'ios';
  expect(getDiarizer()).toBe(FluidAudioDiarizer);
});

it('preserves timed overlapping speaker turns from the Android engine', async () => {
  await expect(getDiarizer().diarize('file:///meeting.wav', 2)).resolves.toEqual(result);
  expect(AndroidDictation!.diarize).toHaveBeenCalledWith(
    'file:///meeting.wav',
    'file:///models/meeting-speakers',
    2,
  );
});

it('rejects unverified models before native inference', async () => {
  jest.mocked(modelReady).mockResolvedValue(false);
  await expect(getDiarizer().diarize('file:///meeting.wav')).rejects.toThrow();
  expect(AndroidDictation!.diarize).not.toHaveBeenCalled();
});

it('cancels queued work without starting the native engine', async () => {
  let release!: () => void;
  const blocker = withAndroidInference(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  await Promise.resolve();
  const diarizer = getDiarizer();
  expect(diarizer.isAvailable()).toBe(true);
  const pending = diarizer.diarize('file:///meeting.wav');
  const rejected = expect(pending).rejects.toThrow();
  diarizer.cancel?.();
  release();
  await blocker;
  await rejected;
  expect(AndroidDictation!.diarize).not.toHaveBeenCalled();
});

it('discards a native result returned after cancellation', async () => {
  let finish!: (value: typeof result) => void;
  let started!: () => void;
  const ready = new Promise<void>((done) => {
    started = done;
  });
  jest.mocked(AndroidDictation!.diarize).mockImplementation(() => {
    started();
    return new Promise((done) => {
      finish = done;
    });
  });
  const diarizer = getDiarizer();
  expect(diarizer.isAvailable()).toBe(true);
  const pending = diarizer.diarize('file:///meeting.wav');
  const rejected = expect(pending).rejects.toThrow();
  await ready;
  diarizer.cancel?.();
  finish(result);
  await rejected;
});
