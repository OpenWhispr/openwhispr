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
  ReasoningService: { processText: jest.fn() },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: { autoGenerateNoteTitle: false } }) },
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
      customDictionary: [' OpenWhispr ', 'OpenWhispr'],
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
