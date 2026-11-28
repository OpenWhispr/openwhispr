import i18n from "../../../i18n";
import { wrapCleanupTranscript } from "../../../config/prompts";
import { requestSignal } from "../requestCancellation";
import type { InferenceProvider } from "./types";

export const aiPassProvider: InferenceProvider = {
  id: "aipass",
  async call({ text, model, agentName, config, ctx }) {
    const id = config.requestId;
    const api = window.electronAPI;
    if (
      config.inferenceScope !== "dictationCleanup" ||
      config.requiresAgent ||
      !id ||
      !api?.runAiPassCleanup
    ) {
      throw new Error(i18n.t("settingsPage.aiModels.aiPass.error"));
    }

    const signal = requestSignal(id);
    const cancel = () => api.cancelAiPassCleanup?.(id);
    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await api.runAiPassCleanup(id, {
        model,
        system: config.systemPrompt || ctx.getSystemPrompt(agentName, config.toneStyle),
        user: config.systemPrompt ? text : wrapCleanupTranscript(text),
      });
      if (!result.ok) throw new Error(i18n.t("settingsPage.aiModels.aiPass.error"));
      return result.data;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  },
};
