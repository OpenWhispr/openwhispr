import { getSettings } from "../stores/settingsStore";
import type { ManagedTranscriptionResolution } from "../helpers/transcriptionRoute";
import {
  getManagedScopeResolution,
  useEnterpriseIdentityStore,
} from "../stores/enterpriseIdentityStore";

/**
 * Managed enterprise STT outcome for the current user, as a
 * `TranscriptionRouteInput.managed` value. Undefined means no managed
 * transcription applies and personal routing proceeds; the context mirrors
 * `getEnterpriseCallSettings` so the main process can re-validate it.
 */
/**
 * True when managed STT resolves for this user. Dictation gates OR this with
 * the personal-selection policy check: a policy that only allows the
 * enterprise mode blocks every personal setting, yet dictation must proceed
 * through the managed route.
 */
export function isManagedTranscriptionActive(): boolean {
  return getManagedTranscriptionResolution()?.kind === "managed";
}

export function getManagedTranscriptionResolution(): ManagedTranscriptionResolution | undefined {
  const settings = getSettings();
  const state = useEnterpriseIdentityStore.getState();
  const resolution = getManagedScopeResolution("transcription", settings.enterpriseSetupMode);
  if (resolution.kind === "error") {
    return { kind: "error", message: resolution.message, code: resolution.code };
  }
  if (
    resolution.kind !== "managed" ||
    resolution.provider !== "azure" ||
    !state.config ||
    !state.accountId ||
    !state.workspaceId ||
    state.authGeneration == null
  ) {
    return undefined;
  }
  return {
    kind: "managed",
    provider: "azure",
    deployment: resolution.model,
    context: {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      authGeneration: state.authGeneration,
      setupMode: settings.enterpriseSetupMode,
      inferenceScope: "transcription",
      provider: "azure",
      generation: state.config.generation,
      providerVersion: resolution.record.version,
    },
  };
}
