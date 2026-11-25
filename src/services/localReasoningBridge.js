const { default: modelManager, reserveFor } = require("../helpers/modelManagerBridge");
const { estimateTokens, BASELINE_CONTEXT_SIZE } = require("../helpers/llamaContextPolicy");
const debugLogger = require("../helpers/debugLogger");

// llama-server's slot count: the app leaves `--parallel` on auto, which
// llama-server resolves to four slots sharing one KV cache. A fifth request
// would only queue for a slot, and fewer would leave one idle.
const MAX_CONCURRENT_INFERENCES = 4;

// The ways a single text can fail on its own. Anything else ends the batch: a
// busy or missing server or a policy refusal would meet every text alike, and
// INFERENCE_FAILED is the catch-all for the server itself failing (a dropped
// connection, a stopped server, a timeout), where the texts left would only
// load the model again.
const TEXT_FAILURE_CODES = new Set([
  "CONTEXT_TOO_LARGE",
  "OUTPUT_TRUNCATED",
  "OUTPUT_COMPLETION_UNVERIFIED",
]);

class LocalReasoningService {
  constructor() {
    this.isProcessing = false;
    this.activeRequestId = null;
    this.abortController = null;
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

    return this._holdSlot(config, async (signal) => {
      const startTime = Date.now();

      try {
        config.signal?.throwIfAborted();
        const inferenceConfig = this._inferenceConfig(text, config);

        debugLogger.logReasoning("LOCAL_BRIDGE_INFERENCE", {
          modelId,
          config: inferenceConfig,
        });

        const cleanResult = await this._infer(modelId, text, inferenceConfig, config, signal);
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
      }
    });
  }

