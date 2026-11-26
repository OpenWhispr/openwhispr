// apiClient reads Constants.expoConfig?.version at call time, so each test
// re-mocks expo-constants (and expo/fetch, useAuthStore) via jest.doMock +
// jest.resetModules and re-requires the module, mirroring the pattern in
// src/services/calendar/__tests__/googleCalendarConfig.test.ts.
type ApiClientModule = typeof import('../apiClient');

interface LoadOptions {
  expoConfig?: { version?: string } | null;
  sessionCookie?: string | null;
}

function loadApiClient(options: LoadOptions = {}): {
  apiClient: ApiClientModule;
  mockFetch: jest.Mock;
} {
  jest.resetModules();
  const mockFetch = jest.fn();
  jest.doMock('expo/fetch', () => ({
    __esModule: true,
    fetch: mockFetch,
  }));
  jest.doMock('expo-constants', () => ({
    __esModule: true,
    default: {
      expoConfig: options.expoConfig === undefined ? { version: '1.2.3' } : options.expoConfig,
    },
  }));
  jest.doMock('@/store/useAuthStore', () => ({
    useAuthStore: {
      getState: () => ({ sessionCookie: options.sessionCookie ?? null }),
    },
  }));

  const apiClient = require('../apiClient') as ApiClientModule;
  return { apiClient, mockFetch };
}

function errorResponse(status: number, json: () => Promise<unknown>): unknown {
  return { ok: false, status, statusText: 'Error', json };
}

function okResponse(status: number, body: unknown = {}): unknown {
  return { ok: true, status, statusText: 'OK', json: async () => body };
}

afterEach(() => {
  jest.dontMock('expo/fetch');
  jest.dontMock('expo-constants');
  jest.dontMock('@/store/useAuthStore');
  jest.resetModules();
});

// ---------------------------------------------------------------------------
// Error envelope parsing
// ---------------------------------------------------------------------------

