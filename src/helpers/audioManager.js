import ReasoningService from "../services/ReasoningService";
import { API_ENDPOINTS, buildApiUrl, normalizeBaseUrl } from "../config/constants";
import logger from "../utils/logger";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import {
  isSecureEndpoint,
  isAzureOpenAIEndpoint,
  buildAzureTranscriptionUrl,
} from "../utils/urlUtils";
import { withSessionRefresh } from "../lib/auth";
import { getBaseLanguageCode, getLanguageLabel } from "../utils/languageSupport";
import {
  createLocalSpeechGateState,
  getLocalSpeechGateDecision,
  recordLocalSpeechWindow,
} from "./localSpeechGate";
import { reacquireIfDead } from "./micTrackHealth";
import { reconcileSavedMicSelection } from "./micSelectionRecovery";
import { isStaleDeviceError } from "./staleMicDevice";
import { shouldSaveDiscardedRecording } from "./discardedRecording";
import {
  getSettings,
  getEffectiveCleanupModel,
  isCloudCleanupMode,
  isCloudDictationAgentMode,
  isCloudTranslationMode,
} from "../stores/settingsStore";
import { recordCleanupFailure } from "../stores/cleanupFailureStore";
import {
  getBatchTranscriptionModel,
  getTranscriptionProvider,
  isOnlineParakeetModel,
} from "../models/ModelRegistry";
import { shouldSkipTranscriptionApiKey } from "./transcriptionAuth";
import {
  isSelfHostedTranscription,
  resolveSelfHostedTranscriptionModel,
} from "./selfHostedTranscription";
import { resolveStreamingFallbackTarget } from "./transcriptionFallback";
import { executeTranslationChain, shouldRunTranslateStep } from "./translationChain";
import { detectAgentName } from "../config/agentDetection";
import {
  resolveDictationRouteKind,
  resolveDictationAgentReachability,
  resolveDictationTranslationReachability,
} from "./dictationRouting";
import { resolvePrompt } from "../config/prompts";
import { syncService } from "../services/SyncService.js";
import { evaluateFinishedRecording } from "./recordingValidation";
import { matchesDictionaryPrompt } from "../utils/dictionaryEchoFilter.js";
import { getDictionaryHintWords } from "../utils/snippets";

