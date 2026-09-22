import { createProviderCredentialScope } from './ProviderCredentialScope';
import type { TinfoilRequest } from '../../../modules/tinfoil-transport/src';
import { isTranscriptionScope, type InferenceRoute } from '@shared/ai/routing';
import { buildApiUrl, isSecureHttpEndpoint, normalizeBaseUrl } from '@shared/ai/endpoints';
import modelCatalog from '@shared/ai/modelRegistryData.json';
import {
  getProviderCredential,
  getProviderCredentialReference,
  type ProviderCredential,
} from './ProviderCredentials';
import { requestProviderFileNative, requestProviderNative } from './NativeProviderTransport';

type ProviderRoute = Extract<InferenceRoute, { mode: 'providers' }>;

export interface ProviderTextInput {
  route: ProviderRoute;
  text: string;
  systemPrompt: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderTranscriptionInput {
  route: ProviderRoute;
  audioUri: string;
  fileName?: string;
  mimeType?: string;
  language?: string;
  routeSnapshot?: string;
  jobId?: string;
  signal?: AbortSignal;
}

export interface ProviderExecutionDependencies {
  requestAttested?(input: TinfoilRequest): Promise<{ status: number; body: string }>;
  getCredential(reference: string): Promise<ProviderCredential | null>;
  readAudio(uri: string, signal?: AbortSignal): Promise<Blob>;
  request(
    url: string,
    init: RequestInit,
    recovery?: { routeSnapshot?: string; recoveryAudioUri?: string },
  ): Promise<Response>;
  requestFile?(input: {
    url: string;
    fileUri: string;
    fileFieldName: string;
    fileMimeType: string;
    fileName: string;
    parameters: Record<string, string>;
    headers: Record<string, string>;
    routeSnapshot?: string;
    recoveryAudioUri?: string;
    signal?: AbortSignal;
  }): Promise<Response>;
}

export interface ProviderExecution {
  processProviderText(input: ProviderTextInput): Promise<{ text: string; model: string }>;
  transcribeWithProvider(
    input: ProviderTranscriptionInput,
  ): Promise<{ text: string; duration: number }>;
  discoverProviderModels(input: ProviderSetupInput): Promise<ProviderModelDiscovery>;
  testProviderConnection(input: ProviderSetupInput): Promise<ProviderConnectionResult>;
}

export interface ProviderSetupInput {
  route: ProviderRoute;
  signal?: AbortSignal;
}

export interface ProviderModelDiscovery {
  models: Array<{ id: string; name: string }>;
  verification: 'catalog-only';
}

export interface ProviderConnectionResult {
  ok: true;
  verification: 'inference' | 'catalog-only' | 'credentials';
  providerId: string;
  modelId: string;
  scope: ProviderRoute['scope'];
}

export class ProviderExecutionError extends Error {
  public readonly code: string;
  public readonly status?: number;
  public readonly retryable: boolean;

