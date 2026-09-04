import {
  resolveInferenceProvider,
  getCloudModel,
  getOpenAiApiConfig,
  getProviderDisplayName,
  isEnterpriseProvider,
  type EnterpriseProvider,
} from "../models/ModelRegistry";
import { BaseReasoningService, ReasoningConfig } from "./BaseReasoningService";
import { SecureCache } from "../utils/SecureCache";
import { withRetry, createApiRetryStrategy, httpError } from "../utils/retry";
import { API_ENDPOINTS, TOKEN_LIMITS, buildApiUrl, ensureV1Suffix } from "../config/constants";
import logger from "../utils/logger";
import { getSettings, isCloudCleanupMode } from "../stores/settingsStore";
import { wrapCleanupTranscript } from "../config/prompts";
import { stripThinkingTags } from "../helpers/stripThinking.js";
import { getLlmRequestTimeoutSeconds } from "../helpers/llmRequestTimeout.js";
import { streamText, stepCountIs } from "ai";
import { getAIModel } from "./ai/providers";
import { createEnterpriseChatModel } from "./ai/enterpriseChatModel";
import { getManagedScopeResolution } from "../stores/enterpriseIdentityStore";
import type { InferenceScope } from "../config/inferenceScopes";
import { PROVIDER_REGISTRY, type ProviderContext } from "./ai/inferenceProviders";
import {
  canBorrowCleanupCustomKey,
  resolveConfiguredOpenAIBase,
  resolveSelfHostedOpenAIBase,
} from "./ai/openaiBase";
import {
  applyChatCompletionsParams,
  fetchWithParamFallback,
  isTruncatedFinishReason,
} from "./ai/chatRequestBody";
import { getModelFamilyConstraints } from "./ai/modelFamilyConstraints";
import { detectEndpointDialect } from "./ai/thinkingSuppressionDialects";
import { createStreamingThinkFilter } from "./ai/streamingThinkFilter";
import { extractApiErrorMessage } from "./ai/apiErrorMessage";
import { clearTinfoilClientCache } from "./ai/tinfoilClient";
import { resolveChatRoute } from "../helpers/chatRouting";
import { assertAgentAllowedByPolicy, assertReasoningAllowedByPolicy } from "./reasoningPolicy";
import type { InferenceMode } from "../types/electron";

export type ToolMetadata = Record<string, unknown> | Array<Record<string, unknown>>;

interface ToolExecutionResult {
  data: string;
  displayText: string;
  metadata?: ToolMetadata;
}

const BYOK_STREAM_PROVIDERS = [
  "openai",
  "groq",
  "gemini",
  "anthropic",
  "tinfoil",
  "custom",
  "openrouter",
  "corti",
] as const;

type ByokStreamProvider = (typeof BYOK_STREAM_PROVIDERS)[number];

