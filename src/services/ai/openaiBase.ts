import { API_ENDPOINTS, ensureV1Suffix } from "../../config/constants";
import { usePolicyStore } from "../../stores/policyStore";
import { getSettings } from "../../stores/settingsStore";
import { isSecureHttpEndpoint } from "../../utils/urlUtils";
import logger from "../../utils/logger";
import i18n from "../../i18n";

// Never falls back: rerouting an invalid Custom endpoint to api.openai.com
// would send the prompt and the custom API key to a host the user never chose.
function invalidCustomEndpoint(reason: string, attempted?: string): never {
  logger.logReasoning("OPENAI_BASE_REJECTED", { reason, attempted });

  const policyStatus = usePolicyStore.getState().status;
  if (policyStatus !== "idle" && policyStatus !== "unmanaged") {
    throw Object.assign(new Error(i18n.t("common.policyAiProcessingRestricted")), {
      code: "POLICY_RESTRICTED",
    });
  }
  throw Object.assign(new Error(i18n.t("reasoning.custom.endpointInvalid")), {
    code: "CUSTOM_ENDPOINT_INVALID",
  });
}

export function resolveConfiguredOpenAIBase(provider: string, configuredBaseUrl?: string): string {
  if (provider !== "custom") return API_ENDPOINTS.OPENAI_BASE;

  const trimmed = configuredBaseUrl?.trim() ?? "";
  if (!trimmed) {
    return invalidCustomEndpoint("Custom endpoint is not configured");
  }

  const normalized = ensureV1Suffix(trimmed);
  if (!normalized) {
    return invalidCustomEndpoint("Custom endpoint could not be normalized", trimmed);
  }

  const knownNonOpenAIUrls = [
    "api.groq.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    // Tinfoil must go through its attested SDK client, never a plain fetch.
    "tinfoil.sh",
  ];
  if (knownNonOpenAIUrls.some((url) => normalized.includes(url))) {
    return invalidCustomEndpoint("Custom URL is a known non-OpenAI provider", normalized);
  }

  if (!isSecureHttpEndpoint(normalized)) {
    return invalidCustomEndpoint(
      "HTTPS required (HTTP allowed for local network only)",
      normalized
    );
  }

  logger.logReasoning("CUSTOM_CLEANUP_ENDPOINT_RESOLVED", {
    customEndpoint: normalized,
    isCustom: true,
    provider,
  });

  return normalized;
}

// The shared "custom" key slot belongs to Dictation Cleanup's endpoint. Only a
// request bound for that same endpoint may borrow it — attaching it to another
// scope's endpoint would send the credential to a host it was never entered for.
export function canBorrowCleanupCustomKey(requestBaseUrl: string | undefined): boolean {
  const cleanupBase = getSettings().cleanupCloudBaseUrl?.trim();
  const requestBase = requestBaseUrl?.trim();
  return !!requestBase && requestBase === cleanupBase;
}

export function resolveSelfHostedOpenAIBase(configuredBaseUrl: string): string {
  const normalized = ensureV1Suffix(configuredBaseUrl.trim());
  if (!normalized || !isSecureHttpEndpoint(normalized)) {
    throw new Error(i18n.t("reasoning.custom.httpsRequired"));
  }

  return normalized;
}