  public constructor(
    code: string,
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'ProviderExecutionError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

const STREAMING_ONLY_PROVIDERS = new Set(['deepgram', 'assemblyai']);
const OPENAI_COMPATIBLE_TEXT_PROVIDERS = new Set([
  'openai',
  'groq',
  'openrouter',
  'custom',
  'corti',
  'tinfoil',
]);
const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MISTRAL_TRANSCRIPTION_URL = 'https://api.mistral.ai/v1/audio/transcriptions';
const XAI_TRANSCRIPTION_URL = 'https://api.x.ai/v1/audio/transcriptions';

function errorForStatus(providerId: string, status: number): ProviderExecutionError {
  if (status === 401 || status === 403) {
    return new ProviderExecutionError(
      'INVALID_CREDENTIAL',
      `${providerId} rejected the configured credential.`,
      { status },
    );
  }
  if (status === 429) {
    return new ProviderExecutionError(
      'PROVIDER_RATE_LIMITED',
      `${providerId} is rate limited. Try again later.`,
      { status },
    );
  }
  if (status >= 500) {
    return new ProviderExecutionError(
      'PROVIDER_UNAVAILABLE',
      `${providerId} is temporarily unavailable.`,
      { status, retryable: true },
    );
  }
  return new ProviderExecutionError(
    'PROVIDER_REQUEST_FAILED',
    `${providerId} rejected the request (${status}).`,
    { status },
  );
}

function assertEndpoint(route: ProviderRoute): string {
  const endpoint = normalizeBaseUrl(route.endpoint);
  if (!endpoint || !isSecureHttpEndpoint(endpoint)) {
    throw new ProviderExecutionError('ENDPOINT_INVALID', 'The provider endpoint is invalid.');
  }
  const parsed = new URL(endpoint);
  if (parsed.username || parsed.password || parsed.hash) {
    throw new ProviderExecutionError('ENDPOINT_INVALID', 'The provider endpoint is invalid.');
  }
  return endpoint;
}

async function credentialForRoute(
  route: ProviderRoute,
  getCredential: ProviderExecutionDependencies['getCredential'],
): Promise<ProviderCredential | null> {
  if (!route.credentialRef) {
    if (route.providerId === 'custom') return null;
    throw new ProviderExecutionError(
      'CREDENTIAL_MISSING',
      `Configure credentials for ${route.providerId}.`,
    );
  }
  const expectedReference = await getProviderCredentialReference(route.providerId, route.endpoint);
  if (route.credentialRef !== expectedReference) {
    throw new ProviderExecutionError(
      'CREDENTIAL_MISMATCH',
      'The credential does not belong to this provider endpoint.',
    );
  }
  const credential = await getCredential(route.credentialRef);
  if (!credential) {
    throw new ProviderExecutionError(
      'CREDENTIAL_MISSING',
      `Configure credentials for ${route.providerId}.`,
    );
  }
  return credential;
}

function apiKeyFromCredential(
  route: ProviderRoute,
  credential: ProviderCredential | null,
): string | null {
  const apiKey = credential?.apiKey?.trim();
  if (!apiKey && route.providerId !== 'custom') {
    throw new ProviderExecutionError(
      'CREDENTIAL_INVALID',
      `${route.providerId} requires an API key.`,
    );
  }
  return apiKey || null;
}

async function safeRequest(
  dependencies: ProviderExecutionDependencies,
  route: ProviderRoute,
  url: string,
  init: RequestInit,
  recovery?: { routeSnapshot?: string; recoveryAudioUri?: string },
): Promise<Response> {
  const requestOrigin = new URL(url).origin;
  let response: Response;
  try {
    response = await dependencies.request(url, { ...init, redirect: 'manual' }, recovery);
  } catch (error) {
    throw normalizeTransportFailure(error, route.providerId);
  }
  const responseOrigin = response.url ? new URL(response.url).origin : requestOrigin;
  if (
    response.redirected ||
    (response.status >= 300 && response.status < 400) ||
    responseOrigin !== requestOrigin
  ) {
    throw new ProviderExecutionError(
      'REDIRECT_BLOCKED',
      'The provider redirected the request to another endpoint.',
    );
  }
  if (!response.ok) throw errorForStatus(route.providerId, response.status);
  return response;
}

function normalizeTransportFailure(error: unknown, providerId: string): Error {
  if (error instanceof ProviderExecutionError) return error;
  if (error instanceof Error && error.name === 'AbortError') return error;
  const nativeCode = objectValue(error)?.code;
  if (nativeCode === 'PROVIDER_CANCELLED') return new DOMException('Aborted', 'AbortError');
  if (nativeCode === 'PROVIDER_LOCAL_NETWORK_ERROR') {
    return new ProviderExecutionError(
      'PROVIDER_LOCAL_NETWORK_ERROR',
      'Check Local Network permission and the server address.',
    );
  }
  return new ProviderExecutionError('PROVIDER_NETWORK_ERROR', `Unable to reach ${providerId}.`, {
    retryable: true,
  });
}

async function parseJson(response: Response, providerId: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderExecutionError(
      'PROVIDER_RESPONSE_INVALID',
      `${providerId} returned an invalid response.`,
    );
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireText(text: string | null, providerId: string): string {
  if (text) return text;
  throw new ProviderExecutionError(
    'PROVIDER_RESPONSE_INVALID',
    `${providerId} returned an empty or malformed response.`,
  );
}

function catalogModelConfig(
  providerId: string,
  modelId: string,
): { supportsTemperature: boolean; tokenParam: string } {
  const providers = modelCatalog.cloudProviders as Array<{
    id: string;
    models: Array<{ id: string; supportsTemperature?: boolean; tokenParam?: string }>;
  }>;
  const model = providers
    .find((provider) => provider.id === providerId)
    ?.models.find((candidate) => candidate.id === modelId);
  return {
    supportsTemperature: model?.supportsTemperature ?? true,
    tokenParam: model?.tokenParam ?? 'max_tokens',
  };
}

function responseTextFromChat(payload: unknown): string | null {
  const choices = objectValue(payload)?.choices;
  if (!Array.isArray(choices)) return null;
  return nonEmptyText(objectValue(objectValue(choices[0])?.message)?.content);
}

function responseTextFromAnthropic(payload: unknown): string | null {
  const content = objectValue(payload)?.content;
  if (!Array.isArray(content)) return null;
  return (
    content
      .map((part) => objectValue(part))
      .filter((part): part is Record<string, unknown> => part?.type === 'text')
      .map((part) => nonEmptyText(part.text))
      .filter((part): part is string => part !== null)
      .join(' ')
      .trim() || null
  );
}

function responseTextFromGemini(payload: unknown): string | null {
  const candidate = Array.isArray(objectValue(payload)?.candidates)
    ? objectValue((objectValue(payload)?.candidates as unknown[])[0])
    : null;
  if (candidate?.finishReason !== 'STOP') return null;
  const parts = objectValue(candidate.content)?.parts;
  if (!Array.isArray(parts)) return null;
  return (
    parts
      .map((part) => objectValue(part))
      .filter((part): part is Record<string, unknown> => part !== null && part.thought !== true)
      .map((part) => nonEmptyText(part.text))
      .filter((part): part is string => part !== null)
      .join('')
      .trim() || null
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const combined = (first << 16) | (second << 8) | third;
    encoded += alphabet[(combined >> 18) & 63];
    encoded += alphabet[(combined >> 12) & 63];
    encoded += index + 1 < bytes.length ? alphabet[(combined >> 6) & 63] : '=';
    encoded += index + 2 < bytes.length ? alphabet[combined & 63] : '=';
  }
  return encoded;
}

function transcriptionText(payload: unknown): string | null {
  return nonEmptyText(objectValue(payload)?.text);
}

function transcriptionDuration(payload: unknown): number {
  const duration = objectValue(payload)?.duration;
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

function attestedDependencies(
  dependencies: ProviderExecutionDependencies,
  credentialRef: string | undefined,
): ProviderExecutionDependencies {
  const requestAttested = dependencies.requestAttested;
  if (!requestAttested)
    throw new ProviderExecutionError(
      'NATIVE_TRANSPORT_REQUIRED',
      'Tinfoil requires its attested native transport.',
    );
  const execute = async (
    url: string,
    headers: HeadersInit | undefined,
    input: Partial<TinfoilRequest>,
  ): Promise<Response> => {
    const path = new URL(url).pathname;
    if (
      path !== '/v1/models' &&
      path !== '/v1/chat/completions' &&
      path !== '/v1/audio/transcriptions'
    )
      throw new ProviderExecutionError('ENDPOINT_INVALID', 'Unsupported Tinfoil request.');
    const authorization = new Headers(headers).get('Authorization');
    if (!authorization?.startsWith('Bearer '))
      throw new ProviderExecutionError('CREDENTIAL_MISSING', 'Configure your Tinfoil API key.');
    const result = await requestAttested({
      ...input,
      credentialRef,
      apiKey: authorization.slice(7),
      path,
    });
    return new Response(result.body, { status: result.status });
  };
  return {
    ...dependencies,
    request: (url, init) =>
      execute(url, init.headers, {
        body: typeof init.body === 'string' ? init.body : undefined,
        signal: init.signal ?? undefined,
      }),
    requestFile: (input) =>
      execute(input.url, input.headers, {
        fileUri: input.fileUri,
        fileName: input.fileName,
        mimeType: input.fileMimeType,
        parameters: input.parameters,
        routeSnapshot: input.routeSnapshot,
        signal: input.signal,
      }),
  };
}

async function processText(
  dependencies: ProviderExecutionDependencies,
  input: ProviderTextInput,
): Promise<{ text: string; model: string }> {
  const { route } = input;
  if (route.providerId === 'tinfoil')
    dependencies = attestedDependencies(dependencies, route.credentialRef);
  const endpoint = assertEndpoint(route);
  const credential = await credentialForRoute(route, dependencies.getCredential);
  const apiKey = apiKeyFromCredential(route, credential);
  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;
  let extractText: (payload: unknown) => string | null;
  const conversation = [...(input.messages ?? []), { role: 'user' as const, content: input.text }];

  if (OPENAI_COMPATIBLE_TEXT_PROVIDERS.has(route.providerId)) {
    const modelConfig = catalogModelConfig(route.providerId, route.modelId);
    url = buildApiUrl(endpoint, '/chat/completions');
    headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    body = {
      model: route.modelId,
      messages: [{ role: 'system', content: input.systemPrompt }, ...conversation],
      ...(input.temperature !== undefined && modelConfig.supportsTemperature
        ? { temperature: input.temperature }
        : {}),
      ...(input.maxTokens !== undefined ? { [modelConfig.tokenParam]: input.maxTokens } : {}),
    };
    extractText = responseTextFromChat;
  } else if (route.providerId === 'anthropic') {
    url = buildApiUrl(endpoint, '/messages');
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey as string,
      'anthropic-version': '2023-06-01',
    };
    body = {
      model: route.modelId,
      system: input.systemPrompt,
      messages: conversation,
      max_tokens: input.maxTokens ?? 4096,
      ...(input.temperature !== undefined &&
      catalogModelConfig(route.providerId, route.modelId).supportsTemperature
        ? { temperature: input.temperature }
        : {}),
    };
    extractText = responseTextFromAnthropic;
  } else if (route.providerId === 'gemini') {
    url = `${endpoint}/models/${encodeURIComponent(route.modelId)}:generateContent`;
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey as string };
    body = {
      systemInstruction: { parts: [{ text: input.systemPrompt }] },
      contents: conversation.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })),
      generationConfig: {
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxTokens !== undefined ? { maxOutputTokens: input.maxTokens } : {}),
      },
    };
    extractText = responseTextFromGemini;
  } else {
    throw new ProviderExecutionError(
      'PROVIDER_UNSUPPORTED',
      `${route.providerId} does not support text generation on mobile.`,
    );
  }

  const response = await safeRequest(dependencies, route, url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: input.signal,
  });
  const payload = await parseJson(response, route.providerId);
  return { text: requireText(extractText(payload), route.providerId), model: route.modelId };
}