describe('apiRequest error envelope', () => {
  it('parses error + code + data from the response body onto the thrown ApiError', async () => {
    const { apiClient, mockFetch } = loadApiClient();
    mockFetch.mockResolvedValue(
      errorResponse(409, async () => ({
        error: 'Note was edited elsewhere',
        code: 'note_version_conflict',
        data: { latestVersion: 5 },
      })),
    );

    await expect(apiClient.apiRequest('/api/notes/1')).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Note was edited elsewhere',
      status: 409,
      code: 'note_version_conflict',
      data: { latestVersion: 5 },
    });
  });

  it('falls back to the legacy `message` field when `error` is absent', async () => {
    const { apiClient, mockFetch } = loadApiClient();
    mockFetch.mockResolvedValue(errorResponse(400, async () => ({ message: 'Old style error' })));

    await expect(apiClient.apiRequest('/api/x')).rejects.toMatchObject({
      message: 'Old style error',
      status: 400,
      code: undefined,
    });
  });

  it('prefers `error` over the legacy `message` when both are present', async () => {
    const { apiClient, mockFetch } = loadApiClient();
    mockFetch.mockResolvedValue(
      errorResponse(422, async () => ({ error: 'New message', message: 'Old message' })),
    );

    await expect(apiClient.apiRequest('/api/x')).rejects.toMatchObject({
      message: 'New message',
    });
  });

  it('falls back to `HTTP <status>` when the body is not JSON', async () => {
    const { apiClient, mockFetch } = loadApiClient();
    mockFetch.mockResolvedValue(
      errorResponse(500, async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      }),
    );

    await expect(apiClient.apiRequest('/api/x')).rejects.toMatchObject({
      message: 'HTTP 500',
      status: 500,
      code: undefined,
      data: undefined,
    });
  });

  it('falls back to `HTTP <status>` when the body is an empty object', async () => {
    const { apiClient, mockFetch } = loadApiClient();
    mockFetch.mockResolvedValue(errorResponse(503, async () => ({})));

    await expect(apiClient.apiRequest('/api/x')).rejects.toMatchObject({
      message: 'HTTP 503',
      status: 503,
    });
  });

  it('leaves code/data undefined when the body does not carry them', async () => {
    const { apiClient, mockFetch } = loadApiClient();
    mockFetch.mockResolvedValue(errorResponse(401, async () => ({ error: 'Unauthorized' })));

    await expect(apiClient.apiRequest('/api/x')).rejects.toMatchObject({
      message: 'Unauthorized',
      code: undefined,
      data: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Version header
// ---------------------------------------------------------------------------

describe('client version header', () => {
  it('is present on requests when the app version is known', async () => {
    const { apiClient, mockFetch } = loadApiClient({ expoConfig: { version: '2.5.0' } });
    mockFetch.mockResolvedValue(okResponse(200, { ok: true }));

    await apiClient.apiRequest('/api/ping');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-openwhispr-version']).toBe('2.5.0');
  });

  it('is absent when the app version is undefined (never sent empty)', async () => {
    const { apiClient, mockFetch } = loadApiClient({ expoConfig: {} });
    mockFetch.mockResolvedValue(okResponse(200, { ok: true }));

    await apiClient.apiRequest('/api/ping');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('x-openwhispr-version');
  });

  it('is absent when expoConfig itself is unavailable', async () => {
    const { apiClient, mockFetch } = loadApiClient({ expoConfig: null });
    mockFetch.mockResolvedValue(okResponse(200, { ok: true }));

    await apiClient.apiRequest('/api/ping');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('x-openwhispr-version');
  });
});

describe('getClientVersionHeader', () => {
  it('identifies mobile alongside the version and policy capability', () => {
    const { apiClient } = loadApiClient({ expoConfig: { version: '9.9.9' } });
    expect(apiClient.getClientVersionHeader()).toEqual({
      'x-openwhispr-version': '9.9.9',
      'x-openwhispr-policy-version': '1',
      'x-openwhispr-platform': 'mobile',
    });
  });

  it('identifies mobile even when the version is unknown', () => {
    const { apiClient } = loadApiClient({ expoConfig: {} });
    expect(apiClient.getClientVersionHeader()).toEqual({
      'x-openwhispr-policy-version': '1',
      'x-openwhispr-platform': 'mobile',
    });
  });
});

describe('mobile cloud request identification', () => {
  it.each(['/api/reason', '/api/openai-realtime-token'])(
    'sends the mobile platform to %s with auth and custom headers',
    async (path) => {
      const { apiClient, mockFetch } = loadApiClient({
        expoConfig: { version: '1.2.1' },
        sessionCookie: 'test-session-cookie',
      });
      mockFetch.mockResolvedValue(okResponse(200, {}));

      await apiClient.api.post(
        path,
        {},
        { headers: { 'X-OpenWhispr-Client-Timeout-Ms': '45000' } },
      );

      expect(mockFetch).toHaveBeenCalledWith(
        `${apiClient.BASE_URL}${path}`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Cookie: 'test-session-cookie',
            'x-openwhispr-version': '1.2.1',
            'x-openwhispr-policy-version': '1',
            'x-openwhispr-platform': 'mobile',
            'X-OpenWhispr-Client-Timeout-Ms': '45000',
          }),
        }),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Policy version header
// ---------------------------------------------------------------------------

describe('client policy header', () => {
  it('is always present on requests, regardless of app version', async () => {
    const { apiClient, mockFetch } = loadApiClient({ expoConfig: {} });
    mockFetch.mockResolvedValue(okResponse(200, { ok: true }));

    await apiClient.apiRequest('/api/ping');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-openwhispr-policy-version']).toBe('1');
  });

  it('is sent with the exact value "1"', async () => {
    const { apiClient, mockFetch } = loadApiClient({ expoConfig: { version: '3.0.0' } });
    mockFetch.mockResolvedValue(okResponse(200, { ok: true }));

    await apiClient.apiRequest('/api/ping');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-openwhispr-policy-version']).toBe('1');
    expect(headers['x-openwhispr-version']).toBe('3.0.0');
  });
});

// ---------------------------------------------------------------------------
// 426 Upgrade Required
// ---------------------------------------------------------------------------

describe('426 UPGRADE_REQUIRED handling', () => {
  it('overrides the message to the fixed upgrade copy, ignoring the server body', async () => {
    const { apiClient, mockFetch } = loadApiClient();
    mockFetch.mockResolvedValue(
      errorResponse(426, async () => ({ error: 'raw server string', code: 'UPGRADE_REQUIRED' })),
    );

    await expect(apiClient.apiRequest('/api/reason')).rejects.toMatchObject({
      message: 'Update OpenWhispr to keep using cloud features.',
      status: 426,
      code: 'UPGRADE_REQUIRED',
    });
  });

  it('never surfaces "HTTP 426" even when the body is empty/unparseable', async () => {
    const { apiClient, mockFetch } = loadApiClient();
    mockFetch.mockResolvedValue(
      errorResponse(426, async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      }),
    );

    await expect(apiClient.apiRequest('/api/reason')).rejects.toMatchObject({
      message: 'Update OpenWhispr to keep using cloud features.',
      status: 426,
    });
  });
});

// ---------------------------------------------------------------------------
// Policy error predicates
// ---------------------------------------------------------------------------

describe('isPolicyModeBlockedError / isPolicyCloudBackupBlockedError', () => {
  it('isPolicyModeBlockedError is true only for 403 + POLICY_MODE_BLOCKED', () => {
    const { apiClient } = loadApiClient();
    const { ApiError, isPolicyModeBlockedError } = apiClient;
    expect(isPolicyModeBlockedError(new ApiError('blocked', 403, 'POLICY_MODE_BLOCKED'))).toBe(
      true,
    );
    expect(
      isPolicyModeBlockedError(new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED')),
    ).toBe(false);
    expect(isPolicyModeBlockedError(new ApiError('nope', 401, 'POLICY_MODE_BLOCKED'))).toBe(false);
    expect(isPolicyModeBlockedError(new Error('plain error'))).toBe(false);
    expect(isPolicyModeBlockedError(null)).toBe(false);
  });

  it('isPolicyCloudBackupBlockedError is true only for 403 + POLICY_CLOUD_BACKUP_BLOCKED', () => {
    const { apiClient } = loadApiClient();
    const { ApiError, isPolicyCloudBackupBlockedError } = apiClient;
    expect(
      isPolicyCloudBackupBlockedError(new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED')),
    ).toBe(true);
    expect(
      isPolicyCloudBackupBlockedError(new ApiError('blocked', 403, 'POLICY_MODE_BLOCKED')),
    ).toBe(false);
    expect(
      isPolicyCloudBackupBlockedError(new ApiError('nope', 500, 'POLICY_CLOUD_BACKUP_BLOCKED')),
    ).toBe(false);
    expect(isPolicyCloudBackupBlockedError(new Error('plain error'))).toBe(false);
  });
});
