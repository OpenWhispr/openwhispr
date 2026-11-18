let mockCaptureSequence = 0;
jest.mock('@/lib/uuid', () => ({ randomUUID: () => `capture-${++mockCaptureSequence}` }));
const mockListeners = new Map<
  string,
  Set<(event: { noteId: number; captureId: string; message?: string }) => void>
>();
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///app/files/' }));
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: {
    startLocalMeeting: jest.fn(async () => undefined),
    stopLocalMeeting: jest.fn(async () => undefined),
  },
  dictationEvents: {
    addListener: jest.fn(
      (name: string, callback: (event: { noteId: number; captureId: string }) => void) => {
        const listeners = mockListeners.get(name) ?? new Set();
        listeners.add(callback);
        mockListeners.set(name, listeners);
        return {
          remove: () => {
            listeners.delete(callback);
            if (listeners.size === 0) mockListeners.delete(name);
          },
        };
      },
    ),
  },
}));
import { AndroidDictation, dictationEvents } from '../../../modules/android-dictation/src';
import { LocalMeetingRecorder } from '../LocalMeetingRecorder';

function emit(name: string, event: { noteId: number; captureId: string; message?: string }) {
  mockListeners.get(name)?.forEach((listener) => listener(event));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.clear();
});

it('uses a note-owned local capture path and never subscribes to streaming audio', async () => {
  const recorder = new LocalMeetingRecorder(7, jest.fn());
  await recorder.start();
  expect(AndroidDictation!.startLocalMeeting).toHaveBeenCalledWith(7, recorder.captureId, '');
  expect(recorder.uri).toBe('file:///app/files/meeting-7.wav');
  expect(jest.mocked(dictationEvents!.addListener).mock.calls.map(([name]) => name)).toEqual([
    'local-meeting-stopped',
    'local-meeting-error',
  ]);
  await recorder.stop();
  expect(mockListeners.size).toBe(0);
});

it('delivers only its own notification Stop once and retains the source on repeated stop', async () => {
  const ended = jest.fn();
  const recorder = new LocalMeetingRecorder(7, ended);
  await recorder.start();
  emit('local-meeting-stopped', { noteId: 8, captureId: recorder.captureId });
  emit('local-meeting-stopped', { noteId: 7, captureId: 'another-attempt' });
  expect(ended).not.toHaveBeenCalled();
  emit('local-meeting-stopped', { noteId: 7, captureId: recorder.captureId });
  emit('local-meeting-stopped', { noteId: 7, captureId: recorder.captureId });
  expect(ended).toHaveBeenCalledTimes(1);
  await expect(Promise.all([recorder.stop(), recorder.stop()])).resolves.toEqual([
    recorder.uri,
    recorder.uri,
  ]);
  expect(AndroidDictation!.stopLocalMeeting).toHaveBeenCalledTimes(1);
  expect(AndroidDictation!.stopLocalMeeting).toHaveBeenCalledWith(7, recorder.captureId);
});

it('stops a pending start without letting its late completion revive capture', async () => {
  let finish!: () => void;
  jest.mocked(AndroidDictation!.startLocalMeeting).mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        finish = done;
      }),
  );
  const recorder = new LocalMeetingRecorder(7, jest.fn());
  const start = recorder.start().catch((error: unknown) => error);
  await recorder.stop();
  finish();
  expect(await start).toMatchObject({ name: 'AbortError' });
  expect(AndroidDictation!.stopLocalMeeting).toHaveBeenCalledTimes(1);
  expect(mockListeners.size).toBe(0);
});

it('keeps recorder failures local and cleans up after failed startup', async () => {
  const ended = jest.fn();
  const recorder = new LocalMeetingRecorder(7, ended);
  await recorder.start();
  emit('local-meeting-error', {
    noteId: 7,
    captureId: recorder.captureId,
    message: 'Microphone interrupted',
  });
  expect(ended).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'Microphone interrupted' }),
  );
  await recorder.stop();
  jest.mocked(AndroidDictation!.startLocalMeeting).mockRejectedValueOnce(new Error('Cannot start'));
  await expect(new LocalMeetingRecorder(8, jest.fn()).start()).rejects.toThrow('Cannot start');
  expect(AndroidDictation!.stopLocalMeeting).toHaveBeenLastCalledWith(8, expect.any(String));
  expect(mockListeners.size).toBe(0);
});

it('cleans up when the native bridge throws before returning a promise', async () => {
  jest.mocked(AndroidDictation!.startLocalMeeting).mockImplementationOnce(() => {
    throw new Error('Bridge unavailable');
  });
  const recorder = new LocalMeetingRecorder(9, jest.fn());
  await expect(recorder.start()).rejects.toThrow('Bridge unavailable');
  expect(mockListeners.size).toBe(0);
  expect(AndroidDictation!.stopLocalMeeting).toHaveBeenCalledWith(9, recorder.captureId);
});

it('reports a synchronous stop failure as a rejection and does not retry the closed capture', async () => {
  const recorder = new LocalMeetingRecorder(10, jest.fn());
  await recorder.start();
  jest.mocked(AndroidDictation!.stopLocalMeeting).mockImplementationOnce(() => {
    throw new Error('Stop unavailable');
  });
  await expect(recorder.stop()).rejects.toThrow('Stop unavailable');
  await expect(recorder.stop()).rejects.toThrow('Stop unavailable');
  expect(AndroidDictation!.stopLocalMeeting).toHaveBeenCalledTimes(1);
  expect(mockListeners.size).toBe(0);
});

it('keeps the original attempt subscribed when a second attempt for its note fails', async () => {
  const ended = jest.fn();
  const original = new LocalMeetingRecorder(7, ended);
  await original.start();
  const replacement = new LocalMeetingRecorder(7, jest.fn());
  jest
    .mocked(AndroidDictation!.startLocalMeeting)
    .mockRejectedValueOnce(new Error('Already recording'));
  await expect(replacement.start()).rejects.toThrow('Already recording');
  expect(AndroidDictation!.stopLocalMeeting).toHaveBeenCalledWith(7, replacement.captureId);
  expect(AndroidDictation!.stopLocalMeeting).not.toHaveBeenCalledWith(7, original.captureId);
  emit('local-meeting-stopped', { noteId: 7, captureId: replacement.captureId });
  expect(ended).not.toHaveBeenCalled();
  emit('local-meeting-stopped', { noteId: 7, captureId: original.captureId });
  expect(ended).toHaveBeenCalledTimes(1);
  await original.stop();
  expect(mockListeners.size).toBe(0);
});
