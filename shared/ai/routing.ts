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
  cortiEnvironment?: "us" | "eu";
  cortiTenant?: string;
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
      cortiEnvironment?: "us" | "eu";
      cortiTenant?: string;
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

export const MEETING_PROVIDER_IDS: readonly string[] = [
  "openai",
  "assemblyai",
  "deepgram",
  "corti",
  "tinfoil",
];
export const STREAMING_ONLY_PROVIDER_IDS: readonly string[] = ["deepgram", "assemblyai"];
const TEXT_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  groq: "https://api.groq.com/openai/v1",
  tinfoil: "https://inference.tinfoil.sh/v1",
  corti: "https://ai.eu.corti.app/v1",
};

export function isTranscriptionScope(scope: InferenceScope): boolean {
  return scope === "dictation" || scope === "upload" || scope === "meeting";
}

export function getProvidersForScope(scope: InferenceScope): ProviderDefinition[] {
  if (!isTranscriptionScope(scope)) {
    return [
      ...catalog.cloudProviders.map((provider): ProviderDefinition => ({
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
  const providers: ProviderDefinition[] = catalog.transcriptionProviders
    .filter(
      (provider): boolean => scope !== "meeting" || MEETING_PROVIDER_IDS.includes(provider.id)
    )
    .filter(
      (provider): boolean =>
        scope !== "upload" || !STREAMING_ONLY_PROVIDER_IDS.includes(provider.id)
    )
    .map((provider): ProviderDefinition => ({
      ...provider,
      endpoint: provider.baseUrl,
      models:
        scope === "meeting"
          ? provider.models.filter(
              (model): boolean => "streaming" in model && model.streaming === true
            )
          : scope === "upload" && provider.id === "gemini"
            ? provider.models.filter(
                (model): boolean => !("streaming" in model && model.streaming === true)
              )
            : scope === "upload" &&
                provider.id === "tinfoil" &&
                "batchModel" in provider &&
                typeof provider.batchModel === "string"
              ? [{ id: provider.batchModel, name: "Voxtral Batch" }]
              : provider.models,
    }));
  if (scope !== "meeting")
    providers.push({ id: "custom", name: "Custom", endpoint: "", models: [] });
  return providers;
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
  const cortiEnvironment = selection.cortiEnvironment ?? "us";
  const cortiTenant = selection.cortiTenant?.trim() || "base";
  if (
    provider.id === "corti" &&
    (!/^(us|eu)$/.test(cortiEnvironment) || !/^[a-zA-Z0-9_-]+$/.test(cortiTenant))
  )
    return { ok: false, code: "ENDPOINT_INVALID" };
  const configuredEndpoint =
    provider.id === "corti" && isTranscriptionScope(scope)
      ? provider.endpoint.replace("api.us.corti.app", `api.${cortiEnvironment}.corti.app`)
      : provider.endpoint;
  const endpoint = normalizeBaseUrl(
    provider.id === "custom" ? selection.endpoint : configuredEndpoint
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
      ...(provider.id === "corti" ? { cortiEnvironment, cortiTenant } : {}),
    },
  };
}