async function transcribeCorti(
  dependencies: ProviderExecutionDependencies,
  input: ProviderTranscriptionInput,
  audio: Blob,
  credential: ProviderCredential,
): Promise<{ text: string; duration: number }> {
  if (!credential.clientId?.trim() || !credential.clientSecret?.trim()) {
    throw new ProviderExecutionError(
      'CREDENTIAL_INVALID',
      'Corti requires a client ID and client secret.',
    );
  }
  const endpoint = assertEndpoint(input.route);
  const parsed = new URL(endpoint);
  const environment =
    input.route.cortiEnvironment ?? (parsed.hostname.includes('.eu.') ? 'eu' : 'us');
  const tenant = input.route.cortiTenant ?? 'base';
  const tokenResponse = await safeRequest(
    dependencies,
    input.route,
    `https://auth.${environment}.corti.app/realms/${tenant}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
        scope: 'openid',
      }).toString(),
      signal: input.signal,
    },
  );
  const token = nonEmptyText(objectValue(await parseJson(tokenResponse, 'corti'))?.access_token);
  if (!token) {
    throw new ProviderExecutionError(
      'PROVIDER_RESPONSE_INVALID',
      'Corti authentication returned an invalid response.',
    );
  }
  const headers = { Authorization: `Bearer ${token}`, 'Tenant-Name': tenant };
  const base = `https://api.${environment}.corti.app/v2`;
  const createResponse = await safeRequest(dependencies, input.route, `${base}/interactions/`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      encounter: {
        identifier: `openwhispr-${Date.now()}`,
        status: 'completed',
        type: 'consultation',
      },
    }),
    signal: input.signal,
  });
  const interactionId = nonEmptyText(
    objectValue(await parseJson(createResponse, 'corti'))?.interactionId,
  );
  if (!interactionId) {
    throw new ProviderExecutionError(
      'PROVIDER_RESPONSE_INVALID',
      'Corti returned an invalid interaction.',
    );
  }
  try {
    const recordingResponse = await safeRequest(
      dependencies,
      input.route,
      `${base}/interactions/${encodeURIComponent(interactionId)}/recordings/`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body: audio,
        signal: input.signal,
      },
    );
    const recordingId = nonEmptyText(
      objectValue(await parseJson(recordingResponse, 'corti'))?.recordingId,
    );
    if (!recordingId) {
      throw new ProviderExecutionError(
        'PROVIDER_RESPONSE_INVALID',
        'Corti returned an invalid recording.',
      );
    }
    const transcriptResponse = await safeRequest(
      dependencies,
      input.route,
      `${base}/interactions/${encodeURIComponent(interactionId)}/transcripts/`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordingId,
          primaryLanguage: input.language || 'en',
          isDictation: true,
        }),
        signal: input.signal,
      },
    );
    const payload = objectValue(await parseJson(transcriptResponse, 'corti'));
    const transcripts = payload?.transcripts;
    const text = Array.isArray(transcripts)
      ? transcripts
          .map((utterance) => nonEmptyText(objectValue(utterance)?.text))
          .filter((utterance): utterance is string => utterance !== null)
          .join(' ')
      : '';
    return { text: requireText(text, 'corti'), duration: transcriptionDuration(payload) };
  } finally {
    void dependencies
      .request(`${base}/interactions/${encodeURIComponent(interactionId)}`, {
        method: 'DELETE',
        headers,
        redirect: 'manual',
      })
      .catch(() => undefined);
  }
}

