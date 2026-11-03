import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { useActionProcessing } from '@/hooks/useActionProcessing';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { buildActionSystemPrompt } from '@/lib/notes/generateNotesPrompt';
import type { Action } from '@/data';

// Compile the desktop source independently: this catches drift in the Android
// bundled copy without pulling desktop modules into the mobile runtime.
const desktop = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { BUILTIN_ACTIONS, GENERATE_NOTES_KEY } from './src/helpers/builtinActions.js';
    import { compileTemplatePrompt } from './src/helpers/templatePrompts.js';
    const action = BUILTIN_ACTIONS.find(a => a.translationKey === GENERATE_NOTES_KEY);
    console.log(JSON.stringify({ action, systemPrompt: compileTemplatePrompt({
      ...action, translation_key: action.translationKey,
    }) }));
  `,
    ],
    {
      cwd: path.resolve(__dirname, '../../../..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ),
);
const desktopAction = desktop.action;
const desktopPrompt = desktop.systemPrompt;

jest.mock('@/services/reasoning/ReasoningService', () => ({
  resolveReasoningPlacement: () => ({ localRequired: false }),
  ReasoningService: { processText: jest.fn() },
}));
const mockConfig = { autoGenerateNoteTitle: false };
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));

const action: Action = {
  id: 1,
  name: 'Generate Notes',
  description: '',
  prompt: 'Saved mobile default instructions.',
  isDefault: 1,
  sortOrder: 0,
  createdAt: null,
  updatedAt: null,
};
const originalPlatform = Platform.OS;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockConfig.autoGenerateNoteTitle = false;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  jest.mocked(ReasoningService.processText).mockResolvedValue({ text: 'Clean notes.' } as never);
});
afterEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('sends the desktop default prompt to Android note inference', async () => {
  const onSuccess = jest.fn();
  const { result } = renderHook(() => useActionProcessing({ onSuccess, onError: jest.fn() }));
  await act(() => result.current.runAction(action, 'we was there'));
  expect(ReasoningService.processText).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'we was there', systemPrompt: desktopPrompt }),
  );
  expect(onSuccess).toHaveBeenCalledWith(
    'Clean notes.',
    desktopAction.prompt || desktopPrompt,
    undefined,
  );
});

it('retains normalized dictionary spellings with the desktop prompt', async () => {
  const { result } = renderHook(() =>
    useActionProcessing({ onSuccess: jest.fn(), onError: jest.fn() }),
  );
  await act(() =>
    result.current.runAction(action, 'a note', {
      dictionaryTiers: [[' OpenWhispr ', 'OpenWhispr'], [], []],
    }),
  );
  expect(ReasoningService.processText).toHaveBeenCalledWith(
    expect.objectContaining({
      systemPrompt:
        desktopPrompt +
        '\n\nCustom Dictionary (use these exact spellings when they appear in the text): OpenWhispr',
    }),
  );
});

it.each([
  'NOTHING_TO_SUMMARIZE',
  '```\nNOTHING_TO_SUMMARIZE\n```',
  'Only filler.\n**NOTHING_TO_SUMMARIZE**',
])('does not publish the desktop empty-content response: %s', async (text) => {
  jest.mocked(ReasoningService.processText).mockResolvedValue({ text } as never);
  const onSuccess = jest.fn();
  const onError = jest.fn();
  const { result } = renderHook(() => useActionProcessing({ onSuccess, onError }));
  await act(() => result.current.runAction(action, 'um uh'));
  expect(onSuccess).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith(expect.stringContaining('summarize'), expect.any(Error));
  expect(result.current.state).toBe('idle');
});

it.each([
  ['ios', 'plain-note', 1],
  ['android', 'meeting-transcript', 1],
  ['android', 'plain-note', 0],
] as const)(
  'preserves the existing %s / %s / default=%s route',
  async (os, inputKind, isDefault) => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
    const { result } = renderHook(() =>
      useActionProcessing({ onSuccess: jest.fn(), onError: jest.fn() }),
    );
    await act(() => result.current.runAction({ ...action, isDefault }, 'source', { inputKind }));
    expect(ReasoningService.processText).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: buildActionSystemPrompt({
          actionPrompt: action.prompt,
          inputKind,
          isDefaultGenerateNotesAction: isDefault === 1,
        }),
      }),
    );
  },
);

// A marker mentioned inside real content must not discard the user's result.
it('publishes substantive notes that mention the empty-content marker', async () => {
  const text = '## Protocol\nThe response token is:\nNOTHING_TO_SUMMARIZE';
  jest.mocked(ReasoningService.processText).mockResolvedValue({ text } as never);
  const onSuccess = jest.fn();
  const onError = jest.fn();
  const { result } = renderHook(() => useActionProcessing({ onSuccess, onError }));
  await act(() => result.current.runAction(action, 'Document the protocol token.'));
  expect(onSuccess).toHaveBeenCalledWith(text, desktopAction.prompt || desktopPrompt, undefined);
  expect(onError).not.toHaveBeenCalled();
});

it('aborts the pending inference request when the action is cancelled', async () => {
  let resolve!: (value: { text: string; model: string }) => void;
  jest.mocked(ReasoningService.processText).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const onSuccess = jest.fn();
  const onError = jest.fn();
  const { result } = renderHook(() => useActionProcessing({ onSuccess, onError }));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.runAction(action, 'Original note');
  });
  const request = jest.mocked(ReasoningService.processText).mock.calls[0][0];
  act(() => result.current.cancel());
  expect(request.signal?.aborted).toBe(true);
  expect(result.current.state).toBe('idle');
  await act(async () => {
    resolve({ text: 'Late result', model: 'test' });
    await pending;
  });
  expect(onSuccess).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it('keeps a replacement action protected from a cancelled request that finishes late', async () => {
  let resolveOld!: (value: { text: string; model: string }) => void;
  let resolveNew!: (value: { text: string; model: string }) => void;
  jest
    .mocked(ReasoningService.processText)
    .mockReturnValueOnce(
      new Promise((r) => {
        resolveOld = r;
      }),
    )
    .mockReturnValueOnce(
      new Promise((r) => {
        resolveNew = r;
      }),
    );
  const onSuccess = jest.fn();
  const { result } = renderHook(() => useActionProcessing({ onSuccess, onError: jest.fn() }));
  let oldRun!: Promise<void>;
  let newRun!: Promise<void>;
  act(() => {
    oldRun = result.current.runAction(action, 'Old note');
  });
  act(() => result.current.cancel());
  act(() => {
    newRun = result.current.runAction(action, 'Replacement note');
  });
  await act(async () => {
    resolveOld({ text: 'Stale result', model: 'test' });
    await oldRun;
  });
  expect(onSuccess).not.toHaveBeenCalled();
  expect(result.current.state).toBe('processing');
  await act(() => result.current.runAction(action, 'Duplicate request'));
  expect(ReasoningService.processText).toHaveBeenCalledTimes(2);
  await act(async () => {
    resolveNew({ text: 'Fresh result', model: 'test' });
    await newRun;
  });
  expect(onSuccess).toHaveBeenCalledTimes(1);
  expect(onSuccess).toHaveBeenCalledWith(
    'Fresh result',
    desktopAction.prompt || desktopPrompt,
    undefined,
  );
});

it('cancels automatic title inference with the same action and never publishes its late result', async () => {
  mockConfig.autoGenerateNoteTitle = true;
  let resolveTitle!: (value: { text: string; model: string }) => void;
  jest
    .mocked(ReasoningService.processText)
    .mockResolvedValueOnce({ text: 'Enhanced note', model: 'test' })
    .mockReturnValueOnce(
      new Promise((r) => {
        resolveTitle = r;
      }),
    );
  const onSuccess = jest.fn();
  const { result } = renderHook(() => useActionProcessing({ onSuccess, onError: jest.fn() }));
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.runAction(action, 'Original note');
  });
  expect(ReasoningService.processText).toHaveBeenCalledTimes(2);
  const [request, title] = jest
    .mocked(ReasoningService.processText)
    .mock.calls.map(([input]) => input);
  act(() => result.current.cancel());
  expect(title.signal?.aborted).toBe(true);
  expect(title.signal).toBe(request.signal);
  await act(async () => {
    resolveTitle({ text: 'Late title', model: 'test' });
    await pending;
  });
  expect(onSuccess).not.toHaveBeenCalled();
});

it('does not let a previous success timer clear a newer pending action', async () => {
  const { result } = renderHook(() =>
    useActionProcessing({ onSuccess: jest.fn(), onError: jest.fn() }),
  );
  await act(() => result.current.runAction(action, 'First note'));
  let resolve!: (value: { text: string; model: string }) => void;
  jest.mocked(ReasoningService.processText).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.runAction(action, 'Next note');
  });
  act(() => jest.advanceTimersByTime(600));
  expect(result.current.state).toBe('processing');
  await act(async () => {
    resolve({ text: 'Second result', model: 'test' });
    await pending;
  });
});
