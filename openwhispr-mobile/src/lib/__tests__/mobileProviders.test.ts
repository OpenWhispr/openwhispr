import {
  MOBILE_PROVIDER_IDS,
  getMobileProvidersForScope,
  resolveMobileInferenceRoute,
} from '../mobileProviders';

it('offers only the OpenAI-compatible providers for each scope', () => {
  expect(getMobileProvidersForScope('dictation').map((provider) => provider.id)).toEqual([
    'openai',
    'groq',
    'custom',
  ]);
  expect(getMobileProvidersForScope('upload').map((provider) => provider.id)).toEqual([
    'openai',
    'groq',
    'custom',
  ]);
  expect(getMobileProvidersForScope('cleanup').map((provider) => provider.id)).toEqual([
    'openai',
    'groq',
    'openrouter',
    'custom',
  ]);
  expect(MOBILE_PROVIDER_IDS).toEqual(['openai', 'groq', 'openrouter', 'custom']);
});

it('refuses providers outside the mobile allowlist', () => {
  expect(
    resolveMobileInferenceRoute({
      scope: 'dictation',
      selection: {
        mode: 'providers',
        providerId: 'xai',
        modelId: 'grok-stt',
        credentialRef: 'provider.xai',
      },
      policy: { status: 'unmanaged' },
    }),
  ).toEqual({ ok: false, code: 'PROVIDER_UNSUPPORTED' });
});

it('refuses the meeting scope for providers', () => {
  expect(
    resolveMobileInferenceRoute({
      scope: 'meeting',
      selection: {
        mode: 'providers',
        providerId: 'openai',
        modelId: 'gpt-4o-transcribe',
        credentialRef: 'provider.openai',
      },
      policy: { status: 'unmanaged' },
    }),
  ).toEqual({ ok: false, code: 'PROVIDER_UNSUPPORTED' });
});

it('resolves supported selections to the catalog endpoint', () => {
  const result = resolveMobileInferenceRoute({
    scope: 'upload',
    selection: {
      mode: 'providers',
      providerId: 'groq',
      modelId: 'whisper-large-v3-turbo',
      credentialRef: 'provider.groq',
    },
    policy: { status: 'unmanaged' },
  });
  expect(result).toMatchObject({
    ok: true,
    route: { providerId: 'groq', endpoint: 'https://api.groq.com/openai/v1' },
  });
  expect(
    resolveMobileInferenceRoute({
      scope: 'meeting',
      selection: { mode: 'openwhispr' },
      policy: { status: 'unmanaged' },
    }),
  ).toEqual({ ok: true, route: { mode: 'openwhispr', scope: 'meeting' } });
});

const groqDictation = {
  mode: 'providers' as const,
  providerId: 'groq',
  modelId: 'whisper-large-v3-turbo',
  credentialRef: 'provider.groq',
};
const dictationInput = {
  scope: 'dictation' as const,
  selection: groqDictation,
  policy: { status: 'unmanaged' as const },
};

it('refuses remote routes for private content and while policy is unresolved', () => {
  expect(resolveMobileInferenceRoute({ ...dictationInput, privateContent: true })).toEqual({
    ok: false,
    code: 'PRIVATE_CONTENT',
  });
  expect(resolveMobileInferenceRoute({ ...dictationInput, policy: { status: 'pending' } })).toEqual(
    { ok: false, code: 'POLICY_UNRESOLVED' },
  );
});

it('never swaps an unsupported transcription model for another', () => {
  expect(
    resolveMobileInferenceRoute({
      ...dictationInput,
      selection: { ...groqDictation, modelId: 'whisper-1' },
    }),
  ).toEqual({ ok: false, code: 'MODEL_UNSUPPORTED' });
});

it('accepts a discovered text model id without changing provider', () => {
  expect(
    resolveMobileInferenceRoute({
      scope: 'cleanup',
      selection: {
        mode: 'providers',
        providerId: 'openai',
        modelId: 'ft:gpt-4.1-mini:example',
        credentialRef: 'provider.openai',
      },
      policy: { status: 'unmanaged' },
    }),
  ).toMatchObject({
    ok: true,
    route: { providerId: 'openai', modelId: 'ft:gpt-4.1-mini:example' },
  });
});

it('applies managed allowlists separately to speech and text', () => {
  const policy = {
    status: 'managed' as const,
    transcription: { allowedModes: ['providers'], allowedByokProviders: ['openai'] },
    llm: { allowedModes: ['providers'], allowedByokProviders: ['groq'] },
  };
  expect(resolveMobileInferenceRoute({ ...dictationInput, policy })).toEqual({
    ok: false,
    code: 'POLICY_BLOCKED',
  });
  expect(
    resolveMobileInferenceRoute({
      ...dictationInput,
      scope: 'cleanup',
      selection: { ...groqDictation, modelId: 'openai/gpt-oss-120b' },
      policy,
    }).ok,
  ).toBe(true);
});

it('keeps a built-in provider on its own endpoint', () => {
  expect(
    resolveMobileInferenceRoute({
      ...dictationInput,
      selection: { ...groqDictation, endpoint: 'https://unrelated.example/v1' },
    }),
  ).toMatchObject({ ok: true, route: { endpoint: 'https://api.groq.com/openai/v1' } });
});

it('refuses public plain-HTTP custom endpoints', () => {
  expect(
    resolveMobileInferenceRoute({
      ...dictationInput,
      selection: {
        mode: 'providers',
        providerId: 'custom',
        modelId: 'my-model',
        endpoint: 'http://server.example/v1',
      },
    }),
  ).toEqual({ ok: false, code: 'ENDPOINT_INVALID' });
});

it('requires a credential and a model without changing the selection', () => {
  expect(
    resolveMobileInferenceRoute({
      ...dictationInput,
      selection: { ...groqDictation, credentialRef: undefined },
    }),
  ).toEqual({ ok: false, code: 'CREDENTIAL_REQUIRED' });
  expect(
    resolveMobileInferenceRoute({
      ...dictationInput,
      selection: { ...groqDictation, modelId: '' },
    }),
  ).toEqual({ ok: false, code: 'MODEL_REQUIRED' });
});
