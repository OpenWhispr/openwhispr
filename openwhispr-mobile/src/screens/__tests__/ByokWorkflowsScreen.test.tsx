import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockClearCredentials = jest.fn().mockResolvedValue(undefined);
let mockActiveMode = 'cloud';
let mockConfig: Record<string, unknown> | null = null;
const mockCredentialStatus = jest.fn();
let mockCredentialListener: (() => void) | null = null;

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: mockConfig }),
}));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: { getState: () => ({ user: null }) } }));
jest.mock('@/lib/privateMode', () => ({}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: unknown) => unknown) =>
    selector({ activeMode: mockActiveMode }),
}));
jest.mock('@/services/providers/ProviderCredentials', () => ({
  clearProviderCredentials: (...args: unknown[]) => mockClearCredentials(...args),
  getProviderCredentialReference: jest.fn(async (providerId: string) => `provider.${providerId}`),
  getProviderCredentialStatus: (...args: unknown[]) => mockCredentialStatus(...args),
  subscribeProviderCredentialChanges: (listener: () => void) => {
    mockCredentialListener = listener;
    return () => {
      mockCredentialListener = null;
    };
  },
}));

import { ByokWorkflowsScreen } from '../ByokWorkflowsScreen';

beforeEach(() => {
  jest.clearAllMocks();
  mockActiveMode = 'cloud';
  mockConfig = null;
  mockCredentialStatus.mockResolvedValue({ isConfigured: true });
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

it('shows what each workflow really does while On-Device mode is on', () => {
  mockActiveMode = 'private';
  mockConfig = {
    defaultMode: 'private',
    inference: {
      dictation: { mode: 'local' },
      upload: { mode: 'providers', providerId: 'openai', modelId: 'whisper-1' },
      cleanup: { mode: 'openwhispr' },
    },
  };
  render(<ByokWorkflowsScreen />);
  // Dictation, uploads and note formatting stay on the phone whatever is saved.
  expect(screen.getAllByText('On-Device')).toHaveLength(3);
  expect(screen.queryByText('OpenAI')).not.toBeOnTheScreen();
  // On-Device transcripts stay raw, so cleanup never runs.
  expect(screen.getByText('Skipped')).toBeTruthy();
  // Note chat keeps its own selection, which is OpenWhispr Cloud when unset.
  expect(screen.getByText('OpenWhispr Cloud')).toBeTruthy();
});

it('shows provider note chat as On-Device, which answers it on this iPhone first', () => {
  mockActiveMode = 'private';
  mockCredentialStatus.mockResolvedValue({ isConfigured: true });
  mockConfig = {
    defaultMode: 'private',
    inference: { agent: { mode: 'providers', providerId: 'groq', modelId: 'llama' } },
  };
  render(<ByokWorkflowsScreen />);
  expect(screen.getAllByText('On-Device')).toHaveLength(4);
  expect(screen.queryByText('Groq')).not.toBeOnTheScreen();
});

it('flags a provider workflow whose key was removed', async () => {
  mockActiveMode = 'providers';
  mockConfig = {
    defaultMode: 'providers',
    inference: {
      dictation: { mode: 'providers', providerId: 'openai', modelId: 'whisper-1' },
      cleanup: { mode: 'providers', providerId: 'groq', modelId: 'llama' },
    },
  };
  mockCredentialStatus.mockImplementation(async (reference: string) => ({
    reference,
    isConfigured: reference !== 'provider.openai',
  }));
  render(<ByokWorkflowsScreen />);
  expect(await screen.findByText('OpenAI · Key missing')).toBeTruthy();
  expect(screen.getByText('Groq')).toBeTruthy();

  mockCredentialStatus.mockResolvedValue({ isConfigured: false });
  mockCredentialListener?.();
  expect(await screen.findByText('Groq · Key missing')).toBeTruthy();
});

it('does not list workflows on Android', () => {
  const platform = require('react-native').Platform;
  const original = platform.OS;
  platform.OS = 'android';
  try {
    render(<ByokWorkflowsScreen />);
    expect(screen.queryByText('Remove all provider keys')).not.toBeOnTheScreen();
    expect(screen.getByText(/Provider setup is available on iOS/)).toBeTruthy();
  } finally {
    platform.OS = original;
  }
});
