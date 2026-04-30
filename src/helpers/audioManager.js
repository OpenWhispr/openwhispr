import ReasoningService from "../services/ReasoningService";
import { API_ENDPOINTS, buildApiUrl, normalizeBaseUrl } from "../config/constants";
import logger from "../utils/logger";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import { isSecureEndpoint } from "../utils/urlUtils";
import { withSessionRefresh } from "../lib/auth";
import { getBaseLanguageCode, validateLanguageForModel } from "../utils/languageSupport";
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
const REALTIME_MODELS = new Set(["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]);

function resolveReasoningRoute(text, settings, agentName) {
  const cleanupReachable =
    !!settings.useCleanupModel && (!!settings.cleanupModel?.trim() || isCloudCleanupMode());
  const agentModel = settings.dictationAgentModel?.trim() || "";
  const agentReachable = !!settings.useDictationAgent && agentModel.length > 0;
  if (!cleanupReachable && !agentReachable) return { kind: "skip" };

  const invoked = !!agentName && detectAgentName(text, agentName);
  if (agentReachable && (!cleanupReachable || invoked)) {
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
        customApiKey: isCustomAgent ? settings.dictationAgentCustomApiKey || undefined : undefined,
        systemPrompt: resolvePrompt("dictationAgent", {
          agentName,
          language: settings.preferredLanguage,
          customDictionary: settings.customDictionary,
          uiLanguage: settings.uiLanguage,
        }),
      },
    };
  }
  return { kind: "cleanup" };
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
  deepgram: {
    warmup: (opts) => window.electronAPI.deepgramStreamingWarmup(opts),
    start: (opts) => window.electronAPI.deepgramStreamingStart(opts),
    send: (buf) => window.electronAPI.deepgramStreamingSend(buf),
    finalize: () => window.electronAPI.deepgramStreamingFinalize(),
    stop: () => window.electronAPI.deepgramStreamingStop(),
    status: () => window.electronAPI.deepgramStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onDeepgramPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onDeepgramFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onDeepgramError(cb),
    onSessionEnd: (cb) => window.electronAPI.onDeepgramSessionEnd(cb),
  },
  assemblyai: {
    warmup: (opts) => window.electronAPI.assemblyAiStreamingWarmup(opts),
    start: (opts) => window.electronAPI.assemblyAiStreamingStart(opts),
    send: (buf) => window.electronAPI.assemblyAiStreamingSend(buf),
    finalize: () => window.electronAPI.assemblyAiStreamingForceEndpoint(),
    stop: () => window.electronAPI.assemblyAiStreamingStop(),
    status: () => window.electronAPI.assemblyAiStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onAssemblyAiPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onAssemblyAiFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onAssemblyAiError(cb),
    onSessionEnd: (cb) => window.electronAPI.onAssemblyAiSessionEnd(cb),
  },
  "openai-realtime": {
    warmup: (opts) => window.electronAPI.dictationRealtimeWarmup(opts),
    start: (opts) => window.electronAPI.dictationRealtimeStart(opts),
    send: (buf) => window.electronAPI.dictationRealtimeSend(buf),
    stop: () => window.electronAPI.dictationRealtimeStop(),
    onPartial: (cb) => window.electronAPI.onDictationRealtimePartial(cb),
    onFinal: (cb) => window.electronAPI.onDictationRealtimeFinal(cb),
    onError: (cb) => window.electronAPI.onDictationRealtimeError(cb),
    onSessionEnd: (cb) => window.electronAPI.onDictationRealtimeSessionEnd(cb),
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
    this.cachedApiKey = null;
    this.cachedApiKeyProvider = null;

    this._onApiKeyChanged = () => {
      this.cachedApiKey = null;
      this.cachedApiKeyProvider = null;
    };
    window.addEventListener("api-key-changed", this._onApiKeyChanged);
    this.cachedTranscriptionEndpoint = null;
    this.cachedEndpointProvider = null;
    this.cachedEndpointBaseUrl = null;
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

  getStreamingProvider() {
    const { cloudTranscriptionModel } = getSettings();
    if (REALTIME_MODELS.has(cloudTranscriptionModel)) {
      return STREAMING_PROVIDERS["openai-realtime"];
    }
    const defaultProvider = this.context === "notes" ? "deepgram" : "openai-realtime";
    const providerName = this.sttConfig?.streamingProvider || defaultProvider;
    return STREAMING_PROVIDERS[providerName] || STREAMING_PROVIDERS[defaultProvider];
  }

  getStreamingProviderName() {
    const defaultProvider = this.context === "notes" ? "deepgram" : "openai-realtime";
    return this.sttConfig?.streamingProvider || defaultProvider;
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

      const {
        showTranscriptionPreview,
        useLocalWhisper,
        localTranscriptionProvider,
        whisperModel,
        parakeetModel,
      } = getSettings();
      if (showTranscriptionPreview && useLocalWhisper) {
        try {
          this._previewAudioContext = new AudioContext({ sampleRate: 16000 });
          this._previewSource = this._previewAudioContext.createMediaStreamSource(micStream);
          await this._previewAudioContext.audioWorklet.addModule(this.getWorkletBlobUrl());

          this._previewProcessor = new AudioWorkletNode(
            this._previewAudioContext,
            "pcm-streaming-processor"
          );
          this._previewProcessor.port.onmessage = (event) => {
            window.electronAPI?.sendDictationPreviewAudio?.(event.data);
          };
          this._previewSource.connect(this._previewProcessor);

          const provider = localTranscriptionProvider === "nvidia" ? "nvidia" : "whisper";
          const model = provider === "nvidia" ? parakeetModel : whisperModel;
          window.electronAPI?.startDictationPreview?.({ provider, model });
        } catch (e) {
          logger.warn("Preview worklet setup failed", { error: e.message }, "audio");
        }
      }

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

    const shouldUseStrongLocalWhisperGate =
      settings.useLocalWhisper && settings.localTranscriptionProvider === "whisper";
    if (
      speechGateDecision.skip &&
      (speechGateDecision.reason === "silence" || shouldUseStrongLocalWhisperGate)
    ) {
      logger.info(
        "Speech gate skipped transcription",
        {
          reason: speechGateDecision.reason,
          useLocalWhisper: settings.useLocalWhisper,
          localProvider: settings.localTranscriptionProvider,
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
      const useLocalWhisper = settings.useLocalWhisper;
      const localProvider = settings.localTranscriptionProvider;
      const whisperModel = settings.whisperModel;
      const parakeetModel = settings.parakeetModel || "parakeet-tdt-0.6b-v3";

      const cloudTranscriptionMode = settings.cloudTranscriptionMode;
      const isSignedIn = settings.isSignedIn;

      const isOpenWhisprCloudMode = !useLocalWhisper && cloudTranscriptionMode === "openwhispr";
      const useCloud = isOpenWhisprCloudMode && isSignedIn;
      logger.debug(
        "Transcription routing",
        { useLocalWhisper, useCloud, isSignedIn, cloudTranscriptionMode },
        "transcription"
      );

      let result;
      let activeModel;
      if (useLocalWhisper) {
        if (localProvider === "nvidia") {
          activeModel = parakeetModel;
          result = await this.processWithLocalParakeet(audioBlob, parakeetModel, metadata);
        } else {
          activeModel = whisperModel;
          result = await this.processWithLocalWhisper(audioBlob, whisperModel, metadata);
        }
      } else if (isOpenWhisprCloudMode) {
        if (!isSignedIn) {
          const err = new Error(
            "OpenWhispr Cloud requires sign-in. Please sign in again or switch to BYOK mode."
          );
          err.code = "AUTH_REQUIRED";
          err.messageKey = "hooks.audioRecording.errorDescriptions.sessionExpired";
          throw err;
        }
        activeModel = "openwhispr-cloud";
        result = await this.processWithOpenWhisprCloud(audioBlob, metadata);
      } else {
        activeModel = this.getTranscriptionModel();
        result = await this.processWithOpenAIAPI(audioBlob, metadata);
      }

      if (!this.isProcessing) {
        return;
      }

      this.lastAudioMetadata = {
        durationMs: metadata?.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : Math.round(performance.now() - pipelineStart),
        provider: result?.source || (useLocalWhisper ? localProvider : "cloud"),
        model: activeModel || null,
      };

      this.onTranscriptionComplete?.(result);

      if (result?.source === "openwhispr") {
        window.dispatchEvent(new Event("usage-changed"));
      }

      const roundTripDurationMs = Math.round(performance.now() - pipelineStart);

      const timingData = {
        mode: useLocalWhisper ? `local-${localProvider}` : "cloud",
        model: activeModel,
        audioDurationMs: metadata.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : null,
        reasoningProcessingDurationMs: result?.timings?.reasoningProcessingDurationMs ?? null,
        roundTripDurationMs,
        audioSizeBytes: audioBlob.size,
        audioFormat: audioBlob.type,
        outputTextLength: result?.text?.length,
      };

      if (useLocalWhisper) {
        timingData.audioConversionDurationMs = result?.timings?.audioConversionDurationMs ?? null;
      }
      timingData.transcriptionProcessingDurationMs =
        result?.timings?.transcriptionProcessingDurationMs ?? null;

      logger.info("Pipeline timing", timingData, "performance");
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

  async processWithLocalWhisper(audioBlob, model = "base", metadata = {}) {
    const timings = {};

    try {
      // Send original audio to main process - FFmpeg in main process handles conversion
      // (renderer-side AudioContext conversion was unreliable with WebM/Opus format)
      const arrayBuffer = await audioBlob.arrayBuffer();
      const language = getBaseLanguageCode(getSettings().preferredLanguage);
      const options = { model };
      if (language) {
        options.language = language;
      }

      // Add custom dictionary as initial prompt to help Whisper recognize specific words
      const dictionaryPrompt = this.getCustomDictionaryPrompt();
      if (dictionaryPrompt) {
        options.initialPrompt = dictionaryPrompt;
      }

      logger.debug(
        "Local transcription starting",
        {
          audioFormat: audioBlob.type,
          audioSizeBytes: audioBlob.size,
        },
        "performance"
      );

      const transcriptionStart = performance.now();
      const result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );

      logger.debug(
        "Local transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result.success,
        },
        "performance"
      );

      if (result.success && result.text) {
        const rawText = result.text;
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return { success: true, text: text || result.text, rawText, source: "local", timings };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Local Whisper transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const { allowOpenAIFallback, useLocalWhisper: isLocalMode } = getSettings();

      if (allowOpenAIFallback && isLocalMode) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `Local Whisper failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Local Whisper failed: ${error.message}`);
      }
    }
  }

  async processWithLocalParakeet(audioBlob, model = "parakeet-tdt-0.6b-v3", metadata = {}) {
    const timings = {};

    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const language = validateLanguageForModel(getSettings().preferredLanguage, model);
      const options = { model };
      if (language) {
        options.language = language;
      }

      logger.debug(
        "Parakeet transcription starting",
        {
          audioFormat: audioBlob.type,
          audioSizeBytes: audioBlob.size,
          model,
        },
        "performance"
      );

      const transcriptionStart = performance.now();
      const result = await window.electronAPI.transcribeLocalParakeet(arrayBuffer, options);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );

      logger.debug(
        "Parakeet transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result.success,
        },
        "performance"
      );

      if (result.success && result.text) {
        const rawText = result.text;
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local-parakeet");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return {
            success: true,
            text: text || result.text,
            rawText,
            source: "local-parakeet",
            timings,
          };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Parakeet transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const { allowOpenAIFallback, useLocalWhisper: isLocalMode } = getSettings();

      if (allowOpenAIFallback && isLocalMode) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `Parakeet failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Parakeet failed: ${error.message}`);
      }
    }
  }

  async getAPIKey() {
    const s = getSettings();
    const provider = s.cloudTranscriptionProvider || "openai";

    // Check cache (invalidate if provider changed)
    if (this.cachedApiKey !== null && this.cachedApiKeyProvider === provider) {
      return this.cachedApiKey;
    }

    let apiKey = null;

    if (provider === "custom") {
      // Prefer store value (user-entered via UI) over main process (.env)
      apiKey = s.customTranscriptionApiKey || "";
      if (!apiKey.trim()) {
        try {
          apiKey = await window.electronAPI.getCustomTranscriptionKey?.();
        } catch (err) {
          logger.debug(
            "Failed to get custom transcription key via IPC",
            { error: err?.message },
            "transcription"
          );
        }
      }
      apiKey = apiKey?.trim() || "";

      logger.debug(
        "Custom STT API key retrieval",
        {
          provider,
          hasKey: !!apiKey,
          keyLength: apiKey?.length || 0,
          keyPreview: apiKey ? `${apiKey.substring(0, 8)}...` : "(none)",
        },
        "transcription"
      );

      // For custom, we allow null/empty - the endpoint may not require auth
      if (!apiKey) {
        apiKey = null;
      }
    } else if (provider === "mistral") {
      // Prefer store value (user-entered via UI) over main process (.env)
      // to avoid stale keys in process.env after auth mode transitions
      apiKey = s.mistralApiKey;
      if (!isValidApiKey(apiKey, "mistral")) {
        apiKey = await window.electronAPI.getMistralKey?.();
      }
      if (!isValidApiKey(apiKey, "mistral")) {
        const err = new Error(
          "Mistral API key not found. Please set your API key in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    } else if (provider === "groq") {
      // Prefer store value (user-entered via UI) over main process (.env)
      apiKey = s.groqApiKey;
      if (!isValidApiKey(apiKey, "groq")) {
        apiKey = await window.electronAPI.getGroqKey?.();
      }
      if (!isValidApiKey(apiKey, "groq")) {
        const err = new Error(
          "Groq API key not found. Please set your API key in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    } else {
      // Default to OpenAI
      // Prefer store value (user-entered via UI) over main process (.env)
      // to avoid stale keys in process.env after auth mode transitions
      apiKey = s.openaiApiKey;
      if (!isValidApiKey(apiKey, "openai")) {
        apiKey = await window.electronAPI.getOpenAIKey();
      }
      if (!isValidApiKey(apiKey, "openai")) {
        const err = new Error(
          "OpenAI API key not found. Please set your API key in the .env file or Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    }

    this.cachedApiKey = apiKey;
    this.cachedApiKeyProvider = provider;
    return apiKey;
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
        const reasoningConfig = route.kind === "agent" ? route.config : undefined;

        logger.logReasoning("SENDING_TO_REASONING", {
          preparedTextLength: normalizedText.length,
          model: targetModel,
          provider: route.config?.provider || cleanupProvider,
          path: route.kind,
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

  shouldStreamTranscription(model, provider) {
    if (provider !== "openai") {
      return false;
    }
    const normalized = typeof model === "string" ? model.trim() : "";
    if (!normalized || normalized === "whisper-1") {
      return false;
    }
    if (normalized === "gpt-4o-transcribe" || normalized === "gpt-4o-transcribe-diarize") {
      return true;
    }
    return normalized.startsWith("gpt-4o-mini-transcribe");
  }

  async readTranscriptionStream(response) {
    const reader = response.body?.getReader();
    if (!reader) {
      logger.error("Streaming response body not available", {}, "transcription");
      throw new Error("Streaming response body not available");
    }

    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let collectedText = "";
    let finalText = null;
    let eventCount = 0;
    const eventTypes = {};

    const handleEvent = (payload) => {
      if (!payload || typeof payload !== "object") {
        return;
      }
      eventCount++;
      const eventType = payload.type || "unknown";
      eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;

      logger.debug(
        "Stream event received",
        {
          type: eventType,
          eventNumber: eventCount,
          payloadKeys: Object.keys(payload),
        },
        "transcription"
      );

      if (payload.type === "transcript.text.delta" && typeof payload.delta === "string") {
        collectedText += payload.delta;
        return;
      }
      if (payload.type === "transcript.text.segment" && typeof payload.text === "string") {
        collectedText += payload.text;
        return;
      }
      if (payload.type === "transcript.text.done" && typeof payload.text === "string") {
        finalText = payload.text;
        logger.debug(
          "Final transcript received",
          {
            textLength: payload.text.length,
          },
          "transcription"
        );
      }
    };

    logger.debug("Starting to read transcription stream", {}, "transcription");

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        logger.debug(
          "Stream reading complete",
          {
            eventCount,
            eventTypes,
            collectedTextLength: collectedText.length,
            hasFinalText: finalText !== null,
          },
          "transcription"
        );
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // Log first chunk to see format
      if (eventCount === 0 && chunk.length > 0) {
        logger.debug(
          "First stream chunk received",
          {
            chunkLength: chunk.length,
            chunkPreview: chunk.substring(0, 500),
          },
          "transcription"
        );
      }

      // Process complete lines from the buffer
      // Each SSE event is "data: <json>\n" followed by empty line
      const lines = buffer.split("\n");
      buffer = "";

      for (const line of lines) {
        const trimmedLine = line.trim();

        // Skip empty lines
        if (!trimmedLine) {
          continue;
        }

        // Extract data from "data: " prefix
        let data = "";
        if (trimmedLine.startsWith("data: ")) {
          data = trimmedLine.slice(6);
        } else if (trimmedLine.startsWith("data:")) {
          data = trimmedLine.slice(5).trim();
        } else {
          // Not a data line, could be leftover - keep in buffer
          buffer += line + "\n";
          continue;
        }

        // Handle [DONE] marker
        if (data === "[DONE]") {
          finalText = finalText ?? collectedText;
          continue;
        }

        // Try to parse JSON
        try {
          const parsed = JSON.parse(data);
          handleEvent(parsed);
        } catch (error) {
          // Incomplete JSON - put back in buffer for next iteration
          buffer += line + "\n";
        }
      }
    }

    const result = finalText ?? collectedText;
    logger.debug(
      "Stream processing complete",
      {
        resultLength: result.length,
        usedFinalText: finalText !== null,
        eventCount,
        eventTypes,
      },
      "transcription"
    );

    return result;
  }

  async processWithOpenWhisprCloud(audioBlob, metadata = {}) {
    if (!navigator.onLine) {
      const err = new Error("You're offline. Cloud transcription requires an internet connection.");
      err.code = "OFFLINE";
      err.messageKey = "hooks.audioRecording.errorDescriptions.offline";
      throw err;
    }

    const timings = {};
    const settings = getSettings();
    const language = getBaseLanguageCode(settings.preferredLanguage);

    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioSizeBytes = audioBlob.size;
    const audioFormat = audioBlob.type;
    const opts = {};
    if (language) opts.language = language;
    const cleanupCloudMode = settings.cleanupCloudMode || "openwhispr";
    if (settings.useCleanupModel && !this.skipReasoning && cleanupCloudMode === "openwhispr") {
      opts.sendLogs = "false";
    }

    const dictionaryPrompt = this.getCustomDictionaryPrompt();
    if (dictionaryPrompt) opts.prompt = dictionaryPrompt;

    // Use withSessionRefresh to handle AUTH_EXPIRED automatically
    const transcriptionStart = performance.now();
    const result = await withSessionRefresh(async () => {
      const res = await window.electronAPI.cloudTranscribe(arrayBuffer, opts);
      if (!res.success) {
        const err = new Error(res.error || "Cloud transcription failed");
        err.code = res.code;
        throw err;
      }
      return res;
    });
    timings.transcriptionProcessingDurationMs = Math.round(performance.now() - transcriptionStart);

    const rawText = result.text;
    let processedText = result.text;
    if (processedText && !this.skipReasoning) {
      const reasoningStart = performance.now();
      const agentName = localStorage.getItem("agentName") || null;
      const route = resolveReasoningRoute(processedText, settings, agentName);
      const cleanupCloudMode = settings.cleanupCloudMode || "openwhispr";

      if (route.kind === "agent") {
        const reasoned = await this.processWithReasoningModel(
          processedText,
          route.model,
          agentName,
          route.config
        );
        if (reasoned) processedText = reasoned;
      } else if (route.kind === "cleanup" && cleanupCloudMode === "openwhispr") {
        const reasonResult = await withSessionRefresh(async () => {
          const res = await window.electronAPI.cloudReason(processedText, {
            agentName,
            customDictionary: settings.customDictionary,
            customPrompt: this.getCustomPrompt(),
            language: settings.preferredLanguage || "auto",
            locale: settings.uiLanguage || "en",
            sttProvider: result.sttProvider,
            sttModel: result.sttModel,
            sttProcessingMs: result.sttProcessingMs,
            sttWordCount: result.sttWordCount,
            sttLanguage: result.sttLanguage,
            audioDurationMs: result.audioDurationMs,
            audioSizeBytes,
            audioFormat,
          });
          if (!res.success) {
            const err = new Error(res.error || "Cloud reasoning failed");
            err.code = res.code;
            throw err;
          }
          return res;
        });

        if (reasonResult.success) {
          processedText = reasonResult.text;
        }
      } else if (route.kind === "cleanup") {
        const effectiveModel = getEffectiveCleanupModel();
        if (effectiveModel) {
          const reasoned = await this.processWithReasoningModel(
            processedText,
            effectiveModel,
            agentName
          );
          if (reasoned) processedText = reasoned;
        }
      }
      timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);
    }

    return {
      success: true,
      text: processedText,
      rawText,
      source: "openwhispr",
      timings,
      limitReached: result.limitReached,
      wordsUsed: result.wordsUsed,
      wordsRemaining: result.wordsRemaining,
    };
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

  async processWithOpenAIAPI(audioBlob, metadata = {}) {
    const timings = {};
    const apiSettings = getSettings();
    const language = getBaseLanguageCode(apiSettings.preferredLanguage);
    const allowLocalFallback = apiSettings.allowLocalFallback;
    const fallbackModel = apiSettings.fallbackWhisperModel || "base";

    try {
      const durationSeconds = metadata.durationSeconds ?? null;
      const model = this.getTranscriptionModel();
      const provider = apiSettings.cloudTranscriptionProvider || "openai";

      logger.debug(
        "Transcription request starting",
        {
          provider,
          model,
          blobSize: audioBlob.size,
          blobType: audioBlob.type,
          durationSeconds,
          language,
        },
        "transcription"
      );

      const apiKey = await this.getAPIKey();
      const optimizedAudio = audioBlob;

      const formData = new FormData();
      // Determine the correct file extension based on the blob type
      const mimeType = optimizedAudio.type || "audio/webm";
      const extension = mimeType.includes("webm")
        ? "webm"
        : mimeType.includes("ogg")
          ? "ogg"
          : mimeType.includes("mp4")
            ? "mp4"
            : mimeType.includes("mpeg")
              ? "mp3"
              : mimeType.includes("wav")
                ? "wav"
                : "webm";

      logger.debug(
        "FormData preparation",
        {
          mimeType,
          extension,
          optimizedSize: optimizedAudio.size,
          hasApiKey: !!apiKey,
        },
        "transcription"
      );

      formData.append("file", optimizedAudio, `audio.${extension}`);
      formData.append("model", model);

      if (language) {
        formData.append("language", language);
      }

      // Add custom dictionary as prompt hint for cloud transcription
      // Groq Whisper API limits prompt to 896 chars; OpenAI ~900 chars.
      // Truncate at last comma boundary so we never send a partial word.
      const MAX_PROMPT_CHARS = provider === "groq" ? 896 : 900;
      let dictionaryPrompt = this.getCustomDictionaryPrompt();
      if (dictionaryPrompt) {
        if (dictionaryPrompt.length > MAX_PROMPT_CHARS) {
          const originalLength = dictionaryPrompt.length;
          const truncated = dictionaryPrompt.slice(0, MAX_PROMPT_CHARS);
          const lastComma = truncated.lastIndexOf(",");
          dictionaryPrompt = lastComma > 0 ? truncated.slice(0, lastComma) : truncated;
          logger.debug(
            "Custom dictionary prompt truncated",
            {
              originalLength,
              truncatedLength: dictionaryPrompt.length,
              maxChars: MAX_PROMPT_CHARS,
            },
            "transcription"
          );
        }
        formData.append("prompt", dictionaryPrompt);
      }

      const shouldStream = this.shouldStreamTranscription(model, provider);
      if (shouldStream) {
        formData.append("stream", "true");
      }

      const endpoint = this.getTranscriptionEndpoint();
      const isCustomEndpoint =
        provider === "custom" ||
        (!endpoint.includes("api.openai.com") &&
          !endpoint.includes("api.groq.com") &&
          !endpoint.includes("api.mistral.ai"));

      const apiCallStart = performance.now();

      // Mistral uses x-api-key auth (not Bearer) and doesn't allow browser CORS — proxy through main process
      if (provider === "mistral" && window.electronAPI?.proxyMistralTranscription) {
        const audioBuffer = await optimizedAudio.arrayBuffer();
        const proxyData = { audioBuffer, model, language };

        if (dictionaryPrompt) {
          const tokens = dictionaryPrompt
            .split(",")
            .flatMap((entry) => entry.trim().split(/\s+/))
            .filter(Boolean)
            .slice(0, 100);
          if (tokens.length > 0) {
            proxyData.contextBias = tokens;
          }
        }

        const result = await window.electronAPI.proxyMistralTranscription(proxyData);
        const proxyText = result?.text;

        if (proxyText && proxyText.trim().length > 0) {
          timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
          const rawText = proxyText;
          const reasoningStart = performance.now();
          const text = await this.processTranscription(proxyText, "mistral");
          timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

          const source = (await this.isReasoningAvailable()) ? "mistral-reasoned" : "mistral";
          return { success: true, text, rawText, source, timings };
        }

        throw new Error("No text transcribed - Mistral response was empty");
      }

      logger.debug(
        "Making transcription API request",
        {
          endpoint,
          shouldStream,
          model,
          provider,
          isCustomEndpoint,
          hasApiKey: !!apiKey,
          apiKeyPreview: apiKey ? `${apiKey.substring(0, 8)}...` : "(none)",
        },
        "transcription"
      );

      // Build headers - only include Authorization if we have an API key
      const headers = {};
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      logger.debug(
        "STT request details",
        {
          endpoint,
          method: "POST",
          hasAuthHeader: !!apiKey,
          formDataFields: [
            "file",
            "model",
            language && language !== "auto" ? "language" : null,
            shouldStream ? "stream" : null,
          ].filter(Boolean),
        },
        "transcription"
      );

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: formData,
      });

      const responseContentType = response.headers.get("content-type") || "";

      logger.debug(
        "Transcription API response received",
        {
          status: response.status,
          statusText: response.statusText,
          contentType: responseContentType,
          ok: response.ok,
        },
        "transcription"
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          "Transcription API error response",
          {
            status: response.status,
            errorText,
          },
          "transcription"
        );
        const err = new Error(`API Error: ${response.status} ${errorText}`);
        if (response.status === 401) err.code = "INVALID_KEY";
        else if (response.status === 429) {
          err.code = "LIMIT_REACHED";
          err.messageKey = "hooks.audioRecording.errorDescriptions.dailyLimitReached";
        } else if (response.status >= 500) err.code = "SERVER_ERROR";
        throw err;
      }

      let result;
      const contentType = responseContentType;

      if (shouldStream && contentType.includes("text/event-stream")) {
        logger.debug("Processing streaming response", { contentType }, "transcription");
        const streamedText = await this.readTranscriptionStream(response);
        result = { text: streamedText };
        logger.debug(
          "Streaming response parsed",
          {
            hasText: !!streamedText,
            textLength: streamedText?.length,
          },
          "transcription"
        );
      } else {
        const rawText = await response.text();
        logger.debug(
          "Raw API response body",
          {
            rawText: rawText.substring(0, 1000),
            fullLength: rawText.length,
          },
          "transcription"
        );

        try {
          result = JSON.parse(rawText);
        } catch (parseError) {
          logger.error(
            "Failed to parse JSON response",
            {
              parseError: parseError.message,
              rawText: rawText.substring(0, 500),
            },
            "transcription"
          );
          throw new Error(`Failed to parse API response: ${parseError.message}`);
        }

        logger.debug(
          "Parsed transcription result",
          {
            hasText: !!result.text,
            textLength: result.text?.length,
            resultKeys: Object.keys(result),
            fullResult: result,
          },
          "transcription"
        );
      }

      // Check for text - handle both empty string and missing field
      if (result.text && result.text.trim().length > 0) {
        timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
        const rawText = result.text;

        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "openai");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        const source = (await this.isReasoningAvailable()) ? "openai-reasoned" : "openai";
        logger.debug(
          "Transcription successful",
          {
            originalLength: result.text.length,
            processedLength: text.length,
            source,
            transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
            reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
          },
          "transcription"
        );
        return { success: true, text, rawText, source, timings };
      } else {
        // Log at info level so it shows without debug mode
        logger.info(
          "Transcription returned empty - check audio input",
          {
            model,
            provider,
            endpoint,
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            mimeType,
            extension,
            resultText: result.text,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        logger.error(
          "No text in transcription result",
          {
            result,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        throw new Error(
          "No text transcribed - audio may be too short, silent, or in an unsupported format"
        );
      }
    } catch (error) {
      const isOpenAIMode = !getSettings().useLocalWhisper;

      if (allowLocalFallback && isOpenAIMode) {
        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          const options = { model: fallbackModel };
          if (language && language !== "auto") {
            options.language = language;
          }

          const result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);

          if (result.success && result.text) {
            const text = await this.processTranscription(result.text, "local-fallback");
            if (text) {
              return { success: true, text, source: "local-fallback" };
            }
          }
          throw error;
        } catch (fallbackError) {
          throw new Error(
            `OpenAI API failed: ${error.message}. Local fallback also failed: ${fallbackError.message}`
          );
        }
      }

      throw error;
    }
  }

  getTranscriptionModel() {
    try {
      const s = getSettings();
      const provider = s.cloudTranscriptionProvider || "openai";
      const trimmedModel = (s.cloudTranscriptionModel || "").trim();

      // For custom provider, use whatever model is set (or fallback to whisper-1)
      if (provider === "custom") {
        return trimmedModel || "whisper-1";
      }

      // Validate model matches provider to handle settings migration
      if (trimmedModel) {
        const isGroqModel = trimmedModel.startsWith("whisper-large-v3");
        const isOpenAIModel = trimmedModel.startsWith("gpt-4o") || trimmedModel === "whisper-1";
        const isMistralModel = trimmedModel.startsWith("voxtral-");

        if (provider === "groq" && isGroqModel) {
          return trimmedModel;
        }
        if (provider === "openai" && isOpenAIModel) {
          return trimmedModel;
        }
        if (provider === "mistral" && isMistralModel) {
          return trimmedModel;
        }
        // Model doesn't match provider - fall through to default
      }

      // Return provider-appropriate default
      if (provider === "groq") return "whisper-large-v3-turbo";
      if (provider === "mistral") return "voxtral-mini-latest";
      return "gpt-4o-mini-transcribe";
    } catch (error) {
      return "gpt-4o-mini-transcribe";
    }
  }

  getTranscriptionEndpoint() {
    const s = getSettings();
    const currentProvider = s.cloudTranscriptionProvider || "openai";
    const currentBaseUrl = s.cloudTranscriptionBaseUrl || "";

    // Only use custom URL when provider is explicitly "custom"
    const isCustomEndpoint = currentProvider === "custom";

    // Invalidate cache if provider or base URL changed
    if (
      this.cachedTranscriptionEndpoint &&
      (this.cachedEndpointProvider !== currentProvider ||
        this.cachedEndpointBaseUrl !== currentBaseUrl)
    ) {
      logger.debug(
        "STT endpoint cache invalidated",
        {
          previousProvider: this.cachedEndpointProvider,
          newProvider: currentProvider,
          previousBaseUrl: this.cachedEndpointBaseUrl,
          newBaseUrl: currentBaseUrl,
        },
        "transcription"
      );
      this.cachedTranscriptionEndpoint = null;
    }

    if (this.cachedTranscriptionEndpoint) {
      return this.cachedTranscriptionEndpoint;
    }

    try {
      // Use custom URL only when provider is "custom", otherwise use provider-specific defaults
      let base;
      if (isCustomEndpoint) {
        base = currentBaseUrl.trim() || API_ENDPOINTS.TRANSCRIPTION_BASE;
      } else if (currentProvider === "groq") {
        base = API_ENDPOINTS.GROQ_BASE;
      } else if (currentProvider === "mistral") {
        base = API_ENDPOINTS.MISTRAL_BASE;
      } else {
        // OpenAI or other standard providers
        base = API_ENDPOINTS.TRANSCRIPTION_BASE;
      }

      const normalizedBase = normalizeBaseUrl(base);

      logger.debug(
        "STT endpoint resolution",
        {
          provider: currentProvider,
          isCustomEndpoint,
          rawBaseUrl: currentBaseUrl,
          normalizedBase,
          defaultBase: API_ENDPOINTS.TRANSCRIPTION_BASE,
        },
        "transcription"
      );

      const cacheResult = (endpoint) => {
        this.cachedTranscriptionEndpoint = endpoint;
        this.cachedEndpointProvider = currentProvider;
        this.cachedEndpointBaseUrl = currentBaseUrl;

        logger.debug(
          "STT endpoint resolved",
          {
            endpoint,
            provider: currentProvider,
            isCustomEndpoint,
            usingDefault: endpoint === API_ENDPOINTS.TRANSCRIPTION,
          },
          "transcription"
        );

        return endpoint;
      };

      if (!normalizedBase) {
        logger.debug(
          "STT endpoint: using default (normalization failed)",
          { rawBase: base },
          "transcription"
        );
        return cacheResult(API_ENDPOINTS.TRANSCRIPTION);
      }

      // Only validate HTTPS for custom endpoints (known providers are already HTTPS)
      if (isCustomEndpoint && !isSecureEndpoint(normalizedBase)) {
        logger.warn(
          "STT endpoint: HTTPS required, falling back to default",
          { attemptedUrl: normalizedBase },
          "transcription"
        );
        return cacheResult(API_ENDPOINTS.TRANSCRIPTION);
      }

      let endpoint;
      if (/\/audio\/(transcriptions|translations)$/i.test(normalizedBase)) {
        endpoint = normalizedBase;
        logger.debug("STT endpoint: using full path from config", { endpoint }, "transcription");
      } else {
        endpoint = buildApiUrl(normalizedBase, "/audio/transcriptions");
        logger.debug(
          "STT endpoint: appending /audio/transcriptions to base",
          { base: normalizedBase, endpoint },
          "transcription"
        );
      }

      return cacheResult(endpoint);
    } catch (error) {
      logger.error(
        "STT endpoint resolution failed",
        { error: error.message, stack: error.stack },
        "transcription"
      );
      this.cachedTranscriptionEndpoint = API_ENDPOINTS.TRANSCRIPTION;
      this.cachedEndpointProvider = currentProvider;
      this.cachedEndpointBaseUrl = currentBaseUrl;
      return API_ENDPOINTS.TRANSCRIPTION;
    }
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

  async saveTranscription(text, rawText = null) {
    if (!getSettings().dataRetentionEnabled) {
      logger.debug("Skipping transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return true;
    }

    try {
      const result = await window.electronAPI.saveTranscription(text, rawText);
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

  shouldUseStreaming(isSignedInOverride) {
    const s = getSettings();
    if (s.useLocalWhisper) return false;

    // For dictation/agent: respect sttConfig mode from the API — this allows
    // batch mode even for realtime-capable models (e.g. gpt-4o-mini-transcribe).
    if (this.context !== "notes" && this.sttConfig?.dictation?.mode === "batch") {
      return false;
    }

    if (REALTIME_MODELS.has(s.cloudTranscriptionModel)) {
      // Realtime WS is OpenAI-only — other providers fall through to HTTP.
      if ((s.cloudTranscriptionProvider || "openai") !== "openai") return false;
      if (s.cloudTranscriptionMode === "byok") return !!s.openaiApiKey;
      if (s.cloudTranscriptionMode === "openwhispr") return !!(isSignedInOverride ?? s.isSignedIn);
      return false;
    }

    if (s.cloudTranscriptionMode !== "openwhispr" || !(isSignedInOverride ?? s.isSignedIn)) {
      return false;
    }
    if (this.context === "notes") {
      return localStorage.getItem("notesStreamingPreference") === "streaming";
    }
    if (!this.sttConfig) return false;
    return this.sttConfig.dictation?.mode === "streaming";
  }

  async warmupStreamingConnection({ isSignedIn: isSignedInOverride } = {}) {
    if (!this.shouldUseStreaming(isSignedInOverride)) {
      logger.debug("Streaming warmup skipped - not in streaming mode", {}, "streaming");
      return false;
    }

    try {
      const provider = this.getStreamingProvider();
      const [, wsResult] = await Promise.all([
        this.cacheMicrophoneDeviceId(),
        withSessionRefresh(async () => {
          const {
            preferredLanguage: warmupLang,
            cloudTranscriptionModel,
            cloudTranscriptionMode,
          } = getSettings();
          const res = await provider.warmup({
            sampleRate: 16000,
            language: warmupLang && warmupLang !== "auto" ? warmupLang : undefined,
            keyterms: this.getKeyterms(),
            model: cloudTranscriptionModel,
            mode: cloudTranscriptionMode === "byok" ? "byok" : "openwhispr",
          });
          // Throw error to trigger retry if AUTH_EXPIRED
          if (!res.success && res.code) {
            const err = new Error(res.error || "Warmup failed");
            err.code = res.code;
            throw err;
          }
          return res;
        }),
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
      //    Frames sent before WebSocket connects are silently dropped by sendAudio().
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
      //    so Deepgram receives data immediately (no idle timeout).
      const result = await withSessionRefresh(async () => {
        const {
          preferredLanguage: preferredLang,
          cloudTranscriptionModel,
          cloudTranscriptionMode,
          useLocalWhisper,
        } = getSettings();
        const res = await provider.start({
          sampleRate: 16000,
          language: preferredLang && preferredLang !== "auto" ? preferredLang : undefined,
          keyterms: this.getKeyterms(),
          model: cloudTranscriptionModel,
          mode: cloudTranscriptionMode === "byok" ? "byok" : "openwhispr",
        });

        if (!res.success) {
          if (res.code === "NO_API") {
            return { needsFallback: true };
          }
          if (res.code === "NETWORK_ERROR" && useLocalWhisper) {
            this.onError?.({
              code: "NETWORK_ERROR",
              title: "streaming.errors.cloudUnreachable.title",
              description: "Cloud unreachable — using local engine for this recording.",
              messageKey: "streaming.errors.cloudUnreachable.fallback",
            });
            return { needsFallback: true };
          }
          const err = new Error(res.error || "Failed to start streaming session");
          err.code = res.code;
          err.messageKey = res.messageKey;
          err.networkCode = res.networkCode;
          throw err;
        }
        return res;
      });
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
      logger.error("Failed to start streaming recording", { error: error.message }, "streaming");

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
    const provider = this.getStreamingProvider();
    provider.finalize?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
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
              agentName
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

    // If streaming produced no text, fall back to batch transcription
    // (batch fallback records usage server-side via /api/transcribe)
    let usedBatchFallback = false;
    if (!finalText && durationSeconds > 2 && fallbackBlob?.size > 0) {
      logger.info(
        "Streaming produced no text, falling back to batch transcription",
        { durationSeconds, blobSize: fallbackBlob.size },
        "streaming"
      );
      try {
        const batchResult = await this.processWithOpenWhisprCloud(fallbackBlob, {
          durationSeconds,
        });
        if (batchResult?.text) {
          finalText = batchResult.text;
          usedBatchFallback = true;
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

      if (!usedBatchFallback) {
        (async () => {
          try {
            await withSessionRefresh(async () => {
              const res = await window.electronAPI.cloudStreamingUsage(
                finalText,
                durationSeconds ?? 0,
                {
                  sendLogs: !usedCloudReasoning,
                  sttProvider: this.getStreamingProviderName(),
                  sttModel: streamingSttModel,
                  sttProcessingMs: streamingSttProcessingMs,
                  sttLanguage: streamingSttLanguage,
                  audioSizeBytes: streamingAudioBytesSent || undefined,
                  audioFormat: "linear16",
                  clientTotalMs,
                }
              );
              if (!res.success) {
                const err = new Error(res.error || "Streaming usage recording failed");
                err.code = res.code;
                throw err;
              }
            });
          } catch (err) {
            logger.error("Failed to report streaming usage", { error: err.message }, "streaming");
          }
          window.dispatchEvent(new Event("usage-changed"));
        })();
      } else {
        window.dispatchEvent(new Event("usage-changed"));
      }

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
    if (this._onApiKeyChanged) {
      window.removeEventListener("api-key-changed", this._onApiKeyChanged);
    }
  }
}

export default AudioManager;
