import type { InferenceProvider } from "./types";
import {
  getOpenAiApiConfig,
  isEnterpriseProvider,
  type EnterpriseProvider as EnterpriseProviderId,
} from "../../../models/ModelRegistry";
import { getSettings } from "../../../stores/settingsStore";
import logger from "../../../utils/logger";

export const enterpriseProvider: InferenceProvider = {
  id: "enterprise",
  async call({ text, model, agentName, config, ctx }) {
    if (typeof window === "undefined" || !window.electronAPI) {
      throw new Error("Enterprise reasoning is not available in this environment");
    }

    const provider = getSettings().cleanupProvider;
    if (!isEnterpriseProvider(provider)) {
      throw new Error(`Unsupported enterprise provider: ${provider}`);
    }
    const enterpriseId = provider as EnterpriseProviderId;

    logger.logReasoning("ENTERPRISE_START", { provider: enterpriseId, model, agentName });

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName, text);
    const s = getSettings();
    const apiKey =
      enterpriseId === "azure" ? s.azureApiKey : enterpriseId === "vertex" ? s.vertexApiKey : "";
    const { supportsTemperature } = getOpenAiApiConfig(model);

    const startTime = Date.now();
    const result = await window.electronAPI.processEnterpriseReasoning(text, model, agentName, {
      ...config,
      systemPrompt,
      provider: enterpriseId,
      apiKey,
      supportsTemperature,
      bedrockRegion: s.bedrockRegion,
      bedrockProfile: s.bedrockProfile,
      bedrockAccessKeyId: s.bedrockAccessKeyId,
      bedrockSecretAccessKey: s.bedrockSecretAccessKey,
      bedrockSessionToken: s.bedrockSessionToken,
      azureEndpoint: s.azureEndpoint,
      azureApiVersion: s.azureApiVersion,
      vertexProject: s.vertexProject,
      vertexLocation: s.vertexLocation,
    });

    const processingTimeMs = Date.now() - startTime;

    if (!result.success) {
      logger.logReasoning("ENTERPRISE_ERROR", {
        provider: enterpriseId,
        model,
        processingTimeMs,
        error: result.error,
      });
      const enhanced = new Error(result.error || `${enterpriseId} reasoning failed`) as Error & {
        retryable?: boolean;
      };
      enhanced.retryable = result.retryable ?? false;
      throw enhanced;
    }

    logger.logReasoning("ENTERPRISE_SUCCESS", {
      provider: enterpriseId,
      model,
      processingTimeMs,
      resultLength: result.text?.length || 0,
    });
    return result.text || "";
  },
};
