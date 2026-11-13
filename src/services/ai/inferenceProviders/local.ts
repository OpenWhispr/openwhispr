import type { InferenceProvider } from "./types";
import { wrapCleanupTranscript } from "../../../config/prompts";
import { getCleanupPromptProfile, runProfiledCleanup } from "../../../config/cleanupPromptProfiles";
import { useSettingsStore } from "../../../stores/settingsStore";
import logger from "../../../utils/logger";
import { buildLocalInferenceError } from "../../../utils/localInferenceError";

export const localProvider: InferenceProvider = {
  id: "local",
  async call({ text, model, agentName, config, ctx }) {
    if (typeof window === "undefined" || !window.electronAPI) {
      throw new Error("Local reasoning is not available in this environment");
    }

    logger.logReasoning("LOCAL_START", { model, agentName, environment: "browser" });
    const startTime = Date.now();

    logger.logReasoning("LOCAL_IPC_CALL", { model, textLength: text.length });

    // A fine-tune with its own request shape replaces the shared cleanup prompt
    // and wrapper for default dictation cleanup; see cleanupPromptProfiles.ts.
    const profile = getCleanupPromptProfile(model, {
      ...config,
      hasCustomCleanupPrompt: !!useSettingsStore.getState().customPrompts.cleanup,
    });
    if (profile) {
      let parts = 0;
      const cleaned = await runProfiledCleanup(profile, text, async (userContent) => {
        parts++;
        const part = await window.electronAPI.processLocalReasoning(userContent, model, agentName, {
          ...config,
          systemPrompt: profile.systemPrompt,
          temperature: profile.temperature,
          disableThinking: true,
        });
        if (!part.success) {
          logger.logReasoning("LOCAL_ERROR", { model, part: parts, error: part.error });
          throw buildLocalInferenceError(part);
        }
        return part.text;
      });
      logger.logReasoning("LOCAL_SUCCESS", {
        model,
        promptProfile: true,
        parts,
        processingTimeMs: Date.now() - startTime,
        resultLength: cleaned.length,
      });
      return cleaned;
    }

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName, config.toneStyle);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);
    const result = await window.electronAPI.processLocalReasoning(userContent, model, agentName, {
      ...config,
      systemPrompt,
    });

    const processingTimeMs = Date.now() - startTime;

    if (!result.success) {
      logger.logReasoning("LOCAL_ERROR", { model, processingTimeMs, error: result.error });
      throw buildLocalInferenceError(result);
    }

    logger.logReasoning("LOCAL_SUCCESS", {
      model,
      processingTimeMs,
      resultLength: result.text.length,
    });
    return result.text;
  },
};
