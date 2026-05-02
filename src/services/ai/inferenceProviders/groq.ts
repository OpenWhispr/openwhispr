import type { InferenceProvider } from "./types";
import { API_ENDPOINTS, buildApiUrl } from "../../../config/constants";
import logger from "../../../utils/logger";

export const groqProvider: InferenceProvider = {
  id: "groq",
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("GROQ_START", { model, agentName });
    const apiKey = await ctx.getApiKey("groq");
    const endpoint = buildApiUrl(API_ENDPOINTS.GROQ_BASE, "/chat/completions");
    return ctx.callChatCompletionsApi(endpoint, apiKey, model, text, agentName, config, "Groq");
  },
};
