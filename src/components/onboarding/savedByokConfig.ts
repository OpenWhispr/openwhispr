import { API_ENDPOINTS } from "../../config/constants.ts";
import { isSelfHostedTranscription } from "../../helpers/selfHostedTranscription.js";
import type { SettingsState } from "../../stores/settingsStore.ts";
import type { OnboardingByokDraft, OnboardingByokStepId } from "./flow.ts";

/** The saved settings a BYOK step reads to reopen on what the user already configured. */
export type SavedByokSnapshot = Pick<
  SettingsState,
  | "useLocalWhisper"
  | "transcriptionMode"
  | "cloudTranscriptionProvider"
  | "cloudTranscriptionModel"
  | "cloudTranscriptionBaseUrl"
  | "remoteTranscriptionUrl"
  | "remoteTranscriptionModel"
  | "chatAgentMode"
  | "chatAgentProvider"
  | "chatAgentModel"
  | "chatAgentRemoteUrl"
>;

export interface SavedByokConfig {
  draft: OnboardingByokDraft;
  /** The Settings self-hosted server, which sends no API key. */
  keyless: boolean;
}

const hostedConfig = (provider: string, model: string): SavedByokConfig => ({
  draft: { selectedProvider: provider, selectedModel: model, baseUrl: "", customModel: "" },
  keyless: false,
});

const endpointConfig = (baseUrl: string, model: string, keyless = false): SavedByokConfig => ({
  draft: { selectedProvider: "", selectedModel: "", baseUrl, customModel: model },
  keyless,
});

// Same precedence as resolveTranscriptionRoute, so the step reopens on the endpoint
// dictation actually uses. Local is read from useLocalWhisper because Settings also
// writes cloudTranscriptionMode "byok" for Local.
function resolveSavedDictation(s: SavedByokSnapshot): SavedByokConfig | null {
  if (isSelfHostedTranscription(s)) {
    return endpointConfig(s.remoteTranscriptionUrl.trim(), s.remoteTranscriptionModel.trim(), true);
  }
  if (s.useLocalWhisper) return null;
  if (s.transcriptionMode !== "providers" && s.transcriptionMode !== "self-hosted") return null;
  if (s.cloudTranscriptionProvider === "custom") {
    const baseUrl = (s.cloudTranscriptionBaseUrl || "").trim();
    // The untouched store default is not a configured endpoint, as in the custom route.
    if (!baseUrl || baseUrl === API_ENDPOINTS.TRANSCRIPTION_BASE) return null;
    return endpointConfig(baseUrl, s.cloudTranscriptionModel);
  }
  // Self-hosted mode without its own URL only routes for the custom provider.
  if (s.transcriptionMode === "self-hosted") return null;
  return hostedConfig(s.cloudTranscriptionProvider, s.cloudTranscriptionModel);
}

// A Custom provider under "providers" is left out: this step can only save a
// self-hosted endpoint, which would move it to a different URL setting.
function resolveSavedAssistant(s: SavedByokSnapshot): SavedByokConfig | null {
  if (s.chatAgentMode === "self-hosted") {
    const baseUrl = s.chatAgentRemoteUrl.trim();
    return baseUrl ? endpointConfig(baseUrl, s.chatAgentModel) : null;
  }
  if (s.chatAgentMode === "providers" && s.chatAgentProvider && s.chatAgentProvider !== "custom") {
    return hostedConfig(s.chatAgentProvider, s.chatAgentModel);
  }
  return null;
}

/**
 * The provider setup already saved for a BYOK step, as the draft the step opens on. Null
 * when there is nothing to reopen: a first run, OpenWhispr Cloud, local or enterprise.
 * The draft never carries a key; the step reads keys from the store.
 */
export function resolveSavedByokConfig(
  stepId: OnboardingByokStepId,
  settings: SavedByokSnapshot
): SavedByokConfig | null {
  return stepId === "byok-assistant"
    ? resolveSavedAssistant(settings)
    : resolveSavedDictation(settings);
}

export function isBlankByokDraft(draft: OnboardingByokDraft): boolean {
  return !(draft.selectedProvider || draft.selectedModel || draft.baseUrl || draft.customModel);
}

/**
 * The remoteTranscriptionUrl stored with a self-hosted dictation endpoint saved in
 * onboarding. Without a key it is mirrored, as migrateProviderSettings does, so Settings
 * and upload show it; both routes send the same request. With a key it is cleared: only
 * the custom route authenticates, and a leftover URL would win over it.
 */
export function selfHostedRemoteTranscriptionUrl(committedUrl: string, apiKey: string): string {
  return apiKey.trim() ? "" : committedUrl;
}
