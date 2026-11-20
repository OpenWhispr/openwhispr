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
const mockFormat = jest.fn(async (_request: { systemPrompt: string }) => ({
  text: 'Hey Tim,\n\nCan we move our call to Friday at 4pm?\n\nThanks,\nJosh',
}));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: (request: { systemPrompt: string }) => mockFormat(request),
  },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { name: 'Josh Padoa', email: 'josh@example.com' } }) },
}));
jest.mock('../pipeline', () => ({
  createAndroidJob: (mode: string, target?: string, selection?: string) => ({
    mode,
    target,
    selection,
    route: { provider: 'local' },
  }),
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
      expect.objectContaining({
        mode: 'dictate',
        route: { provider: 'cloud', cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' } },
      }),
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockDelete).toHaveBeenCalledWith('file:///cache/practice.wav', { idempotent: true });
    expect(recorder.active).toBe(false);
  });

  it('formats the email practice into lines', async () => {
    const recorder = new PracticeRecorder();
    await recorder.start();
    await expect(recorder.finish('email')).resolves.toContain('Hey Tim,\n\n');
    expect(mockFormat.mock.calls[0][0].systemPrompt).toMatch(/email/);
  });

  it('keeps the cleaned dictation when formatting fails', async () => {
    mockFormat.mockRejectedValueOnce(new Error('rate limited'));
    const recorder = new PracticeRecorder();
    await recorder.start();
    await expect(recorder.finish('email')).resolves.toBe(
      'Hey, are we still on for dinner tonight?',
    );
  });

  it('does not format the message practice', async () => {
    const recorder = new PracticeRecorder();
    await recorder.start();
    await recorder.finish();
    expect(mockFormat).not.toHaveBeenCalled();
  });

  it('runs Practice 2 as an Assistant request on Cloud and lays it out as an email', async () => {
    const recorder = new PracticeRecorder();
    await recorder.start();
    await expect(recorder.finishWrite()).resolves.toContain('Hey Tim,\n\n');
    expect(mockProcess).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        mode: 'write',
        route: expect.objectContaining({ provider: 'cloud' }),
      }),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('asks for a real email: no [Name] placeholders, signed with the account first name', async () => {
    const recorder = new PracticeRecorder();
    await recorder.start();
    await recorder.finishWrite();
    expect(mockFormat).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringMatching(/Never leave placeholders.*sign it from Josh/),
      }),
    );
  });

  it('runs Practice 3 as Edit selection on the selected text only', async () => {
    const recorder = new PracticeRecorder();
    await recorder.start();
    await recorder.finishEdit('Could we move our call?', 'Spanish');
    expect(mockProcess).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ mode: 'edit', selection: 'Could we move our call?' }),
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockFormat).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled();
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
