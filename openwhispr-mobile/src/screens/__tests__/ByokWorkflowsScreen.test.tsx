import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockClearCredentials = jest.fn().mockResolvedValue(undefined);
let mockActiveMode = 'cloud';
let mockConfig: Record<string, unknown> | null = null;

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: mockConfig }),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: unknown) => unknown) =>
    selector({ activeMode: mockActiveMode }),
}));
jest.mock('@/services/providers/ProviderCredentials', () => ({
  clearProviderCredentials: (...args: unknown[]) => mockClearCredentials(...args),
}));

import { ByokWorkflowsScreen } from '../ByokWorkflowsScreen';

beforeEach(() => {
  jest.clearAllMocks();
  mockActiveMode = 'cloud';
  mockConfig = null;
});

it('shows what each workflow runs, naming the provider for Bring Your Own Key', () => {
  mockActiveMode = 'providers';
  mockConfig = {
    defaultMode: 'providers',
    inference: {
      dictation: { mode: 'providers', providerId: 'openai', modelId: 'whisper-1' },
      upload: { mode: 'local' },
      notes: { mode: 'openwhispr' },
      agent: { mode: 'providers', providerId: 'custom', modelId: 'llama' },
    },
  };
  render(<ByokWorkflowsScreen />);
  expect(screen.getByText('OpenAI')).toBeTruthy();
  expect(screen.getByText('On-Device')).toBeTruthy();
  // Bring Your Own Key dictation skips cleanup until a provider is saved for it.
  expect(screen.getByText('Not set')).toBeTruthy();
  expect(screen.getByText('OpenWhispr Cloud')).toBeTruthy();
  expect(screen.getByText('Custom server')).toBeTruthy();
  expect(screen.queryByText(/Meeting/)).toBeNull();
});

it('opens the tapped workflow on its own page', () => {
  render(<ByokWorkflowsScreen />);
  fireEvent.press(screen.getByText('Text Cleanup'));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/(account)/provider-workflow',
    params: { scope: 'cleanup' },
  });
});

it('removes every saved provider key after confirmation', async () => {
  jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons) => buttons?.[1]?.onPress?.());
  render(<ByokWorkflowsScreen />);
  fireEvent.press(screen.getByText('Remove all provider keys'));
  await screen.findByText('All provider keys were removed.');
  expect(mockClearCredentials).toHaveBeenCalledTimes(1);
});
