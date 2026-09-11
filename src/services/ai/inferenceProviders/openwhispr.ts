import type { InferenceProvider } from "./types";
import type { InferenceScope } from "../../../config/inferenceScopes";
import type { CloudReasonPurpose } from "../../../types/electron";
import { withSessionRefresh } from "../../../lib/auth";
import { getSettings } from "../../../stores/settingsStore";
import logger from "../../../utils/logger";

const PURPOSE_BY_SCOPE: Record<InferenceScope, CloudReasonPurpose> = {
  dictationCleanup: "cleanup",
  dictationAgent: "assistant",
  dictationAgentVision: "assistant",
  chatIntelligence: "assistant",
  dictationTranslation: "translation",
  noteFormatting: "noteFormatting",
};

export const openwhisprProvider: InferenceProvider = {
  id: "openwhispr",
  supportsImages: true,
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("OPENWHISPR_START", {
      model,
      agentName,
      hasScreenContext: !!config.screenContext,
    });

    const customPrompt = config.systemPrompt
      ? undefined
      : getSettings().customPrompts.cleanup || undefined;

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
        purpose: config.inferenceScope ? PURPOSE_BY_SCOPE[config.inferenceScope] : undefined,
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
