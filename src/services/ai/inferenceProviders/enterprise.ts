import type { InferenceProvider } from "./types";
import {
  isEnterpriseProvider,
  supportsTemperature as supportsTemp,
  type EnterpriseProvider as EnterpriseProviderId,
} from "../../../models/ModelRegistry";
import { getSettings } from "../../../stores/settingsStore";
import { getEnterpriseCallSettings } from "../enterpriseSettings";
import { wrapCleanupTranscript } from "../../../config/prompts";
import logger from "../../../utils/logger";

export const enterpriseProvider: InferenceProvider = {
  id: "enterprise",
  async call({ text, model, agentName, config, ctx }) {
    if (typeof window === "undefined" || !window.electronAPI) {
      throw new Error("Enterprise reasoning is not available in this environment");
    }

    const provider = config.provider || getSettings().cleanupProvider;
    if (!isEnterpriseProvider(provider)) {
      throw new Error(`Unsupported enterprise provider: ${provider}`);
    }
    const enterpriseId = provider as EnterpriseProviderId;

    logger.logReasoning("ENTERPRISE_START", { provider: enterpriseId, model, agentName });

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);
    const supportsTemperature = supportsTemp(model);

    const startTime = Date.now();
    const result = await window.electronAPI.processEnterpriseReasoning(
      userContent,
      model,
      agentName,
      {
        ...config,
        systemPrompt,
        provider: enterpriseId,
        supportsTemperature,
        ...getEnterpriseCallSettings(enterpriseId),
      }
    );

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
