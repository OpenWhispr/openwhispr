import { getSettings } from "../stores/settingsStore";
import type { ManagedTranscriptionResolution } from "../helpers/transcriptionRoute";
import {
  getManagedScopeResolution,
  useEnterpriseIdentityStore,
} from "../stores/enterpriseIdentityStore";

/**
 * True when managed STT resolves for this user. Dictation gates OR this with
 * the personal-selection policy check: a policy that only allows the
 * enterprise mode blocks every personal setting, yet dictation must proceed
 * through the managed route.
 */
export function isManagedTranscriptionActive(): boolean {
  return getManagedTranscriptionResolution()?.kind === "managed";
}

/**
 * Managed enterprise STT outcome for the current user, as a
 * `TranscriptionRouteInput.managed` value. Undefined means no managed
 * transcription applies and personal routing proceeds; the context mirrors
 * `getEnterpriseCallSettings` so the main process can re-validate it.
 */
export function getManagedTranscriptionResolution(
  operation: "batch" | "realtime" = "batch"
): ManagedTranscriptionResolution | undefined {
  const settings = getSettings();
  const state = useEnterpriseIdentityStore.getState();
  const resolution = getManagedScopeResolution(
    "transcription",
    settings.enterpriseTranscriptionSetupMode,
    operation
  );
  if (resolution.kind === "error") {
    return {
      kind: "error",
      message: resolution.message,
      code: resolution.code,
      messageKey: resolution.messageKey,
    };
  }
  if (
    resolution.kind !== "managed" ||
    !["azure", "openai-compatible"].includes(resolution.provider) ||
    !state.config ||
    !state.accountId ||
    !state.workspaceId ||
    state.authGeneration == null
  ) {
    return undefined;
  }
  return {
    kind: "managed",
    provider: resolution.provider as "azure" | "openai-compatible",
    deployment: resolution.model,
    context: {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      authGeneration: state.authGeneration,
      setupMode: settings.enterpriseTranscriptionSetupMode,
      inferenceScope: "transcription",
      provider: resolution.provider as "azure" | "openai-compatible",
      generation: state.config.generation,
      providerVersion: resolution.record.version,
      operation,
    },
  };
}
