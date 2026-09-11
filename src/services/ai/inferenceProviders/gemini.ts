import type { InferenceProvider } from "./types";
import { withRetry, createApiRetryStrategy, httpError } from "../../../utils/retry";
import { API_ENDPOINTS, TOKEN_LIMITS } from "../../../config/constants";
import { getLlmRequestTimeoutSeconds } from "../../../helpers/llmRequestTimeout.js";
import { extractGeminiText } from "../../../helpers/geminiResponse.js";
import { wrapCleanupTranscript } from "../../../config/prompts";
import { extractApiErrorMessage } from "../apiErrorMessage";
import logger from "../../../utils/logger";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiGenerationConfig {
  temperature: number;
  maxOutputTokens: number;
  thinkingConfig?: {
    thinkingLevel?: "minimal" | "low";
    thinkingBudget?: number;
    includeThoughts: boolean;
  };
}

// Thinking controls differ by model: Pro cannot use minimal, and 2.5 uses budgets.
const minimalThinking: Record<string, GeminiGenerationConfig["thinkingConfig"]> = {
  "gemini-3.5-flash": { thinkingLevel: "minimal", includeThoughts: false },
  "gemini-3.5-flash-lite": { thinkingLevel: "minimal", includeThoughts: false },
  "gemini-3.1-flash-lite": { thinkingLevel: "minimal", includeThoughts: false },
  "gemini-3-flash-preview": { thinkingLevel: "minimal", includeThoughts: false },
  "gemini-3.1-pro-preview": { thinkingLevel: "low", includeThoughts: false },
  "gemini-2.5-flash": { thinkingBudget: 0, includeThoughts: false },
  "gemini-2.5-flash-lite": { thinkingBudget: 0, includeThoughts: false },
  "gemini-2.5-pro": { thinkingBudget: 128, includeThoughts: false },
};

export const geminiProvider: InferenceProvider = {
  id: "gemini",
  supportsImages: true,
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("GEMINI_START", { model, agentName, hasApiKey: false });
    const apiKey = await ctx.getApiKey("gemini");
    logger.logReasoning("GEMINI_API_KEY", { hasApiKey: !!apiKey, keyLength: apiKey?.length || 0 });

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);

    const isGemini = model.startsWith("gemini-");
    const isGemini3 = model.startsWith("gemini-3-") || model.startsWith("gemini-3.");
    const generationConfig: GeminiGenerationConfig = {
      // Google recommends 1.0 for Gemini 3 to avoid low-temperature looping.
      // Cleanup defers here; explicit overrides still win.
      // https://ai.google.dev/gemini-api/docs/gemini-3#temperature
      temperature: config.temperature ?? (isGemini3 ? 1 : config.systemPrompt ? 0.3 : 0),
      // This cap includes thoughts. Leave headroom and scale for long transcripts.
      maxOutputTokens:
        config.maxTokens ??
        Math.min(
          isGemini ? 65536 : TOKEN_LIMITS.MAX_TOKENS_GEMINI,
          Math.max(8192, text.length * TOKEN_LIMITS.TOKEN_MULTIPLIER + 4096)
        ),
    };

    if (config.disableThinking === true && minimalThinking[model]) {
      generationConfig.thinkingConfig = minimalThinking[model];
    }

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      // Keep the existing inline instructions for non-Gemini models (e.g. Gemma).
      { text: isGemini ? userContent : `${systemPrompt}\n\n${userContent}` },
    ];
    if (config.screenContext) {
      parts.push({
        inlineData: {
          mimeType: config.screenContext.mediaType,
          data: config.screenContext.data,
        },
      });
    }
    const requestBody = {
      ...(isGemini ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
      contents: [{ parts }],
      generationConfig,
    };

    const response = await withRetry(async () => {
      // Metadata only: body previews can leak transcript text or base64 screenshots.
      logger.logReasoning("GEMINI_REQUEST", {
        endpoint: `${API_ENDPOINTS.GEMINI}/models/${model}:generateContent`,
        model,
        hasApiKey: !!apiKey,
        hasScreenContext: !!config.screenContext,
        generationConfig,
        textLength: text.length,
      });

      const controller = new AbortController();
      const timeoutSeconds = getLlmRequestTimeoutSeconds();
      const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
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
          finishReason: jsonResponse?.candidates?.[0]?.finishReason,
          usageMetadata: jsonResponse?.usageMetadata,
        });
        return jsonResponse;
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          throw new Error(`Request timed out after ${timeoutSeconds}s`);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    }, createApiRetryStrategy());

    const candidate = response.candidates?.[0];
    // Outside withRetry: don't repeat cutoffs/blocks; cleanup falls back to the original.
    if (candidate?.finishReason !== "STOP") {
      throw new Error(
        `Gemini returned incomplete output (${candidate?.finishReason || "missing finish reason"})`
      );
    }
    const responseText = extractGeminiText(candidate);
    if (!responseText) {
      logger.logReasoning("GEMINI_EMPTY_RESPONSE", {
        model,
        finishReason: candidate?.finishReason,
      });
      throw new Error("Gemini returned empty response");
    }

    logger.logReasoning("GEMINI_RESPONSE", {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usageMetadata?.totalTokenCount || 0,
      success: true,
    });
    return responseText;
  },
};
