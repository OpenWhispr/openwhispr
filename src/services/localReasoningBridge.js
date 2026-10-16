const modelManager = require("../helpers/modelManagerBridge").default;
const debugLogger = require("../helpers/debugLogger");

const INTERACTIVE_SCOPES = new Set(["dictationCleanup", "dictationAgent", "dictationTranslation"]);

// A dictation is someone waiting at the cursor. A note summary can take minutes
// and must not sit in front of that, or fail the dictation for being busy.
function isInteractiveRequest(config) {
  if (config.priority === "background") return false;
  if (config.priority === "interactive" || config.purpose === "cleanup") return true;
  return INTERACTIVE_SCOPES.has(config.inferenceScope);
}

class LocalReasoningService {
  constructor() {
    this.isProcessing = false;
    this.activeRequestId = null;
    this.activeJob = null;
    this.queue = [];
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

  processText(text, modelId, config = {}) {
    debugLogger.logReasoning("LOCAL_BRIDGE_START", {
      modelId,
      textLength: text.length,
      hasConfig: Object.keys(config).length > 0,
    });

    return new Promise((resolve, reject) => {
      const job = {
        text,
        modelId,
        config,
        resolve,
        reject,
        requestId: config.requestId ?? null,
        interactive: isInteractiveRequest(config),
        preempted: false,
        cancelled: false,
      };
      const waiting = this.isProcessing || this.queue.length > 0;
      this._insert(job);
      if (waiting) this._notify(job, "queued");
      // One llama-server. A dictation does not wait out a summary that is
      // already generating: that call is aborted and run again afterwards.
      if (
        job.interactive &&
        this.activeJob &&
        !this.activeJob.interactive &&
        !this.activeJob.cancelled
      ) {
        this.activeJob.preempted = true;
        modelManager.cancelInference();
      }
      this._kick();
    });
  }

  _insert(job) {
    if (job.interactive) this._insertBeforeBackground(job);
    else this.queue.push(job);
  }

  // Ahead of summaries that have not started, behind dictation already waiting.
  _insertBeforeBackground(job) {
    const index = this.queue.findIndex((queued) => !queued.interactive);
    if (index === -1) this.queue.push(job);
    else this.queue.splice(index, 0, job);
  }

  _kick() {
    if (this.isProcessing || this.queue.length === 0) return;
    this._start(this.queue.shift());
  }

  _start(job) {
    this.isProcessing = true;
    this.activeJob = job;
    this.activeRequestId = job.requestId;
    this._notify(job, "running");
    this._run(job)
      .then(
        (result) => {
          if (job.cancelled) {
            job.reject(this._cancelledError());
            return;
          }
          job.preempted = false;
          job.resolve(result);
        },
        (error) => {
          if (job.cancelled) {
            job.reject(error?.code ? error : this._cancelledError());
            return;
          }
          if (job.preempted) {
            job.preempted = false;
            this._insertBeforeBackground(job);
            this._notify(job, "queued");
            return;
          }
          job.reject(error);
        }
      )
      .finally(() => {
        if (this.activeJob !== job) return;
        this.isProcessing = false;
        this.activeJob = null;
        this.activeRequestId = null;
        this._kick();
      });
  }

  async _run(job) {
    const { text, modelId, config } = job;
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
        responseFormat: config.responseFormat,
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
      let cleanResult = result;
      // Thinking tags inside a JSON string are document data. The caller
      // validates the complete envelope instead of stripping anything from it.
      if (!config.responseFormat) {
        const stripThinking = config.disableThinking !== false;
        cleanResult = stripThinking
          ? (await import("../helpers/stripThinking.js")).stripThinkingTags(result)
          : result.trim();
      }

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
  }

  _notify(job, state) {
    if (typeof job.config?.onQueueState !== "function") return;
    try {
      job.config.onQueueState(state);
    } catch (error) {
      debugLogger.debug("Local reasoning queue listener failed", { error: error.message });
    }
  }

  _cancelledError() {
    return Object.assign(new Error("Cancelled"), { code: "CANCELLED" });
  }

  // A queued note can be dropped before it starts. Only the caller that tagged
  // the in-flight request can abort it, so a cancelled note never kills a
  // dictation cleanup that took the slot after it.
  cancel(requestId) {
    if (!requestId) return;
    const index = this.queue.findIndex((job) => job.requestId === requestId);
    if (index !== -1) {
      const [job] = this.queue.splice(index, 1);
      job.cancelled = true;
      job.reject(this._cancelledError());
      return;
    }
    if (this.activeJob && this.activeJob.requestId === requestId) {
      this.activeJob.cancelled = true;
      this.activeJob.preempted = false;
      modelManager.cancelInference();
    }
  }

  calculateMaxTokens(textLength, minTokens = 512, maxTokens = 2048, multiplier = 2) {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }
}

module.exports = {
  default: new LocalReasoningService(),
};
