import type { SettingsState } from "../stores/settingsStore";

export interface InferenceScopeStoreKeys {
  mode: keyof SettingsState;
  provider: keyof SettingsState;
  model: keyof SettingsState;
  cloudMode?: keyof SettingsState;
  cloudBaseUrl?: keyof SettingsState;
  remoteType?: keyof SettingsState;
  remoteUrl?: keyof SettingsState;
  customApiKey?: keyof SettingsState;
}

export interface InferenceScopeDefinition {
  storeKeys: InferenceScopeStoreKeys;
  fallbackScope?: string;
}

export const INFERENCE_SCOPES = {
  dictationCleanup: {
    storeKeys: {
      mode: "reasoningMode",
      provider: "reasoningProvider",
      model: "reasoningModel",
      cloudMode: "cloudReasoningMode",
      cloudBaseUrl: "cloudReasoningBaseUrl",
      remoteType: "remoteReasoningType",
      remoteUrl: "remoteReasoningUrl",
      customApiKey: "customReasoningApiKey",
    },
  },
  dictationAgent: {
    storeKeys: {
      mode: "dictationAgentMode",
      provider: "dictationAgentProvider",
      model: "dictationAgentModel",
      cloudMode: "dictationAgentCloudMode",
      cloudBaseUrl: "dictationAgentCloudBaseUrl",
      remoteType: "dictationAgentRemoteType",
      remoteUrl: "dictationAgentRemoteUrl",
      customApiKey: "dictationAgentCustomApiKey",
    },
    fallbackScope: "dictationCleanup",
  },
  noteFormatting: {
    storeKeys: {
      mode: "meetingReasoningMode",
      provider: "meetingReasoningProvider",
      model: "meetingReasoningModel",
      cloudMode: "meetingCloudReasoningMode",
      cloudBaseUrl: "meetingCloudReasoningBaseUrl",
      remoteType: "meetingRemoteReasoningType",
      remoteUrl: "meetingRemoteReasoningUrl",
    },
    fallbackScope: "dictationCleanup",
  },
  chatIntelligence: {
    storeKeys: {
      mode: "agentInferenceMode",
      provider: "agentProvider",
      model: "agentModel",
      cloudMode: "cloudAgentMode",
      remoteUrl: "remoteAgentUrl",
    },
  },
} as const satisfies Record<string, InferenceScopeDefinition>;

export type InferenceScope = keyof typeof INFERENCE_SCOPES;
