import { Alert } from 'react-native';

const mockUpdateConfig = jest.fn().mockResolvedValue(undefined);
const mockSetActiveMode = jest.fn();
const mockPush = jest.fn();
const mockPrivateReadiness = jest.fn();
const mockLocalReasoningReadiness = jest.fn();
let mockConfig: Record<string, unknown> | null = null;
let mockUser: Record<string, unknown> | null = { id: 'user-1' };
let mockActiveMode = 'cloud';

jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({ config: mockConfig, updateConfig: mockUpdateConfig }),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: {
    getState: () => ({ activeMode: mockActiveMode, setActiveMode: mockSetActiveMode }),
  },
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

import { pickLocalModel, setPrivateMode, switchWorkflowMode } from '../workflowModeSwitch';

let alert: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = { defaultMode: 'cloud', inference: { dictation: { mode: 'openwhispr' } } };
  mockUser = { id: 'user-1' };
  mockActiveMode = 'cloud';
  mockPrivateReadiness.mockResolvedValue({ status: 'ready', modelName: 'Parakeet v2' });
  mockLocalReasoningReadiness.mockResolvedValue({ status: 'ready', tokenCounting: false });
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

it('asks a signed-out user to sign in before switching to Cloud', async () => {
  mockUser = null;
  mockConfig = { defaultMode: 'private' };
  await expect(switchWorkflowMode('cleanup', 'openwhispr')).resolves.toBe('refused');
  expect(alert).toHaveBeenCalledWith('Sign in required', expect.any(String), expect.any(Array));
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('switches dictation to On-Device along with the app mode', async () => {
  await expect(switchWorkflowMode('dictation', 'local')).resolves.toBe('switched');
  expect(mockSetActiveMode).toHaveBeenCalledWith('private', true);
  expect(mockUpdateConfig).toHaveBeenCalledWith({
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' } },
  });
});

it('opens the model list when no on-device transcription model is downloaded', async () => {
  mockPrivateReadiness.mockResolvedValue({ status: 'missing', modelName: 'Parakeet v2' });
  await expect(switchWorkflowMode('upload', 'local')).resolves.toBe('needs-model');
  // Every model is offered there, not just the one recommended for the language.
  expect(alert).not.toHaveBeenCalled();
  expect(mockPush).toHaveBeenCalledWith('/(account)/model-download');
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('switches uploads to On-Device with the model picked for them before', async () => {
  mockConfig = {
    defaultMode: 'cloud',
    inference: { dictation: { mode: 'openwhispr' } },
    rememberedInference: { upload: { local: { mode: 'local', modelId: 'whisper-base' } } },
  };
  await expect(switchWorkflowMode('upload', 'local')).resolves.toBe('switched');
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
  await expect(switchWorkflowMode('cleanup', 'local')).resolves.toBe('refused');
  expect(alert).toHaveBeenCalledWith('On-Device Unavailable', 'Apple Intelligence is turned off.');
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('switches a text workflow to On-Device when Apple Intelligence is ready', async () => {
  await expect(switchWorkflowMode('notes', 'local')).resolves.toBe('switched');
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
    await expect(switchWorkflowMode('upload', 'openwhispr')).resolves.toBe('switched');
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

describe('setPrivateMode', () => {
  it('turns on by switching dictation, and with it the app, to On-Device', async () => {
    await expect(setPrivateMode(true)).resolves.toBe('switched');
    expect(mockSetActiveMode).toHaveBeenCalledWith('private', true);
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' } },
    });
  });

  it('opens the model list instead of turning on when no model is downloaded', async () => {
    mockPrivateReadiness.mockResolvedValue({ status: 'missing', modelName: 'Parakeet v2' });
    await expect(setPrivateMode(true)).resolves.toBe('needs-model');
    expect(mockPush).toHaveBeenCalledWith('/(account)/model-download');
    expect(mockSetActiveMode).not.toHaveBeenCalled();
  });

  it('turns off by switching dictation back to Cloud', async () => {
    mockConfig = { defaultMode: 'private', inference: { dictation: { mode: 'local' } } };
    await expect(setPrivateMode(false)).resolves.toBe('switched');
    expect(mockSetActiveMode).toHaveBeenCalledWith('cloud', true);
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      defaultMode: 'cloud',
      inference: { dictation: { mode: 'openwhispr' } },
    });
  });

  it('remembers Bring Your Own Key when turned on from it', async () => {
    mockActiveMode = 'providers';
    mockConfig = {
      defaultMode: 'providers',
      inference: { dictation: { mode: 'providers', providerId: 'openai' } },
    };
    await expect(setPrivateMode(true)).resolves.toBe('switched');
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ defaultMode: 'private', privateModeReturn: 'providers' }),
    );
  });

  // Turning it off must not send audio to Cloud for someone who was using their own key.
  it('turns off into the last provider used when it was turned on from Bring Your Own Key', async () => {
    mockActiveMode = 'private';
    mockConfig = {
      defaultMode: 'private',
      privateModeReturn: 'providers',
      inference: { dictation: { mode: 'local' } },
      rememberedInference: {
        dictation: {
          local: { mode: 'local', modelId: 'whisper-base' },
          groq: { mode: 'providers', providerId: 'groq', modelId: 'whisper-large-v3' },
          openai: { mode: 'providers', providerId: 'openai', modelId: 'gpt-4o-transcribe' },
        },
      },
    };
    await expect(setPrivateMode(false)).resolves.toBe('switched');
    expect(mockSetActiveMode).toHaveBeenCalledWith('providers', true);
    const update = mockUpdateConfig.mock.calls[0][0];
    expect(update).toMatchObject({
      defaultMode: 'providers',
      inference: {
        dictation: { mode: 'providers', providerId: 'groq', modelId: 'whisper-large-v3' },
        // Leaving Private mode keeps the workflows that followed it on this phone.
        upload: { mode: 'local' },
        notes: { mode: 'local' },
        agent: { mode: 'local' },
      },
      pinnedInference: ['upload', 'notes', 'agent'],
    });
    expect(update).toHaveProperty('privateModeReturn', undefined);
  });

  // Needs no account, so a guest kept in Private mode can still leave it this way.
  it('turns off into the provider dictation is saved to without signing in', async () => {
    mockUser = null;
    mockActiveMode = 'private';
    mockConfig = {
      defaultMode: 'providers',
      inference: { dictation: { mode: 'providers', providerId: 'openai' } },
    };
    await expect(setPrivateMode(false)).resolves.toBe('switched');
    expect(mockSetActiveMode).toHaveBeenCalledWith('providers', true);
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultMode: 'providers',
        inference: expect.objectContaining({
          dictation: { mode: 'providers', providerId: 'openai' },
        }),
      }),
    );
    expect(alert).not.toHaveBeenCalled();
  });

  it('turns off into Cloud, not an old provider, when it was turned on from Cloud', async () => {
    mockActiveMode = 'private';
    mockConfig = {
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' } },
      rememberedInference: { dictation: { openai: { mode: 'providers', providerId: 'openai' } } },
    };
    await expect(setPrivateMode(false)).resolves.toBe('switched');
    expect(mockSetActiveMode).toHaveBeenCalledWith('cloud', true);
  });

  it('stays on when a signed-out user would need Cloud', async () => {
    mockUser = null;
    mockConfig = { defaultMode: 'private', inference: { dictation: { mode: 'local' } } };
    await expect(setPrivateMode(false)).resolves.toBe('refused');
    expect(alert).toHaveBeenCalledWith('Sign in required', expect.any(String), expect.any(Array));
    expect(mockSetActiveMode).not.toHaveBeenCalled();
  });
});
