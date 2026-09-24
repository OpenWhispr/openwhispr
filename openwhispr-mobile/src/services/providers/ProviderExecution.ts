import * as FileSystem from 'expo-file-system/legacy';
import { createProviderCredentialScope } from './ProviderCredentialScope';
import {
  buildApiUrl,
  getModelListBaseCandidates,
  isSecureHttpEndpoint,
  normalizeBaseUrl,
} from '@/lib/providerEndpoints';
import modelCatalog from '@/config/providerCatalog.json';
import {
  MOBILE_PROVIDER_IDS,
  isTranscriptionScope,
  providerDisplayName,
  type InferenceRoute,
} from '@/lib/mobileProviders';
import {
  getProviderCredential,
  getProviderCredentialReference,
  type ProviderCredential,
} from './ProviderCredentials';
import {
  abortError,
  requestProviderFileNative,
  requestProviderNative,
} from './NativeProviderTransport';

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
  /** A key typed on the setup screen, checked before it is saved. */
  apiKey?: string;
}

export interface ProviderModelDiscovery {
  models: Array<{ id: string; name: string }>;
  verification: 'catalog-only';
  /** The base that answered; a bare custom server origin may resolve to its /v1 API. */
  endpoint: string;
}

export interface ProviderConnectionResult {
  ok: true;
  verification: 'inference' | 'catalog-only';
  providerId: string;
  modelId: string;
  scope: ProviderRoute['scope'];
  /** The base that answered; a bare custom server origin may resolve to its /v1 API. */
  endpoint: string;
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
      `${providerDisplayName(providerId)} rejected the configured credential.`,
      { status },
    );
  }
  if (status === 402) {
    return new ProviderExecutionError(
      'PROVIDER_QUOTA_EXCEEDED',
      `${providerDisplayName(providerId)} reports a billing or quota problem for this key.`,
      { status },
    );
  }
  if (status === 404) {
    return new ProviderExecutionError(
      'MODEL_NOT_FOUND',
      `${providerDisplayName(providerId)} did not find the selected model or endpoint.`,
      { status },
    );
  }
  if (status === 429) {
    return new ProviderExecutionError(
      'PROVIDER_RATE_LIMITED',
      `${providerDisplayName(providerId)} is rate limited. Try again later.`,
      { status },
    );
  }
  if (status >= 500) {
    return new ProviderExecutionError(
      'PROVIDER_UNAVAILABLE',
      `${providerDisplayName(providerId)} is temporarily unavailable.`,
      { status, retryable: true },
    );
  }
  return new ProviderExecutionError(
    'PROVIDER_REQUEST_FAILED',
    `${providerDisplayName(providerId)} rejected the request (${status}).`,
    { status },
  );
}

