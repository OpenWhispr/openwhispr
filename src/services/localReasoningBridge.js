const modelManager = require("../helpers/modelManagerBridge").default;
const debugLogger = require("../helpers/debugLogger");

class LocalReasoningService {
  constructor() {
    this.isProcessing = false;
  }

  async isAvailable() {
    try {
      await modelManager.ensureLlamaCpp();
      const models = await modelManager.getAllModels();
      return models.some((model) => model.isDownloaded);
    } catch {
      return false;
    }
  }

  async processText(text, modelId, config = {}) {
    debugLogger.logReasoning("LOCAL_BRIDGE_START", {
      modelId,
      textLength: text.length,
      hasConfig: Object.keys(config).length > 0,
    });

    if (this.isProcessing) {
      throw new Error("Already processing a request");
    }

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      // The renderer shapes every tunable (applyChatCompletionsParams in
      // local.ts) and this bridge forwards that verbatim — the main process
      // never decides sampling. A caller that skips the shaper keeps the
      // pre-shaping contract: the length-based token budget, and
      // enable_thinking off unless it opted out (Qwen templates otherwise
      // leave `content` empty, #783). llamaServer keeps the same defaults for
      // its own direct callers.
      const shaped = config.params !== undefined;
      const params = { ...config.params };
      params.max_tokens ??= this.calculateMaxTokens(text.length);
      if (!shaped && config.disableThinking !== false) {
        params.chat_template_kwargs = { enable_thinking: false };
      }

      const inferenceConfig = {
        params,
        systemPrompt: config.systemPrompt || "",
        disableThinking: config.disableThinking !== false,
        requireCompleteOutput: config.requireCompleteOutput,
      };

      debugLogger.logReasoning("LOCAL_BRIDGE_INFERENCE", {
        modelId,
        config: inferenceConfig,
      });

      const result = await modelManager.runInference(modelId, text, inferenceConfig);
      const stripThinking = config.disableThinking !== false;
      const cleanResult = stripThinking
        ? (await import("../helpers/stripThinking.js")).stripThinkingTags(result)
        : result.trim();

      const processingTime = Date.now() - startTime;

      debugLogger.logReasoning("LOCAL_BRIDGE_SUCCESS", {
        modelId,
        processingTimeMs: processingTime,
        resultLength: cleanResult.length,
        resultPreview: cleanResult.substring(0, 100) + (cleanResult.length > 100 ? "..." : ""),
      });

      return cleanResult;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      debugLogger.logReasoning("LOCAL_BRIDGE_ERROR", {
        modelId,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
      });

      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  calculateMaxTokens(textLength, minTokens = 512, maxTokens = 2048, multiplier = 2) {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }
}

module.exports = {
  default: new LocalReasoningService(),
};
