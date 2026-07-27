import logger from "@/utils/logger";
import { InferenceProvider } from "./types";
import { API_ENDPOINTS, buildApiUrl } from "../../../config/constants";

export const vercelProvider: InferenceProvider = {
  id: "vercel",
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("VERCEL_START", { model, agentName });
    const apiKey = await ctx.getApiKey("vercel");
    const endpoint = buildApiUrl(API_ENDPOINTS.VERCEL_AI_GATEWAY_BASE, "/chat/completions");
    return ctx.callChatCompletionsApi(
      endpoint,
      apiKey,
      model,
      text,
      agentName,
      config,
      "Vercel AI Gateway"
    );
  },
};
