const mockCredentialListeners = new Set<(reference: string | null) => void>();
jest.mock('../ProviderCredentials', () => ({
  getProviderCredential: jest.fn(),
  getProviderCredentialReference: jest.fn(async (providerId: string) =>
    providerId === 'custom' ? 'custom.endpoint-fixture' : `provider.${providerId}`,
  ),
  subscribeProviderCredentialChanges: (listener: (reference: string | null) => void) => {
    mockCredentialListeners.add(listener);
    return () => mockCredentialListeners.delete(listener);
  },
}));
afterEach(() => {
  expect(mockCredentialListeners.size).toBe(0);
});
// Hermes has no DOMException global; run the abort paths the way the device does.
const nodeDOMException = globalThis.DOMException;
beforeAll(() => {
  delete (globalThis as { DOMException?: unknown }).DOMException;
});
afterAll(() => {
  globalThis.DOMException = nodeDOMException;
});
import type { InferenceRoute } from '@shared/ai/routing';
import {
  createProviderExecution,
  ProviderExecutionError,
  type ProviderExecutionDependencies,
} from '../ProviderExecution';

type ProviderRoute = Extract<InferenceRoute, { mode: 'providers' }>;

const route = (overrides: Partial<ProviderRoute> = {}): ProviderRoute => ({
  mode: 'providers',
  scope: 'cleanup',
  providerId: 'openai',
  modelId: 'gpt-4o-mini',
  endpoint: 'https://api.openai.com/v1',
  credentialRef:
    overrides.providerId === 'custom'
      ? 'custom.endpoint-fixture'
      : `provider.${overrides.providerId ?? 'openai'}`,
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

type FileRequest = Parameters<ProviderExecutionDependencies['requestFile']>[0];

function makeDependencies(
  responses: Response[],
  requests: Array<{ url: string; init: RequestInit }>,
  fileRequests: FileRequest[] = [],
  fileSize = 1024,
): ProviderExecutionDependencies {
  const next = (): Response => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected request');
    return response;
  };
  return {
    getCredential: async () => ({ apiKey: 'fixture-key' }),
    fileSize: async () => fileSize,
    request: async (url, init) => {
      requests.push({ url, init });
      return next();
    },
    requestFile: async (input) => {
      fileRequests.push(input);
      return next();
    },
  };
}

describe('ProviderExecution text adapters', () => {
  test('OpenAI-compatible providers send chat messages and parse fixture output', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const execution = createProviderExecution(
      makeDependencies(
        [jsonResponse({ choices: [{ message: { content: 'clean result' } }] })],
        requests,
      ),
    );

    await expect(
      execution.processProviderText({
        route: route(),
        text: 'raw transcript',
        systemPrompt: 'Clean the transcript.',
        temperature: 0.2,
        maxTokens: 800,
      }),
    ).resolves.toEqual({ text: 'clean result', model: 'gpt-4o-mini' });

    expect(requests[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Clean the transcript.' },
        { role: 'user', content: 'raw transcript' },
      ],
      temperature: 0.2,
      max_tokens: 800,
    });
  });

  test('OpenAI reasoning catalog models omit unsupported temperature', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const execution = createProviderExecution(
      makeDependencies([jsonResponse({ choices: [{ message: { content: 'result' } }] })], requests),
    );

    await execution.processProviderText({
      route: route({ modelId: 'gpt-5-mini' }),
      text: 'input',
      systemPrompt: 'system',
      temperature: 0.7,
      maxTokens: 700,
    });

    const body = JSON.parse(String(requests[0]?.init.body));
    expect(body).not.toHaveProperty('temperature');
    expect(body).toHaveProperty('max_completion_tokens', 700);
    expect(body).not.toHaveProperty('max_tokens');
  });

  test('preserves conversation roles before the latest user text', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const execution = createProviderExecution(
      makeDependencies(
        [jsonResponse({ choices: [{ message: { content: 'latest answer' } }] })],
        requests,
      ),
    );

    await execution.processProviderText({
      route: route(),
      text: 'latest question',
      systemPrompt: 'system',
      messages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
    });

    expect(JSON.parse(String(requests[0]?.init.body)).messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'latest question' },
    ]);
  });
});

