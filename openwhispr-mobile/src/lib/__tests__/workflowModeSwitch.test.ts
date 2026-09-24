import { Alert } from 'react-native';

const mockUpdateConfig = jest.fn().mockResolvedValue(undefined);
const mockSetActiveMode = jest.fn();
const mockPush = jest.fn();
const mockPrivateReadiness = jest.fn();
const mockLocalReasoningReadiness = jest.fn();
let mockConfig: Record<string, unknown> | null = null;
let mockUser: Record<string, unknown> | null = { id: 'user-1' };

jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({ config: mockConfig, updateConfig: mockUpdateConfig }),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ setActiveMode: mockSetActiveMode }) },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: mockUser }) },
}));
jest.mock('@/lib/privateMode', () => ({
  getPrivateModeReadiness: () => mockPrivateReadiness(),
  getPrivateModeUnavailableMessage: () => 'Native modules are missing.',
}));
jest.mock('@/lib/localReasoning', () => ({
  getLocalReasoningReadiness: () => mockLocalReasoningReadiness(),
  getLocalReasoningUnavailableMessage: () => 'Apple Intelligence is turned off.',
}));

import { pickLocalModel, switchWorkflowMode } from '../workflowModeSwitch';

let alert: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = { defaultMode: 'cloud', inference: { dictation: { mode: 'openwhispr' } } };
  mockUser = { id: 'user-1' };
  mockPrivateReadiness.mockResolvedValue({ status: 'ready', modelName: 'Parakeet v2' });
  mockLocalReasoningReadiness.mockResolvedValue({ status: 'ready', tokenCounting: false });
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

it('asks a signed-out user to sign in before switching to Cloud', async () => {
  mockUser = null;
  mockConfig = { defaultMode: 'private' };
  await expect(switchWorkflowMode('cleanup', 'openwhispr')).resolves.toBe(false);
  expect(alert).toHaveBeenCalledWith('Sign in required', expect.any(String), expect.any(Array));
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('switches dictation to On-Device along with the app mode', async () => {
  await expect(switchWorkflowMode('dictation', 'local')).resolves.toBe(true);
  expect(mockSetActiveMode).toHaveBeenCalledWith('private', true);
  expect(mockUpdateConfig).toHaveBeenCalledWith({
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' } },
  });
});

it('offers the download when the on-device transcription model is missing', async () => {
  mockPrivateReadiness.mockResolvedValue({ status: 'missing', modelName: 'Parakeet v2' });
  await expect(switchWorkflowMode('upload', 'local')).resolves.toBe(false);
  const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
  buttons.find((button) => button.text === 'Download')?.onPress?.();
  expect(mockPush).toHaveBeenCalledWith('/(account)/model-download');
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('switches uploads to On-Device with the model picked for them before', async () => {
  mockConfig = {
    defaultMode: 'cloud',
    inference: { dictation: { mode: 'openwhispr' } },
    rememberedInference: { upload: { local: { mode: 'local', modelId: 'whisper-base' } } },
  };
  await expect(switchWorkflowMode('upload', 'local')).resolves.toBe(true);
  expect(mockUpdateConfig).toHaveBeenCalledWith({
    inference: {
      dictation: { mode: 'openwhispr' },
      upload: { mode: 'local', modelId: 'whisper-base' },
    },
  });
  expect(mockSetActiveMode).not.toHaveBeenCalled();
});

it('explains why a text workflow cannot run on-device', async () => {
  mockLocalReasoningReadiness.mockResolvedValue({ status: 'appleIntelligenceOff' });
  await expect(switchWorkflowMode('cleanup', 'local')).resolves.toBe(false);
  expect(alert).toHaveBeenCalledWith('On-Device Unavailable', 'Apple Intelligence is turned off.');
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('switches a text workflow to On-Device when Apple Intelligence is ready', async () => {
  await expect(switchWorkflowMode('notes', 'local')).resolves.toBe(true);
  expect(mockUpdateConfig).toHaveBeenCalledWith({
    inference: { dictation: { mode: 'openwhispr' }, notes: { mode: 'local' } },
  });
});

it('saves a picked model for the workflow and remembers it for the next switch', async () => {
  mockConfig = { defaultMode: 'private', inference: { dictation: { mode: 'local' } } };
  await pickLocalModel('dictation', 'parakeet-v3');
  expect(mockUpdateConfig).toHaveBeenCalledWith({
    inference: { dictation: { mode: 'local', modelId: 'parakeet-v3' } },
    rememberedInference: {
      dictation: { local: { mode: 'local', modelId: 'parakeet-v3' } },
    },
  });
});

it('picking Automatic clears the model', async () => {
  mockConfig = {
    defaultMode: 'private',
    inference: { dictation: { mode: 'local', modelId: 'parakeet-v3' } },
  };
  await pickLocalModel('dictation', undefined);
  expect(mockUpdateConfig).toHaveBeenCalledWith({
    inference: { dictation: { mode: 'local' } },
    rememberedInference: { dictation: { local: { mode: 'local' } } },
  });
});

describe('a workflow held on its old mode when dictation moved to your own key', () => {
  beforeEach(() => {
    mockConfig = {
      defaultMode: 'providers',
      inference: {
        dictation: { mode: 'providers', providerId: 'openai', modelId: 'whisper-1' },
        upload: { mode: 'local' },
        notes: { mode: 'local' },
      },
      pinnedInference: ['upload', 'notes'],
    };
  });

  it('becomes the user choice once a mode is tapped for it', async () => {
    await expect(switchWorkflowMode('upload', 'openwhispr')).resolves.toBe(true);
    expect(mockUpdateConfig.mock.calls[0][0]).toMatchObject({
      inference: { upload: { mode: 'openwhispr' } },
      pinnedInference: ['notes'],
    });
  });

  it('becomes the user choice once a model is picked for it', async () => {
    await pickLocalModel('upload', 'whisper-base');
    expect(mockUpdateConfig.mock.calls[0][0]).toMatchObject({
      inference: { upload: { mode: 'local', modelId: 'whisper-base' } },
      pinnedInference: ['notes'],
    });
  });
});
