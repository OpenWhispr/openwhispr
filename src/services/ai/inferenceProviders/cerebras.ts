import type { InferenceProvider } from "./types";
import { API_ENDPOINTS, buildApiUrl } from "../../../config/constants";
import logger from "../../../utils/logger";

export const cerebrasProvider: InferenceProvider = {
  id: "cerebras",
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("CEREBRAS_START", { model, agentName });
    const apiKey = await ctx.getApiKey("cerebras");
    const endpoint = buildApiUrl(API_ENDPOINTS.CEREBRAS_BASE, "/chat/completions");
    return ctx.callChatCompletionsApi(
      endpoint,
      apiKey,
      model,
      text,
      agentName,
      config,
      "Cerebras"
    );
  },
};
