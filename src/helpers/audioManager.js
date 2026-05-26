import ReasoningService from "../services/ReasoningService";
import logger from "../utils/logger";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import { withSessionRefresh } from "../lib/auth";
import { getBaseLanguageCode } from "../utils/languageSupport";
import {
  createLocalSpeechGateState,
  getLocalSpeechGateDecision,
  recordLocalSpeechWindow,
} from "./localSpeechGate";
import { getSettings, getEffectiveCleanupModel, isCloudCleanupMode } from "../stores/settingsStore";
import { detectAgentName } from "../config/agentDetection";
import { resolvePrompt } from "../config/prompts";
import { syncService } from "../services/SyncService.js";

const REASONING_CACHE_TTL = 30000; // 30 seconds

function resolveReasoningRoute(text, settings, agentName) {
  const cleanupReachable =
    !!settings.useCleanupModel && (!!settings.cleanupModel?.trim() || isCloudCleanupMode());
  const agentModel = settings.dictationAgentModel?.trim() || "";
  const agentReachable = !!settings.useDictationAgent && agentModel.length > 0;
  if (!cleanupReachable && !agentReachable) return { kind: "skip" };

  const invoked = !!agentName && detectAgentName(text, agentName);
  if (agentReachable && invoked) {
    const provider = settings.dictationAgentProvider?.trim() || undefined;
    const isSelfHostedAgent =
      settings.dictationAgentMode === "self-hosted" && !!settings.dictationAgentRemoteUrl;
    const isCustomAgent = settings.dictationAgentMode === "providers" && provider === "custom";
    return {
      kind: "agent",
      model: agentModel,
      config: {
        provider,
        lanUrl: isSelfHostedAgent ? settings.dictationAgentRemoteUrl : undefined,
        baseUrl: isCustomAgent ? settings.dictationAgentCloudBaseUrl || undefined : undefined,
        customApiKey:
          isCustomAgent || isSelfHostedAgent
            ? settings.dictationAgentCustomApiKey || undefined
            : undefined,
        disableThinking: settings.dictationAgentDisableThinking,
        systemPrompt: resolvePrompt("dictationAgent", {
          agentName,
          language: settings.preferredLanguage,
          customDictionary: settings.customDictionary,
          uiLanguage: settings.uiLanguage,
        }),
      },
    };
  }
  if (cleanupReachable) {
    return {
      kind: "cleanup",
      config: { disableThinking: settings.cleanupDisableThinking },
    };
  }
  return { kind: "skip" };
}

const PLACEHOLDER_KEYS = {
  openai: "your_openai_api_key_here",
  groq: "your_groq_api_key_here",
  mistral: "your_mistral_api_key_here",
};

const isValidApiKey = (key, provider = "openai") => {
  if (!key || key.trim() === "") return false;
  const placeholder = PLACEHOLDER_KEYS[provider] || PLACEHOLDER_KEYS.openai;
  return key !== placeholder;
};

const STREAMING_PROVIDERS = {
  "corti-realtime": {
    warmup: () => Promise.resolve({ success: true, alreadyWarm: false }),
    start: (opts) => window.electronAPI.cortiStreamingStart(opts),
    send: (buf) => window.electronAPI.cortiStreamingSend(buf),
    finalize: () => {}, // flush is sent automatically on stop
    // No post-finalize wait: disconnect() sends the flush and awaits the
    // server's `flushed` reply directly, so an extra setTimeout here is dead time.
    finalizeWaitMs: 0,
    stop: () => window.electronAPI.cortiStreamingStop(),
    status: () => window.electronAPI.cortiStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onCortiPartialTranscript(cb),
    onFinal: (cb) => {
      const subscribe =
        window.electronAPI.onCortiFinalTranscript || window.electronAPI.onCortiiFinalTranscript;
      return typeof subscribe === "function" ? subscribe(cb) : () => {};
    },
    onError: (cb) => window.electronAPI.onCortiError(cb),
    onSessionEnd: (cb) => window.electronAPI.onCortiSessionEnd(cb),
  },
};

