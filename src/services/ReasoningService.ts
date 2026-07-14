import {
  getModelProvider,
  getCloudModel,
  getOpenAiApiConfig,
  getProviderDisplayName,
  isEnterpriseProvider,
  type EnterpriseProvider,
} from "../models/ModelRegistry";
import { BaseReasoningService, ReasoningConfig } from "./BaseReasoningService";
import { SecureCache } from "../utils/SecureCache";
import { withRetry, createApiRetryStrategy } from "../utils/retry";
import { API_ENDPOINTS, TOKEN_LIMITS, buildApiUrl, ensureV1Suffix } from "../config/constants";
import logger from "../utils/logger";
import { getSettings, isCloudCleanupMode } from "../stores/settingsStore";
import { wrapCleanupTranscript } from "../config/prompts";
import { stripThinkingTags } from "../helpers/stripThinking.js";
import { streamText, stepCountIs } from "ai";
import { getAIModel } from "./ai/providers";
import { createEnterpriseChatModel } from "./ai/enterpriseChatModel";
import { PROVIDER_REGISTRY, type ProviderContext } from "./ai/inferenceProviders";
import { getConfiguredOpenAIBase } from "./ai/openaiBase";
import { applyThinkingSuppression } from "./ai/thinkingSuppression";
import { clearTinfoilClientCache } from "./ai/tinfoilClient";

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

// Old Ollama/strict proxies reject the `reasoning` object; drop it and retry once.
async function fetchWithReasoningFieldFallback(
  doFetch: () => Promise<Response>,
  requestBody: Record<string, unknown>,
  logEvent: string
): Promise<Response> {
  let res = await doFetch();
  if (!res.ok && (res.status === 400 || res.status === 422) && requestBody.reasoning) {
    logger.logReasoning(logEvent, { status: res.status });
    delete requestBody.reasoning;
    void res.body?.cancel();
    res = await doFetch();
  }
  return res;
}

class ReasoningService extends BaseReasoningService {
  private apiKeyCache: SecureCache<string>;
  private static readonly MAX_TOOL_STEPS = 20;
  private cacheCleanupStop: (() => void) | undefined;
  private streamAbortController: AbortController | null = null;

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

