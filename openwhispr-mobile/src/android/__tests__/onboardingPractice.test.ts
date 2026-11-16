import { PermissionsAndroid } from 'react-native';
import { PracticeRecorder, requestMicrophone } from '../onboarding/practiceRecorder';

const mockStart = jest.fn(async () => {});
const mockStop = jest.fn(async (_cancel: boolean) => ({
  uri: 'file:///cache/practice.wav',
  durationMs: 1800,
  noSpeech: false,
}));
const mockProcess = jest.fn(async () => 'Hey, are we still on for dinner tonight?');
const mockDelete = jest.fn(async () => {});

jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: {
    startRecording: () => mockStart(),
    stopRecording: (cancel: boolean) => mockStop(cancel),
  },
}));
jest.mock('expo-file-system/legacy', () => ({
  deleteAsync: (...args: unknown[]) => mockDelete(...(args as [])),
}));
jest.mock('../pipeline', () => ({
  createAndroidJob: (mode: string) => ({ mode }),
  processAndroidAudio: (...args: unknown[]) => mockProcess(...(args as [])),
}));

beforeEach(() => jest.clearAllMocks());

describe('practice recorder', () => {
  it('records in the app and runs the dictation pipeline on the recording', async () => {
    const recorder = new PracticeRecorder();
    await recorder.start();
    expect(recorder.active).toBe(true);
    await expect(recorder.finish()).resolves.toBe('Hey, are we still on for dinner tonight?');
    expect(mockStop).toHaveBeenCalledWith(false);
    expect(mockProcess).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'file:///cache/practice.wav' }),
      { mode: 'dictate' },
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockDelete).toHaveBeenCalledWith('file:///cache/practice.wav', { idempotent: true });
    expect(recorder.active).toBe(false);
  });

  it('throws the recording away on cancel', async () => {
    const recorder = new PracticeRecorder();
    await recorder.start();
    await recorder.cancel();
    expect(mockStop).toHaveBeenCalledWith(true);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled();
  });

  it('does nothing on cancel when nothing is recording', async () => {
    await new PracticeRecorder().cancel();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('still deletes the audio when the pipeline fails', async () => {
    mockProcess.mockRejectedValueOnce(new Error('offline'));
    const recorder = new PracticeRecorder();
    await recorder.start();
    await expect(recorder.finish()).rejects.toThrow('offline');
    expect(mockDelete).toHaveBeenCalled();
  });
});

describe('microphone request', () => {
  it('skips the dialog when access is already granted', async () => {
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
    const request = jest.spyOn(PermissionsAndroid, 'request');
    await expect(requestMicrophone()).resolves.toBe('granted');
    expect(request).not.toHaveBeenCalled();
  });

  it('reports a permanent refusal so the screen can offer Settings', async () => {
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
    jest
      .spyOn(PermissionsAndroid, 'request')
      .mockResolvedValue(PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
    await expect(requestMicrophone()).resolves.toBe('blocked');
  });
});
