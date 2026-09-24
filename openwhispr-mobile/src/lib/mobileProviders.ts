import catalog from '@/config/providerCatalog.json';
import { isSecureHttpEndpoint, normalizeBaseUrl } from '@/lib/providerEndpoints';

export type InferenceScope = 'dictation' | 'upload' | 'meeting' | 'cleanup' | 'notes' | 'agent';
export type InferenceMode = 'openwhispr' | 'local' | 'providers';
export interface InferenceSelection {
  mode: InferenceMode;
  providerId?: string;
  modelId?: string;
  endpoint?: string;
  credentialRef?: string;
}
export interface ProviderModel {
  id: string;
  name: string;
}
export interface ProviderDefinition {
  id: string;
  name: string;
  endpoint: string;
  models: readonly ProviderModel[];
}
export interface ScopePolicy {
  allowedModes: readonly string[];
  allowedByokProviders: readonly string[];
}
export type InferencePolicy =
  | { status: 'unmanaged' }
  | { status: 'pending' }
  | { status: 'managed'; transcription: ScopePolicy; llm: ScopePolicy; agentEnabled?: boolean };
export type InferenceRoute =
  | { mode: 'openwhispr' | 'local'; scope: InferenceScope }
  | {
      mode: 'providers';
      scope: InferenceScope;
      providerId: string;
      modelId: string;
      endpoint: string;
      credentialRef?: string;
    };
export type RouteErrorCode =
  | 'PRIVATE_CONTENT'
  | 'POLICY_UNRESOLVED'
  | 'POLICY_BLOCKED'
  | 'PROVIDER_UNSUPPORTED'
  | 'MODEL_UNSUPPORTED'
  | 'MODEL_REQUIRED'
  | 'CREDENTIAL_REQUIRED'
  | 'ENDPOINT_INVALID';
export type RouteResolution =
  | { ok: true; route: InferenceRoute }
  | { ok: false; code: RouteErrorCode };

export type MobileInferenceScope = Exclude<InferenceScope, 'meeting'>;

// The iOS-first release ships the single OpenAI-compatible transport. Other
// providers need their own adapters and device verification first.
export const MOBILE_PROVIDER_IDS: readonly string[] = ['openai', 'groq', 'openrouter', 'custom'];

const TEXT_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
};
const CUSTOM_PROVIDER: ProviderDefinition = {
  id: 'custom',
  name: 'Custom',
  endpoint: '',
  models: [],
};

export function isTranscriptionScope(scope: InferenceScope): boolean {
  return scope === 'dictation' || scope === 'upload' || scope === 'meeting';
}

export function getMobileProvidersForScope(scope: InferenceScope): ProviderDefinition[] {
  // Live meetings stream audio, which the batch protocol does not cover.
  if (scope === 'meeting') return [];
  if (!isTranscriptionScope(scope)) {
    return [
      ...catalog.cloudProviders.map((provider) => ({
        ...provider,
        endpoint: TEXT_ENDPOINTS[provider.id],
      })),
      {
        id: 'openrouter',
        name: 'OpenRouter',
        endpoint: 'https://openrouter.ai/api/v1',
        models: [],
      },
      CUSTOM_PROVIDER,
    ];
  }
  return [
    ...catalog.transcriptionProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      endpoint: provider.baseUrl,
      models: provider.models,
    })),
    CUSTOM_PROVIDER,
  ];
}

// Catalog model lists are ordered best-first.
export function defaultModelId(provider: ProviderDefinition | undefined): string {
  return provider?.models[0]?.id ?? '';
}

// Names a provider the way the settings screens do.
export function providerDisplayName(providerId: string): string {
  if (providerId === 'custom') return 'Custom server';
  return (
    getMobileProvidersForScope('cleanup').find((provider) => provider.id === providerId)?.name ??
    providerId
  );
}

export function resolveMobileInferenceRoute(input: {
  scope: InferenceScope;
  selection: InferenceSelection;
  privateContent?: boolean;
  policy: InferencePolicy;
}): RouteResolution {
  const { scope, selection, policy } = input;
  if (selection.mode === 'providers' && !MOBILE_PROVIDER_IDS.includes(selection.providerId ?? ''))
    return { ok: false, code: 'PROVIDER_UNSUPPORTED' };
  if (input.privateContent && selection.mode !== 'local')
    return { ok: false, code: 'PRIVATE_CONTENT' };
  if (policy.status === 'pending' && selection.mode !== 'local')
    return { ok: false, code: 'POLICY_UNRESOLVED' };
  if (policy.status === 'managed') {
    const scopedPolicy = isTranscriptionScope(scope) ? policy.transcription : policy.llm;
    if (
      !scopedPolicy.allowedModes.includes(selection.mode) ||
      (selection.mode === 'providers' &&
        !scopedPolicy.allowedByokProviders.includes(selection.providerId ?? '')) ||
      (scope === 'agent' && policy.agentEnabled === false)
    )
      return { ok: false, code: 'POLICY_BLOCKED' };
  }
  if (selection.mode !== 'providers') return { ok: true, route: { mode: selection.mode, scope } };
  const provider = getMobileProvidersForScope(scope).find(
    (candidate) => candidate.id === selection.providerId,
  );
  if (!provider) return { ok: false, code: 'PROVIDER_UNSUPPORTED' };
  const modelId = selection.modelId?.trim();
  if (!modelId) return { ok: false, code: 'MODEL_REQUIRED' };
  if (
    isTranscriptionScope(scope) &&
    provider.models.length &&
    !provider.models.some((model) => model.id === modelId)
  )
    return { ok: false, code: 'MODEL_UNSUPPORTED' };
  const endpoint = normalizeBaseUrl(
    provider.id === 'custom' ? selection.endpoint : provider.endpoint,
  );
  if (!endpoint || !isSecureHttpEndpoint(endpoint)) return { ok: false, code: 'ENDPOINT_INVALID' };
  const parsed = new URL(endpoint);
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (provider.id === 'custom' && parsed.search)
  )
    return { ok: false, code: 'ENDPOINT_INVALID' };
  if (provider.id !== 'custom' && !selection.credentialRef)
    return { ok: false, code: 'CREDENTIAL_REQUIRED' };
  return {
    ok: true,
    route: {
      mode: 'providers',
      scope,
      providerId: provider.id,
      modelId,
      endpoint,
      ...(selection.credentialRef ? { credentialRef: selection.credentialRef } : {}),
    },
  };
}
