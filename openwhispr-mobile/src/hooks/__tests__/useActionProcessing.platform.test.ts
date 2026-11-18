import { act, renderHook } from '@testing-library/react-native';
import { useActionProcessing } from '../useActionProcessing';
import { useActionProcessing as useAndroidActionProcessing } from '../useActionProcessing.android';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { generateNoteTitle } from '@/utils/generateTitle';
import type { Action } from '@/data';

jest.mock('@/services/reasoning/ReasoningService', () => ({
  resolveReasoningPlacement: () => ({ localRequired: false }),
  ReasoningService: { processText: jest.fn() },
}));
jest.mock('@/utils/generateTitle', () => ({ generateNoteTitle: jest.fn() }));
const mockConfig = { autoGenerateNoteTitle: false };
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));

const action = { name: 'Summarize', prompt: 'Summarize.', isDefault: 0 } as Action;
function deferred() {
  let resolve!: (value: { text: string; model: string }) => void;
  const promise = new Promise<{ text: string; model: string }>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockConfig.autoGenerateNoteTitle = false;
  jest
    .mocked(ReasoningService.processText)
    .mockResolvedValue({ text: 'Summary', model: 'fixture' });
  jest.mocked(generateNoteTitle).mockResolvedValue('Title');
});
afterEach(() => {
  jest.clearAllTimers();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('keeps the upstream default reasoning argument shape without an Android signal', async () => {
  const { result } = renderHook(() =>
    useActionProcessing({ onSuccess: jest.fn(), onError: jest.fn() }),
  );
  await act(() => result.current.runAction(action, 'Note'));
  expect(ReasoningService.processText).toHaveBeenCalledTimes(1);
  expect(ReasoningService.processText).toHaveBeenCalledWith({
    inferenceScope: 'notes',
    routing: undefined,
    text: 'Note',
    temperature: 0.3,
    systemPrompt: expect.any(String),
  });
  expect(Object.keys(jest.mocked(ReasoningService.processText).mock.calls[0][0])).not.toContain(
    'signal',
  );
});

it('leaves the added caller-current guard to the default hook caller', async () => {
  const onSuccess = jest.fn();
  const { result } = renderHook(() => useActionProcessing({ onSuccess, onError: jest.fn() }));
  const options = { routing: {}, isCurrent: () => false };
  await act(() => result.current.runAction(action, 'Note', options));
  expect(onSuccess).toHaveBeenCalledWith('Summary', 'Summarize.', undefined);
});

it('keeps the upstream two-argument title call and ignores the added title veto', async () => {
  mockConfig.autoGenerateNoteTitle = true;
  const onSuccess = jest.fn();
  const { result } = renderHook(() => useActionProcessing({ onSuccess, onError: jest.fn() }));
  const options = { routing: {}, shouldGenerateTitle: () => false };
  await act(() => result.current.runAction(action, 'Note', options));
  expect(generateNoteTitle).toHaveBeenCalledWith('Summary', options.routing);
  expect(onSuccess).toHaveBeenCalledWith('Summary', 'Summarize.', 'Title');
});

it('retains the upstream deferred result when the added caller check becomes stale', async () => {
  const job = deferred();
  let current = true;
  jest.mocked(ReasoningService.processText).mockReturnValueOnce(job.promise);
  const onSuccess = jest.fn();
  const { result } = renderHook(() => useActionProcessing({ onSuccess, onError: jest.fn() }));
  const options = { routing: {}, isCurrent: () => current };
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.runAction(action, 'Note', options);
  });
  current = false;
  await act(async () => {
    job.resolve({ text: 'Late summary', model: 'fixture' });
    await pending;
  });
  expect(onSuccess).toHaveBeenCalledWith('Late summary', 'Summarize.', undefined);
});

it('keeps the original cancellation flag semantics when a replacement starts', async () => {
  const old = deferred(),
    next = deferred();
  jest
    .mocked(ReasoningService.processText)
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(next.promise);
  const onSuccess = jest.fn();
  const { result } = renderHook(() => useActionProcessing({ onSuccess, onError: jest.fn() }));
  let first!: Promise<void>, second!: Promise<void>;
  act(() => {
    first = result.current.runAction(action, 'Old');
  });
  act(() => result.current.cancel());
  act(() => {
    second = result.current.runAction(action, 'Replacement');
  });
  await act(async () => {
    old.resolve({ text: 'Old result', model: 'fixture' });
    await first;
  });
  expect(onSuccess).toHaveBeenCalledWith('Old result', 'Summarize.', undefined);
  await act(async () => {
    next.resolve({ text: 'New result', model: 'fixture' });
    await second;
  });
  expect(onSuccess).toHaveBeenCalledTimes(2);
});

it('retains the upstream success timer even while a newer request is pending', async () => {
  const { result } = renderHook(() =>
    useActionProcessing({ onSuccess: jest.fn(), onError: jest.fn() }),
  );
  await act(() => result.current.runAction(action, 'First'));
  const next = deferred();
  jest.mocked(ReasoningService.processText).mockReturnValueOnce(next.promise);
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.runAction(action, 'Second');
  });
  act(() => jest.advanceTimersByTime(600));
  expect(result.current.state).toBe('idle');
  await act(async () => {
    next.resolve({ text: 'Second result', model: 'fixture' });
    await pending;
  });
});

it('does not add Android success-timer cleanup to the default unmount contract', async () => {
  const schedule = jest.spyOn(global, 'setTimeout');
  const clear = jest.spyOn(global, 'clearTimeout');
  const { result, unmount } = renderHook(() =>
    useActionProcessing({ onSuccess: jest.fn(), onError: jest.fn() }),
  );
  await act(() => result.current.runAction(action, 'Note'));
  const index = schedule.mock.calls.findIndex((call) => call[1] === 600);
  expect(index).toBeGreaterThanOrEqual(0);
  const timer = schedule.mock.results[index].value;
  unmount();
  expect(clear).not.toHaveBeenCalledWith(timer);
});

it.each([useActionProcessing, useAndroidActionProcessing])(
  'preserves public callback identity across unchanged renders (%#)',
  (useHook) => {
    const options = { onSuccess: jest.fn(), onError: jest.fn() };
    const { result, rerender } = renderHook(() => useHook(options));
    const run = result.current.runAction;
    const cancel = result.current.cancel;
    rerender({});
    expect(result.current.runAction).toBe(run);
    expect(result.current.cancel).toBe(cancel);
  },
);
