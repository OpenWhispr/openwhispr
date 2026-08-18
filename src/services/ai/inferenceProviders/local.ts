import type { InferenceProvider } from "./types";
import { wrapCleanupTranscript } from "../../../config/prompts";
import { applyChatCompletionsParams } from "../chatRequestBody";
import logger from "../../../utils/logger";

export const localProvider: InferenceProvider = {
  id: "local",
  async call({ text, model, agentName, config, ctx }) {
    if (typeof window === "undefined" || !window.electronAPI) {
      throw new Error("Local reasoning is not available in this environment");
    }

    logger.logReasoning("LOCAL_START", { model, agentName, environment: "browser" });
    const startTime = Date.now();

    logger.logReasoning("LOCAL_IPC_CALL", { model, textLength: text.length });

    // Shape the tunables here, against the caller's config, so local models get
    // the same per-family and per-model facts as every other provider — the
    // main-process bridge forwards `params` verbatim and never decides sampling.
    // Must run before the systemPrompt merge below: the merged config always
    // carries a prompt, which would make every call look like an agent call
    // (0.3) and cleanup would never get its deterministic 0. An absent
    // maxTokens is left to the bridge's length-based fallback.
    const params: Record<string, unknown> = {};
    applyChatCompletionsParams(params, {
      model,
      provider: "local",
      config,
      maxTokens: config.maxTokens,
    });

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);
    const result = await window.electronAPI.processLocalReasoning(userContent, model, agentName, {
      ...config,
      systemPrompt,
      params,
    });

    const processingTimeMs = Date.now() - startTime;

    if (!result.success) {
      logger.logReasoning("LOCAL_ERROR", { model, processingTimeMs, error: result.error });
      throw new Error(result.error);
    }

    logger.logReasoning("LOCAL_SUCCESS", {
      model,
      processingTimeMs,
      resultLength: result.text.length,
    });
    return result.text;
  },
};