  private isLanCleanupMode(): boolean {
    const settings = getSettings();
    return settings.cleanupMode === "self-hosted" && !!settings.cleanupRemoteUrl;
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

    const requestBody: any = {
      model,
      messages,
      temperature: config.temperature ?? (isCleanup ? 0 : 0.3),
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

    // gpt-oss defaults to medium reasoning effort; low cuts hidden reasoning
    // tokens (latency) and the tendency to answer the transcript instead of
    // cleaning it. applyThinkingSuppression still wins when thinking is
    // disabled by the user.
    if (isCleanup && model.includes("gpt-oss")) {
      requestBody.reasoning_effort = "low";
    }

    applyThinkingSuppression(requestBody, model, providerName, config);

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
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const res = await fetchWithReasoningFieldFallback(
          () =>
            fetch(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            }),
          requestBody,
          `${providerName.toUpperCase()}_REASONING_FIELD_RETRY`
        );

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
    const trimmedModel = model?.trim?.() || "";
    const isLanCleanup = !!config.lanUrl || this.isLanCleanupMode();
    const providerId = isLanCleanup ? "lan" : config.provider || getModelProvider(trimmedModel);

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
        config,
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
    const cloudProviders = [
      "openai",
      "groq",
      "gemini",
      "anthropic",
      "tinfoil",
      "custom",
      "openrouter",
      "corti",
    ];
    const isLocalProvider = !cloudProviders.includes(provider);

    const settings = getSettings();
    const lanOverride = config.lanUrl?.trim();
    const isLanCleanup = !!lanOverride || this.isLanCleanupMode();

    let endpoint: string;
    let apiKey = "";

    if (isLanCleanup) {
      const rawUrl = lanOverride || settings.cleanupRemoteUrl.trim();
      const baseUrl = ensureV1Suffix(rawUrl);
      endpoint = buildApiUrl(baseUrl, "/chat/completions");
      apiKey =
        config.customApiKey?.trim() ||
        (lanOverride ? "" : settings.cleanupCustomApiKey?.trim() || "");
    } else if (isLocalProvider) {
      const serverResult = await window.electronAPI.llamaServerStart(model);
      if (!serverResult.success || !serverResult.port) {
        throw new Error(serverResult.error || "Failed to start local model server");
      }
      endpoint = `http://127.0.0.1:${serverResult.port}/v1/chat/completions`;
    } else {
      const providerKey = provider as
        "openai" | "groq" | "gemini" | "anthropic" | "tinfoil" | "custom" | "openrouter" | "corti";
      const overrideKey = providerKey === "custom" ? config.customApiKey?.trim() : "";
      apiKey = overrideKey || (await this.getApiKey(providerKey));

      switch (providerKey) {
        case "groq":
          endpoint = buildApiUrl(API_ENDPOINTS.GROQ_BASE, "/chat/completions");
          break;
        case "corti":
          endpoint = buildApiUrl(API_ENDPOINTS.CORTI_MODELS_BASE, "/chat/completions");
          break;
        case "gemini":
          endpoint = buildApiUrl(API_ENDPOINTS.GEMINI, "/openai/chat/completions");
          break;
        case "openrouter":
          endpoint = buildApiUrl(API_ENDPOINTS.OPENROUTER_BASE, "/chat/completions");
          break;
        case "tinfoil":
          throw new Error("Tinfoil streaming must use the verified SDK transport");
        case "openai":
        case "custom":
          endpoint = buildApiUrl(
            config.baseUrl?.trim() || getConfiguredOpenAIBase(),
            "/chat/completions"
          );
          break;
        default:
          endpoint = buildApiUrl(API_ENDPOINTS.OPENAI_BASE, "/chat/completions");
          break;
      }
    }

    const apiConfig = getOpenAiApiConfig(model, provider);
    const useOldTokenParam = isLocalProvider || isLanCleanup || provider === "groq";

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

    applyThinkingSuppression(requestBody, model, isLanCleanup ? "lan" : provider, config);

    logger.logReasoning("AGENT_STREAM_REQUEST", {
      endpoint,
      model,
      provider,
      isLocal: isLocalProvider,
      isLan: !!isLanCleanup,
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
      response = await fetchWithReasoningFieldFallback(
        () =>
          fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          }),
        requestBody,
        "AGENT_STREAM_REASONING_FIELD_RETRY"
      );
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

            const stripThinking =
              (isLocalProvider || isLanCleanup) && config.disableThinking !== false;
            if (stripThinking) {
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
    const lanOverride = config.lanUrl?.trim();
    // An explicit self-hosted URL is the caller's declared route — it must win
    // even when a stale enterprise provider id is left in the scope's settings.
    const isEnterprise = !lanOverride && isEnterpriseProvider(provider);

    const cloudProviders = [
      "openai",
      "groq",
      "gemini",
      "anthropic",
      "tinfoil",
      "custom",
      "openrouter",
      "corti",
    ];
    const isLocalProvider = !isEnterprise && !cloudProviders.includes(provider);

    const settings = getSettings();
    const isLanCleanup = !isEnterprise && (!!lanOverride || this.isLanCleanupMode());

    if ((isLocalProvider || isLanCleanup) && !tools) {
      const contentGen = this.processTextStreaming(messages, model, provider, config);
      for await (const text of contentGen) {
        yield { type: "content", text };
      }
      yield { type: "done", finishReason: "stop" };
      return;
    }

    let apiKey = "";
    let baseURL: string | undefined;

    if (isEnterprise) {
      // Enterprise SDKs run in the main process; the model below proxies
      // doStream over IPC, so no key or base URL is resolved here.
    } else if (isLanCleanup) {
      const rawUrl = lanOverride || settings.cleanupRemoteUrl.trim();
      baseURL = ensureV1Suffix(rawUrl);
      apiKey =
        config.customApiKey?.trim() ||
        (lanOverride ? "" : settings.cleanupCustomApiKey?.trim() || "");
    } else if (isLocalProvider) {
      const serverResult = await window.electronAPI.llamaServerStart(model);
      if (!serverResult.success || !serverResult.port) {
        throw new Error(serverResult.error || "Failed to start local model server");
      }
      baseURL = `http://127.0.0.1:${serverResult.port}/v1`;
    } else {
      const providerKey = provider as
        "openai" | "groq" | "gemini" | "anthropic" | "tinfoil" | "custom" | "openrouter" | "corti";
      const overrideKey = providerKey === "custom" ? config.customApiKey?.trim() : "";
      apiKey = overrideKey || (await this.getApiKey(providerKey));
      baseURL =
        provider === "openrouter"
          ? API_ENDPOINTS.OPENROUTER_BASE
          : provider === "custom"
            ? config.baseUrl?.trim() || getConfiguredOpenAIBase()
            : undefined;
    }
    const aiProvider = isLocalProvider || isLanCleanup ? "local" : provider;
    // OpenRouter ids are never in the local registry, so the supportsThinking
    // exemption below can't apply — honor the toggle directly.
    const openrouterDisableThinking = provider === "openrouter" && config.disableThinking === true;
    // Resolving a Tinfoil model refreshes the registry, so read model config after it.
    const aiModel = isEnterprise
      ? createEnterpriseChatModel(provider as EnterpriseProvider, model)
      : await getAIModel(aiProvider, model, apiKey, baseURL, {
          disableThinking: openrouterDisableThinking,
        });

    const apiConfig = getOpenAiApiConfig(model, provider);
    const modelDef = getCloudModel(model);
    const userSuppressesThinking = config.disableThinking === true && !!modelDef?.supportsThinking;
    const needsGroqDisableThinking =
      provider === "groq" && (modelDef?.disableThinking || userSuppressesThinking);
    const needsGeminiMinimalThinking = provider === "gemini" && userSuppressesThinking;
    const providerOptions = {
      ...(needsGroqDisableThinking ? { groq: { reasoningEffort: "none" } } : {}),
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

    const useTemperature = isLocalProvider || isLanCleanup || apiConfig.supportsTemperature;

    // cancelActiveStream() aborts this controller; streamText propagates it
    // into doStream, cancelling the enterprise IPC proxy's request in main.
    const abortController = new AbortController();
    this.streamAbortController = abortController;

    const result = streamText({
      model: aiModel,
      messages: messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      })),
      tools: tools || undefined,
      stopWhen: stepCountIs(tools ? ReasoningService.MAX_TOOL_STEPS : 1),
      abortSignal: abortController.signal,
      ...(useTemperature ? { temperature: config.temperature ?? 0.3 } : {}),
      maxOutputTokens: config.maxTokens || 4096,
      ...(hasProviderOptions ? { providerOptions } : {}),
    });

    try {
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
    } catch (error) {
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
      if (isCloudCleanupMode()) {
        logger.logReasoning("API_KEY_CHECK", { cloudCleanupMode: true });
        return true;
      }

      if (this.isLanCleanupMode()) {
        logger.logReasoning("API_KEY_CHECK", { lanCleanup: true });
        return true;
      }

      const settings = getSettings();
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
    this.cancelActiveStream();
    if (this.cacheCleanupStop) {
      this.cacheCleanupStop();
    }
  }
}

export default new ReasoningService();
