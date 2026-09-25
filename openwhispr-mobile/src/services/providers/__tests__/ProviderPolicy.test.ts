import { resolveMobileInferenceRoute, type InferencePolicy } from '@/lib/mobileProviders';

const mockGet = jest.fn();
let mockAuthState: {
  user: { id: string; isAnonymous?: boolean } | null;
  isGuest: boolean;
  sessionCookie: string | null;
};
const stored = new Map<string, string>();
let getProviderPolicy: () => Promise<InferencePolicy>;

jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/lib/apiClient', () => ({
  BASE_URL: 'https://api.openwhispr.test',
  api: { get: (...args: unknown[]): Promise<unknown> => mockGet(...args) },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: (): typeof mockAuthState => mockAuthState },
}));
const mockCredentialListeners = new Set<(reference: string | null) => void>();
jest.mock('../ProviderCredentials', () => ({
  subscribeProviderCredentialChanges: (listener: (reference: string | null) => void) => {
    mockCredentialListeners.add(listener);
    return (): void => {
      mockCredentialListeners.delete(listener);
    };
  },
}));

function managedEnvelope(options: { allowed?: boolean; updatedAt?: string } = {}): unknown {
  return {
    data: {
      managed: true,
      policyUpdatedAt: options.updatedAt ?? '2026-09-21T00:00:00Z',
      policy: {
        version: 1,
        transcription: { allowedModes: ['local'], allowedByokProviders: [] },
        llm: {
          allowedModes: options.allowed ? ['providers'] : ['local'],
          allowedByokProviders: options.allowed ? ['openai'] : [],
        },
        features: { agentEnabled: false },
      },
    },
  };
}

const denied: InferencePolicy = {
  status: 'managed',
  transcription: { allowedModes: ['local'], allowedByokProviders: [] },
  llm: { allowedModes: ['local'], allowedByokProviders: [] },
  agentEnabled: false,
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle): void => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.resetModules();
  mockCredentialListeners.clear();
  mockGet.mockReset();
  stored.clear();
  mockAuthState = { user: { id: 'account-a' }, isGuest: false, sessionCookie: 'fixture-session-a' };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string): string | null => stored.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        stored.set(key, value);
      },
      removeItem: (key: string): void => {
        stored.delete(key);
      },
    },
  });
  getProviderPolicy =
    jest.requireActual<typeof import('../ProviderPolicy')>('../ProviderPolicy').getProviderPolicy;
});

it.each([false, true])(
  'allows signed-out personal usage without any policy request (guest: %s)',
  async (isGuest) => {
    mockAuthState = { user: null, isGuest, sessionCookie: null };
    await expect(getProviderPolicy()).resolves.toEqual({ status: 'unmanaged' });
    expect(mockGet).not.toHaveBeenCalled();
  },
);

it('returns explicit managed restrictions and opts into strict server policy resolution', async () => {
  mockGet.mockResolvedValue(managedEnvelope());
  await expect(getProviderPolicy()).resolves.toEqual(denied);
  expect(mockGet).toHaveBeenCalledWith(
    '/api/workspace-policy',
    expect.objectContaining({
      headers: { 'x-openwhispr-policy-version': '1' },
    }),
  );
  expect([...stored.values()].join('')).not.toContain('fixture-session');
});

it('accepts a verified unmanaged account', async () => {
  mockGet.mockResolvedValue({ data: { managed: false, policy: null, policyUpdatedAt: null } });
  await expect(getProviderPolicy()).resolves.toEqual({ status: 'unmanaged' });
});

it('fails closed when the first policy request fails', async () => {
  mockGet.mockRejectedValue(new Error('offline'));
  await expect(getProviderPolicy()).resolves.toEqual({ status: 'pending' });
});

it('retains the same-account managed policy across failed refresh and service reload', async () => {
  mockGet.mockResolvedValueOnce(managedEnvelope());
  await getProviderPolicy();
  jest.resetModules();
  const reloaded = jest.requireActual<typeof import('../ProviderPolicy')>('../ProviderPolicy');
  mockGet.mockRejectedValue(new Error('offline'));
  await expect(reloaded.getProviderPolicy()).resolves.toEqual(denied);
});

it('does not use another account policy on failure', async () => {
  mockGet.mockResolvedValueOnce(managedEnvelope({ allowed: true }));
  await getProviderPolicy();
  mockAuthState = { user: { id: 'account-b' }, isGuest: false, sessionCookie: 'fixture-session-b' };
  mockGet.mockRejectedValue(new Error('offline'));
  await expect(getProviderPolicy()).resolves.toEqual({ status: 'pending' });
});

