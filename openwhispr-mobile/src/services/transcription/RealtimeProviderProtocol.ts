import type { InferenceRoute } from '@shared/ai/routing';
import type { ProviderCredential } from '@/services/providers/ProviderCredentials';
import { ProviderExecutionError } from '@/services/providers/ProviderExecution';

type ProviderRoute = Extract<InferenceRoute, { mode: 'providers' }>;

export type RealtimeWireData = string | ArrayBuffer | ArrayBufferView;

export interface RealtimeProviderOptions {
  manualCommit?: boolean;
  signal?: AbortSignal;
  language?: string;
  sampleRate?: number;
}

export interface RealtimeProviderDependencies {
  getCredential(reference: string): Promise<ProviderCredential | null>;
  request(url: string, init: RequestInit): Promise<Response>;
}

export interface RealtimeProviderProtocol {
  providerId: string;
  connection: {
    url: string;
    protocols: string[];
    waitForReadyEvent: boolean;
    socketFactory?: () => {
      readyState: number;
      send(data: RealtimeWireData): void;
      close(code?: number, reason?: string): void;
      onopen: ((event?: unknown) => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      onerror: ((event?: unknown) => void) | null;
      onclose: ((event: { code?: number }) => void) | null;
    };
  };
  onOpenMessages: string[];
  encodeAudio(bytes: Uint8Array): RealtimeWireData;
  finalizeMessages: RealtimeWireData[];
  normalize(message: unknown): unknown[];
}

interface JsonObject {
  [key: string]: unknown;
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requireCredential(
  route: ProviderRoute,
  credential: ProviderCredential | null,
): ProviderCredential {
  if (!credential) {
    throw new ProviderExecutionError(
      'CREDENTIAL_MISSING',
      `Configure credentials for ${route.providerId}.`,
    );
  }
  return credential;
}

function requireApiKey(route: ProviderRoute, credential: ProviderCredential): string {
  const apiKey = credential.apiKey?.trim();
  if (!apiKey) {
    throw new ProviderExecutionError(
      'CREDENTIAL_INVALID',
      `${route.providerId} requires an API key.`,
    );
  }
  return apiKey;
}

function assertSuccessfulResponse(
  response: Response,
  providerId: string,
  requestUrl: string,
): void {
  const requestOrigin = new URL(requestUrl).origin;
  const responseOrigin = response.url ? new URL(response.url).origin : requestOrigin;
  if (
    response.redirected ||
    (response.status >= 300 && response.status < 400) ||
    responseOrigin !== requestOrigin
  ) {
    throw new ProviderExecutionError(
      'REDIRECT_BLOCKED',
      'The provider redirected the credential request.',
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ProviderExecutionError(
      'INVALID_CREDENTIAL',
      `${providerId} rejected the configured credential.`,
    );
  }
  if (!response.ok) {
    throw new ProviderExecutionError(
      'PROVIDER_REQUEST_FAILED',
      `${providerId} rejected the connection request (${response.status}).`,
    );
  }
}

async function readJson(response: Response, providerId: string): Promise<JsonObject> {
  try {
    const parsed = objectValue(await response.json());
    if (parsed) return parsed;
  } catch {
    // Normalize below without surfacing the response body.
  }
  throw new ProviderExecutionError(
    'PROVIDER_RESPONSE_INVALID',
    `${providerId} returned an invalid connection response.`,
  );
}

function completedEvent(
  itemId: string,
  transcript: string,
  startMs: number | null,
  endMs: number | null,
): JsonObject {
  return {
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
    ...(startMs !== null ? { audio_start_ms: startMs } : {}),
    ...(endMs !== null ? { audio_end_ms: endMs } : {}),
  };
}

function partialEvent(itemId: string, transcript: string): JsonObject {
  return { type: 'provider.partial', item_id: itemId, transcript };
}

function errorEvent(message: string): JsonObject {
  return { type: 'error', error: { message } };
}

function finishedEvent(): JsonObject {
  return { type: 'provider.finished' };
}

function openAiSessionUpdate(route: ProviderRoute, options: RealtimeProviderOptions): string {
  const transcription = {
    model: route.modelId,
    ...(options.language && options.language !== 'auto' ? { language: options.language } : {}),
  };
  const turnDetection =
    options.manualCommit || route.modelId.startsWith('gpt-live-transcribe')
      ? null
      : {
          type: 'server_vad',
          threshold: 0.6,
          silence_duration_ms: 600,
          prefix_padding_ms: 500,
        };
  return JSON.stringify({
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: options.sampleRate ?? 24000 },
          transcription,
          turn_detection: turnDetection,
        },
      },
    },
  });
}

