import type { InferenceProvider } from "./types";
import { withRetry, createApiRetryStrategy } from "../../../utils/retry";
import { API_ENDPOINTS, TOKEN_LIMITS } from "../../../config/constants";
import logger from "../../../utils/logger";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { totalTokenCount?: number };
}

export const geminiProvider: InferenceProvider = {
  id: "gemini",
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("GEMINI_START", { model, agentName, hasApiKey: false });
    const apiKey = await ctx.getApiKey("gemini");
    logger.logReasoning("GEMINI_API_KEY", { hasApiKey: !!apiKey, keyLength: apiKey?.length || 0 });

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName, text);

    const requestBody = {
      contents: [{ parts: [{ text: `${systemPrompt}\n\n${text}` }] }],
      generationConfig: {
        temperature: config.temperature || 0.3,
        maxOutputTokens:
          config.maxTokens ||
          Math.max(
            2000,
            ctx.calculateMaxTokens(
              text.length,
              TOKEN_LIMITS.MIN_TOKENS_GEMINI,
              TOKEN_LIMITS.MAX_TOKENS_GEMINI,
              TOKEN_LIMITS.TOKEN_MULTIPLIER
            )
          ),
      },
    };

    const response = await withRetry(async () => {
      logger.logReasoning("GEMINI_REQUEST", {
        endpoint: `${API_ENDPOINTS.GEMINI}/models/${model}:generateContent`,
        model,
        hasApiKey: !!apiKey,
        requestBody: JSON.stringify(requestBody).substring(0, 200),
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch(`${API_ENDPOINTS.GEMINI}/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errorText = await res.text();
          let errorData: { error?: { message?: string } | string; message?: string } = {
            error: res.statusText,
          };
          try {
            errorData = JSON.parse(errorText);
          } catch {
            errorData = { error: errorText || res.statusText };
          }

          logger.logReasoning("GEMINI_API_ERROR_DETAIL", {
            status: res.status,
            statusText: res.statusText,
            error: errorData,
            fullResponse: errorText.substring(0, 500),
          });

          const errMsg =
            (typeof errorData.error === "object" && errorData.error?.message) ||
            errorData.message ||
            (typeof errorData.error === "string" ? errorData.error : null) ||
            `Gemini API error: ${res.status}`;
          throw new Error(errMsg);
        }

        const jsonResponse = (await res.json()) as GeminiResponse;
        logger.logReasoning("GEMINI_RAW_RESPONSE", {
          hasResponse: !!jsonResponse,
          hasCandidates: !!jsonResponse?.candidates,
          candidatesLength: jsonResponse?.candidates?.length || 0,
        });
        return jsonResponse;
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          throw new Error("Request timed out after 30s");
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    }, createApiRetryStrategy());

    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts?.[0]?.text) {
      logger.logReasoning("GEMINI_EMPTY_RESPONSE", {
        model,
        finishReason: candidate?.finishReason,
      });
      if (candidate?.finishReason === "MAX_TOKENS") {
        throw new Error(
          "Gemini reached token limit before generating response. Try a shorter input or increase max tokens."
        );
      }
      throw new Error("Gemini returned empty response");
    }

    const responseText = candidate.content.parts[0].text!.trim();
    logger.logReasoning("GEMINI_RESPONSE", {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usageMetadata?.totalTokenCount || 0,
      success: true,
    });
    return responseText;
  },
};
