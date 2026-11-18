import { ProviderExecutionError } from '@/services/providers/ProviderExecutionError';
import type { UserConfig } from '@/types';

const mockDiscover = jest.fn();
jest.mock('@/services/providers/ProviderExecution', () => ({
  discoverProviderModels: (...args: unknown[]) => mockDiscover(...args),
}));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('@/services/providers/ProviderCredentials', () => ({
  getProviderCredential: async () => ({ apiKey: 'test-key' }),
  getProviderCredentialReference: async (id: string) =>
    id === 'custom' ? `custom.${'a'.repeat(64)}` : `provider.${id}`,
  getProviderCredentialStatus: async () => ({ isConfigured: true }),
  removeProviderCredential: async () => undefined,
  setProviderCredential: async () => undefined,
  subscribeProviderCredentialChanges: () => () => undefined,
}));
jest.mock('@/android/strings', () => ({
  __esModule: true,
  default: { addResourceBundle: jest.fn(), t: (key: string) => key },
}));
jest.mock('../models', () => ({
  ANDROID_MODELS: {
    'parakeet-v3': { title: 'Parakeet v3', bytes: 670478772 },
    'qwen-balanced': { title: 'Qwen3 1.7B', bytes: 1100000000 },
  },
  modelReady: async () => true,
  useModelDownloads: () => ({}),
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
const logic = require('../processingV1/logic') as typeof import('../processingV1/logic');
const {
  checkCustomServer,
  customSelection,
  normalizeServer,
  sourceCanRun,
  taskList,
  taskValue,
  tasksUsing,
} = logic;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveMobileInferenceRoute } =
  require('@/lib/mobileProviders') as typeof import('@/lib/mobileProviders');

const t = ((key: string, options?: Record<string, string>) =>
  options ? `${key}:${JSON.stringify(options)}` : key) as never;

describe('Processing v1 logic', () => {
  beforeEach(() => mockDiscover.mockReset());

  it('adds a scheme to a bare server address and drops trailing slashes', () => {
    expect(normalizeServer(' 192.168.1.4:11434/ ')).toBe('http://192.168.1.4:11434');
    expect(normalizeServer('https://llm.example/v1/')).toBe('https://llm.example/v1');
    expect(normalizeServer('')).toBe('');
  });

  it('runs a custom server for everything but live meetings', () => {
    expect(sourceCanRun('custom', 'dictation')).toBe(true);
    expect(sourceCanRun('custom', 'notes')).toBe(true);
    expect(sourceCanRun('custom', 'meeting')).toBe(false);
    expect(sourceCanRun('openrouter', 'dictation')).toBe(false);
    expect(sourceCanRun('deepgram', 'cleanup')).toBe(false);
    expect(sourceCanRun('deepgram', 'meeting')).toBe(true);
  });

  it('reads a server that lists models as working, and keeps the base that answered', async () => {
    mockDiscover.mockResolvedValue({
      models: [{ id: 'whisper-1', name: 'whisper-1' }],
      verification: 'catalog-only',
      endpoint: 'http://10.0.0.2:8000/v1',
    });
    await expect(checkCustomServer('http://10.0.0.2:8000', 'secret')).resolves.toEqual({
      state: 'connected',
      models: ['whisper-1'],
      endpoint: 'http://10.0.0.2:8000/v1',
    });
    expect(mockDiscover.mock.calls[0][0]).toMatchObject({
      route: { providerId: 'custom', endpoint: 'http://10.0.0.2:8000' },
      apiKey: 'secret',
    });
  });

  it('tells a refused key from a server it could not reach', async () => {
    mockDiscover.mockRejectedValueOnce(new ProviderExecutionError('INVALID_CREDENTIAL', 'no'));
    await expect(checkCustomServer('https://x.example')).resolves.toMatchObject({
      state: 'failed',
      reason: 'rejected',
    });
    mockDiscover.mockRejectedValueOnce(
      new ProviderExecutionError('PROVIDER_NETWORK_ERROR', 'down'),
    );
    await expect(checkCustomServer('https://x.example')).resolves.toMatchObject({
      state: 'unverified',
    });
  });

  it('names where each task runs and which tasks a key serves', () => {
    const config = {
      cleanupEnabled: true,
      inference: {
        dictation: { mode: 'providers', providerId: 'openai', modelId: 'gpt-transcribe' },
        upload: { mode: 'local' },
        cleanup: { mode: 'providers', providerId: 'openai', modelId: 'gpt-6-luna' },
        notes: { mode: 'openwhispr' },
      },
    } as unknown as UserConfig;
    expect(taskValue(t, config, 'dictation')).toBe('keyValue:{"provider":"OpenAI"}');
    expect(taskValue(t, config, 'upload')).toBe('thisPhone');
    expect(taskValue(t, config, 'notes')).toBe('cloudShort');
    expect(tasksUsing(config, 'openai')).toEqual(['dictation', 'cleanup']);
    expect(taskList(t, ['dictation', 'cleanup'])).toBe(
      'listAnd:{"first":"dictation","last":"textCleanup"}',
    );
    expect(taskValue(t, { ...config, cleanupEnabled: false } as UserConfig, 'cleanup')).toBe(
      'offInSettings',
    );
  });

  it('saves a custom server choice that routes for speech and text tasks, key included', async () => {
    const selection = await customSelection('http://localhost:18765/v1', 'whisper-large-v3');
    expect(selection).toEqual({
      mode: 'providers',
      providerId: 'custom',
      modelId: 'whisper-large-v3',
      endpoint: 'http://localhost:18765/v1',
      credentialRef: `custom.${'a'.repeat(64)}`,
    });
    for (const scope of ['dictation', 'upload', 'cleanup'] as const) {
      const route = resolveMobileInferenceRoute({
        scope,
        selection,
        policy: { status: 'unmanaged' },
      });
      expect(route).toMatchObject({ ok: true, route: { providerId: 'custom', scope } });
    }
  });
});
