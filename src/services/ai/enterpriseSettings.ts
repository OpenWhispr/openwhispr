import { getSettings } from "../../stores/settingsStore";
import type { EnterpriseProvider } from "../../models/ModelRegistry";
import type { InferenceScope } from "../../config/inferenceScopes";
import type {
  EnterpriseSetupMode,
  ManagedEnterpriseRequestContext,
} from "../../types/enterpriseIdentity";
import type { ReasoningStartClaim } from "../../types/electron";
import {
  isCurrentManagedLocalModelBinding,
  readManagedLocalModelBinding,
} from "../../components/onboarding/managedLocalModels";
import { readManagedPendingLocalModel } from "../../components/onboarding/pendingLocalModels";
import {
  getManagedScopeResolution,
  selectManagedLocalModelContext,
  useEnterpriseIdentityStore,
} from "../../stores/enterpriseIdentityStore";
import { isLlmSelectionAllowed } from "../../stores/policyRules";
import { usePolicyStore } from "../../stores/policyStore";

const AUTHORIZATION_BOUNDARY_CHANGED = "AUTHORIZATION_BOUNDARY_CHANGED";

export function isReasoningAdmissionError(value: unknown): boolean {
  const code =
    value && typeof value === "object" && "code" in value
      ? (value as { code?: unknown }).code
      : undefined;
  return (
    code === AUTHORIZATION_BOUNDARY_CHANGED ||
    code === "PROVIDER_POLICY_CONFLICT" ||
    (typeof code === "string" && code.startsWith("MANAGED_"))
  );
}

export interface ExactReasoningRoute {
  provider: string;
  model: string | null;
  inferenceScope: InferenceScope;
  setupMode: EnterpriseSetupMode;
}

export interface ReasoningStartResolution {
  provider: string;
  model: string;
  inferenceScope: InferenceScope;
  setupMode: EnterpriseSetupMode;
  managed: boolean;
  claim: ReasoningStartClaim;
}

interface ReasoningStartInput {
  provider: string;
  model: string;
  inferenceScope: InferenceScope;
  setupMode: EnterpriseSetupMode;
  isSignedIn?: boolean;
}

export interface ReasoningStartContext {
  route: ExactReasoningRoute;
  claim: ReasoningStartClaim;
}

const REASONING_START_CONTEXT = Symbol("reasoningStartContext");

function reasoningAdmissionError(code: string): Error & { code: string } {
  const messages: Record<string, string> = {
    AUTHORIZATION_BOUNDARY_CHANGED: "Inference authorization changed. Retry the request.",
    MANAGED_CONFIG_UNAVAILABLE: "Managed configuration is unavailable.",
    MANAGED_LOCAL_MODEL_UNAVAILABLE: "Managed local model is unavailable.",
    MANAGED_WORKSPACE_REQUIRED: "An active workspace is required for managed inference.",
    PROVIDER_POLICY_CONFLICT:
      "Managed access is blocked by your workspace policy. Contact your IT administrator.",
  };
  return Object.assign(new Error(messages[code] || "Reasoning is unavailable."), { code });
}

function normalizedModel(model: string | null | undefined): string | null {
  return typeof model === "string" && model.length > 0 ? model : null;
}

function buildReasoningClaim(
  input: Pick<ReasoningStartInput, "provider" | "model">,
  managed: boolean,
  configGeneration: number | null
): ReasoningStartClaim {
  const state = useEnterpriseIdentityStore.getState();
  const isGuest =
    state.accountId === null && state.workspaceId === null && state.authGeneration === null;
  return {
    accountId: isGuest ? null : state.accountId,
    workspaceId: isGuest ? null : state.workspaceId,
    authGeneration: isGuest ? null : state.authGeneration,
    configGeneration: isGuest ? null : configGeneration,
    managed,
    provider: input.provider,
    model: normalizedModel(input.model),
  };
}

function unmanagedResolution(
  input: ReasoningStartInput,
  configGeneration: number | null
): ReasoningStartResolution {
  return {
    provider: input.provider,
    model: input.model,
    inferenceScope: input.inferenceScope,
    setupMode: input.setupMode,
    managed: false,
    claim: buildReasoningClaim(input, false, configGeneration),
  };
}

