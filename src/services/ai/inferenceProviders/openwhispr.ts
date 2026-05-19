import type { InferenceProvider } from "./types";
import { withSessionRefresh } from "../../../lib/auth";
import { getSettings } from "../../../stores/settingsStore";
import logger from "../../../utils/logger";

export const openwhisprProvider: InferenceProvider = {
  id: "openwhispr",
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("OPENWHISPR_START", { model, agentName });

    const customPrompt = config.systemPrompt
      ? undefined
      : getSettings().customPrompts.cleanup || undefined;

    const result = await withSessionRefresh(async () => {
      const res = await window.electronAPI?.cloudReason?.(text, {
        agentName,
        customDictionary: ctx.getCustomDictionary(),
        customPrompt,
        systemPrompt: config.systemPrompt,
        language: ctx.getPreferredLanguage(),
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
    });

    return result.text;
  },
};
