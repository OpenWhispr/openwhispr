import type { InferenceProvider } from "./types";
import { TOKEN_LIMITS } from "../../../config/constants";
import { getOpenAiApiConfig } from "../../../models/ModelRegistry";
import { withRetry, createApiRetryStrategy } from "../../../utils/retry";
import logger from "../../../utils/logger";
import { applyThinkingSuppression } from "../thinkingSuppression";
import { getTinfoilChatClient } from "../tinfoilClient";

export const tinfoilProvider: InferenceProvider = {
  id: "tinfoil",
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("TINFOIL_START", { model, agentName });

    const apiKey = await ctx.getApiKey("tinfoil");
    const client = await getTinfoilChatClient(apiKey);

    const verification = await client.getVerificationDocument();
    if (!verification.securityVerified) {
      throw new Error("Tinfoil enclave verification failed");
    }

    logger.logReasoning("TINFOIL_VERIFIED", {
      model,
      enclaveHost: verification.enclaveHost,
      configRepo: verification.configRepo,
      selectedRouterEndpoint: verification.selectedRouterEndpoint,
    });

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ];

    const apiConfig = getOpenAiApiConfig(model);
    const maxTokens =
      config.maxTokens ||
      Math.max(
        4096,
        ctx.calculateMaxTokens(
          text.length,
          TOKEN_LIMITS.MIN_TOKENS,
          TOKEN_LIMITS.MAX_TOKENS,
          TOKEN_LIMITS.TOKEN_MULTIPLIER
        )
      );

    const requestBody: Record<string, unknown> = {
      model,
      messages,
      [apiConfig.tokenParam]: maxTokens,
    };

    if (apiConfig.supportsTemperature) {
      requestBody.temperature = config.temperature ?? 0.3;
    }

    applyThinkingSuppression(requestBody, model, "tinfoil", config);

    const response = await withRetry(
      () => client.chat.completions.create(requestBody as any),
      createApiRetryStrategy()
    );

    const responseText =
      response.choices
        ?.map((choice: any) => choice?.message?.content)
        .find((content: unknown) => typeof content === "string" && content.trim())
        ?.trim() || "";

    logger.logReasoning("TINFOIL_RESPONSE", {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usage?.total_tokens || 0,
      success: true,
      isEmpty: responseText.length === 0,
    });

    if (!responseText) {
      logger.logReasoning("TINFOIL_EMPTY_RESPONSE_FALLBACK", {
        model,
        originalTextLength: text.length,
      });
      return text;
    }

    return responseText;
  },
};
