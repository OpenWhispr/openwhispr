import type { InferenceRoute } from '@shared/ai/routing';
import {
  createRealtimeProviderProtocol,
  type RealtimeProviderDependencies,
} from '../RealtimeProviderProtocol';

type ProviderRoute = Extract<InferenceRoute, { mode: 'providers' }>;

const route = (providerId: string, modelId: string): ProviderRoute => ({
  mode: 'providers',
  scope: 'meeting',
  providerId,
  modelId,
  endpoint: `https://${providerId}.example/v1`,
  credentialRef: `provider.${providerId}`,
});

const dependencies: RealtimeProviderDependencies & { request: jest.Mock } = {
  getCredential: async () => ({ apiKey: 'fixture-key' }),
  request: jest.fn(),
};

beforeEach(() => {
  dependencies.getCredential = async () => ({ apiKey: 'fixture-key' });
  dependencies.request.mockReset();
});

test('Deepgram configures raw PCM and normalizes partial and final results', async () => {
  const protocol = await createRealtimeProviderProtocol(
    route('deepgram', 'nova-3'),
    { language: 'en', sampleRate: 24000 },
    dependencies,
  );

  expect(protocol.connection.url).toContain('wss://api.deepgram.com/v1/listen?');
  expect(protocol.connection.url).toContain('encoding=linear16');
  expect(protocol.connection.protocols).toEqual(['token', 'fixture-key']);
  expect(protocol.encodeAudio(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
  expect(
    protocol.normalize({
      type: 'Results',
      is_final: false,
      start: 1.5,
      duration: 0.5,
      channel: { alternatives: [{ transcript: 'hello' }] },
    }),
  ).toEqual([{ type: 'provider.partial', item_id: 'deepgram-1500', transcript: 'hello' }]);
  expect(
    protocol.normalize({
      type: 'Results',
      is_final: true,
      start: 1.5,
      duration: 0.5,
      channel: { alternatives: [{ transcript: 'hello world' }] },
    }),
  ).toEqual([
    {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'deepgram-1500',
      transcript: 'hello world',
      audio_start_ms: 1500,
      audio_end_ms: 2000,
    },
  ]);
});

test('AssemblyAI exchanges the long-lived key for a short-lived streaming token', async () => {
  dependencies.request.mockResolvedValue(
    new Response(JSON.stringify({ token: 'temporary-token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  const protocol = await createRealtimeProviderProtocol(
    route('assemblyai', 'universal-3-5-pro'),
    { sampleRate: 16000 },
    dependencies,
  );

  expect(dependencies.request).toHaveBeenCalledWith(
    'https://streaming.assemblyai.com/v3/token?expires_in_seconds=60',
    expect.objectContaining({ headers: { Authorization: 'fixture-key' } }),
  );
  expect(protocol.connection.url).toContain('token=temporary-token');
  expect(
    protocol.normalize({
      type: 'Turn',
      turn_order: 4,
      transcript: 'assembled words',
      end_of_turn: true,
      words: [{ start: 200, end: 900 }],
    }),
  ).toEqual([
    {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'assemblyai-4',
      transcript: 'assembled words',
      audio_start_ms: 200,
      audio_end_ms: 900,
    },
  ]);
});

test('Corti authenticates with client credentials and delays audio until config acceptance', async () => {
  dependencies.getCredential = async () => ({
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });
  dependencies.request.mockResolvedValue(
    new Response(JSON.stringify({ access_token: 'corti-token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  const protocol = await createRealtimeProviderProtocol(
    { ...route('corti', 'corti-transcribe'), endpoint: 'https://api.us.corti.app/v2' },
    { language: 'en', sampleRate: 16000 },
    dependencies,
  );

  expect(protocol.connection.waitForReadyEvent).toBe(true);
  expect(protocol.onOpenMessages).toEqual([
    JSON.stringify({
      type: 'config',
      configuration: {
        primaryLanguage: 'en',
        interimResults: true,
        automaticPunctuation: true,
        audioFormat: 'audio/pcm; rate=16000; channels=1; bits=16',
      },
    }),
  ]);
  expect(protocol.normalize({ type: 'CONFIG_ACCEPTED' })).toEqual([{ type: 'provider.ready' }]);
});

test('Gemini Live configures input transcription and normalizes revised and final text', async () => {
  const protocol = await createRealtimeProviderProtocol(
    {
      ...route('gemini', 'gemini-3.5-transcribe-live'),
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    },
    { language: 'en', sampleRate: 16000 },
    dependencies,
  );

  expect(protocol.connection.url).toContain('BidiGenerateContent?key=fixture-key');
  expect(JSON.parse(protocol.onOpenMessages[0])).toEqual({
    setup: {
      model: 'models/gemini-3.5-transcribe-live',
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: { languageCodes: ['en'] },
    },
  });
  expect(protocol.normalize({ setupComplete: {} })).toEqual([{ type: 'provider.ready' }]);
  expect(
    protocol.normalize({ serverContent: { inputTranscription: { text: 'final words' } } }),
  ).toEqual([
    expect.objectContaining({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'final words',
    }),
  ]);
});

test('Tinfoil selects only the attested native socket factory', async () => {
  const protocol = await createRealtimeProviderProtocol(
    route('tinfoil', 'voxtral'),
    {},
    dependencies,
  );

  expect(protocol.connection.url).toBe('');
  expect(protocol.connection.protocols).toEqual([]);
  expect(protocol.connection.socketFactory).toEqual(expect.any(Function));
});

test('OpenAI configures the selected model, language, sample rate, and waits for acknowledgement', async () => {
  const protocol = await createRealtimeProviderProtocol(
    route('openai', 'gpt-live-transcribe'),
    { language: 'en', sampleRate: 16000 },
    dependencies,
  );

  expect(protocol.connection.waitForReadyEvent).toBe(true);
  expect(JSON.parse(protocol.onOpenMessages[0])).toEqual({
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 16000 },
          transcription: { model: 'gpt-live-transcribe', language: 'en' },
          turn_detection: null,
        },
      },
    },
  });
  expect(protocol.normalize({ type: 'session.updated' })).toEqual([{ type: 'provider.ready' }]);
});

test('Tinfoil configures 24k meeting audio and the selected attested model', async () => {
  const protocol = await createRealtimeProviderProtocol(
    route('tinfoil', 'voxtral'),
    { sampleRate: 24000 },
    dependencies,
  );

  expect(JSON.parse(protocol.onOpenMessages[0])).toEqual(
    expect.objectContaining({
      session: expect.objectContaining({
        audio: {
          input: expect.objectContaining({
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'voxtral' },
          }),
        },
      }),
    }),
  );
});

test('protocol terminal events cover delayed and empty provider finalization', async () => {
  const deepgram = await createRealtimeProviderProtocol(
    route('deepgram', 'nova-3'),
    {},
    dependencies,
  );
  expect(
    deepgram.normalize({
      type: 'Results',
      from_finalize: true,
      channel: { alternatives: [{ transcript: '' }] },
    }),
  ).toEqual([{ type: 'provider.finished' }]);

  dependencies.request.mockResolvedValue(
    new Response(JSON.stringify({ token: 'temporary-token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const assembly = await createRealtimeProviderProtocol(
    route('assemblyai', 'universal-3-5-pro'),
    {},
    dependencies,
  );
  expect(assembly.normalize({ type: 'Termination' })).toEqual([{ type: 'provider.finished' }]);

  const gemini = await createRealtimeProviderProtocol(
    route('gemini', 'gemini-3.5-transcribe-live'),
    {},
    dependencies,
  );
  expect(gemini.normalize({ serverContent: { turnComplete: true } })).toEqual([
    { type: 'provider.finished' },
  ]);

  const openai = await createRealtimeProviderProtocol(
    route('openai', 'gpt-live-transcribe'),
    {},
    dependencies,
  );
  expect(
    openai.normalize({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'late final words',
    }),
  ).toEqual([
    {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'late final words',
    },
    { type: 'provider.finished' },
  ]);
});

test.each([
  ['deepgram', 'nova-3', { type: 'Error', description: 'secret dg raw body' }, 'Deepgram'],
  [
    'assemblyai',
    'universal-3-5-pro',
    { type: 'Error', error: 'secret assembly body' },
    'AssemblyAI',
  ],
  [
    'corti',
    'corti-transcribe',
    { type: 'error', error: { details: 'secret corti body' } },
    'Corti',
  ],
  [
    'openai',
    'gpt-live-transcribe',
    { type: 'error', error: { message: 'secret openai body' } },
    'OpenAI',
  ],
  ['tinfoil', 'voxtral', { type: 'error', error: { message: 'secret tinfoil body' } }, 'Tinfoil'],
])('sanitizes %s wire errors before exposing them', async (providerId, modelId, event, label) => {
  if (providerId === 'assemblyai') {
    dependencies.request.mockResolvedValue(
      new Response(JSON.stringify({ token: 'temporary-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  if (providerId === 'corti') {
    dependencies.getCredential = async () => ({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    dependencies.request.mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'temporary-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  const protocol = await createRealtimeProviderProtocol(
    route(providerId, modelId),
    {},
    dependencies,
  );
  const normalized = protocol.normalize(event);
  expect(normalized).toEqual([
    {
      type: 'error',
      error: {
        message: `${label} could not continue transcription. Check provider settings and try again.`,
      },
    },
  ]);
  expect(JSON.stringify(normalized)).not.toContain('secret');
});

test('rejects a mismatched credential reference before reading credentials or starting network work', async () => {
  const getCredential = jest.fn(async () => ({ apiKey: 'must-not-be-read' }));
  const request = jest.fn();

  await expect(
    createRealtimeProviderProtocol(
      { ...route('deepgram', 'nova-3'), credentialRef: 'provider.openai' },
      {},
      { getCredential, request },
    ),
  ).rejects.toMatchObject({ code: 'CREDENTIAL_REFERENCE_INVALID' });
  expect(getCredential).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

test.each(['openai', 'tinfoil'])(
  '%s disables automatic turn commits for file replay',
  async (providerId) => {
    const protocol = await createRealtimeProviderProtocol(
      route(providerId, 'fixture-model'),
      { manualCommit: true, sampleRate: 16000 },
      dependencies,
    );
    expect(JSON.parse(protocol.onOpenMessages[0]).session.audio.input.turn_detection).toBeNull();
    const meeting = await createRealtimeProviderProtocol(
      route(providerId, 'fixture-model'),
      { sampleRate: 24000 },
      dependencies,
    );
    expect(JSON.parse(meeting.onOpenMessages[0]).session.audio.input.turn_detection).toMatchObject({
      type: 'server_vad',
    });
  },
);
