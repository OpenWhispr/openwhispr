const modelManager = require("../helpers/modelManagerBridge").default;
const debugLogger = require("../helpers/debugLogger");
const { LocalInferenceScheduler } = require("../helpers/localInferenceScheduler");

class LocalReasoningService {
  constructor() {
    // One llama-server, one request at a time. This used to be a boolean that
    // threw "Already processing a request", which made a multi-minute batch job
    // break dictation outright for its whole duration.
    this.scheduler = new LocalInferenceScheduler({
      onLeaseReclaimed: (id, owner) =>
        debugLogger.notice("Reclaimed a stale local inference lease", { id, owner }, "llama"),
    });
  }

  get isProcessing() {
    return this.scheduler.busy;
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

    const startTime = Date.now();
    // Batch is the safe default: an unlabelled caller must never be able to
    // preempt dictation, and the post-call pipeline reaches us without a
    // priority of its own.
    const release = await this.scheduler.acquire({
      priority: config.priority === "interactive" ? "interactive" : "batch",
      signal: config.signal,
    });

    try {
      const inferenceConfig = {
        maxTokens: config.maxTokens || this.calculateMaxTokens(text.length),
        temperature: config.temperature || 0.7,
        topK: config.topK || 40,
        topP: config.topP || 0.9,
        repeatPenalty: config.repeatPenalty || 1.1,
        contextSize: config.contextSize || 4096,
        threads: config.threads || 4,
        systemPrompt: config.systemPrompt || "",
        disableThinking: config.disableThinking !== false,
        requestTimeoutMs: config.requestTimeoutMs,
      };

      debugLogger.logReasoning("LOCAL_BRIDGE_INFERENCE", {
        modelId,
        config: inferenceConfig,
      });

      const result = await modelManager.runInference(modelId, text, inferenceConfig);
      const stripThinking = config.disableThinking !== false;
      const cleanResult = stripThinking
        ? result
            .replace(/<think>[\s\S]*?<\/think>/g, "")
            .replace(/<think>[\s\S]*$/, "")
            .trim()
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
      release();
    }
  }

  acquireLease(options) {
    return this.scheduler.acquireLease(options);
  }

  releaseLease(id) {
    return this.scheduler.releaseLease(id);
  }

  releaseLeasesForOwner(owner) {
    return this.scheduler.releaseLeasesForOwner(owner);
  }

  calculateMaxTokens(textLength, minTokens = 512, maxTokens = 2048, multiplier = 2) {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }
}

module.exports = {
  default: new LocalReasoningService(),
};
