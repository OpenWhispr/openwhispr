import type { InferenceProvider } from "./types";
import { appendCleanupSuffixes, wrapCleanupTranscript } from "../../../config/prompts";
import { getCleanupPromptProfile, runProfiledCleanup } from "../../../config/cleanupPromptProfiles";
import { useSettingsStore } from "../../../stores/settingsStore";
import logger from "../../../utils/logger";
import { buildLocalInferenceError } from "../../../utils/localInferenceError";
import { isRequestCancelled } from "../requestCancellation";

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
      const systemPrompt = profile.appendsCleanupSuffixes
        ? appendCleanupSuffixes(profile.systemPrompt, {
            customDictionary: ctx.getCustomDictionary(),
            language: ctx.getPreferredLanguage(),
            uiLanguage: ctx.getUiLanguage(),
            toneStyle: config.toneStyle,
          })
        : profile.systemPrompt;
      const profiledConfig = {
        ...config,
        systemPrompt,
        temperature: profile.temperature,
        disableThinking: true,
      };
      let parts = 0;
      const cleaned = await runProfiledCleanup(
        profile,
        text,
        async (userContent) => {
          parts++;
          const part = await window.electronAPI.processLocalReasoning(
            userContent,
            model,
            agentName,
            profiledConfig
          );
          if (!part.success) {
            logger.logReasoning("LOCAL_ERROR", { model, part: parts, error: part.error });
            throw buildLocalInferenceError(part);
          }
          return part.text;
        },
        // A part cleaned again goes in one call: the bridge refuses a second
        // request while one runs, and the main process runs the pieces together.
        async (userContents) => {
          const batch = await window.electronAPI.processLocalReasoningBatch(
            userContents,
            model,
            agentName,
            profiledConfig
          );
          if (batch.success) {
            return batch.results.map((piece) => (piece.success ? piece.text : null));
          }
          logger.logReasoning("LOCAL_ERROR", {
            model,
            part: parts,
            pieces: userContents.length,
            error: batch.error,
          });
          // A cancelled cleanup stops here, as it does at a failed part; any
          // other failure keeps this part as spoken.
          if (isRequestCancelled(config.requestId)) throw buildLocalInferenceError(batch);
          return null;
        }
      );
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
