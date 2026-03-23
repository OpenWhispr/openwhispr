import { getModelProvider, getCloudModel, getOpenAiApiConfig } from "../models/ModelRegistry";
import { BaseReasoningService, ReasoningConfig } from "./BaseReasoningService";
import { SecureCache } from "../utils/SecureCache";
import { withRetry, createApiRetryStrategy } from "../utils/retry";
import { API_ENDPOINTS, TOKEN_LIMITS, buildApiUrl, normalizeBaseUrl } from "../config/constants";
import logger from "../utils/logger";
import { isSecureEndpoint } from "../utils/urlUtils";
import { withSessionRefresh } from "../lib/neonAuth";
import { getSettings, isCloudReasoningMode } from "../stores/settingsStore";
import { streamText, stepCountIs } from "ai";
import { getAIModel } from "./ai/providers";

export type AgentStreamChunk =
  | { type: "content"; text: string }
  | { type: "tool_calls"; calls: Array<{ id: string; name: string; arguments: string }> }
  | {
      type: "tool_result";
      callId: string;
      toolName: string;
      displayText: string;
      metadata?: Record<string, unknown>;
    }
  | { type: "done"; finishReason?: string };

class ReasoningService extends BaseReasoningService {
  private apiKeyCache: SecureCache<string>;
  private openAiEndpointPreference = new Map<string, "responses" | "chat">();
  private static readonly OPENAI_ENDPOINT_PREF_STORAGE_KEY = "openAiEndpointPreference";
  private static readonly MAX_TOOL_STEPS = 20;
  private cacheCleanupStop: (() => void) | undefined;
  private streamAbortController: AbortController | null = null;

