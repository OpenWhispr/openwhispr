import type { InferenceProvider } from "./types";
import { TOKEN_LIMITS } from "../../../config/constants";
import { withRetry, createApiRetryStrategy } from "../../../utils/retry";
import logger from "../../../utils/logger";
import { applyChatCompletionsParams, isTruncatedFinishReason } from "../chatRequestBody";
import { getTinfoilChatClient } from "../tinfoilClient";
import { getLlmRequestTimeoutSeconds } from "../../../helpers/llmRequestTimeout.js";
import { wrapCleanupTranscript } from "../../../config/prompts";

export const tinfoilProvider: InferenceProvider = {
  id: "tinfoil",
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("TINFOIL_START", { model, agentName });

    const apiKey = await ctx.getApiKey("tinfoil");
    // The client verifies enclave attestation before every request and
    // refuses to send anything over an unverified transport.
    const client = await getTinfoilChatClient(apiKey);

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ];

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

    const requestBody: Record<string, unknown> = { model, messages };
    applyChatCompletionsParams(requestBody, { model, provider: "tinfoil", config, maxTokens });

    // Keep SDK-internal retries off so withRetry stays the single retry layer.
    const timeoutMs = getLlmRequestTimeoutSeconds() * 1000;
    const response = await withRetry(
      () =>
        client.chat.completions.create(requestBody as any, {
          timeout: timeoutMs,
          maxRetries: 0,
        }),
      createApiRetryStrategy()
    );

    const responseText =
      response.choices
        ?.map((choice: any) => choice?.message?.content)
        .find((content: unknown) => typeof content === "string" && content.trim())
        ?.trim() || "";

    if (
      config.requireCompleteOutput &&
      response.choices?.some((choice: any) => isTruncatedFinishReason(choice?.finish_reason))
    ) {
      throw new Error("Model output was truncated before the selection edit completed");
    }

    logger.logReasoning("TINFOIL_RESPONSE", {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usage?.total_tokens || 0,
      success: true,
      isEmpty: responseText.length === 0,
    });

    if (!responseText) {
      if (config.requireCompleteOutput) {
        throw new Error("Model returned an empty selection edit");
      }
      logger.logReasoning("TINFOIL_EMPTY_RESPONSE_FALLBACK", {
        model,
        originalTextLength: text.length,
      });
      return text;
    }

    return responseText;
  },
};
