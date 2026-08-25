import type { InferenceProvider } from "./types";
import { wrapCleanupTranscript } from "../../../config/prompts";
import logger from "../../../utils/logger";
import { getReasoningStartContext } from "../enterpriseSettings";

export const localProvider: InferenceProvider = {
  id: "local",
  async call({ text, model, agentName, config, ctx }) {
    if (typeof window === "undefined" || !window.electronAPI) {
      throw new Error("Local reasoning is not available in this environment");
    }

    logger.logReasoning("LOCAL_START", { model, agentName, environment: "browser" });
    const startTime = Date.now();

    logger.logReasoning("LOCAL_IPC_CALL", { model, textLength: text.length });

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);
    const start = getReasoningStartContext(config);
    const result = await window.electronAPI.processLocalReasoning(
      userContent,
      model,
      agentName,
      {
        ...config,
        systemPrompt,
        setupMode: start.route.setupMode,
      },
      start.claim
    );

    const processingTimeMs = Date.now() - startTime;

    if (!result.success) {
      logger.logReasoning("LOCAL_ERROR", { model, processingTimeMs, error: result.error });
      throw Object.assign(new Error(result.error), { code: result.code });
    }

    logger.logReasoning("LOCAL_SUCCESS", {
      model,
      processingTimeMs,
      resultLength: result.text.length,
    });
    return result.text;
  },
};
