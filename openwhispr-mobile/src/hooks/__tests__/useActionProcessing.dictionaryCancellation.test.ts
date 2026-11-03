import { act, renderHook } from '@testing-library/react-native';
import { useActionProcessing } from '../useActionProcessing';
import { fitDictionaryOnDevice } from '@/lib/onDeviceDictionary';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import type { LlmDictionary } from '@/lib/snippets';
import type { Action } from '@/data';

jest.mock('@/services/reasoning/ReasoningService', () => ({
  resolveReasoningPlacement: () => ({ localRequired: true }),
  ReasoningService: { processText: jest.fn() },
}));
jest.mock('@/lib/onDeviceDictionary', () => ({ fitDictionaryOnDevice: jest.fn() }));
jest.mock('@/utils/generateTitle', () => ({ generateNoteTitle: jest.fn() }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: { autoGenerateNoteTitle: false } }) },
}));

const action = { name: 'Summarize', prompt: 'Summarize.', isDefault: 0 } as Action;
const dictionary = { personal: ['Piha'], shared: ['Acme'] };

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.mocked(ReasoningService.processText).mockResolvedValue({ text: 'Summary', model: 'test' });
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('does not start inference after cancellation while fitting shared dictionary hints', async () => {
  let finishFit!: (value: LlmDictionary) => void;
  jest.mocked(fitDictionaryOnDevice).mockReturnValueOnce(
    new Promise((resolve) => {
      finishFit = resolve;
    }),
  );
  const onSuccess = jest.fn();
  const onError = jest.fn();
  const { result } = renderHook(() => useActionProcessing({ onSuccess, onError }));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.runAction(action, 'Private note', {
      dictionaryTiers: [['Piha'], ['Acme'], []],
    });
  });
  act(() => result.current.cancel());
  await act(async () => {
    finishFit(dictionary);
    await pending;
  });

  expect(ReasoningService.processText).not.toHaveBeenCalled();
  expect(onSuccess).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(result.current.state).toBe('idle');
});

it('rechecks editor ownership after fitting hints before sending note content', async () => {
  let finishFit!: (value: LlmDictionary) => void;
  jest.mocked(fitDictionaryOnDevice).mockReturnValueOnce(
    new Promise((resolve) => {
      finishFit = resolve;
    }),
  );
  let current = true;
  const onSuccess = jest.fn();
  const { result } = renderHook(() => useActionProcessing({ onSuccess, onError: jest.fn() }));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.runAction(action, 'Previous account note', {
      dictionaryTiers: [['Piha'], ['Acme'], []],
      isCurrent: () => current,
    });
  });
  current = false;
  await act(async () => {
    finishFit(dictionary);
    await pending;
  });

  expect(ReasoningService.processText).not.toHaveBeenCalled();
  expect(onSuccess).not.toHaveBeenCalled();
  expect(result.current.state).toBe('idle');
});
