import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockRouterPush = jest.fn();
let mockStoredPrompt = '';

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
}));
// nativewind's cssInterop breaks jest's transform; same stub the other screen suites use.
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: null }),
}));
jest.mock('@/hooks/useConfigToggle', () => ({ useConfigToggle: () => jest.fn() }));
jest.mock('@/store/useCustomPromptsStore', () => ({
  useCustomPromptsStore: (selector: (state: unknown) => unknown) =>
    selector({ customPrompts: { cleanup: mockStoredPrompt } }),
}));

import DictationCleanupScreen from '../DictationCleanupScreen';

beforeEach(() => {
  jest.clearAllMocks();
  mockStoredPrompt = '';
});

describe('DictationCleanupScreen — Cleanup Prompt entry point', () => {
  it('shows the prompt row as Default when no override is stored', () => {
    render(<DictationCleanupScreen />);
    expect(screen.getByText('Cleanup Prompt')).toBeTruthy();
    expect(screen.getByText('Default')).toBeTruthy();
  });

  it('shows the prompt row as Custom when an override is stored', () => {
    mockStoredPrompt = 'Always use bullet points.';
    render(<DictationCleanupScreen />);
    expect(screen.getByText('Custom')).toBeTruthy();
  });

  it('opens the prompt editor', () => {
    render(<DictationCleanupScreen />);
    fireEvent.press(screen.getByText('Cleanup Prompt'));
    expect(mockRouterPush).toHaveBeenCalledWith('/(account)/cleanup-prompt');
  });
});
