import * as SecureStore from 'expo-secure-store';
import {
  clearProviderCredentials,
  getProviderCredential,
  getProviderCredentialReference,
  getProviderCredentialStatus,
  removeProviderCredential,
  setProviderCredential,
  subscribeProviderCredentialChanges,
  type ProviderCredential,
} from '../ProviderCredentials';
import { SecureStorageService, StorageService } from '../../storage/StorageService';

jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 3,
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, value: string): Promise<string> =>
    jest.requireActual('node:crypto').createHash('sha256').update(value).digest('hex'),
}));

const stored = new Map<string, string>();
const appStorage = new Map<string, string>();
const installMarker = 'openwhispr.provider-credentials.installed.v1';
const clearAppStorage = jest.fn((): void => appStorage.clear());
const getItem = jest.mocked(SecureStore.getItemAsync);
const setItem = jest.mocked(SecureStore.setItemAsync);
const deleteItem = jest.mocked(SecureStore.deleteItemAsync);
const openaiReference = 'provider.openai';

beforeEach(() => {
  jest.clearAllMocks();
  stored.clear();
  appStorage.clear();
  // App storage (unlike the Keychain) is deleted with the app, so it marks this install.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string): string | null => appStorage.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        appStorage.set(key, value);
      },
      removeItem: (key: string): void => {
        appStorage.delete(key);
      },
      clear: clearAppStorage,
    },
  });
  getItem.mockImplementation(async (key): Promise<string | null> => stored.get(key) ?? null);
  setItem.mockImplementation(async (key, value): Promise<void> => {
    stored.set(key, value);
  });
  deleteItem.mockImplementation(async (key): Promise<void> => {
    stored.delete(key);
  });
});

it('stores and rotates credentials with device-local background access and no biometric prompt', async () => {
  await setProviderCredential(openaiReference, { apiKey: 'fixture-first' });
  expect(await getProviderCredential(openaiReference)).toEqual({ apiKey: 'fixture-first' });
  await setProviderCredential(openaiReference, { apiKey: 'fixture-second' });
  expect(await getProviderCredential(openaiReference)).toEqual({ apiKey: 'fixture-second' });
  for (const [, , options] of setItem.mock.calls) {
    expect(options).toMatchObject({
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      requireAuthentication: false,
    });
  }
});

it('stores and reads back an API key', async () => {
  expect(await getProviderCredentialStatus('provider.groq')).toEqual({
    reference: 'provider.groq',
    isConfigured: false,
  });
  await setProviderCredential('provider.groq', { apiKey: 'fixture-key' });
  expect(await getProviderCredential('provider.groq')).toEqual({ apiKey: 'fixture-key' });
  expect(await getProviderCredentialStatus('provider.groq')).toEqual({
    reference: 'provider.groq',
    isConfigured: true,
  });
});

it('shares built-in slots and binds custom references to canonical origin and path', async () => {
  expect(await getProviderCredentialReference('openai')).toBe(openaiReference);
  const reference = await getProviderCredentialReference(
    'custom',
    'https://EXAMPLE.com:443/team/v1/',
  );
  expect(reference).toMatch(/^custom\.[a-f0-9]{64}$/);
  expect(reference).toBe(
    await getProviderCredentialReference('custom', 'https://example.com/team/v1'),
  );
  expect(reference).not.toBe(
    await getProviderCredentialReference('custom', 'https://example.com/other/v1'),
  );
  expect(reference).not.toBe(
    await getProviderCredentialReference('custom', 'https://other.example.com/team/v1'),
  );
});

it.each([
  'https://user:password@example.com/v1',
  'https://example.com/v1?api_key=fixture-secret',
  'https://example.com/v1#fixture-secret',
  'http://public.example.com/v1',
])('rejects unsafe custom credential endpoint %s without exposing it', async (endpoint) => {
  await expect(getProviderCredentialReference('custom', endpoint)).rejects.toThrow(
    'Invalid provider endpoint',
  );
  expect(stored.size).toBe(0);
});

it('rejects references that could contain endpoints or secret data', async () => {
  await expect(
    setProviderCredential('https://example.com/?key=fixture-secret', { apiKey: 'fixture' }),
  ).rejects.toThrow('Invalid credential reference');
  expect(stored.size).toBe(0);
});

it('removes a credential and invalidates cached client consumers without exposing the key', async () => {
  const changes: (string | null)[] = [];
  const unsubscribe = subscribeProviderCredentialChanges((reference): void => {
    changes.push(reference);
  });
  try {
    await setProviderCredential(openaiReference, { apiKey: 'fixture' });
    await removeProviderCredential(openaiReference);
    expect(await getProviderCredential(openaiReference)).toBeNull();
    expect(changes).toEqual([openaiReference, openaiReference]);
    expect([...stored.values()].join('')).not.toContain('fixture');
  } finally {
    unsubscribe();
  }
});

