import type { InferenceProvider } from "./types";
import { buildApiUrl } from "../../../config/constants";
import logger from "../../../utils/logger";

export const litellmProvider: InferenceProvider = {
  id: "litellm",
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("LITELLM_START", { model, agentName });
    const apiKey = await ctx.getApiKey("litellm");
    const baseUrl = config.baseUrl?.trim() || "http://localhost:4000/v1";
    const endpoint = buildApiUrl(baseUrl, "/chat/completions");
    return ctx.callChatCompletionsApi(endpoint, apiKey, model, text, agentName, config, "LiteLLM");
  },
};