class AudioManager {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.isProcessing = false;
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.recordingStartTime = null;
    this.reasoningAvailabilityCache = { value: false, expiresAt: 0 };
    this.cachedReasoningPreference = null;
    this.isStreaming = false;
    this.streamingAudioContext = null;
    this.streamingSource = null;
    this.streamingProcessor = null;
    this.streamingStream = null;
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextResolve = null;
    this.streamingTextDebounce = null;
    this.cachedMicDeviceId = null;
    this.persistentAudioContext = null;
    this.workletModuleLoaded = false;
    this.workletBlobUrl = null;
    this.streamingStartInProgress = false;
    this.stopRequestedDuringStreamingStart = false;
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    this.skipReasoning = false;
    this.context = "dictation";
    this.sttConfig = null;
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    this._localSpeechGateState = null;
    this._previewAudioContext = null;
    this._previewSource = null;
    this._previewProcessor = null;
    this._previewEventCleanupFns = [];
    this._previewTranscript = "";
  }

  getWorkletBlobUrl() {
    if (this.workletBlobUrl) return this.workletBlobUrl;
    const code = `
const BUFFER_SIZE = 800;
class PCMStreamingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(BUFFER_SIZE);
    this._offset = 0;
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this.port.postMessage(partial.buffer, [partial.buffer]);
          this._buffer = new Int16Array(BUFFER_SIZE);
          this._offset = 0;
        }
        this._stopped = true;
      }
    };
  }
  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= BUFFER_SIZE) {
        this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-streaming-processor", PCMStreamingProcessor);
`;
    this.workletBlobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    return this.workletBlobUrl;
  }

  getCustomDictionaryPrompt() {
    const words = getSettings().customDictionary;
    return words.length > 0 ? words.join(", ") : null;
  }

  setCallbacks({
    onStateChange,
    onError,
    onTranscriptionComplete,
    onPartialTranscript,
    onStreamingCommit,
  }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onTranscriptionComplete = onTranscriptionComplete;
    this.onPartialTranscript = onPartialTranscript;
    this.onStreamingCommit = onStreamingCommit;
  }

  setSkipReasoning(skip) {
    this.skipReasoning = skip;
  }

  setContext(context) {
    this.context = context;
  }

  setSttConfig(config) {
    this.sttConfig = config;
  }

  async startPreviewCapture(micStream, { provider, model, language } = {}) {
    const settings = getSettings();
    if (!settings.showTranscriptionPreview) return false;
    if (
      !window.electronAPI?.startDictationPreview ||
      !window.electronAPI?.sendDictationPreviewAudio
    ) {
      return false;
    }

    try {
      this.cleanupPreview({ dismiss: true });

      const result = await window.electronAPI.startDictationPreview({
        provider,
        model,
        ...(language ? { language } : {}),
        insertTextContinuously: settings.insertTextContinuously,
      });
      if (!result?.success) return false;

      this._previewTranscript = "";

      // corti-realtime drives the overlay directly from main process via the
      // streaming WebSocket — no preview audio pipeline needed, and the main
      // process drops dictation-preview-audio frames for this provider anyway.
      if (provider !== "corti-realtime") {
        const eventCleanups = [
          window.electronAPI?.onPreviewText?.((text) => {
            this._previewTranscript = typeof text === "string" ? text : "";
            this.onPartialTranscript?.(this._previewTranscript);
          }),
          window.electronAPI?.onPreviewAppend?.((text) => {
            const chunk = typeof text === "string" ? text.trim() : "";
            if (!chunk) return;
            this._previewTranscript = this._previewTranscript
              ? `${this._previewTranscript} ${chunk}`
              : chunk;
            this.onPartialTranscript?.(this._previewTranscript);
          }),
          window.electronAPI?.onPreviewHide?.(() => {
            this._previewTranscript = "";
            this.onPartialTranscript?.("");
          }),
        ].filter(Boolean);
        this._previewEventCleanupFns = eventCleanups;

        const previewContext = new AudioContext({ sampleRate: 16000 });
        await previewContext.audioWorklet.addModule(this.getWorkletBlobUrl());

        const previewSource = previewContext.createMediaStreamSource(micStream);
        const previewProcessor = new AudioWorkletNode(previewContext, "pcm-streaming-processor");

        previewProcessor.port.onmessage = (event) => {
          window.electronAPI?.sendDictationPreviewAudio?.(event.data);
        };

        previewSource.connect(previewProcessor);

        this._previewAudioContext = previewContext;
        this._previewSource = previewSource;
        this._previewProcessor = previewProcessor;
      }
      return true;
    } catch (error) {
      logger.debug("Failed to start dictation preview capture", { error: error.message }, "audio");
      this.cleanupPreview({ dismiss: true });
      return false;
    }
  }

  getStreamingProvider() {
    return STREAMING_PROVIDERS["corti-realtime"];
  }

  getStreamingProviderName() {
    return "corti-realtime";
  }

  async getAudioConstraints() {
    const { preferBuiltInMic: preferBuiltIn, selectedMicDeviceId: selectedDeviceId } =
      getSettings();

    // All browser audio processing disabled to avoid OS-level side-effects.
    // AGC off: Chromium's AGC on Windows mutates the system mic volume via WASAPI (#476).
    // Echo cancellation and noise suppression off to avoid latency and speech distortion.
    // Stereo recording required — mono WebM breaks silence detection on Linux/PipeWire (#472).
    const noProcessing = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    };

    if (preferBuiltIn) {
      if (this.cachedMicDeviceId) {
        logger.debug(
          "Using cached microphone device ID",
          { deviceId: this.cachedMicDeviceId },
          "audio"
        );
        return { audio: { deviceId: { exact: this.cachedMicDeviceId }, ...noProcessing } };
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");
        const builtInMic = audioInputs.find((d) => isBuiltInMicrophone(d.label));

        if (builtInMic) {
          this.cachedMicDeviceId = builtInMic.deviceId;
          logger.debug(
            "Using built-in microphone (cached for next time)",
            { deviceId: builtInMic.deviceId, label: builtInMic.label },
            "audio"
          );
          return { audio: { deviceId: { exact: builtInMic.deviceId }, ...noProcessing } };
        }
      } catch (error) {
        logger.debug(
          "Failed to enumerate devices for built-in mic detection",
          { error: error.message },
          "audio"
        );
      }
    }

    if (!preferBuiltIn && selectedDeviceId) {
      logger.debug("Using selected microphone", { deviceId: selectedDeviceId }, "audio");
      return { audio: { deviceId: { exact: selectedDeviceId }, ...noProcessing } };
    }

    logger.debug("Using default microphone", {}, "audio");
    return { audio: noProcessing };
  }

  async cacheMicrophoneDeviceId() {
    if (this.cachedMicDeviceId) return; // Already cached

    if (!getSettings().preferBuiltInMic) return; // Only needed for built-in mic detection

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === "audioinput");
      const builtInMic = audioInputs.find((d) => isBuiltInMicrophone(d.label));
      if (builtInMic) {
        this.cachedMicDeviceId = builtInMic.deviceId;
        logger.debug("Microphone device ID pre-cached", { deviceId: builtInMic.deviceId }, "audio");
      }
    } catch (error) {
      logger.debug("Failed to pre-cache microphone device ID", { error: error.message }, "audio");
    }
  }

  async startRecording() {
    try {
      if (this.isRecording || this.isProcessing || this.mediaRecorder?.state === "recording") {
        return false;
      }

      const constraints = await this.getAudioConstraints();
      const micStream = await navigator.mediaDevices.getUserMedia(constraints);

      const audioTrack = micStream.getAudioTracks()[0];
      const preferredLanguage = getSettings().preferredLanguage;
      const previewLanguage = preferredLanguage !== "auto" ? preferredLanguage : undefined;
      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
          },
          "audio"
        );
      }

      await this.startPreviewCapture(micStream, {
        provider: "corti-rest",
        model: "corti",
        language: previewLanguage,
      });

      try {
        this._silenceCtx = new AudioContext();
        this._silenceAnalyser = this._silenceCtx.createAnalyser();
        this._silenceAnalyser.fftSize = 2048;
        const sourceNode = this._silenceCtx.createMediaStreamSource(micStream);
        sourceNode.connect(this._silenceAnalyser);
        this._localSpeechGateState = createLocalSpeechGateState();
        const dataArray = new Uint8Array(this._silenceAnalyser.fftSize);
        this._silenceInterval = setInterval(() => {
          this._silenceAnalyser.getByteTimeDomainData(dataArray);
          let sum = 0;
          let peak = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const v = (dataArray[i] - 128) / 128;
            sum += v * v;
            const abs = Math.abs(v);
            if (abs > peak) peak = abs;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          recordLocalSpeechWindow(this._localSpeechGateState, rms, peak);
        }, 100);
      } catch (e) {
        logger.warn("Audio level gate setup failed, skipping", { error: e.message }, "audio");
        this._localSpeechGateState = null;
      }

      this.mediaRecorder = new MediaRecorder(micStream);
      this.audioChunks = [];
      this.recordingStartTime = Date.now();
      this.recordingMimeType = this.mediaRecorder.mimeType || "audio/webm";

      this.mediaRecorder.ondataavailable = (event) => {
        this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = async () => {
        if (this._silenceInterval) {
          clearInterval(this._silenceInterval);
          this._silenceInterval = null;
        }
        this._silenceCtx?.close().catch(() => {});
        this._silenceCtx = null;
        this._silenceAnalyser = null;

        this.cleanupPreview({ showCleanup: this.shouldShowPreviewCleanupState() });

        this.isRecording = false;
        this.isProcessing = true;
        this.onStateChange?.({ isRecording: false, isProcessing: true });

        const audioBlob = new Blob(this.audioChunks, { type: this.recordingMimeType });
        this.lastAudioBlob = audioBlob;

        logger.info(
          "Recording stopped",
          {
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            chunksCount: this.audioChunks.length,
          },
          "audio"
        );

        const durationSeconds = this.recordingStartTime
          ? (Date.now() - this.recordingStartTime) / 1000
          : null;
        this.recordingStartTime = null;
        await this.processAudio(audioBlob, { durationSeconds });

        micStream.getTracks().forEach((track) => track.stop());
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      this.onStateChange?.({ isRecording: true, isProcessing: false });

      return true;
    } catch (error) {
      let errorTitle = "Recording Error";
      let errorDescription = `Failed to access microphone: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        errorTitle = "No Microphone Found";
        errorDescription = "No microphone was detected. Please connect a microphone and try again.";
      } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        errorTitle = "Microphone In Use";
        errorDescription =
          "The microphone is being used by another application. Please close other apps and try again.";
      }

      this.onError?.({
        title: errorTitle,
        description: errorDescription,
      });
      return false;
    }
  }

  stopRecording() {
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.stop();
      return true;
    }
    return false;
  }

  cancelRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.mediaRecorder.onstop = () => {
        this.cleanupPreview({ dismiss: true });
        this.isRecording = false;
        this.isProcessing = false;
        this.audioChunks = [];
        this.recordingStartTime = null;
        this.onStateChange?.({ isRecording: false, isProcessing: false });
      };

      this.mediaRecorder.stop();

      if (this.mediaRecorder.stream) {
        this.mediaRecorder.stream.getTracks().forEach((track) => track.stop());
      }

      return true;
    }
    return false;
  }

  cancelProcessing() {
    if (this.isProcessing) {
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      return true;
    }
    return false;
  }

  async processAudio(audioBlob, metadata = {}) {
    const pipelineStart = performance.now();
    const settings = getSettings();
    const speechGateDecision = getLocalSpeechGateDecision(this._localSpeechGateState);
    this._localSpeechGateState = null;

    if (speechGateDecision.skip && speechGateDecision.reason === "silence") {
      logger.info(
        "Speech gate skipped transcription",
        {
          reason: speechGateDecision.reason,
          peakRms: speechGateDecision.peakRms?.toFixed(4),
          peakAmplitude: speechGateDecision.peakAmplitude?.toFixed(4),
          speechWindowCount: speechGateDecision.speechWindowCount,
          maxConsecutiveSpeechWindows: speechGateDecision.maxConsecutiveSpeechWindows,
        },
        "audio"
      );
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      this.onTranscriptionComplete?.({ success: true, text: "" });
      return;
    }

    try {
      const activeModel = "corti";
      const result = await this.processWithCortiREST(audioBlob, metadata);

      if (!this.isProcessing) {
        return;
      }

      this.lastAudioMetadata = {
        durationMs: metadata?.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : Math.round(performance.now() - pipelineStart),
        provider: result?.source || "corti",
        model: activeModel,
      };

      this.onTranscriptionComplete?.(result);

      const roundTripDurationMs = Math.round(performance.now() - pipelineStart);

      logger.info(
        "Pipeline timing",
        {
          mode: "corti",
          model: activeModel,
          audioDurationMs: metadata.durationSeconds
            ? Math.round(metadata.durationSeconds * 1000)
            : null,
          reasoningProcessingDurationMs: result?.timings?.reasoningProcessingDurationMs ?? null,
          transcriptionProcessingDurationMs:
            result?.timings?.transcriptionProcessingDurationMs ?? null,
          roundTripDurationMs,
          audioSizeBytes: audioBlob.size,
          audioFormat: audioBlob.type,
          outputTextLength: result?.text?.length,
        },
        "performance"
      );
    } catch (error) {
      const errorAtMs = Math.round(performance.now() - pipelineStart);

      logger.error(
        "Pipeline failed",
        {
          errorAtMs,
          error: error.message,
        },
        "performance"
      );

      if (error.message !== "No audio detected") {
        this.onError?.({
          title: "Transcription Error",
          description: `Transcription failed: ${error.message}`,
          code: error.code,
          messageKey: error.messageKey,
        });

        // Save failed transcription with audio so the user can retry later
        if (this.lastAudioBlob) {
          this.saveFailedTranscription(error.message, error.code || null, metadata);
        }
      }
    } finally {
      if (this.isProcessing) {
        this.isProcessing = false;
        this.onStateChange?.({ isRecording: false, isProcessing: false });
      }
    }
  }

  async processWithReasoningModel(text, model, agentName, config) {
    logger.logReasoning("CALLING_REASONING_SERVICE", {
      model,
      agentName,
      textLength: text.length,
      hasOverrides: !!config,
    });

    const startTime = Date.now();

    try {
      const result = await ReasoningService.processText(text, model, agentName, config);

      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_COMPLETE", {
        model,
        processingTimeMs: processingTime,
        resultLength: result.length,
        success: true,
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_ERROR", {
        model,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
      });

      throw error;
    }
  }

  async isReasoningAvailable() {
    if (typeof window === "undefined") {
      return false;
    }

    const s = getSettings();
    const useReasoning =
      !!s.useCleanupModel || (!!s.useDictationAgent && !!s.dictationAgentModel?.trim());
    const now = Date.now();
    const cacheValid =
      this.reasoningAvailabilityCache &&
      now < this.reasoningAvailabilityCache.expiresAt &&
      this.cachedReasoningPreference === useReasoning;

    if (cacheValid) {
      return this.reasoningAvailabilityCache.value;
    }

    logger.logReasoning("REASONING_STORAGE_CHECK", {
      useReasoning,
    });

    if (!useReasoning) {
      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return false;
    }

    if (s.useCleanupModel && isCloudCleanupMode()) {
      this.reasoningAvailabilityCache = {
        value: true,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return true;
    }

    try {
      const isAvailable = await ReasoningService.isAvailable();

      logger.logReasoning("REASONING_AVAILABILITY", {
        isAvailable,
        reasoningEnabled: useReasoning,
        finalDecision: useReasoning && isAvailable,
      });

      this.reasoningAvailabilityCache = {
        value: isAvailable,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;

      return isAvailable;
    } catch (error) {
      logger.logReasoning("REASONING_AVAILABILITY_ERROR", {
        error: error.message,
        stack: error.stack,
      });

      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return false;
    }
  }

  async processTranscription(text, source) {
    const normalizedText = typeof text === "string" ? text.trim() : "";

    if (!normalizedText) {
      logger.logReasoning("TRANSCRIPTION_EMPTY_SKIPPING_REASONING", {
        source,
        reason: "Empty text after normalization",
      });
      return normalizedText;
    }

    if (this.skipReasoning) {
      logger.logReasoning("REASONING_SKIPPED_AGENT_MODE", {
        source,
        reason: "skipReasoning is set (agent mode) — returning raw transcription",
      });
      return normalizedText;
    }

    logger.logReasoning("TRANSCRIPTION_RECEIVED", {
      source,
      textLength: normalizedText.length,
      textPreview: normalizedText.substring(0, 100) + (normalizedText.length > 100 ? "..." : ""),
      timestamp: new Date().toISOString(),
    });

    const cleanupModel = getEffectiveCleanupModel();
    const isCloud = isCloudCleanupMode();
    const settings = getSettings();
    const cleanupProvider = settings.cleanupProvider || "auto";
    const hasAgentModel = !!settings.dictationAgentModel?.trim();
    const cleanupReachable = !!settings.useCleanupModel && (!!cleanupModel || isCloud);
    const agentReachable = !!settings.useDictationAgent && hasAgentModel;
    const agentName =
      typeof window !== "undefined" && window.localStorage
        ? localStorage.getItem("agentName") || null
        : null;
    if (!cleanupReachable && !agentReachable) {
      logger.logReasoning("REASONING_SKIPPED", {
        reason: "No cleanup or dictation-agent model available",
      });
      return normalizedText;
    }

    const useReasoning = await this.isReasoningAvailable();

    logger.logReasoning("REASONING_CHECK", {
      useReasoning,
      cleanupModel,
      cleanupProvider,
      agentName,
    });

    if (useReasoning) {
      try {
        const route = resolveReasoningRoute(normalizedText, getSettings(), agentName);
        if (route.kind === "skip") return normalizedText;

        const targetModel = route.kind === "agent" ? route.model : cleanupModel;
        const reasoningConfig = route.config;

        logger.logReasoning("SENDING_TO_REASONING", {
          preparedTextLength: normalizedText.length,
          model: targetModel,
          provider: route.config?.provider || cleanupProvider,
          path: route.kind,
          disableThinking: reasoningConfig?.disableThinking,
        });

        const result = await this.processWithReasoningModel(
          normalizedText,
          targetModel,
          agentName,
          reasoningConfig
        );

        logger.logReasoning("REASONING_SUCCESS", {
          resultLength: result.length,
          resultPreview: result.substring(0, 100) + (result.length > 100 ? "..." : ""),
          processingTime: new Date().toISOString(),
        });

        return result;
      } catch (error) {
        logger.logReasoning("REASONING_FAILED", {
          error: error.message,
          stack: error.stack,
          fallbackToCleanup: true,
        });
        logger.warn("Reasoning failed", { source, error: error.message }, "notes");
      }
    }

    logger.logReasoning("USING_STANDARD_CLEANUP", {
      reason: useReasoning ? "Reasoning failed" : "Reasoning not enabled",
    });

    return normalizedText;
  }

  async processWithCortiREST(audioBlob, metadata = {}) {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const settings = getSettings();
    const language =
      metadata.language ||
      (settings.preferredLanguage !== "auto" ? settings.preferredLanguage : null);

    const result = await window.electronAPI.transcribeCortiRest(arrayBuffer, { language });

    if (!result.success) {
      const err = new Error(result.error || "Corti transcription failed");
      err.code = result.code;
      throw err;
    }

    return { ...result, source: "corti-rest" };
  }

  getCustomDictionaryArray() {
    return getSettings().customDictionary;
  }

  getCustomPrompt() {
    return getSettings().customPrompts.cleanup || undefined;
  }

  getKeyterms() {
    return this.getCustomDictionaryArray();
  }


  async safePaste(text, options = {}) {
    try {
      await window.electronAPI.pasteText(text, options);
      return true;
    } catch (error) {
      const message =
        error?.message ??
        (typeof error?.toString === "function" ? error.toString() : String(error));
      this.onError?.({
        title: "Paste Error",
        description: `Failed to paste text. Please check accessibility permissions. ${message}`,
      });
      return false;
    }
  }

  async saveTranscription(text, rawText = null, { clientTranscriptionId } = {}) {
    if (!getSettings().dataRetentionEnabled) {
      logger.debug("Skipping transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return true;
    }

    try {
      const result = await window.electronAPI.saveTranscription(text, rawText, {
        clientTranscriptionId,
      });
      if (result?.id) syncService.debouncedPush("transcription", result.id);

      // Save audio if we have a captured blob and the transcription was saved successfully
      if (result?.id && this.lastAudioBlob) {
        try {
          const arrayBuffer = await this.lastAudioBlob.arrayBuffer();
          await window.electronAPI.saveTranscriptionAudio(
            result.id,
            arrayBuffer,
            this.lastAudioMetadata
          );
        } catch (audioErr) {
          // Non-blocking: transcription is saved even if audio save fails
          logger.warn("Failed to save transcription audio", { error: audioErr.message }, "audio");
        }
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  async saveFailedTranscription(errorMessage, errorCode = null, metadata = {}) {
    if (!getSettings().dataRetentionEnabled) {
      logger.debug("Skipping failed transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return;
    }

    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        status: "failed",
        errorMessage,
        errorCode,
      });
      if (result?.id) syncService.debouncedPush("transcription", result.id);

      if (result?.id && this.lastAudioBlob) {
        try {
          const durationMs = metadata?.durationSeconds
            ? Math.round(metadata.durationSeconds * 1000)
            : null;
          const arrayBuffer = await this.lastAudioBlob.arrayBuffer();
          await window.electronAPI.saveTranscriptionAudio(result.id, arrayBuffer, {
            durationMs,
            provider: null,
            model: null,
          });
        } catch (audioErr) {
          logger.warn(
            "Failed to save audio for failed transcription",
            {
              error: audioErr.message,
            },
            "audio"
          );
        }
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }
    } catch (error) {
      logger.error(
        "Failed to save failed transcription record",
        {
          error: error.message,
        },
        "audio"
      );
    }
  }

  getState() {
    return {
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStreaming: this.isStreaming,
      isStreamingStartInProgress: this.streamingStartInProgress,
    };
  }

  shouldUseStreaming() {
    const mode = getSettings().cortiTranscriptionMode || "websocket";
    return mode === "websocket";
  }

  async warmupStreamingConnection() {
    if (!this.shouldUseStreaming()) {
      logger.debug("Streaming warmup skipped - not in streaming mode", {}, "streaming");
      return false;
    }

    try {
      const provider = this.getStreamingProvider();
      const [, wsResult] = await Promise.all([
        this.cacheMicrophoneDeviceId(),
        (async () => {
          const { preferredLanguage: warmupLang } = getSettings();
          const res = await provider.warmup({
            sampleRate: 16000,
            language: warmupLang && warmupLang !== "auto" ? warmupLang : undefined,
            keyterms: this.getKeyterms(),
          });
          return res || { success: true, alreadyWarm: false };
        })(),
      ]);

      if (wsResult.success) {
        // Pre-load AudioWorklet module so first recording is faster
        try {
          const audioContext = await this.getOrCreateAudioContext();
          if (!this.workletModuleLoaded) {
            await audioContext.audioWorklet.addModule(this.getWorkletBlobUrl());
            this.workletModuleLoaded = true;
            logger.debug("AudioWorklet module pre-loaded during warmup", {}, "streaming");
          }
        } catch (e) {
          logger.debug(
            "AudioWorklet pre-load failed (will retry on recording)",
            { error: e.message },
            "streaming"
          );
        }

        // Warm up the OS audio driver by briefly acquiring the mic, then releasing.
        // This forces macOS to initialize the audio subsystem so subsequent
        // getUserMedia calls resolve in ~100-200ms instead of ~500-1000ms.
        if (!this.micDriverWarmedUp) {
          try {
            const constraints = await this.getAudioConstraints();
            const tempStream = await navigator.mediaDevices.getUserMedia(constraints);
            tempStream.getTracks().forEach((track) => track.stop());
            this.micDriverWarmedUp = true;
            logger.debug("Microphone driver pre-warmed", {}, "streaming");
          } catch (e) {
            logger.debug(
              "Mic driver warmup failed (non-critical)",
              { error: e.message },
              "streaming"
            );
          }
        }

        logger.info(
          "Streaming connection warmed up",
          { alreadyWarm: wsResult.alreadyWarm, micCached: !!this.cachedMicDeviceId },
          "streaming"
        );
        return true;
      } else if (wsResult.code === "NO_API") {
        logger.debug("Streaming warmup skipped - API not configured", {}, "streaming");
        return false;
      } else {
        logger.warn("Streaming warmup failed", { error: wsResult.error }, "streaming");
        return false;
      }
    } catch (error) {
      logger.error("Streaming warmup error", { error: error.message }, "streaming");
      return false;
    }
  }

  async getOrCreateAudioContext() {
    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      if (this.persistentAudioContext.state === "suspended") {
        await this.persistentAudioContext.resume();
      }
      return this.persistentAudioContext;
    }
    this.persistentAudioContext = new AudioContext({ sampleRate: 16000 });
    this.workletModuleLoaded = false;
    return this.persistentAudioContext;
  }

  async startStreamingRecording() {
    try {
      if (this.streamingStartInProgress) {
        return false;
      }
      this.streamingStartInProgress = true;

      if (this.isRecording || this.isStreaming || this.isProcessing) {
        this.streamingStartInProgress = false;
        return false;
      }

      this.stopRequestedDuringStreamingStart = false;

      const t0 = performance.now();
      const constraints = await this.getAudioConstraints();
      const tConstraints = performance.now();

      // 1. Get mic stream (can take 10-15s on cold macOS mic driver)
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const tMedia = performance.now();

      const audioTrack = stream.getAudioTracks()[0];
      const preferredLanguage = getSettings().preferredLanguage;
      const previewLanguage = preferredLanguage !== "auto" ? preferredLanguage : undefined;
      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Streaming recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            usedCachedId: !!this.cachedMicDeviceId,
          },
          "audio"
        );
      }

      await this.startPreviewCapture(stream, {
        provider: "corti-realtime",
        model: "corti",
        language: previewLanguage,
      });

      // Start fallback recorder in case streaming produces no results
      try {
        this.streamingFallbackChunks = [];
        this.streamingFallbackRecorder = new MediaRecorder(stream);
        this.streamingFallbackRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) this.streamingFallbackChunks.push(e.data);
        };
        this.streamingFallbackRecorder.start();
      } catch (e) {
        logger.debug("Fallback recorder failed to start", { error: e.message }, "streaming");
        this.streamingFallbackRecorder = null;
      }

      // 2. Set up audio pipeline so frames flow the instant WebSocket is ready.
      //    Frames sent before the WebSocket is ready are buffered (Corti) or
      //    silently dropped (other providers); Corti flushes the buffer in
      //    FIFO order on CONFIG_ACCEPTED so no leading audio is lost.
      const audioContext = await this.getOrCreateAudioContext();
      this.streamingAudioContext = audioContext;
      this.streamingSource = audioContext.createMediaStreamSource(stream);
      this.streamingStream = stream;

      if (!this.workletModuleLoaded) {
        await audioContext.audioWorklet.addModule(this.getWorkletBlobUrl());
        this.workletModuleLoaded = true;
      }

      this.streamingProcessor = new AudioWorkletNode(audioContext, "pcm-streaming-processor");
      const provider = this.getStreamingProvider();

      this.streamingProcessor.port.onmessage = (event) => {
        if (!this.isStreaming) return;
        provider.send(event.data);
      };

      this.isStreaming = true;
      this.streamingSource.connect(this.streamingProcessor);

      const tPipeline = performance.now();

      // 3. Register IPC event listeners BEFORE connecting, so no transcript
      //    events are lost during the connect handshake.
      this.streamingFinalText = "";
      this.streamingPartialText = "";
      this.streamingTextResolve = null;
      this.streamingTextDebounce = null;

      const partialCleanup = provider.onPartial((text) => {
        this.streamingPartialText = text;
        this.onPartialTranscript?.(text);
      });

      const finalCleanup = provider.onFinal((text) => {
        // text = accumulated final text from streaming provider.
        // Extract just the new segment (delta from previous accumulated final).
        const prevLen = this.streamingFinalText.length;
        this.streamingFinalText = text;
        this.streamingPartialText = "";
        const newSegment = text.slice(prevLen);
        if (newSegment) {
          this.onStreamingCommit?.(newSegment);
        }
      });

      const errorCleanup = provider.onError((error) => {
        logger.error("Streaming provider error", { error }, "streaming");
        this.onError?.({
          title: "Streaming Error",
          description: error,
        });
        if (this.isStreaming) {
          logger.warn("Connection lost during streaming, auto-stopping", {}, "streaming");
          this.stopStreamingRecording().catch((e) => {
            logger.error(
              "Auto-stop after connection loss failed",
              { error: e.message },
              "streaming"
            );
          });
        }
      });

      const sessionEndCleanup = provider.onSessionEnd((data) => {
        logger.debug("Streaming session ended", data, "streaming");
        if (data.text) {
          this.streamingFinalText = data.text;
        }
      });

      this.streamingCleanupFns = [partialCleanup, finalCleanup, errorCleanup, sessionEndCleanup];
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this.onStateChange?.({ isRecording: true, isProcessing: false, isStreaming: true });

      // 4. Connect WebSocket — audio is already flowing from the pipeline above,
      //    so Corti receives data immediately (no idle timeout).
      const result = await (async () => {
        const { preferredLanguage: preferredLang } = getSettings();
        const res = await provider.start({
          sampleRate: 16000,
          language: preferredLang && preferredLang !== "auto" ? preferredLang : undefined,
          keyterms: this.getKeyterms(),
        });

        if (!res.success) {
          if (res.code === "NO_API") {
            return { needsFallback: true };
          }
          const err = new Error(res.error || "Failed to start streaming session");
          err.code = res.code;
          err.messageKey = res.messageKey;
          err.networkCode = res.networkCode;
          throw err;
        }
        return res;
      })();
      const tWs = performance.now();

      if (result.needsFallback) {
        this.isRecording = false;
        this.recordingStartTime = null;
        this.stopRequestedDuringStreamingStart = false;
        await this.cleanupStreaming();
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
        this.streamingStartInProgress = false;
        logger.debug(
          "Streaming API not configured, falling back to regular recording",
          {},
          "streaming"
        );
        return this.startRecording();
      }

      logger.info(
        "Streaming start timing",
        {
          constraintsMs: Math.round(tConstraints - t0),
          getUserMediaMs: Math.round(tMedia - tConstraints),
          pipelineMs: Math.round(tPipeline - tMedia),
          wsConnectMs: Math.round(tWs - tPipeline),
          totalMs: Math.round(tWs - t0),
          usedWarmConnection: result.usedWarmConnection,
          micDriverWarmedUp: !!this.micDriverWarmedUp,
        },
        "streaming"
      );

      this.streamingStartInProgress = false;
      if (this.stopRequestedDuringStreamingStart) {
        this.stopRequestedDuringStreamingStart = false;
        logger.debug("Applying deferred streaming stop requested during startup", {}, "streaming");
        return this.stopStreamingRecording();
      }
      return true;
    } catch (error) {
      this.streamingStartInProgress = false;
      this.stopRequestedDuringStreamingStart = false;
      logger.error(
        "Failed to start streaming recording",
        {
          message: error?.message,
          name: error?.name,
          code: error?.code,
          stack: error?.stack,
          raw: typeof error === "object" ? JSON.stringify(error) : String(error),
        },
        "streaming"
      );

      let errorTitle = "Streaming Error";
      let errorDescription = `Failed to start streaming: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.code === "AUTH_EXPIRED" || error.code === "AUTH_REQUIRED") {
        errorTitle = "Sign-in Required";
        errorDescription =
          "Your OpenWhispr Cloud session is unavailable. Please sign in again from Settings.";
      } else if (error.code === "NETWORK_ERROR") {
        errorTitle = "streaming.errors.cloudUnreachable.title";
        errorDescription = error.messageKey || "streaming.errors.cloudUnreachable.generic";
      }

      this.onError?.({
        code: error.code,
        messageKey: error.messageKey,
        title: errorTitle,
        description: errorDescription,
      });

      await this.cleanupStreaming();
      this.isRecording = false;
      this.recordingStartTime = null;
      this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
      return false;
    }
  }

  async stopStreamingRecording() {
    if (this.streamingStartInProgress) {
      this.stopRequestedDuringStreamingStart = true;
      logger.debug("Streaming stop requested while start is in progress", {}, "streaming");
      return true;
    }

    if (!this.isStreaming) return false;

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;

    const t0 = performance.now();
    let finalText = this.streamingFinalText || "";

    // 1. Update UI immediately
    this.isRecording = false;
    this.recordingStartTime = null;
    this.cleanupPreview({ showCleanup: this.shouldShowPreviewCleanupState() });
    this.onStateChange?.({ isRecording: false, isProcessing: true, isStreaming: false });

    // 2. Stop the processor — it flushes its remaining buffer on "stop".
    //    Keep isStreaming TRUE so the port.onmessage handler forwards the flush to WebSocket.
    if (this.streamingProcessor) {
      try {
        this.streamingProcessor.port.postMessage("stop");
        this.streamingProcessor.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingProcessor = null;
    }
    if (this.streamingSource) {
      try {
        this.streamingSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingSource = null;
    }
    this.streamingAudioContext = null;

    // Stop fallback recorder before stopping media tracks
    let fallbackBlob = null;
    if (this.streamingFallbackRecorder?.state === "recording") {
      fallbackBlob = await new Promise((resolve) => {
        this.streamingFallbackRecorder.onstop = () => {
          const mimeType = this.streamingFallbackRecorder.mimeType || "audio/webm";
          resolve(new Blob(this.streamingFallbackChunks, { type: mimeType }));
        };
        this.streamingFallbackRecorder.stop();
      });
    }
    if (fallbackBlob) {
      this.lastAudioBlob = fallbackBlob;
    }
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];

    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
    }
    const tAudioCleanup = performance.now();

    // 3. Wait for flushed buffer to travel: port -> main thread -> IPC -> WebSocket -> server.
    //    Then mark streaming done so no further audio is forwarded.
    await new Promise((resolve) => setTimeout(resolve, 120));
    this.isStreaming = false;

    // 4. Finalize tells the provider to process any buffered audio and send final results.
    //    Wait briefly so the server sends back the finalized transcript before disconnect.
    //    Providers whose finalize is a no-op (e.g. Corti — flush is sent inside stop())
    //    can opt out via finalizeWaitMs: 0 to avoid dead time.
    const provider = this.getStreamingProvider();
    provider.finalize?.();
    const finalizeWaitMs = provider.finalizeWaitMs ?? 300;
    if (finalizeWaitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, finalizeWaitMs));
    }
    const tForceEndpoint = performance.now();

    const stopResult = await provider.stop().catch((e) => {
      logger.debug("Streaming disconnect error", { error: e.message }, "streaming");
      return { success: false };
    });
    const tTerminate = performance.now();

    finalText = this.streamingFinalText || "";

    if (!finalText && this.streamingPartialText) {
      finalText = this.streamingPartialText;
      logger.debug("Using partial text as fallback", { textLength: finalText.length }, "streaming");
    }

    if (!finalText && stopResult?.text) {
      finalText = stopResult.text;
      logger.debug(
        "Using disconnect result text as fallback",
        { textLength: finalText.length },
        "streaming"
      );
    }

    this.cleanupStreamingListeners();

    logger.info(
      "Streaming stop timing",
      {
        durationSeconds,
        audioCleanupMs: Math.round(tAudioCleanup - t0),
        flushWaitMs: Math.round(tForceEndpoint - tAudioCleanup),
        terminateRoundTripMs: Math.round(tTerminate - tForceEndpoint),
        totalStopMs: Math.round(tTerminate - t0),
        textLength: finalText.length,
      },
      "streaming"
    );

    const stSettings = getSettings();
    const streamingSttModel = stopResult?.model || "nova-3";
    const streamingSttProcessingMs = Math.round(tTerminate - t0);
    const streamingAudioBytesSent = stopResult?.audioBytesSent || 0;
    const streamingSttLanguage = getBaseLanguageCode(stSettings.preferredLanguage) || undefined;
    const streamingSttWordCount = finalText ? finalText.split(/\s+/).filter(Boolean).length : 0;

    let usedCloudReasoning = false;
    if (finalText && !this.skipReasoning) {
      const reasoningStart = performance.now();
      const agentName = localStorage.getItem("agentName") || null;
      const route = resolveReasoningRoute(finalText, stSettings, agentName);
      const cleanupCloudMode = stSettings.cleanupCloudMode || "openwhispr";

      try {
        if (route.kind === "agent") {
          const reasoned = await this.processWithReasoningModel(
            finalText,
            route.model,
            agentName,
            route.config
          );
          if (reasoned) finalText = reasoned;
          logger.info(
            "Streaming dictation-agent complete",
            { reasoningDurationMs: Math.round(performance.now() - reasoningStart) },
            "streaming"
          );
        } else if (route.kind === "cleanup" && cleanupCloudMode === "openwhispr") {
          const reasonResult = await withSessionRefresh(async () => {
            const res = await window.electronAPI.cloudReason(finalText, {
              agentName,
              customDictionary: stSettings.customDictionary,
              customPrompt: this.getCustomPrompt(),
              language: stSettings.preferredLanguage || "auto",
              locale: stSettings.uiLanguage || "en",
              sttProvider: this.getStreamingProviderName(),
              sttModel: streamingSttModel,
              sttProcessingMs: streamingSttProcessingMs,
              sttWordCount: streamingSttWordCount,
              sttLanguage: streamingSttLanguage,
              audioDurationMs: durationSeconds ? Math.round(durationSeconds * 1000) : undefined,
              audioSizeBytes: streamingAudioBytesSent || undefined,
              audioFormat: "linear16",
            });
            if (!res.success) {
              const err = new Error(res.error || "Cloud reasoning failed");
              err.code = res.code;
              throw err;
            }
            return res;
          });

          if (reasonResult.success && reasonResult.text) {
            finalText = reasonResult.text;
          }
          usedCloudReasoning = true;

          logger.info(
            "Streaming reasoning complete",
            {
              reasoningDurationMs: Math.round(performance.now() - reasoningStart),
              model: reasonResult.model,
            },
            "streaming"
          );
        } else if (route.kind === "cleanup") {
          const effectiveModel = getEffectiveCleanupModel();
          if (effectiveModel) {
            const reasoned = await this.processWithReasoningModel(
              finalText,
              effectiveModel,
              agentName,
              route.config
            );
            if (reasoned) finalText = reasoned;
            logger.info(
              "Streaming BYOK reasoning complete",
              { reasoningDurationMs: Math.round(performance.now() - reasoningStart) },
              "streaming"
            );
          }
        }
      } catch (reasonError) {
        logger.error(
          "Streaming reasoning failed, using raw text",
          { error: reasonError.message },
          "streaming"
        );
      }
    }

    // If streaming produced no text, fall back to Corti REST batch transcription
    if (!finalText && durationSeconds > 2 && fallbackBlob?.size > 0) {
      logger.info(
        "Streaming produced no text, falling back to Corti REST transcription",
        { durationSeconds, blobSize: fallbackBlob.size },
        "streaming"
      );
      try {
        const batchResult = await this.processWithCortiREST(fallbackBlob, { durationSeconds });
        if (batchResult?.text) {
          finalText = batchResult.text;
          logger.info("Batch fallback succeeded", { textLength: finalText.length }, "streaming");
        }
      } catch (fallbackErr) {
        logger.error("Batch fallback failed", { error: fallbackErr.message }, "streaming");
      }
    }

    if (finalText) {
      const tBeforePaste = performance.now();
      const clientTotalMs = Math.round(tBeforePaste - t0);
      this.lastAudioMetadata = {
        durationMs: durationSeconds
          ? Math.round(durationSeconds * 1000)
          : Math.round(tBeforePaste - t0),
        provider: `${this.getStreamingProviderName()}-streaming`,
        model: streamingSttModel || null,
      };
      this.onTranscriptionComplete?.({
        success: true,
        text: finalText,
        rawText: finalText,
        source: `${this.getStreamingProviderName()}-streaming`,
      });

      logger.info(
        "Streaming total processing",
        {
          totalProcessingMs: Math.round(tBeforePaste - t0),
          hasReasoning: stSettings.useCleanupModel || stSettings.useDictationAgent,
        },
        "streaming"
      );
    } else {
      // Silence: still fire callback so media playback resumes.
      this.onTranscriptionComplete?.({ success: true, text: "" });
    }

    this.isProcessing = false;
    this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });

    if (this.shouldUseStreaming()) {
      this.warmupStreamingConnection().catch((e) => {
        logger.debug("Background re-warm failed", { error: e.message }, "streaming");
      });
    }

    return true;
  }

  shouldShowPreviewCleanupState() {
    const settings = getSettings();
    return (!!settings.useCleanupModel || !!settings.useDictationAgent) && !this.skipReasoning;
  }

  cleanupPreview(options = {}) {
    const { dismiss = false, showCleanup = false } = options;

    for (const cleanup of this._previewEventCleanupFns) {
      try {
        cleanup?.();
      } catch {
        // Ignore cleanup errors for preview listeners
      }
    }
    this._previewEventCleanupFns = [];
    this._previewTranscript = "";

    if (this._previewProcessor) {
      this._previewProcessor.port.postMessage("stop");
      this._previewProcessor.disconnect();
      this._previewProcessor = null;
    }
    if (this._previewSource) {
      this._previewSource.disconnect();
      this._previewSource = null;
    }
    if (this._previewAudioContext) {
      this._previewAudioContext.close().catch(() => {});
      this._previewAudioContext = null;
    }
    if (dismiss) {
      window.electronAPI?.dismissDictationPreview?.();
      return;
    }
    window.electronAPI?.stopDictationPreview?.({ showCleanup });
  }

  cleanupStreamingAudio() {
    if (this.streamingFallbackRecorder?.state === "recording") {
      try {
        this.streamingFallbackRecorder.stop();
      } catch {}
    }
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];

    if (this.streamingProcessor) {
      try {
        this.streamingProcessor.port.postMessage("stop");
        this.streamingProcessor.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingProcessor = null;
    }

    if (this.streamingSource) {
      try {
        this.streamingSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingSource = null;
    }

    this.streamingAudioContext = null;

    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
    }

    this.isStreaming = false;
  }

  cleanupStreamingListeners() {
    for (const cleanup of this.streamingCleanupFns) {
      try {
        cleanup?.();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextResolve = null;
    clearTimeout(this.streamingTextDebounce);
    this.streamingTextDebounce = null;
  }

  async cleanupStreaming() {
    this.cleanupStreamingAudio();
    this.cleanupStreamingListeners();
  }

  cleanup() {
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    if (this.isStreaming) {
      this.cleanupStreaming();
    }
    if (this.mediaRecorder?.state === "recording") {
      this.stopRecording();
    }
    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      this.persistentAudioContext.close().catch(() => {});
      this.persistentAudioContext = null;
      this.workletModuleLoaded = false;
    }
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    try {
      this.getStreamingProvider().stop?.();
    } catch (e) {
      // Ignore errors during cleanup (page may be unloading)
    }
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.onStreamingCommit = null;
  }
}

export default AudioManager;
