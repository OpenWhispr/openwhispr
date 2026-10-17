import { act, renderHook } from '@testing-library/react-native';
import { CloudMeetingFinishError, useCloudMeeting } from '../useCloudMeeting';
import { startRealtimeMeetingWs } from '@/services/transcription/RealtimeMeetingWsService';
import type { RealtimeCallbacks, RealtimeSession } from '@/services/transcription/realtimeEvents';

jest.mock('@/services/transcription/RealtimeMeetingWsService', () => ({
  startRealtimeMeetingWs: jest.fn(),
}));

const start = jest.mocked(startRealtimeMeetingWs);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function session(): RealtimeSession {
  return { stop: jest.fn(), finish: jest.fn(async () => undefined), utterances: jest.fn(() => []) };
}
beforeEach(() => jest.clearAllMocks());

it('opens no microphone session until explicitly enabled', () => {
  renderHook(() => useCloudMeeting({ enabled: false }));
  expect(start).not.toHaveBeenCalled();
});

it('aborts startup on Stop and closes a late session without becoming live', async () => {
  const pending = deferred<RealtimeSession>();
  start.mockReturnValue(pending.promise);
  const { result } = renderHook(() => useCloudMeeting({ enabled: true }));
  await act(async () => {
    await expect(result.current.stop()).rejects.toThrow('before recording was ready');
  });
  expect(start.mock.calls[0][0]?.signal?.aborted).toBe(true);
  const late = session();
  await act(async () => pending.resolve(late));
  expect(late.stop).toHaveBeenCalledTimes(1);
  expect(result.current.status).not.toBe('live');
});

it('drains the last utterance once even when Stop is pressed twice', async () => {
  const final = deferred<void>();
  const live = session();
  live.finish = jest.fn(() => final.promise);
  const utterance = { itemId: 'last', text: 'Last sentence.', startMs: 0, endMs: 1200 };
  start.mockResolvedValue(live);
  const { result } = renderHook(() => useCloudMeeting({ enabled: true }));
  await act(async () => undefined);
  let first!: ReturnType<typeof result.current.stop>;
  let second!: typeof first;
  act(() => {
    first = result.current.stop();
    second = result.current.stop();
  });
  expect(first).toBe(second);
  expect(live.finish).toHaveBeenCalledTimes(1);
  expect(live.utterances).not.toHaveBeenCalled();
  await act(async () => {
    jest.mocked(live.utterances).mockReturnValue([utterance]);
    final.resolve();
    await expect(first).resolves.toEqual([utterance]);
  });
});

it('forwards notification Stop and resets it for a new recording', async () => {
  start.mockImplementation(async (_options, callbacks) => {
    callbacks?.onStopRequested?.();
    return session();
  });
  const { result, rerender } = renderHook(
    ({ enabled }: { enabled: boolean }) => useCloudMeeting({ enabled }),
    {
      initialProps: { enabled: true },
    },
  );
  await act(async () => undefined);
  expect(result.current.stopRequested).toBe(true);
  rerender({ enabled: false });
  start.mockResolvedValue(session());
  rerender({ enabled: true });
  await act(async () => undefined);
  expect(result.current.stopRequested).toBe(false);
  expect(result.current.utterances).toEqual([]);
});

it('unmount aborts capture and ignores callbacks from the removed session', async () => {
  const live = session();
  let callbacks!: RealtimeCallbacks;
  start.mockImplementation(async (_options, events) => {
    callbacks = events ?? {};
    return live;
  });
  const { unmount } = renderHook(() => useCloudMeeting({ enabled: true }));
  await act(async () => undefined);
  unmount();
  expect(start.mock.calls[0][0]?.signal?.aborted).toBe(true);
  expect(live.stop).toHaveBeenCalledTimes(1);
  act(() => {
    callbacks.onPartial?.('late', 'item');
    callbacks.onError?.(new Error('late'));
  });
});

it('Cancel aborts and closes the session without requesting a final transcript', async () => {
  const live = session();
  start.mockResolvedValue(live);
  const { result } = renderHook(() => useCloudMeeting({ enabled: true }));
  await act(async () => undefined);
  act(() => result.current.cancel());
  expect(start.mock.calls[0][0]?.signal?.aborted).toBe(true);
  expect(live.stop).toHaveBeenCalledTimes(1);
  expect(live.finish).not.toHaveBeenCalled();
});

it('preserves finalized text in the error when the final transcript cannot be completed', async () => {
  const live = session();
  const utterance = { itemId: 'kept', text: 'Keep these notes.', startMs: 0, endMs: 1200 };
  live.finish = jest.fn(async () => {
    throw new Error('Connection interrupted.');
  });
  live.utterances = jest.fn(() => [utterance]);
  start.mockResolvedValue(live);
  const { result } = renderHook(() => useCloudMeeting({ enabled: true }));
  await act(async () => undefined);
  await act(async () => {
    const error = await result.current.stop().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CloudMeetingFinishError);
    expect(error).toMatchObject({ message: 'Connection interrupted.', utterances: [utterance] });
    expect((error as Error).message).not.toContain('saved recording');
  });
});
