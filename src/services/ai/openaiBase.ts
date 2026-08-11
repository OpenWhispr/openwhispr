import { API_ENDPOINTS, ensureV1Suffix } from "../../config/constants";
import { usePolicyStore } from "../../stores/policyStore";
import { isSecureHttpEndpoint } from "../../utils/urlUtils";
import logger from "../../utils/logger";
import i18n from "../../i18n";

function invalidCustomEndpoint(reason: string, attempted?: string): string {
  const policyStatus = usePolicyStore.getState().status;
  if (policyStatus !== "idle" && policyStatus !== "unmanaged") {
    throw Object.assign(new Error(i18n.t("common.policyAiProcessingRestricted")), {
      code: "POLICY_RESTRICTED",
    });
  }

  logger.logReasoning("OPENAI_BASE_REJECTED", {
    reason,
    attempted,
    fallbackTo: API_ENDPOINTS.OPENAI_BASE,
  });
  return API_ENDPOINTS.OPENAI_BASE;
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

export function resolveSelfHostedOpenAIBase(configuredBaseUrl: string): string {
  const normalized = ensureV1Suffix(configuredBaseUrl.trim());
  if (!normalized || !isSecureHttpEndpoint(normalized)) {
    throw new Error(i18n.t("reasoning.custom.httpsRequired"));
  }

  return normalized;
}