async function transcribe(
  dependencies: ProviderExecutionDependencies,
  input: ProviderTranscriptionInput,
): Promise<{ text: string; duration: number }> {
  const { route } = input;
  if (STREAMING_ONLY_PROVIDERS.has(route.providerId)) {
    throw new ProviderExecutionError(
      'STREAMING_ONLY_PROVIDER',
      `${route.providerId} only supports live transcription.`,
    );
  }
  if (route.providerId === 'tinfoil')
    dependencies = attestedDependencies(dependencies, route.credentialRef);
  assertEndpoint(route);
  const credential = await credentialForRoute(route, dependencies.getCredential);
  if (route.providerId === 'corti') {
    const audio = await dependencies.readAudio(input.audioUri, input.signal);
    return transcribeCorti(dependencies, input, audio, credential as ProviderCredential);
  }
  const apiKey = apiKeyFromCredential(route, credential);

  if (route.providerId === 'gemini') {
    const audio = await dependencies.readAudio(input.audioUri, input.signal);
    const bytes = new Uint8Array(await audio.arrayBuffer());
    const mimeType = input.mimeType || audio.type || 'audio/m4a';
    const requestBody: Record<string, unknown> = {
      model: route.modelId,
      input: [
        {
          type: 'audio',
          data: bytesToBase64(bytes),
          mime_type:
            mimeType === 'audio/mpeg'
              ? 'audio/mp3'
              : mimeType === 'audio/mp4'
                ? 'audio/aac'
                : mimeType,
        },
      ],
    };
    if (input.language && input.language !== 'auto') {
      requestBody.generation_config = {
        transcription_config: { language_codes: [input.language] },
      };
    }
    const response = await safeRequest(
      dependencies,
      route,
      GEMINI_INTERACTIONS_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey as string },
        body: JSON.stringify(requestBody),
        signal: input.signal,
      },
      { routeSnapshot: input.routeSnapshot, recoveryAudioUri: input.audioUri },
    );
    const payload = objectValue(await parseJson(response, route.providerId));
    if (payload?.status !== undefined && payload.status !== 'completed') {
      throw new ProviderExecutionError(
        'PROVIDER_REQUEST_FAILED',
        'Gemini did not complete the transcription.',
      );
    }
    const outputText = nonEmptyText(payload?.output_text);
    const steps = payload?.steps;
    const fallback = Array.isArray(steps)
      ? steps
          .flatMap((step) => {
            const content = objectValue(step)?.content;
            return Array.isArray(content) ? content : [];
          })
          .map((part) => objectValue(part))
          .filter((part): part is Record<string, unknown> => part?.type === 'text')
          .map((part) => nonEmptyText(part.text))
          .filter((part): part is string => part !== null)
          .join(' ')
      : '';
    return {
      text: requireText(outputText || fallback || null, route.providerId),
      duration: transcriptionDuration(payload),
    };
  }

  const parameters: Record<string, string> = {};
  if (route.providerId === 'xai') {
    if (input.language && input.language !== 'auto') {
      parameters.language = input.language;
      parameters.format = 'true';
    }
  } else {
    parameters.model = route.modelId;
    if (input.language && input.language !== 'auto') parameters.language = input.language;
  }
  const headers: Record<string, string> = {};
  if (route.providerId === 'mistral') headers['x-api-key'] = apiKey as string;
  else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const url =
    route.providerId === 'mistral'
      ? MISTRAL_TRANSCRIPTION_URL
      : route.providerId === 'xai'
        ? XAI_TRANSCRIPTION_URL
        : buildApiUrl(assertEndpoint(route), '/audio/transcriptions');
  let response: Response;
  try {
    response = dependencies.requestFile
      ? await dependencies.requestFile({
          url,
          fileUri: input.audioUri,
          fileFieldName: 'file',
          fileMimeType: input.mimeType || 'audio/m4a',
          fileName: input.fileName || input.audioUri.split('/').pop() || 'recording.m4a',
          parameters,
          headers,
          routeSnapshot: input.routeSnapshot,
          recoveryAudioUri: input.audioUri,
          signal: input.signal,
        })
      : await (async (): Promise<Response> => {
          const audio = await dependencies.readAudio(input.audioUri, input.signal);
          const formData = new FormData();
          formData.append(
            'file',
            audio,
            input.fileName || input.audioUri.split('/').pop() || 'recording.m4a',
          );
          for (const [key, value] of Object.entries(parameters)) formData.append(key, value);
          return safeRequest(dependencies, route, url, {
            method: 'POST',
            headers,
            body: formData,
            signal: input.signal,
          });
        })();
  } catch (error) {
    throw normalizeTransportFailure(error, route.providerId);
  }
  if (!response.ok) throw errorForStatus(route.providerId, response.status);
  const payload = await parseJson(response, route.providerId);
  return {
    text: requireText(transcriptionText(payload), route.providerId),
    duration: transcriptionDuration(payload),
  };
}

