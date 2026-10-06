const modelManager = require("../helpers/modelManagerBridge").default;
const debugLogger = require("../helpers/debugLogger");

class LocalReasoningService {
  constructor() {
    this.isProcessing = false;
    this.activeRequestId = null;
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
      // Typed so the renderer can translate it: a note summarised in parts
      // holds this bridge for minutes, and whatever arrives meanwhile (another
      // note's action, dictation cleanup) used to surface this text raw.
      throw Object.assign(new Error("Already processing a request"), { code: "LOCAL_MODEL_BUSY" });
    }

    this.isProcessing = true;
    this.activeRequestId = config.requestId ?? null;
    const startTime = Date.now();

    try {
      const inferenceConfig = {
        maxTokens: config.maxTokens ?? this.calculateMaxTokens(text.length),
        temperature: config.temperature ?? 0.7,
        topK: config.topK ?? 40,
        topP: config.topP ?? 0.9,
        repeatPenalty: config.repeatPenalty ?? 1.1,
        systemPrompt: config.systemPrompt || "",
        disableThinking: config.disableThinking !== false,
        requireCompleteOutput: config.requireCompleteOutput,
        refuseClippedByWindow: config.refuseClippedByWindow,
        // A minimum context window for this request. Rebuilding this object
        // field-by-field is what silently orphaned it before #2142: it was
        // declared, written by selection editing, and never forwarded.
        contextSize: config.contextSize,
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
      this.activeRequestId = null;
    }
  }

  // Only the caller that tagged the request can abort it, so a cancelled note
  // never kills a dictation cleanup that took the slot after it.
  cancel(requestId) {
    if (requestId && requestId === this.activeRequestId) modelManager.cancelInference();
  }

  calculateMaxTokens(textLength, minTokens = 512, maxTokens = 2048, multiplier = 2) {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }
}

module.exports = {
  default: new LocalReasoningService(),
};
