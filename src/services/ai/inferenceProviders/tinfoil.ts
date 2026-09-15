import type { InferenceProvider } from "./types";
import { TOKEN_LIMITS } from "../../../config/constants";
import { withRetry, createApiRetryStrategy } from "../../../utils/retry";
import logger from "../../../utils/logger";
import {
  applyChatCompletionsParams,
  emptyResponseError,
  isTruncatedFinishReason,
  truncatedOutputError,
} from "../chatRequestBody";
import { getTinfoilChatClient } from "../tinfoilClient";
import {
  getLlmRequestTimeoutSeconds,
  llmRequestTimeoutError,
} from "../../../helpers/llmRequestTimeout.js";
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
    const timeoutSeconds = getLlmRequestTimeoutSeconds({ scope: config.inferenceScope });
    const response = await withRetry(async () => {
      try {
        return await client.chat.completions.create(requestBody as any, {
          timeout: timeoutSeconds * 1000,
          maxRetries: 0,
        });
      } catch (error) {
        // The SDK reports an expired deadline as a connection error, which
        // withRetry would otherwise treat as a network drop and re-send.
        if ((error as Error).name === "APIConnectionTimeoutError") {
          throw llmRequestTimeoutError(timeoutSeconds);
        }
        throw error;
      }
    }, createApiRetryStrategy());

    const responseText =
      response.choices
        ?.map((choice: any) => choice?.message?.content)
        .find((content: unknown) => typeof content === "string" && content.trim())
        ?.trim() || "";

    const responseIncomplete = response.choices?.some((choice: any) =>
      isTruncatedFinishReason(choice?.finish_reason)
    );
    if (config.requireCompleteOutput && responseIncomplete) {
      throw truncatedOutputError();
    }

    logger.logReasoning("TINFOIL_RESPONSE", {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usage?.total_tokens || 0,
      success: true,
      isEmpty: responseText.length === 0,
    });

    if (!responseText) {
      const error = emptyResponseError("Tinfoil", config, !!responseIncomplete);
      if (error) throw error;
      logger.logReasoning("TINFOIL_EMPTY_RESPONSE_FALLBACK", {
        model,
        originalTextLength: text.length,
      });
      return text;
    }

    return responseText;
  },
};