async function discoverModels(
  dependencies: ProviderExecutionDependencies,
  input: ProviderSetupInput,
): Promise<ProviderModelDiscovery> {
  const { route } = input;
  if (route.providerId === 'tinfoil')
    dependencies = attestedDependencies(dependencies, route.credentialRef);
  if (route.providerId === 'corti' && isTranscriptionScope(route.scope)) {
    throw new ProviderExecutionError(
      'MODEL_DISCOVERY_UNSUPPORTED',
      'Corti transcription does not expose model discovery.',
    );
  }
  const endpoint = assertEndpoint(route);
  const credential = await credentialForRoute(route, dependencies.getCredential);
  const apiKey = apiKeyFromCredential(route, credential);
  const headers: Record<string, string> = {};
  if (route.providerId === 'anthropic') {
    headers['x-api-key'] = apiKey as string;
    headers['anthropic-version'] = '2023-06-01';
  } else if (route.providerId === 'gemini') {
    headers['x-goog-api-key'] = apiKey as string;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const response = await safeRequest(dependencies, route, buildApiUrl(endpoint, '/models'), {
    method: 'GET',
    headers,
    signal: input.signal,
  });
  const payload = objectValue(await parseJson(response, route.providerId));
  const entries = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  const models = entries
    .map((entry): { id: string; name: string } | null => {
      const model = objectValue(entry);
      const rawId = nonEmptyText(model?.id) || nonEmptyText(model?.name);
      if (!rawId) return null;
      const id = rawId.startsWith('models/') ? rawId.slice('models/'.length) : rawId;
      return { id, name: nonEmptyText(model?.displayName) || id };
    })
    .filter((model): model is { id: string; name: string } => model !== null)
    .sort((first, second) => first.name.localeCompare(second.name));
  if (!models.length) {
    throw new ProviderExecutionError(
      'PROVIDER_RESPONSE_INVALID',
      `${route.providerId} returned no usable models.`,
    );
  }
  return { models, verification: 'catalog-only' };
}

async function testConnection(
  dependencies: ProviderExecutionDependencies,
  input: ProviderSetupInput,
): Promise<ProviderConnectionResult> {
  const { route } = input;
  if (!isTranscriptionScope(route.scope)) {
    await processText(dependencies, {
      route,
      text: 'Reply with OK.',
      systemPrompt: 'This is a provider connection test. Reply only with OK.',
      maxTokens: 8,
      signal: input.signal,
    });
    return {
      ok: true,
      verification: 'inference',
      providerId: route.providerId,
      modelId: route.modelId,
      scope: route.scope,
    };
  }
  let verification: ProviderConnectionResult['verification'] = 'credentials';
  if (route.providerId === 'corti') {
    const credential = await credentialForRoute(route, dependencies.getCredential);
    if (!credential?.clientId || !credential.clientSecret) {
      throw new ProviderExecutionError(
        'CREDENTIAL_INVALID',
        'Corti requires a client ID and client secret.',
      );
    }
  } else {
    await discoverModels(dependencies, input);
    verification = 'catalog-only';
  }
  return {
    ok: true,
    verification,
    providerId: route.providerId,
    modelId: route.modelId,
    scope: route.scope,
  };
}

const defaultDependencies: ProviderExecutionDependencies = {
  requestAttested: (input) => {
    const { requestTinfoil } =
      require('../../../modules/tinfoil-transport/src') as typeof import('../../../modules/tinfoil-transport/src');
    return requestTinfoil(input);
  },
  getCredential: getProviderCredential,
  readAudio: async (uri, signal) => {
    const response = await fetch(uri, { signal });
    if (!response.ok) {
      throw new ProviderExecutionError('AUDIO_READ_FAILED', 'Unable to read the audio file.');
    }
    return response.blob();
  },
  request: requestProviderNative,
  requestFile: requestProviderFileNative,
};

export function createProviderExecution(
  dependencies: ProviderExecutionDependencies,
): ProviderExecution {
  const execute = <T>(
    input: ProviderSetupInput,
    operation: (scoped: ProviderExecutionDependencies, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const scope = createProviderCredentialScope(input.route.credentialRef, input.signal);
    const scoped: ProviderExecutionDependencies = {
      ...dependencies,
      request: (url, init, recovery) => {
        scope.assertActive();
        return dependencies.request(url, { ...init, signal: scope.signal }, recovery);
      },
      ...(dependencies.requestFile
        ? {
            requestFile: (
              request: Parameters<NonNullable<ProviderExecutionDependencies['requestFile']>>[0],
            ) => {
              scope.assertActive();
              return dependencies.requestFile!({ ...request, signal: scope.signal });
            },
          }
        : {}),
      ...(dependencies.requestAttested
        ? {
            requestAttested: (request: TinfoilRequest) => {
              scope.assertActive();
              return dependencies.requestAttested!({ ...request, signal: scope.signal });
            },
          }
        : {}),
    };
    return scope.run(() => operation(scoped, scope.signal)).finally(scope.dispose);
  };
  return {
    processProviderText: (input) =>
      execute(input, (scoped, signal) => processText(scoped, { ...input, signal })),
    transcribeWithProvider: (input) =>
      execute(input, (scoped, signal) => transcribe(scoped, { ...input, signal })),
    discoverProviderModels: (input) =>
      execute(input, (scoped, signal) => discoverModels(scoped, { ...input, signal })),
    testProviderConnection: (input) =>
      execute(input, (scoped, signal) => testConnection(scoped, { ...input, signal })),
  };
}

const defaultExecution = createProviderExecution(defaultDependencies);

export const processProviderText = defaultExecution.processProviderText;
export const transcribeWithProvider = defaultExecution.transcribeWithProvider;
export const discoverProviderModels = defaultExecution.discoverProviderModels;
export const testProviderConnection = defaultExecution.testProviderConnection;
