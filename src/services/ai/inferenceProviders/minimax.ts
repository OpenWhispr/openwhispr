import type { InferenceProvider } from "./types";
import { API_ENDPOINTS, buildApiUrl } from "../../../config/constants";
import logger from "../../../utils/logger";

export const minimaxProvider: InferenceProvider = {
  id: "minimax",
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("MINIMAX_START", { model, agentName });
    const apiKey = await ctx.getApiKey("minimax");
    const endpoint = buildApiUrl(API_ENDPOINTS.MINIMAX_BASE, "/chat/completions");
    return ctx.callChatCompletionsApi(endpoint, apiKey, model, text, agentName, config, "MiniMax");
  },
};
