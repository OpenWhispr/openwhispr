import catalog from "./modelRegistryData.json" with { type: "json" };
import { isSecureHttpEndpoint, normalizeBaseUrl } from "./endpoints.ts";

export type InferenceScope = "dictation" | "upload" | "meeting" | "cleanup" | "notes" | "agent";
export type InferenceMode = "openwhispr" | "local" | "providers";
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
  streaming?: boolean;
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
  | { status: "unmanaged" }
  | { status: "pending" }
  | { status: "managed"; transcription: ScopePolicy; llm: ScopePolicy; agentEnabled?: boolean };
export type InferenceRoute =
  | { mode: "openwhispr" | "local"; scope: InferenceScope }
  | {
      mode: "providers";
      scope: InferenceScope;
      providerId: string;
      modelId: string;
      endpoint: string;
      credentialRef?: string;
    };
export type RouteErrorCode =
  | "PRIVATE_CONTENT"
  | "POLICY_UNRESOLVED"
  | "POLICY_BLOCKED"
  | "PROVIDER_UNSUPPORTED"
  | "MODEL_UNSUPPORTED"
  | "MODEL_REQUIRED"
  | "CREDENTIAL_REQUIRED"
  | "ENDPOINT_INVALID";
export type RouteResolution =
  { ok: true; route: InferenceRoute } | { ok: false; code: RouteErrorCode };

// Routes are resolved for the OpenAI-compatible batch and chat protocol. Catalog
// providers that need their own adapters (streaming-only, batch models, regional
// endpoints) stay out of the apps' allowlists until those adapters exist.
const TEXT_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
};

export function isTranscriptionScope(scope: InferenceScope): boolean {
  return scope === "dictation" || scope === "upload" || scope === "meeting";
}

export function getProvidersForScope(scope: InferenceScope): ProviderDefinition[] {
  // Live meetings stream audio, which the batch protocol does not cover.
  if (scope === "meeting") return [];
  if (!isTranscriptionScope(scope)) {
    return [
      ...catalog.cloudProviders
        .filter((provider): boolean => provider.id in TEXT_ENDPOINTS)
        .map((provider): ProviderDefinition => ({
          ...provider,
          endpoint: TEXT_ENDPOINTS[provider.id],
        })),
      {
        id: "openrouter",
        name: "OpenRouter",
        endpoint: "https://openrouter.ai/api/v1",
        models: [],
      },
      { id: "custom", name: "Custom", endpoint: "", models: [] },
    ];
  }
  return [
    ...catalog.transcriptionProviders.map((provider): ProviderDefinition => ({
      id: provider.id,
      name: provider.name,
      endpoint: provider.baseUrl,
      models: provider.models,
    })),
    { id: "custom", name: "Custom", endpoint: "", models: [] },
  ];
}

export function resolveInferenceRoute(input: {
  scope: InferenceScope;
  selection: InferenceSelection;
  privateContent?: boolean;
  policy: InferencePolicy;
}): RouteResolution {
  const { scope, selection, policy } = input;
  if (input.privateContent && selection.mode !== "local")
    return { ok: false, code: "PRIVATE_CONTENT" };
  if (policy.status === "pending" && selection.mode !== "local")
    return { ok: false, code: "POLICY_UNRESOLVED" };
  if (policy.status === "managed") {
    const scopedPolicy = isTranscriptionScope(scope) ? policy.transcription : policy.llm;
    if (
      !scopedPolicy.allowedModes.includes(selection.mode) ||
      (selection.mode === "providers" &&
        !scopedPolicy.allowedByokProviders.includes(selection.providerId ?? "")) ||
      (scope === "agent" && policy.agentEnabled === false)
    )
      return { ok: false, code: "POLICY_BLOCKED" };
  }
  if (selection.mode !== "providers") return { ok: true, route: { mode: selection.mode, scope } };
  const provider = getProvidersForScope(scope).find(
    (candidate): boolean => candidate.id === selection.providerId
  );
  if (!provider) return { ok: false, code: "PROVIDER_UNSUPPORTED" };
  const modelId = selection.modelId?.trim();
  if (!modelId) return { ok: false, code: "MODEL_REQUIRED" };
  if (
    isTranscriptionScope(scope) &&
    provider.models.length &&
    !provider.models.some((model): boolean => model.id === modelId)
  )
    return { ok: false, code: "MODEL_UNSUPPORTED" };
  const endpoint = normalizeBaseUrl(
    provider.id === "custom" ? selection.endpoint : provider.endpoint
  );
  if (!endpoint || !isSecureHttpEndpoint(endpoint)) return { ok: false, code: "ENDPOINT_INVALID" };
  const parsed = new URL(endpoint);
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (provider.id === "custom" && parsed.search)
  )
    return { ok: false, code: "ENDPOINT_INVALID" };
  if (provider.id !== "custom" && !selection.credentialRef)
    return { ok: false, code: "CREDENTIAL_REQUIRED" };
  return {
    ok: true,
    route: {
      mode: "providers",
      scope,
      providerId: provider.id,
      modelId,
      endpoint,
      ...(selection.credentialRef ? { credentialRef: selection.credentialRef } : {}),
    },
  };
}