function normalizeOpenAiEvent(message: unknown, providerId: string): unknown[] {
  const event = objectValue(message);
  if (!event) return [];
  if (event.type === 'session.updated') return [{ type: 'provider.ready' }];
  if (
    event.type === 'error' ||
    event.type === 'conversation.item.input_audio_transcription.failed'
  ) {
    return [
      errorEvent(
        `${providerId} could not continue transcription. Check provider settings and try again.`,
      ),
    ];
  }
  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    return [event, finishedEvent()];
  }
  return [event];
}

function createOpenAiProtocol(
  route: ProviderRoute,
  apiKey: string,
  options: RealtimeProviderOptions,
): RealtimeProviderProtocol {
  const query = new URLSearchParams({ intent: 'transcription' });
  if (route.modelId) query.set('model', route.modelId);
  return {
    providerId: route.providerId,
    connection: {
      url: `wss://api.openai.com/v1/realtime?${query}`,
      protocols: ['realtime', `openai-insecure-api-key.${apiKey}`],
      waitForReadyEvent: true,
    },
    onOpenMessages: [openAiSessionUpdate(route, options)],
    encodeAudio: (bytes) =>
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(bytes).toString('base64'),
      }),
    finalizeMessages: [JSON.stringify({ type: 'input_audio_buffer.commit' })],
    normalize: (message) => normalizeOpenAiEvent(message, 'OpenAI'),
  };
}

function createTinfoilProtocol(
  route: ProviderRoute,
  apiKey: string,
  options: RealtimeProviderOptions,
): RealtimeProviderProtocol {
  return {
    providerId: route.providerId,
    connection: {
      url: '',
      protocols: [],
      waitForReadyEvent: true,
      socketFactory: () => {
        const { createTinfoilWebSocket } =
          require('../../../modules/tinfoil-transport/src') as typeof import('../../../modules/tinfoil-transport/src');
        return createTinfoilWebSocket(apiKey, route.modelId, route.credentialRef);
      },
    },
    onOpenMessages: [openAiSessionUpdate(route, options)],
    encodeAudio: (bytes) =>
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(bytes).toString('base64'),
      }),
    finalizeMessages: [JSON.stringify({ type: 'input_audio_buffer.commit' })],
    normalize: (message) => normalizeOpenAiEvent(message, 'Tinfoil'),
  };
}

function createGeminiLiveProtocol(
  route: ProviderRoute,
  apiKey: string,
  options: RealtimeProviderOptions,
): RealtimeProviderProtocol {
  let turnIndex = 0;
  const language =
    options.language && options.language !== 'auto' ? { languageCodes: [options.language] } : {};
  return {
    providerId: route.providerId,
    connection: {
      url: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`,
      protocols: [],
      waitForReadyEvent: true,
    },
    onOpenMessages: [
      JSON.stringify({
        setup: {
          model: `models/${route.modelId}`,
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: language,
        },
      }),
    ],
    encodeAudio: (bytes) =>
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: Buffer.from(bytes).toString('base64'),
            mimeType: `audio/pcm;rate=${options.sampleRate ?? 16000}`,
          },
        },
      }),
    finalizeMessages: [JSON.stringify({ realtimeInput: { audioStreamEnd: true } })],
    normalize: (message) => {
      const event = objectValue(message);
      if (!event) return [];
      if (event.setupComplete !== undefined) return [{ type: 'provider.ready' }];
      const content = objectValue(event.serverContent);
      if (!content) return [];
      const partial = textValue(objectValue(content.interimInputTranscription)?.text);
      const final = textValue(objectValue(content.inputTranscription)?.text);
      const normalized: unknown[] = [];
      if (final) {
        turnIndex += 1;
        normalized.push(completedEvent(`gemini-${turnIndex}`, final, null, null));
      } else if (partial) {
        normalized.push(partialEvent(`gemini-${turnIndex + 1}`, partial));
      }
      if (content.turnComplete === true) normalized.push(finishedEvent());
      return normalized;
    },
  };
}

function createDeepgramProtocol(
  route: ProviderRoute,
  apiKey: string,
  options: RealtimeProviderOptions,
): RealtimeProviderProtocol {
  const query = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: String(options.sampleRate ?? 24000),
    channels: '1',
    model: route.modelId || 'nova-3',
    punctuate: 'true',
    interim_results: 'true',
  });
  if (options.language && options.language !== 'auto') query.set('language', options.language);
  return {
    providerId: route.providerId,
    connection: {
      url: `wss://api.deepgram.com/v1/listen?${query}`,
      protocols: ['token', apiKey],
      waitForReadyEvent: false,
    },
    onOpenMessages: [],
    encodeAudio: (bytes) => bytes,
    finalizeMessages: [JSON.stringify({ type: 'Finalize' })],
    normalize: (message) => {
      const event = objectValue(message);
      if (!event) return [];
      if (event.type === 'Error') {
        return [
          errorEvent(
            'Deepgram could not continue transcription. Check provider settings and try again.',
          ),
        ];
      }
      if (event.type !== 'Results') return [];
      const alternatives = objectValue(event.channel)?.alternatives;
      const first = Array.isArray(alternatives) ? objectValue(alternatives[0]) : null;
      const transcript = textValue(first?.transcript);
      if (!transcript) return event.from_finalize === true ? [finishedEvent()] : [];
      const startSeconds = numberValue(event.start);
      const durationSeconds = numberValue(event.duration);
      const startMs = startSeconds === null ? null : Math.round(startSeconds * 1000);
      const endMs =
        startSeconds === null || durationSeconds === null
          ? null
          : Math.round((startSeconds + durationSeconds) * 1000);
      const itemId = `deepgram-${startMs ?? 'active'}`;
      if (event.from_finalize === true) {
        return [completedEvent(itemId, transcript, startMs, endMs), finishedEvent()];
      }
      return event.is_final === true
        ? [completedEvent(itemId, transcript, startMs, endMs)]
        : [partialEvent(itemId, transcript)];
    },
  };
}

