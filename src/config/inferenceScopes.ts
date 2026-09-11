import type { SettingsState } from "../stores/settingsStore";
import type { CloudReasonPurpose } from "../types/electron";

export interface InferenceScopeStoreKeys {
  mode: keyof SettingsState;
  provider: keyof SettingsState;
  model: keyof SettingsState;
  cloudMode?: keyof SettingsState;
  cloudBaseUrl?: keyof SettingsState;
  remoteUrl?: keyof SettingsState;
  customApiKey?: keyof SettingsState;
  disableThinking?: keyof SettingsState;
}

export interface InferenceScopeDefinition {
  storeKeys: InferenceScopeStoreKeys;
  fallbackScope?: string;
  /** Server-side fallback chain OpenWhispr Cloud answers this scope on. */
  cloudPurpose: CloudReasonPurpose;
  /**
   * Inert until the user picks its own model, inheriting the fallback scope
   * meanwhile. Policy never invents that choice, and a policy that moves the
   * chosen provider clears the model so the override asks to be picked again:
   * an invented target would switch the override on and capture requests for
   * a provider with no key. Only for scopes whose every offered mode needs a
   * model, since a cloud mode counts as chosen with none.
   */
  optional?: true;
}

export const INFERENCE_SCOPES = {
  dictationCleanup: {
    cloudPurpose: "cleanup",
    storeKeys: {
      mode: "cleanupMode",
      provider: "cleanupProvider",
      model: "cleanupModel",
      cloudMode: "cleanupCloudMode",
      cloudBaseUrl: "cleanupCloudBaseUrl",
      remoteUrl: "cleanupRemoteUrl",
      customApiKey: "cleanupCustomApiKey",
      disableThinking: "cleanupDisableThinking",
    },
  },
  dictationAgent: {
    cloudPurpose: "assistant",
    storeKeys: {
      mode: "dictationAgentMode",
      provider: "dictationAgentProvider",
      model: "dictationAgentModel",
      cloudMode: "dictationAgentCloudMode",
      cloudBaseUrl: "dictationAgentCloudBaseUrl",
      remoteUrl: "dictationAgentRemoteUrl",
      customApiKey: "dictationAgentCustomApiKey",
      disableThinking: "dictationAgentDisableThinking",
    },
  },
  // Optional override used only when a voice-agent request carries a screen
  // context screenshot. Unset fields resolve to the dictationAgent scope, and
  // the UI offers only cloud/BYOK modes, so remoteUrl is deliberately absent.
  dictationAgentVision: {
    cloudPurpose: "assistant",
    storeKeys: {
      mode: "dictationAgentVisionMode",
      provider: "dictationAgentVisionProvider",
      model: "dictationAgentVisionModel",
      cloudMode: "dictationAgentVisionCloudMode",
      cloudBaseUrl: "dictationAgentVisionCloudBaseUrl",
      customApiKey: "dictationAgentVisionCustomApiKey",
      disableThinking: "dictationAgentVisionDisableThinking",
    },
    fallbackScope: "dictationAgent",
    optional: true,
  },
  noteFormatting: {
    cloudPurpose: "noteFormatting",
    storeKeys: {
      mode: "noteFormattingMode",
      provider: "noteFormattingProvider",
      model: "noteFormattingModel",
      cloudMode: "noteFormattingCloudMode",
      cloudBaseUrl: "noteFormattingCloudBaseUrl",
      remoteUrl: "noteFormattingRemoteUrl",
      customApiKey: "noteFormattingCustomApiKey",
      disableThinking: "noteFormattingDisableThinking",
    },
    fallbackScope: "dictationCleanup",
  },
  // Runs typed chat conversations (Control Panel, note and container chat).
  // The voice assistant panel's spoken commands, like selection edits, run on
  // dictationAgent(Vision) — see resolveChatStreamingInference.
  chatIntelligence: {
    cloudPurpose: "assistant",
    storeKeys: {
      mode: "chatAgentMode",
      provider: "chatAgentProvider",
      model: "chatAgentModel",
      cloudMode: "chatAgentCloudMode",
      cloudBaseUrl: "chatAgentCloudBaseUrl",
      remoteUrl: "chatAgentRemoteUrl",
      customApiKey: "chatAgentCustomApiKey",
      disableThinking: "chatAgentDisableThinking",
    },
  },
  dictationTranslation: {
    cloudPurpose: "translation",
    storeKeys: {
      mode: "translationMode",
      provider: "translationProvider",
      model: "translationModel",
      cloudMode: "translationCloudMode",
      cloudBaseUrl: "translationCloudBaseUrl",
      remoteUrl: "translationRemoteUrl",
      customApiKey: "translationCustomApiKey",
      disableThinking: "translationDisableThinking",
    },
  },
} as const satisfies Record<string, InferenceScopeDefinition>;

export type InferenceScope = keyof typeof INFERENCE_SCOPES;
