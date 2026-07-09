import type { InferenceProvider } from "./types";
import { API_ENDPOINTS, buildApiUrl } from "../../../config/constants";
import logger from "../../../utils/logger";

export const cortiProvider: InferenceProvider = {
  id: "corti",
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("CORTI_START", { model, agentName });
    const apiKey = await ctx.getApiKey("corti");
    const endpoint = buildApiUrl(API_ENDPOINTS.CORTI_MODELS_BASE, "/chat/completions");
    return ctx.callChatCompletionsApi(endpoint, apiKey, model, text, agentName, config, "Corti");
  },
};