it('discards an in-flight response after an account switch', async () => {
  const response = deferred<unknown>();
  mockGet.mockReturnValueOnce(response.promise);
  const pending = getProviderPolicy();
  mockAuthState = { user: { id: 'account-b' }, isGuest: false, sessionCookie: 'fixture-session-b' };
  response.resolve({ data: { managed: false, policy: null } });
  await expect(pending).resolves.toEqual({ status: 'pending' });
  expect(stored.size).toBe(0);
});

it('discards an old session response even when the same account has signed in again', async () => {
  const response = deferred<unknown>();
  mockGet.mockReturnValueOnce(response.promise);
  const pending = getProviderPolicy();
  mockAuthState = {
    user: { id: 'account-a' },
    isGuest: false,
    sessionCookie: 'fixture-session-new',
  };
  response.resolve({ data: { managed: false, policy: null } });
  await expect(pending).resolves.toEqual({ status: 'pending' });
});

it('deduplicates concurrent requests for the same session', async () => {
  const response = deferred<unknown>();
  mockGet.mockReturnValue(response.promise);
  const first = getProviderPolicy();
  const second = getProviderPolicy();
  response.resolve(managedEnvelope());
  await expect(first).resolves.toEqual(denied);
  await expect(second).resolves.toEqual(denied);
  expect(mockGet).toHaveBeenCalledTimes(1);
});

it.each([
  null,
  {},
  { data: { managed: 'false' } },
  { data: { managed: true, policy: null } },
  { data: { managed: false, policy: { version: 1 } } },
  { data: { managed: true, policyUpdatedAt: 'invalid', policy: {} } },
])('fails closed for an invalid policy envelope: %j', async (envelope) => {
  mockGet.mockResolvedValue(envelope);
  await expect(getProviderPolicy()).resolves.toEqual({ status: 'pending' });
});

it('rejects unsupported policy versions, unknown modes and invalid agent flags', async () => {
  for (const patch of [
    { version: 2 },
    { transcription: { allowedModes: ['future-mode'], allowedByokProviders: [] } },
    { llm: { allowedModes: ['providers'], allowedByokProviders: [null] } },
    { features: { agentEnabled: 'true' } },
  ]) {
    const envelope = managedEnvelope() as { data: { policy: Record<string, unknown> } };
    Object.assign(envelope.data.policy, patch);
    mockGet.mockResolvedValue(envelope);
    await expect(getProviderPolicy()).resolves.toEqual({ status: 'pending' });
  }
});

it('does not replace a newer managed restriction with an older server response', async () => {
  mockGet.mockResolvedValueOnce(managedEnvelope());
  await getProviderPolicy();
  mockGet.mockResolvedValueOnce(
    managedEnvelope({ allowed: true, updatedAt: '2026-09-20T00:00:00Z' }),
  );
  await expect(getProviderPolicy()).resolves.toEqual(denied);
});

it('an unresolvable managed policy invalidates an old unmanaged verdict across reloads', async () => {
  mockGet.mockResolvedValueOnce({ data: { managed: false, policy: null } });
  await getProviderPolicy();
  mockGet.mockRejectedValueOnce(
    Object.assign(new Error('unresolved'), { code: 'POLICY_UNRESOLVABLE' }),
  );
  await expect(getProviderPolicy()).resolves.toEqual({ status: 'pending' });
  jest.resetModules();
  const reloaded = jest.requireActual<typeof import('../ProviderPolicy')>('../ProviderPolicy');
  mockGet.mockRejectedValue(new Error('offline'));
  await expect(reloaded.getProviderPolicy()).resolves.toEqual({ status: 'pending' });
});

it('malformed managed responses cannot reuse a previous unmanaged verdict', async () => {
  mockGet.mockResolvedValueOnce({ data: { managed: false, policy: null } });
  await getProviderPolicy();
  mockGet.mockResolvedValueOnce({ data: { managed: true, policy: null } });
  await expect(getProviderPolicy()).resolves.toEqual({ status: 'pending' });
});

