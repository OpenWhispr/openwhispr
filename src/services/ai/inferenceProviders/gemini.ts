import type { InferenceProvider } from "./types";
import { getCloudModel } from "../../../models/ModelRegistry";
import { withRetry, createApiRetryStrategy, httpError } from "../../../utils/retry";
import { API_ENDPOINTS, TOKEN_LIMITS } from "../../../config/constants";
import { wrapCleanupTranscript } from "../../../config/prompts";
import { extractApiErrorMessage } from "../apiErrorMessage";
import logger from "../../../utils/logger";
import {
  assessGeminiResponse,
  resolveGeminiThinkingConfig,
} from "../../../helpers/geminiResponse.js";
import { truncatedResponseError } from "../../../helpers/completionTruncation.js";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

interface GeminiGenerationConfig {
  temperature: number;
  maxOutputTokens: number;
  thinkingConfig?: {
    thinkingLevel: "minimal" | "low" | "medium" | "high";
    includeThoughts: boolean;
  };
}

export const geminiProvider: InferenceProvider = {
  id: "gemini",
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("GEMINI_START", { model, agentName, hasApiKey: false });
    const apiKey = await ctx.getApiKey("gemini");
    logger.logReasoning("GEMINI_API_KEY", { hasApiKey: !!apiKey, keyLength: apiKey?.length || 0 });

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);

    const modelDef = getCloudModel(model);
    const generationConfig: GeminiGenerationConfig = {
      temperature: config.temperature ?? (config.systemPrompt ? 0.3 : 0),
      // Thinking tokens share maxOutputTokens, so thinking-capable models get the full ceiling. See #1341.
      maxOutputTokens:
        config.maxTokens ||
        Math.max(
          modelDef?.supportsThinking ? TOKEN_LIMITS.MAX_TOKENS_GEMINI : 2000,
          ctx.calculateMaxTokens(
            text.length,
            TOKEN_LIMITS.MIN_TOKENS_GEMINI,
            TOKEN_LIMITS.MAX_TOKENS_GEMINI,
            TOKEN_LIMITS.TOKEN_MULTIPLIER
          )
        ),
    };

    const thinkingConfig = resolveGeminiThinkingConfig(config, modelDef);
    if (thinkingConfig) {
      generationConfig.thinkingConfig = thinkingConfig;
    }

    const requestBody = {
      contents: [{ parts: [{ text: `${systemPrompt}\n\n${userContent}` }] }],
      generationConfig,
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

          const errMsg = extractApiErrorMessage(errorData, `Gemini API error: ${res.status}`);
          throw httpError(errMsg, res.status);
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

    const { kind, text: responseText, finishReason, usage } = assessGeminiResponse(response);

    if (kind === "empty" || kind === "empty_token_limit") {
      logger.logReasoning("GEMINI_EMPTY_RESPONSE", {
        model,
        finishReason,
      });
      if (kind === "empty_token_limit") {
        throw new Error(
          "Gemini reached token limit before generating response. Try a shorter input or increase max tokens."
        );
      }
      throw new Error("Gemini returned empty response");
    }

    // A truncated candidate is a reply cut mid-sentence; fail it so the raw transcription survives. See #1341.
    if (kind === "truncated") {
      logger.logReasoning("GEMINI_TRUNCATED_RESPONSE", {
        model,
        finishReason,
        responseLength: responseText.length,
        thoughtsTokenCount: usage.thoughtsTokenCount ?? 0,
        candidatesTokenCount: usage.candidatesTokenCount ?? 0,
        totalTokenCount: usage.totalTokenCount ?? 0,
      });
      throw truncatedResponseError("Gemini");
    }

    logger.logReasoning("GEMINI_RESPONSE", {
      model,
      responseLength: responseText.length,
      tokensUsed: usage.totalTokenCount || 0,
      thoughtsTokenCount: usage.thoughtsTokenCount ?? 0,
      candidatesTokenCount: usage.candidatesTokenCount ?? 0,
      success: true,
    });
    return responseText;
  },
};
