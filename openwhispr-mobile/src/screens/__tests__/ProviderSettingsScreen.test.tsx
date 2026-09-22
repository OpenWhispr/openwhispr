import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockUpdateConfig = jest.fn().mockResolvedValue(undefined);
const mockSetActiveMode = jest.fn();
const mockSetCredential = jest.fn().mockResolvedValue(undefined);
const mockRemoveCredential = jest.fn().mockResolvedValue(undefined);
const mockTestConnection = jest.fn();
const mockDiscoverModels = jest.fn();
const mockPolicy = jest.fn();
let mockActiveMode = 'cloud';
const mockCredentialStatus = jest.fn().mockResolvedValue({ isConfigured: false });
let mockConfig: Record<string, unknown> | null = null;

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GradientGlassSurface', () => ({ GradientGlassSurface: () => null }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ config: mockConfig, updateConfig: mockUpdateConfig }),
    { getState: () => ({ config: mockConfig, error: null }) },
  ),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: unknown) => unknown) =>
    selector({ setActiveMode: mockSetActiveMode, activeMode: mockActiveMode }),
}));
jest.mock('@/services/providers/ProviderExecution', () => ({
  discoverProviderModels: (...args: unknown[]) => mockDiscoverModels(...args),
  testProviderConnection: (...args: unknown[]) => mockTestConnection(...args),
  ProviderExecutionError: class ProviderExecutionError extends Error {},
}));
jest.mock('@/services/providers/ProviderPolicy', () => ({
  getProviderPolicy: () => mockPolicy(),
}));
jest.mock('@/services/providers/ProviderCredentials', () => ({
  getProviderCredentialReference: jest.fn(async (providerId: string) => `provider.${providerId}`),
  getProviderCredentialStatus: (...args: unknown[]) => mockCredentialStatus(...args),
  setProviderCredential: (...args: unknown[]) => mockSetCredential(...args),
  removeProviderCredential: (...args: unknown[]) => mockRemoveCredential(...args),
}));

import { ProviderSettingsScreen } from '../ProviderSettingsScreen';

function chooseProvider(provider: string): void {
  fireEvent.press(screen.getByText('Provider'));
  fireEvent.press(screen.getByText(provider));
}