it('sends one policy-awareness header through the real API client', async () => {
  const { fetch } = jest.requireMock('expo/fetch') as { fetch: jest.Mock };
  fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async (): Promise<unknown> => managedEnvelope(),
  });
  const actualClient = jest.requireActual<typeof import('@/lib/apiClient')>('@/lib/apiClient');
  mockGet.mockImplementationOnce(actualClient.api.get);
  await expect(getProviderPolicy()).resolves.toEqual(denied);
  const options = fetch.mock.calls.at(-1)?.[1] as RequestInit;
  expect(new Headers(options.headers).get('x-openwhispr-policy-version')).toBe('1');
});

describe('after signing out', () => {
  const signedOut = { user: null, isGuest: false, sessionCookie: null };
  const unmanaged = { data: { managed: false, policy: null, policyUpdatedAt: null } };
  const openaiCleanup = {
    scope: 'cleanup' as const,
    selection: {
      mode: 'providers' as const,
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      credentialRef: 'provider.openai',
    },
  };

  it('keeps enforcing the last managed policy, so a blocked provider stays blocked', async () => {
    mockGet.mockResolvedValueOnce(managedEnvelope());
    await getProviderPolicy();
    mockAuthState = signedOut;
    const policy = await getProviderPolicy();
    expect(policy).toEqual(denied);
    expect(resolveMobileInferenceRoute({ ...openaiCleanup, policy })).toEqual({
      ok: false,
      code: 'POLICY_BLOCKED',
    });
    mockAuthState = { ...signedOut, isGuest: true };
    await expect(getProviderPolicy()).resolves.toEqual(denied);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('remembers the policy across an app restart', async () => {
    mockGet.mockResolvedValueOnce(managedEnvelope());
    await getProviderPolicy();
    jest.resetModules();
    mockAuthState = signedOut;
    const reloaded = jest.requireActual<typeof import('../ProviderPolicy')>('../ProviderPolicy');
    await expect(reloaded.getProviderPolicy()).resolves.toEqual(denied);
  });

  it('stays unresolved when the member policy could not be read', async () => {
    mockGet.mockRejectedValueOnce(
      Object.assign(new Error('unresolved'), { code: 'POLICY_UNRESOLVABLE' }),
    );
    await getProviderPolicy();
    mockAuthState = signedOut;
    await expect(getProviderPolicy()).resolves.toEqual({ status: 'pending' });
  });

  it('is replaced by a different account that signs in', async () => {
    mockGet.mockResolvedValueOnce(managedEnvelope());
    await getProviderPolicy();
    mockAuthState = { user: { id: 'account-b' }, isGuest: false, sessionCookie: 'fixture-b' };
    mockGet.mockResolvedValueOnce(managedEnvelope({ allowed: true }));
    await getProviderPolicy();
    mockAuthState = signedOut;
    await expect(getProviderPolicy()).resolves.toMatchObject({
      status: 'managed',
      llm: { allowedByokProviders: ['openai'] },
    });
    mockAuthState = { user: { id: 'account-c' }, isGuest: false, sessionCookie: 'fixture-c' };
    mockGet.mockResolvedValueOnce(unmanaged);
    await getProviderPolicy();
    mockAuthState = signedOut;
    await expect(getProviderPolicy()).resolves.toEqual({ status: 'unmanaged' });
  });

  it('is lifted when the same account leaves the organization', async () => {
    mockGet.mockResolvedValueOnce(managedEnvelope());
    await getProviderPolicy();
    mockGet.mockResolvedValueOnce(unmanaged);
    await getProviderPolicy();
    mockAuthState = signedOut;
    await expect(getProviderPolicy()).resolves.toEqual({ status: 'unmanaged' });
  });

  it('is not lifted by an automatic anonymous session', async () => {
    mockGet.mockResolvedValueOnce(managedEnvelope());
    await getProviderPolicy();
    mockAuthState = {
      user: { id: 'anonymous-1', isAnonymous: true },
      isGuest: false,
      sessionCookie: 'fixture-anonymous',
    };
    mockGet.mockResolvedValue(unmanaged);
    await expect(getProviderPolicy()).resolves.toEqual(denied);
    mockAuthState = signedOut;
    await expect(getProviderPolicy()).resolves.toEqual(denied);
  });

  it('is cleared when every provider key is reset', async () => {
    mockGet.mockResolvedValueOnce(managedEnvelope());
    await getProviderPolicy();
    mockCredentialListeners.forEach((listener) => listener('provider.openai'));
    mockAuthState = signedOut;
    await expect(getProviderPolicy()).resolves.toEqual(denied);
    mockCredentialListeners.forEach((listener) => listener(null));
    await expect(getProviderPolicy()).resolves.toEqual({ status: 'unmanaged' });
  });
});
