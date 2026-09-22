import * as FileSystem from 'expo-file-system/legacy';
import { createProviderCredentialScope } from './ProviderCredentialScope';
import type { InferenceRoute } from '@shared/ai/routing';
import { isTranscriptionScope } from '@shared/ai/routing';
import { buildApiUrl, isSecureHttpEndpoint, normalizeBaseUrl } from '@shared/ai/endpoints';
import modelCatalog from '@shared/ai/modelRegistryData.json';
import { MOBILE_PROVIDER_IDS } from '@/lib/mobileProviders';
import {
  getProviderCredential,
  getProviderCredentialReference,
  type ProviderCredential,
} from './ProviderCredentials';
import { requestProviderFileNative, requestProviderNative } from './NativeProviderTransport';

type ProviderRoute = Extract<InferenceRoute, { mode: 'providers' }>;

export const PROVIDER_AUDIO_LIMIT_BYTES = 25 * 1024 * 1024;

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
  prompt?: string;
  routeSnapshot?: string;
  signal?: AbortSignal;
}

export interface ProviderFileRequest {
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
}

export interface ProviderExecutionDependencies {
  getCredential(reference: string): Promise<ProviderCredential | null>;
  fileSize(uri: string): Promise<number | undefined>;
  request(url: string, init: RequestInit): Promise<Response>;
  requestFile(input: ProviderFileRequest): Promise<Response>;
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
  verification: 'inference' | 'catalog-only';
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

function errorForStatus(providerId: string, status: number): ProviderExecutionError {
  if (status === 401 || status === 403) {
    return new ProviderExecutionError(
      'INVALID_CREDENTIAL',
      `${providerId} rejected the configured credential.`,
      { status },
    );
  }
  if (status === 402) {
    return new ProviderExecutionError(
      'PROVIDER_QUOTA_EXCEEDED',
      `${providerId} reports a billing or quota problem for this key.`,
      { status },
    );
  }
  if (status === 404) {
    return new ProviderExecutionError(
      'MODEL_NOT_FOUND',
      `${providerId} did not find the selected model or endpoint.`,
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

function assertSupportedProvider(route: ProviderRoute): void {
  if (!MOBILE_PROVIDER_IDS.includes(route.providerId)) {
    throw new ProviderExecutionError(
      'PROVIDER_UNSUPPORTED',
      `${route.providerId} is not available on this device.`,
    );
  }
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

async function apiKeyForRoute(
  route: ProviderRoute,
  getCredential: ProviderExecutionDependencies['getCredential'],
): Promise<string | null> {
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
  return credential.apiKey;
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function checkResponse(route: ProviderRoute, requestUrl: string, response: Response): Response {
  const requestOrigin = new URL(requestUrl).origin;
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

async function safeRequest(
  dependencies: ProviderExecutionDependencies,
  route: ProviderRoute,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await dependencies.request(url, { ...init, redirect: 'manual' });
  } catch (error) {
    throw normalizeTransportFailure(error, route.providerId);
  }
  return checkResponse(route, url, response);
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
  if (nativeCode === 'PROVIDER_INVALID_URL' || nativeCode === 'PROVIDER_INVALID_REQUEST') {
    return new ProviderExecutionError('ENDPOINT_INVALID', 'The provider endpoint is invalid.');
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

function transcriptionDuration(payload: unknown): number {
  const duration = objectValue(payload)?.duration;
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

async function processText(
  dependencies: ProviderExecutionDependencies,
  input: ProviderTextInput,
): Promise<{ text: string; model: string }> {
  const { route } = input;
  assertSupportedProvider(route);
  const endpoint = assertEndpoint(route);
  const apiKey = await apiKeyForRoute(route, dependencies.getCredential);
  const modelConfig = catalogModelConfig(route.providerId, route.modelId);
  const conversation = [...(input.messages ?? []), { role: 'user' as const, content: input.text }];
  const response = await safeRequest(
    dependencies,
    route,
    buildApiUrl(endpoint, '/chat/completions'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model: route.modelId,
        messages: [{ role: 'system', content: input.systemPrompt }, ...conversation],
        ...(input.temperature !== undefined && modelConfig.supportsTemperature
          ? { temperature: input.temperature }
          : {}),
        ...(input.maxTokens !== undefined ? { [modelConfig.tokenParam]: input.maxTokens } : {}),
      }),
      signal: input.signal,
    },
  );
  const payload = await parseJson(response, route.providerId);
  return {
    text: requireText(responseTextFromChat(payload), route.providerId),
    model: route.modelId,
  };
}

async function transcribe(
  dependencies: ProviderExecutionDependencies,
  input: ProviderTranscriptionInput,
): Promise<{ text: string; duration: number }> {
  const { route } = input;
  assertSupportedProvider(route);
  const endpoint = assertEndpoint(route);
  const apiKey = await apiKeyForRoute(route, dependencies.getCredential);
  const size = await dependencies.fileSize(input.audioUri);
  if (size !== undefined && size > PROVIDER_AUDIO_LIMIT_BYTES) {
    throw new ProviderExecutionError(
      'AUDIO_TOO_LARGE',
      'This audio is larger than the 25 MB provider limit. Record a shorter clip or choose a smaller file.',
    );
  }
  const parameters: Record<string, string> = { model: route.modelId };
  if (input.language && input.language !== 'auto') parameters.language = input.language;
  if (input.prompt) parameters.prompt = input.prompt;
  const url = buildApiUrl(endpoint, '/audio/transcriptions');
  let response: Response;
  try {
    response = await dependencies.requestFile({
      url,
      fileUri: input.audioUri,
      fileFieldName: 'file',
      fileMimeType: input.mimeType || 'audio/m4a',
      fileName: input.fileName || input.audioUri.split('/').pop() || 'recording.m4a',
      parameters,
      headers: authHeaders(apiKey),
      routeSnapshot: input.routeSnapshot,
      recoveryAudioUri: input.audioUri,
      signal: input.signal,
    });
  } catch (error) {
    throw normalizeTransportFailure(error, route.providerId);
  }
  const payload = await parseJson(checkResponse(route, url, response), route.providerId);
  return {
    text: requireText(nonEmptyText(objectValue(payload)?.text), route.providerId),
    duration: transcriptionDuration(payload),
  };
}

async function discoverModels(
  dependencies: ProviderExecutionDependencies,
  input: ProviderSetupInput,
): Promise<ProviderModelDiscovery> {
  const { route } = input;
  assertSupportedProvider(route);
  const endpoint = assertEndpoint(route);
  const apiKey = await apiKeyForRoute(route, dependencies.getCredential);
  const response = await safeRequest(dependencies, route, buildApiUrl(endpoint, '/models'), {
    method: 'GET',
    headers: authHeaders(apiKey),
    signal: input.signal,
  });
  const payload = objectValue(await parseJson(response, route.providerId));
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const models = entries
    .map((entry): { id: string; name: string } | null => {
      const model = objectValue(entry);
      const id = nonEmptyText(model?.id);
      return id ? { id, name: nonEmptyText(model?.name) || id } : null;
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
  await discoverModels(dependencies, input);
  return {
    ok: true,
    verification: 'catalog-only',
    providerId: route.providerId,
    modelId: route.modelId,
    scope: route.scope,
  };
}

const defaultDependencies: ProviderExecutionDependencies = {
  getCredential: getProviderCredential,
  fileSize: async (uri) => {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && typeof info.size === 'number' ? info.size : undefined;
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
      request: (url, init) => {
        scope.assertActive();
        return dependencies.request(url, { ...init, signal: scope.signal });
      },
      requestFile: (request) => {
        scope.assertActive();
        return dependencies.requestFile({ ...request, signal: scope.signal });
      },
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
