import type { InferenceProvider } from "./types";
import { buildApiUrl, normalizeBaseUrl } from "../../../config/constants";
import { getSettings } from "../../../stores/settingsStore";
import logger from "../../../utils/logger";

export const lanProvider: InferenceProvider = {
  id: "lan",
  async call({ text, agentName, config, ctx }) {
    const lanUrl = (config.lanUrl || getSettings().remoteReasoningUrl).trim();
    logger.logReasoning("LAN_START", { url: lanUrl, agentName });

    try {
      const baseUrl = normalizeBaseUrl(lanUrl) || lanUrl;
      const endpoint = buildApiUrl(baseUrl, "/v1/chat/completions");
      return await ctx.callChatCompletionsApi(
        endpoint,
        "",
        "default",
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