const REASONING_CACHE_TTL = 30000; // 30 seconds
const RECORDING_TIMESLICE_MS = 250; // flush chunks periodically so short recordings still carry audio frames. See #871.
const REALTIME_MODELS = new Set(["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]);

function dictationAgentReachable(settings) {
  return resolveDictationAgentReachability({
    useDictationAgent: settings.useDictationAgent,
    dictationAgentModel: settings.dictationAgentModel,
    isCloudAgent: isCloudDictationAgentMode(),
    isSelfHostedAgent:
      settings.dictationAgentMode === "self-hosted" && !!settings.dictationAgentRemoteUrl?.trim(),
  });
}

function translationChainReachable(settings) {
  const isSelfHostedTranslation =
    settings.translationMode === "self-hosted" && !!settings.translationRemoteUrl?.trim();
  return resolveDictationTranslationReachability({
    useDictationTranslation: settings.useDictationTranslation,
    translationTargetLanguage: settings.translationTargetLanguage,
    translationModel: settings.translationModel,
    isCloudTranslation: isCloudTranslationMode(),
    isSelfHostedTranslation,
  });
}

function resolveReasoningRoute(
  text,
  settings,
  agentName,
  voiceAgentRequested,
  translationRequested
) {
  const cleanupReachable =
    !!settings.useCleanupModel && (!!settings.cleanupModel?.trim() || isCloudCleanupMode());
  const agentModel = settings.dictationAgentModel?.trim() || "";
  const isCloudAgent = isCloudDictationAgentMode();
  const isSelfHostedAgent =
    settings.dictationAgentMode === "self-hosted" && !!settings.dictationAgentRemoteUrl?.trim();
  const agentReachable = resolveDictationAgentReachability({
    useDictationAgent: settings.useDictationAgent,
    dictationAgentModel: agentModel,
    isCloudAgent,
    isSelfHostedAgent,
  });

  const isCloudTranslation = isCloudTranslationMode();
  const isSelfHostedTranslation =
    settings.translationMode === "self-hosted" && !!settings.translationRemoteUrl?.trim();
  const translationReachable = resolveDictationTranslationReachability({
    useDictationTranslation: settings.useDictationTranslation,
    translationTargetLanguage: settings.translationTargetLanguage,
    translationModel: settings.translationModel,
    isCloudTranslation,
    isSelfHostedTranslation,
  });

  const kind = resolveDictationRouteKind({
    cleanupReachable,
    agentReachable,
    agentInvoked: !!agentName && detectAgentName(text, agentName),
    voiceAgentRequested,
    translationRequested,
    translationReachable,
  });
  if (translationRequested && kind !== "translation") {
    logger.warn(
      "Translation requested but unreachable, falling back",
      {
        kind,
        useDictationTranslation: settings.useDictationTranslation,
        hasTarget: !!settings.translationTargetLanguage?.trim(),
      },
      "transcription"
    );
  }
  if (kind === "translation") {
    const provider = isCloudTranslation
      ? "openwhispr"
      : settings.translationProvider?.trim() || undefined;
    const isCustomTranslation = settings.translationMode === "providers" && provider === "custom";
    return {
      kind: "translation",
      model: settings.translationModel?.trim() || "",
      cleanupReachable,
      cleanupConfig: { disableThinking: settings.cleanupDisableThinking },
      config: {
        provider,
        language: settings.translationTargetLanguage,
        lanUrl: isSelfHostedTranslation ? settings.translationRemoteUrl : undefined,
        baseUrl: isCustomTranslation ? settings.translationCloudBaseUrl || undefined : undefined,
        customApiKey:
          isCustomTranslation || isSelfHostedTranslation
            ? settings.translationCustomApiKey || undefined
            : undefined,
        disableThinking: settings.translationDisableThinking,
        systemPrompt: resolvePrompt("translate", {
          agentName,
          targetLanguageLabel: getLanguageLabel(settings.translationTargetLanguage),
          customDictionary: getDictionaryHintWords(settings),
          uiLanguage: settings.uiLanguage,
        }),
      },
    };
  }
  if (kind === "agent") {
    const provider = isCloudAgent
      ? "openwhispr"
      : settings.dictationAgentProvider?.trim() || undefined;
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
          customDictionary: getDictionaryHintWords(settings),
          uiLanguage: settings.uiLanguage,
        }),
      },
    };
  }
  if (kind === "cleanup") {
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
  xai: "your_xai_api_key_here",
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
  corti: {
    warmup: (opts) => window.electronAPI.cortiStreamingWarmup(opts),
    start: (opts) => window.electronAPI.cortiStreamingStart(opts),
    send: (buf) => window.electronAPI.cortiStreamingSend(buf),
    finalize: () => window.electronAPI.cortiStreamingFinalize(),
    stop: () => window.electronAPI.cortiStreamingStop(),
    status: () => window.electronAPI.cortiStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onCortiPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onCortiFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onCortiError(cb),
    onSessionEnd: (cb) => window.electronAPI.onCortiSessionEnd(cb),
  },
  "tinfoil-realtime": {
    warmup: (opts) =>
      window.electronAPI.dictationRealtimeWarmup({
        ...opts,
        provider: "tinfoil-realtime",
        preview: true,
      }),
    start: (opts) =>
      window.electronAPI.dictationRealtimeStart({
        ...opts,
        provider: "tinfoil-realtime",
        preview: true,
      }),
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

    // Invalidate the pinned mic device when the OS adds/removes/suspends inputs.
    // Otherwise wake-after-idle keeps requesting a stale deviceId that yields silence.
    this._onDeviceChange = () => {
      this.cachedMicDeviceId = null;
      this.validatedSelectedMicDeviceId = null;
      this.micDriverWarmedUp = false;
      this.rejectedMicDeviceId = null;
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", this._onDeviceChange);
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
    this.validatedSelectedMicDeviceId = null;
    this.rejectedMicDeviceId = null;
    this.persistentAudioContext = null;
    this.workletModuleLoaded = false;
    this.workletBlobUrl = null;
    this.streamingStartInProgress = false;
    this.stopRequestedDuringStreamingStart = false;
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    this.skipReasoning = false;
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.context = "dictation";
    this.sttConfig = null;
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    this._localSpeechGateState = null;
    this._streamingCommitActive = false;
    this._previewFlushResolve = null;
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
        this.port.postMessage("flushed");
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
    const words = getDictionaryHintWords(getSettings());
    return words.length > 0 ? words.join(", ") : null;
  }

  isDictionaryEcho(text) {
    return matchesDictionaryPrompt(text, this.getCustomDictionaryPrompt());
  }

  setCallbacks({
    onStateChange,
    onError,
    onTranscriptionComplete,
    onPartialTranscript,
    onStreamingCommit,
    onTranslationFallback,
  }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onTranscriptionComplete = onTranscriptionComplete;
    this.onPartialTranscript = onPartialTranscript;
    this.onStreamingCommit = onStreamingCommit;
    this.onTranslationFallback = onTranslationFallback;
  }

  // Fail-open: translation degraded/failed but raw text is still pasted. Surface why.
  notifyTranslationFallback(reason) {
    this.onTranslationFallback?.({ reason });
  }

  setSkipReasoning(skip) {
    this.skipReasoning = skip;
  }

  setVoiceAgentRequested(requested) {
    this.voiceAgentRequested = requested;
  }

  setTranslationRequested(requested) {
    this.translationRequested = requested;
  }

  // In translation mode the STT hint is the configured source language, not
  // the UI-wide preferred language; "auto" keeps whisper auto-detection.
  getEffectiveSttLanguage(settings) {
    if (this.translationRequested) {
      return settings.translationSourceLanguage || "auto";
    }
    return settings.preferredLanguage;
  }

  setContext(context) {
    this.context = context;
  }

  setSttConfig(config) {
    this.sttConfig = config;
  }

  getStreamingProvider() {
    const fallback = this.context === "notes" ? "deepgram" : "openai-realtime";
    return STREAMING_PROVIDERS[this.getStreamingProviderName()] || STREAMING_PROVIDERS[fallback];
  }

  getStreamingProviderName() {
    const s = getSettings();
    if (s.cloudTranscriptionProvider === "tinfoil") {
      return "tinfoil-realtime";
    }
    if (s.cloudTranscriptionProvider === "corti" && s.cloudTranscriptionMode === "byok") {
      return "corti";
    }
    if (REALTIME_MODELS.has(s.cloudTranscriptionModel)) {
      return "openai-realtime";
    }
    const defaultProvider = this.context === "notes" ? "deepgram" : "openai-realtime";
    return this.sttConfig?.streamingProvider || defaultProvider;
  }

  async getAudioConstraints(forceDefaultMic = false) {
    const {
      preferBuiltInMic: preferBuiltIn,
      selectedMicDeviceId: selectedDeviceId,
      selectedMicDeviceLabel: selectedDeviceLabel,
    } = getSettings();

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

    // Pinned device was unavailable (Chromium rotates IDs / device unplugged); fall back to the
    // system default for this capture without discarding the saved preference. See #900.
    if (forceDefaultMic) {
      logger.debug("Using default microphone (pinned device unavailable)", {}, "audio");
      return { audio: noProcessing };
    }

    if (preferBuiltIn) {
      if (this.cachedMicDeviceId) {
        // The device was already proven silent this session; don't pin it again.
        if (this.cachedMicDeviceId === this.rejectedMicDeviceId) {
          logger.debug(
            "Skipping cached microphone (delivered no audio)",
            { deviceId: this.cachedMicDeviceId },
            "audio"
          );
          return { audio: noProcessing };
        }

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
          // Leave it uncached so a later devicechange can re-resolve it cleanly.
          if (builtInMic.deviceId === this.rejectedMicDeviceId) {
            logger.debug(
              "Skipping built-in microphone (delivered no audio)",
              { deviceId: builtInMic.deviceId, label: builtInMic.label },
              "audio"
            );
            return { audio: noProcessing };
          }

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
      let resolvedDeviceId = selectedDeviceId;

      if (this.validatedSelectedMicDeviceId !== selectedDeviceId) {
        try {
          const reconciled = await reconcileSavedMicSelection(
            selectedDeviceId,
            selectedDeviceLabel,
            "audio"
          );
          resolvedDeviceId = reconciled.deviceId;

          if (reconciled.resolved) {
            this.validatedSelectedMicDeviceId = resolvedDeviceId;
          } else {
            // Avoid enumerating on every recording while the saved device is
            // unplugged. A devicechange event clears this cache when it returns.
            this.validatedSelectedMicDeviceId = reconciled.labelsAvailable
              ? selectedDeviceId
              : null;
          }
        } catch (error) {
          logger.debug(
            "Failed to reconcile selected microphone",
            { error: error.message },
            "audio"
          );
        }
      }

      if (resolvedDeviceId === this.rejectedMicDeviceId) {
        logger.debug(
          "Skipping selected microphone (delivered no audio)",
          { deviceId: resolvedDeviceId },
          "audio"
        );
        return { audio: noProcessing };
      }

      logger.debug("Using selected microphone", { deviceId: resolvedDeviceId }, "audio");
      return { audio: { deviceId: { exact: resolvedDeviceId }, ...noProcessing } };
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

  // Briefly acquire and release the mic so the OS audio driver is warm before
  // the first real recording, reducing cold-start empty captures. See #871.
  async warmupMicDriver() {
    if (this.micDriverWarmedUp) return;
    // Skip while a recording is active so we don't double-acquire the mic. See #871.
    if (this.isRecording || this.isProcessing || this.mediaRecorder?.state === "recording") return;
    try {
      const constraints = await this.getAudioConstraints();
      const tempStream = await navigator.mediaDevices.getUserMedia(constraints);
      tempStream.getTracks().forEach((track) => track.stop());
      this.micDriverWarmedUp = true;
      logger.debug("Microphone driver pre-warmed", {}, "audio");
    } catch (e) {
      logger.debug("Mic driver warmup failed (non-critical)", { error: e.message }, "audio");
    }
  }

  // Recovers a dead/muted capture: retries the same device, then hops to the OS default,
  // remembering a silent pinned device for the session. Throws MicUnusableError when no
  // input delivers audio. See #1152.
  async acquireHealthyMicStream(rawStream, constraints) {
    const pinnedMicDeviceId = constraints.audio?.deviceId?.exact ?? null;
    let fallbackMicUnusable = false;
    // Keep verifying after a rejection too, otherwise a muted default records silence unnoticed.
    const verifyMic = pinnedMicDeviceId !== null || this.rejectedMicDeviceId !== null;
    const stream = await reacquireIfDead(
      rawStream,
      () => {
        this.cachedMicDeviceId = null;
        return this.getAudioConstraints();
      },
      logger,
      verifyMic
        ? {
            getConstraints: () => this.getAudioConstraints(true),
            onDeviceRejected: () => {
              if (pinnedMicDeviceId) this.rejectedMicDeviceId = pinnedMicDeviceId;
            },
            onFallbackUnusable: () => {
              fallbackMicUnusable = true;
            },
          }
        : null
    );

    if (fallbackMicUnusable) {
      stream.getTracks().forEach((track) => track.stop());
      const micError = new Error("No microphone is delivering audio");
      micError.name = "MicUnusableError";
      throw micError;
    }

    return stream;
  }

  async startRecording(forceDefaultMic = false) {
    try {
      if (this.isRecording || this.isProcessing || this.mediaRecorder?.state === "recording") {
        return false;
      }

      const constraints = await this.getAudioConstraints(forceDefaultMic);
      const micStream = await this.acquireHealthyMicStream(
        await navigator.mediaDevices.getUserMedia(constraints),
        constraints
      );

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
            muted: audioTrack.muted,
            readyState: audioTrack.readyState,
          },
          "audio"
        );
      }

      try {
        this._silenceCtx = new AudioContext();
        if (this._silenceCtx.state === "suspended") {
          // Not awaited — resume() can hang when the output device is wedged.
          this._silenceCtx.resume().catch(() => {});
        }
        this._silenceAnalyser = this._silenceCtx.createAnalyser();
        this._silenceAnalyser.fftSize = 2048;
        const sourceNode = this._silenceCtx.createMediaStreamSource(micStream);
        sourceNode.connect(this._silenceAnalyser);
        this._localSpeechGateState = createLocalSpeechGateState();
        const dataArray = new Uint8Array(this._silenceAnalyser.fftSize);
        this._silenceInterval = setInterval(() => {
          // A stalled context reads flat silence; recording no windows fails the gate open.
          if (this._silenceCtx?.state !== "running") return;
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
      this._receivedAudioData = false;
      this.recordingStartTime = Date.now();
      this.recordingMimeType = this.mediaRecorder.mimeType || "audio/webm";

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this._receivedAudioData = true;
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        this.teardownSpeechGate();

        const previewStopPromise = this.cleanupPreview({
          showCleanup: this.shouldShowPreviewCleanupState(),
        });

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

        // Drop header-only / no-frame recordings before they crash FFmpeg. See #871.
        const recordingCheck = evaluateFinishedRecording({
          blobSize: audioBlob.size,
          receivedAudioData: this._receivedAudioData,
        });
        if (!recordingCheck.usable) {
          logger.info(
            "Dropping degenerate recording before transcription",
            {
              blobSize: audioBlob.size,
              reason: recordingCheck.reason,
              receivedAudioData: this._receivedAudioData,
            },
            "audio"
          );
          this.isProcessing = false;
          this._localSpeechGateState = null;
          this.onStateChange?.({ isRecording: false, isProcessing: false });
          this.onTranscriptionComplete?.({ success: true, text: "" });
          micStream.getTracks().forEach((track) => track.stop());
          return;
        }

        // Non-commit sessions stop concurrently with the decode below.
        const previewStop = this._streamingCommitActive ? await previewStopPromise : null;
        this._streamingCommitActive = false;

        await this.processAudio(audioBlob, {
          durationSeconds,
          ...(previewStop?.streamed ? { streamedText: previewStop.text } : {}),
        });

        micStream.getTracks().forEach((track) => track.stop());
      };

      this.mediaRecorder.start(RECORDING_TIMESLICE_MS);
      this.isRecording = true;
      this.onStateChange?.({ isRecording: true, isProcessing: false });

      const {
        showTranscriptionPreview,
        useLocalWhisper,
        localTranscriptionProvider,
        whisperModel,
        parakeetModel,
      } = getSettings();
      const isNvidia = localTranscriptionProvider === "nvidia";
      // Online models stream+commit during capture, so PCM runs even with preview off.
      const streamingCommit = useLocalWhisper && isNvidia && isOnlineParakeetModel(parakeetModel);
      this._streamingCommitActive = false;
      if (useLocalWhisper && (showTranscriptionPreview || streamingCommit)) {
        try {
          this._previewAudioContext = new AudioContext({ sampleRate: 16000 });
          this._previewSource = this._previewAudioContext.createMediaStreamSource(micStream);
          await this._previewAudioContext.audioWorklet.addModule(this.getWorkletBlobUrl());

          this._previewProcessor = new AudioWorkletNode(
            this._previewAudioContext,
            "pcm-streaming-processor"
          );
          this._previewProcessor.port.onmessage = (event) => {
            if (event.data === "flushed") {
              this._previewFlushResolve?.();
              return;
            }
            window.electronAPI?.sendDictationPreviewAudio?.(event.data);
          };
          this._previewSource.connect(this._previewProcessor);

          const provider = isNvidia ? "nvidia" : "whisper";
          const model = isNvidia ? parakeetModel : whisperModel;
          const language = getBaseLanguageCode(getSettings().preferredLanguage);
          window.electronAPI?.startDictationPreview?.({
            provider,
            model,
            language,
            display: showTranscriptionPreview,
          });
          this._streamingCommitActive = streamingCommit;
        } catch (e) {
          logger.warn("Preview worklet setup failed", { error: e.message }, "audio");
        }
      }

      return true;
    } catch (error) {
      if (isStaleDeviceError(error) && !forceDefaultMic) {
        // Pinned mic is gone (Chromium rotates IDs / device unplugged). Retry once on the default mic. See #900.
        logger.warn("Pinned microphone unavailable, retrying on default mic", {}, "audio");
        this.cachedMicDeviceId = null;
        return this.startRecording(true);
      }

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
      } else if (error.name === "MicUnusableError") {
        errorTitle = "Microphone Muted";
        errorDescription =
          "Your microphones stayed muted and produced no audio. Please check your sound input settings and try again.";
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

  teardownSpeechGate() {
    if (this._silenceInterval) {
      clearInterval(this._silenceInterval);
      this._silenceInterval = null;
    }
    this._silenceCtx?.close().catch(() => {});
    this._silenceCtx = null;
    this._silenceAnalyser = null;
  }

  cancelRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.mediaRecorder.onstop = () => {
        this.teardownSpeechGate();
        this._localSpeechGateState = null;

        const durationSeconds = this.recordingStartTime
          ? (Date.now() - this.recordingStartTime) / 1000
          : null;
        const shouldSave =
          shouldSaveDiscardedRecording(getSettings(), durationSeconds) &&
          this.audioChunks.length > 0;
        const blob = shouldSave
          ? new Blob(this.audioChunks, { type: this.recordingMimeType })
          : null;

        this.cleanupPreview({ dismiss: true });
        this.isRecording = false;
        this.isProcessing = false;
        this.audioChunks = [];
        this.recordingStartTime = null;
        this.onStateChange?.({ isRecording: false, isProcessing: false });

        if (blob) {
          this.saveDiscardedTranscription(blob, durationSeconds).catch((err) => {
            logger.warn("Failed to save discarded transcription", { error: err.message }, "audio");
          });
        }
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
      const language = getBaseLanguageCode(this.getEffectiveSttLanguage(getSettings()));
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
        if (this.isDictionaryEcho(result.text)) {
          throw new Error("No audio detected");
        }
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
      let result;
      if (typeof metadata.streamedText === "string") {
        const streamedText = metadata.streamedText.trim();
        if (!streamedText) {
          throw new Error("No audio detected");
        }
        logger.debug("Parakeet using committed streaming transcript", { model }, "performance");
        timings.transcriptionProcessingDurationMs = 0;
        result = { success: true, text: streamedText };
      } else {
        const arrayBuffer = await audioBlob.arrayBuffer();

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
        result = await window.electronAPI.transcribeLocalParakeet(arrayBuffer, { model });
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
      }

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
            ...(result.warning ? { warning: result.warning } : {}),
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
    if (shouldSkipTranscriptionApiKey(s)) {
      return null;
    }

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
    } else if (provider === "corti") {
      // Tokens are minted in the main process; only verify credentials exist here
      let clientId = s.cortiClientId;
      let clientSecret = s.cortiClientSecret;
      if (!clientId?.trim() || !clientSecret?.trim()) {
        [clientId, clientSecret] = await Promise.all([
          window.electronAPI.getCortiClientId?.(),
          window.electronAPI.getCortiClientSecret?.(),
        ]);
      }
      if (!clientId?.trim() || !clientSecret?.trim()) {
        const err = new Error(
          "Corti credentials not found. Please set your Client ID and Client Secret in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
      apiKey = null;
    } else if (provider === "tinfoil") {
      apiKey = s.tinfoilApiKey;
      if (!apiKey?.trim()) {
        apiKey = await window.electronAPI.getTinfoilKey?.();
      }
      if (!apiKey?.trim()) {
        const err = new Error(
          "Tinfoil API key not found. Please set your API key in the Control Panel."
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
    } else if (provider === "xai") {
      apiKey = s.xaiApiKey;
      if (!isValidApiKey(apiKey, "xai")) {
        apiKey = await window.electronAPI.getXaiKey?.();
      }
      if (!isValidApiKey(apiKey, "xai")) {
        const err = new Error(
          "xAI API key not found. Please set your API key in the Control Panel."
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
      !!s.useCleanupModel || dictationAgentReachable(s) || translationChainReachable(s);
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

  // Cleanup-then-translate chain shared by batch, cloud, and streaming paths: Step 1
  // (optional cleanup) soft-fails to input; Step 2 translates unless source === target.
  async runTranslationChain({ text, settings, agentName, route, cleanup }) {
    const runCleanup = async (currentText) => {
      if (cleanup.mode === "cloudReason") {
        const reasonResult = await withSessionRefresh(async () => {
          const res = await window.electronAPI.cloudReason(currentText, {
            agentName,
            promptMode: "cleanup",
            customDictionary: getDictionaryHintWords(settings),
            customPrompt: this.getCustomPrompt(),
            language: this.getEffectiveSttLanguage(settings) || "auto",
            locale: settings.uiLanguage || "en",
            ...(cleanup.meta || {}),
          });
          if (!res.success) {
            const err = new Error(res.error || "Cloud reasoning failed");
            err.code = res.code;
            throw err;
          }
          return res;
        });
        return reasonResult.success && reasonResult.text ? reasonResult.text : null;
      }
      const cleanupModel = cleanup.model;
      if (cleanupModel) {
        return this.processWithReasoningModel(
          currentText,
          cleanupModel,
          agentName,
          route.cleanupConfig
        );
      }
      return null;
    };

    const runTranslate = async (currentText) =>
      this.processWithReasoningModel(currentText, route.model, agentName, route.config);

    try {
      return await executeTranslationChain({
        text,
        cleanupReachable: route.cleanupReachable,
        cleanupIsCloud: cleanup.mode === "cloudReason",
        runCleanup,
        runTranslate,
        shouldTranslate: shouldRunTranslateStep(
          settings.translationSourceLanguage,
          settings.translationTargetLanguage
        ),
        translateIsCloud: route.config?.provider === "openwhispr",
        onCleanupError: (cleanupError) => {
          const { level = "error", channel, extra } = cleanup.log || {};
          logger[level](
            "Cleanup step failed in translation chain, translating raw transcript",
            { ...(extra || {}), error: cleanupError.message },
            channel
          );
        },
        onEmptyTranslate: () => {
          const { channel } = cleanup.log || {};
          logger.warn("Translation step returned empty text, keeping previous text", {}, channel);
          this.notifyTranslationFallback("failed");
        },
      });
    } catch (translateError) {
      // Translate step threw: raw text is still pasted by the caller. Surface the failure.
      this.notifyTranslationFallback("failed");
      throw translateError;
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
    const cleanupReachable = !!settings.useCleanupModel && (!!cleanupModel || isCloud);
    const agentReachable = dictationAgentReachable(settings);
    const agentName =
      typeof window !== "undefined" && window.localStorage
        ? localStorage.getItem("agentName") || null
        : null;
    if (
      !cleanupReachable &&
      !agentReachable &&
      !(this.translationRequested && translationChainReachable(settings))
    ) {
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
      let route;
      try {
        route = resolveReasoningRoute(
          normalizedText,
          settings,
          agentName,
          this.voiceAgentRequested,
          this.translationRequested
        );
        if (this.translationRequested && route.kind !== "translation") {
          this.notifyTranslationFallback("unreachable");
        }
        if (route.kind === "skip") return normalizedText;

        if (route.kind === "translation") {
          const { text: translatedText } = await this.runTranslationChain({
            text: normalizedText,
            settings,
            agentName,
            route,
            cleanup: {
              mode: "model",
              model: cleanupModel,
              log: { level: "warn", channel: "notes", extra: { source } },
            },
          });

          logger.logReasoning("REASONING_SUCCESS", {
            resultLength: translatedText.length,
            resultPreview:
              translatedText.substring(0, 100) + (translatedText.length > 100 ? "..." : ""),
            processingTime: new Date().toISOString(),
          });

          return translatedText;
        }

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
        if (route?.kind === "cleanup") recordCleanupFailure();
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
    const language = getBaseLanguageCode(this.getEffectiveSttLanguage(settings));

    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioSizeBytes = audioBlob.size;
    const audioFormat = audioBlob.type;
    const opts = {};
    if (language) opts.language = language;
    const cleanupCloudMode = settings.cleanupCloudMode || "openwhispr";
    if (
      (settings.useCleanupModel && !this.skipReasoning && cleanupCloudMode === "openwhispr") ||
      (this.translationRequested &&
        !this.skipReasoning &&
        translationChainReachable(settings) &&
        isCloudTranslationMode())
    ) {
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
    if (this.isDictionaryEcho(rawText)) {
      throw new Error("No audio detected");
    }
    let processedText = result.text;
    if (processedText && !this.skipReasoning) {
      const reasoningStart = performance.now();
      const agentName = localStorage.getItem("agentName") || null;
      const route = resolveReasoningRoute(
        processedText,
        settings,
        agentName,
        this.voiceAgentRequested,
        this.translationRequested
      );
      if (this.translationRequested && route.kind !== "translation") {
        this.notifyTranslationFallback("unreachable");
      }
      const cleanupCloudMode = settings.cleanupCloudMode || "openwhispr";

      try {
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
              promptMode: "cleanup",
              customDictionary: getDictionaryHintWords(settings),
              customPrompt: this.getCustomPrompt(),
              language: this.getEffectiveSttLanguage(settings) || "auto",
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
              agentName,
              route.config
            );
            if (reasoned) processedText = reasoned;
          }
        } else if (route.kind === "translation") {
          const chainResult = await this.runTranslationChain({
            text: processedText,
            settings,
            agentName,
            route,
            cleanup:
              cleanupCloudMode === "openwhispr"
                ? {
                    mode: "cloudReason",
                    meta: {
                      sttProvider: result.sttProvider,
                      sttModel: result.sttModel,
                      sttProcessingMs: result.sttProcessingMs,
                      sttWordCount: result.sttWordCount,
                      sttLanguage: result.sttLanguage,
                      audioDurationMs: result.audioDurationMs,
                      audioSizeBytes,
                      audioFormat,
                    },
                    log: { level: "error", channel: "transcription" },
                  }
                : {
                    mode: "model",
                    model: getEffectiveCleanupModel(),
                    log: { level: "error", channel: "transcription" },
                  },
          });
          processedText = chainResult.text;
        }
      } catch (reasonError) {
        logger.error(
          "Cloud reasoning failed, using raw transcription",
          { error: reasonError.message },
          "transcription"
        );
        if (route.kind === "cleanup") recordCleanupFailure();
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
      clientTranscriptionId: result.clientTranscriptionId,
      ...(result.warning ? { warning: result.warning } : {}),
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
    const language = getBaseLanguageCode(this.getEffectiveSttLanguage(apiSettings));
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

      // Dispatch before endpoint resolution (which defaults to OpenAI and would leak
      // the key). Self-hosted wins, so a leftover "tinfoil" provider isn't diverted here.
      if (provider === "tinfoil" && !isSelfHostedTranscription(apiSettings)) {
        if (!window.electronAPI?.proxyTinfoilTranscription) {
          throw new Error("Tinfoil transcription is unavailable in this window");
        }
        const dictionaryPrompt = this.getCustomDictionaryPrompt();
        const apiCallStart = performance.now();
        const result = await window.electronAPI.proxyTinfoilTranscription({
          audioBuffer: await optimizedAudio.arrayBuffer(),
          language,
          prompt: dictionaryPrompt || undefined,
        });
        if (result?.error) {
          const err = new Error(result.error);
          if (result.code) err.code = result.code;
          if (result.messageKey) err.messageKey = result.messageKey;
          throw err;
        }
        const proxyText = result?.text;
        if (!proxyText?.trim()) {
          throw new Error("No text transcribed - Tinfoil response was empty");
        }
        if (this.isDictionaryEcho(proxyText)) {
          throw new Error("No audio detected");
        }
        timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
        const reasoningStart = performance.now();
        const text = await this.processTranscription(proxyText, "tinfoil");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        const source = (await this.isReasoningAvailable()) ? "tinfoil-reasoned" : "tinfoil";
        return { success: true, text, rawText: proxyText, source, timings };
      }

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

      const endpoint = this.getTranscriptionEndpoint(model);

      // Groq rejects prompts > 896 chars (incl. when reached via "custom" provider).
      // 890 leaves margin for UTF-16 vs codepoint counting drift.
      const isGroqEndpoint = provider === "groq" || endpoint.includes("api.groq.com");
      const MAX_PROMPT_CHARS = isGroqEndpoint ? 890 : 900;
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

      const isCustomEndpoint =
        provider === "custom" ||
        (!endpoint.includes("api.openai.com") &&
          !endpoint.includes("api.groq.com") &&
          !endpoint.includes("api.x.ai") &&
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
          if (this.isDictionaryEcho(proxyText)) {
            throw new Error("No audio detected");
          }
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

      // xAI STT has a non-OpenAI-compatible API — proxy through main process. See #910.
      if (provider === "xai" && window.electronAPI?.proxyXaiTranscription) {
        const audioBuffer = await optimizedAudio.arrayBuffer();
        const proxyData = { audioBuffer, language: language !== "auto" ? language : undefined };

        const keyterms = this.getKeyterms()
          .map((t) => t.trim().slice(0, 50))
          .filter(Boolean)
          .slice(0, 100);
        if (keyterms.length > 0) {
          proxyData.keyterms = keyterms;
        }

        const result = await window.electronAPI.proxyXaiTranscription(proxyData);
        const proxyText = result?.text;

        if (proxyText && proxyText.trim().length > 0) {
          if (this.isDictionaryEcho(proxyText)) {
            throw new Error("No audio detected");
          }
          timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
          const rawText = proxyText;
          const reasoningStart = performance.now();
          const text = await this.processTranscription(proxyText, "xai");
          timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

          const source = (await this.isReasoningAvailable()) ? "xai-reasoned" : "xai";
          return { success: true, text, rawText, source, timings };
        }

        throw new Error("No text transcribed - xAI response was empty");
      }

      // Corti uses OAuth client credentials and an interaction-based REST flow — proxy through main process
      if (provider === "corti" && window.electronAPI?.proxyCortiTranscription) {
        const audioBuffer = await optimizedAudio.arrayBuffer();
        const proxyData = {
          audioBuffer,
          // Corti requires a concrete primaryLanguage; default to English when auto-detecting
          language: language || "en",
          environment: apiSettings.cortiEnvironment || "us",
          tenant: (apiSettings.cortiTenant || "").trim() || "base",
        };

        const result = await window.electronAPI.proxyCortiTranscription(proxyData);
        const proxyText = result?.text;

        if (proxyText && proxyText.trim().length > 0) {
          if (this.isDictionaryEcho(proxyText)) {
            throw new Error("No audio detected");
          }
          timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
          const rawText = proxyText;
          const reasoningStart = performance.now();
          const text = await this.processTranscription(proxyText, "corti");
          timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

          const source = (await this.isReasoningAvailable()) ? "corti-reasoned" : "corti";
          return { success: true, text, rawText, source, timings };
        }

        throw new Error("No text transcribed - Corti response was empty");
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
        },
        "transcription"
      );

      // Build headers - only include Authorization if we have an API key
      const headers = {};
      if (apiKey) {
        // Azure OpenAI authenticates API keys via the `api-key` header, not a
        // Bearer token (which it reserves for Entra ID access tokens).
        if (isAzureOpenAIEndpoint(endpoint)) {
          headers["api-key"] = apiKey;
        } else {
          headers.Authorization = `Bearer ${apiKey}`;
        }
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
          // The user's own provider rate-limited the request — not an OpenWhispr plan limit
          err.code = "PROVIDER_RATE_LIMITED";
          err.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
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
        if (this.isDictionaryEcho(result.text)) {
          throw new Error("No audio detected");
        }
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
      if (error.message === "No audio detected") {
        throw error;
      }

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
      const selfHostedModel = resolveSelfHostedTranscriptionModel(s);
      if (selfHostedModel) return selfHostedModel;
      const provider = s.cloudTranscriptionProvider || "openai";
      const trimmedModel = (s.cloudTranscriptionModel || "").trim();

      // For custom provider, use whatever model is set (or fallback to whisper-1)
      if (provider === "custom") {
        return trimmedModel || "whisper-1";
      }

      if (provider === "tinfoil") {
        return getBatchTranscriptionModel("tinfoil");
      }

      // Validate model matches provider to handle settings migration
      if (trimmedModel) {
        const isGroqModel = trimmedModel.startsWith("whisper-large-v3");
        const isOpenAIModel = trimmedModel.startsWith("gpt-4o") || trimmedModel === "whisper-1";
        const isMistralModel = trimmedModel.startsWith("voxtral-");
        const isCortiModel = trimmedModel.startsWith("corti-");

        if (provider === "groq" && isGroqModel) {
          return trimmedModel;
        }
        if (provider === "openai" && isOpenAIModel) {
          return trimmedModel;
        }
        if (provider === "mistral" && isMistralModel) {
          return trimmedModel;
        }
        if (provider === "corti" && isCortiModel) {
          return trimmedModel;
        }
        // Model doesn't match provider - fall through to default
      }

      // Return provider-appropriate default
      if (provider === "groq") return "whisper-large-v3-turbo";
      if (provider === "xai") return "grok-stt";
      if (provider === "mistral") return "voxtral-mini-latest";
      if (provider === "corti") return "corti-transcribe";
      return "gpt-4o-mini-transcribe";
    } catch (error) {
      return "gpt-4o-mini-transcribe";
    }
  }

  getTranscriptionEndpoint(deploymentName = "") {
    const s = getSettings();
    const currentProvider = s.cloudTranscriptionProvider || "openai";

    // Backstop against the OpenAI-default leak: Tinfoil goes through the main-process
    // proxy, never here — except self-hosted, which resolves its remote URL below.
    if (currentProvider === "tinfoil" && !isSelfHostedTranscription(s)) {
      throw new Error("Tinfoil transcription must go through the attested main-process proxy");
    }

    const currentBaseUrl = s.cloudTranscriptionBaseUrl || "";
    const transcriptionMode = s.transcriptionMode || "";
    const remoteUrl = (s.remoteTranscriptionUrl || "").trim();
    const deployment = (deploymentName || "").trim();

    const isSelfHosted = isSelfHostedTranscription(s);
    const isCustomEndpoint = isSelfHosted || currentProvider === "custom";

    // Never fall back to the cloud default for self-hosted — fail closed instead.
    if (isSelfHosted) {
      const normalizedRemote = normalizeBaseUrl(remoteUrl);
      if (!normalizedRemote || !isSecureEndpoint(normalizedRemote)) {
        throw new Error("Self-hosted transcription URL is invalid or unsupported");
      }
    }

    if (
      this.cachedTranscriptionEndpoint &&
      (this.cachedEndpointProvider !== currentProvider ||
        this.cachedEndpointDeployment !== deployment ||
        this.cachedEndpointBaseUrl !== currentBaseUrl ||
        this.cachedEndpointMode !== transcriptionMode ||
        this.cachedEndpointRemoteUrl !== remoteUrl)
    ) {
      logger.debug(
        "STT endpoint cache invalidated",
        {
          previousProvider: this.cachedEndpointProvider,
          newProvider: currentProvider,
          previousBaseUrl: this.cachedEndpointBaseUrl,
          newBaseUrl: currentBaseUrl,
          previousMode: this.cachedEndpointMode,
          newMode: transcriptionMode,
          previousRemoteUrl: this.cachedEndpointRemoteUrl,
          newRemoteUrl: remoteUrl,
        },
        "transcription"
      );
      this.cachedTranscriptionEndpoint = null;
    }

    if (this.cachedTranscriptionEndpoint) {
      return this.cachedTranscriptionEndpoint;
    }

    try {
      let base;
      if (isSelfHosted) {
        base = remoteUrl;
      } else if (currentProvider === "custom") {
        base = currentBaseUrl.trim() || API_ENDPOINTS.TRANSCRIPTION_BASE;
      } else if (currentProvider === "groq") {
        base = API_ENDPOINTS.GROQ_BASE;
      } else if (currentProvider === "xai") {
        base = API_ENDPOINTS.XAI_BASE;
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
          mode: transcriptionMode,
          isSelfHosted,
          isCustomEndpoint,
          rawBaseUrl: currentBaseUrl,
          remoteUrl,
          normalizedBase,
          defaultBase: API_ENDPOINTS.TRANSCRIPTION_BASE,
        },
        "transcription"
      );

      const cacheResult = (endpoint) => {
        this.cachedTranscriptionEndpoint = endpoint;
        this.cachedEndpointProvider = currentProvider;
        this.cachedEndpointBaseUrl = currentBaseUrl;
        this.cachedEndpointMode = transcriptionMode;
        this.cachedEndpointRemoteUrl = remoteUrl;
        this.cachedEndpointDeployment = deployment;

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
      if (isCustomEndpoint && isAzureOpenAIEndpoint(normalizedBase)) {
        // Azure OpenAI routes by deployment in the URL path and requires an
        // api-version query string — the plain {base}/audio/transcriptions
        // shape returns DeploymentNotFound. Build the deployment-style URL.
        // The api-version defaults to a transcribe-capable preview; a user can
        // override it by appending ?api-version=... to their endpoint URL.
        const azureUrl = buildAzureTranscriptionUrl(normalizedBase, deployment);
        if (azureUrl) {
          endpoint = azureUrl;
          logger.debug(
            "STT endpoint: built Azure deployment URL",
            { base: normalizedBase, deployment, endpoint },
            "transcription"
          );
        } else {
          endpoint = buildApiUrl(normalizedBase, "/audio/transcriptions");
          logger.warn(
            "STT endpoint: Azure host detected but no deployment name; falling back to default path",
            { base: normalizedBase, endpoint },
            "transcription"
          );
        }
      } else if (/\/audio\/(transcriptions|translations)$/i.test(normalizedBase)) {
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
      if (isSelfHosted) throw error;
      this.cachedTranscriptionEndpoint = API_ENDPOINTS.TRANSCRIPTION;
      this.cachedEndpointProvider = currentProvider;
      this.cachedEndpointBaseUrl = currentBaseUrl;
      this.cachedEndpointMode = transcriptionMode;
      this.cachedEndpointRemoteUrl = remoteUrl;
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
        routeKind: this.translationRequested ? "translation" : null,
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
        routeKind: this.translationRequested ? "translation" : null,
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

  async saveDiscardedTranscription(blob, durationSeconds) {
    let savedId = null;
    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        status: "discarded",
        routeKind: this.translationRequested ? "translation" : null,
      });
      if (!result?.id) return;
      savedId = result.id;

      if (blob) {
        const durationMs = durationSeconds ? Math.round(durationSeconds * 1000) : null;
        const arrayBuffer = await blob.arrayBuffer();
        await window.electronAPI.saveTranscriptionAudio(savedId, arrayBuffer, {
          durationMs,
          provider: null,
          model: null,
        });
      }

      syncService.debouncedPush("transcription", savedId);
    } catch (error) {
      logger.error(
        "Failed to save discarded transcription record",
        { error: error.message },
        "audio"
      );
      // A discarded row is only recoverable through its audio; if the audio save
      // failed, drop the dead row instead of leaving an empty unrecoverable entry. See #907.
      if (savedId != null) {
        try {
          await window.electronAPI.deleteTranscription(savedId);
        } catch (cleanupError) {
          logger.warn(
            "Failed to clean up discarded row after audio save failure",
            { error: cleanupError.message },
            "audio"
          );
        }
      }
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

    // Self-hosted transcription is batch HTTP to the user's server, never cloud realtime WS.
    if (isSelfHostedTranscription(s)) return false;

    // Corti (BYOK) streams over its own WSS — independent of OpenWhispr Cloud.
    if (s.cloudTranscriptionProvider === "corti" && s.cloudTranscriptionMode === "byok") {
      return !!(s.cortiClientId && s.cortiClientSecret);
    }

    // Tinfoil realtime streams without an OpenWhispr account.
    if (s.cloudTranscriptionProvider === "tinfoil") {
      const provider = getTranscriptionProvider("tinfoil");
      const model = provider?.models.find((m) => m.id === s.cloudTranscriptionModel);
      return !!model?.streaming && !!s.tinfoilApiKey;
    }

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
            cortiEnvironment,
            cortiTenant,
          } = getSettings();
          const res = await provider.warmup({
            sampleRate: 16000,
            language: warmupLang && warmupLang !== "auto" ? warmupLang : undefined,
            keyterms: this.getKeyterms(),
            model: cloudTranscriptionModel,
            mode: cloudTranscriptionMode === "byok" ? "byok" : "openwhispr",
            environment: cortiEnvironment,
            tenant: cortiTenant,
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

  async startStreamingRecording(forceDefaultMic = false) {
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
      const constraints = await this.getAudioConstraints(forceDefaultMic);
      const tConstraints = performance.now();

      // 1. Get mic stream (can take 10-15s on cold macOS mic driver)
      const rawStream = await navigator.mediaDevices.getUserMedia(constraints);
      const tMedia = performance.now();

      const stream = await this.acquireHealthyMicStream(rawStream, constraints);

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
            muted: audioTrack.muted,
            readyState: audioTrack.readyState,
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
      //    Frames sent before the connection is open are buffered (bounded) by
      //    sendAudio(), not dropped.
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
        const streamingSettings = getSettings();
        const {
          cloudTranscriptionModel,
          cloudTranscriptionMode,
          cortiEnvironment,
          cortiTenant,
          useLocalWhisper,
        } = streamingSettings;
        const sttLanguage = this.getEffectiveSttLanguage(streamingSettings);
        const res = await provider.start({
          sampleRate: 16000,
          language: sttLanguage && sttLanguage !== "auto" ? sttLanguage : undefined,
          keyterms: this.getKeyterms(),
          model: cloudTranscriptionModel,
          mode: cloudTranscriptionMode === "byok" ? "byok" : "openwhispr",
          environment: cortiEnvironment,
          tenant: cortiTenant,
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
      const stopRequested = this.stopRequestedDuringStreamingStart;
      this.streamingStartInProgress = false;
      this.stopRequestedDuringStreamingStart = false;

      if (isStaleDeviceError(error) && !forceDefaultMic && !stopRequested) {
        // Pinned mic is gone (Chromium rotates IDs / device unplugged). Retry once on the default mic. See #900.
        logger.warn(
          "Pinned microphone unavailable, retrying streaming on default mic",
          {},
          "streaming"
        );
        this.cachedMicDeviceId = null;
        await this.cleanupStreaming();
        this.isRecording = false;
        this.recordingStartTime = null;
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
        return this.startStreamingRecording(true);
      }

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
      } else if (error.name === "MicUnusableError") {
        errorTitle = "Microphone Muted";
        errorDescription =
          "Your microphones stayed muted and produced no audio. Please check your sound input settings and try again.";
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
    const streamingSttLanguage =
      getBaseLanguageCode(this.getEffectiveSttLanguage(stSettings)) || undefined;
    const streamingSttWordCount = finalText ? finalText.split(/\s+/).filter(Boolean).length : 0;

    let usedCloudReasoning = false;
    if (finalText && !this.skipReasoning) {
      const reasoningStart = performance.now();
      const agentName = localStorage.getItem("agentName") || null;
      const route = resolveReasoningRoute(
        finalText,
        stSettings,
        agentName,
        this.voiceAgentRequested,
        this.translationRequested
      );
      if (this.translationRequested && route.kind !== "translation") {
        this.notifyTranslationFallback("unreachable");
      }
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
              promptMode: "cleanup",
              customDictionary: getDictionaryHintWords(stSettings),
              customPrompt: this.getCustomPrompt(),
              language: this.getEffectiveSttLanguage(stSettings) || "auto",
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
        } else if (route.kind === "translation") {
          const chainResult = await this.runTranslationChain({
            text: finalText,
            settings: stSettings,
            agentName,
            route,
            cleanup:
              cleanupCloudMode === "openwhispr"
                ? {
                    mode: "cloudReason",
                    meta: {
                      sttProvider: this.getStreamingProviderName(),
                      sttModel: streamingSttModel,
                      sttProcessingMs: streamingSttProcessingMs,
                      sttWordCount: streamingSttWordCount,
                      sttLanguage: streamingSttLanguage,
                      audioDurationMs: durationSeconds
                        ? Math.round(durationSeconds * 1000)
                        : undefined,
                      audioSizeBytes: streamingAudioBytesSent || undefined,
                      audioFormat: "linear16",
                    },
                    log: { level: "error", channel: "streaming" },
                  }
                : {
                    mode: "model",
                    model: getEffectiveCleanupModel(),
                    log: { level: "error", channel: "streaming" },
                  },
          });
          finalText = chainResult.text;
          usedCloudReasoning = chainResult.usedCloudReasoning || usedCloudReasoning;
        }
      } catch (reasonError) {
        logger.error(
          "Streaming reasoning failed, using raw text",
          { error: reasonError.message },
          "streaming"
        );
        if (route.kind === "cleanup") recordCleanupFailure();
      }
    }

    // If streaming produced no text, fall back to batch — routed so BYOK audio
    // and cloud audio never cross over (see resolveStreamingFallbackTarget).
    let usedBatchFallback = false;
    let batchWarning = null;
    if (!finalText && durationSeconds > 2 && fallbackBlob?.size > 0) {
      const target = resolveStreamingFallbackTarget(getSettings());
      if (target === "skip") {
        logger.warn(
          "Skipping batch fallback: OpenWhispr Cloud session signed out",
          {},
          "streaming"
        );
      } else {
        logger.info(
          "Streaming produced no text, falling back to batch transcription",
          { durationSeconds, blobSize: fallbackBlob.size, target },
          "streaming"
        );
        try {
          // Cloud records usage server-side via /api/transcribe; BYOK has no metering.
          const batchResult =
            target === "cloud"
              ? await this.processWithOpenWhisprCloud(fallbackBlob, { durationSeconds })
              : await this.processWithOpenAIAPI(fallbackBlob, { durationSeconds });
          if (batchResult?.text) {
            finalText = batchResult.text;
            usedBatchFallback = true;
            batchWarning = batchResult.warning || null;
            logger.info("Batch fallback succeeded", { textLength: finalText.length }, "streaming");
          }
        } catch (fallbackErr) {
          logger.error("Batch fallback failed", { error: fallbackErr.message }, "streaming");
        }
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
        ...(batchWarning ? { warning: batchWarning } : {}),
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
      // Silence: still fire callback to dismiss the preview and show the no-audio toast.
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
    return (
      (!!settings.useCleanupModel ||
        !!settings.useDictationAgent ||
        (this.translationRequested && !!settings.useDictationTranslation)) &&
      !this.skipReasoning
    );
  }

  async cleanupPreview(options = {}) {
    const { dismiss = false, showCleanup = false } = options;

    // Claim the session's nodes synchronously so a recording started during the
    // flush await can never have its fresh nodes torn down by this cleanup.
    const processor = this._previewProcessor;
    const source = this._previewSource;
    const audioContext = this._previewAudioContext;
    this._previewProcessor = null;
    this._previewSource = null;
    this._previewAudioContext = null;

    if (processor) {
      // Wait for the worklet to flush its partial buffer so the final PCM
      // chunk reaches the stream before it is finished.
      let resolveFlush;
      const flushed = new Promise((resolve) => {
        resolveFlush = resolve;
        setTimeout(resolve, 150);
      });
      this._previewFlushResolve = resolveFlush;
      processor.port.postMessage("stop");
      await flushed;
      if (this._previewFlushResolve === resolveFlush) this._previewFlushResolve = null;
      processor.disconnect();
    }
    source?.disconnect();
    audioContext?.close().catch(() => {});
    if (dismiss) {
      window.electronAPI?.dismissDictationPreview?.();
      return null;
    }
    return (await window.electronAPI?.stopDictationPreview?.({ showCleanup })) || null;
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
    if (this._onDeviceChange) {
      navigator.mediaDevices?.removeEventListener?.("devicechange", this._onDeviceChange);
    }
  }
}

export { resolveReasoningRoute };
export default AudioManager;