/** Resolves the current identity-fenced reasoning route immediately before dispatch. */
export function resolveManagedReasoningStart(input: ReasoningStartInput): ReasoningStartResolution {
  const state = useEnterpriseIdentityStore.getState();
  const isGuest =
    state.accountId === null && state.workspaceId === null && state.authGeneration === null;
  if (isGuest && !input.isSignedIn) return unmanagedResolution(input, null);
  if (input.isSignedIn && state.accountId && !state.workspaceId) {
    throw reasoningAdmissionError("MANAGED_WORKSPACE_REQUIRED");
  }
  if (state.verdict === "unmanaged" && !state.failClosed) {
    return unmanagedResolution(input, null);
  }
  if (
    state.failClosed ||
    state.status !== "ready" ||
    state.verdict !== "configured" ||
    !state.config ||
    !state.accountId ||
    !state.workspaceId ||
    state.authGeneration == null
  ) {
    throw reasoningAdmissionError("MANAGED_CONFIG_UNAVAILABLE");
  }

  const localContext = selectManagedLocalModelContext(state);
  const assistantSelections =
    localContext?.localModels.selections.filter(
      (selection) => selection.provider !== "whisper" && selection.provider !== "nvidia"
    ) ?? [];
  if (assistantSelections.length > 0) {
    const binding = readManagedLocalModelBinding(localContext!.identity, "assistant");
    if (
      !isCurrentManagedLocalModelBinding(
        binding,
        localContext!.identity,
        "assistant",
        assistantSelections
      ) ||
      readManagedPendingLocalModel("assistant", {
        ...localContext!.identity,
        provider: binding.provider,
        modelId: binding.model,
      })
    ) {
      throw reasoningAdmissionError("MANAGED_LOCAL_MODEL_UNAVAILABLE");
    }
    if (
      !isLlmSelectionAllowed(usePolicyStore.getState(), {
        mode: "local",
        provider: binding.provider,
      })
    ) {
      throw reasoningAdmissionError("PROVIDER_POLICY_CONFLICT");
    }
    const managedInput = {
      provider: binding.provider,
      model: binding.model,
      inferenceScope: input.inferenceScope,
      setupMode: input.setupMode,
    };
    return {
      ...managedInput,
      managed: true,
      claim: buildReasoningClaim(managedInput, true, state.config.generation),
    };
  }

  // A local-only envelope with no assistant selection does not own reasoning.
  if (state.config.localModels) {
    return unmanagedResolution(input, state.config.generation);
  }

  const resolution = getManagedScopeResolution(input.inferenceScope, input.setupMode);
  if (resolution.kind === "error") throw reasoningAdmissionError(resolution.code);
  if (resolution.kind === "manual") {
    return unmanagedResolution(input, state.config.generation);
  }
  const managedInput = {
    provider: resolution.provider,
    model: resolution.model,
    inferenceScope: input.inferenceScope,
    setupMode: input.setupMode,
  };
  return {
    ...managedInput,
    managed: true,
    claim: buildReasoningClaim(managedInput, true, state.config.generation),
  };
}

/** Captures a claim only when the already-selected route is still authoritative. */
export function captureReasoningStartClaim(
  route: ExactReasoningRoute,
  settings: { isSignedIn?: boolean }
): ReasoningStartClaim {
  const resolution = resolveManagedReasoningStart({
    ...route,
    model: route.model ?? "",
    isSignedIn: settings.isSignedIn,
  });
  if (
    resolution.provider !== route.provider ||
    normalizedModel(resolution.model) !== normalizedModel(route.model)
  ) {
    throw reasoningAdmissionError(AUTHORIZATION_BOUNDARY_CHANGED);
  }
  return resolution.claim;
}

/** Carries renderer-only start metadata without duplicating it in structured IPC config. */
export function withReasoningStartContext<T extends object>(
  config: T,
  resolution: ReasoningStartResolution
): T {
  Object.defineProperty(config, REASONING_START_CONTEXT, {
    configurable: false,
    enumerable: false,
    value: {
      route: {
        provider: resolution.provider,
        model: normalizedModel(resolution.model),
        inferenceScope: resolution.inferenceScope,
        setupMode: resolution.setupMode,
      },
      claim: resolution.claim,
    } satisfies ReasoningStartContext,
  });
  return config;
}

export function getReasoningStartContext(config: object): ReasoningStartContext {
  const context = (config as { [REASONING_START_CONTEXT]?: ReasoningStartContext })[
    REASONING_START_CONTEXT
  ];
  if (!context) throw reasoningAdmissionError(AUTHORIZATION_BOUNDARY_CHANGED);
  return context;
}

export type EnterpriseCallSettings = {
  apiKey: string;
  bedrockRegion: string;
  bedrockProfile: string;
  bedrockAccessKeyId: string;
  bedrockSecretAccessKey: string;
  bedrockSessionToken: string;
  azureEndpoint: string;
  azureApiVersion: string;
  vertexProject: string;
  vertexLocation: string;
  managedContext?: ManagedEnterpriseRequestContext;
  reasoningStartClaim: ReasoningStartClaim;
  inferenceScope: InferenceScope;
  setupMode: EnterpriseSetupMode;
};

export function getEnterpriseCallSettings(
  provider: EnterpriseProvider,
  inferenceScope: InferenceScope,
  model = "",
  existingClaim?: ReasoningStartClaim
): EnterpriseCallSettings {
  const s = getSettings();
  const managedState = useEnterpriseIdentityStore.getState();
  const reasoningStartClaim =
    existingClaim ??
    resolveManagedReasoningStart({
      provider,
      model,
      inferenceScope,
      setupMode: s.enterpriseSetupMode,
      isSignedIn: s.isSignedIn,
    }).claim;
  const resolution = getManagedScopeResolution(inferenceScope, s.enterpriseSetupMode);
  if (resolution.kind === "error") {
    throw Object.assign(new Error(resolution.message), { code: resolution.code });
  }
  const managedContext =
    resolution.kind === "managed" &&
    managedState.config &&
    managedState.accountId &&
    managedState.workspaceId &&
    managedState.authGeneration != null
      ? {
          accountId: managedState.accountId,
          workspaceId: managedState.workspaceId,
          authGeneration: managedState.authGeneration,
          setupMode: s.enterpriseSetupMode,
          inferenceScope,
          provider: resolution.provider,
          generation: managedState.config.generation,
          providerVersion: resolution.record.version,
        }
      : undefined;
  return {
    apiKey: provider === "azure" ? s.azureApiKey : provider === "vertex" ? s.vertexApiKey : "",
    bedrockRegion: s.bedrockRegion,
    bedrockProfile: s.bedrockProfile,
    bedrockAccessKeyId: s.bedrockAccessKeyId,
    bedrockSecretAccessKey: s.bedrockSecretAccessKey,
    bedrockSessionToken: s.bedrockSessionToken,
    azureEndpoint: s.azureEndpoint,
    azureApiVersion: s.azureApiVersion,
    vertexProject: s.vertexProject,
    vertexLocation: s.vertexLocation,
    managedContext,
    reasoningStartClaim,
    inferenceScope,
    setupMode: s.enterpriseSetupMode,
  };
}