async function createAssemblyAiProtocol(
  route: ProviderRoute,
  apiKey: string,
  options: RealtimeProviderOptions,
  dependencies: RealtimeProviderDependencies,
): Promise<RealtimeProviderProtocol> {
  const tokenUrl = 'https://streaming.assemblyai.com/v3/token?expires_in_seconds=60';
  const response = await dependencies.request(tokenUrl, {
    method: 'GET',
    headers: { Authorization: apiKey },
    redirect: 'manual',
    signal: options.signal,
  });
  assertSuccessfulResponse(response, route.providerId, tokenUrl);
  const token = textValue((await readJson(response, route.providerId)).token);
  if (!token) {
    throw new ProviderExecutionError(
      'PROVIDER_RESPONSE_INVALID',
      'AssemblyAI returned an invalid streaming token.',
    );
  }
  const query = new URLSearchParams({
    sample_rate: String(options.sampleRate ?? 16000),
    encoding: 'pcm_s16le',
    format_turns: 'true',
    token,
  });
  if (route.modelId) query.set('speech_model', route.modelId);
  const emittedTurns = new Set<string>();
  return {
    providerId: route.providerId,
    connection: {
      url: `wss://streaming.assemblyai.com/v3/ws?${query}`,
      protocols: [],
      waitForReadyEvent: true,
    },
    onOpenMessages: [],
    encodeAudio: (bytes) => bytes,
    finalizeMessages: [JSON.stringify({ type: 'Terminate' })],
    normalize: (message) => {
      const event = objectValue(message);
      if (!event) return [];
      if (event.type === 'Begin') return [{ type: 'provider.ready' }];
      if (event.type === 'Error') {
        return [
          errorEvent(
            'AssemblyAI could not continue transcription. Check provider settings and try again.',
          ),
        ];
      }
      if (event.type === 'Termination') return [finishedEvent()];
      if (event.type !== 'Turn') return [];
      const transcript = textValue(event.transcript);
      if (!transcript) return [];
      const itemId = `assemblyai-${String(event.turn_order ?? 'active')}`;
      if (event.end_of_turn !== true) return [partialEvent(itemId, transcript)];
      if (emittedTurns.has(itemId)) return [];
      emittedTurns.add(itemId);
      const words = Array.isArray(event.words) ? event.words.map(objectValue) : [];
      const startMs = numberValue(words[0]?.start);
      const endMs = numberValue(words[words.length - 1]?.end);
      return [completedEvent(itemId, transcript, startMs, endMs)];
    },
  };
}

