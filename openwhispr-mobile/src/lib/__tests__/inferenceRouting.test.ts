const mockGetPolicy = jest.fn();
jest.mock('@/services/providers/ProviderPolicy', () => ({
  getProviderPolicy: (): Promise<unknown> => mockGetPolicy(),
}));
import {
  getInferenceSelection,
  getTranscriptionProvider,
  snapshotTranscriptionJob,
  resolveMobileProviderRoute,
} from '../inferenceRouting';
const mockState = { config: { defaultMode: 'cloud', inference: {} } as Record<string, unknown> };
const mockProcessing = { activeMode: 'cloud' };
jest.mock('@/store/useConfigStore', () => ({ useConfigStore: { getState: () => mockState } }));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => mockProcessing },
}));

describe('mobile inference routing', () => {
  beforeEach(() => {
    mockState.config = { defaultMode: 'cloud', inference: {} };
    mockProcessing.activeMode = 'cloud';
  });
  it('does not opt existing configuration into providers', () => {
    expect(getInferenceSelection('dictation')).toBeUndefined();
    expect(getTranscriptionProvider('dictation')).toBe('cloud');
  });
  it('resolves independently selected upload provider', () => {
    mockState.config.inference = {
      upload: {
        mode: 'providers',
        providerId: 'groq',
        modelId: 'whisper-large-v3-turbo',
        credentialRef: 'provider.groq',
      },
    };
    expect(getTranscriptionProvider('upload')).toBe('byok');
    expect(getTranscriptionProvider('dictation')).toBe('cloud');
  });
  it('keeps private mode on-device despite saved provider settings', () => {
    mockState.config.inference = { dictation: { mode: 'providers', providerId: 'openai' } };
    mockProcessing.activeMode = 'private';
    expect(getTranscriptionProvider('dictation')).toBe('local');
  });
  it('does not reuse dictation providers for unconfigured uploads', () => {
    mockProcessing.activeMode = 'providers';
    mockState.config.inference = { dictation: { mode: 'providers', providerId: 'openai' } };
    expect(getTranscriptionProvider('dictation')).toBe('byok');
    expect(getTranscriptionProvider('upload')).toBe('cloud');
  });
});

it('snapshots a job before settings change', () => {
  mockProcessing.activeMode = 'providers';
  mockState.config.inference = {
    dictation: {
      mode: 'providers',
      providerId: 'groq',
      modelId: 'whisper-large-v3-turbo',
      credentialRef: 'provider.groq',
    },
  };
  const snapshot = snapshotTranscriptionJob('dictation');
  mockState.config.inference = { dictation: { mode: 'openwhispr' } };
  expect(snapshot.provider).toBe('byok');
  expect(snapshot.inferenceRoute?.providerId).toBe('groq');
});

it('freezes explicit Cloud cleanup and separate agent selection for a BYOK recording', () => {
  mockProcessing.activeMode = 'cloud';
  mockState.config.inference = {
    dictation: {
      mode: 'providers',
      providerId: 'groq',
      modelId: 'whisper-large-v3-turbo',
      credentialRef: 'provider.groq',
    },
    cleanup: { mode: 'openwhispr' },
    agent: {
      mode: 'providers',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      credentialRef: 'provider.openai',
    },
  };
  const snapshot = snapshotTranscriptionJob('dictation');
  expect(snapshot.cleanupRoute).toEqual({ mode: 'openwhispr', scope: 'cleanup' });
  expect(snapshot.agentRoute).toMatchObject({
    mode: 'providers',
    scope: 'agent',
    providerId: 'openai',
  });
});

it('freezes legacy Cloud text routes rather than rereading later provider settings', () => {
  mockProcessing.activeMode = 'cloud';
  mockState.config.inference = {};
  const snapshot = snapshotTranscriptionJob('dictation');
  expect(snapshot.cleanupRoute).toEqual({ mode: 'openwhispr', scope: 'cleanup' });
  expect(snapshot.agentRoute).toEqual({ mode: 'openwhispr', scope: 'agent' });
});

it('rechecks private mode after awaiting workspace policy', async () => {
  mockProcessing.activeMode = 'cloud';
  let resolvePolicy!: (value: unknown) => void;
  mockGetPolicy.mockReturnValue(
    new Promise((resolve): void => {
      resolvePolicy = resolve;
    }),
  );
  const pending = resolveMobileProviderRoute('agent', {
    mode: 'providers',
    providerId: 'openai',
    modelId: 'gpt-4.1-mini',
    credentialRef: 'provider.openai',
  });
  mockProcessing.activeMode = 'private';
  resolvePolicy({ status: 'unmanaged' });
  await expect(pending).rejects.toThrow('Private content');
});
