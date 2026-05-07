import type { InferenceProvider } from "./types";
import { buildApiUrl, ensureV1Suffix } from "../../../config/constants";
import { getSettings } from "../../../stores/settingsStore";
import logger from "../../../utils/logger";

export const lanProvider: InferenceProvider = {
  id: "lan",
  async call({ text, model, agentName, config, ctx }) {
    const lanUrl = (config.lanUrl || getSettings().cleanupRemoteUrl).trim();
    logger.logReasoning("LAN_START", { url: lanUrl, agentName, model });

    try {
      const baseUrl = ensureV1Suffix(lanUrl);
      const endpoint = buildApiUrl(baseUrl, "/chat/completions");
      const apiKey = config.customApiKey?.trim() || getSettings().cleanupCustomApiKey?.trim() || "";
      const resolvedModel = model?.trim() || "default";
      return await ctx.callChatCompletionsApi(
        endpoint,
        apiKey,
        resolvedModel,
        text,
        agentName,
        config,
        "LAN"
      );
    } catch (error) {
      logger.logReasoning("LAN_ERROR", {
        url: lanUrl,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    }
  },
};