async function createCortiProtocol(
  route: ProviderRoute,
  credential: ProviderCredential,
  options: RealtimeProviderOptions,
  dependencies: RealtimeProviderDependencies,
): Promise<RealtimeProviderProtocol> {
  const clientId = credential.clientId?.trim();
  const clientSecret = credential.clientSecret?.trim();
  if (!clientId || !clientSecret) {
    throw new ProviderExecutionError(
      'CREDENTIAL_INVALID',
      'Corti requires a client ID and client secret.',
    );
  }
  const environment =
    route.cortiEnvironment ?? (new URL(route.endpoint).hostname.includes('.eu.') ? 'eu' : 'us');
  const tenant = route.cortiTenant ?? 'base';
  const authUrl = `https://auth.${environment}.corti.app/realms/${tenant}/protocol/openid-connect/token`;
  const response = await dependencies.request(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'openid',
    }).toString(),
    redirect: 'manual',
    signal: options.signal,
  });
  assertSuccessfulResponse(response, route.providerId, authUrl);
  const token = textValue((await readJson(response, route.providerId)).access_token);
  if (!token) {
    throw new ProviderExecutionError(
      'PROVIDER_RESPONSE_INVALID',
      'Corti returned an invalid access token.',
    );
  }
  const sampleRate = options.sampleRate ?? 16000;
  const query = new URLSearchParams({ 'tenant-name': tenant, token: `Bearer ${token}` });
  return {
    providerId: route.providerId,
    connection: {
      url: `wss://api.${environment}.corti.app/audio-bridge/v2/transcribe?${query}`,
      protocols: [],
      waitForReadyEvent: true,
    },
    onOpenMessages: [
      JSON.stringify({
        type: 'config',
        configuration: {
          primaryLanguage:
            options.language && options.language !== 'auto' ? options.language : 'en',
          interimResults: true,
          automaticPunctuation: true,
          audioFormat: `audio/pcm; rate=${sampleRate}; channels=1; bits=16`,
        },
      }),
    ],
    encodeAudio: (bytes) => bytes,
    finalizeMessages: [JSON.stringify({ type: 'flush' }), JSON.stringify({ type: 'end' })],
    normalize: (message) => {
      const event = objectValue(message);
      if (!event) return [];
      if (event.type === 'CONFIG_ACCEPTED') return [{ type: 'provider.ready' }];
      if (event.type === 'error') {
        return [
          errorEvent(
            'Corti could not continue transcription. Check provider settings and try again.',
          ),
        ];
      }
      if (event.type !== 'transcript') return [];
      const data = objectValue(event.data);
      const transcript = textValue(data?.text);
      if (!transcript) return [];
      const start = numberValue(data?.start);
      const duration = numberValue(data?.duration);
      const startMs = start === null ? null : Math.round(start * 1000);
      const endMs =
        start === null || duration === null ? null : Math.round((start + duration) * 1000);
      const itemId = `corti-${startMs ?? 'active'}`;
      return data?.isFinal === true
        ? [completedEvent(itemId, transcript, startMs, endMs)]
        : [partialEvent(itemId, transcript)];
    },
  };
}

export async function createRealtimeProviderProtocol(
  route: ProviderRoute,
  options: RealtimeProviderOptions,
  dependencies: RealtimeProviderDependencies,
): Promise<RealtimeProviderProtocol> {
  const expectedCredentialRef = `provider.${route.providerId}`;
  if (!route.credentialRef) {
    throw new ProviderExecutionError(
      'CREDENTIAL_MISSING',
      `Configure credentials for ${route.providerId}.`,
    );
  }
  if (route.credentialRef !== expectedCredentialRef) {
    throw new ProviderExecutionError(
      'CREDENTIAL_REFERENCE_INVALID',
      `Select the configured ${route.providerId} credential.`,
    );
  }
  const credential = requireCredential(
    route,
    await dependencies.getCredential(route.credentialRef),
  );
  switch (route.providerId) {
    case 'openai':
      return createOpenAiProtocol(route, requireApiKey(route, credential), options);
    case 'tinfoil':
      return createTinfoilProtocol(route, requireApiKey(route, credential), options);
    case 'gemini':
      if (!route.modelId.endsWith('-live')) {
        throw new ProviderExecutionError(
          'MODEL_UNSUPPORTED',
          `${route.modelId} is not a Gemini Live model.`,
        );
      }
      return createGeminiLiveProtocol(route, requireApiKey(route, credential), options);
    case 'deepgram':
      return createDeepgramProtocol(route, requireApiKey(route, credential), options);
    case 'assemblyai':
      return createAssemblyAiProtocol(
        route,
        requireApiKey(route, credential),
        options,
        dependencies,
      );
    case 'corti':
      return createCortiProtocol(route, credential, options, dependencies);
    default:
      throw new ProviderExecutionError(
        'PROVIDER_UNSUPPORTED',
        `${route.providerId} does not support realtime meetings on mobile.`,
      );
  }
}
