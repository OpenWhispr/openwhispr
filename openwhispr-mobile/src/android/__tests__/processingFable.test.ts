import type { UserConfig } from '@/types';

const mockDiscover = jest.fn();
jest.mock('@/services/providers/ProviderExecution', () => ({
  discoverProviderModels: (...args: unknown[]) => mockDiscover(...args),
}));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
const mockKeys = new Map<string, string>();
jest.mock('@/services/providers/ProviderCredentials', () => ({
  getProviderCredential: async (reference: string) =>
    mockKeys.has(reference) ? { apiKey: mockKeys.get(reference) } : null,
  getProviderCredentialReference: async (id: string) =>
    id === 'custom' ? `custom.${'a'.repeat(64)}` : `provider.${id}`,
  getProviderCredentialStatus: async (reference: string) => ({
    isConfigured: mockKeys.has(reference),
  }),
  removeProviderCredential: async (reference: string) => void mockKeys.delete(reference),
  setProviderCredential: async (reference: string, value: { apiKey: string }) =>
    void mockKeys.set(reference, value.apiKey),
  subscribeProviderCredentialChanges: () => () => undefined,
}));
jest.mock('@/android/strings', () => ({
  __esModule: true,
  default: { addResourceBundle: jest.fn(), t: (key: string) => key },
}));
const mockReady = new Set<string>();
jest.mock('../models', () => ({
  ANDROID_MODELS: {
    'parakeet-v3': { title: 'Parakeet v3', bytes: 670_000_000 },
    'qwen-balanced': { title: 'Qwen3 1.7B', bytes: 1_100_000_000 },
    'meeting-speakers': { title: 'Meeting speakers', bytes: 42_000_000 },
  },
  modelReady: async (id: string) => mockReady.has(id),
  downloadAndroidModel: jest.fn(async () => undefined),
  cancelAndroidDownload: jest.fn(async () => undefined),
  useModelDownloads: Object.assign(() => ({}), {
    getState: () => ({ progress: {} }),
    subscribe: () => () => undefined,
  }),
}));

// The app's localStorage is SQLite-backed; a plain in-memory one stands in here.
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  },
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../providers/register');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const places = require('../processingFable/places') as typeof import('../processingFable/places');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useConfigStore } =
  require('@/store/useConfigStore') as typeof import('@/store/useConfigStore');

const config = (inference: UserConfig['inference']) => ({ inference }) as UserConfig;