  // Several texts on the model at once, in one hold of the slot: up to
  // MAX_CONCURRENT_INFERENCES, fewer when they would not fit the window side by
  // side. A text that fails on its own gets that failure in its place; any other
  // failure, or a cancel, stops the rest and rejects the whole batch.
  async processTextBatch(texts, modelId, config = {}) {
    debugLogger.logReasoning("LOCAL_BRIDGE_BATCH_START", { modelId, textCount: texts.length });

    return this._holdSlot(config, async (signal) => {
      const startTime = Date.now();
      const inferenceConfigs = texts.map((text) => this._inferenceConfig(text, config));
      const concurrency = this._concurrencyFor(modelId, texts, inferenceConfigs);
      const results = new Array(texts.length);
      let failure = null;
      let next = 0;

      // Each lane takes the next text until none are left.
      const lane = async () => {
        while (next < texts.length && !signal.aborted) {
          const index = next++;
          const text = texts[index];
          try {
            results[index] = {
              success: true,
              text: await this._infer(modelId, text, inferenceConfigs[index], config, signal),
            };
          } catch (error) {
            // Fallout of a cancel, or of the failure that ended the batch,
            // which the batch reports instead.
            if (signal.aborted) return;
            if (TEXT_FAILURE_CODES.has(error.code)) {
              results[index] = { success: false, error: error.message, code: error.code };
            } else {
              failure = error;
              this._abortActive();
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, lane));

      const timing = {
        modelId,
        textCount: texts.length,
        concurrency,
        processingTimeMs: Date.now() - startTime,
      };
      if (failure || signal.aborted) {
        // Texts in flight each fail their own way when cancelled (a closed
        // request, an aborted wait); the batch reports one cancel, in the
        // shape llama-server gives a cancelled request.
        const error =
          failure ?? Object.assign(new Error("cancelled"), { code: "LOCAL_MODEL_CANCELLED" });
        debugLogger.logReasoning("LOCAL_BRIDGE_BATCH_ERROR", { ...timing, code: error.code });
        throw error;
      }

      debugLogger.logReasoning("LOCAL_BRIDGE_BATCH_SUCCESS", {
        ...timing,
        failedCount: results.filter((result) => !result.success).length,
      });
      return results;
    });
  }

  // The slots share one KV cache the size of the window, while runInference
  // sizes each request as if it had the window to itself. So only as many texts
  // run at once as fit in it side by side, by runInference's own estimate. The
  // window is the running server's when it serves this model, and never less
  // than the floor every server starts at.
  _concurrencyFor(modelId, texts, inferenceConfigs) {
    const { serverManager } = modelManager;
    const runningContextSize =
      modelManager.currentServerModelId === modelId && serverManager.ready
        ? serverManager.contextSize
        : null;
    const contextSize = Math.max(BASELINE_CONTEXT_SIZE, runningContextSize ?? 0);
    const largestNeed = Math.max(
      ...inferenceConfigs.map(
        ({ systemPrompt, maxTokens }, index) =>
          estimateTokens(systemPrompt) + estimateTokens(texts[index]) + reserveFor(maxTokens)
      )
    );
    return Math.min(MAX_CONCURRENT_INFERENCES, Math.max(1, Math.floor(contextSize / largestNeed)));
  }

  // One caller holds the local model at a time, a batch for all of its texts.
  async _holdSlot(config, run) {
    if (this.isProcessing) {
      // Typed so the renderer can translate it: a note summarised in parts
      // holds this bridge for minutes, and whatever arrives meanwhile (another
      // note's action, dictation cleanup) used to surface this text raw.
      throw Object.assign(new Error("Already processing a request"), { code: "LOCAL_MODEL_BUSY" });
    }

    this.isProcessing = true;
    this.activeRequestId = config.requestId ?? null;
    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      return await run(
        config.signal
          ? AbortSignal.any([config.signal, abortController.signal])
          : abortController.signal
      );
    } finally {
      this.isProcessing = false;
      this.activeRequestId = null;
      this.abortController = null;
    }
  }

  _inferenceConfig(text, config) {
    return {
      maxTokens: config.maxTokens ?? this.calculateMaxTokens(text.length),
      temperature: config.temperature ?? 0.7,
      topK: config.topK ?? 40,
      topP: config.topP ?? 0.9,
      repeatPenalty: config.repeatPenalty ?? 1.1,
      systemPrompt: config.systemPrompt || "",
      disableThinking: config.disableThinking !== false,
      requireCompleteOutput: config.requireCompleteOutput,
      responseFormat: config.responseFormat,
      refuseClippedByWindow: config.refuseClippedByWindow,
      // A minimum context window for this request. Rebuilding this object
      // field-by-field is what silently orphaned it before #2142: it was
      // declared, written by selection editing, and never forwarded.
      contextSize: config.contextSize,
      // How long to wait for another model's answer before giving up.
      busyWaitMs: config.busyWaitMs,
    };
  }

  async _infer(modelId, text, inferenceConfig, config, signal) {
    const result = await modelManager.runInference(modelId, text, { ...inferenceConfig, signal });
    config.signal?.throwIfAborted();
    // Thinking tags inside a JSON string are document data. The caller
    // validates the complete envelope instead of stripping anything from it.
    if (config.responseFormat) return result;
    const stripThinking = config.disableThinking !== false;
    return stripThinking
      ? (await import("../helpers/stripThinking.js")).stripThinkingTags(result)
      : result.trim();
  }

  // Only the caller that tagged the request can abort it, so a cancelled note
  // never kills a dictation cleanup that took the slot after it. The abort also
  // reaches a request still waiting for the server, which would otherwise swap
  // its model in and run anyway once the other model's answer is done.
  cancel(requestId) {
    if (!requestId || requestId !== this.activeRequestId) return;
    this._abortActive();
  }

  // Closes every request the holder has at the server (a batch has several)
  // and keeps a batch from starting its remaining texts.
  _abortActive() {
    this.abortController?.abort();
    modelManager.cancelInference();
  }

  calculateMaxTokens(textLength, minTokens = 512, maxTokens = 2048, multiplier = 2) {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }
}

module.exports = {
  default: new LocalReasoningService(),
};
