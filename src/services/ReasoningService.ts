import { getModelProvider, getCloudModel } from "../models/ModelRegistry";
import { BaseReasoningService, ReasoningConfig } from "./BaseReasoningService";
import { API_ENDPOINTS, TOKEN_LIMITS } from "../config/constants";
import { isReasoningProviderAvailable } from "../helpers/providerSecurity.mjs";
import logger from "../utils/logger";
import { withSessionRefresh } from "../lib/neonAuth";
import { getSettings, isCloudReasoningMode } from "../stores/settingsStore";

class ReasoningService extends BaseReasoningService {
  constructor() {
    super();
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
    });

    if (this.isProcessing) {
      throw new Error("Already processing a request");
    }

    this.isProcessing = true;

    try {
      const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName, text);

      const result = await window.electronAPI.processOpenAIReasoning(text, model, agentName, {
        ...config,
        systemPrompt,
        isCustomProvider,
      });

      if (result.success) {
        logger.logReasoning("OPENAI_RESPONSE", {
          model,
          responseLength: result.text.length,
          success: true,
        });
        return result.text;
      } else {
        throw new Error(result.error);
      }
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
    logger.logReasoning("ANTHROPIC_START", {
      model,
      agentName,
      environment: typeof window !== "undefined" ? "browser" : "node",
    });

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
  }

  private async processWithLocal(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    logger.logReasoning("LOCAL_START", {
      model,
      agentName,
      environment: typeof window !== "undefined" ? "browser" : "node",
    });

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
  }

  private async processWithGemini(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    logger.logReasoning("GEMINI_START", { model, agentName });

    if (this.isProcessing) {
      throw new Error("Already processing a request");
    }

    this.isProcessing = true;

    try {
      const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName, text);
      const maxTokens =
        config.maxTokens ||
        Math.max(
          2000,
          this.calculateMaxTokens(
            text.length,
            TOKEN_LIMITS.MIN_TOKENS_GEMINI,
            TOKEN_LIMITS.MAX_TOKENS_GEMINI,
            TOKEN_LIMITS.TOKEN_MULTIPLIER
          )
        );

      const result = await window.electronAPI.processGeminiReasoning(text, model, agentName, {
        ...config,
        systemPrompt,
        maxTokens,
      });

      if (result.success) {
        logger.logReasoning("GEMINI_RESPONSE", {
          model,
          responseLength: result.text.length,
          success: true,
        });
        return result.text;
      } else {
        throw new Error(result.error);
      }
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

    this.isProcessing = true;

    try {
      const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName, text);

      // Check if thinking should be disabled for this model
      const modelDef = getCloudModel(model);
      const reasoningEffort =
        modelDef?.disableThinking ? "none" : undefined;
      const reasoningFormat = modelDef?.reasoningFormat;

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

      const result = await window.electronAPI.processGroqReasoning(text, model, agentName, {
        ...config,
        systemPrompt,
        maxTokens,
        reasoningEffort,
        reasoningFormat,
      });

      if (result.success) {
        logger.logReasoning("GROQ_RESPONSE", {
          model,
          responseLength: result.text.length,
          success: true,
        });
        return result.text;
      } else {
        throw new Error(result.error);
      }
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
        const res = await window.electronAPI.cloudReason(text, {
          agentName,
          customDictionary,
          customPrompt: this.getCustomPrompt(),
          systemPrompt: config.systemPrompt,
          language,
          locale,
        });

        if (!res.success) {
          const err: any = new Error(res.error || "OpenWhispr cloud reasoning failed");
          err.code = res.code;
          throw err;
        }

        return res;
      });

      logger.logReasoning("OPENWHISPR_SUCCESS", {
        model: result.model,
        provider: result.provider,
        resultLength: result.text.length,
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

  async isAvailable(): Promise<boolean> {
    try {
      if (isCloudReasoningMode()) {
        logger.logReasoning("API_KEY_CHECK", { cloudReasoningMode: true });
        return true;
      }

      const reasoningProvider = getSettings().reasoningProvider || "openai";
      const hasOpenAI = await window.electronAPI?.hasOpenAIKey?.();
      const hasAnthropic = await window.electronAPI?.hasAnthropicKey?.();
      const hasGemini = await window.electronAPI?.hasGeminiKey?.();
      const hasGroq = await window.electronAPI?.hasGroqKey?.();
      const localAvailable = await window.electronAPI?.checkLocalReasoningAvailable?.();
      const hasCustom = await window.electronAPI?.hasCustomReasoningBaseUrl?.();
      const isAvailable = isReasoningProviderAvailable({
        reasoningProvider,
        hasOpenAI,
        hasAnthropic,
        hasGemini,
        hasGroq,
        hasLocal: localAvailable,
        hasCustomBaseUrl: hasCustom,
      });

      logger.logReasoning("API_KEY_CHECK", {
        reasoningProvider,
        hasOpenAI: !!hasOpenAI,
        hasAnthropic: !!hasAnthropic,
        hasGemini: !!hasGemini,
        hasGroq: !!hasGroq,
        hasLocal: !!localAvailable,
        hasCustom: !!hasCustom,
        isAvailable,
      });

      return isAvailable;
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
    // No-op: API keys are now managed entirely by the main process
    logger.logReasoning("API_KEY_CACHE_CLEARED", { provider: provider || "all" });
  }

  destroy(): void {
    // No resources to clean up
  }
}

export default new ReasoningService();
