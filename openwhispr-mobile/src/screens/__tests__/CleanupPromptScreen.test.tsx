import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DEFAULT_CLEANUP_PROMPT } from '@/config/prompts/registry';

const mockSetCustomPrompt = jest.fn();
const mockResetCustomPrompt = jest.fn();
let mockStoredPrompt = '';
let mockConfig: Record<string, unknown> | null = { defaultMode: 'cloud', cleanupEnabled: true };
let mockActiveMode = 'cloud';

// nativewind's cssInterop breaks jest's transform; same stub the other screen suites use.
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/hooks/useKeyboardHeight', () => ({ useKeyboardHeight: () => 0 }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: mockConfig }),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: unknown) => unknown) =>
    selector({ activeMode: mockActiveMode }),
}));
jest.mock('@/store/useCustomPromptsStore', () => ({
  useCustomPromptsStore: (selector: (state: unknown) => unknown) =>
    selector({
      customPrompts: { cleanup: mockStoredPrompt },
      setCustomPrompt: mockSetCustomPrompt,
      resetCustomPrompt: mockResetCustomPrompt,
    }),
}));

import CleanupPromptScreen from '../CleanupPromptScreen';

const CUSTOM = 'Always use bullet points, {{agentName}}.';
const NOTICE = /requires Cloud mode with Dictation Cleanup turned on/;
const PLACEHOLDER_CAUTION = /\{\{agentName\}\} is missing/;

const editor = () => screen.getByLabelText('Cleanup prompt');

beforeEach(() => {
  jest.clearAllMocks();
  mockStoredPrompt = '';
  mockConfig = { defaultMode: 'cloud', cleanupEnabled: true };
  mockActiveMode = 'cloud';
});

describe('CleanupPromptScreen — editing', () => {
  it('seeds the editor with the shipped default when nothing is stored', () => {
    render(<CleanupPromptScreen />);
    expect(editor().props.value).toBe(DEFAULT_CLEANUP_PROMPT);
  });

  it('seeds the editor with the stored override', () => {
    mockStoredPrompt = CUSTOM;
    render(<CleanupPromptScreen />);
    expect(editor().props.value).toBe(CUSTOM);
  });

  it('ignores Save while the draft is unchanged', () => {
    render(<CleanupPromptScreen />);
    fireEvent.press(screen.getByText('Save Prompt'));
    expect(mockSetCustomPrompt).not.toHaveBeenCalled();
  });

  it('saves an edited draft verbatim', () => {
    render(<CleanupPromptScreen />);
    fireEvent.changeText(editor(), CUSTOM);
    fireEvent.press(screen.getByText('Save Prompt'));
    expect(mockSetCustomPrompt).toHaveBeenCalledWith('cleanup', CUSTOM);
  });

  it('saves "" when the draft is put back to the shipped default', () => {
    mockStoredPrompt = CUSTOM;
    render(<CleanupPromptScreen />);
    fireEvent.changeText(editor(), DEFAULT_CLEANUP_PROMPT);
    fireEvent.press(screen.getByText('Save Prompt'));
    expect(mockSetCustomPrompt).toHaveBeenCalledWith('cleanup', '');
  });
});

describe('CleanupPromptScreen — guidance', () => {
  it('warns when the agent-name placeholder is removed, and not otherwise', () => {
    render(<CleanupPromptScreen />);
    expect(screen.queryByText(PLACEHOLDER_CAUTION)).toBeNull();
    fireEvent.changeText(editor(), 'Clean the transcript.');
    expect(screen.getByText(PLACEHOLDER_CAUTION)).toBeTruthy();
  });

  it('shows the inactive notice in Private mode', () => {
    mockActiveMode = 'private';
    render(<CleanupPromptScreen />);
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  it('shows the inactive notice when cleanup is turned off', () => {
    mockConfig = { defaultMode: 'cloud', cleanupEnabled: false };
    render(<CleanupPromptScreen />);
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  it('hides the notice in Cloud mode with cleanup on', () => {
    render(<CleanupPromptScreen />);
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});

describe('CleanupPromptScreen — reset', () => {
  it('confirms, then clears the override and shows the default', () => {
    mockStoredPrompt = CUSTOM;
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<CleanupPromptScreen />);

    fireEvent.press(screen.getByText('Reset to Default'));
    expect(mockResetCustomPrompt).not.toHaveBeenCalled();

    const buttons = alert.mock.calls[0][2] as { style?: string; onPress?: () => void }[];
    act(() => {
      buttons.find((button) => button.style === 'destructive')?.onPress?.();
    });

    expect(mockResetCustomPrompt).toHaveBeenCalledWith('cleanup');
    expect(editor().props.value).toBe(DEFAULT_CLEANUP_PROMPT);
    alert.mockRestore();
  });

  it('offers no reset while the shipped default is in use and untouched', () => {
    render(<CleanupPromptScreen />);
    expect(screen.queryByText('Reset to Default')).toBeNull();
  });
});
