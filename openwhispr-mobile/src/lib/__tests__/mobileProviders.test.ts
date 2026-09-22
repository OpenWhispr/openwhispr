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

it('refuses providers outside the mobile allowlist even when the shared catalog knows them', () => {
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

it('delegates supported selections to the shared resolver unchanged', () => {
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
