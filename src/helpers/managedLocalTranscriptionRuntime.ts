import {
  isCurrentManagedLocalModelBinding,
  readManagedLocalModelBinding,
  type ManagedLocalModelIdentity,
} from "../components/onboarding/managedLocalModels";
import { readManagedPendingLocalModel } from "../components/onboarding/pendingLocalModels";
import {
  selectManagedLocalModelContext,
  useEnterpriseIdentityStore,
} from "../stores/enterpriseIdentityStore";
import type { TranscriptionStartClaim } from "../types/electron";

export type ManagedLocalTranscriptionRuntime =
  | { kind: "unmanaged" }
  | {
      kind: "managed";
      provider: "whisper" | "nvidia";
      model: string;
      identity: ManagedLocalModelIdentity;
    }
  | {
      kind: "error";
      code:
        | "MANAGED_CONFIG_UNAVAILABLE"
        | "MANAGED_LOCAL_MODEL_UNAVAILABLE"
        | "MANAGED_WORKSPACE_REQUIRED";
    };

export interface ExactTranscriptionRoute {
  provider: string;
  model: string | null;
}

const AUTHORIZATION_BOUNDARY_CHANGED = "AUTHORIZATION_BOUNDARY_CHANGED";

export function isTranscriptionAdmissionError(value: unknown): boolean {
  const code =
    value && typeof value === "object" && "code" in value
      ? (value as { code?: unknown }).code
      : undefined;
  return (
    code === AUTHORIZATION_BOUNDARY_CHANGED ||
    (typeof code === "string" && code.startsWith("MANAGED_"))
  );
}

function transcriptionAdmissionError(code: string): Error & { code: string } {
  const messages: Record<string, string> = {
    AUTHORIZATION_BOUNDARY_CHANGED: "Inference authorization changed. Retry the request.",
    MANAGED_CONFIG_UNAVAILABLE: "Managed configuration is unavailable.",
    MANAGED_LOCAL_MODEL_UNAVAILABLE: "Managed local model is unavailable.",
    MANAGED_WORKSPACE_REQUIRED: "An active workspace is required for managed inference.",
  };
  return Object.assign(new Error(messages[code] || "Transcription is unavailable."), { code });
}

/** Resolves the identity-fenced local route without falling back to personal settings. */
export function resolveManagedLocalTranscriptionRuntime(settings: {
  isSignedIn?: boolean;
}): ManagedLocalTranscriptionRuntime {
  const state = useEnterpriseIdentityStore.getState();
  const isGuest =
    state.accountId === null && state.workspaceId === null && state.authGeneration === null;
  if (isGuest && !settings.isSignedIn) return { kind: "unmanaged" };
  if (settings.isSignedIn && state.accountId && !state.workspaceId) {
    return { kind: "error", code: "MANAGED_WORKSPACE_REQUIRED" };
  }
  if (state.verdict === "unmanaged" && !state.failClosed) return { kind: "unmanaged" };
  if (
    state.failClosed ||
    state.status !== "ready" ||
    state.verdict !== "configured" ||
    !state.config ||
    !state.accountId ||
    !state.workspaceId ||
    state.authGeneration == null
  ) {
    return { kind: "error", code: "MANAGED_CONFIG_UNAVAILABLE" };
  }
  const context = selectManagedLocalModelContext(state);
  if (!context || !context.localModels.selections.length) return { kind: "unmanaged" };
  const approvedSelections = context.localModels.selections.filter(
    (selection) => selection.provider === "whisper" || selection.provider === "nvidia"
  );
  if (approvedSelections.length === 0) return { kind: "unmanaged" };
  const binding = readManagedLocalModelBinding(context.identity, "dictation");
  if (
    !isCurrentManagedLocalModelBinding(
      binding,
      context.identity,
      "dictation",
      approvedSelections
    ) ||
    (binding.provider !== "whisper" && binding.provider !== "nvidia")
  ) {
    return { kind: "error", code: "MANAGED_LOCAL_MODEL_UNAVAILABLE" };
  }
  if (
    readManagedPendingLocalModel("dictation", {
      ...context.identity,
      provider: binding.provider,
      modelId: binding.model,
    })
  ) {
    return { kind: "error", code: "MANAGED_LOCAL_MODEL_UNAVAILABLE" };
  }
  return {
    kind: "managed",
    provider: binding.provider,
    model: binding.model,
    identity: context.identity,
  };
}

/** Captures the current session identity against an already-resolved exact route. */
export function captureTranscriptionStartClaim(
  route: ExactTranscriptionRoute,
  settings: { isSignedIn?: boolean }
): TranscriptionStartClaim {
  const runtime = resolveManagedLocalTranscriptionRuntime(settings);
  if (runtime.kind === "error") throw transcriptionAdmissionError(runtime.code);

  const state = useEnterpriseIdentityStore.getState();
  if (
    runtime.kind === "managed" &&
    (route.provider !== runtime.provider || route.model !== runtime.model)
  ) {
    throw transcriptionAdmissionError(AUTHORIZATION_BOUNDARY_CHANGED);
  }

  const isGuest =
    state.accountId === null && state.workspaceId === null && state.authGeneration === null;
  return {
    accountId: isGuest ? null : state.accountId,
    workspaceId: isGuest ? null : state.workspaceId,
    authGeneration: isGuest ? null : state.authGeneration,
    configGeneration: isGuest ? null : (state.config?.generation ?? null),
    managed: runtime.kind === "managed",
    provider: route.provider,
    model: route.model,
  };
}
