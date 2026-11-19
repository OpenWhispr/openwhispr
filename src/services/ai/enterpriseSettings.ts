import i18n from "../../i18n";
import { getSettings, LLM_ENTERPRISE_POLICY_PROVIDER_IDS } from "../../stores/settingsStore";
import { usePolicyStore } from "../../stores/policyStore";
import type { EnterpriseProvider } from "../../models/ModelRegistry";
import type { InferenceScope } from "../../config/inferenceScopes";
import type { ManagedEnterpriseRequestContext } from "../../types/enterpriseIdentity";
import {
  getManagedScopeResolution,
  useEnterpriseIdentityStore,
} from "../../stores/enterpriseIdentityStore";

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
};

export function getEnterpriseCallSettings(
  provider: EnterpriseProvider,
  inferenceScope: InferenceScope
): EnterpriseCallSettings {
  const s = getSettings();
  const managedState = useEnterpriseIdentityStore.getState();
  const resolution = getManagedScopeResolution(inferenceScope, s.enterpriseSetupMode);
  if (resolution.kind === "error") {
    throw Object.assign(new Error(resolution.message), {
      code: resolution.code,
      messageKey: resolution.messageKey,
    });
  }
  // A saved personal provider must not run when the managed desktop picker cannot offer it.
  if (
    resolution.kind !== "managed" &&
    usePolicyStore.getState().status === "managed" &&
    !LLM_ENTERPRISE_POLICY_PROVIDER_IDS.some((supportedId) => supportedId === provider)
  ) {
    throw Object.assign(new Error(i18n.t("common.policyAiProcessingRestricted")), {
      code: "POLICY_RESTRICTED",
      messageKey: "common.policyAiProcessingRestricted",
    });
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
  };
}