  constructor() {
    super();
    this.apiKeyCache = new SecureCache();
    this.cacheCleanupStop = this.apiKeyCache.startAutoCleanup();

    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => this.destroy());
    }
  }

  private getConfiguredOpenAIBase(): string {
    if (typeof window === "undefined") {
      return API_ENDPOINTS.OPENAI_BASE;
    }

    try {
      const settings = getSettings();
      const provider = settings.reasoningProvider || "";
      const isCustomProvider = provider === "custom";

      if (!isCustomProvider) {
        logger.logReasoning("CUSTOM_REASONING_ENDPOINT_CHECK", {
          hasCustomUrl: false,
          provider,
          reason: "Provider is not 'custom', using default OpenAI endpoint",
          defaultEndpoint: API_ENDPOINTS.OPENAI_BASE,
        });
        return API_ENDPOINTS.OPENAI_BASE;
      }

      const stored = settings.cloudReasoningBaseUrl || "";
      const trimmed = stored.trim();

      if (!trimmed) {
        logger.logReasoning("CUSTOM_REASONING_ENDPOINT_CHECK", {
          hasCustomUrl: false,
          provider,
          usingDefault: true,
          defaultEndpoint: API_ENDPOINTS.OPENAI_BASE,
        });
        return API_ENDPOINTS.OPENAI_BASE;
      }

      const normalized = normalizeBaseUrl(trimmed) || API_ENDPOINTS.OPENAI_BASE;

      logger.logReasoning("CUSTOM_REASONING_ENDPOINT_CHECK", {
        hasCustomUrl: true,
        provider,
        rawUrl: trimmed,
        normalizedUrl: normalized,
        defaultEndpoint: API_ENDPOINTS.OPENAI_BASE,
      });

      const knownNonOpenAIUrls = [
        "api.groq.com",
        "api.anthropic.com",
        "generativelanguage.googleapis.com",
      ];

      const isKnownNonOpenAI = knownNonOpenAIUrls.some((url) => normalized.includes(url));
      if (isKnownNonOpenAI) {
        logger.logReasoning("OPENAI_BASE_REJECTED", {
          reason: "Custom URL is a known non-OpenAI provider, using default OpenAI endpoint",
          attempted: normalized,
        });
        return API_ENDPOINTS.OPENAI_BASE;
      }

      if (!isSecureEndpoint(normalized)) {
        logger.logReasoning("OPENAI_BASE_REJECTED", {
          reason: "HTTPS required (HTTP allowed for local network only)",
          attempted: normalized,
        });
        return API_ENDPOINTS.OPENAI_BASE;
      }

      logger.logReasoning("CUSTOM_REASONING_ENDPOINT_RESOLVED", {
        customEndpoint: normalized,
        isCustom: true,
        provider,
      });

      return normalized;
    } catch (error) {
      logger.logReasoning("CUSTOM_REASONING_ENDPOINT_ERROR", {
        error: (error as Error).message,
        fallbackTo: API_ENDPOINTS.OPENAI_BASE,
      });
      return API_ENDPOINTS.OPENAI_BASE;
    }
  }

  private getOpenAIEndpointCandidates(
    base: string
  ): Array<{ url: string; type: "responses" | "chat" }> {
    const lower = base.toLowerCase();

    if (lower.endsWith("/responses") || lower.endsWith("/chat/completions")) {
      const type = lower.endsWith("/responses") ? "responses" : "chat";
      return [{ url: base, type }];
    }

    const preference = this.getStoredOpenAiPreference(base);
    if (preference === "chat") {
      return [{ url: buildApiUrl(base, "/chat/completions"), type: "chat" }];
    }

    const candidates: Array<{ url: string; type: "responses" | "chat" }> = [
      { url: buildApiUrl(base, "/responses"), type: "responses" },
      { url: buildApiUrl(base, "/chat/completions"), type: "chat" },
    ];

    return candidates;
  }

  private getStoredOpenAiPreference(base: string): "responses" | "chat" | undefined {
    if (this.openAiEndpointPreference.has(base)) {
      return this.openAiEndpointPreference.get(base);
    }

    if (typeof window === "undefined" || !window.localStorage) {
      return undefined;
    }

    try {
      const raw = window.localStorage.getItem(ReasoningService.OPENAI_ENDPOINT_PREF_STORAGE_KEY);
      if (!raw) {
        return undefined;
      }
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) {
        return undefined;
      }
      const value = parsed[base];
      if (value === "responses" || value === "chat") {
        this.openAiEndpointPreference.set(base, value);
        return value;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private rememberOpenAiPreference(base: string, preference: "responses" | "chat"): void {
    this.openAiEndpointPreference.set(base, preference);

    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    try {
      const raw = window.localStorage.getItem(ReasoningService.OPENAI_ENDPOINT_PREF_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const data = typeof parsed === "object" && parsed !== null ? parsed : {};
      data[base] = preference;
      window.localStorage.setItem(
        ReasoningService.OPENAI_ENDPOINT_PREF_STORAGE_KEY,
        JSON.stringify(data)
      );
    } catch {}
  }

  private async getApiKey(
    provider: "openai" | "anthropic" | "gemini" | "groq" | "custom"
  ): Promise<string> {
    if (provider === "custom") {
      let customKey = "";
      try {
        customKey = (await window.electronAPI?.getCustomReasoningKey?.()) || "";
      } catch (err) {
        logger.logReasoning("CUSTOM_KEY_IPC_FALLBACK", { error: (err as Error)?.message });
      }
      if (!customKey || !customKey.trim()) {
        customKey = getSettings().customReasoningApiKey || "";
      }
      const trimmedKey = customKey.trim();

      logger.logReasoning("CUSTOM_KEY_RETRIEVAL", {
        provider,
        hasKey: !!trimmedKey,
        keyLength: trimmedKey.length,
      });

      return trimmedKey;
    }

    let apiKey = this.apiKeyCache.get(provider);

    logger.logReasoning(`${provider.toUpperCase()}_KEY_RETRIEVAL`, {
      provider,
      fromCache: !!apiKey,
      cacheSize: this.apiKeyCache.size || 0,
    });

    if (!apiKey) {
      try {
        const keyGetters = {
          openai: () => window.electronAPI.getOpenAIKey(),
          anthropic: () => window.electronAPI.getAnthropicKey(),
          gemini: () => window.electronAPI.getGeminiKey(),
          groq: () => window.electronAPI.getGroqKey(),
        };
        apiKey = (await keyGetters[provider]()) ?? undefined;

        logger.logReasoning(`${provider.toUpperCase()}_KEY_FETCHED`, {
          provider,
          hasKey: !!apiKey,
          keyLength: apiKey?.length || 0,
        });

        if (apiKey) {
          this.apiKeyCache.set(provider, apiKey);
        }
      } catch (error) {
        logger.logReasoning(`${provider.toUpperCase()}_KEY_FETCH_ERROR`, {
          provider,
          error: (error as Error).message,
          stack: (error as Error).stack,
        });
      }
    }

    if (!apiKey) {
      const errorMsg = `${provider.charAt(0).toUpperCase() + provider.slice(1)} API key not configured`;
      logger.logReasoning(`${provider.toUpperCase()}_KEY_MISSING`, {
        provider,
        error: errorMsg,
      });
      throw new Error(errorMsg);
    }

    return apiKey;
  }

  private async callChatCompletionsApi(
    endpoint: string,
    apiKey: string,
    model: string,
    text: string,
    agentName: string | null,
    config: ReasoningConfig,
    providerName: string
  ): Promise<string> {
    const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName, text);
    const userPrompt = text;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const requestBody: any = {
      model,
      messages,
      temperature: config.temperature ?? 0.3,
      max_tokens:
        config.maxTokens ||
        Math.max(
          4096,
          this.calculateMaxTokens(
            text.length,
            TOKEN_LIMITS.MIN_TOKENS,
            TOKEN_LIMITS.MAX_TOKENS,
            TOKEN_LIMITS.TOKEN_MULTIPLIER
          )
        ),
    };

    // Disable thinking for Groq Qwen models
    const modelDef = getCloudModel(model);
    if (modelDef?.disableThinking && providerName.toLowerCase() === "groq") {
      requestBody.reasoning_effort = "none";
    }

    logger.logReasoning(`${providerName.toUpperCase()}_REQUEST`, {
      endpoint,
      model,
      hasApiKey: !!apiKey,
      requestBody: JSON.stringify(requestBody).substring(0, 200),
    });

    const response = await withRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errorText = await res.text();
          let errorData: any = { error: res.statusText };

          try {
            errorData = JSON.parse(errorText);
          } catch {
            errorData = { error: errorText || res.statusText };
          }

          logger.logReasoning(`${providerName.toUpperCase()}_API_ERROR_DETAIL`, {
            status: res.status,
            statusText: res.statusText,
            error: errorData,
            errorMessage: errorData.error?.message || errorData.message || errorData.error,
            fullResponse: errorText.substring(0, 500),
          });

          const errorMessage =
            errorData.error?.message ||
            errorData.message ||
            errorData.error ||
            `${providerName} API error: ${res.status}`;
          throw new Error(errorMessage);
        }

        const jsonResponse = await res.json();

        logger.logReasoning(`${providerName.toUpperCase()}_RAW_RESPONSE`, {
          hasResponse: !!jsonResponse,
          responseKeys: jsonResponse ? Object.keys(jsonResponse) : [],
          hasChoices: !!jsonResponse?.choices,
          choicesLength: jsonResponse?.choices?.length || 0,
          fullResponse: JSON.stringify(jsonResponse).substring(0, 500),
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

    if (!response.choices || !response.choices[0]) {
      logger.logReasoning(`${providerName.toUpperCase()}_RESPONSE_ERROR`, {
        model,
        response: JSON.stringify(response).substring(0, 500),
        hasChoices: !!response.choices,
        choicesCount: response.choices?.length || 0,
      });
      throw new Error(`Invalid response structure from ${providerName} API`);
    }

    const choice = response.choices[0];
    const responseText = choice.message?.content?.trim() || "";

    if (!responseText) {
      logger.logReasoning(`${providerName.toUpperCase()}_EMPTY_RESPONSE`, {
        model,
        finishReason: choice.finish_reason,
        hasMessage: !!choice.message,
        response: JSON.stringify(choice).substring(0, 500),
      });
      throw new Error(`${providerName} returned empty response`);
    }

    logger.logReasoning(`${providerName.toUpperCase()}_RESPONSE`, {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usage?.total_tokens || 0,
      success: true,
    });

    return responseText;
  }

  async processText(
    text: string,
    model: string = "",
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    let trimmedModel = model?.trim?.() || "";
    const provider = getModelProvider(trimmedModel);

    if (!trimmedModel && provider !== "openwhispr") {
      throw new Error("No reasoning model selected");
    }

    logger.logReasoning("PROVIDER_SELECTION", {
      model: trimmedModel,
      provider,
      agentName,
      hasConfig: Object.keys(config).length > 0,
      textLength: text.length,
      timestamp: new Date().toISOString(),
    });

    try {
      let result: string;
      const startTime = Date.now();

      logger.logReasoning("ROUTING_TO_PROVIDER", {
        provider,
        model,
      });

      switch (provider) {
        case "openai":
          result = await this.processWithOpenAI(text, trimmedModel, agentName, config);
          break;
        case "anthropic":
          result = await this.processWithAnthropic(text, trimmedModel, agentName, config);
          break;
        case "local":
          result = await this.processWithLocal(text, trimmedModel, agentName, config);
          break;
        case "gemini":
          result = await this.processWithGemini(text, trimmedModel, agentName, config);
          break;
        case "groq":
          result = await this.processWithGroq(text, model, agentName, config);
          break;
        case "openwhispr":
          result = await this.processWithOpenWhispr(text, model, agentName, config);
          break;
        case "custom":
          result = await this.processWithOpenAI(text, trimmedModel, agentName, config);
          break;
        default:
          throw new Error(`Unsupported reasoning provider: ${provider}`);
      }

      const processingTime = Date.now() - startTime;

      logger.logReasoning("PROVIDER_SUCCESS", {
        provider,
        model,
        processingTimeMs: processingTime,
        resultLength: result.length,
        resultPreview: result.substring(0, 100) + (result.length > 100 ? "..." : ""),
      });

      return result;
    } catch (error) {
      logger.logReasoning("PROVIDER_ERROR", {
        provider,
        model,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      throw error;
    }
  }

  private async processWithOpenAI(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    const reasoningProvider = getSettings().reasoningProvider || "";
    const isCustomProvider = reasoningProvider === "custom";

    logger.logReasoning("OPENAI_START", {
      model,
      agentName,
      isCustomProvider,
      hasApiKey: false, // Will update after fetching
    });

    if (this.isProcessing) {
      throw new Error("Already processing a request");
    }

    const apiKey = await this.getApiKey(isCustomProvider ? "custom" : "openai");

    logger.logReasoning("OPENAI_API_KEY", {
      hasApiKey: !!apiKey,
      keyLength: apiKey?.length || 0,
    });

    this.isProcessing = true;

    try {
      const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName, text);
      const userPrompt = text;

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];

      const openAiBase = this.getConfiguredOpenAIBase();
      const endpointCandidates = this.getOpenAIEndpointCandidates(openAiBase);
      const isCustomEndpoint = openAiBase !== API_ENDPOINTS.OPENAI_BASE;

      logger.logReasoning("OPENAI_ENDPOINTS", {
        base: openAiBase,
        isCustomEndpoint,
        candidates: endpointCandidates.map((candidate) => candidate.url),
        preference: this.getStoredOpenAiPreference(openAiBase) || null,
      });

      if (isCustomEndpoint) {
        logger.logReasoning("CUSTOM_TEXT_CLEANUP_REQUEST", {
          customBase: openAiBase,
          model,
          textLength: text.length,
          hasApiKey: !!apiKey,
          apiKeyPreview: apiKey ? `${apiKey.substring(0, 8)}...` : "(none)",
        });
      }

      const response = await withRetry(async () => {
        let lastError: Error | null = null;

        for (const { url: endpoint, type } of endpointCandidates) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);
          try {
            const maxTokens =
              config.maxTokens ||
              Math.max(
                4096,
                this.calculateMaxTokens(
                  text.length,
                  TOKEN_LIMITS.MIN_TOKENS,
                  TOKEN_LIMITS.MAX_TOKENS,
                  TOKEN_LIMITS.TOKEN_MULTIPLIER
                )
              );

            const apiConfig = getOpenAiApiConfig(model);
            const requestBody: any = { model };

            if (type === "responses") {
              requestBody.input = messages;
              requestBody.store = false;
              requestBody.max_output_tokens = maxTokens;
            } else {
              requestBody.messages = messages;
              requestBody[apiConfig.tokenParam] = maxTokens;
            }

            if (apiConfig.supportsTemperature) {
              requestBody.temperature = config.temperature || 0.3;
            }

            const res = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            });

            if (!res.ok) {
              const errorData = await res.json().catch(() => ({ error: res.statusText }));
              const errorMessage =
                errorData.error?.message || errorData.message || `OpenAI API error: ${res.status}`;

              const isUnsupportedEndpoint =
                (res.status === 404 || res.status === 405) && type === "responses";

              if (isUnsupportedEndpoint) {
                lastError = new Error(errorMessage);
                this.rememberOpenAiPreference(openAiBase, "chat");
                logger.logReasoning("OPENAI_ENDPOINT_FALLBACK", {
                  attemptedEndpoint: endpoint,
                  error: errorMessage,
                });
                continue;
              }

              throw new Error(errorMessage);
            }

            this.rememberOpenAiPreference(openAiBase, type);
            return res.json();
          } catch (error) {
            if ((error as Error).name === "AbortError") {
              throw new Error("Request timed out after 30s");
            }
            lastError = error as Error;
            if (type === "responses") {
              logger.logReasoning("OPENAI_ENDPOINT_FALLBACK", {
                attemptedEndpoint: endpoint,
                error: (error as Error).message,
              });
              continue;
            }
            throw error;
          } finally {
            clearTimeout(timeoutId);
          }
        }

        throw lastError || new Error("No OpenAI endpoint responded");
      }, createApiRetryStrategy());

      const isResponsesApi = Array.isArray(response?.output);
      const isChatCompletions = Array.isArray(response?.choices);

      logger.logReasoning("OPENAI_RAW_RESPONSE", {
        model,
        format: isResponsesApi ? "responses" : isChatCompletions ? "chat_completions" : "unknown",
        hasOutput: isResponsesApi,
        outputLength: isResponsesApi ? response.output.length : 0,
        outputTypes: isResponsesApi ? response.output.map((item: any) => item.type) : undefined,
        hasChoices: isChatCompletions,
        choicesLength: isChatCompletions ? response.choices.length : 0,
        usage: response.usage,
      });

      let responseText = "";

      if (isResponsesApi) {
        for (const item of response.output) {
          if (item.type === "message" && item.content) {
            for (const content of item.content) {
              if (content.type === "output_text" && content.text) {
                responseText = content.text.trim();
                break;
              }
            }
            if (responseText) break;
          }
        }
      }

      if (!responseText && typeof response?.output_text === "string") {
        responseText = response.output_text.trim();
      }

      if (!responseText && isChatCompletions) {
        for (const choice of response.choices) {
          const message = choice?.message ?? choice?.delta;
          const content = message?.content;

          if (typeof content === "string" && content.trim()) {
            responseText = content.trim();
            break;
          }

          if (Array.isArray(content)) {
            for (const part of content) {
              if (typeof part?.text === "string" && part.text.trim()) {
                responseText = part.text.trim();
                break;
              }
            }
          }

          if (responseText) break;

          if (typeof choice?.text === "string" && choice.text.trim()) {
            responseText = choice.text.trim();
            break;
          }
        }
      }

      logger.logReasoning("OPENAI_RESPONSE", {
        model,
        responseLength: responseText.length,
        tokensUsed: response.usage?.total_tokens || 0,
        success: true,
        isEmpty: responseText.length === 0,
      });

      if (!responseText) {
        logger.logReasoning("OPENAI_EMPTY_RESPONSE_FALLBACK", {
          model,
          originalTextLength: text.length,
          reason: "Empty response from API",
        });
        return text;
      }

      return responseText;
    } catch (error) {
      logger.logReasoning("OPENAI_ERROR", {
        model,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  private async processWithAnthropic(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    if (this.isProcessing) {
      throw new Error("Already processing a request");
    }

    logger.logReasoning("ANTHROPIC_START", {
      model,
      agentName,
      environment: typeof window !== "undefined" ? "browser" : "node",
    });

    this.isProcessing = true;
    try {
      if (typeof window !== "undefined" && window.electronAPI) {
        const startTime = Date.now();

        logger.logReasoning("ANTHROPIC_IPC_CALL", {
          model,
          textLength: text.length,
        });

        const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName, text);
        const result = await window.electronAPI.processAnthropicReasoning(text, model, agentName, {
          ...config,
          systemPrompt,
        });

        const processingTime = Date.now() - startTime;

        if (result.success) {
          logger.logReasoning("ANTHROPIC_SUCCESS", {
            model,
            processingTimeMs: processingTime,
            resultLength: result.text.length,
          });
          return result.text;
        } else {
          logger.logReasoning("ANTHROPIC_ERROR", {
            model,
            processingTimeMs: processingTime,
            error: result.error,
          });
          throw new Error(result.error);
        }
      } else {
        logger.logReasoning("ANTHROPIC_UNAVAILABLE", {
          reason: "Not in Electron environment",
        });
        throw new Error("Anthropic reasoning is not available in this environment");
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processWithLocal(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    if (this.isProcessing) {
      throw new Error("Already processing a request");
    }

    logger.logReasoning("LOCAL_START", {
      model,
      agentName,
      environment: typeof window !== "undefined" ? "browser" : "node",
    });

    this.isProcessing = true;
    try {
      if (typeof window !== "undefined" && window.electronAPI) {
        const startTime = Date.now();

        logger.logReasoning("LOCAL_IPC_CALL", {
          model,
          textLength: text.length,
        });

        const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName, text);
        const result = await window.electronAPI.processLocalReasoning(text, model, agentName, {
          ...config,
          systemPrompt,
        });

        const processingTime = Date.now() - startTime;

        if (result.success) {
          logger.logReasoning("LOCAL_SUCCESS", {
            model,
            processingTimeMs: processingTime,
            resultLength: result.text.length,
          });
          return result.text;
        } else {
          logger.logReasoning("LOCAL_ERROR", {
            model,
            processingTimeMs: processingTime,
            error: result.error,
          });
          throw new Error(result.error);
        }
      } else {
        logger.logReasoning("LOCAL_UNAVAILABLE", {
          reason: "Not in Electron environment",
        });
        throw new Error("Local reasoning is not available in this environment");
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processWithGemini(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    logger.logReasoning("GEMINI_START", {
      model,
      agentName,
      hasApiKey: false,
    });

    if (this.isProcessing) {
      throw new Error("Already processing a request");
    }

    const apiKey = await this.getApiKey("gemini");

    logger.logReasoning("GEMINI_API_KEY", {
      hasApiKey: !!apiKey,
      keyLength: apiKey?.length || 0,
    });

    this.isProcessing = true;

    try {
      const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName, text);
      const userPrompt = text;

      const requestBody = {
        contents: [
          {
            parts: [
              {
                text: `${systemPrompt}\n\n${userPrompt}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: config.temperature || 0.3,
          maxOutputTokens:
            config.maxTokens ||
            Math.max(
              2000,
              this.calculateMaxTokens(
                text.length,
                TOKEN_LIMITS.MIN_TOKENS_GEMINI,
                TOKEN_LIMITS.MAX_TOKENS_GEMINI,
                TOKEN_LIMITS.TOKEN_MULTIPLIER
              )
            ),
        },
      };

      let response: any;
      try {
        response = await withRetry(async () => {
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
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            });

            if (!res.ok) {
              const errorText = await res.text();
              let errorData: any = { error: res.statusText };

              try {
                errorData = JSON.parse(errorText);
              } catch {
                errorData = { error: errorText || res.statusText };
              }

              logger.logReasoning("GEMINI_API_ERROR_DETAIL", {
                status: res.status,
                statusText: res.statusText,
                error: errorData,
                errorMessage: errorData.error?.message || errorData.message || errorData.error,
                fullResponse: errorText.substring(0, 500),
              });

              const errorMessage =
                errorData.error?.message ||
                errorData.message ||
                errorData.error ||
                `Gemini API error: ${res.status}`;
              throw new Error(errorMessage);
            }

            const jsonResponse = await res.json();

            logger.logReasoning("GEMINI_RAW_RESPONSE", {
              hasResponse: !!jsonResponse,
              responseKeys: jsonResponse ? Object.keys(jsonResponse) : [],
              hasCandidates: !!jsonResponse?.candidates,
              candidatesLength: jsonResponse?.candidates?.length || 0,
              fullResponse: JSON.stringify(jsonResponse).substring(0, 500),
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
      } catch (fetchError) {
        logger.logReasoning("GEMINI_FETCH_ERROR", {
          error: (fetchError as Error).message,
          stack: (fetchError as Error).stack,
        });
        throw fetchError;
      }

      if (!response.candidates || !response.candidates[0]) {
        logger.logReasoning("GEMINI_RESPONSE_ERROR", {
          model,
          response: JSON.stringify(response).substring(0, 500),
          hasCandidate: !!response.candidates,
          candidateCount: response.candidates?.length || 0,
        });
        throw new Error("Invalid response structure from Gemini API");
      }

      const candidate = response.candidates[0];
      if (!candidate.content?.parts?.[0]?.text) {
        logger.logReasoning("GEMINI_EMPTY_RESPONSE", {
          model,
          finishReason: candidate.finishReason,
          hasContent: !!candidate.content,
          hasParts: !!candidate.content?.parts,
          response: JSON.stringify(candidate).substring(0, 500),
        });

        if (candidate.finishReason === "MAX_TOKENS") {
          throw new Error(
            "Gemini reached token limit before generating response. Try a shorter input or increase max tokens."
          );
        }
        throw new Error("Gemini returned empty response");
      }

      const responseText = candidate.content.parts[0].text.trim();

      logger.logReasoning("GEMINI_RESPONSE", {
        model,
        responseLength: responseText.length,
        tokensUsed: response.usageMetadata?.totalTokenCount || 0,
        success: true,
      });

      return responseText;
    } catch (error) {
      logger.logReasoning("GEMINI_ERROR", {
        model,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  private async processWithGroq(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    logger.logReasoning("GROQ_START", { model, agentName });

    if (this.isProcessing) {
      throw new Error("Already processing a request");
    }

    const apiKey = await this.getApiKey("groq");
    this.isProcessing = true;

    try {
      const endpoint = buildApiUrl(API_ENDPOINTS.GROQ_BASE, "/chat/completions");
      return await this.callChatCompletionsApi(
        endpoint,
        apiKey,
        model,
        text,
        agentName,
        config,
        "Groq"
      );
    } catch (error) {
      logger.logReasoning("GROQ_ERROR", {
        model,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  private async processWithOpenWhispr(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    logger.logReasoning("OPENWHISPR_START", { model, agentName });

    if (this.isProcessing) {
      throw new Error("Already processing a request");
    }

    this.isProcessing = true;

    try {
      const customDictionary = this.getCustomDictionary();
      const language = this.getPreferredLanguage();
      const locale = this.getUiLanguage();

      const result = await withSessionRefresh(async () => {
        const res = await window.electronAPI?.cloudReason?.(text, {
          agentName,
          customDictionary,
          customPrompt: this.getCustomPrompt(),
          systemPrompt: config.systemPrompt,
          language,
          locale,
        });

        if (!res?.success) {
          const err: any = new Error(res?.error || "OpenWhispr cloud reasoning failed");
          err.code = res?.code;
          throw err;
        }

        return res;
      });

      logger.logReasoning("OPENWHISPR_SUCCESS", {
        model: result.model,
        provider: result.provider,
        resultLength: result.text.length,
        promptMode: result.promptMode,
        matchType: result.matchType,
      });

      return result.text;
    } catch (error) {
      logger.logReasoning("OPENWHISPR_ERROR", {
        model,
        error: (error as Error).message,
      });
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  private getCustomPrompt(): string | undefined {
    try {
      const raw = localStorage.getItem("customUnifiedPrompt");
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async *processTextStreaming(
    messages: Array<{ role: string; content: string }>,
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string }
  ): AsyncGenerator<string, void, unknown> {
    const cloudProviders = ["openai", "groq", "gemini", "anthropic", "custom"];
    const isLocalProvider = !cloudProviders.includes(provider);

    let endpoint: string;
    let apiKey = "";

    if (isLocalProvider) {
      // Local model via llama.cpp server
      const serverResult = await window.electronAPI.llamaServerStart(model);
      if (!serverResult.success || !serverResult.port) {
        throw new Error(serverResult.error || "Failed to start local model server");
      }
      endpoint = `http://127.0.0.1:${serverResult.port}/v1/chat/completions`;
    } else {
      const providerKey = provider as "openai" | "groq" | "gemini" | "anthropic" | "custom";
      apiKey = await this.getApiKey(providerKey);

      switch (providerKey) {
        case "groq":
          endpoint = buildApiUrl(API_ENDPOINTS.GROQ_BASE, "/chat/completions");
          break;
        case "gemini":
          endpoint = buildApiUrl(API_ENDPOINTS.GEMINI, "/openai/chat/completions");
          break;
        case "openai":
        case "custom":
          endpoint = buildApiUrl(this.getConfiguredOpenAIBase(), "/chat/completions");
          break;
        default:
          endpoint = buildApiUrl(API_ENDPOINTS.OPENAI_BASE, "/chat/completions");
          break;
      }
    }

    const apiConfig = getOpenAiApiConfig(model);
    const useOldTokenParam = isLocalProvider || provider === "groq";

    const requestBody: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };

    const maxTokens = config.maxTokens || Math.max(4096, TOKEN_LIMITS.MAX_TOKENS);

    if (useOldTokenParam) {
      requestBody.temperature = config.temperature ?? 0.3;
      requestBody.max_tokens = maxTokens;
    } else {
      requestBody[apiConfig.tokenParam] = maxTokens;
      if (apiConfig.supportsTemperature) {
        requestBody.temperature = config.temperature ?? 0.3;
      }
    }

    logger.logReasoning("AGENT_STREAM_REQUEST", {
      endpoint,
      model,
      provider,
      isLocal: isLocalProvider,
      messageCount: messages.length,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    this.streamAbortController = new AbortController();
    const controller = this.streamAbortController;
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === "AbortError") {
        throw new Error("Streaming request timed out");
      }
      throw error;
    }

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage: string;
      try {
        const errorData = JSON.parse(errorText);
        errorMessage =
          errorData.error?.message ||
          errorData.message ||
          errorData.error ||
          `API error: ${response.status}`;
      } catch {
        errorMessage = errorText || `API error: ${response.status}`;
      }
      logger.logReasoning("AGENT_STREAM_ERROR", { status: response.status, errorMessage });
      throw new Error(errorMessage);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let insideThinkBlock = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data);
            let content = parsed.choices?.[0]?.delta?.content;
            if (!content) continue;

            // Strip Qwen3 <think> blocks from streamed output
            if (isLocalProvider) {
              if (insideThinkBlock) {
                const endIdx = content.indexOf("</think>");
                if (endIdx !== -1) {
                  insideThinkBlock = false;
                  content = content.slice(endIdx + 8);
                } else {
                  continue;
                }
              }
              const startIdx = content.indexOf("<think>");
              if (startIdx !== -1) {
                const before = content.slice(0, startIdx);
                const after = content.slice(startIdx + 7);
                const endIdx = after.indexOf("</think>");
                if (endIdx !== -1) {
                  content = before + after.slice(endIdx + 8);
                } else {
                  insideThinkBlock = true;
                  content = before;
                }
              }
              if (!content) continue;
            }

            yield content;
          } catch {
            // skip malformed SSE chunks
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
      this.streamAbortController = null;
      reader.releaseLock();
    }
  }

  async *processTextStreamingAI(
    messages: Array<{ role: string; content: string }>,
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string },
    tools?: Record<string, import("ai").Tool>
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const cloudProviders = ["openai", "groq", "gemini", "anthropic", "custom"];
    const isLocalProvider = !cloudProviders.includes(provider);

    if (isLocalProvider) {
      const contentGen = this.processTextStreaming(messages, model, provider, config);
      for await (const text of contentGen) {
        yield { type: "content", text };
      }
      yield { type: "done", finishReason: "stop" };
      return;
    }

    const providerKey = provider as "openai" | "groq" | "gemini" | "anthropic" | "custom";
    const apiKey = await this.getApiKey(providerKey);
    const baseURL = provider === "custom" ? this.getConfiguredOpenAIBase() : undefined;
    const apiConfig = getOpenAiApiConfig(model);

    const aiModel = getAIModel(provider, model, apiKey, baseURL);

    const modelDef = getCloudModel(model);
    const needsDisableThinking = provider === "groq" && modelDef?.disableThinking;

    logger.logReasoning("AGENT_AI_SDK_STREAM_REQUEST", {
      model,
      provider,
      hasTools: !!tools,
      toolCount: tools ? Object.keys(tools).length : 0,
      messageCount: messages.length,
    });

    const result = streamText({
      model: aiModel,
      messages: messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      })),
      tools: tools || undefined,
      stopWhen: stepCountIs(tools ? ReasoningService.MAX_TOOL_STEPS : 1),
      ...(apiConfig.supportsTemperature ? { temperature: config.temperature ?? 0.3 } : {}),
      maxOutputTokens: config.maxTokens || 4096,
      ...(needsDisableThinking ? { providerOptions: { groq: { reasoningEffort: "none" } } } : {}),
    });

    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") {
        yield { type: "content", text: chunk.text };
      } else if (chunk.type === "tool-call") {
        yield {
          type: "tool_calls",
          calls: [
            {
              id: chunk.toolCallId,
              name: chunk.toolName,
              arguments: JSON.stringify(chunk.input),
            },
          ],
        };
      } else if (chunk.type === "tool-result") {
        const output = chunk.output;
        const displayText =
          typeof output === "string" ? output : output?.error ? String(output.error) : "Done";
        yield {
          type: "tool_result",
          callId: chunk.toolCallId,
          toolName: chunk.toolName,
          displayText,
        };
      } else if (chunk.type === "finish") {
        yield { type: "done", finishReason: chunk.finishReason };
      }
    }
  }

  cancelActiveStream(): void {
    this.streamAbortController?.abort();
    this.streamAbortController = null;
  }

  private streamFromIPC(
    messages: Array<{ role: string; content: string | Array<unknown> }>,
    opts: {
      systemPrompt?: string;
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    }
  ): AsyncGenerator<
    {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      arguments?: string;
      finishReason?: string;
    },
    void,
    unknown
  > {
    type StreamEvent = {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      arguments?: string;
      finishReason?: string;
    };
    const queue: Array<StreamEvent | { type: "__error"; error: string } | { type: "__end" }> = [];
    let resolve: (() => void) | null = null;

    const cleanupChunk = window.electronAPI?.onAgentStreamChunk?.((chunk) => {
      queue.push(chunk);
      resolve?.();
    });
    const cleanupError = window.electronAPI?.onAgentStreamError?.((err) => {
      queue.push({ type: "__error", error: err.error });
      resolve?.();
    });
    const cleanupEnd = window.electronAPI?.onAgentStreamEnd?.(() => {
      queue.push({ type: "__end" });
      resolve?.();
    });

    const cleanup = () => {
      cleanupChunk?.();
      cleanupError?.();
      cleanupEnd?.();
    };

    window.electronAPI?.startAgentStream?.(messages, opts);

    const generator = async function* () {
      try {
        while (true) {
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              resolve = r;
            });
            resolve = null;
          }

          while (queue.length > 0) {
            const item = queue.shift()!;
            if (item.type === "__end") return;
            if (item.type === "__error") throw new Error((item as { error: string }).error);
            yield item as StreamEvent;
          }
        }
      } finally {
        cleanup();
      }
    };

    return generator();
  }

  async *processTextStreamingCloud(
    messages: Array<{ role: string; content: string | Array<unknown> }>,
    config: {
      systemPrompt: string;
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
      executeToolCall?: (
        name: string,
        args: string
      ) => Promise<{ data: string; displayText: string; metadata?: Record<string, unknown> }>;
    }
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const maxSteps = config.tools?.length ? ReasoningService.MAX_TOOL_STEPS : 1;
    let currentMessages = [...messages];

    for (let step = 0; step < maxSteps; step++) {
      const stream = this.streamFromIPC(currentMessages, {
        systemPrompt: config.systemPrompt,
        tools: config.tools,
      });

      const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

      for await (const ev of stream) {
        if (ev.type === "content") {
          yield { type: "content", text: ev.text as string };
        } else if (ev.type === "tool_call") {
          const call = {
            id: ev.id as string,
            name: ev.name as string,
            arguments: ev.arguments as string,
          };
          pendingToolCalls.push(call);
          yield { type: "tool_calls", calls: [call] };
        }
      }

      if (pendingToolCalls.length === 0 || !config.executeToolCall) {
        yield { type: "done", finishReason: "stop" };
        return;
      }

      for (const call of pendingToolCalls) {
        let toolResult: { data: string; displayText: string; metadata?: Record<string, unknown> };
        try {
          toolResult = await config.executeToolCall(call.name, call.arguments);
        } catch (error) {
          const errMsg = `Error: ${(error as Error).message}`;
          toolResult = { data: errMsg, displayText: errMsg };
        }
        yield {
          type: "tool_result",
          callId: call.id,
          toolName: call.name,
          displayText: toolResult.displayText,
          ...(toolResult.metadata ? { metadata: toolResult.metadata } : {}),
        };

        currentMessages = [
          ...currentMessages,
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: call.id,
                toolName: call.name,
                input: JSON.parse(call.arguments),
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: call.id,
                toolName: call.name,
                output: { type: "text", value: toolResult.data },
              },
            ],
          },
        ];
      }
    }

    yield { type: "done", finishReason: "stop" };
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (isCloudReasoningMode()) {
        logger.logReasoning("API_KEY_CHECK", { cloudReasoningMode: true });
        return true;
      }

      const settings = getSettings();
      if (settings.reasoningProvider === "custom" && settings.cloudReasoningBaseUrl?.trim()) {
        logger.logReasoning("API_KEY_CHECK", {
          customProvider: true,
          hasCustomEndpoint: true,
        });
        return true;
      }

      const openaiKey = await window.electronAPI?.getOpenAIKey?.();
      const anthropicKey = await window.electronAPI?.getAnthropicKey?.();
      const geminiKey = await window.electronAPI?.getGeminiKey?.();
      const groqKey = await window.electronAPI?.getGroqKey?.();
      const localAvailable = await window.electronAPI?.checkLocalReasoningAvailable?.();

      logger.logReasoning("API_KEY_CHECK", {
        hasOpenAI: !!openaiKey,
        hasAnthropic: !!anthropicKey,
        hasGemini: !!geminiKey,
        hasGroq: !!groqKey,
        hasLocal: !!localAvailable,
      });

      return !!(openaiKey || anthropicKey || geminiKey || groqKey || localAvailable);
    } catch (error) {
      logger.logReasoning("API_KEY_CHECK_ERROR", {
        error: (error as Error).message,
        stack: (error as Error).stack,
        name: (error as Error).name,
      });
      return false;
    }
  }

  clearApiKeyCache(
    provider?: "openai" | "anthropic" | "gemini" | "groq" | "mistral" | "custom"
  ): void {
    if (provider) {
      if (provider !== "custom") {
        this.apiKeyCache.delete(provider);
      }
      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider });
    } else {
      this.apiKeyCache.clear();
      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider: "all" });
    }
  }

  destroy(): void {
    this.cancelActiveStream();
    if (this.cacheCleanupStop) {
      this.cacheCleanupStop();
    }
  }
}

export default new ReasoningService();