it('blocks reuse after deletion fails and retains enough registry data to retry after reload', async () => {
  await setProviderCredential(openaiReference, { apiKey: 'fixture' });
  deleteItem.mockRejectedValueOnce(new Error('native error containing fixture'));
  await expect(removeProviderCredential(openaiReference)).rejects.toThrow(
    'Unable to remove provider credential',
  );
  expect(await getProviderCredential(openaiReference)).toBeNull();
  let reloaded!: typeof import('../ProviderCredentials');
  jest.isolateModules(() => {
    reloaded =
      jest.requireActual<typeof import('../ProviderCredentials')>('../ProviderCredentials');
  });
  expect(await reloaded.getProviderCredential(openaiReference)).toBeNull();
  await reloaded.clearProviderCredentials();
  expect([...stored.values()].join('')).not.toContain('fixture');
});

it('does not write a secret when registry registration fails', async () => {
  setItem.mockRejectedValueOnce(new Error('native storage unavailable'));
  await expect(setProviderCredential(openaiReference, { apiKey: 'fixture' })).rejects.toThrow(
    'Unable to save provider credential',
  );
  expect(stored.size).toBe(0);
});

it('keeps a failed credential write tracked for reset without reporting configured', async () => {
  setItem.mockImplementationOnce(async (key, value): Promise<void> => {
    stored.set(key, value);
  });
  setItem.mockImplementationOnce(async (): Promise<void> => {
    throw new Error('native fixture');
  });
  await expect(setProviderCredential(openaiReference, { apiKey: 'fixture' })).rejects.toThrow(
    'Unable to save provider credential',
  );
  expect(await getProviderCredentialStatus(openaiReference)).toEqual({
    reference: openaiReference,
    isConfigured: false,
  });
  await clearProviderCredentials();
  expect(stored.size).toBe(0);
});

it('serializes concurrent writes so full reset removes every credential', async () => {
  await Promise.all([
    setProviderCredential(openaiReference, { apiKey: 'fixture-first' }),
    setProviderCredential('provider.groq', { apiKey: 'fixture-second' }),
  ]);
  await clearProviderCredentials();
  expect(await getProviderCredential(openaiReference)).toBeNull();
  expect(await getProviderCredential('provider.groq')).toBeNull();
  expect(stored.size).toBe(0);
});

it('blocks all references on a partial reset and retries failed physical deletions', async () => {
  await setProviderCredential(openaiReference, { apiKey: 'fixture-first' });
  await setProviderCredential('provider.groq', { apiKey: 'fixture-second' });
  deleteItem.mockRejectedValueOnce(new Error('native error'));
  await expect(clearProviderCredentials()).rejects.toThrow('Unable to clear provider credentials');
  expect(await getProviderCredential(openaiReference)).toBeNull();
  expect(await getProviderCredential('provider.groq')).toBeNull();
  await clearProviderCredentials();
  expect(stored.size).toBe(0);
});

it('auth token removal preserves provider keys but full app reset deletes them', async () => {
  await setProviderCredential(openaiReference, { apiKey: 'fixture' });
  await SecureStorageService.clearAuthToken();
  expect(await getProviderCredential(openaiReference)).toEqual({ apiKey: 'fixture' });
  await StorageService.clearAll();
  expect(await getProviderCredential(openaiReference)).toBeNull();
  expect(clearAppStorage).toHaveBeenCalledTimes(1);
});

it('does not reactivate an old secret when replacement fails after a removal failure', async () => {
  await setProviderCredential(openaiReference, { apiKey: 'fixture-old' });
  deleteItem.mockRejectedValueOnce(new Error('native unavailable'));
  await expect(removeProviderCredential(openaiReference)).rejects.toThrow();
  setItem.mockImplementationOnce(async (key, value): Promise<void> => {
    stored.set(key, value);
  });
  setItem.mockRejectedValueOnce(new Error('native unavailable'));
  await expect(setProviderCredential(openaiReference, { apiKey: 'fixture-new' })).rejects.toThrow();
  expect(await getProviderCredential(openaiReference)).toBeNull();
  await clearProviderCredentials();
  expect(stored.size).toBe(0);
});

it('sanitizes corrupt persisted credentials and does not return their contents', async () => {
  await setProviderCredential(openaiReference, { apiKey: 'fixture' });
  const secretKey = [...stored.entries()].find(([, value]) => value.includes('fixture'))![0];
  stored.set(secretKey, '{fixture-secret');
  await expect(getProviderCredential(openaiReference)).rejects.toThrow(
    'Unable to read provider credential',
  );
});

it.each<unknown>([{}, { apiKey: ' ' }, { apiKey: 42 }])(
  'rejects incomplete credentials before storage: %j',
  async (credential) => {
    // Persisted or bridged values are untyped at runtime; the parser must reject them anyway.
    await expect(
      setProviderCredential(openaiReference, credential as ProviderCredential),
    ).rejects.toThrow('Invalid provider credential');
    expect(stored.size).toBe(0);
  },
);