describe('ProviderExecution batch transcription adapters', () => {
  test.each(['openai', 'groq', 'custom'])(
    '%s uploads an OpenAI-compatible multipart request',
    async (providerId) => {
      const fileRequests: FileRequest[] = [];
      const execution = createProviderExecution(
        makeDependencies(
          [jsonResponse({ text: 'fixture transcript', duration: 4.25 })],
          [],
          fileRequests,
        ),
      );

      await expect(
        execution.transcribeWithProvider({
          route: route({
            scope: 'upload',
            providerId,
            modelId: 'whisper-large-v3',
            endpoint:
              providerId === 'custom'
                ? 'https://lan.example/v1'
                : `https://${providerId}.example/v1`,
          }),
          audioUri: 'file:///recording.m4a',
          fileName: 'recording.m4a',
          language: 'en',
        }),
      ).resolves.toEqual({ text: 'fixture transcript', duration: 4.25 });

      expect(fileRequests[0]?.url).toBe(
        `${providerId === 'custom' ? 'https://lan.example/v1' : `https://${providerId}.example/v1`}/audio/transcriptions`,
      );
      expect(fileRequests[0]?.parameters).toEqual({ model: 'whisper-large-v3', language: 'en' });
      expect(fileRequests[0]?.headers.Authorization).toBe('Bearer fixture-key');
    },
  );

  test('reports an empty transcript as no speech rather than a provider failure', async () => {
    const execution = createProviderExecution(makeDependencies([jsonResponse({ text: ' ' })], []));
    await expect(
      execution.transcribeWithProvider({
        route: route({ scope: 'dictation', modelId: 'whisper-1' }),
        audioUri: 'file:///recording.m4a',
      }),
    ).rejects.toMatchObject({ message: 'No speech detected', retryable: false });
  });

  test('sends a file name the native multipart writer accepts', async () => {
    const fileRequests: FileRequest[] = [];
    const execution = createProviderExecution(
      makeDependencies([jsonResponse({ text: 'words' })], [], fileRequests),
    );
    await execution.transcribeWithProvider({
      route: route({ scope: 'upload', modelId: 'whisper-1' }),
      audioUri: 'file:///import.m4a',
      fileName: 'Team "sync"\\notes.m4a',
    });
    expect(fileRequests[0]?.fileName).toBe('Team _sync__notes.m4a');
  });

  test.each(['deepgram', 'assemblyai'])(
    '%s rejects batch audio before touching the file',
    async (providerId) => {
      const fileSize = jest.fn(async () => 1024);
      const requestFile = jest.fn();
      const execution = createProviderExecution({
        ...makeDependencies([], []),
        fileSize,
        requestFile,
      });

      await expect(
        execution.transcribeWithProvider({
          route: route({
            scope: 'upload',
            providerId,
            modelId: 'streaming',
            endpoint: `https://${providerId}.example/v1`,
          }),
          audioUri: 'file:///audio.m4a',
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
      expect(fileSize).not.toHaveBeenCalled();
      expect(requestFile).not.toHaveBeenCalled();
    },
  );

  test('refuses a provider outside the mobile allowlist before touching credentials', async () => {
    const getCredential = jest.fn();
    const execution = createProviderExecution({
      ...makeDependencies([], []),
      getCredential,
    });
    await expect(
      execution.transcribeWithProvider({
        route: route({ providerId: 'xai', endpoint: 'https://api.x.ai/v1', scope: 'dictation' }),
        audioUri: 'file:///audio.m4a',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
    await expect(
      execution.processProviderText({
        route: route({ providerId: 'anthropic', endpoint: 'https://api.anthropic.com/v1' }),
        text: 'hi',
        systemPrompt: 'test',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
    expect(getCredential).not.toHaveBeenCalled();
  });

  test('refuses audio over the provider limit before uploading', async () => {
    const fileRequests: FileRequest[] = [];
    const execution = createProviderExecution(
      makeDependencies([], [], fileRequests, 25 * 1024 * 1024 + 1),
    );
    await expect(
      execution.transcribeWithProvider({
        route: route({ scope: 'dictation' }),
        audioUri: 'file:///audio.m4a',
      }),
    ).rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE' });
    expect(fileRequests).toHaveLength(0);
  });

  test('sends the dictionary prompt and omits it when absent', async () => {
    const fileRequests: FileRequest[] = [];
    const execution = createProviderExecution(
      makeDependencies(
        [jsonResponse({ text: 'a' }), jsonResponse({ text: 'b' })],
        [],
        fileRequests,
      ),
    );
    await execution.transcribeWithProvider({
      route: route({ scope: 'dictation' }),
      audioUri: 'file:///audio.m4a',
      prompt: 'OpenWhispr, Gizmo',
    });
    await execution.transcribeWithProvider({
      route: route({ scope: 'dictation' }),
      audioUri: 'file:///audio.m4a',
    });
    expect(fileRequests[0]?.parameters.prompt).toBe('OpenWhispr, Gizmo');
    expect(fileRequests[1]?.parameters.prompt).toBeUndefined();
  });

  test('a redirect returned by the native transport is reported as blocked', async () => {
    const execution = createProviderExecution(
      makeDependencies(
        [new Response('', { status: 307, headers: { Location: 'https://elsewhere.example' } })],
        [],
      ),
    );
    await expect(
      execution.transcribeWithProvider({
        route: route({ scope: 'dictation' }),
        audioUri: 'file:///audio.m4a',
      }),
    ).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
  });

  test('maps quota and missing-model statuses to actionable codes', async () => {
    const execution = createProviderExecution(
      makeDependencies([jsonResponse({}, 402), jsonResponse({}, 404)], []),
    );
    await expect(
      execution.processProviderText({ route: route(), text: 'hi', systemPrompt: 'test' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_QUOTA_EXCEEDED' });
    await expect(
      execution.processProviderText({ route: route(), text: 'hi', systemPrompt: 'test' }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });
});

describe('ProviderExecution security and errors', () => {
  test('fetch redirects to another origin are rejected without exposing response bodies', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const redirected = jsonResponse({ secret: 'raw-provider-body' });
    Object.defineProperties(redirected, {
      redirected: { value: true },
      url: { value: 'https://attacker.example/result' },
    });
    const execution = createProviderExecution(makeDependencies([redirected], requests));

    await expect(
      execution.processProviderText({
        route: route(),
        text: 'input',
        systemPrompt: 'system',
      }),
    ).rejects.toMatchObject({
      code: 'REDIRECT_BLOCKED',
      message: expect.not.stringContaining('raw-provider-body'),
    });
    expect(requests[0]?.init.redirect).toBe('manual');
  });

  test('missing credentials and malformed successful responses are actionable', async () => {
    const execution = createProviderExecution({
      ...makeDependencies([jsonResponse({ choices: [] })], []),
      getCredential: async () => null,
    });

    await expect(
      execution.processProviderText({ route: route(), text: 'input', systemPrompt: 'system' }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' });
  });

  test.each([
    ['PROVIDER_LOCAL_NETWORK_ERROR', 'Check Local Network permission and the server address.'],
    ['PROVIDER_CANCELLED', 'AbortError'],
  ])('normalizes native %s failures without forwarding native details', async (code, expected) => {
    const execution = createProviderExecution({
      ...makeDependencies([], []),
      request: async () => {
        throw Object.assign(new Error('native detail with sensitive URL'), { code });
      },
    });

    const promise = execution.processProviderText({
      route: route(),
      text: 'input',
      systemPrompt: 'system',
    });
    if (code === 'PROVIDER_CANCELLED') {
      await expect(promise).rejects.toMatchObject({ name: expected });
    } else {
      await expect(promise).rejects.toMatchObject({
        code,
        message: expected,
      });
    }
  });

  test.each([
    ['PROVIDER_HTTPS_REQUIRED', 'iOS only allows this server over HTTPS. Use an HTTPS address.'],
    ['PROVIDER_AUDIO_UNAVAILABLE', 'The recorded audio is unavailable. Record again.'],
    [
      'PROVIDER_RECOVERY_UNAVAILABLE',
      'The recording could not be saved for recovery. The original audio is retained.',
    ],
    ['PROVIDER_TRANSPORT_UNAVAILABLE', 'Update OpenWhispr to use your own provider key.'],
  ])('reports native %s as a final, readable failure', async (code, message) => {
    const execution = createProviderExecution({
      ...makeDependencies([], []),
      request: async () => {
        throw Object.assign(new Error('native detail'), { code });
      },
    });
    await expect(
      execution.processProviderText({ route: route(), text: 'input', systemPrompt: 'system' }),
    ).rejects.toMatchObject({ code, message, retryable: false });
  });

  test.each([
    ['openai', 'OpenAI rejected the configured credential.'],
    ['custom', 'Custom server rejected the configured credential.'],
  ])('names %s the way the settings screen does in error copy', async (providerId, message) => {
    const execution = createProviderExecution(makeDependencies([jsonResponse({}, 401)], []));
    await expect(
      execution.processProviderText({
        route: route({
          providerId,
          ...(providerId === 'custom' ? { endpoint: 'https://lan.example/v1' } : {}),
        }),
        text: 'input',
        systemPrompt: 'system',
      }),
    ).rejects.toMatchObject({ message });
  });

  test.each([
    [401, 'INVALID_CREDENTIAL'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [503, 'PROVIDER_UNAVAILABLE'],
    [400, 'PROVIDER_REQUEST_FAILED'],
  ])('maps HTTP %s to sanitized %s', async (status, code) => {
    const execution = createProviderExecution(
      makeDependencies([jsonResponse({ error: { message: 'raw provider detail' } }, status)], []),
    );

    await expect(
      execution.processProviderText({ route: route(), text: 'input', systemPrompt: 'system' }),
    ).rejects.toMatchObject({
      code,
      message: expect.not.stringContaining('raw provider detail'),
    });
  });
});

describe('ProviderExecution setup checks', () => {
  test('model discovery returns sanitized models without claiming inference access', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const execution = createProviderExecution(
      makeDependencies(
        [
          jsonResponse({
            data: [{ id: 'model-b' }, { id: 'model-a' }, { id: '' }, { owned_by: 'missing-id' }],
          }),
        ],
        requests,
      ),
    );

    await expect(execution.discoverProviderModels({ route: route() })).resolves.toEqual({
      models: [
        { id: 'model-a', name: 'model-a' },
        { id: 'model-b', name: 'model-b' },
      ],
      verification: 'catalog-only',
    });
    expect(requests[0]?.url).toBe('https://api.openai.com/v1/models');
  });

  test('text connection testing performs a minimal inference and identifies its scope', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const execution = createProviderExecution(
      makeDependencies([jsonResponse({ choices: [{ message: { content: 'OK' } }] })], requests),
    );

    await expect(
      execution.testProviderConnection({ route: route({ modelId: 'gpt-6-astra' }) }),
    ).resolves.toEqual({
      ok: true,
      verification: 'inference',
      providerId: 'openai',
      modelId: 'gpt-6-astra',
      scope: 'cleanup',
    });
    // Reasoning models spend a small output cap on hidden reasoning and return
    // no text, which would fail a valid key.
    const body = JSON.parse(String(requests[0]?.init.body));
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
  });

  test('connection checks can try a typed key before it is saved', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const getCredential = jest.fn();
    const execution = createProviderExecution({
      ...makeDependencies([jsonResponse({ choices: [{ message: { content: 'OK' } }] })], requests),
      getCredential,
    });
    await execution.testProviderConnection({ route: route(), apiKey: 'typed-key' });
    expect(new Headers(requests[0]?.init.headers).get('Authorization')).toBe('Bearer typed-key');
    expect(getCredential).not.toHaveBeenCalled();
  });

  test('transcription connection testing reports catalog access rather than inference', async () => {
    const execution = createProviderExecution(
      makeDependencies([jsonResponse({ data: [{ id: 'whisper-large-v3' }] })], []),
    );

    await expect(
      execution.testProviderConnection({
        route: route({ scope: 'upload', providerId: 'groq', modelId: 'whisper-large-v3' }),
      }),
    ).resolves.toEqual({
      ok: true,
      verification: 'catalog-only',
      providerId: 'groq',
      modelId: 'whisper-large-v3',
      scope: 'upload',
    });
  });
});

describe('ProviderExecutionError retry metadata', () => {
  test.each([
    [401, 'INVALID_CREDENTIAL'],
    [404, 'MODEL_NOT_FOUND'],
    [429, 'PROVIDER_RATE_LIMITED'],
  ])('marks deterministic HTTP %i failures as non-retryable', async (status, code) => {
    const execution = createProviderExecution(
      makeDependencies([jsonResponse({ error: 'sensitive body' }, status)], []),
    );

    await expect(
      execution.processProviderText({
        route: route(),
        text: 'input',
        systemPrompt: 'system',
      }),
    ).rejects.toMatchObject({ code, status, retryable: false });
  });

  test('marks provider 5xx and transport failures as retryable without leaking a body', async () => {
    const unavailable = createProviderExecution(
      makeDependencies([jsonResponse({ error: 'sensitive body' }, 503)], []),
    );
    await expect(
      unavailable.processProviderText({ route: route(), text: 'input', systemPrompt: 'system' }),
    ).rejects.toMatchObject({ status: 503, retryable: true });

    const network = createProviderExecution({
      ...makeDependencies([], []),
      request: async () => {
        throw new Error('socket included secret fixture-key');
      },
    });
    await expect(
      network.processProviderText({ route: route(), text: 'input', systemPrompt: 'system' }),
    ).rejects.toEqual(
      new ProviderExecutionError('PROVIDER_NETWORK_ERROR', 'Unable to reach OpenAI.', {
        retryable: true,
      }),
    );
  });
});

test('deleting a credential aborts ordinary HTTP and rejects without waiting for the network', async () => {
  let activeSignal: AbortSignal | undefined;
  const request = jest.fn((_url: string, init: RequestInit): Promise<Response> => {
    activeSignal = init.signal ?? undefined;
    return new Promise(() => undefined);
  });
  const execution = createProviderExecution({ ...makeDependencies([], []), request });
  const result = execution.processProviderText({
    route: route(),
    text: 'private words',
    systemPrompt: 'Clean',
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  for (let index = 0; index < 10 && !request.mock.calls.length; index++) await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(1);
  mockCredentialListeners.forEach((listener) => listener('provider.groq'));
  expect(activeSignal?.aborted).toBe(false);
  mockCredentialListeners.forEach((listener) => listener('provider.openai'));
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(activeSignal?.aborted).toBe(true);
});
test('a credential change that lands as the response arrives still rejects', async () => {
  let finishRequest!: (response: Response) => void;
  const request = jest.fn(
    (): Promise<Response> =>
      new Promise((resolve) => {
        finishRequest = resolve;
      }),
  );
  const execution = createProviderExecution({ ...makeDependencies([], []), request });
  const result = execution.processProviderText({
    route: route(),
    text: 'words',
    systemPrompt: 'Clean',
  });
  for (let index = 0; index < 10 && !request.mock.calls.length; index++) await Promise.resolve();
  mockCredentialListeners.forEach((listener) => listener('provider.openai'));
  finishRequest(jsonResponse({ choices: [{ message: { content: 'output' } }] }));
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
});
test('credential reset during a key read prevents a later HTTP request', async () => {
  let finishCredential!: (value: { apiKey: string }) => void;
  const request = jest.fn(async () =>
    jsonResponse({ choices: [{ message: { content: 'output' } }] }),
  );
  const execution = createProviderExecution({
    ...makeDependencies([], []),
    request,
    getCredential: () =>
      new Promise((resolve) => {
        finishCredential = resolve;
      }),
  });
  const result = execution.processProviderText({
    route: route(),
    text: 'words',
    systemPrompt: 'Clean',
  });
  for (let index = 0; index < 10 && !finishCredential; index++) await Promise.resolve();
  mockCredentialListeners.forEach((listener) => listener(null));
  finishCredential({ apiKey: 'deleted-key' });
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).not.toHaveBeenCalled();
});

test.each(['provider.openai', 'custom.another-endpoint'])(
  'rejects a mismatched custom credential %s before reading or transmitting it',
  async (credentialRef) => {
    const getCredential = jest.fn(async () => ({ apiKey: 'fixture' }));
    const request = jest.fn();
    const execution = createProviderExecution({
      ...makeDependencies([], []),
      getCredential,
      request,
    });
    await expect(
      execution.processProviderText({
        route: route({
          providerId: 'custom',
          endpoint: 'https://different.example/v1',
          credentialRef,
        }),
        text: 'words',
        systemPrompt: 'Clean',
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_MISMATCH' });
    expect(getCredential).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  },
);
