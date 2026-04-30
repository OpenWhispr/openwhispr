import { API_ENDPOINTS, normalizeBaseUrl } from "../../config/constants";
import { getSettings } from "../../stores/settingsStore";
import { isSecureEndpoint } from "../../utils/urlUtils";
import logger from "../../utils/logger";

export function getConfiguredOpenAIBase(): string {
  if (typeof window === "undefined") {
    return API_ENDPOINTS.OPENAI_BASE;
  }

  try {
    const settings = getSettings();
    const provider = settings.cleanupProvider || "";
    const isCustomProvider = provider === "custom";

    if (!isCustomProvider) {
      logger.logReasoning("CUSTOM_CLEANUP_ENDPOINT_CHECK", {
        hasCustomUrl: false,
        provider,
        reason: "Provider is not 'custom', using default OpenAI endpoint",
        defaultEndpoint: API_ENDPOINTS.OPENAI_BASE,
      });
      return API_ENDPOINTS.OPENAI_BASE;
    }

    const stored = settings.cleanupCloudBaseUrl || "";
    const trimmed = stored.trim();

    if (!trimmed) {
      logger.logReasoning("CUSTOM_CLEANUP_ENDPOINT_CHECK", {
        hasCustomUrl: false,
        provider,
        usingDefault: true,
        defaultEndpoint: API_ENDPOINTS.OPENAI_BASE,
      });
      return API_ENDPOINTS.OPENAI_BASE;
    }

    const normalized = normalizeBaseUrl(trimmed) || API_ENDPOINTS.OPENAI_BASE;

    logger.logReasoning("CUSTOM_CLEANUP_ENDPOINT_CHECK", {
      hasCustomUrl: true,
      provider,
      rawUrl: trimmed,
      normalizedUrl: normalized,
      defaultEndpoint: API_ENDPOINTS.OPENAI_BASE,
    });

    const knownNonOpenAIUrls = [
      "api.groq.com",
      "api.anthropic.com",
      "generativelanguage.googleapis.com",
    ];

    const isKnownNonOpenAI = knownNonOpenAIUrls.some((url) => normalized.includes(url));
    if (isKnownNonOpenAI) {
      logger.logReasoning("OPENAI_BASE_REJECTED", {
        reason: "Custom URL is a known non-OpenAI provider, using default OpenAI endpoint",
        attempted: normalized,
      });
      return API_ENDPOINTS.OPENAI_BASE;
    }

    if (!isSecureEndpoint(normalized)) {
      logger.logReasoning("OPENAI_BASE_REJECTED", {
        reason: "HTTPS required (HTTP allowed for local network only)",
        attempted: normalized,
      });
      return API_ENDPOINTS.OPENAI_BASE;
    }

    logger.logReasoning("CUSTOM_CLEANUP_ENDPOINT_RESOLVED", {
      customEndpoint: normalized,
      isCustom: true,
      provider,
    });

    return normalized;
  } catch (error) {
    logger.logReasoning("CUSTOM_CLEANUP_ENDPOINT_ERROR", {
      error: (error as Error).message,
      fallbackTo: API_ENDPOINTS.OPENAI_BASE,
    });
    return API_ENDPOINTS.OPENAI_BASE;
  }
}