it('binds local-network endpoint credentials to the port and strips supported API suffixes', async () => {
  const reference = await getProviderCredentialReference(
    'custom',
    'http://localhost:8080/v1/chat/completions',
  );
  expect(reference).toBe(
    await getProviderCredentialReference('custom', 'http://localhost:8080/v1'),
  );
  expect(reference).not.toBe(
    await getProviderCredentialReference('custom', 'http://localhost:8081/v1'),
  );
});

it('leaves app data available for retry when secure credential reset fails', async () => {
  await setProviderCredential(openaiReference, { apiKey: 'fixture' });
  deleteItem.mockRejectedValueOnce(new Error('native unavailable'));
  await expect(StorageService.clearAll()).rejects.toThrow('Unable to clear provider credentials');
  expect(clearAppStorage).not.toHaveBeenCalled();
});

it('treats an unreadable registry as empty so save and reset still work', async () => {
  await SecureStore.setItemAsync('openwhispr.provider-credentials.registry.v1', '{not json');
  await expect(getProviderCredential('provider.openai')).resolves.toBeNull();
  await expect(
    setProviderCredential('provider.openai', { apiKey: 'fresh-key' }),
  ).resolves.toBeUndefined();
  await expect(getProviderCredential('provider.openai')).resolves.toEqual({ apiKey: 'fresh-key' });
  await SecureStore.setItemAsync('openwhispr.provider-credentials.registry.v1', '{not json');
  await expect(clearProviderCredentials()).resolves.toBeUndefined();
  await expect(
    SecureStore.getItemAsync('openwhispr.provider-credentials.registry.v1'),
  ).resolves.toBeNull();
});

it('reset deletes built-in provider keys even when the registry is corrupt', async () => {
  await setProviderCredential(openaiReference, { apiKey: 'fixture-openai' });
  await setProviderCredential('provider.openrouter', { apiKey: 'fixture-openrouter' });
  await SecureStore.setItemAsync('openwhispr.provider-credentials.registry.v1', '{not json');
  await expect(clearProviderCredentials()).resolves.toBeUndefined();
  expect(
    await SecureStore.getItemAsync(`openwhispr.provider-credentials.v1.${openaiReference}`),
  ).toBeNull();
  expect(
    await SecureStore.getItemAsync('openwhispr.provider-credentials.v1.provider.openrouter'),
  ).toBeNull();
  expect([...stored.values()].join('')).not.toContain('fixture');
});

describe('after the app is reinstalled', () => {
  function reload(): typeof import('../ProviderCredentials') {
    let reloaded!: typeof import('../ProviderCredentials');
    jest.isolateModules(() => {
      reloaded =
        jest.requireActual<typeof import('../ProviderCredentials')>('../ProviderCredentials');
    });
    return reloaded;
  }

  it('erases keys a previous install left in the Keychain before anything reads them', async () => {
    await setProviderCredential(openaiReference, { apiKey: 'fixture-old-install' });
    appStorage.clear();
    const changes: (string | null)[] = [];
    const fresh = reload();
    const unsubscribe = fresh.subscribeProviderCredentialChanges((reference): void => {
      changes.push(reference);
    });
    try {
      expect(await fresh.getProviderCredential(openaiReference)).toBeNull();
    } finally {
      unsubscribe();
    }
    expect([...stored.values()].join('')).not.toContain('fixture-old-install');
    expect(appStorage.get(installMarker)).toBeDefined();
    expect(changes).toEqual([]);
  });

  it('runs the check at launch without any credential request', async () => {
    await setProviderCredential(openaiReference, { apiKey: 'fixture-old-install' });
    appStorage.clear();
    await reload().eraseProviderCredentialsFromPreviousInstall();
    expect(stored.size).toBe(0);
  });

  it('keeps keys across launches of the same install', async () => {
    await setProviderCredential(openaiReference, { apiKey: 'fixture' });
    const relaunched = reload();
    await relaunched.eraseProviderCredentialsFromPreviousInstall();
    expect(await relaunched.getProviderCredential(openaiReference)).toEqual({ apiKey: 'fixture' });
  });

  it('keeps a key saved after a full app data reset', async () => {
    await StorageService.clearAll();
    await setProviderCredential(openaiReference, { apiKey: 'fixture-after-reset' });
    expect(await reload().getProviderCredential(openaiReference)).toEqual({
      apiKey: 'fixture-after-reset',
    });
  });

  it('retries the erase on the next request when a deletion fails', async () => {
    await setProviderCredential(openaiReference, { apiKey: 'fixture-old-install' });
    appStorage.clear();
    const fresh = reload();
    deleteItem.mockRejectedValueOnce(new Error('native unavailable'));
    await expect(fresh.getProviderCredential(openaiReference)).rejects.toThrow(
      'Unable to read provider credential',
    );
    expect(appStorage.get(installMarker)).toBeUndefined();
    expect(await fresh.getProviderCredential(openaiReference)).toBeNull();
    expect([...stored.values()].join('')).not.toContain('fixture-old-install');
  });
});
