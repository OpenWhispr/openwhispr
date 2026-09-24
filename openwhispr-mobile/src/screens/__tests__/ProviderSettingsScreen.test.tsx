import React from 'react';
import { Alert, Keyboard, ScrollView } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

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
let mockScope: string | undefined;
let mockModeParam: string | undefined;
let mockUser: { id: string } | null = { id: 'user-1' };
const mockPrivateReadiness = jest.fn();
const mockPreventRemove = jest.fn();
const mockDispatch = jest.fn();
const mockLocalReasoningReadiness = jest.fn();
const MockText = require('react-native').Text;

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GradientGlassSurface', () => ({ GradientGlassSurface: () => null }));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ scope: mockScope, mode: mockModeParam }),
  router: { push: jest.fn() },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ user: mockUser }),
    { getState: () => ({ user: mockUser }) },
  ),
}));
jest.mock('@/lib/privateMode', () => ({
  getPrivateModeReadiness: () => mockPrivateReadiness(),
  getPrivateModeUnavailableMessage: () => 'Native modules are missing.',
}));
jest.mock('@/lib/localReasoning', () => ({
  getLocalReasoningReadiness: () => mockLocalReasoningReadiness(),
  getLocalReasoningUnavailableMessage: () =>
    'Local Apple Intelligence is unavailable on this device.',
}));
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ dispatch: mockDispatch }),
  usePreventRemove: (...args: unknown[]) => mockPreventRemove(...args),
}));
jest.mock('@/components/ui/Toast', () => ({
  Toast: ({
    message,
    visible,
    type,
    showId,
  }: {
    message: string;
    visible: boolean;
    type: string;
    showId?: number;
  }) =>
    visible ? (
      <MockText testID={`toast-${type}`} accessibilityHint={`show ${showId}`}>
        {message}
      </MockText>
    ) : null,
}));
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
const mockGetCredential = jest.fn().mockResolvedValue(null);
jest.mock('@/services/providers/ProviderCredentials', () => ({
  getProviderCredentialReference: jest.fn(async (providerId: string, endpoint?: string) =>
    providerId === 'custom' ? `custom.${endpoint}` : `provider.${providerId}`,
  ),
  getProviderCredential: (...args: unknown[]) => mockGetCredential(...args),
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
  fireEvent.press(screen.getByText('Bring Your Own Key'));
}

function selectedMode(): string | undefined {
  return ['OpenWhispr Cloud', 'On-Device', 'Bring Your Own Key'].find((title) => {
    let row = screen.getByText(title).parent;
    while (row && !row.props.accessibilityState) row = row.parent;
    return row?.props.accessibilityState.selected;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = null;
  mockScope = 'dictation';
  mockModeParam = undefined;
  mockActiveMode = 'cloud';
  mockUser = { id: 'user-1' };
  mockPrivateReadiness.mockResolvedValue({ status: 'ready', modelName: 'Parakeet v3' });
  mockLocalReasoningReadiness.mockResolvedValue({ status: 'ready', tokenCounting: false });
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

it('lists only the supported providers', async () => {
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.press(screen.getByText('Provider'));
  // OpenAI is both the selected row's subtitle and a picker choice.
  expect(screen.getAllByText('OpenAI')).toHaveLength(2);
  expect(screen.getByText('Groq')).toBeTruthy();
  expect(screen.getByText('Custom')).toBeTruthy();
  expect(screen.queryByText('Corti')).toBeNull();
  expect(screen.queryByText('Tinfoil')).toBeNull();
  await waitFor(() => expect(mockCredentialStatus).toHaveBeenCalled());
});

it('saves text workflow selection independently from the dictation mode', async () => {
  mockConfig = { defaultMode: 'private', inference: { dictation: { mode: 'local' } } };
  mockScope = 'cleanup';
  render(<ProviderSettingsScreen />);
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
  expect(await screen.findByTestId('toast-info')).toHaveTextContent(
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
  expect(mockTestConnection).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-key' }));
  expect(mockSetCredential).not.toHaveBeenCalled();
  expect(mockUpdateConfig).not.toHaveBeenCalled();
  expect(mockSetActiveMode).not.toHaveBeenCalled();
});

it('offers to replace or remove a saved key that can no longer be read', async () => {
  mockCredentialStatus.mockRejectedValue(new Error('unreadable'));
  render(<ProviderSettingsScreen />);
  enableProviders();
  await screen.findByText('Remove credential');
  fireEvent.changeText(screen.getByLabelText('API key'), 'replacement-key');
  fireEvent.press(screen.getByText('Save selection'));
  await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
  expect(mockSetCredential).toHaveBeenCalledWith('provider.openai', { apiKey: 'replacement-key' });
});

it('blocks diagnostic network calls when organization policy is unresolved', async () => {
  mockPolicy.mockResolvedValue({ status: 'pending' });
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.changeText(screen.getByLabelText('API key'), 'test-key');
  fireEvent.press(screen.getByText('Check connection'));
  expect(await screen.findByTestId('toast-error')).toHaveTextContent(
    'Organization policy does not currently permit this provider check.',
  );
  expect(mockTestConnection).not.toHaveBeenCalled();
});

it('reports a passing inference check as a success toast', async () => {
  mockTestConnection.mockResolvedValue({ ok: true, verification: 'inference' });
  mockScope = 'cleanup';
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.changeText(screen.getByLabelText('API key'), 'test-key');
  fireEvent.press(screen.getByText('Check connection'));
  expect(await screen.findByTestId('toast-success')).toHaveTextContent(
    'Connection works. Save to use it.',
  );
});

it('reports a check without a key as an error toast and closes the keyboard', async () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.press(screen.getByText('Check connection'));
  expect(dismiss).toHaveBeenCalled();
  expect(await screen.findByTestId('toast-error')).toHaveTextContent(
    'Enter a credential for this provider.',
  );
  expect(mockTestConnection).not.toHaveBeenCalled();
});

it('closes the keyboard when a key is pasted, but not while typing', () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  render(<ProviderSettingsScreen />);
  enableProviders();
  const input = screen.getByLabelText('API key');
  fireEvent.changeText(input, 's');
  fireEvent.changeText(input, 'sk');
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.changeText(input, 'sk-pasted-provider-key');
  expect(dismiss).toHaveBeenCalledTimes(1);
});

it('checks a provider from On-Device mode, since a check sends no user content', async () => {
  mockActiveMode = 'private';
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.changeText(screen.getByLabelText('API key'), 'test-key');
  fireEvent.press(screen.getByText('Check connection'));
  await screen.findByTestId('toast-info');
  expect(mockTestConnection).toHaveBeenCalled();
});

it('shows cleanup as waiting for a provider when Bring Your Own Key dictation will skip it', async () => {
  mockConfig = {
    defaultMode: 'providers',
    inference: { dictation: { mode: 'providers', providerId: 'openai', modelId: 'whisper-1' } },
  };
  mockActiveMode = 'providers';
  mockScope = 'cleanup';
  render(<ProviderSettingsScreen />);
  expect(selectedMode()).toBe('Bring Your Own Key');
  expect(
    screen.getByText('Not saved yet. Cleanup is skipped until you save a selection.'),
  ).toBeTruthy();
});

it('shows a guest held in On-Device mode as On-Device, not a stale Cloud preference', () => {
  mockConfig = { defaultMode: 'cloud' };
  mockActiveMode = 'private';
  render(<ProviderSettingsScreen />);
  expect(selectedMode()).toBe('On-Device');
});

it('discovers custom models before choosing a model, without silently selecting one', async () => {
  render(<ProviderSettingsScreen />);
  enableProviders();
  chooseProvider('Custom');
  fireEvent.changeText(screen.getByLabelText('Endpoint URL'), 'https://example.com/v1');
  fireEvent.press(screen.getByText('Discover models'));
  expect(await screen.findByTestId('toast-info')).toHaveTextContent(
    'Model catalog loaded. Inference access has not been verified.',
  );
  expect(screen.getByLabelText('Model ID').props.value).toBe('');
  fireEvent.press(screen.getByText('Model'));
  fireEvent.press(screen.getByText('Server Model'));
  expect(screen.getByLabelText('Model ID').props.value).toBe('server-model');
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('defaults an unselected workflow to On-Device for a private-mode user', () => {
  mockConfig = { defaultMode: 'private' };
  mockActiveMode = 'private';
  mockScope = 'upload';
  render(<ProviderSettingsScreen />);
  expect(selectedMode()).toBe('On-Device');
});

it('keeps uploads on the previous mode when dictation switches to Bring Your Own Key', async () => {
  mockConfig = { defaultMode: 'private' };
  mockActiveMode = 'private';
  mockCredentialStatus.mockResolvedValue({ isConfigured: true });
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.press(screen.getByText('Save selection'));
  await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
  const saved = mockUpdateConfig.mock.calls[0][0] as {
    inference: Record<string, { mode: string }>;
  };
  expect(saved.inference.dictation.mode).toBe('providers');
  expect(saved.inference.upload).toEqual({ mode: 'local' });
});

it('keeps notes and chat on this phone when dictation leaves On-Device for a provider', async () => {
  mockConfig = { defaultMode: 'private' };
  mockActiveMode = 'private';
  mockCredentialStatus.mockResolvedValue({ isConfigured: true });
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.press(screen.getByText('Save selection'));
  await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
  expect(mockUpdateConfig.mock.calls[0][0]).toMatchObject({
    inference: { notes: { mode: 'local' }, agent: { mode: 'local' } },
    pinnedInference: ['upload', 'notes', 'agent'],
  });
});

it('releases the upload pin when dictation moves from Bring Your Own Key to Cloud', async () => {
  mockConfig = {
    defaultMode: 'providers',
    inference: {
      dictation: { mode: 'providers', providerId: 'openai', modelId: 'whisper-1' },
      upload: { mode: 'local' },
    },
    pinnedInference: ['upload'],
  };
  mockActiveMode = 'providers';
  render(<ProviderSettingsScreen />);
  fireEvent.press(screen.getByText('OpenWhispr Cloud'));
  fireEvent.press(screen.getByText('Save selection'));
  await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
  const saved = mockUpdateConfig.mock.calls[0][0] as {
    inference: Record<string, { mode: string } | undefined>;
  };
  expect(saved.inference.dictation).toEqual({ mode: 'openwhispr' });
  expect(saved.inference.upload).toBeUndefined();
});

it('pins uploads to the mode the app is in, not a stale saved Cloud preference', async () => {
  mockConfig = { defaultMode: 'cloud' };
  mockActiveMode = 'private';
  mockCredentialStatus.mockResolvedValue({ isConfigured: true });
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.press(screen.getByText('Save selection'));
  await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
  const saved = mockUpdateConfig.mock.calls[0][0] as {
    inference: Record<string, { mode: string }>;
  };
  expect(saved.inference.upload).toEqual({ mode: 'local' });
});

it('adds no pins when an existing user re-saves dictation with their own key', async () => {
  mockConfig = {
    defaultMode: 'providers',
    inference: {
      dictation: {
        mode: 'providers',
        providerId: 'groq',
        modelId: 'whisper-large-v3-turbo',
        credentialRef: 'provider.groq',
      },
    },
  };
  mockActiveMode = 'providers';
  mockCredentialStatus.mockResolvedValue({ isConfigured: true });
  render(<ProviderSettingsScreen />);
  // Dictation already opens in Bring Your Own Key mode for this config.
  chooseProvider('OpenAI');
  fireEvent.press(screen.getByText('Save selection'));
  await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
  const saved = mockUpdateConfig.mock.calls[0][0] as {
    inference: Record<string, { mode: string }>;
  };
  // Unsaved workflows already run where they will keep running; nothing is newly held.
  expect(saved.inference.upload).toBeUndefined();
  expect(saved.inference.notes).toBeUndefined();
});

it('explains that On-Device mode keeps a workflow on this phone, and still saves it', async () => {
  mockConfig = {
    defaultMode: 'private',
    inference: { upload: { mode: 'providers', providerId: 'openai', modelId: 'whisper-1' } },
  };
  mockActiveMode = 'private';
  mockScope = 'upload';
  mockCredentialStatus.mockResolvedValue({ isConfigured: true });
  render(<ProviderSettingsScreen />);
  expect(
    screen.getByText(
      'On-Device mode keeps this on your iPhone. Your choice applies when dictation leaves On-Device.',
    ),
  ).toBeTruthy();
  fireEvent.press(screen.getByText('Save selection'));
  await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
  expect(mockUpdateConfig.mock.calls[0][0].inference.upload).toMatchObject({
    providerId: 'openai',
  });
});

it('does not show the On-Device note on the Dictation page', () => {
  mockConfig = { defaultMode: 'private' };
  mockActiveMode = 'private';
  render(<ProviderSettingsScreen />);
  expect(screen.queryByText(/On-Device mode keeps this/)).not.toBeOnTheScreen();
});

describe('mode checks the other mode pickers run', () => {
  let alert: jest.SpyInstance;
  beforeEach(() => {
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  afterEach(() => alert.mockRestore());

  it('asks for the on-device model before switching dictation to On-Device', async () => {
    mockPrivateReadiness.mockResolvedValue({ status: 'missing', modelName: 'Parakeet v3' });
    render(<ProviderSettingsScreen />);
    fireEvent.press(screen.getByText('On-Device'));
    fireEvent.press(screen.getByText('Save selection'));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][0]).toBe('Download required');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    expect(mockSetActiveMode).not.toHaveBeenCalled();
  });

  it('asks a signed-out guest to sign in before saving Cloud dictation', async () => {
    mockUser = null;
    mockConfig = { defaultMode: 'private' };
    mockActiveMode = 'private';
    render(<ProviderSettingsScreen />);
    fireEvent.press(screen.getByText('OpenWhispr Cloud'));
    fireEvent.press(screen.getByText('Save selection'));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][0]).toBe('Sign in required');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('refuses On-Device cleanup where Apple Intelligence cannot run it', async () => {
    mockLocalReasoningReadiness.mockResolvedValue({ status: 'unavailable', tokenCounting: false });
    mockScope = 'cleanup';
    render(<ProviderSettingsScreen />);
    fireEvent.press(screen.getByText('On-Device'));
    fireEvent.press(screen.getByText('Save selection'));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0]).toEqual([
      'On-Device Unavailable',
      'Local Apple Intelligence is unavailable on this device.',
    ]);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('saves On-Device cleanup once Apple Intelligence is ready', async () => {
    mockScope = 'cleanup';
    render(<ProviderSettingsScreen />);
    fireEvent.press(screen.getByText('On-Device'));
    fireEvent.press(screen.getByText('Save selection'));
    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
    expect(mockUpdateConfig.mock.calls[0][0].inference.cleanup).toEqual({ mode: 'local' });
    expect(alert).not.toHaveBeenCalled();
  });
});

it('does not edit dictation settings from an unknown workflow link', () => {
  mockScope = 'meeting';
  render(<ProviderSettingsScreen />);
  expect(screen.getByText('This workflow is not available.')).toBeTruthy();
  expect(screen.queryByText('Save selection')).not.toBeOnTheScreen();
});

it('opens with Bring Your Own Key chosen when Speech to Text sent the user here for it', async () => {
  mockConfig = { defaultMode: 'cloud' };
  mockModeParam = 'providers';
  render(<ProviderSettingsScreen />);
  expect(selectedMode()).toBe('Bring Your Own Key');
  await waitFor(() => expect(mockCredentialStatus).toHaveBeenCalled());
});

it('restores the provider saved last when switching back to Bring Your Own Key', async () => {
  mockConfig = {
    defaultMode: 'cloud',
    inference: { dictation: { mode: 'openwhispr' } },
    rememberedInference: {
      dictation: {
        groq: { mode: 'providers', providerId: 'groq', modelId: 'whisper-large-v3-turbo' },
        openai: { mode: 'providers', providerId: 'openai', modelId: 'whisper-1' },
      },
    },
  };
  render(<ProviderSettingsScreen />);
  enableProviders();
  expect(screen.getByText('Groq')).toBeTruthy();
  await waitFor(() => expect(mockCredentialStatus).toHaveBeenCalled());
});

it('keeps the focused field and Save above the keyboard', async () => {
  render(<ProviderSettingsScreen />);
  const scroll = screen.UNSAFE_getByType(ScrollView);
  expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
  expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
});

it('asks before leaving with a checked but unsaved key', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  render(<ProviderSettingsScreen />);
  expect(mockPreventRemove).toHaveBeenLastCalledWith(false, expect.any(Function));
  enableProviders();
  fireEvent.changeText(screen.getByLabelText('API key'), 'unsaved-key');
  const [prevent, onPreventRemove] = mockPreventRemove.mock.calls.at(-1);
  expect(prevent).toBe(true);
  onPreventRemove({ data: { action: { type: 'GO_BACK' } } });
  expect(alert.mock.calls[0][0]).toBe('Discard unsaved changes?');
  const buttons = alert.mock.calls[0][2] ?? [];
  buttons.find((button) => button.text === 'Discard')?.onPress?.();
  expect(mockDispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
  alert.mockRestore();
  await waitFor(() => expect(mockCredentialStatus).toHaveBeenCalled());
});

it('lets the user leave freely once the selection is saved', async () => {
  mockCredentialStatus.mockResolvedValue({ isConfigured: true });
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.press(screen.getByText('Save selection'));
  await screen.findByText('Selection saved.');
  expect(mockPreventRemove).toHaveBeenLastCalledWith(false, expect.any(Function));
});

it('replays the toast when a check returns the same result again', async () => {
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.press(screen.getByText('Check connection'));
  const first = (await screen.findByTestId('toast-error')).props.accessibilityHint;
  fireEvent.press(screen.getByText('Check connection'));
  await waitFor(() =>
    expect(screen.getByTestId('toast-error').props.accessibilityHint).not.toBe(first),
  );
});

it('keeps an error toast up longer than a success toast', async () => {
  jest.useFakeTimers();
  try {
    render(<ProviderSettingsScreen />);
    enableProviders();
    fireEvent.press(screen.getByText('Check connection'));
    await screen.findByTestId('toast-error');
    act(() => jest.advanceTimersByTime(4000));
    expect(screen.getByTestId('toast-error')).toBeOnTheScreen();
    act(() => jest.advanceTimersByTime(3000));
    expect(screen.queryByTestId('toast-error')).not.toBeOnTheScreen();
  } finally {
    jest.useRealTimers();
  }
});

describe('a custom server reached under /v1', () => {
  const bare = 'http://192.168.1.2:11434';
  const withV1 = `${bare}/v1`;

  it('adopts the address that answered a check, so later requests use it', async () => {
    mockDiscoverModels.mockResolvedValue({
      models: [],
      verification: 'catalog-only',
      endpoint: withV1,
    });
    render(<ProviderSettingsScreen />);
    enableProviders();
    chooseProvider('Custom');
    fireEvent.changeText(screen.getByLabelText('Endpoint URL'), bare);
    fireEvent.changeText(screen.getByLabelText('Model ID'), 'local-model');
    fireEvent.press(screen.getByText('Discover models'));
    await waitFor(() => expect(screen.getByLabelText('Endpoint URL').props.value).toBe(withV1));
    fireEvent.press(screen.getByText('Save selection'));
    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
    expect(mockUpdateConfig.mock.calls[0][0].inference.dictation.endpoint).toBe(withV1);
  });

  it('keeps the key saved for the address the check replaced', async () => {
    mockConfig = {
      defaultMode: 'providers',
      inference: {
        dictation: {
          mode: 'providers',
          providerId: 'custom',
          modelId: 'local-model',
          endpoint: bare,
          credentialRef: `custom.${bare}`,
        },
      },
    };
    mockCredentialStatus.mockImplementation(async (reference: string) => ({
      reference,
      isConfigured: reference === `custom.${bare}`,
    }));
    mockGetCredential.mockImplementation(async (reference: string) =>
      reference === `custom.${bare}` ? { apiKey: 'saved-key' } : null,
    );
    mockTestConnection.mockResolvedValue({ ok: true, verification: 'inference', endpoint: withV1 });
    render(<ProviderSettingsScreen />);
    fireEvent.press(screen.getByText('Check connection'));
    await waitFor(() => expect(screen.getByLabelText('Endpoint URL').props.value).toBe(withV1));
    fireEvent.press(screen.getByText('Save selection'));
    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
    expect(mockSetCredential).toHaveBeenCalledWith(`custom.${withV1}`, { apiKey: 'saved-key' });
    expect(mockUpdateConfig.mock.calls[0][0].inference.dictation).toMatchObject({
      endpoint: withV1,
      credentialRef: `custom.${withV1}`,
    });
  });

  it('checks again with the saved key after the check moved the address', async () => {
    mockConfig = {
      defaultMode: 'providers',
      inference: {
        dictation: {
          mode: 'providers',
          providerId: 'custom',
          modelId: 'local-model',
          endpoint: bare,
          credentialRef: `custom.${bare}`,
        },
      },
    };
    mockCredentialStatus.mockImplementation(async (reference: string) => ({
      reference,
      isConfigured: reference === `custom.${bare}`,
    }));
    mockGetCredential.mockImplementation(async (reference: string) =>
      reference === `custom.${bare}` ? { apiKey: 'saved-key' } : null,
    );
    mockTestConnection.mockResolvedValue({ ok: true, verification: 'inference', endpoint: withV1 });
    render(<ProviderSettingsScreen />);
    fireEvent.press(screen.getByText('Check connection'));
    await waitFor(() => expect(screen.getByLabelText('Endpoint URL').props.value).toBe(withV1));
    fireEvent.press(screen.getByText('Check connection'));
    await waitFor(() => expect(mockTestConnection).toHaveBeenCalledTimes(2));
    expect(mockTestConnection.mock.calls[1][0]).toMatchObject({ apiKey: 'saved-key' });
    expect(mockSetCredential).not.toHaveBeenCalled();
  });

  it('never carries a saved key to a different server', async () => {
    mockConfig = {
      defaultMode: 'providers',
      inference: {
        dictation: {
          mode: 'providers',
          providerId: 'custom',
          modelId: 'local-model',
          endpoint: bare,
          credentialRef: `custom.${bare}`,
        },
      },
    };
    mockGetCredential.mockResolvedValue({ apiKey: 'saved-key' });
    render(<ProviderSettingsScreen />);
    fireEvent.changeText(screen.getByLabelText('Endpoint URL'), 'http://192.168.1.9:11434/v1');
    fireEvent.press(screen.getByText('Save selection'));
    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
    expect(mockSetCredential).not.toHaveBeenCalled();
    expect(mockUpdateConfig.mock.calls[0][0].inference.dictation.credentialRef).toBeUndefined();
  });
});