function enableProviders(): void {
  fireEvent.press(screen.getByText('Inference mode'));
  fireEvent.press(screen.getByText('Providers'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = null;
  mockActiveMode = 'cloud';
  mockPolicy.mockResolvedValue({ status: 'unmanaged' });
  mockTestConnection.mockResolvedValue({ ok: true, verification: 'catalog-only' });
  mockDiscoverModels.mockResolvedValue({
    models: [{ id: 'server-model', name: 'Server Model' }],
    verification: 'catalog-only',
  });
  mockCredentialStatus.mockResolvedValue({ isConfigured: false });
});

it('lets a signed-out user save a secure credential reference without persisting the key', async () => {
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.changeText(screen.getByLabelText('API key'), 'test-key-value');
  fireEvent.press(screen.getByText('Save selection'));
  await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
  expect(mockSetCredential).toHaveBeenCalledWith('provider.openai', { apiKey: 'test-key-value' });
  expect(mockUpdateConfig.mock.calls[0][0]).toMatchObject({
    defaultMode: 'providers',
    inference: {
      dictation: { mode: 'providers', providerId: 'openai', credentialRef: 'provider.openai' },
    },
  });
  expect(JSON.stringify(mockUpdateConfig.mock.calls)).not.toContain('test-key-value');
  expect(mockSetActiveMode).toHaveBeenCalledWith('providers', true);
  expect(screen.getByLabelText('API key').props.value).toBe('');
});

it('rejects public HTTP endpoints before storing a credential', async () => {
  render(<ProviderSettingsScreen />);
  enableProviders();
  chooseProvider('Custom');
  fireEvent.changeText(screen.getByLabelText('Endpoint URL'), 'http://example.com/v1');
  fireEvent.changeText(screen.getByLabelText('Model ID'), 'custom-model');
  fireEvent.changeText(screen.getByLabelText('API key'), 'test-key-value');
  fireEvent.press(screen.getByText('Save selection'));
  await screen.findByText('Use HTTPS, or HTTP for a private-network host.');
  expect(mockSetCredential).not.toHaveBeenCalled();
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('keeps model choices separate when switching providers and clears credential input', async () => {
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.press(screen.getByText('Model'));
  fireEvent.press(screen.getByText('Whisper'));
  fireEvent.changeText(screen.getByLabelText('API key'), 'first-provider-key');
  chooseProvider('Groq');
  expect(screen.getByLabelText('API key').props.value).toBe('');
  chooseProvider('OpenAI');
  expect(screen.getByText('Whisper')).toBeTruthy();
});

it('saves custom endpoints without requiring an API key and preserves other scopes', async () => {
  mockConfig = { defaultMode: 'cloud', inference: { cleanup: { mode: 'local' } } };
  render(<ProviderSettingsScreen />);
  enableProviders();
  chooseProvider('Custom');
  fireEvent.changeText(screen.getByLabelText('Endpoint URL'), 'http://192.168.1.2:8080/v1/');
  fireEvent.changeText(screen.getByLabelText('Model ID'), 'local-model');
  fireEvent.press(screen.getByText('Save selection'));
  await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
  expect(mockSetCredential).not.toHaveBeenCalled();
  expect(mockUpdateConfig.mock.calls[0][0].inference).toMatchObject({
    cleanup: { mode: 'local' },
    dictation: {
      providerId: 'custom',
      modelId: 'local-model',
      endpoint: 'http://192.168.1.2:8080/v1',
    },
  });
  expect(mockUpdateConfig.mock.calls[0][0].inference.dictation.credentialRef).toBeUndefined();
});

it('removes an existing credential and requires a replacement before saving', async () => {
  mockCredentialStatus.mockResolvedValue({ isConfigured: true });
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.press(await screen.findByText('Remove credential'));
  await waitFor(() => expect(mockRemoveCredential).toHaveBeenCalledWith('provider.openai'));
  mockCredentialStatus.mockResolvedValue({ isConfigured: false });
  fireEvent.press(screen.getByText('Save selection'));
  await screen.findByText('Enter a credential for this provider.');
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('lists only the supported providers and no Live Meetings workflow', () => {
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.press(screen.getByText('Provider'));
  // OpenAI is both the selected row's subtitle and a picker choice.
  expect(screen.getAllByText('OpenAI')).toHaveLength(2);
  expect(screen.getByText('Groq')).toBeTruthy();
  expect(screen.getByText('Custom')).toBeTruthy();
  expect(screen.queryByText('Corti')).toBeNull();
  expect(screen.queryByText('Tinfoil')).toBeNull();
  fireEvent.press(screen.getByText('Workflow'));
  expect(screen.queryByText('Live Meetings')).toBeNull();
});

it('saves text workflow selection independently from the dictation mode', async () => {
  mockConfig = { defaultMode: 'private', inference: { dictation: { mode: 'local' } } };
  render(<ProviderSettingsScreen />);
  fireEvent.press(screen.getByText('Workflow'));
  fireEvent.press(screen.getByText('Text Cleanup'));
  enableProviders();
  chooseProvider('Groq');
  fireEvent.changeText(screen.getByLabelText('API key'), 'test-text-key');
  fireEvent.press(screen.getByText('Save selection'));
  await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
  expect(mockUpdateConfig.mock.calls[0][0]).toMatchObject({
    inference: {
      dictation: { mode: 'local' },
      cleanup: { mode: 'providers', providerId: 'groq' },
    },
  });
  expect(mockUpdateConfig.mock.calls[0][0].defaultMode).toBeUndefined();
  expect(mockSetActiveMode).not.toHaveBeenCalled();
});

it('restores a provider model saved in an earlier settings session', async () => {
  mockConfig = {
    defaultMode: 'cloud',
    rememberedInference: {
      dictation: { openai: { mode: 'providers', providerId: 'openai', modelId: 'whisper-1' } },
    },
  };
  render(<ProviderSettingsScreen />);
  enableProviders();
  chooseProvider('Groq');
  chooseProvider('OpenAI');
  // The current session's untouched default must not overwrite a saved provider choice.
  expect(screen.getByText('Whisper')).toBeTruthy();
});

it('does not expose provider setup on Android', () => {
  const platform = require('react-native').Platform;
  const original = platform.OS;
  platform.OS = 'android';
  try {
    render(<ProviderSettingsScreen />);
    expect(screen.queryByText('Save selection')).toBeNull();
    expect(screen.getByText(/Provider setup is available on iOS/)).toBeTruthy();
  } finally {
    platform.OS = original;
  }
});

it('reports catalog-only checks without claiming inference access or changing the workflow', async () => {
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.changeText(screen.getByLabelText('API key'), 'test-key');
  fireEvent.press(screen.getByText('Check connection'));
  await screen.findByText(
    'Model catalog accessible. Transcription and inference access have not been verified.',
  );
  expect(mockTestConnection).toHaveBeenCalledWith(
    expect.objectContaining({
      route: expect.objectContaining({
        scope: 'dictation',
        providerId: 'openai',
        credentialRef: 'provider.openai',
      }),
    }),
  );
  expect(mockUpdateConfig).not.toHaveBeenCalled();
  expect(mockSetActiveMode).not.toHaveBeenCalled();
});

it('blocks diagnostic network calls when organization policy is unresolved', async () => {
  mockPolicy.mockResolvedValue({ status: 'pending' });
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.changeText(screen.getByLabelText('API key'), 'test-key');
  fireEvent.press(screen.getByText('Check connection'));
  await screen.findByText('Organization policy does not currently permit this provider check.');
  expect(mockTestConnection).not.toHaveBeenCalled();
});

it('discovers custom models before choosing a model, without silently selecting one', async () => {
  render(<ProviderSettingsScreen />);
  enableProviders();
  chooseProvider('Custom');
  fireEvent.changeText(screen.getByLabelText('Endpoint URL'), 'https://example.com/v1');
  fireEvent.press(screen.getByText('Discover models'));
  await screen.findByText('Model catalog loaded. Inference access has not been verified.');
  expect(screen.getByLabelText('Model ID').props.value).toBe('');
  fireEvent.press(screen.getByText('Model'));
  fireEvent.press(screen.getByText('Server Model'));
  expect(screen.getByLabelText('Model ID').props.value).toBe('server-model');
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});
