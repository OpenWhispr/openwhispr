import i18n from "../../i18n";
import {
  getSettings,
  LLM_ENTERPRISE_POLICY_PROVIDER_IDS,
  type SettingsState,
} from "../../stores/settingsStore";
import { usePolicyStore } from "../../stores/policyStore";
import type { EnterpriseProvider } from "../../models/ModelRegistry";
import type { InferenceScope } from "../../config/inferenceScopes";
import type { ManagedEnterpriseRequestContext } from "../../types/enterpriseIdentity";
import {
  getManagedScopeResolution,
  useEnterpriseIdentityStore,
} from "../../stores/enterpriseIdentityStore";

type ManualEnterpriseCallSettings =
  | Pick<
      SettingsState,
      | "bedrockRegion"
      | "bedrockProfile"
      | "bedrockAccessKeyId"
      | "bedrockSecretAccessKey"
      | "bedrockSessionToken"
    >
  | (Pick<SettingsState, "azureEndpoint" | "azureApiVersion" | "azureApiKey"> & { apiKey: string })
  | (Pick<SettingsState, "vertexProject" | "vertexLocation" | "vertexApiKey"> & { apiKey: string });

export type EnterpriseCallSettings =
  ManualEnterpriseCallSettings | { managedContext: ManagedEnterpriseRequestContext };

export function getManualEnterpriseCallSettings(
  provider: EnterpriseProvider,
  settings: SettingsState
): ManualEnterpriseCallSettings {
  switch (provider) {
    case "bedrock": {
      const useKeys = settings.bedrockAuthMode === "keys";
      return {
        bedrockRegion: settings.bedrockRegion,
        bedrockProfile: settings.bedrockAuthMode === "sso" ? settings.bedrockProfile : "",
        bedrockAccessKeyId: useKeys ? settings.bedrockAccessKeyId : "",
        bedrockSecretAccessKey: useKeys ? settings.bedrockSecretAccessKey : "",
        bedrockSessionToken: useKeys ? settings.bedrockSessionToken : "",
      };
    }
    case "azure":
      return {
        azureEndpoint: settings.azureEndpoint,
        azureApiVersion: settings.azureApiVersion,
        azureApiKey: settings.azureApiKey,
        apiKey: settings.azureApiKey,
      };
    case "vertex": {
      const apiKey = settings.vertexAuthMode === "apikey" ? settings.vertexApiKey : "";
      return {
        vertexProject: settings.vertexProject,
        vertexLocation: settings.vertexLocation,
        vertexApiKey: apiKey,
        apiKey,
      };
    }
  }
}

export function getEnterpriseCallSettings(
  provider: EnterpriseProvider,
  inferenceScope: InferenceScope
): EnterpriseCallSettings {
  const settings = getSettings();
  const resolution = getManagedScopeResolution(inferenceScope, settings.enterpriseSetupMode);
  if (resolution.kind === "error") {
    throw Object.assign(new Error(resolution.message), {
      code: resolution.code,
      messageKey: resolution.messageKey,
    });
  }
  if (resolution.kind !== "managed") {
    // A saved personal provider must not run when the managed desktop picker cannot offer it.
    if (
      usePolicyStore.getState().status === "managed" &&
      !LLM_ENTERPRISE_POLICY_PROVIDER_IDS.some((supportedId) => supportedId === provider)
    ) {
      throw Object.assign(new Error(i18n.t("common.policyAiProcessingRestricted")), {
        code: "POLICY_RESTRICTED",
        messageKey: "common.policyAiProcessingRestricted",
      });
    }
    return getManualEnterpriseCallSettings(provider, settings);
  }
  const managedState = useEnterpriseIdentityStore.getState();
  if (
    !managedState.config ||
    !managedState.accountId ||
    !managedState.workspaceId ||
    managedState.authGeneration == null
  ) {
    throw Object.assign(new Error(i18n.t("common.managedConfigUnavailable")), {
      code: "MANAGED_CONFIG_UNAVAILABLE",
      messageKey: "common.managedConfigUnavailable",
    });
  }
  return {
    managedContext: {
      accountId: managedState.accountId,
      workspaceId: managedState.workspaceId,
      authGeneration: managedState.authGeneration,
      setupMode: settings.enterpriseSetupMode,
      inferenceScope,
      provider: resolution.provider,
      generation: managedState.config.generation,
      providerVersion: resolution.record.version,
    },
  };
}
