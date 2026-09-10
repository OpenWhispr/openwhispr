import type { InferenceProvider } from "./types";
import { withSessionRefresh } from "../../../lib/auth";
import { appendVoiceModeSuffix, getDefaultPromptText } from "../../../config/prompts";
import { getSettings } from "../../../stores/settingsStore";
import logger from "../../../utils/logger";

export const openwhisprProvider: InferenceProvider = {
  id: "openwhispr",
  supportsImages: true,
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("OPENWHISPR_START", {
      model,
      agentName,
      hasScreenContext: !!config.screenContext,
    });

    // The server builds the cleanup prompt unless a custom one is sent, so a
    // voice mode rides in as a custom prompt on top of the user's template or
    // the shipped default ({{agentName}} is substituted server-side).
    const cleanupTemplate = getSettings().customPrompts.cleanup || undefined;
    const customPrompt = config.systemPrompt
      ? undefined
      : config.voiceMode
        ? appendVoiceModeSuffix(
            cleanupTemplate ?? getDefaultPromptText("cleanup", ctx.getUiLanguage()),
            config.voiceMode,
            ctx.getUiLanguage()
          )
        : cleanupTemplate;

    // "agent" only rides with a screenshot (which already requires the new
    // API) — older servers reject unknown promptMode values, so plain agent
    // requests omit it. Explicit "cleanup" stops the server flipping to the
    // action prompt on an agent-name mention. Distinct from requestPurpose,
    // which declares intent for org-policy enforcement.
    const promptMode = config.systemPrompt
      ? config.screenContext
        ? "agent"
        : undefined
      : "cleanup";

    const result = await withSessionRefresh(async () => {
      const res = await window.electronAPI?.cloudReason?.(text, {
        agentName,
        customDictionary: ctx.getCustomDictionary(),
        customPrompt,
        systemPrompt: config.systemPrompt,
        requestPurpose: config.requiresAgent ? "agent" : undefined,
        promptMode,
        screenContext: config.screenContext,
        language: config.language || ctx.getPreferredLanguage(),
        locale: ctx.getUiLanguage(),
      });

      if (!res?.success) {
        const err: Error & { code?: string } = new Error(
          res?.error || "OpenWhispr cloud reasoning failed"
        );
        err.code = res?.code;
        throw err;
      }

      return res;
    });

    logger.logReasoning("OPENWHISPR_SUCCESS", {
      model: result.model,
      provider: result.provider,
      resultLength: result.text.length,
      promptMode: result.promptMode,
      matchType: result.matchType,
      screenContextApplied: result.screenContextApplied,
    });

    return result.text;
  },
};