describe('Processing · Fable’s take', () => {
  beforeEach(() => {
    mockDiscover.mockReset();
    mockKeys.clear();
    mockReady.clear();
    useConfigStore.setState({
      config: { inference: {} } as UserConfig,
      updateConfig: async (change: Partial<UserConfig>) => {
        useConfigStore.setState((state) => ({
          config: { ...state.config, ...change } as UserConfig,
        }));
      },
    } as never);
  });

  it('counts the tasks each provider can run, as the key sheet’s button names them', () => {
    expect(places.sourceTasks('openai')).toHaveLength(5);
    expect(places.sourceTasks('groq')).toEqual(['dictation', 'upload', 'cleanup', 'notes']);
    expect(places.sourceTasks('deepgram')).toEqual(['dictation', 'upload', 'meeting']);
    expect(places.sourceTasks('assemblyai')).toEqual(['dictation', 'upload', 'meeting']);
    expect(places.sourceTasks('openrouter')).toEqual(['cleanup', 'notes']);
  });

  it('puts each task in the place it runs on, meetings on Cloud until moved', () => {
    const current = config({
      dictation: { mode: 'local' },
      upload: { mode: 'providers', providerId: 'openai', modelId: 'gpt-transcribe' },
      cleanup: { mode: 'openwhispr' },
    });
    const at = (task: 'dictation' | 'upload' | 'cleanup' | 'meeting') =>
      places.placementOf(current, task, 'cloud', 'account');
    expect(at('dictation')).toEqual({ place: 'device' });
    expect(at('upload')).toEqual({ place: 'key', source: 'openai', modelId: 'gpt-transcribe' });
    expect(at('cleanup')).toEqual({ place: 'cloud' });
    expect(at('meeting')).toEqual({ place: 'cloud' });
  });

  it('splits a custom server’s models into speech and text', () => {
    expect(
      places.splitModels(['whisper-large-v3', 'llama-3.3-70b', 'parakeet-tdt', 'nomic-embed-text']),
    ).toEqual({ speech: ['whisper-large-v3', 'parakeet-tdt'], text: ['llama-3.3-70b'] });
  });

  it('reads an unreachable server as a failed address, and a 401 as a refused key', async () => {
    mockDiscover.mockRejectedValueOnce(new Error('Network request failed'));
    expect(await places.checkCustomServer('https://llm.example/v1')).toMatchObject({
      state: 'failed',
      reason: 'network',
    });
    mockDiscover.mockRejectedValueOnce(
      Object.assign(new Error('nope'), { code: 'INVALID_CREDENTIAL' }),
    );
    expect(await places.checkCustomServer('https://llm.example/v1', 'k')).toMatchObject({
      state: 'failed',
      reason: 'rejected',
    });
    mockDiscover.mockResolvedValueOnce({
      models: [{ id: 'whisper-1' }, { id: 'gpt-oss' }],
      endpoint: 'https://llm.example/v1',
    });
    expect(await places.checkCustomServer('https://llm.example', 'k')).toMatchObject({
      state: 'connected',
      speech: ['whisper-1'],
      text: ['gpt-oss'],
      endpoint: 'https://llm.example/v1',
    });
  });

  it('adds a key for every task it can run, and Undo takes the key and the tasks back', async () => {
    const { tasks, undo } = await places.addSource('groq', 'gsk_test', true);
    expect(tasks).toEqual(['dictation', 'upload', 'cleanup', 'notes']);
    expect(mockKeys.get('provider.groq')).toBe('gsk_test');
    expect(useConfigStore.getState().config?.inference?.cleanup).toMatchObject({
      mode: 'providers',
      providerId: 'groq',
    });
    expect(useConfigStore.getState().config?.inference?.meeting).toBeUndefined();
    await undo();
    expect(mockKeys.has('provider.groq')).toBe(false);
    expect(useConfigStore.getState().config?.inference?.cleanup).toBeUndefined();
  });

  it('saves a custom server and runs speech and text tasks on the models it listed', async () => {
    await places.addSource('custom', '', true, {
      endpoint: 'http://192.168.1.4:8000/v1',
      speech: ['whisper-1'],
      text: ['gpt-oss'],
    });
    const inference = useConfigStore.getState().config?.inference;
    expect(inference?.dictation).toMatchObject({ providerId: 'custom', modelId: 'whisper-1' });
    expect(inference?.notes).toMatchObject({
      providerId: 'custom',
      modelId: 'gpt-oss',
      endpoint: 'http://192.168.1.4:8000/v1',
    });
    // No key was given, so none is referenced.
    expect(inference?.notes?.credentialRef).toBeUndefined();
    expect(inference?.meeting).toBeUndefined();
  });

  it('removing a key moves its tasks to Cloud, and Undo restores both', async () => {
    await places.addSource('openai', 'sk-test-4f2a', true);
    const undo = await places.removeSource('openai', true, 'account');
    expect(mockKeys.has('provider.openai')).toBe(false);
    expect(useConfigStore.getState().config?.inference?.dictation).toEqual({ mode: 'openwhispr' });
    expect(useConfigStore.getState().config?.inference?.meeting).toEqual({ mode: 'openwhispr' });
    await undo();
    expect(mockKeys.get('provider.openai')).toBe('sk-test-4f2a');
    expect(useConfigStore.getState().config?.inference?.dictation).toMatchObject({
      providerId: 'openai',
    });
  });

  it('on device moves the tasks whose model is here now and queues the rest', async () => {
    mockReady.add('parakeet-v3');
    await places.moveTasksOnDevice(['dictation', 'cleanup']);
    expect(useConfigStore.getState().config?.inference?.dictation).toEqual({ mode: 'local' });
    // Qwen isn't on the phone: cleanup waits for it.
    expect(useConfigStore.getState().config?.inference?.cleanup).toBeUndefined();
    await expect(places.missingForEverything()).resolves.toEqual([
      'qwen-balanced',
      'meeting-speakers',
    ]);
  });
});
