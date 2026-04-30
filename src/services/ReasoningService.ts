import {
  getModelProvider,
  getCloudModel,
  getOpenAiApiConfig,
  isEnterpriseProvider,
} from "../models/ModelRegistry";
import { BaseReasoningService, ReasoningConfig } from "./BaseReasoningService";
import { SecureCache } from "../utils/SecureCache";
import { withRetry, createApiRetryStrategy } from "../utils/retry";
import { API_ENDPOINTS, TOKEN_LIMITS, buildApiUrl, normalizeBaseUrl } from "../config/constants";
import logger from "../utils/logger";
import { getSettings, isCloudCleanupMode } from "../stores/settingsStore";
import { streamText, stepCountIs } from "ai";
import { getAIModel } from "./ai/providers";
import { PROVIDER_REGISTRY, type ProviderContext } from "./ai/inferenceProviders";
import { getConfiguredOpenAIBase } from "./ai/openaiBase";

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
      getCustomPrompt: this.getCustomPrompt.bind(this),
      callChatCompletionsApi: this.callChatCompletionsApi.bind(this),
      calculateMaxTokens: this.calculateMaxTokens.bind(this),
    };

    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => this.destroy());
    }
  }

  private isLanCleanupMode(): boolean {
    const settings = getSettings();
    return (
      settings.cleanupMode === "self-hosted" &&
      settings.cleanupRemoteType === "lan" &&
      !!settings.cleanupRemoteUrl
    );
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
    const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName);
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
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const res = await fetch(endpoint, {
          method: "POST",
          headers,
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

  private getCustomPrompt(): string | undefined {
    return getSettings().customPrompts.cleanup || undefined;
  }

  async *processTextStreaming(
    messages: Array<{ role: string; content: string }>,
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string }
  ): AsyncGenerator<string, void, unknown> {
    const cloudProviders = ["openai", "groq", "gemini", "anthropic", "custom"];
    const isLocalProvider = !cloudProviders.includes(provider);

    const settings = getSettings();
    const lanOverride = config.lanUrl?.trim();
    const isLanCleanup = !!lanOverride || this.isLanCleanupMode();

    let endpoint: string;
    let apiKey = "";

    if (isLanCleanup) {
      const rawUrl = lanOverride || settings.cleanupRemoteUrl.trim();
      const baseUrl = normalizeBaseUrl(rawUrl) || rawUrl;
      endpoint = buildApiUrl(baseUrl, "/v1/chat/completions");
    } else if (isLocalProvider) {
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
          endpoint = buildApiUrl(getConfiguredOpenAIBase(), "/chat/completions");
          break;
        default:
          endpoint = buildApiUrl(API_ENDPOINTS.OPENAI_BASE, "/chat/completions");
          break;
      }
    }

    const apiConfig = getOpenAiApiConfig(model);
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
            if (isLocalProvider || isLanCleanup) {
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
    if (isEnterpriseProvider(provider)) {
      throw new Error(
        "Agent Mode is not yet supported with enterprise providers (Bedrock/Azure/Vertex). " +
          "Switch to Cloud or Local for Agent Mode, or use this provider for text cleanup only."
      );
    }

    const cloudProviders = ["openai", "groq", "gemini", "anthropic", "custom"];
    const isLocalProvider = !cloudProviders.includes(provider);

    const settings = getSettings();
    const lanOverride = config.lanUrl?.trim();
    const isLanCleanup = !!lanOverride || this.isLanCleanupMode();

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

    if (isLanCleanup) {
      const rawUrl = lanOverride || settings.cleanupRemoteUrl.trim();
      baseURL = normalizeBaseUrl(rawUrl) || rawUrl;
      if (!baseURL.endsWith("/v1")) {
        baseURL = buildApiUrl(baseURL, "/v1");
      }
    } else if (isLocalProvider) {
      const serverResult = await window.electronAPI.llamaServerStart(model);
      if (!serverResult.success || !serverResult.port) {
        throw new Error(serverResult.error || "Failed to start local model server");
      }
      baseURL = `http://127.0.0.1:${serverResult.port}/v1`;
    } else {
      const providerKey = provider as "openai" | "groq" | "gemini" | "anthropic" | "custom";
      apiKey = await this.getApiKey(providerKey);
      baseURL = provider === "custom" ? getConfiguredOpenAIBase() : undefined;
    }
    const apiConfig = getOpenAiApiConfig(model);

    const aiProvider = isLocalProvider || isLanCleanup ? "local" : provider;
    const aiModel = getAIModel(aiProvider, model, apiKey, baseURL);

    const modelDef = getCloudModel(model);
    const needsDisableThinking = provider === "groq" && modelDef?.disableThinking;

    logger.logReasoning("AGENT_AI_SDK_STREAM_REQUEST", {
      model,
      provider,
      hasTools: !!tools,
      toolCount: tools ? Object.keys(tools).length : 0,
      messageCount: messages.length,
    });

    const useTemperature = isLocalProvider || isLanCleanup || apiConfig.supportsTemperature;

    const result = streamText({
      model: aiModel,
      messages: messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      })),
      tools: tools || undefined,
      stopWhen: stepCountIs(tools ? ReasoningService.MAX_TOOL_STEPS : 1),
      ...(useTemperature ? { temperature: config.temperature ?? 0.3 } : {}),
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