function assertSupportedProvider(route: ProviderRoute): void {
  if (!MOBILE_PROVIDER_IDS.includes(route.providerId)) {
    throw new ProviderExecutionError(
      'PROVIDER_UNSUPPORTED',
      `${providerDisplayName(route.providerId)} is not available on this device.`,
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

function audioTooLargeError(): ProviderExecutionError {
  return new ProviderExecutionError(
    'AUDIO_TOO_LARGE',
    'This audio is larger than the 25 MB provider limit. Record a shorter clip or choose a smaller file.',
  );
}

async function apiKeyForRoute(
  route: ProviderRoute,
  getCredential: ProviderExecutionDependencies['getCredential'],
): Promise<string | null> {
  if (!route.credentialRef) {
    if (route.providerId === 'custom') return null;
    throw new ProviderExecutionError(
      'CREDENTIAL_MISSING',
      `Configure credentials for ${providerDisplayName(route.providerId)}.`,
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
      `Configure credentials for ${providerDisplayName(route.providerId)}.`,
    );
  }
  return credential.apiKey;
}

async function prepareRoute(
  route: ProviderRoute,
  getCredential: ProviderExecutionDependencies['getCredential'],
): Promise<{ endpoint: string; apiKey: string | null }> {
  assertSupportedProvider(route);
  const endpoint = assertEndpoint(route);
  return { endpoint, apiKey: await apiKeyForRoute(route, getCredential) };
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

// Native failures that retrying cannot fix, with fixed copy so no native detail
// reaches the UI.
const FINAL_NATIVE_FAILURES: Record<string, string> = {
  PROVIDER_HTTPS_REQUIRED: 'iOS only allows this server over HTTPS. Use an HTTPS address.',
  PROVIDER_AUDIO_UNAVAILABLE: 'The recorded audio is unavailable. Record again.',
  PROVIDER_RECOVERY_UNAVAILABLE:
    'The recording could not be saved for recovery. The original audio is retained.',
  PROVIDER_TRANSPORT_UNAVAILABLE: 'Update OpenWhispr to use your own provider key.',
  PROVIDER_INVALID_RECOVERY_ROUTE:
    'The provider settings for this recording are invalid. Check AI Models, then retry from history.',
  // Not a cancellation: the audio is kept, so the user can retry it.
  PROVIDER_BACKGROUND_EXPIRED: 'iOS stopped the request in the background. Retry from history.',
  PROVIDER_CERTIFICATE_UNTRUSTED:
    "Couldn't connect securely to this server. Check that its certificate is valid and trusted by iOS.",
  // The 10-minute total limit. Retrying would send a long upload again.
  PROVIDER_TIMED_OUT: 'The provider took too long to respond. Try again.',
};

function normalizeTransportFailure(error: unknown, providerId: string): Error {
  if (error instanceof ProviderExecutionError) return error;
  if (error instanceof Error && error.name === 'AbortError') return error;
  const nativeCode = objectValue(error)?.code;
  if (nativeCode === 'PROVIDER_CANCELLED') return abortError();
  if (nativeCode === 'PROVIDER_AUDIO_TOO_LARGE') return audioTooLargeError();
  if (typeof nativeCode === 'string' && FINAL_NATIVE_FAILURES[nativeCode]) {
    return new ProviderExecutionError(nativeCode, FINAL_NATIVE_FAILURES[nativeCode]);
  }
  if (nativeCode === 'PROVIDER_LOCAL_NETWORK_ERROR') {
    return new ProviderExecutionError(
      'PROVIDER_LOCAL_NETWORK_ERROR',
      'Check Local Network permission and the server address.',
    );
  }
  if (nativeCode === 'PROVIDER_INVALID_URL' || nativeCode === 'PROVIDER_INVALID_REQUEST') {
    return new ProviderExecutionError('ENDPOINT_INVALID', 'The provider endpoint is invalid.');
  }
  return new ProviderExecutionError(
    'PROVIDER_NETWORK_ERROR',
    `Unable to reach ${providerDisplayName(providerId)}.`,
    {
      retryable: true,
    },
  );
}

async function parseJson(response: Response, providerId: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderExecutionError(
      'PROVIDER_RESPONSE_INVALID',
      `${providerDisplayName(providerId)} returned an invalid response.`,
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
    `${providerDisplayName(providerId)} returned an empty or malformed response.`,
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

function responseTextFromChat(payload: unknown, providerId: string): string | null {
  const choices = objectValue(payload)?.choices;
  if (!Array.isArray(choices)) return null;
  const choice = objectValue(choices[0]);
  // A cut-off cleanup would silently replace the full transcript it was given.
  if (choice?.finish_reason === 'length') {
    throw new ProviderExecutionError(
      'PROVIDER_RESPONSE_TRUNCATED',
      `${providerDisplayName(providerId)} stopped before finishing. Try a model with a larger output limit.`,
    );
  }
  return nonEmptyText(objectValue(choice?.message)?.content);
}

function transcriptionDuration(payload: unknown): number {
  const duration = objectValue(payload)?.duration;
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

// Failures a different base address cannot change: the key, the account, or the
// connection itself. Anything else (a 404, a web page, a 405) may mean the API
// lives under /v1.
const SAME_AT_EVERY_BASE = new Set([
  'INVALID_CREDENTIAL',
  'PROVIDER_QUOTA_EXCEEDED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_NETWORK_ERROR',
  'PROVIDER_LOCAL_NETWORK_ERROR',
  'PROVIDER_HTTPS_REQUIRED',
  'PROVIDER_CERTIFICATE_UNTRUSTED',
  'PROVIDER_TIMED_OUT',
]);

// Setup checks only: a custom server entered as a bare origin usually serves its
// API under /v1. Built-in providers have fixed endpoints and are never probed.
async function firstWorkingEndpoint<T>(
  route: ProviderRoute,
  endpoint: string,
  attempt: (candidate: string) => Promise<T>,
): Promise<{ result: T; endpoint: string }> {
  const candidates =
    route.providerId === 'custom' ? getModelListBaseCandidates(endpoint) : [endpoint];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return { result: await attempt(candidate), endpoint: candidate };
    } catch (error) {
      if (!(error instanceof ProviderExecutionError) || SAME_AT_EVERY_BASE.has(error.code)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

async function processText(
  dependencies: ProviderExecutionDependencies,
  input: ProviderTextInput,
): Promise<{ text: string; model: string }> {
  const { endpoint, apiKey } = await prepareRoute(input.route, dependencies.getCredential);
  return {
    text: await requestChat(dependencies, input, endpoint, apiKey),
    model: input.route.modelId,
  };
}

async function requestChat(
  dependencies: ProviderExecutionDependencies,
  input: ProviderTextInput,
  endpoint: string,
  apiKey: string | null,
): Promise<string> {
  const { route } = input;
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
  return requireText(responseTextFromChat(payload, route.providerId), route.providerId);
}

async function transcribe(
  dependencies: ProviderExecutionDependencies,
  input: ProviderTranscriptionInput,
): Promise<{ text: string; duration: number }> {
  const { route } = input;
  const { endpoint, apiKey } = await prepareRoute(route, dependencies.getCredential);
  const size = await dependencies.fileSize(input.audioUri);
  if (size !== undefined && size > PROVIDER_AUDIO_LIMIT_BYTES) throw audioTooLargeError();
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
      // The native multipart writer refuses quotes, backslashes and line breaks here.
      fileName: (input.fileName || input.audioUri.split('/').pop() || 'recording.m4a').replace(
        /["\\\r\n]/g,
        '_',
      ),
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
  const text = objectValue(payload)?.text;
  // Silence comes back as an empty transcript; report it the way Cloud does.
  if (typeof text === 'string' && !text.trim()) {
    throw new ProviderExecutionError('NO_SPEECH', 'No speech detected');
  }
  return {
    text: requireText(nonEmptyText(text), route.providerId),
    duration: transcriptionDuration(payload),
  };
}

async function discoverModels(
  dependencies: ProviderExecutionDependencies,
  input: ProviderSetupInput,
): Promise<ProviderModelDiscovery> {
  const { route } = input;
  const { endpoint, apiKey } = await prepareRoute(route, dependencies.getCredential);
  const discovered = await firstWorkingEndpoint(route, endpoint, (candidate) =>
    listModels(dependencies, input, candidate, apiKey),
  );
  return { models: discovered.result, verification: 'catalog-only', endpoint: discovered.endpoint };
}

async function listModels(
  dependencies: ProviderExecutionDependencies,
  input: ProviderSetupInput,
  endpoint: string,
  apiKey: string | null,
): Promise<Array<{ id: string; name: string }>> {
  const { route } = input;
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
      `${providerDisplayName(route.providerId)} returned no usable models.`,
    );
  }
  return models;
}

async function testConnection(
  dependencies: ProviderExecutionDependencies,
  input: ProviderSetupInput,
): Promise<ProviderConnectionResult> {
  const { route } = input;
  const identity = {
    ok: true,
    providerId: route.providerId,
    modelId: route.modelId,
    scope: route.scope,
  } as const;
  if (isTranscriptionScope(route.scope)) {
    const { endpoint } = await discoverModels(dependencies, input);
    return { ...identity, verification: 'catalog-only', endpoint };
  }
  const prepared = await prepareRoute(route, dependencies.getCredential);
  const { endpoint } = await firstWorkingEndpoint(route, prepared.endpoint, (candidate) =>
    requestChat(
      dependencies,
      {
        route,
        text: 'Reply with OK.',
        systemPrompt: 'This is a provider connection test. Reply only with OK.',
        signal: input.signal,
      },
      candidate,
      prepared.apiKey,
    ),
  );
  return { ...identity, verification: 'inference', endpoint };
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
  const withTypedKey = (
    scoped: ProviderExecutionDependencies,
    apiKey: string | undefined,
  ): ProviderExecutionDependencies =>
    apiKey ? { ...scoped, getCredential: async () => ({ apiKey }) } : scoped;
  return {
    processProviderText: (input) =>
      execute(input, (scoped, signal) => processText(scoped, { ...input, signal })),
    transcribeWithProvider: (input) =>
      execute(input, (scoped, signal) => transcribe(scoped, { ...input, signal })),
    discoverProviderModels: (input) =>
      execute(input, (scoped, signal) =>
        discoverModels(withTypedKey(scoped, input.apiKey), { ...input, signal }),
      ),
    testProviderConnection: (input) =>
      execute(input, (scoped, signal) =>
        testConnection(withTypedKey(scoped, input.apiKey), { ...input, signal }),
      ),
  };
}

const defaultExecution = createProviderExecution(defaultDependencies);

export const processProviderText = defaultExecution.processProviderText;
export const transcribeWithProvider = defaultExecution.transcribeWithProvider;
export const discoverProviderModels = defaultExecution.discoverProviderModels;
export const testProviderConnection = defaultExecution.testProviderConnection;
