import React from 'react';
import { Alert, Platform } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockClearCredentials = jest.fn().mockResolvedValue(undefined);
let mockActiveMode = 'cloud';
let mockConfig: Record<string, unknown> | null = null;
const mockCredentialStatus = jest.fn();
let mockCredentialListener: (() => void) | null = null;
const MockText = require('react-native').Text;

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }));
jest.mock('@/components/ui/Toast', () => ({
  Toast: ({ message, visible, type }: { message: string; visible: boolean; type: string }) =>
    visible ? <MockText testID={`toast-${type}`}>{message}</MockText> : null,
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: mockConfig }),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: unknown) => unknown) =>
    selector({ activeMode: mockActiveMode }),
}));
jest.mock('@/hooks/useConfigToggle', () => ({ useConfigToggle: () => jest.fn() }));
jest.mock('@/lib/localReasoning', () => ({
  getLocalReasoningReadiness: jest.fn(async () => ({ status: 'ready', tokenCounting: false })),
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

import AIModelsScreen from '../AIModelsScreen';

const originalPlatform = Platform.OS;

beforeEach(() => {
  jest.clearAllMocks();
  mockActiveMode = 'cloud';
  mockConfig = null;
  Platform.OS = 'ios';
  mockCredentialStatus.mockResolvedValue({ isConfigured: true });
});

afterAll(() => {
  Platform.OS = originalPlatform;
});

it('shows what each workflow runs, naming the provider or on-device model', async () => {
  mockActiveMode = 'providers';
  mockConfig = {
    defaultMode: 'providers',
    inference: {
      dictation: { mode: 'providers', providerId: 'openai', modelId: 'whisper-1' },
      upload: { mode: 'local', modelId: 'whisper-base' },
      notes: { mode: 'openwhispr' },
      agent: { mode: 'providers', providerId: 'custom', modelId: 'llama' },
    },
  };
  render(<AIModelsScreen />);
  expect(screen.getByText('OpenAI')).toBeTruthy();
  expect(screen.getByText('Whisper base')).toBeTruthy();
  // Bring Your Own Key dictation skips cleanup until a provider is saved for it.
  expect(screen.getByText('Not set')).toBeTruthy();
  expect(screen.getByText('OpenWhispr Cloud')).toBeTruthy();
  expect(screen.getByText('Custom server')).toBeTruthy();
  expect(screen.queryByText(/Meeting/)).toBeNull();
  await screen.findByText(/Status: Ready/);
});

it('opens the tapped workflow on its own page', async () => {
  render(<AIModelsScreen />);
  fireEvent.press(screen.getByText('Text Cleanup'));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/(account)/ai-workflow',
    params: { scope: 'cleanup' },
  });
  await screen.findByText(/Status: Ready/);
});

it('keeps the meeting speaker model with the other on-device settings', async () => {
  render(<AIModelsScreen />);
  fireEvent.press(screen.getByText('Speaker Separation'));
  expect(mockPush).toHaveBeenCalledWith('/(account)/diarization-model');
  expect(screen.getByText('Local Apple Intelligence')).toBeTruthy();
  await screen.findByText(/Status: Ready/);
});

it('removes every saved provider key after confirmation', async () => {
  jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons) => buttons?.[1]?.onPress?.());
  render(<AIModelsScreen />);
  fireEvent.press(screen.getByText('Remove All Provider Keys'));
  expect(await screen.findByTestId('toast-success')).toHaveTextContent(
    'All provider keys were removed.',
  );
  expect(mockClearCredentials).toHaveBeenCalledTimes(1);
});

it('has no provider keys to remove on Android', async () => {
  Platform.OS = 'android';
  render(<AIModelsScreen />);
  expect(screen.getByText('Dictation & Keyboard')).toBeTruthy();
  expect(screen.queryByText('Remove All Provider Keys')).toBeNull();
  await screen.findByText(/Status: Ready/);
});

it('shows what each workflow really does while On-Device mode is on', async () => {
  mockActiveMode = 'private';
  mockConfig = {
    defaultMode: 'private',
    inference: {
      dictation: { mode: 'local', modelId: 'whisper-base' },
      upload: { mode: 'providers', providerId: 'openai', modelId: 'whisper-1' },
      cleanup: { mode: 'openwhispr' },
    },
  };
  render(<AIModelsScreen />);
  // A picked model keeps its name; uploads stay on the phone whatever is saved.
  expect(screen.getByText('Whisper base')).toBeTruthy();
  expect(screen.queryByText('OpenAI')).toBeNull();
  // On-Device transcripts stay raw, so cleanup never runs.
  expect(screen.getByText('Skipped')).toBeTruthy();
  // Note chat keeps its own selection, which is OpenWhispr Cloud when unset.
  expect(screen.getByText('OpenWhispr Cloud')).toBeTruthy();
  await screen.findByText(/Status: Ready/);
});

it('shows provider note chat as On-Device, which answers it on this iPhone first', async () => {
  mockActiveMode = 'private';
  mockCredentialStatus.mockResolvedValue({ isConfigured: true });
  mockConfig = {
    defaultMode: 'private',
    inference: { agent: { mode: 'providers', providerId: 'groq', modelId: 'llama' } },
  };
  render(<AIModelsScreen />);
  expect(screen.queryByText('Groq')).toBeNull();
  expect(screen.queryByText('OpenWhispr Cloud')).toBeNull();
  await screen.findByText(/Status: Ready/);
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
  render(<AIModelsScreen />);
  expect(await screen.findByText('OpenAI · Key missing')).toBeTruthy();
  expect(screen.getByText('Groq')).toBeTruthy();

  mockCredentialStatus.mockResolvedValue({ isConfigured: false });
  mockCredentialListener?.();
  expect(await screen.findByText('Groq · Key missing')).toBeTruthy();
});