function toByokStreamProvider(provider: string): ByokStreamProvider {
  if (!(BYOK_STREAM_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unsupported reasoning provider: ${provider}`);
  }
  return provider as ByokStreamProvider;
}

export type AgentStreamChunk =
  | { type: "content"; text: string }
  | { type: "tool_calls"; calls: Array<{ id: string; name: string; arguments: string }> }
  | {
      type: "tool_result";
      callId: string;
      toolName: string;
      displayText: string;
      metadata?: ToolMetadata;
    }
  | { type: "done"; finishReason?: string };

function resolveLlmDispatchMode(
  provider: string,
  config: Pick<ReasoningConfig, "lanUrl">
): InferenceMode {
  if (config.lanUrl || provider === "lan") return "self-hosted";
  if (provider === "openwhispr") return "openwhispr";
  if (provider === "local") return "local";
  if (isEnterpriseProvider(provider)) return "enterprise";
  return "providers";
}

function assertAgentSessionAllowedByPolicy(provider: string, mode: InferenceMode): void {
  assertAgentAllowedByPolicy();
  assertReasoningAllowedByPolicy(provider, mode);
}

function logParamFallback(logEvent: string) {
  return (details: { status: number; stripped: string[] }) =>
    logger.logReasoning(logEvent, details);
}

class ReasoningService extends BaseReasoningService {
  private apiKeyCache: SecureCache<string>;
  private static readonly MAX_TOOL_STEPS = 20;
  private cacheCleanupStop: (() => void) | undefined;
  private streamAbortController: AbortController | null = null;
  private activeRequestControllers = new Set<AbortController>();
  private activeCloudStream: { requestId: string; cancel: () => void } | null = null;
  private cloudOperationGeneration = 0;
  private requestCancellationGeneration = 0;

  private readonly providerContext: ProviderContext;

  constructor() {
    super();
    this.apiKeyCache = new SecureCache();
    this.cacheCleanupStop = this.apiKeyCache.startAutoCleanup();
    this.providerContext = {
      getApiKey: (provider: string) =>
        this.getApiKey(provider as Parameters<ReasoningService["getApiKey"]>[0]),
      getSystemPrompt: this.getSystemPrompt.bind(this),
      getCustomDictionary: this.getCustomDictionary.bind(this),
      getPreferredLanguage: this.getPreferredLanguage.bind(this),
      getUiLanguage: this.getUiLanguage.bind(this),
      callChatCompletionsApi: this.callChatCompletionsApi.bind(this),
      calculateMaxTokens: this.calculateMaxTokens.bind(this),
    };

    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => this.destroy());
    }
  }

  private hasLanCleanupConfiguration(): boolean {
    const settings = getSettings();
    return settings.cleanupMode === "self-hosted" && !!settings.cleanupRemoteUrl?.trim();
  }

  // Managed enterprise access owns the route. Manual self-hosted and BYOK overrides are
  // dropped so a leftover endpoint or key can never outrank the administrator's provider.
  private resolveManagedScope<T extends ReasoningConfig, P extends string | undefined>(
    model: string,
    provider: P,
    config: T,
    fallbackScope: InferenceScope
  ): { model: string; provider: P; config: T; isManaged: boolean } {
    const inferenceScope = config.inferenceScope || fallbackScope;
    const managed = getManagedScopeResolution(inferenceScope, getSettings().enterpriseSetupMode);
    if (managed.kind === "error") throw new Error(managed.message);
    if (managed.kind !== "managed") {
      return { model, provider, config: { ...config, inferenceScope }, isManaged: false };
    }
    return {
      model: managed.model,
      provider: managed.provider as P,
      config: {
        ...config,
        inferenceScope,
        provider: managed.provider,
        lanUrl: undefined,
        baseUrl: undefined,
        customApiKey: undefined,
      },
      isManaged: true,
    };
  }

  private async getApiKey(
    provider:
      "openai" | "anthropic" | "gemini" | "groq" | "tinfoil" | "custom" | "openrouter" | "corti"
  ): Promise<string> {
    if (provider === "custom") {
      let customKey = "";
      try {
        customKey = (await window.electronAPI?.getCleanupCustomKey?.()) || "";
      } catch (err) {
        logger.logReasoning("CUSTOM_KEY_IPC_FALLBACK", { error: (err as Error)?.message });
      }
      if (!customKey || !customKey.trim()) {
        customKey = getSettings().cleanupCustomApiKey || "";
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
          openrouter: () => window.electronAPI.getOpenrouterKey(),
          tinfoil: () => window.electronAPI.getTinfoilKey?.(),
          corti: () => window.electronAPI.getCortiKey?.(),
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
      const displayName = getProviderDisplayName(provider);
      const errorMsg = `${displayName} API key not configured`;
      logger.logReasoning(`${provider.toUpperCase()}_KEY_MISSING`, {
        provider,
        error: errorMsg,
      });
      const error = new Error(errorMsg) as Error & { code: string; provider: string };
      error.code = "API_KEY_MISSING";
      error.provider = displayName;
      throw error;
    }

    return apiKey;
  }

  // Single source for BYOK streaming credentials and endpoint overrides:
  // rejects unknown providers instead of defaulting them to OpenAI, and only
  // lets a custom scope borrow the shared cleanup key for the cleanup endpoint.
  private async resolveByokAccess(
    provider: string,
    config: Pick<ReasoningConfig, "baseUrl" | "customApiKey">
  ): Promise<{ apiKey: string; baseURL?: string }> {
    const providerKey = toByokStreamProvider(provider);
    const overrideKey = providerKey === "custom" ? config.customApiKey?.trim() || "" : "";
    const canFallBackToSharedKey =
      providerKey !== "custom" || canBorrowCleanupCustomKey(config.baseUrl);
    const apiKey = overrideKey || (canFallBackToSharedKey ? await this.getApiKey(providerKey) : "");
    const baseURL =
      providerKey === "openrouter"
        ? API_ENDPOINTS.OPENROUTER_BASE
        : providerKey === "custom"
          ? resolveConfiguredOpenAIBase(providerKey, config.baseUrl)
          : undefined;
    return { apiKey, baseURL };
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
    // No systemPrompt override means the default cleanup path: a deterministic
    // transform, so zero temperature and a delimited transcript.
    const isCleanup = !config.systemPrompt;
    const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName);
    const userPrompt = isCleanup ? wrapCleanupTranscript(text) : text;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const requestBody: any = { model, messages };
    applyChatCompletionsParams(requestBody, {
      model,
      provider: providerName,
      endpoint,
      config,
      maxTokens:
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
    });

    logger.logReasoning(`${providerName.toUpperCase()}_REQUEST`, {
      endpoint,
      model,
      hasApiKey: !!apiKey,
      requestBody: JSON.stringify(requestBody).substring(0, 200),
    });

    const requestGeneration = this.requestCancellationGeneration;
    const response = await withRetry(async () => {
      if (requestGeneration !== this.requestCancellationGeneration) {
        throw httpError("Request cancelled", 499);
      }
      const controller = new AbortController();
      this.activeRequestControllers.add(controller);
      const timeoutSeconds = getLlmRequestTimeoutSeconds();
      const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const res = await fetchWithParamFallback(
          () =>
            fetch(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            }),
          requestBody,
          logParamFallback(`${providerName.toUpperCase()}_PARAM_FALLBACK`)
        );

        if (!res.ok) {
          const errorText = await res.text();
          let errorData: any = { error: res.statusText };

          try {
            errorData = JSON.parse(errorText);
          } catch {
            errorData = { error: errorText || res.statusText };
          }

          const errorMessage = extractApiErrorMessage(
            errorData,
            `${providerName} API error: ${res.status}`
          );

          logger.logReasoning(`${providerName.toUpperCase()}_API_ERROR_DETAIL`, {
            status: res.status,
            statusText: res.statusText,
            error: errorData,
            errorMessage,
            fullResponse: errorText.substring(0, 500),
          });
          throw httpError(errorMessage, res.status);
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
          if (requestGeneration !== this.requestCancellationGeneration) {
            throw httpError("Request cancelled", 499);
          }
          throw new Error(`Request timed out after ${timeoutSeconds}s`);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
        this.activeRequestControllers.delete(controller);
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
    if (config.requireCompleteOutput && isTruncatedFinishReason(choice?.finish_reason)) {
      throw new Error("Model output was truncated before the selection edit completed");
    }
    // Reasoning models leak <think> blocks into non-streamed output; strip them
    // unless the user explicitly enabled thinking (same default as streaming).
    const rawContent = choice.message?.content?.trim() || "";
    const responseText =
      config.disableThinking !== false ? stripThinkingTags(rawContent) : rawContent;

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
    const managed = this.resolveManagedScope(model, config.provider, config, "dictationCleanup");
    ({ model, config } = managed);
    const trimmedModel = model?.trim?.() || "";
    const settings = getSettings();
    const isImplicitCleanup =
      config.provider === undefined && config.baseUrl === undefined && config.lanUrl === undefined;
    const implicitProvider =
      settings.cleanupMode === "openwhispr"
        ? "openwhispr"
        : settings.cleanupMode === "self-hosted"
          ? "lan"
          : settings.cleanupProvider || undefined;
    const isImplicitCustomCleanup =
      isImplicitCleanup && settings.cleanupMode === "providers" && implicitProvider === "custom";
    const dispatchConfig: ReasoningConfig = isImplicitCleanup
      ? {
          ...config,
          provider: implicitProvider,
          baseUrl: isImplicitCustomCleanup ? settings.cleanupCloudBaseUrl : undefined,
          customApiKey: isImplicitCustomCleanup
            ? (config.customApiKey ?? settings.cleanupCustomApiKey)
            : config.customApiKey,
        }
      : config;
    const isLanCleanup = !!dispatchConfig.lanUrl || dispatchConfig.provider === "lan";
    const providerId = isLanCleanup
      ? "lan"
      : resolveInferenceProvider(dispatchConfig.provider, trimmedModel);
    if (!providerId) {
      throw new Error("No reasoning provider selected");
    }
    if (dispatchConfig.requiresAgent) assertAgentAllowedByPolicy();
    assertReasoningAllowedByPolicy(providerId, resolveLlmDispatchMode(providerId, dispatchConfig));

    if (!trimmedModel && providerId !== "openwhispr" && providerId !== "lan") {
      throw new Error("No reasoning model selected");
    }

    logger.logReasoning("PROVIDER_SELECTION", {
      provider: providerId,
      model: trimmedModel,
      agentName,
      isLanCleanup,
      textLength: text.length,
    });

    const handler = PROVIDER_REGISTRY[providerId];
    if (!handler) {
      throw new Error(`Unsupported reasoning provider: ${providerId}`);
    }

    const startTime = Date.now();
    try {
      const result = await handler.call({
        text,
        model: trimmedModel,
        agentName,
        config: dispatchConfig,
        ctx: this.providerContext,
      });

      logger.logReasoning("PROVIDER_SUCCESS", {
        provider: providerId,
        model: trimmedModel,
        processingTimeMs: Date.now() - startTime,
        resultLength: result.length,
      });

      return result;
    } catch (error) {
      logger.logReasoning("PROVIDER_ERROR", {
        provider: providerId,
        model: trimmedModel,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  async *processTextStreaming(
    messages: Array<{ role: string; content: string }>,
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string }
  ): AsyncGenerator<string, void, unknown> {
    const abortController = new AbortController();
    this.streamAbortController = abortController;
    try {
      yield* this.processTextStreamingRaw(messages, model, provider, config, abortController);
    } finally {
      if (this.streamAbortController === abortController) {
        this.streamAbortController = null;
      }
    }
  }

  private async *processTextStreamingRaw(
    messages: Array<{ role: string; content: string }>,
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string },
    abortController: AbortController
  ): AsyncGenerator<string, void, unknown> {
    const route = resolveChatRoute({
      provider,
      lanUrl: config.lanUrl,
      customApiKey: config.customApiKey,
    });
    const mode: InferenceMode =
      route.kind === "self-hosted" ? "self-hosted" : route.kind === "local" ? "local" : "providers";
    assertAgentSessionAllowedByPolicy(provider, mode);
    const isLocalProvider = route.kind === "local";
    const isLanChat = route.kind === "self-hosted";

    let endpoint: string;
    let apiKey = "";

    if (isLanChat) {
      const baseUrl = resolveSelfHostedOpenAIBase(route.baseUrl);
      endpoint = buildApiUrl(baseUrl, "/chat/completions");
      apiKey = route.apiKey;
    } else if (isLocalProvider) {
      const serverResult = await window.electronAPI.llamaServerStart(model);
      if (!serverResult.success || !serverResult.port) {
        throw new Error(serverResult.error || "Failed to start local model server");
      }
      endpoint = `http://127.0.0.1:${serverResult.port}/v1/chat/completions`;
    } else {
      const access = await this.resolveByokAccess(provider, config);
      apiKey = access.apiKey;
      const chatBase =
        access.baseURL ??
        (
          {
            openai: API_ENDPOINTS.OPENAI_BASE,
            groq: API_ENDPOINTS.GROQ_BASE,
            corti: API_ENDPOINTS.CORTI_MODELS_BASE,
            gemini: API_ENDPOINTS.GEMINI,
          } as Partial<Record<string, string>>
        )[provider];
      // anthropic and tinfoil have no raw Chat Completions transport here.
      if (!chatBase) {
        throw new Error(`${provider} streaming must use the AI SDK transport`);
      }
      endpoint = buildApiUrl(
        chatBase,
        provider === "gemini" ? "/openai/chat/completions" : "/chat/completions"
      );
    }

    if (abortController.signal.aborted) return;

    const requestBody: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };

    applyChatCompletionsParams(requestBody, {
      model,
      provider: isLanChat ? "lan" : isLocalProvider ? "local" : provider,
      endpoint,
      config,
      maxTokens: config.maxTokens || Math.max(4096, TOKEN_LIMITS.MAX_TOKENS),
    });

    logger.logReasoning("AGENT_STREAM_REQUEST", {
      endpoint,
      model,
      provider,
      isLocal: isLocalProvider,
      isLan: isLanChat,
      messageCount: messages.length,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const timeoutSeconds = getLlmRequestTimeoutSeconds({ streaming: true });
    let timeoutTriggered = false;
    const timeoutId = setTimeout(() => {
      if (abortController.signal.aborted) return;
      timeoutTriggered = true;
      abortController.abort();
    }, timeoutSeconds * 1000);

    let response: Response;
    try {
      response = await fetchWithParamFallback(
        () =>
          fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
            signal: abortController.signal,
          }),
        requestBody,
        logParamFallback("AGENT_STREAM_PARAM_FALLBACK")
      );
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === "AbortError" && abortController.signal.aborted) {
        if (!timeoutTriggered) return;
        throw new Error("Streaming request timed out");
      }
      throw error;
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      const errorText = await response.text();
      let errorMessage: string;
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = extractApiErrorMessage(errorData, `API error: ${response.status}`);
      } catch {
        errorMessage = errorText || `API error: ${response.status}`;
      }
      logger.logReasoning("AGENT_STREAM_ERROR", { status: response.status, errorMessage });
      throw new Error(errorMessage);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      clearTimeout(timeoutId);
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const stripThinking = (isLocalProvider || isLanChat) && config.disableThinking !== false;
    const filterThinkTags = stripThinking ? createStreamingThinkFilter() : null;

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
          if (data === "[DONE]") {
            const trailing = filterThinkTags?.finish();
            if (trailing) yield trailing;
            return;
          }

          try {
            const parsed = JSON.parse(data);
            let content = parsed.choices?.[0]?.delta?.content;
            if (!content) continue;

            if (filterThinkTags) {
              content = filterThinkTags(content);
              if (!content) continue;
            }

            yield content;
          } catch {
            // skip malformed SSE chunks
          }
        }
      }

      const trailing = filterThinkTags?.finish();
      if (trailing) yield trailing;
    } catch (error) {
      if ((error as Error).name === "AbortError" && abortController.signal.aborted) {
        if (!timeoutTriggered) return;
        throw new Error("Streaming request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      reader.releaseLock();
    }
  }

  async *processTextStreamingAI(
    // Content is a string, or text+image parts when a screenshot rides along
    // (image-capable BYOK providers only — the caller drops it elsewhere).
    messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>,
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string },
    tools?: Record<string, import("ai").Tool>
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    ({ model, provider, config } = this.resolveManagedScope(
      model,
      provider,
      config,
      "chatIntelligence"
    ));
    const route = resolveChatRoute({
      provider,
      lanUrl: config.lanUrl,
      customApiKey: config.customApiKey,
      isEnterpriseProvider: isEnterpriseProvider(provider),
    });
    const mode: InferenceMode =
      route.kind === "self-hosted"
        ? "self-hosted"
        : route.kind === "enterprise"
          ? "enterprise"
          : route.kind === "local"
            ? "local"
            : "providers";
    assertAgentSessionAllowedByPolicy(provider, mode);
    // Both streaming transports share this owner so cancellation survives
    // asynchronous server, key, and model setup.
    const abortController = new AbortController();
    this.streamAbortController = abortController;
    const isEnterprise = route.kind === "enterprise";
    const isLocalProvider = route.kind === "local";
    const isLanChat = route.kind === "self-hosted";

    if ((isLocalProvider || isLanChat) && !tools) {
      // Attachments are never routed to local/LAN providers, so content is string-only here.
      try {
        const contentGen = this.processTextStreamingRaw(
          messages as Array<{ role: string; content: string }>,
          model,
          provider,
          config,
          abortController
        );
        for await (const text of contentGen) {
          yield { type: "content", text };
        }
        yield { type: "done", finishReason: "stop" };
      } catch (error) {
        if (abortController.signal.aborted && (error as Error).name === "AbortError") return;
        throw error;
      } finally {
        if (this.streamAbortController === abortController) {
          this.streamAbortController = null;
        }
      }
      return;
    }

    const filterThinkTags =
      (isLocalProvider || isLanChat) && config.disableThinking !== false
        ? createStreamingThinkFilter()
        : null;
    let apiKey = "";
    let baseURL: string | undefined;

    if (isEnterprise) {
      // Enterprise SDKs run in the main process; the model below proxies
      // doStream over IPC, so no key or base URL is resolved here.
    } else if (isLanChat) {
      apiKey = route.apiKey;
      baseURL = resolveSelfHostedOpenAIBase(route.baseUrl);
    } else if (isLocalProvider) {
      const serverResult = await window.electronAPI.llamaServerStart(model);
      if (!serverResult.success || !serverResult.port) {
        throw new Error(serverResult.error || "Failed to start local model server");
      }
      baseURL = `http://127.0.0.1:${serverResult.port}/v1`;
    } else {
      ({ apiKey, baseURL } = await this.resolveByokAccess(provider, config));
    }
    const aiProvider = isLocalProvider || isLanChat ? "local" : provider;
    // OpenRouter ids are never in the local registry, so the supportsThinking
    // exemption below can't apply — honor the toggle directly.
    const openrouterDisableThinking = provider === "openrouter" && config.disableThinking === true;
    // Resolving a Tinfoil model refreshes the registry, so read model config after it.
    const aiModel = isEnterprise
      ? createEnterpriseChatModel(provider as EnterpriseProvider, model, config.inferenceScope)
      : await getAIModel(aiProvider, model, apiKey, baseURL, {
          disableThinking: openrouterDisableThinking,
        });

    if (abortController.signal.aborted) {
      yield { type: "done", finishReason: "stop" };
      return;
    }

    const apiConfig = detectEndpointDialect(baseURL) ?? getOpenAiApiConfig(model, provider);
    const modelDef = getCloudModel(model);
    const userSuppressesThinking = config.disableThinking === true && !!modelDef?.supportsThinking;
    const needsGroqDisableThinking =
      provider === "groq" && (modelDef?.disableThinking || userSuppressesThinking);
    const needsGeminiMinimalThinking = provider === "gemini" && userSuppressesThinking;
    const providerOptions = {
      // The effort value is a family fact: gpt-oss has no "none" (#1611).
      ...(needsGroqDisableThinking
        ? {
            groq: {
              reasoningEffort:
                getModelFamilyConstraints(model)?.reasoningEffort?.suppressValue ?? "none",
            },
          }
        : {}),
      ...(needsGeminiMinimalThinking
        ? { google: { thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false } } }
        : {}),
    };
    const hasProviderOptions = Object.keys(providerOptions).length > 0;

    logger.logReasoning("AGENT_AI_SDK_STREAM_REQUEST", {
      model,
      provider,
      hasTools: !!tools,
      toolCount: tools ? Object.keys(tools).length : 0,
      messageCount: messages.length,
    });

    const useTemperature = isLocalProvider || isLanChat || apiConfig.supportsTemperature;

    const result = streamText({
      model: aiModel,
      messages: messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      })) as import("ai").ModelMessage[],
      tools: tools || undefined,
      stopWhen: stepCountIs(tools ? ReasoningService.MAX_TOOL_STEPS : 1),
      abortSignal: abortController.signal,
      ...(useTemperature ? { temperature: config.temperature ?? 0.3 } : {}),
      maxOutputTokens: config.maxTokens || 4096,
      ...(hasProviderOptions ? { providerOptions } : {}),
    });

    let canFlushFilteredText = true;
    const finishFilteredText = (): string => {
      const trailing = filterThinkTags?.finish() ?? "";
      return canFlushFilteredText ? trailing : "";
    };

    try {
      for await (const chunk of result.fullStream) {
        if (chunk.type === "text-delta") {
          const text = filterThinkTags ? filterThinkTags(chunk.text) : chunk.text;
          if (text) yield { type: "content", text };
        } else if (chunk.type === "text-end" || chunk.type === "finish-step") {
          const trailing = finishFilteredText();
          if (trailing) yield { type: "content", text: trailing };
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
        } else if (chunk.type === "abort") {
          canFlushFilteredText = false;
          finishFilteredText();
        } else if (chunk.type === "error") {
          // streamText reports provider failures as error parts and then ends
          // the stream; swallowing them leaves callers with an empty reply and
          // no terminal signal. Re-throw unless we aborted on purpose.
          canFlushFilteredText = false;
          finishFilteredText();
          if (!abortController.signal.aborted) {
            const cause = (chunk as { error?: unknown }).error;
            throw cause instanceof Error ? cause : new Error(String(cause ?? "Stream failed"));
          }
        } else if (chunk.type === "finish") {
          const trailing = finishFilteredText();
          if (trailing) yield { type: "content", text: trailing };
          yield { type: "done", finishReason: chunk.finishReason };
        }
      }
    } catch (error) {
      canFlushFilteredText = false;
      finishFilteredText();
      if (abortController.signal.aborted) {
        yield { type: "done", finishReason: "stop" };
        return;
      }
      throw error;
    } finally {
      if (this.streamAbortController === abortController) {
        this.streamAbortController = null;
      }
    }
  }

  /** Aborts the chat/agent stream only (panel Esc, chat surface unmount). */
  cancelActiveStream(): void {
    this.cloudOperationGeneration += 1;
    this.streamAbortController?.abort();
    this.streamAbortController = null;
    const activeCloudStream = this.activeCloudStream;
    this.activeCloudStream = null;
    activeCloudStream?.cancel();
  }

  /**
   * Aborts everything in flight in this renderer: the chat stream plus every
   * single-shot request (cleanup, selection edit, titles) and the cloud-reason
   * IPC jobs. Used by the dictation cancel path, never by chat lifecycle —
   * a note or tab switch must not kill unrelated reasoning work.
   */
  cancelAllRequests(): void {
    this.requestCancellationGeneration += 1;
    for (const controller of this.activeRequestControllers) controller.abort();
    this.activeRequestControllers.clear();
    if (typeof window !== "undefined") {
      window.electronAPI?.cancelCloudReason?.();
      window.electronAPI?.cancelEnterpriseReasoning?.();
    }
    this.cancelActiveStream();
  }

  private streamFromIPC(
    messages: Array<{ role: string; content: string | Array<unknown> }>,
    opts: {
      systemPrompt?: string;
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
      // Press-time screenshot; the server routes to its vision chain when present.
      screenContext?: { data: string; mediaType: string };
    }
  ): {
    stream: AsyncGenerator<
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
    >;
    wasCancelled: () => boolean;
  } {
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
    let cancelled = false;
    let closed = false;
    const requestId = crypto.randomUUID();
    const electronAPI = window.electronAPI;

    this.activeCloudStream?.cancel();

    const cleanupChunk = electronAPI?.onAgentStreamChunk?.((payload) => {
      if (payload.requestId !== requestId || closed || cancelled) return;
      queue.push(payload.chunk);
      resolve?.();
    });
    const cleanupError = electronAPI?.onAgentStreamError?.((payload) => {
      if (payload.requestId !== requestId || closed || cancelled) return;
      queue.push({ type: "__error", error: payload.error });
      resolve?.();
    });
    const cleanupEnd = electronAPI?.onAgentStreamEnd?.((payload) => {
      if (payload.requestId !== requestId || closed || cancelled) return;
      queue.push({ type: "__end" });
      resolve?.();
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      cleanupChunk?.();
      cleanupError?.();
      cleanupEnd?.();
      if (this.activeCloudStream?.requestId === requestId) this.activeCloudStream = null;
    };

    const cancel = () => {
      if (closed || cancelled) return;
      cancelled = true;
      electronAPI?.cancelAgentStream?.(requestId);
      queue.length = 0;
      queue.push({ type: "__end" });
      resolve?.();
    };
    this.activeCloudStream = { requestId, cancel };

    electronAPI?.startAgentStream?.(requestId, messages, opts);

    const generator = (async function* () {
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
    })();

    return { stream: generator, wasCancelled: () => cancelled };
  }

  processTextStreamingCloud(
    messages: Array<{ role: string; content: string | Array<unknown> }>,
    config: {
      systemPrompt: string;
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
      executeToolCall?: (name: string, args: string) => Promise<ToolExecutionResult>;
      screenContext?: { data: string; mediaType: string };
    }
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    // Capture synchronously so a cancel before the first next() is observed.
    const operationGeneration = ++this.cloudOperationGeneration;
    return this._processTextStreamingCloud(messages, config, operationGeneration);
  }

  private async *_processTextStreamingCloud(
    messages: Array<{ role: string; content: string | Array<unknown> }>,
    config: {
      systemPrompt: string;
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
      executeToolCall?: (name: string, args: string) => Promise<ToolExecutionResult>;
      screenContext?: { data: string; mediaType: string };
    },
    operationGeneration: number
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    assertAgentSessionAllowedByPolicy("openwhispr", "openwhispr");
    const operationWasCancelled = (): boolean =>
      operationGeneration !== this.cloudOperationGeneration;
    const maxSteps = config.tools?.length ? ReasoningService.MAX_TOOL_STEPS : 1;
    let currentMessages = [...messages];

    for (let step = 0; step < maxSteps; step++) {
      if (operationWasCancelled()) return;
      // The screenshot rides every step of the tool loop so the model keeps
      // its vision after tool results come back.
      const ipcStream = this.streamFromIPC(currentMessages, {
        systemPrompt: config.systemPrompt,
        tools: config.tools,
        screenContext: config.screenContext,
      });

      const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

      for await (const ev of ipcStream.stream) {
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

      if (ipcStream.wasCancelled() || operationWasCancelled()) return;

      if (pendingToolCalls.length === 0 || !config.executeToolCall) {
        yield { type: "done", finishReason: "stop" };
        return;
      }

      for (const call of pendingToolCalls) {
        if (operationWasCancelled()) return;
        let toolResult: ToolExecutionResult;
        try {
          toolResult = await config.executeToolCall(call.name, call.arguments);
        } catch (error) {
          const errMsg = `Error: ${(error as Error).message}`;
          toolResult = { data: errMsg, displayText: errMsg };
        }
        if (operationWasCancelled()) return;
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

    if (operationWasCancelled()) return;
    yield { type: "done", finishReason: "stop" };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const settings = getSettings();
      // Mirrors processText's precedence: managed access outranks every manual route.
      if (
        getManagedScopeResolution("dictationCleanup", settings.enterpriseSetupMode).kind ===
        "managed"
      ) {
        logger.logReasoning("API_KEY_CHECK", { managedEnterprise: true });
        return true;
      }

      if (isCloudCleanupMode()) {
        logger.logReasoning("API_KEY_CHECK", { cloudCleanupMode: true });
        return true;
      }

      if (this.hasLanCleanupConfiguration()) {
        logger.logReasoning("API_KEY_CHECK", { lanCleanup: true });
        return true;
      }

      if (settings.cleanupProvider === "custom" && settings.cleanupCloudBaseUrl?.trim()) {
        logger.logReasoning("API_KEY_CHECK", {
          customProvider: true,
          hasCustomEndpoint: true,
        });
        return true;
      }

      // Enterprise providers: detect credentials by provider, short-circuit.
      // Runtime auth errors (expired SSO, missing ADC) surface via
      // mapEnterpriseError with actionable remediation copy.
      if (settings.cleanupProvider === "bedrock") {
        const hasBedrockCreds =
          !!settings.bedrockProfile?.trim() ||
          (!!settings.bedrockAccessKeyId?.trim() && !!settings.bedrockSecretAccessKey?.trim());
        logger.logReasoning("API_KEY_CHECK", { bedrock: true, hasBedrockCreds });
        if (hasBedrockCreds) return true;
      }
      if (settings.cleanupProvider === "azure") {
        const hasAzureCreds = !!settings.azureApiKey?.trim() && !!settings.azureEndpoint?.trim();
        logger.logReasoning("API_KEY_CHECK", { azure: true, hasAzureCreds });
        if (hasAzureCreds) return true;
      }
      if (settings.cleanupProvider === "vertex") {
        const hasVertexCreds = !!settings.vertexApiKey?.trim() || !!settings.vertexProject?.trim();
        logger.logReasoning("API_KEY_CHECK", { vertex: true, hasVertexCreds });
        if (hasVertexCreds) return true;
      }

      const openaiKey = await window.electronAPI?.getOpenAIKey?.();
      const anthropicKey = await window.electronAPI?.getAnthropicKey?.();
      const geminiKey = await window.electronAPI?.getGeminiKey?.();
      const groqKey = await window.electronAPI?.getGroqKey?.();
      const openrouterKey = await window.electronAPI?.getOpenrouterKey?.();
      const tinfoilKey = await window.electronAPI?.getTinfoilKey?.();
      const cortiKey = await window.electronAPI?.getCortiKey?.();
      const localAvailable = await window.electronAPI?.checkLocalReasoningAvailable?.();

      logger.logReasoning("API_KEY_CHECK", {
        hasOpenAI: !!openaiKey,
        hasAnthropic: !!anthropicKey,
        hasGemini: !!geminiKey,
        hasGroq: !!groqKey,
        hasOpenrouter: !!openrouterKey,
        hasTinfoil: !!tinfoilKey,
        hasCorti: !!cortiKey,
        hasLocal: !!localAvailable,
      });

      return !!(
        openaiKey ||
        anthropicKey ||
        geminiKey ||
        groqKey ||
        openrouterKey ||
        tinfoilKey ||
        cortiKey ||
        localAvailable
      );
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
    provider?:
      | "openai"
      | "anthropic"
      | "gemini"
      | "groq"
      | "mistral"
      | "tinfoil"
      | "custom"
      | "openrouter"
      | "corti"
  ): void {
    if (provider) {
      if (provider !== "custom") {
        this.apiKeyCache.delete(provider);
      }
      if (provider === "tinfoil") {
        clearTinfoilClientCache();
      }
      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider });
    } else {
      this.apiKeyCache.clear();
      clearTinfoilClientCache();
      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider: "all" });
    }
  }

  destroy(): void {
    this.cancelAllRequests();
    if (this.cacheCleanupStop) {
      this.cacheCleanupStop();
    }
  }
}

export default new ReasoningService();
