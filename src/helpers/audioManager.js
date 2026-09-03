import ReasoningService from "../services/ReasoningService";
import { PROVIDER_REGISTRY } from "../services/ai/inferenceProviders";
import logger from "../utils/logger";
import { isAzureOpenAIEndpoint } from "../utils/urlUtils";
import { withSessionRefresh } from "../lib/auth";
import { getBaseLanguageCode, getLanguageLabel } from "../utils/languageSupport";
import {
  applyChineseScript,
  mergeWhisperPrompt,
  resolveChineseScriptTarget,
  resolveCleanupLanguage,
} from "../utils/chineseScript";
import {
  createLocalSpeechGateState,
  getLocalSpeechGateDecision,
  recordLocalSpeechWindow,
} from "./localSpeechGate";
import { reacquireIfDead } from "./micTrackHealth";
import { isMicWarm, WARMUP_ACQUIRE_TIMEOUT_MS } from "./micWarmState";
import {
  PreparedMicCapture,
  disposePreparedCapture,
  discardPreRoll,
  PRE_ROLL_MAX_AGE_MS,
} from "./preparedMicCapture";
import { MicStreamHold } from "./micStreamHold";
import { ActiveMicRecoveryController } from "./activeMicRecovery";
import { followsSystemDefaultMic } from "./micSelectionRecovery";
import { isCacheableMicrophoneResolution, resolvePreferredMicrophone } from "./microphoneSelection";
import { isStaleDeviceError } from "./staleMicDevice";
import { shouldSaveDiscardedRecording } from "./discardedRecording";
import {
  getSettings,
  useSettingsStore,
  getEffectiveCleanupModel,
  isCloudCleanupMode,
  isCloudDictationAgentMode,
  isCloudTranslationMode,
  selectResolvedLLMConfig,
} from "../stores/settingsStore";
import {
  effectiveAudioRetentionDays,
  effectiveLocalHistoryEnabled,
  isAgentAllowed,
  isTranscriptionContextAllowed,
  isTranscriptionSelectionAllowed,
} from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import {
  getBatchTranscriptionModel,
  getCloudModel,
  getTranscriptionProvider,
  getTranscriptionProviders,
  isOnlineParakeetModel,
  isSherpaLocalProvider,
} from "../models/ModelRegistry";
import { TINFOIL_PROXY_REQUIRED_ERROR } from "../services/transcriptionBaseUrl";
import { resolveByokModel, resolveTranscriptionRoute } from "./transcriptionRoute.ts";
import { shouldSkipTranscriptionApiKey } from "./transcriptionAuth";
import {
  isSelfHostedTranscription,
  resolveSelfHostedTranscriptionModel,
} from "./selfHostedTranscription";
import { resolveStreamingFallbackTarget } from "./transcriptionFallback";
import {
  executeTranslationChain,
  hasTextContent,
  resolveTranslatedText,
  shouldRunTranslateStep,
} from "./translationChain";
import { detectAgentName, stripAgentAddress } from "../config/agentDetection";
import {
  resolveDictationRouteKind,
  resolveAgentImageTarget,
  resolveWakeWordLanguage,
} from "./dictationRouting";
import {
  resolveDictationAgentInference,
  resolveDictationAgentVisionInference,
} from "./dictationAgentInference";
import { resolveDictationTranslationInference } from "./dictationTranslationInference";
import { resolvePrompt, appendScreenContextSuffix } from "../config/prompts";
import { syncService } from "../services/SyncService.js";
import { evaluateFinishedRecording, withSalvageWarning } from "./recordingValidation";
import { isEmptyRecording } from "./recordingGuard";
import {
  analyzeDictionaryPromptFragment,
  DICTIONARY_ECHO_CODE,
  dictionaryEchoError,
  matchesDictionaryPrompt,
  payloadSendsDictionaryBias,
} from "../utils/dictionaryEchoFilter.js";
import { getDictionaryHintWords } from "../utils/snippets";
import { normalizeAgentSelectionContext } from "../utils/agentSelectionContext";
import { shouldDisplayDictationPreview } from "../utils/transcriptionPreview";
import {
  buildSelectionEditSystemPrompt,
  buildSelectionEditUserPrompt,
  extractSelectionEditReplacement,
  getSelectionCaptureDisposition,
} from "./selectionEditing";
import {
  REALTIME_MODELS,
  defaultStreamingProviderName,
  resolveStreamingProviderName,
  buildStreamingSessionOptions,
} from "./dictationStreamingRouting";

const REASONING_CACHE_TTL = 30000; // 30 seconds
const RECORDING_TIMESLICE_MS = 250; // flush chunks periodically so short recordings still carry audio frames. See #871.
// Failure detector only: fires when the worklet or audio graph is dead and never flushes.
const PREVIEW_FLUSH_WATCHDOG_MS = 1000;
const neverCancelled = () => false;
const MIN_SPARSE_RECORDING_DURATION_SECONDS = 3;
const MIN_UNIQUE_WORD_GAIN = 2;

const cleanupFailureFromError = (error) => ({
  message: error?.message || String(error),
  ...(error?.messageKey ? { messageKey: error.messageKey } : {}),
  ...(error?.messageParams ? { messageParams: error.messageParams } : {}),
  ...(error?.action ? { action: error.action } : {}),
  ...(error?.actionKey ? { actionKey: error.actionKey } : {}),
  ...(error?.copyCommand ? { copyCommand: error.copyCommand } : {}),
  ...(error?.technicalDetails ? { technicalDetails: error.technicalDetails } : {}),
});

const micDeviceKey = (settings) =>
  `${settings.microphoneSelectionMode}|${settings.selectedMicDeviceId}`;

function getEffectiveRetentionPreferences() {
  const settings = getSettings();
  const policyState = usePolicyStore.getState();
  return {
    dataRetentionEnabled: effectiveLocalHistoryEnabled(policyState, settings.dataRetentionEnabled),
    audioRetentionDays: effectiveAudioRetentionDays(policyState, settings.audioRetentionDays),
  };
}

const providerSupportsImages = (providerId) =>
  !!(providerId && PROVIDER_REGISTRY[providerId]?.supportsImages);

// Shared by the agent route and its text-only retry, which needs the prompt
// without the screen-context suffix.
function dictationAgentPrompt(settings, agentName) {
  return resolvePrompt("dictationAgent", {
    agentName,
    language: settings.preferredLanguage,
    customDictionary: getDictionaryHintWords(settings),
    uiLanguage: settings.uiLanguage,
  });
}

function dictationAgentReachable(settings) {
  return resolveDictationAgentInference(settings, { isCloudAgent: isCloudDictationAgentMode() })
    .reachable;
}

function translationChainReachable(settings) {
  return resolveDictationTranslationInference(settings, {
    isCloudTranslation: isCloudTranslationMode(),
  }).reachable;
}

function resolveReasoningRoute(
  text,
  settings,
  agentName,
  voiceAgentRequested,
  translationRequested,
  screenContext,
  detectedLanguage
) {
  const cleanup = selectResolvedLLMConfig(settings, "dictationCleanup");
  const cleanupReachable =
    !!settings.useCleanupModel && (!!cleanup.model?.trim() || isCloudCleanupMode());
  const agent = resolveDictationAgentInference(settings, {
    isCloudAgent: isCloudDictationAgentMode(),
  });

  const translation = resolveDictationTranslationInference(settings, {
    isCloudTranslation: isCloudTranslationMode(),
  });

  const kind = resolveDictationRouteKind({
    cleanupReachable,
    agentReachable: agent.reachable,
    // A translation recording never routes to the agent, so skip the scan.
    agentInvoked:
      !translationRequested &&
      !!agentName &&
      detectAgentName(text, agentName, resolveWakeWordLanguage(settings, detectedLanguage)),
    voiceAgentRequested,
    translationRequested,
    translationReachable: translation.reachable,
  });
  logger.logReasoning("ROUTE_RESOLVED", {
    kind,
    voiceAgentRequested,
    agentReachable: agent.reachable,
    agentMode: settings.dictationAgentMode,
    agentProvider: agent.displayProvider,
    agentModel: agent.model,
    hasScreenContext: !!screenContext,
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
    return {
      kind: "translation",
      model: translation.model,
      cleanupReachable,
      cleanupConfig: {
        inferenceScope: /** @type {const} */ ("dictationCleanup"),
        disableThinking: settings.cleanupDisableThinking,
      },
      config: {
        ...translation.config,
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
    const vision = resolveDictationAgentVisionInference(settings, {
      isSignedIn: settings.isSignedIn,
    });
    const { attach, useVisionOverride } = resolveAgentImageTarget({
      hasScreenContext: !!screenContext,
      visionOverrideActive: vision.active,
      visionProviderImageWired: providerSupportsImages(vision.config.provider),
      baseProviderImageWired: providerSupportsImages(agent.config.provider),
      isCloudAgent: isCloudDictationAgentMode(),
      baseModelSupportsVision: !!getCloudModel(agent.model)?.supportsVision,
    });
    const target = useVisionOverride ? vision : agent;
    logger.logReasoning("AGENT_IMAGE_TARGET", {
      hasScreenContext: !!screenContext,
      visionOverrideActive: vision.active,
      attach,
      useVisionOverride,
    });

    const systemPrompt = dictationAgentPrompt(settings, agentName);

    return {
      kind: "agent",
      model: target.model,
      config: {
        ...target.config,
        systemPrompt: attach
          ? appendScreenContextSuffix(systemPrompt, settings.uiLanguage)
          : systemPrompt,
        ...(attach ? { screenContext, textOnlySystemPrompt: systemPrompt } : {}),
        // Selection edits run on this (dictation) scope, so they need it
        // reachable; standalone commands run on the chat scope in the panel.
        selectionEditReachable: agent.reachable,
        // The panel re-decides attach/drop against the chat scope's model,
        // which may see images even when this scope's cannot — carry the raw
        // screenshot past the attach gate for that path.
        ...(screenContext ? { rawScreenContext: screenContext } : {}),
      },
    };
  }
  if (kind === "cleanup") {
    return {
      kind: "cleanup",
      config: {
        inferenceScope: /** @type {const} */ ("dictationCleanup"),
        disableThinking: settings.cleanupDisableThinking,
      },
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

// Realtime providers expose no finalize handshake (unlike Deepgram/AssemblyAI/
// Corti), so the transcript tail lands whenever it lands — wait, don't sleep.
const STREAMING_FINAL_QUIET_MS = 250;
const STREAMING_FINAL_CEILING_MS = 2000;

// Both realtime providers share the dictation realtime IPC surface and differ
// only in the token-provider id. Forcing `provider` here (even though
// buildStreamingSessionOptions already stamps it) is pinned by
// audioManagerStreamingRouting.test.js: the hardened main-process allowlist
// fails closed on an options object that lost the tag (#1624).
const makeDictationRealtimeProvider = (id) => ({
  awaitsFinalTranscript: true,
  warmup: (opts) => window.electronAPI.dictationRealtimeWarmup({ ...opts, provider: id }),
  start: (opts) => window.electronAPI.dictationRealtimeStart({ ...opts, provider: id }),
  send: (buf) => window.electronAPI.dictationRealtimeSend(buf),
  stop: () => window.electronAPI.dictationRealtimeStop(),
  onPartial: (cb) => window.electronAPI.onDictationRealtimePartial(cb),
  onFinal: (cb) => window.electronAPI.onDictationRealtimeFinal(cb),
  onError: (cb) => window.electronAPI.onDictationRealtimeError(cb),
  onSessionEnd: (cb) => window.electronAPI.onDictationRealtimeSessionEnd(cb),
});

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
  "openai-realtime": makeDictationRealtimeProvider("openai-realtime"),
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
  "tinfoil-realtime": makeDictationRealtimeProvider("tinfoil-realtime"),
};

// Batch providers that must transcribe via a main-process proxy (CORS,
// non-Bearer auth, OAuth, or attested transport) instead of a renderer fetch.
const PROXY_TRANSCRIPTION_PROVIDERS = {
  tinfoil: {
    displayName: "Tinfoil",
    ipc: () => window.electronAPI?.proxyTinfoilTranscription,
    buildPayload: ({ audioBuffer, language, dictionaryPrompt }) => ({
      audioBuffer,
      language,
      prompt: dictionaryPrompt || undefined,
    }),
  },
  mistral: {
    displayName: "Mistral",
    ipc: () => window.electronAPI?.proxyMistralTranscription,
    buildPayload: ({ audioBuffer, model, language, dictionaryPrompt }) => {
      const payload = { audioBuffer, model, language };
      const tokens = (dictionaryPrompt || "")
        .split(",")
        .flatMap((entry) => entry.trim().split(/\s+/))
        .filter(Boolean)
        .slice(0, 100);
      if (tokens.length > 0) payload.contextBias = tokens;
      return payload;
    },
  },
  gemini: {
    displayName: "Gemini",
    ipc: () => window.electronAPI?.proxyGeminiTranscription,
    buildPayload: ({ audioBuffer, model, language, keyterms }) => ({
      audioBuffer,
      model,
      language,
      keyterms: keyterms.length > 0 ? keyterms : undefined,
    }),
  },
  xai: {
    displayName: "xAI",
    ipc: () => window.electronAPI?.proxyXaiTranscription,
    buildPayload: ({ audioBuffer, language, keyterms }) => {
      const payload = { audioBuffer, language: language !== "auto" ? language : undefined };
      if (keyterms.length > 0) payload.keyterms = keyterms;
      return payload;
    },
  },
  corti: {
    displayName: "Corti",
    ipc: () => window.electronAPI?.proxyCortiTranscription,
    buildPayload: ({ audioBuffer, language, apiSettings }) => ({
      audioBuffer,
      // Corti requires a concrete primaryLanguage; default to English when auto-detecting
      language: language || "en",
      environment: apiSettings.cortiEnvironment || "us",
      tenant: (apiSettings.cortiTenant || "").trim() || "base",
    }),
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
    this.micCaptureStatus = "inactive";
    this.cachedApiKey = null;
    this.cachedApiKeyProvider = null;
    this._micWarmedAt = 0;
    this._startInProgress = false;
    this._micOpenReported = false;
    this.preparedMicCapture = new PreparedMicCapture({
      dispose: (prepared) => this._disposePrepared(prepared),
      onActiveChange: () => this._syncMicOpenGate(),
    });
    const micSettings = getSettings();
    this._micHoldSeconds = Number(micSettings.micWarmHoldSeconds) || 0;
    this._micDeviceKey = micDeviceKey(micSettings);
    this.micStreamHold = new MicStreamHold({
      holdSeconds: this._micHoldSeconds,
      onHoldChange: () => this._syncMicOpenGate(),
      isBusy: () =>
        this.isRecording ||
        this.isStreaming ||
        this.mediaRecorder?.state === "recording" ||
        this.preparedMicCapture.active,
    });

    // Every window owns an AudioManager (dictation and the agent overlay), so
    // the hold has to follow the setting here rather than in one window's hook.
    this._unsubscribeSettings = useSettingsStore.subscribe((state) => {
      const holdSeconds = Number(state.micWarmHoldSeconds) || 0;
      if (holdSeconds !== this._micHoldSeconds) {
        this._micHoldSeconds = holdSeconds;
        this.micStreamHold.setHoldSeconds(holdSeconds);
      }
      const deviceKey = micDeviceKey(state);
      if (deviceKey !== this._micDeviceKey) {
        this._micDeviceKey = deviceKey;
        this.cachedMicDeviceId = null;
        this.rejectedMicDeviceId = null;
        this._micWarmedAt = 0;
        this.cancelPreparedMicCapture();
        this.micStreamHold.drop();
      }
    });

    this._onApiKeyChanged = () => {
      this.cachedApiKey = null;
      this.cachedApiKeyProvider = null;
    };
    window.addEventListener("api-key-changed", this._onApiKeyChanged);

    // Invalidate the pinned mic device when the OS adds/removes/suspends inputs.
    // Otherwise wake-after-idle keeps requesting a stale deviceId that yields silence.
    this._onDeviceChange = () => {
      this.cachedMicDeviceId = null;
      this._micWarmedAt = 0;
      this.rejectedMicDeviceId = null;
      this.cancelPreparedMicCapture();
      this.micStreamHold.drop();
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", this._onDeviceChange);
    this.recordingStartTime = null;
    this.reasoningAvailabilityCache = { value: false, expiresAt: 0 };
    this.cachedReasoningPreference = null;
    this.isStreaming = false;
    this.streamingAudioContext = null;
    this.streamingSource = null;
    this.streamingAnalyser = null;
    this.streamingProcessor = null;
    this.streamingStream = null;
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextBump = null;
    this.streamingTextDebounce = null;
    this.cachedMicDeviceId = null;
    this.rejectedMicDeviceId = null;
    this.persistentAudioContext = null;
    this.workletModuleLoaded = false;
    this.workletBlobUrl = null;
    this.streamingStartInProgress = false;
    this._streamingStartSettlementWaiters = [];
    this.stopRequestedDuringStreamingStart = false;
    this._streamingStopPromise = null;
    this._streamingStopMode = null;
    this._streamingSessionGeneration = 0;
    this._streamingCancellationGeneration = 0;
    this._activeTranscriptionAbortController = null;
    this._activeStreamingSessionId = null;
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.translationApplied = false;
    this.pendingSelectionEdit = null;
    this.pendingAssistantConversation = null;
    this.pendingCleanupFailure = null;
    this._processingCancellationGeneration = 0;
    this._activeProcessingPipeline = null;
    this.assistantSelectionContext = null;
    this.screenContextPromise = null;
    this.selectionCapturePromise = null;
    this.sttConfig = null;
    this.warmupFailureStreak = 0;
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    this._localSpeechGateState = null;
    this._streamingCommitActive = false;
    this._previewFlushResolve = null;
    this._batchSegments = [];
    this._rotatingBatchRecorder = null;
    this._rotationResolve = null;
    this._stopRequestedDuringMicRecovery = false;
    this._cancelRequestedDuringMicRecovery = false;
    this._streamingFallbackSegments = [];
    this._streamingMicSwapPromise = null;
    this.micRecovery = new ActiveMicRecoveryController({
      mediaDevices: navigator.mediaDevices,
      acquire: async (reason) => {
        try {
          const constraints = await this.getAudioConstraints(
            false,
            reason === "devicechange" || reason === "devicechange-ended"
          );
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (error) {
          logger.debug(
            "Preferred mic unavailable during recovery, falling back to default",
            { error: error.message },
            "audio"
          );
          const fallback = await this.getAudioConstraints(true);
          return navigator.mediaDevices.getUserMedia(fallback);
        }
      },
      onRecovered: (replacement, previous) => this.replaceActiveMic(replacement, previous),
      onStatusChange: (status) => this.setMicCaptureStatus(status),
    });
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

  // Script conversion targets whatever the user ends up pasting: the translation
  // target when translating, otherwise the dictation language. Using the STT
  // language here would force zh-TW source audio back to Traditional even when
  // the user asked to translate into Simplified.
  //
  // Only a completed translate step actually moves text into the target language.
  // When translation is unreachable, skipped or fails, the source transcript is
  // what gets pasted, so it must be scripted as the STT language — otherwise a
  // failed ja → zh-CN run would run Japanese through OpenCC (会議の資料 → 会议の数据).
  getEffectiveOutputLanguage(settings) {
    if (this.translationRequested && this.translationApplied) {
      return settings.translationTargetLanguage || "auto";
    }
    return this.getEffectiveSttLanguage(settings);
  }

  // Whisper only accepts language "zh"; script (简体/繁體) is applied here. See #975.
  // No transcript exists yet, so only an explicit zh-CN/zh-TW may bias the prompt.
  getWhisperPrompt(settings = getSettings()) {
    return mergeWhisperPrompt(
      this.getCustomDictionaryPrompt(),
      resolveChineseScriptTarget(
        this.getEffectiveSttLanguage(settings),
        settings.chineseScriptPreference
      )
    );
  }

  // Cleanup runs before the translate step, so it still works in the STT language.
  getCleanupLanguage(settings) {
    return resolveCleanupLanguage(this.getEffectiveSttLanguage(settings));
  }

  finalizeChineseScript(text, settings = getSettings()) {
    return applyChineseScript(
      text,
      resolveChineseScriptTarget(
        this.getEffectiveOutputLanguage(settings),
        settings.chineseScriptPreference,
        text
      )
    );
  }

  // Check the dictionary on its own as well as the full prompt: the echo filter needs
  // 70% of the prompt's words to appear, and a Chinese script bias counts as one more
  // word, which alone pushes a one- or two-term dictionary under the threshold.
  isDictionaryEcho(text) {
    return (
      matchesDictionaryPrompt(text, this.getCustomDictionaryPrompt()) ||
      matchesDictionaryPrompt(text, this.getWhisperPrompt())
    );
  }

  setCallbacks({
    onStateChange,
    onError,
    // Optional: the agent overlay has no dictation toast surface.
    onNoAudio = undefined,
    onTranscriptionComplete,
    onPartialTranscript,
    onStreamingCommit,
    onTranslationFallback,
  }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onNoAudio = onNoAudio;
    this.onTranscriptionComplete = onTranscriptionComplete;
    this.onPartialTranscript = onPartialTranscript;
    this.onStreamingCommit = onStreamingCommit;
    this.onTranslationFallback = onTranslationFallback;
  }

  // Fail-open: translation degraded/failed but raw text is still pasted. Surface why.
  notifyTranslationFallback(reason) {
    this.onTranslationFallback?.({ reason });
  }

  setMicCaptureStatus(status) {
    if (this.micCaptureStatus === status) return;
    this.micCaptureStatus = status;
    this.onStateChange?.({
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStreaming: this.isStreaming,
      micCaptureStatus: status,
    });
  }

  async beginMicRecovery(stream) {
    // A stop/cancel can land during the awaits between recorder start and this
    // call; never arm recovery for a recording that already ended.
    if (!this.isRecording) return;
    await this.micRecovery.start(stream, {
      followDefault: followsSystemDefaultMic(getSettings()),
    });
  }

  async replaceActiveMic(replacement, previous) {
    if (!this.isRecording) throw new Error("Recording is no longer active");
    if (this.isStreaming) {
      await this.replaceStreamingMic(replacement, previous);
    } else {
      await this.replaceBatchMic(replacement, previous);
    }
  }

  async mergeRecordedSegments(segments) {
    // Header-only segments carry no audio frames and crash FFmpeg's concat (#871).
    const usable = segments.filter((segment) => segment && !isEmptyRecording(segment.size));
    if (usable.length === 0) return null;
    if (usable.length === 1) return usable[0];
    const payload = await Promise.all(
      usable.map(async (segment) => ({
        buffer: await segment.arrayBuffer(),
        mimeType: segment.type || "audio/webm",
      }))
    );
    const result = await window.electronAPI.mergeAudioSegments(payload);
    if (!result?.success) throw new Error(result?.error || "Failed to merge audio segments");
    return new Blob([result.buffer], { type: result.mimeType });
  }

  getLargestRecordedSegment(segments) {
    return segments
      .filter((segment) => segment && !isEmptyRecording(segment.size))
      .reduce(
        (largest, segment) => (segment.size > (largest?.size || 0) ? segment : largest),
        null
      );
  }

  setVoiceAgentRequested(requested) {
    this.voiceAgentRequested = requested;
    this.pendingSelectionEdit = null;
    this.pendingAssistantConversation = null;
    this.pendingCleanupFailure = null;
    this.assistantSelectionContext = null;
    // No recording must ever see a stale capture (e.g. left over from a
    // cancelled voice-agent recording, even after the setting was turned
    // off). A live voice-agent start re-captures right after this call.
    this.screenContextPromise = null;
    // Same for a prefetched selection: bounded to one recording, so a read taken
    // in an earlier app can never be edited in place by this command.
    this.selectionCapturePromise = null;
  }

  setAssistantSelectionContext(context) {
    this.assistantSelectionContext = normalizeAgentSelectionContext(context);
    if (this.assistantSelectionContext) this.selectionCapturePromise = null;
  }

  consumeAssistantSelectionContext() {
    const context = this.assistantSelectionContext;
    this.assistantSelectionContext = null;
    return context;
  }

  setTranslationRequested(requested) {
    this.translationRequested = requested;
    this.translationApplied = false;
  }

  // In translation mode the STT hint is the configured source language, not
  // the UI-wide preferred language; "auto" keeps whisper auto-detection.
  getEffectiveSttLanguage(settings) {
    if (this.translationRequested) {
      return settings.translationSourceLanguage || "auto";
    }
    return settings.preferredLanguage;
  }

  // Kicked off at voice-agent recording start (so the screenshot reflects the
  // invocation moment) and consumed after transcription by the reasoning route.
  beginScreenContextCapture() {
    this.screenContextPromise = window.electronAPI?.captureScreenContext?.() ?? null;
  }

  // Kicked off at voice-agent recording start, alongside the screenshot, so the
  // read resolves while the user is still speaking. The editable-caret probe
  // only matters when auto-paste could deliver to that caret, so the flag
  // spares the main process a binary spawn otherwise.
  beginSelectionCapture() {
    this.selectionCapturePromise =
      window.electronAPI?.captureSelectedText?.({
        probeEditable: Boolean(getSettings().autoPasteEnabled),
      }) ?? null;
    // Marks the stored promise handled without consuming it: a failure nobody is
    // awaiting yet must not surface as an unhandled rejection, and the awaiting
    // caller must still see the original error.
    this.selectionCapturePromise?.catch(() => {});
  }

  consumeSelectionCapture() {
    const pending = this.selectionCapturePromise;
    this.selectionCapturePromise = null;
    return (
      pending ??
      window.electronAPI?.captureSelectedText?.({
        probeEditable: Boolean(getSettings().autoPasteEnabled),
      })
    );
  }

  async consumeScreenContext() {
    const pending = this.screenContextPromise;
    this.screenContextPromise = null;
    if (!pending) return null;
    try {
      // Capture resolves in well under a second; the race only protects the
      // paste path if the IPC ever hangs.
      const image = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (!image) logger.logReasoning("SCREEN_CONTEXT_UNAVAILABLE", {});
      return image;
    } catch {
      return null;
    }
  }

  // An agent-route failure pastes the spoken command verbatim into the focused
  // app — surface that. Cleanup failures stay quiet; raw text is a fine result.
  _notifyAgentReasoningFailed() {
    this.onError?.({
      code: "AGENT_REASONING_FAILED",
      title: "Agent Unavailable",
      messageKey: "hooks.audioRecording.errorDescriptions.agentReasoningFailed",
    });
  }

  // The command still ran, so this is a downgrade notice rather than a failure.
  _notifyScreenContextSkipped() {
    this.onError?.({
      code: "SCREEN_CONTEXT_SKIPPED",
      title: "Screen Context Skipped",
      messageKey: "hooks.audioRecording.errorDescriptions.screenContextSkipped",
      variant: "default",
    });
  }

  isRecordingAllowedByPolicy() {
    const policyState = usePolicyStore.getState();
    return (
      isTranscriptionContextAllowed(policyState, getSettings(), "dictation") &&
      (!this.voiceAgentRequested || isAgentAllowed(policyState))
    );
  }

  assertAgentAllowedByPolicy() {
    if (isAgentAllowed(usePolicyStore.getState())) return;
    const error = new Error("AI agent use is restricted by your organization.");
    error.code = "POLICY_RESTRICTED";
    error.messageKey = "common.policyAgentRestricted";
    throw error;
  }

  setSttConfig(config) {
    this.sttConfig = config;
  }

  getStreamingProvider() {
    return STREAMING_PROVIDERS[this.getStreamingProviderName()];
  }

  getStreamingProviderName() {
    // Every AudioManager instance records dictation; notes and meetings have
    // their own routing, so the context is a literal here.
    const name = resolveStreamingProviderName({
      settings: getSettings(),
      context: "dictation",
      sttConfig: this.sttConfig,
    });
    // A server-driven sttConfig.streamingProvider we don't recognize must fall
    // back to a provider we can run — and the reported name must match the
    // channel bindings actually used, so the main process is never handed a
    // provider id it would fail closed on.
    return STREAMING_PROVIDERS[name] ? name : defaultStreamingProviderName("dictation");
  }

  async getAudioConstraints(forceDefaultMic = false, refreshSystemDefault = false) {
    const settings = getSettings();

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

    if (
      !forceDefaultMic &&
      !refreshSystemDefault &&
      this.cachedMicDeviceId &&
      this.cachedMicDeviceId !== this.rejectedMicDeviceId
    ) {
      return {
        audio: { deviceId: { exact: this.cachedMicDeviceId }, ...noProcessing },
      };
    }

    try {
      const resolution = await resolvePreferredMicrophone({
        settings,
        forceSystemDefault: forceDefaultMic,
        refreshSystemDefault: forceDefaultMic || refreshSystemDefault,
      });
      const deviceId = resolution.device?.deviceId;

      if (deviceId && deviceId !== this.rejectedMicDeviceId) {
        if (isCacheableMicrophoneResolution(resolution)) {
          this.cachedMicDeviceId = deviceId;
        }
        logger.debug(
          "Resolved microphone input",
          {
            mode: resolution.mode,
            status: resolution.status,
            label: resolution.device.label,
          },
          "audio"
        );
        return { audio: { deviceId: { exact: deviceId }, ...noProcessing } };
      }

      logger.debug(
        "Microphone selection could not be pinned; using browser fallback",
        { mode: resolution.mode, status: resolution.status },
        "audio"
      );
    } catch (error) {
      logger.debug(
        "Failed to resolve microphone selection; using browser fallback",
        { error: error.message },
        "audio"
      );
    }

    return { audio: noProcessing };
  }

  async cacheMicrophoneDeviceId() {
    if (this.cachedMicDeviceId) return; // Already cached

    try {
      const resolution = await resolvePreferredMicrophone({ settings: getSettings() });
      if (isCacheableMicrophoneResolution(resolution)) {
        this.cachedMicDeviceId = resolution.device.deviceId;
        logger.debug(
          "Microphone device ID pre-cached",
          { mode: resolution.mode, status: resolution.status },
          "audio"
        );
      }
    } catch (error) {
      logger.debug("Failed to pre-cache microphone device ID", { error: error.message }, "audio");
    }
  }

  // Open the mic the moment a dictation is likely (push-to-talk key-down,
  // toggle press) and hand the same stream — plus everything its pre-roll
  // recorder already captured — to the real recording. Replaces the one-shot
  // warmupMicDriver (#845): a raced warm-up never resolved before the
  // recording's own open, so it only ever added a concurrent double open.
  async prepareMicCapture() {
    // Preparing opens the device, so it answers to the same policy as the
    // recording it anticipates — otherwise a blocked user's key-down would
    // still light the mic and buffer pre-roll.
    if (!this.isRecordingAllowedByPolicy()) return null;
    // A start already awaiting the mic open leaves isRecording false for as long
    // as that open takes, so without this guard a second prepare would open the
    // device again and buffer a pre-roll no recording ever answers.
    if (
      this._startInProgress ||
      this.isRecording ||
      this.isProcessing ||
      this.isStreaming ||
      this._streamingStopPromise ||
      this.mediaRecorder?.state === "recording"
    ) {
      return null;
    }
    try {
      const prepared = await this.preparedMicCapture.prepare(async () => {
        const constraints = await this.getAudioConstraints();
        const stream = await this._acquireCaptureStream(constraints);
        const value = { stream, constraints, recorder: null, chunks: [], startedAt: Date.now() };
        if (!this.shouldUseStreaming()) this._startPreRollRecorder(value);
        return value;
      });
      if (prepared) {
        logger.debug("Microphone capture prepared", { preRoll: !!prepared.recorder }, "audio");
      }
      return prepared;
    } catch (e) {
      logger.debug("Mic capture preparation failed (non-critical)", { error: e.message }, "audio");
      return null;
    }
  }

  cancelPreparedMicCapture() {
    this.preparedMicCapture.cancel();
  }

  // Tells the main process whether this renderer is holding the mic open outside
  // a recording — an idle hold or a prepared capture. Recordings are gated by
  // setUserRecording instead. Without this the device-global macOS/Linux mic
  // signal reports our own capture as a meeting.
  _syncMicOpenGate() {
    const open = this.micStreamHold.active || this.preparedMicCapture.active;
    if (open === this._micOpenReported) return;
    this._micOpenReported = open;
    window.electronAPI?.micWarmHoldChanged?.(open);
  }

  _disposePrepared(prepared) {
    if (!prepared) return;
    disposePreparedCapture(prepared);
    this._markCaptureStreamReleased();
  }

  // Record from the instant the prepared stream delivers frames. If the hold
  // guard confirms a real dictation these chunks become the recording's opening;
  // a cancel discards them without the audio ever leaving the renderer.
  _startPreRollRecorder(prepared) {
    try {
      const recorder = new MediaRecorder(prepared.stream);
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) prepared.chunks.push(event.data);
      };
      recorder.start(RECORDING_TIMESLICE_MS);
      prepared.recorder = recorder;
    } catch (e) {
      logger.debug("Pre-roll recorder unavailable", { error: e.message }, "audio");
    }
  }

  _constraintsKey(constraints) {
    return JSON.stringify(constraints?.audio ?? constraints ?? {});
  }

  _stampMicWarm() {
    this._micWarmedAt = Date.now();
  }

  // Every capture-stream release funnels through here: the driver was
  // demonstrably open, so stamp warmth (a free warm window for the next open,
  // replacing #1284's post-transcription re-warm and its extra device open)
  // and restart the idle-hold countdown.
  _markCaptureStreamReleased() {
    this._stampMicWarm();
    this.micStreamHold.touch();
  }

  async _acquireCaptureStream(constraints) {
    const key = this._constraintsKey(constraints);
    const held = this.micStreamHold.acquireClone(key);
    if (held) {
      this._stampMicWarm();
      return held;
    }
    const stream = await this.acquireHealthyMicStream(
      await navigator.mediaDevices.getUserMedia(constraints),
      constraints
    );
    this._stampMicWarm();
    return this.micStreamHold.adoptAndClone(stream, key);
  }

  // TTL-gated warm-up used only by the streaming-connection warm-up. The
  // recording paths never warm-then-discard — they open once via
  // prepareMicCapture and keep the stream. A stream resolving past the deadline
  // still stamps warmth: the driver did come up, which is exactly what the
  // slowest machines need recorded (#845).
  async _warmMicDriverIfCold(logCategory) {
    // A held master already has the driver up; opening a second device to prove
    // it is the concurrent double open this replaced.
    if (this.micStreamHold.active) {
      this._stampMicWarm();
      return;
    }
    if (isMicWarm(this._micWarmedAt, Date.now())) return;
    try {
      const constraints = await this.getAudioConstraints();
      const streamPromise = navigator.mediaDevices.getUserMedia(constraints);
      streamPromise
        .then((stream) => {
          stream.getTracks().forEach((track) => track.stop());
          this._stampMicWarm();
        })
        .catch(() => {});
      let timer = null;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("mic warmup timed out")),
          WARMUP_ACQUIRE_TIMEOUT_MS
        );
      });
      try {
        await Promise.race([streamPromise, deadline]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      logger.debug("Microphone driver pre-warmed", {}, logCategory);
    } catch (e) {
      logger.debug("Mic driver warmup failed (non-critical)", { error: e.message }, logCategory);
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
    let prepared = null;
    let preparedAdopted = false;
    this._startInProgress = true;
    try {
      if (!this.isRecordingAllowedByPolicy()) {
        logger.warn("Recording blocked by workspace policy", {}, "audio");
        return false;
      }
      if (
        this.isRecording ||
        this.isProcessing ||
        this.isStreaming ||
        this._streamingStopPromise ||
        this.mediaRecorder?.state === "recording"
      ) {
        return false;
      }

      const startRequestedAt = performance.now();
      prepared = forceDefaultMic ? null : await this.preparedMicCapture.take();
      const constraints =
        prepared?.constraints ?? (await this.getAudioConstraints(forceDefaultMic));
      const micStream = prepared?.stream ?? (await this._acquireCaptureStream(constraints));
      const micReadyAt = performance.now();

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
        this._silenceSource = this._silenceCtx.createMediaStreamSource(micStream);
        this._silenceSource.connect(this._silenceAnalyser);
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

      this.audioChunks = [];
      this._batchSegments = [];
      this._stopRequestedDuringMicRecovery = false;
      this._cancelRequestedDuringMicRecovery = false;
      this._receivedAudioData = false;
      if (prepared && Date.now() - prepared.startedAt > PRE_ROLL_MAX_AGE_MS) {
        discardPreRoll(prepared);
      }
      const preRoll =
        prepared?.recorder && prepared.recorder.state === "recording"
          ? { recorder: prepared.recorder, chunks: prepared.chunks }
          : null;
      // Pre-roll audio is part of the recording, so the reported duration
      // starts when the prepared stream started — but only when its recorder
      // was adopted; a prepared stream without pre-roll contributes no audio
      // before this point, and back-dating would inflate durationSeconds.
      this.recordingStartTime = preRoll ? prepared.startedAt : Date.now();
      this.createBatchRecorder(micStream, preRoll);
      preparedAdopted = true;
      this.isRecording = true;
      this.onStateChange?.({
        isRecording: true,
        isProcessing: false,
        micCaptureStatus: "active",
      });
      logger.info(
        "Recording start timing",
        {
          micReadyMs: Math.round(micReadyAt - startRequestedAt),
          totalMs: Math.round(performance.now() - startRequestedAt),
          usedPreparedCapture: !!prepared,
          preparedAgeMs: prepared?.startedAt ? Date.now() - prepared.startedAt : 0,
        },
        "audio"
      );

      const {
        showTranscriptionPreview,
        useLocalWhisper,
        localTranscriptionProvider,
        whisperModel,
        parakeetModel,
        cohereModel,
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

          const model = isNvidia
            ? parakeetModel
            : localTranscriptionProvider === "cohere"
              ? cohereModel
              : whisperModel;
          const language = getBaseLanguageCode(getSettings().preferredLanguage);
          window.electronAPI?.startDictationPreview?.({
            provider: localTranscriptionProvider,
            model,
            language,
            display: shouldDisplayDictationPreview(
              showTranscriptionPreview,
              this.voiceAgentRequested
            ),
          });
          this._streamingCommitActive = streamingCommit;
        } catch (e) {
          logger.warn("Preview worklet setup failed", { error: e.message }, "audio");
        }
      }

      await this.beginMicRecovery(micStream);

      return true;
    } catch (error) {
      // A prepared value the recording never adopted still owns a live stream
      // (and possibly a pre-roll recorder); release it before any retry.
      if (prepared && !preparedAdopted) this._disposePrepared(prepared);
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
    } finally {
      this._startInProgress = false;
    }
  }

  createBatchRecorder(micStream, adoption = null) {
    // Adopting the pre-roll recorder keeps every chunk captured since key-down:
    // rebinding the handlers below transfers ownership with no gap and no
    // re-encode, and the seeded chunks become the recording's opening.
    const recorder = adoption?.recorder ?? new MediaRecorder(micStream);
    const segmentChunks = adoption ? [...adoption.chunks] : [];
    if (segmentChunks.length > 0) {
      this._receivedAudioData = true;
      // The speech-gate analyser only attaches at recording start, so it never
      // measured these frames. Fail the gate open rather than let it discard a
      // short utterance spoken entirely in pre-roll (#845).
      this._localSpeechGateState = null;
    }
    this.mediaRecorder = recorder;
    this.audioChunks = segmentChunks;
    this.recordingMimeType = recorder.mimeType || "audio/webm";

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this._receivedAudioData = true;
        segmentChunks.push(event.data);
      }
    };

    recorder.onstop = async () => {
      const segment = new Blob(segmentChunks, { type: recorder.mimeType || "audio/webm" });
      segmentChunks.length = 0;
      const rotating = this._rotatingBatchRecorder === recorder;
      // The recorder also stops on its own when its mic track dies (the stream
      // goes inactive). While recovery is armed, treat that like a rotation:
      // bank the segment and keep the recording alive for the replacement mic.
      if (rotating || this.micRecovery.started) {
        if (segment.size > 0) this._batchSegments.push(segment);
        micStream.getTracks().forEach((track) => track.stop());
        this._markCaptureStreamReleased();
        if (rotating) {
          this._rotatingBatchRecorder = null;
          this._rotationResolve?.();
          this._rotationResolve = null;
        } else {
          void this.micRecovery.recover("recorder-stopped");
        }
        return;
      }

      micStream.getTracks().forEach((track) => track.stop());
      this._markCaptureStreamReleased();
      await this.finalizeBatchRecording(segment);
    };

    if (!adoption) recorder.start(RECORDING_TIMESLICE_MS);
    return recorder;
  }

  async finalizeBatchRecording(finalSegment) {
    const processingPipeline = this._startProcessingPipeline();
    const wasCancelled = () => this._shouldAbandonProcessingPipeline(processingPipeline);
    this.micRecovery.stop();
    this.teardownSpeechGate();
    const previewStopPromise = this.cleanupPreview({
      showCleanup: this.shouldShowPreviewCleanupState(),
    });
    this.isRecording = false;
    this.isProcessing = true;
    this.onStateChange?.({
      isRecording: false,
      isProcessing: true,
      micCaptureStatus: "inactive",
    });

    const segments = finalSegment ? [...this._batchSegments, finalSegment] : this._batchSegments;
    this._batchSegments = [];
    const segmentsCount = segments.filter((segment) => segment?.size > 0).length;
    let audioBlob = null;
    let salvagedRecording = false;
    try {
      audioBlob = await this.mergeRecordedSegments(segments);
    } catch (error) {
      if (wasCancelled()) {
        this._settleProcessingPipeline(processingPipeline);
        return;
      }
      logger.error("Failed to assemble recovered recording", { error: error.message }, "audio");
      // Salvage the largest segment rather than dropping the whole recording.
      audioBlob = this.getLargestRecordedSegment(segments);
      salvagedRecording = !!audioBlob;
    }
    if (wasCancelled()) {
      this._settleProcessingPipeline(processingPipeline);
      return;
    }
    audioBlob = audioBlob || new Blob([], { type: this.recordingMimeType || "audio/webm" });
    this.lastAudioBlob = audioBlob;

    logger.info(
      "Recording stopped",
      {
        blobSize: audioBlob.size,
        blobType: audioBlob.type,
        segmentsCount,
      },
      "audio"
    );

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;
    this.recordingStartTime = null;
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
      if (!this._settleProcessingPipeline(processingPipeline)) return;
      this._localSpeechGateState = null;
      this.onTranscriptionComplete?.({ success: true, text: "" });
      return;
    }
    // Non-commit sessions stop concurrently with the decode below.
    const previewStop = this._streamingCommitActive ? await previewStopPromise : null;
    if (wasCancelled()) {
      this._settleProcessingPipeline(processingPipeline);
      return;
    }
    this._streamingCommitActive = false;

    await this.processAudio(
      audioBlob,
      {
        durationSeconds,
        ...(salvagedRecording ? { salvagedRecording: true } : {}),
        ...(previewStop?.streamed ? { streamedText: previewStop.text } : {}),
      },
      processingPipeline
    );
  }

  async replaceBatchMic(replacement) {
    try {
      const recorder = this.mediaRecorder;
      if (!recorder) throw new Error("Batch recorder is no longer active");
      // An auto-stopped recorder (mic track died) already banked its segment in
      // onstop; only a live recorder needs the explicit rotation handshake.
      if (recorder.state === "recording") {
        await new Promise((resolve) => {
          this._rotatingBatchRecorder = recorder;
          this._rotationResolve = resolve;
          recorder.stop();
        });
      }
      if (!this.isRecording) throw new Error("Recording stopped during microphone recovery");

      this._silenceSource?.disconnect();
      if (this._silenceCtx && this._silenceAnalyser) {
        this._silenceSource = this._silenceCtx.createMediaStreamSource(replacement);
        this._silenceSource.connect(this._silenceAnalyser);
      }
      this._previewSource?.disconnect();
      if (this._previewAudioContext && this._previewProcessor) {
        this._previewSource = this._previewAudioContext.createMediaStreamSource(replacement);
        this._previewSource.connect(this._previewProcessor);
      }
      this.createBatchRecorder(replacement);
    } finally {
      // Honor a stop/cancel that arrived mid-rotation even when the swap failed —
      // dropping it would leave an unstoppable recording (isRecording stuck true).
      const cancelRequested = this._cancelRequestedDuringMicRecovery;
      const stopRequested = this._stopRequestedDuringMicRecovery;
      this._cancelRequestedDuringMicRecovery = false;
      this._stopRequestedDuringMicRecovery = false;
      if (cancelRequested) this.cancelRecording();
      else if (stopRequested) this.stopRecording();
    }
  }

  stopRecording() {
    this.micRecovery.stop();
    if (this._rotatingBatchRecorder) {
      this._stopRequestedDuringMicRecovery = true;
      return true;
    }
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.stop();
      return true;
    }
    if (this.isRecording && !this.isStreaming) {
      // The mic died mid-recovery, so no live recorder exists; finalize what
      // was captured instead of leaving the recording unstoppable.
      void this.finalizeBatchRecording(null);
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
    this._silenceSource = null;
    this._levelData = null;
  }

  // Live input level (RMS 0..~1) for the waveform, read from whichever
  // pipeline is recording: the batch speech-gate analyser or the streaming
  // path's analyser. Null (waveform rests) when neither is live.
  getRecordingAudioLevel() {
    const pair = this._silenceAnalyser
      ? { ctx: this._silenceCtx, analyser: this._silenceAnalyser }
      : this.streamingAnalyser
        ? { ctx: this.streamingAudioContext, analyser: this.streamingAnalyser }
        : null;
    if (!pair?.ctx) return null;
    if (pair.ctx.state === "suspended") {
      // A suspended context reads flat silence — nudge it awake (not awaited;
      // resume() can hang when the output device is wedged).
      pair.ctx.resume().catch(() => {});
      return null;
    }
    if (pair.ctx.state !== "running") return null;
    const analyser = pair.analyser;
    if (!this._levelData || this._levelData.length !== analyser.fftSize) {
      this._levelData = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteTimeDomainData(this._levelData);
    let sum = 0;
    for (let i = 0; i < this._levelData.length; i++) {
      const v = (this._levelData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this._levelData.length);
  }

  cancelRecording() {
    this.micRecovery.stop();
    if (this._rotatingBatchRecorder) {
      this._cancelRequestedDuringMicRecovery = true;
      return true;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      const recorder = this.mediaRecorder;
      const discarded = this.takeDiscardedBatchSnapshot();
      this.mediaRecorder.onstop = () => {
        recorder.stream?.getTracks().forEach((track) => track.stop());
        this.persistDiscardedBatchRecording(discarded);
      };

      // Detach from manager state before recorder.stop(): its final
      // dataavailable/onstop land async and must not block or observe the
      // next recording.
      this.resetDiscardedBatchRecordingState();

      recorder.stop();

      if (recorder.stream) {
        recorder.stream.getTracks().forEach((track) => track.stop());
        this._markCaptureStreamReleased();
      }

      return true;
    }
    if (this.isRecording && !this.isStreaming) {
      // The mic died mid-recovery, so no live recorder exists; discard what was
      // captured instead of leaving the recording uncancelable.
      this.discardBatchRecording();
      return true;
    }
    return false;
  }

  discardBatchRecording() {
    const discarded = this.takeDiscardedBatchSnapshot();
    this.resetDiscardedBatchRecordingState();
    this.persistDiscardedBatchRecording(discarded);
  }

  takeDiscardedBatchSnapshot() {
    return {
      durationSeconds: this.recordingStartTime
        ? (Date.now() - this.recordingStartTime) / 1000
        : null,
      chunks: this.audioChunks,
      segments: this._batchSegments,
      mimeType: this.recordingMimeType,
    };
  }

  resetDiscardedBatchRecordingState() {
    this.teardownSpeechGate();
    this._localSpeechGateState = null;

    this.cleanupPreview({ dismiss: true });
    this.isRecording = false;
    this.isProcessing = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this._batchSegments = [];
    this.recordingStartTime = null;
    this.onStateChange?.({ isRecording: false, isProcessing: false });
  }

  persistDiscardedBatchRecording({ durationSeconds, chunks, segments, mimeType }) {
    // This must run after MediaRecorder's final dataavailable event, so decide
    // whether to retain the discarded audio from the snapshot rather than live
    // manager state (which may already belong to a new recording).
    const shouldSave =
      shouldSaveDiscardedRecording(getSettings(), durationSeconds, usePolicyStore.getState()) &&
      (chunks.length > 0 || segments.length > 0);
    if (shouldSave) {
      // Assemble and save in the background — the merge crosses IPC into FFmpeg
      // and must not delay the recorder becoming available again.
      void (async () => {
        try {
          const current = new Blob(chunks, { type: mimeType });
          const blob = await this.mergeRecordedSegments([...segments, current]);
          if (blob) await this.saveDiscardedTranscription(blob, durationSeconds);
        } catch (error) {
          const fallback = this.getLargestRecordedSegment([
            ...segments,
            new Blob(chunks, { type: mimeType }),
          ]);
          if (fallback) {
            try {
              await this.saveDiscardedTranscription(fallback, durationSeconds);
            } catch (fallbackError) {
              logger.warn(
                "Failed to save discarded recording fallback",
                { error: fallbackError.message },
                "audio"
              );
            }
            return;
          }
          logger.warn("Failed to save discarded recording", { error: error.message }, "audio");
        }
      })();
    }
  }

  _startProcessingPipeline() {
    const pipeline = {
      cancellationGeneration: this._processingCancellationGeneration ?? 0,
    };
    this._activeProcessingPipeline = pipeline;
    return pipeline;
  }

  _shouldAbandonProcessingPipeline(pipeline) {
    return (
      pipeline.cancellationGeneration !== (this._processingCancellationGeneration ?? 0) ||
      this._activeProcessingPipeline !== pipeline
    );
  }

  _settleProcessingPipeline(pipeline) {
    if (this._activeProcessingPipeline !== pipeline) return false;
    this._activeProcessingPipeline = null;
    if (this.isProcessing) {
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
    }
    return true;
  }

  cancelProcessing() {
    if (this.isProcessing) {
      this._processingCancellationGeneration = (this._processingCancellationGeneration ?? 0) + 1;
      this._requestStreamingCancellation();
      // Streaming finalization can be inside a provider or model await that
      // cannot be aborted. Keep the lifecycle truthfully busy until that await
      // observes the generation change and exits; advertising idle while the
      // stop promise still blocks a new recording makes hotkeys appear broken.
      if (this._streamingStopPromise) return true;

      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      // finalizeBatchRecording's earlier cleanupPreview() call (without
      // dismiss:true) already put the live-transcript panel in a "hold"
      // state — meant to keep showing the final/cleanup text, not close it.
      // onError used to be what actually closed the panel on a failure; the
      // processAudio cancel guard means onError never fires for a cancel, so
      // the close has to happen here instead, independent of onError. Only
      // reached when _streamingStopPromise was falsy above, i.e. never for a
      // streaming session (recording or finalizing) — its own preview
      // lifecycle is untouched by this call.
      window.electronAPI?.dismissDictationPreview?.();
      return true;
    }
    return false;
  }

  async processAudio(audioBlob, metadata = {}, processingPipeline = null) {
    const pipeline = processingPipeline ?? this._startProcessingPipeline();
    if (processingPipeline && this._activeProcessingPipeline !== processingPipeline) return;
    const wasCancelled = () => this._shouldAbandonProcessingPipeline(pipeline);
    const pipelineStart = performance.now();
    const settings = getSettings();
    let noAudioDetected = false;
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
      if (!this._settleProcessingPipeline(pipeline)) return;
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
        if (isSherpaLocalProvider(localProvider)) {
          activeModel = localProvider === "cohere" ? settings.cohereModel : parakeetModel;
          result = await this.processWithLocalParakeet(
            audioBlob,
            activeModel,
            metadata,
            wasCancelled
          );
        } else {
          activeModel = whisperModel;
          result = await this.processWithLocalWhisper(
            audioBlob,
            whisperModel,
            metadata,
            wasCancelled
          );
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
        result = await this.processWithOpenWhisprCloud(audioBlob, metadata, wasCancelled);
      } else {
        activeModel = this.getTranscriptionModel();
        result = await this.processWithOpenAIAPI(audioBlob, metadata, wasCancelled);
      }

      if (wasCancelled() || !this.isProcessing) {
        return;
      }

      this.lastAudioMetadata = {
        durationMs: metadata?.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : Math.round(performance.now() - pipelineStart),
        provider: result?.source || (useLocalWhisper ? localProvider : "cloud"),
        model: activeModel || null,
      };

      result = withSalvageWarning(result, metadata.salvagedRecording);

      result = { ...result, ...this._takePendingResultExtras() };
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

      if (wasCancelled()) {
        // The user cancelled mid-pipeline; the aborted request's rejection is
        // the expected outcome, not a failure to report or persist.
        logger.info("Transcription cancelled by user", { errorAtMs }, "performance");
        return;
      }

      logger.error(
        "Pipeline failed",
        {
          errorAtMs,
          error: error.message,
        },
        "performance"
      );

      if (error.code === DICTIONARY_ECHO_CODE) {
        // The transcript was discarded as an echo of the dictionary prompt.
        // Surface the shared soft no-audio outcome and keep the recording for
        // a manual retry — otherwise the whole utterance disappears with no
        // feedback (#1547).
        noAudioDetected = true;
        if (this.lastAudioBlob) {
          this.saveFailedTranscription(error.message, error.code, metadata);
        }
      } else if (error.message === "No audio detected") {
        noAudioDetected = true;
      } else {
        this.onError?.({
          title: error.selectionEditFatal ? "Selection Edit Failed" : "Transcription Error",
          description: error.selectionEditFatal
            ? error.message
            : `Transcription failed: ${error.message}`,
          code: error.code,
          messageKey: error.messageKey,
        });

        // Save failed transcription with audio so the user can retry later
        if (this.lastAudioBlob) {
          this.saveFailedTranscription(error.message, error.code || null, metadata);
        }
      }
    } finally {
      const shouldNotifyNoAudio =
        !wasCancelled() && noAudioDetected && this._activeProcessingPipeline === pipeline;
      this._settleProcessingPipeline(pipeline);
      // Every provider reports genuine silence through this one post-processing
      // outcome. The pill can now leave thinking before the error surface takes
      // ownership, instead of receiving an IPC event mid-pipeline.
      if (shouldNotifyNoAudio) this.onNoAudio?.();
    }
  }

  async processWithLocalWhisper(
    audioBlob,
    model = "base",
    metadata = {},
    wasCancelled = neverCancelled
  ) {
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
      const customDictionaryPrompt = this.getCustomDictionaryPrompt();
      const dictionaryPrompt = this.getWhisperPrompt();
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
      let result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);
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
        const strictDictionaryEcho = Boolean(
          dictionaryPrompt &&
          (matchesDictionaryPrompt(result.text, dictionaryPrompt) ||
            matchesDictionaryPrompt(result.text, customDictionaryPrompt))
        );
        const initialFragment = analyzeDictionaryPromptFragment(result.text, dictionaryPrompt);
        const dictionaryPromptFragment = !strictDictionaryEcho && initialFragment.isPromptFragment;
        // A non-repeated fragment can only be replaced by the sparse-recording rule
        // below, so on a short recording the retry would be decoded and then discarded.
        const retryCanBeAdopted =
          strictDictionaryEcho ||
          initialFragment.hasRepeatedWords ||
          (Number.isFinite(metadata.durationSeconds) &&
            metadata.durationSeconds >= MIN_SPARSE_RECORDING_DURATION_SECONDS);

        if ((strictDictionaryEcho || dictionaryPromptFragment) && retryCanBeAdopted) {
          // A prompt-free, VAD-free retry distinguishes real speech from Whisper
          // continuing either the whole dictionary prompt or a short fragment of it.
          const retryStart = performance.now();
          let retry = null;
          try {
            retry = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, {
              model: options.model,
              ...(options.language ? { language: options.language } : {}),
              skipVad: true,
            });
          } catch (retryError) {
            if (strictDictionaryEcho) throw retryError;
            // A heuristic recovery is best-effort; keep the initial text if it fails.
            logger.warn(
              "Dictionary-fragment retry failed; keeping the initial transcript",
              { message: retryError?.message },
              "audio"
            );
          }

          const retryText = retry?.success && typeof retry.text === "string" ? retry.text : "";
          const hasRetryText = Boolean(retryText.trim());
          const retryFragment = analyzeDictionaryPromptFragment(retryText, dictionaryPrompt);
          const retryStrictDictionaryEcho = Boolean(
            hasRetryText &&
            (matchesDictionaryPrompt(retryText, dictionaryPrompt) ||
              matchesDictionaryPrompt(retryText, customDictionaryPrompt))
          );
          // On the strict path a short, dictionary-spelled retry is the recovered
          // dictation (#1454), not a second echo — only another full-prompt echo
          // disqualifies it. The fragment test applies to the heuristic path alone.
          const retryStillPromptLike = strictDictionaryEcho
            ? retryStrictDictionaryEcho
            : retryStrictDictionaryEcho || retryFragment.isPromptFragment;
          const retryAddsUniqueWords =
            retryFragment.uniqueWordCount > initialFragment.uniqueWordCount;
          const repeatedFragmentRecovered =
            initialFragment.hasRepeatedWords && retryAddsUniqueWords;
          // A non-repeated dictionary term or snippet is valid short-form
          // dictation unless a long recording yields substantially more content.
          const sparseRecordingRecovered =
            Number.isFinite(metadata.durationSeconds) &&
            metadata.durationSeconds >= MIN_SPARSE_RECORDING_DURATION_SECONDS &&
            retryFragment.uniqueWordCount >= initialFragment.uniqueWordCount + MIN_UNIQUE_WORD_GAIN;
          const recovered =
            hasRetryText &&
            !retryStillPromptLike &&
            (strictDictionaryEcho || repeatedFragmentRecovered || sparseRecordingRecovered);

          logger.info(
            "Local dictionary-prompt recovery attempt",
            {
              reason: strictDictionaryEcho ? "strict-echo" : "prompt-fragment",
              retryDurationMs: Math.round(performance.now() - retryStart),
              promptLength: dictionaryPrompt.length,
              initialTextLength: result.text.length,
              retryTextLength: retryText.length,
              recovered,
            },
            "audio"
          );

          timings.transcriptionProcessingDurationMs = Math.round(
            performance.now() - transcriptionStart
          );

          if (recovered) {
            result = retry;
          } else if (strictDictionaryEcho) {
            throw dictionaryEchoError();
          }
        }
        const rawText = result.text;
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local", wasCancelled);
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
      if (error.selectionEditFatal) {
        throw error;
      }
      if (error.message === "No audio detected") {
        throw error;
      }

      const {
        allowOpenAIFallback,
        useLocalWhisper: isLocalMode,
        cloudTranscriptionProvider,
      } = getSettings();
      // A policy-blocked fallback surfaces the local failure, not a policy error.
      const fallbackAllowedByPolicy = isTranscriptionSelectionAllowed(usePolicyStore.getState(), {
        mode: "providers",
        provider: cloudTranscriptionProvider || "openai",
      });

      if (allowOpenAIFallback && isLocalMode && fallbackAllowedByPolicy) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata, wasCancelled);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          if (fallbackError.selectionEditFatal) {
            throw fallbackError;
          }
          throw new Error(
            `Local Whisper failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Local Whisper failed: ${error.message}`);
      }
    }
  }

  async processWithLocalParakeet(
    audioBlob,
    model = "parakeet-tdt-0.6b-v3",
    metadata = {},
    wasCancelled = neverCancelled
  ) {
    const timings = {};

    try {
      let result;
      const streamedText =
        typeof metadata.streamedText === "string" ? metadata.streamedText.trim() : null;
      // An empty stream is indistinguishable from silence; let the offline decode settle it.
      if (streamedText) {
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
        result = await window.electronAPI.transcribeLocalParakeet(arrayBuffer, {
          model,
          language: getBaseLanguageCode(this.getEffectiveSttLanguage(getSettings())),
        });
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
        const text = await this.processTranscription(result.text, "local-parakeet", wasCancelled);
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
      if (error.selectionEditFatal) {
        throw error;
      }
      if (error.message === "No audio detected") {
        throw error;
      }

      const {
        allowOpenAIFallback,
        useLocalWhisper: isLocalMode,
        cloudTranscriptionProvider,
      } = getSettings();
      // A policy-blocked fallback surfaces the local failure, not a policy error.
      const fallbackAllowedByPolicy = isTranscriptionSelectionAllowed(usePolicyStore.getState(), {
        mode: "providers",
        provider: cloudTranscriptionProvider || "openai",
      });

      if (allowOpenAIFallback && isLocalMode && fallbackAllowedByPolicy) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata, wasCancelled);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          if (fallbackError.selectionEditFatal) {
            throw fallbackError;
          }
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
    } else if (provider === "gemini") {
      apiKey = s.geminiApiKey;
      if (!apiKey?.trim()) {
        apiKey = await window.electronAPI.getGeminiKey?.();
      }
      if (!apiKey?.trim()) {
        const err = new Error(
          "Gemini API key not found. Please set your API key in the Control Panel."
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
    if (config?.requiresAgent) this.assertAgentAllowedByPolicy();
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

      // A screenshot the model or transport rejects must not cost the user
      // their command — rerun it text-only, swapping in the pre-built prompt
      // that never had the screen-context suffix. Rebuilding from scratch
      // would drop the selection-edit instructions and completion marker.
      // rawScreenContext/selectionEditReachable are routing-only keys (see
      // processAgentCommand) — keep the retry config clean of them too.
      if (config?.screenContext) {
        const {
          screenContext,
          rawScreenContext,
          selectionEditReachable,
          textOnlySystemPrompt,
          ...textOnlyConfig
        } = config;
        const result = await ReasoningService.processText(text, model, agentName, {
          ...textOnlyConfig,
          systemPrompt: textOnlySystemPrompt ?? dictationAgentPrompt(getSettings(), agentName),
        });
        this._notifyScreenContextSkipped();
        return result;
      }

      throw error;
    }
  }

  // Panel-first banking: the command streams into the assistant panel with
  // the chat's tools and memory once transcription completes; nothing types
  // at the cursor. The transcript flows back as the result text so history
  // and previews stay truthful.
  _bankAssistantDirective(transcript, config, options = {}) {
    if (!this.isProcessing) return;
    const { selectedContext, deliverySessionId } = options || {};
    this.pendingAssistantConversation = {
      transcript,
      // resolveReasoningRoute mirrors an attached screenContext into
      // rawScreenContext (same object), so the raw carry is the single source
      // to read — it also survives when the agent scope's attach gate dropped
      // the image (the panel re-decides against the chat scope's model).
      screenContext: config?.rawScreenContext ?? null,
      ...(selectedContext ? { selectedContext } : {}),
      ...(deliverySessionId ? { deliverySessionId } : {}),
    };
  }

  // Consume the directives banked during reasoning so that exactly one
  // transcription result — batch or streaming — carries them.
  _takePendingResultExtras() {
    const extras = {
      ...(this.pendingAssistantConversation
        ? { assistantConversation: this.pendingAssistantConversation }
        : {}),
      ...(this.pendingSelectionEdit ? { selectionEdit: this.pendingSelectionEdit } : {}),
      ...(this.pendingCleanupFailure ? { cleanupFailure: this.pendingCleanupFailure } : {}),
    };
    this.pendingAssistantConversation = null;
    this.pendingSelectionEdit = null;
    this.pendingCleanupFailure = null;
    return extras;
  }

  // Panel-first commands skip the dictation-agent model, so the org policy
  // guard that protected that model must run here instead.
  _bankPanelAgentCommand(
    text,
    agentName,
    config,
    { selectedContext, selectedText, deliverySessionId } = {}
  ) {
    this.assertAgentAllowedByPolicy();
    const command = this.voiceAgentRequested
      ? text
      : stripAgentAddress(text, agentName, resolveWakeWordLanguage(getSettings()));
    const transcript = selectedText === undefined ? command : `${command}\n\n"${selectedText}"`;
    this._bankAssistantDirective(transcript, config, { selectedContext, deliverySessionId });
    return text;
  }

  async processAgentCommand(text, model, agentName, config, wasCancelled = neverCancelled) {
    if (wasCancelled()) return text;
    const assistantSelectionContext = this.consumeAssistantSelectionContext();
    if (assistantSelectionContext) {
      // An in-panel selection is conversational context, not an editable OS
      // target. Keep it on the existing panel-first route and leave the
      // external selection replacement path completely untouched.
      this.selectionCapturePromise = null;
      return this._bankPanelAgentCommand(text, agentName, config, {
        selectedContext: assistantSelectionContext,
      });
    }

    let capture;
    try {
      capture = await this.consumeSelectionCapture();
    } catch (cause) {
      const error = new Error(
        `Selection edit could not safely read the selection: ${cause.message}`
      );
      error.code = "SELECTION_EDIT_CAPTURE_FAILED";
      error.messageKey = "hooks.audioRecording.selectionEditing.unavailable";
      error.selectionEditFatal = true;
      error.cause = cause;
      throw error;
    }
    if (wasCancelled()) return text;

    const captureDisposition = getSelectionCaptureDisposition(capture);
    const deliverySessionId =
      captureDisposition === "caret" && getSettings().autoPasteEnabled
        ? capture.sessionId
        : undefined;

    if (!config?.selectionEditReachable) {
      // No in-place editor: the panel never types, so only a readable
      // selection is quoted; every other capture sends the plain command.
      return this._bankPanelAgentCommand(text, agentName, config, {
        selectedText:
          captureDisposition === "selection" && typeof capture?.text === "string"
            ? capture.text
            : undefined,
        deliverySessionId,
      });
    }

    if (capture?.status === "too_large") {
      // A large selection definitely exists, so running the command as plain
      // agent dictation would paste over it — the one capture failure that
      // must not fall through.
      const error = new Error(
        `Selected text exceeds the ${capture.maxCharacters || 6000} character limit`
      );
      error.code = "SELECTION_EDIT_TOO_LARGE";
      error.messageKey = "hooks.audioRecording.selectionEditing.tooLarge";
      error.selectionEditFatal = true;
      throw error;
    }

    if (captureDisposition === "standalone" || captureDisposition === "caret") {
      return this._bankPanelAgentCommand(text, agentName, config, { deliverySessionId });
    }

    if (capture?.status !== "selected") {
      // A captured target changing, a synthetic-copy failure, or an unexpected
      // accessibility result is ambiguous: a normal agent paste could overwrite
      // unrelated selected text. Abort instead of falling through.
      const error = new Error("Selection edit could not safely verify the selected text");
      error.code = "SELECTION_EDIT_CAPTURE_FAILED";
      error.messageKey =
        captureDisposition === "changed"
          ? "hooks.audioRecording.selectionEditing.changed"
          : "hooks.audioRecording.selectionEditing.unavailable";
      error.selectionEditFatal = true;
      throw error;
    }

    // selectionEditReachable and rawScreenContext are routing directives for
    // this method, not reasoning options — strip them before the config
    // reaches ReasoningService.
    const { selectionEditReachable, rawScreenContext, ...reasoningOptions } = config ?? {};
    const selectionConfig = {
      ...reasoningOptions,
      maxTokens: Math.max(config?.maxTokens || 0, 8192),
      contextSize: Math.max(config?.contextSize || 0, 16384),
      temperature: config?.temperature ?? 0.2,
      requireCompleteOutput: true,
    };
    const completionMarker = `__OPENWHISPR_SELECTION_COMPLETE_${crypto.randomUUID()}__`;
    selectionConfig.systemPrompt = buildSelectionEditSystemPrompt(
      config?.systemPrompt,
      completionMarker
    );
    if (selectionConfig.textOnlySystemPrompt) {
      // The text-only retry prompt must carry the same selection-edit
      // instructions and marker, or a rejected screenshot loses the command.
      selectionConfig.textOnlySystemPrompt = buildSelectionEditSystemPrompt(
        selectionConfig.textOnlySystemPrompt,
        completionMarker
      );
    }
    const userPrompt = buildSelectionEditUserPrompt(text, capture.text);

    try {
      const result = await this.processWithReasoningModel(
        userPrompt,
        model,
        agentName,
        selectionConfig
      );
      if (wasCancelled()) return text;
      const replacement = extractSelectionEditReplacement(result, completionMarker);
      this.pendingSelectionEdit = { sessionId: capture.sessionId };
      return replacement;
    } catch (cause) {
      const error = new Error(`Selection edit failed: ${cause.message}`);
      error.code = "SELECTION_EDIT_REASONING_FAILED";
      error.messageKey = "hooks.audioRecording.selectionEditing.reasoningFailed";
      error.selectionEditFatal = true;
      error.cause = cause;
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
            language: this.getCleanupLanguage(settings),
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
      const chainResult = await executeTranslationChain({
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
        // No fallback toast here: an echoed translation usually means the dictation was
        // already in the target language, which the current app treats as silent success.
        onUnchangedTranslate: () => {
          const { channel } = cleanup.log || {};
          logger.warn("Translation step returned unchanged text, keeping source text", {}, channel);
        },
      });
      this.translationApplied = chainResult.translated;
      return chainResult;
    } catch (translateError) {
      // Translate step threw: raw text is still pasted by the caller. Surface the failure.
      this.notifyTranslationFallback("failed");
      throw translateError;
    }
  }

  async processTranscription(text, source, wasCancelled = neverCancelled) {
    const result = await this.processTranscriptionCore(text, source, wasCancelled);
    if (wasCancelled()) return result;
    return this.finalizeChineseScript(result);
  }

  async processTranscriptionCore(text, source, wasCancelled = neverCancelled) {
    const normalizedText = typeof text === "string" ? text.trim() : "";

    if (!normalizedText) {
      logger.logReasoning("TRANSCRIPTION_EMPTY_SKIPPING_REASONING", {
        source,
        reason: "Empty text after normalization",
      });
      return normalizedText;
    }
    if (wasCancelled()) return normalizedText;

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
      !(this.translationRequested && translationChainReachable(settings)) &&
      // A voice-assistant command always routes: standalone commands run on
      // the chat scope in the panel, so no dictation-scope model is needed.
      !this.voiceAgentRequested
    ) {
      logger.logReasoning("REASONING_SKIPPED", {
        reason: "No cleanup or dictation-agent model available",
      });
      return normalizedText;
    }

    const useReasoning = this.voiceAgentRequested || (await this.isReasoningAvailable());
    if (wasCancelled()) return normalizedText;

    logger.logReasoning("REASONING_CHECK", {
      useReasoning,
      cleanupModel,
      cleanupProvider,
      agentName,
    });

    if (useReasoning) {
      let route;
      try {
        const screenContext = this.voiceAgentRequested ? await this.consumeScreenContext() : null;
        route = resolveReasoningRoute(
          normalizedText,
          settings,
          agentName,
          this.voiceAgentRequested,
          this.translationRequested,
          screenContext
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

        const result =
          route.kind === "agent"
            ? await this.processAgentCommand(
                normalizedText,
                targetModel,
                agentName,
                {
                  ...reasoningConfig,
                  requiresAgent: true,
                },
                wasCancelled
              )
            : await this.processWithReasoningModel(
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

        // A blank reply must not wipe the dictation — keep the transcript (#1616).
        return hasTextContent(result) ? result : normalizedText;
      } catch (error) {
        if (error.selectionEditFatal) throw error;
        if (wasCancelled()) return normalizedText;
        logger.logReasoning("REASONING_FAILED", {
          error: error.message,
          stack: error.stack,
          fallbackToCleanup: true,
        });
        logger.warn("Reasoning failed", { source, error: error.message }, "notes");
        if (route?.kind === "cleanup") this.pendingCleanupFailure = cleanupFailureFromError(error);
        if (route?.kind === "agent") this._notifyAgentReasoningFailed();
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

  async processWithOpenWhisprCloud(audioBlob, metadata = {}, wasCancelled = neverCancelled) {
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
      (settings.useCleanupModel && cleanupCloudMode === "openwhispr") ||
      (this.translationRequested && translationChainReachable(settings) && isCloudTranslationMode())
    ) {
      opts.sendLogs = "false";
    }

    const dictionaryPrompt = this.getWhisperPrompt(settings);
    if (dictionaryPrompt) opts.prompt = dictionaryPrompt;

    // Use withSessionRefresh to handle AUTH_EXPIRED automatically
    const transcriptionStart = performance.now();
    const result = await withSessionRefresh(async () => {
      const res = await window.electronAPI.cloudTranscribe(arrayBuffer, opts);
      if (!res.success) {
        const err = new Error(res.error || "Cloud transcription failed");
        err.code = res.code;
        // The recording is kept by saveFailedTranscription, so point the user
        // at History rather than leaving them with a raw main-process string.
        if (res.code === "CHUNK_LOSS_EXCEEDED") {
          err.messageKey = "hooks.audioRecording.errorDescriptions.chunkLoss";
        }
        throw err;
      }
      return res;
    });
    timings.transcriptionProcessingDurationMs = Math.round(performance.now() - transcriptionStart);

    const rawText = result.text;
    if (this.isDictionaryEcho(rawText)) {
      throw dictionaryEchoError();
    }
    let processedText = result.text;
    if (processedText) {
      const reasoningStart = performance.now();
      const agentName = localStorage.getItem("agentName") || null;
      const screenContext = this.voiceAgentRequested ? await this.consumeScreenContext() : null;
      const route = resolveReasoningRoute(
        processedText,
        settings,
        agentName,
        this.voiceAgentRequested,
        this.translationRequested,
        screenContext,
        result.sttLanguage
      );
      if (this.translationRequested && route.kind !== "translation") {
        this.notifyTranslationFallback("unreachable");
      }
      const cleanupCloudMode = settings.cleanupCloudMode || "openwhispr";

      try {
        if (route.kind === "agent") {
          const reasoned = await this.processAgentCommand(
            processedText,
            route.model,
            agentName,
            {
              ...route.config,
              requiresAgent: true,
            },
            wasCancelled
          );
          if (hasTextContent(reasoned)) processedText = reasoned;
        } else if (route.kind === "cleanup" && cleanupCloudMode === "openwhispr") {
          const reasonResult = await withSessionRefresh(async () => {
            const res = await window.electronAPI.cloudReason(processedText, {
              agentName,
              promptMode: "cleanup",
              customDictionary: getDictionaryHintWords(settings),
              customPrompt: this.getCustomPrompt(),
              language: this.getCleanupLanguage(settings),
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

          // Cloud cleanup can return success with empty text; keep the raw transcription instead of wiping it.
          if (reasonResult.success && hasTextContent(reasonResult.text)) {
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
            if (hasTextContent(reasoned)) processedText = reasoned;
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
          processedText = resolveTranslatedText(processedText, chainResult);
        }
      } catch (reasonError) {
        if (reasonError.selectionEditFatal) throw reasonError;
        if (!wasCancelled()) {
          logger.error(
            "Cloud reasoning failed, using raw transcription",
            { error: reasonError.message },
            "transcription"
          );
          if (route.kind === "cleanup") {
            this.pendingCleanupFailure = cleanupFailureFromError(reasonError);
          }
          if (route.kind === "agent") this._notifyAgentReasoningFailed();
        }
      }
      timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);
    }

    return {
      success: true,
      text: await this.finalizeChineseScript(processedText, settings),
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

  async processWithOpenAIAPI(audioBlob, metadata = {}, wasCancelled = neverCancelled) {
    const timings = {};
    let requestController = null;
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
      // the key). Self-hosted wins, so a leftover proxied provider isn't diverted here.
      const proxySpec = PROXY_TRANSCRIPTION_PROVIDERS[provider];
      if (proxySpec && !isSelfHostedTranscription(apiSettings)) {
        const call = proxySpec.ipc();
        if (!call) {
          throw new Error(`${proxySpec.displayName} transcription is unavailable in this window`);
        }
        const apiCallStart = performance.now();
        const proxyPayload = proxySpec.buildPayload({
          audioBuffer: await optimizedAudio.arrayBuffer(),
          model,
          language,
          apiSettings,
          dictionaryPrompt: this.getWhisperPrompt(apiSettings),
          keyterms: this.getKeyterms()
            .map((t) => t.trim().slice(0, 50))
            .filter(Boolean)
            .slice(0, 100),
        });
        const result = await call(proxyPayload);
        if (result?.error) {
          const err = new Error(result.error);
          if (result.code) err.code = result.code;
          if (result.messageKey) err.messageKey = result.messageKey;
          throw err;
        }
        const proxyText = result?.text;
        if (!proxyText?.trim()) {
          throw new Error(`No text transcribed - ${proxySpec.displayName} response was empty`);
        }
        if (payloadSendsDictionaryBias(proxyPayload) && this.isDictionaryEcho(proxyText)) {
          throw dictionaryEchoError();
        }
        timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
        const reasoningStart = performance.now();
        const text = await this.processTranscription(proxyText, provider, wasCancelled);
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        const source = (await this.isReasoningAvailable()) ? `${provider}-reasoned` : provider;
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
      let dictionaryPrompt = this.getWhisperPrompt(apiSettings);
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

      const apiCallStart = performance.now();

      logger.debug(
        "Making transcription API request",
        { endpoint, shouldStream, model, provider, hasApiKey: !!apiKey },
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

      requestController = new AbortController();
      this._activeTranscriptionAbortController = requestController;
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: formData,
        signal: requestController.signal,
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
          throw dictionaryEchoError();
        }
        timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
        const rawText = result.text;

        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "openai", wasCancelled);
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
      if (error.name === "AbortError") throw error;
      if (error.selectionEditFatal) {
        throw error;
      }
      if (error.message === "No audio detected") {
        throw error;
      }

      const isOpenAIMode = !getSettings().useLocalWhisper;
      // A policy-blocked fallback surfaces the cloud failure, not a policy error.
      const fallbackAllowedByPolicy = isTranscriptionSelectionAllowed(usePolicyStore.getState(), {
        mode: "local",
        provider: "",
      });

      if (allowLocalFallback && isOpenAIMode && fallbackAllowedByPolicy) {
        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          const options = { model: fallbackModel };
          if (language && language !== "auto") {
            options.language = language;
          }

          const result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);

          if (result.success && result.text) {
            const text = await this.processTranscription(
              result.text,
              "local-fallback",
              wasCancelled
            );
            if (text) {
              return { success: true, text, source: "local-fallback" };
            }
          }
          throw error;
        } catch (fallbackError) {
          if (fallbackError.selectionEditFatal) {
            throw fallbackError;
          }
          const wrapped = new Error(
            `OpenAI API failed: ${error.message}. Local fallback also failed: ${fallbackError.message}`
          );
          if (error.code) wrapped.code = error.code;
          if (error.messageKey) wrapped.messageKey = error.messageKey;
          throw wrapped;
        }
      }
      throw error;
    } finally {
      if (this._activeTranscriptionAbortController === requestController) {
        this._activeTranscriptionAbortController = null;
      }
    }
  }

  getTranscriptionModel() {
    try {
      const s = getSettings();
      const selfHostedModel = resolveSelfHostedTranscriptionModel(s);
      if (selfHostedModel) return selfHostedModel;
      const provider = s.cloudTranscriptionProvider || "openai";
      // Tinfoil pins its batch model in the registry rather than in settings.
      if (provider === "tinfoil") {
        return getBatchTranscriptionModel("tinfoil");
      }
      return resolveByokModel(provider, s.cloudTranscriptionModel);
    } catch (error) {
      return "gpt-4o-mini-transcribe";
    }
  }

  // Local-vs-cloud is decided upstream, so useLocalWhisper is forced off here:
  // the local→cloud fallback resolves its cloud endpoint through this too.
  getTranscriptionEndpoint(deploymentName = "") {
    const route = resolveTranscriptionRoute({
      settings: { ...getSettings(), useLocalWhisper: false },
      policy: usePolicyStore.getState(),
      providers: getTranscriptionProviders(),
      request: { model: deploymentName },
    });
    if (route.transport === "error") {
      const error = new Error(route.message);
      if (route.code) error.code = route.code;
      if (route.messageKey) error.messageKey = route.messageKey;
      throw error;
    }
    if (route.transport !== "http-batch") {
      // Proxied providers are dispatched before endpoint resolution; reaching
      // here means that guard was bypassed — never fall open to a default.
      throw new Error(
        route.provider === "tinfoil"
          ? TINFOIL_PROXY_REQUIRED_ERROR
          : `${route.provider} transcription must go through the main-process proxy`
      );
    }
    logger.debug(
      "STT endpoint resolved",
      { endpoint: route.endpoint, provider: route.provider },
      "transcription"
    );
    return route.endpoint;
  }

  async safePaste(text, options = {}) {
    try {
      const result = await window.electronAPI.pasteText(text, options);
      return result?.pasted === true;
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
    const { dataRetentionEnabled, audioRetentionDays } = getEffectiveRetentionPreferences();
    if (!dataRetentionEnabled) {
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
        if (audioRetentionDays > 0) {
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
    const { dataRetentionEnabled, audioRetentionDays } = getEffectiveRetentionPreferences();
    if (!dataRetentionEnabled) {
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
        if (audioRetentionDays > 0) {
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
      isFinalizingStreaming: Boolean(this._streamingStopPromise),
      micCaptureStatus: this.micCaptureStatus,
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

    // The managed-cloud bootstrap only controls OpenWhispr Cloud. A user's
    // BYOK realtime model must not be downgraded because managed dictation is
    // configured for batch processing.
    if (s.cloudTranscriptionMode === "openwhispr" && this.sttConfig?.dictation?.mode === "batch") {
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
    if (!this.sttConfig) return false;
    return this.sttConfig.dictation?.mode === "streaming";
  }

  async warmupStreamingConnection({ isSignedIn: isSignedInOverride } = {}) {
    if (!this.isRecordingAllowedByPolicy()) {
      logger.debug("Streaming warmup skipped by workspace policy", {}, "streaming");
      return false;
    }
    if (!this.shouldUseStreaming(isSignedInOverride)) {
      logger.debug("Streaming warmup skipped - not in streaming mode", {}, "streaming");
      return false;
    }

    try {
      const providerName = this.getStreamingProviderName();
      const provider = STREAMING_PROVIDERS[providerName];
      const [, wsResult] = await Promise.all([
        this.cacheMicrophoneDeviceId(),
        withSessionRefresh(async () => {
          const settings = getSettings();
          const res = await provider.warmup(
            buildStreamingSessionOptions({
              providerName,
              settings,
              language: settings.preferredLanguage,
              keyterms: this.getKeyterms(),
              voiceAgentRequested: this.voiceAgentRequested,
            })
          );
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

        // Warm up the OS audio driver by briefly acquiring the mic, then
        // releasing. TTL-gated: drivers go cold again after idle, so this must
        // re-fire once the warm window lapses (#845).
        await this._warmMicDriverIfCold("streaming");

        this.warmupFailureStreak = 0;
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
        this._reportWarmupFailure(providerName, wsResult.error, wsResult.code);
        return false;
      }
    } catch (error) {
      this._reportWarmupFailure(this.getStreamingProviderName(), error.message, error.code);
      return false;
    }
  }

  // Warmup exercises the same connect that recording start will make, so a
  // failing warmup predicts a guaranteed user-facing failure at the next
  // keypress — #1624 logged exactly this on every idle cycle for days at warn
  // level and nobody saw it. Error level, provider named, streak counted.
  _reportWarmupFailure(provider, error, code) {
    this.warmupFailureStreak += 1;
    logger.error(
      "Streaming warmup failed",
      { provider, error, code, consecutiveFailures: this.warmupFailureStreak },
      "streaming"
    );
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

  startStreamingFallbackRecorder(stream) {
    try {
      const chunks = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data?.size > 0) chunks.push(event.data);
      };
      recorder.start(RECORDING_TIMESLICE_MS);
      this.streamingFallbackRecorder = recorder;
      this.streamingFallbackChunks = chunks;
      return recorder;
    } catch (error) {
      logger.debug("Fallback recorder failed to start", { error: error.message }, "streaming");
      this.streamingFallbackRecorder = null;
      return null;
    }
  }

  async finishStreamingFallbackSegment() {
    const recorder = this.streamingFallbackRecorder;
    if (!recorder) return null;
    const chunks = this.streamingFallbackChunks;
    const collect = () => new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    let blob;
    if (recorder.state === "recording") {
      blob = await new Promise((resolve) => {
        recorder.onstop = () => resolve(collect());
        recorder.stop();
      });
    } else {
      // The recorder auto-stops when its track dies; its chunks still hold the
      // audio captured up to that point.
      blob = collect();
    }
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    if (blob?.size > 0) this._streamingFallbackSegments.push(blob);
    return blob;
  }

  async replaceStreamingMic(replacement, previous) {
    if (!this.streamingProcessor || !this.streamingAudioContext) {
      throw new Error("Streaming audio pipeline is unavailable");
    }
    const swap = (async () => {
      const nextSource = this.streamingAudioContext.createMediaStreamSource(replacement);
      nextSource.connect(this.streamingProcessor);
      this.streamingSource?.disconnect();
      this.streamingSource = nextSource;
      if (this.streamingAnalyser) this.streamingSource.connect(this.streamingAnalyser);
      await this.finishStreamingFallbackSegment();
      if (!this.isStreaming || !this.isRecording) {
        throw new Error("Streaming stopped during microphone recovery");
      }
      this.startStreamingFallbackRecorder(replacement);
      previous?.getTracks().forEach((track) => track.stop());
      this.streamingStream = replacement;
    })();
    // Expose the swap so stopStreamingRecording can wait for it instead of
    // racing it (losing the newest fallback segment / orphaning a recorder).
    this._streamingMicSwapPromise = swap.catch(() => {});
    try {
      await swap;
    } finally {
      this._streamingMicSwapPromise = null;
    }
  }

  _waitForStreamingStartSettlement() {
    if (!this.streamingStartInProgress) return Promise.resolve();
    return new Promise((resolve) => {
      this._streamingStartSettlementWaiters.push(resolve);
    });
  }

  _settleStreamingStart() {
    this.streamingStartInProgress = false;
    for (const resolve of this._streamingStartSettlementWaiters.splice(0)) resolve();
  }

  async startStreamingRecording(forceDefaultMic = false) {
    let acquiredStream = null;
    let usedPreparedCapture = false;
    let sessionId = null;
    let startWasCancelled = () => false;
    this._startInProgress = true;
    try {
      if (!this.isRecordingAllowedByPolicy()) {
        logger.warn("Streaming recording blocked by workspace policy", {}, "audio");
        return false;
      }
      if (this.streamingStartInProgress) {
        return false;
      }
      this.streamingStartInProgress = true;

      if (this.isRecording || this.isStreaming || this.isProcessing || this._streamingStopPromise) {
        this._settleStreamingStart();
        return false;
      }

      this.stopRequestedDuringStreamingStart = false;
      sessionId = (this._streamingSessionGeneration || 0) + 1;
      this._streamingSessionGeneration = sessionId;
      this._activeStreamingSessionId = sessionId;
      const ownsSession = () => this._activeStreamingSessionId === sessionId;
      const cancellationGeneration = this._streamingCancellationGeneration;
      startWasCancelled = () => cancellationGeneration !== this._streamingCancellationGeneration;

      const t0 = performance.now();
      const prepared = forceDefaultMic ? null : await this.preparedMicCapture.take();
      // Prepared while batch mode was expected; keep the stream, drop the pre-roll
      // (the streaming transcript comes from the PCM worklet, not these chunks).
      discardPreRoll(prepared);
      usedPreparedCapture = !!prepared;
      const constraints =
        prepared?.constraints ?? (await this.getAudioConstraints(forceDefaultMic));
      const tConstraints = performance.now();

      // 1. Get mic stream (can take 10-15s on a cold driver — unless a prepared
      //    capture or a held master stream already opened the device).
      const stream = prepared?.stream ?? (await this._acquireCaptureStream(constraints));
      acquiredStream = stream;
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
            muted: audioTrack.muted,
            readyState: audioTrack.readyState,
          },
          "audio"
        );
      }

      // Start fallback recorder in case streaming produces no results.
      this._streamingFallbackSegments = [];
      this.startStreamingFallbackRecorder(stream);

      // 2. Set up audio pipeline so frames flow the instant WebSocket is ready.
      //    Frames sent before the connection is open are buffered (bounded) by
      //    sendAudio(), not dropped.
      const audioContext = await this.getOrCreateAudioContext();
      this.streamingAudioContext = audioContext;
      this.streamingSource = audioContext.createMediaStreamSource(stream);
      this.streamingStream = stream;

      // Level source for the live waveform: the batch path reads the
      // speech-gate analyser, which never attaches to streaming recordings.
      this.streamingAnalyser = audioContext.createAnalyser();
      this.streamingAnalyser.fftSize = 2048;
      this.streamingSource.connect(this.streamingAnalyser);

      if (!this.workletModuleLoaded) {
        await audioContext.audioWorklet.addModule(this.getWorkletBlobUrl());
        this.workletModuleLoaded = true;
      }

      this.streamingProcessor = new AudioWorkletNode(audioContext, "pcm-streaming-processor");
      const provider = this.getStreamingProvider();

      this.streamingProcessor.port.onmessage = (event) => {
        // The worklet posts its remaining PCM followed by a "flushed" sentinel
        // on stop; the sentinel must not be sent as audio (realtime backends
        // reject the odd-length non-PCM bytes with "Invalid audio data").
        if (!ownsSession() || !this.isStreaming || event.data === "flushed") return;
        provider.send(event.data);
      };

      this.isStreaming = true;
      this.streamingSource.connect(this.streamingProcessor);

      const tPipeline = performance.now();

      // 3. Register IPC event listeners BEFORE connecting, so no transcript
      //    events are lost during the connect handshake.
      this.streamingFinalText = "";
      this.streamingPartialText = "";
      this.streamingTextBump = null;
      this.streamingTextDebounce = null;

      const partialCleanup = provider.onPartial((text) => {
        if (!ownsSession()) return;
        this.streamingPartialText = text;
        this.streamingTextBump?.();
        this.onPartialTranscript?.(text);
      });

      const finalCleanup = provider.onFinal((text) => {
        if (!ownsSession()) return;
        // text = accumulated final text from streaming provider.
        // Extract just the new segment (delta from previous accumulated final).
        const prevLen = this.streamingFinalText.length;
        this.streamingFinalText = text;
        this.streamingPartialText = "";
        this.streamingTextBump?.();
        const newSegment = text.slice(prevLen);
        if (newSegment) {
          this.onStreamingCommit?.(newSegment);
        }
      });

      const errorCleanup = provider.onError((error) => {
        if (!ownsSession()) return;
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
        if (!ownsSession()) return;
        logger.debug("Streaming session ended", data, "streaming");
        if (data.text) {
          this.streamingFinalText = data.text;
        }
      });

      this.streamingCleanupFns = [partialCleanup, finalCleanup, errorCleanup, sessionEndCleanup];
      if (startWasCancelled()) {
        // Cancelled while the mic was opening: never flip to recording.
        await this.cleanupStreaming();
        if (ownsSession()) this._activeStreamingSessionId = null;
        // cancelStreamingRecording may already be awaiting this start's
        // settlement before it can disconnect the provider.
        this._settleStreamingStart();
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
        return false;
      }
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this.onStateChange?.({ isRecording: true, isProcessing: false, isStreaming: true });
      await this.beginMicRecovery(stream);

      // 4. Connect WebSocket — audio is already flowing from the pipeline above,
      //    so Deepgram receives data immediately (no idle timeout).
      const result = await withSessionRefresh(async () => {
        const streamingSettings = getSettings();
        const { useLocalWhisper } = streamingSettings;
        const res = await provider.start(
          buildStreamingSessionOptions({
            providerName: this.getStreamingProviderName(),
            settings: streamingSettings,
            language: this.getEffectiveSttLanguage(streamingSettings),
            keyterms: this.getKeyterms(),
            voiceAgentRequested: this.voiceAgentRequested,
          })
        );

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
      this._settleStreamingStart();
      if (startWasCancelled()) return false;

      if (result.needsFallback) {
        this.isRecording = false;
        this.recordingStartTime = null;
        this.stopRequestedDuringStreamingStart = false;
        await this.cleanupStreaming();
        if (ownsSession()) this._activeStreamingSessionId = null;
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
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
          usedPreparedCapture,
          micWarm: isMicWarm(this._micWarmedAt, Date.now()),
        },
        "streaming"
      );

      if (this.stopRequestedDuringStreamingStart) {
        this.stopRequestedDuringStreamingStart = false;
        logger.debug("Applying deferred streaming stop requested during startup", {}, "streaming");
        return this.stopStreamingRecording();
      }
      return true;
    } catch (error) {
      const stopRequested = this.stopRequestedDuringStreamingStart;
      this._settleStreamingStart();
      this.stopRequestedDuringStreamingStart = false;

      // A stream the pipeline never took ownership of would leak the device
      // (and, when prepared, keep the mic indicator lit) — release it here.
      if (acquiredStream && this.streamingStream !== acquiredStream) {
        acquiredStream.getTracks().forEach((track) => track.stop());
        this._markCaptureStreamReleased();
      }

      if (startWasCancelled()) return false;

      if (isStaleDeviceError(error) && !forceDefaultMic && !stopRequested) {
        // Pinned mic is gone (Chromium rotates IDs / device unplugged). Retry once on the default mic. See #900.
        logger.warn(
          "Pinned microphone unavailable, retrying streaming on default mic",
          {},
          "streaming"
        );
        this.cachedMicDeviceId = null;
        await this.cleanupStreaming();
        if (this._activeStreamingSessionId === sessionId) {
          this._activeStreamingSessionId = null;
        }
        this.isRecording = false;
        this.recordingStartTime = null;
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
        return this.startStreamingRecording(true);
      }

      logger.error(
        "Failed to start streaming recording",
        { provider: this.getStreamingProviderName(), error: error.message, code: error.code },
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
      if (this._activeStreamingSessionId === sessionId) {
        this._activeStreamingSessionId = null;
      }
      this.isRecording = false;
      this.recordingStartTime = null;
      this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
      return false;
    } finally {
      this._startInProgress = false;
    }
  }

  // Resolves once the transcript stops moving. An outstanding partial proves its
  // final is still in flight, so only the ceiling ends the wait until it lands —
  // a plain debounce would expire on the very tail this exists to catch.
  awaitStreamingTextSettled() {
    return new Promise((resolve) => {
      const settle = () => {
        clearTimeout(this.streamingTextDebounce);
        clearTimeout(ceiling);
        this.streamingTextBump = null;
        this.streamingTextDebounce = null;
        resolve();
      };
      const ceiling = setTimeout(settle, STREAMING_FINAL_CEILING_MS);
      const arm = () => {
        clearTimeout(this.streamingTextDebounce);
        if (this.streamingPartialText) return;
        this.streamingTextDebounce = setTimeout(settle, STREAMING_FINAL_QUIET_MS);
      };
      this.streamingTextBump = arm;
      arm();
    });
  }

  async stopStreamingRecording() {
    if (this.streamingStartInProgress) {
      this.stopRequestedDuringStreamingStart = true;
      logger.debug("Streaming stop requested while start is in progress", {}, "streaming");
      return true;
    }

    if (this._streamingStopPromise) {
      return this._streamingStopPromise;
    }
    if (!this.isStreaming) return false;

    const sessionId = this._activeStreamingSessionId;
    const stopPromise = this._finalizeStreamingRecording(sessionId);
    this._streamingStopPromise = stopPromise;
    this._streamingStopMode = "finalize";
    try {
      return await stopPromise;
    } finally {
      if (this._streamingStopPromise === stopPromise) {
        this._streamingStopPromise = null;
        this._streamingStopMode = null;
      }
      if (this._activeStreamingSessionId === sessionId) {
        this._activeStreamingSessionId = null;
      }

      // Finalization has several provider/reasoning awaits. A thrown error must
      // never leave the renderer or main process stuck in a busy lifecycle.
      const needsIdleNotification = this.isRecording || this.isProcessing || this.isStreaming;
      this.isRecording = false;
      this.isProcessing = false;
      this.isStreaming = false;
      if (needsIdleNotification) {
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
      }
    }
  }

  _requestStreamingCancellation() {
    this._streamingCancellationGeneration += 1;
    ReasoningService.cancelAllRequests();
    window.electronAPI?.cancelCloudTranscription?.();
    this._activeTranscriptionAbortController?.abort();
    this._activeTranscriptionAbortController = null;
    this.pendingSelectionEdit = null;
    this.pendingAssistantConversation = null;
    this.pendingCleanupFailure = null;
    this.assistantSelectionContext = null;
    this.screenContextPromise = null;
    this.selectionCapturePromise = null;
  }

  async cancelStreamingRecording() {
    if (this._streamingStopPromise) {
      if (this._streamingStopMode === "finalize") {
        this._requestStreamingCancellation();
      }
      return this._streamingStopPromise;
    }
    if (!this.isStreaming && !this.streamingStartInProgress) {
      return false;
    }

    const sessionId = this._activeStreamingSessionId;
    const cancelPromise = (async () => {
      this._requestStreamingCancellation();
      this.stopRequestedDuringStreamingStart = false;
      this.recordingStartTime = null;
      this.isRecording = false;
      this._activeProcessingPipeline = null;
      this.isProcessing = true;
      this.micRecovery.stop();
      this.cleanupStreamingAudio();
      this.cleanupStreamingListeners(sessionId);
      this._streamingFallbackSegments = [];
      this.onStateChange?.({ isRecording: false, isProcessing: true, isStreaming: false });

      const providerStop = this._waitForStreamingStartSettlement()
        .then(() => {
          // Startup may have attached replacement capture resources after the
          // first synchronous cleanup. Reclaim them once startup can no longer
          // mutate the session, then disconnect its provider.
          this.micRecovery.stop();
          this.cleanupStreamingAudio();
          this.cleanupStreamingListeners(sessionId);
          return this.getStreamingProvider().stop?.();
        })
        .catch((error) => {
          logger.debug(
            "Streaming disconnect after cancellation failed",
            { error: error.message },
            "streaming"
          );
        });
      await Promise.all([providerStop, this.cleanupPreview({ dismiss: true })]);
      return true;
    })();

    this._streamingStopPromise = cancelPromise;
    this._streamingStopMode = "cancel";
    try {
      return await cancelPromise;
    } finally {
      if (this._streamingStopPromise === cancelPromise) {
        this._streamingStopPromise = null;
        this._streamingStopMode = null;
      }
      if (this._activeStreamingSessionId === sessionId) {
        this._activeStreamingSessionId = null;
      }
      this.isRecording = false;
      this.isProcessing = false;
      this.isStreaming = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
    }
  }

  async _finalizeStreamingRecording(sessionId) {
    if (
      sessionId !== null &&
      sessionId !== undefined &&
      this._activeStreamingSessionId !== sessionId
    ) {
      return false;
    }

    const cancellationGeneration = this._streamingCancellationGeneration;
    const wasCancelled = () => cancellationGeneration !== this._streamingCancellationGeneration;
    const abandonFinalization = async () => {
      this.cleanupStreamingAudio();
      this.cleanupStreamingListeners(sessionId);
      this._streamingFallbackSegments = [];
      try {
        await this.getStreamingProvider().stop?.();
      } catch (error) {
        logger.debug(
          "Streaming disconnect after cancellation failed",
          { error: error.message },
          "streaming"
        );
      }
      return true;
    };

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;

    // Enter processing synchronously, before any mic/provider await. This is
    // the authoritative guard that makes a second hotkey a no-op for the full
    // finalization and reasoning interval.
    // Supersede cancelled batch work that may still be settling in the background.
    this._activeProcessingPipeline = null;
    this.isRecording = false;
    this.isProcessing = true;
    this.recordingStartTime = null;
    this.onStateChange?.({ isRecording: false, isProcessing: true, isStreaming: false });

    this.micRecovery.stop();
    // Let an in-flight mic swap settle so its fallback segment isn't lost and
    // its replacement recorder doesn't outlive this stop.
    if (this._streamingMicSwapPromise) await this._streamingMicSwapPromise;
    if (wasCancelled()) return abandonFinalization();

    const t0 = performance.now();
    let finalText = this.streamingFinalText || "";

    // 1. Stop the processor — it flushes its remaining buffer on "stop".
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
    this.streamingAnalyser = null;
    this.streamingAudioContext = null;

    // Stop fallback recorder before stopping media tracks
    let fallbackBlob = null;
    await this.finishStreamingFallbackSegment();
    if (wasCancelled()) return abandonFinalization();
    try {
      fallbackBlob = await this.mergeRecordedSegments(this._streamingFallbackSegments);
    } catch (error) {
      logger.warn(
        "Failed to merge streaming fallback audio",
        { error: error.message },
        "streaming"
      );
      fallbackBlob = this.getLargestRecordedSegment(this._streamingFallbackSegments);
    }
    if (wasCancelled()) return abandonFinalization();
    if (fallbackBlob) {
      this.lastAudioBlob = fallbackBlob;
    }
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    this._streamingFallbackSegments = [];

    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
      this._markCaptureStreamReleased();
    }
    const tAudioCleanup = performance.now();

    // 2. Wait for flushed buffer to travel: port -> main thread -> IPC -> WebSocket -> server.
    //    Then mark streaming done so no further audio is forwarded.
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (wasCancelled()) return abandonFinalization();
    this.isStreaming = false;
    const tFlush = performance.now();

    // 3. Finalize tells the provider to process any buffered audio and send final results.
    //    Wait for the transcript to settle before disconnecting.
    const provider = this.getStreamingProvider();
    provider.finalize?.();
    if (provider.awaitsFinalTranscript) {
      await this.awaitStreamingTextSettled();
    } else {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (wasCancelled()) return abandonFinalization();
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

    this.cleanupStreamingListeners(sessionId);
    if (wasCancelled()) return true;

    logger.info(
      "Streaming stop timing",
      {
        durationSeconds,
        audioCleanupMs: Math.round(tAudioCleanup - t0),
        flushWaitMs: Math.round(tForceEndpoint - tAudioCleanup),
        finalSettleMs: Math.round(tForceEndpoint - tFlush),
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
    // Reasoning below reassigns `finalText` to the cleaned-up/agent output, so
    // snapshot the pre-reasoning transcript now to report as `rawText` — matching
    // the batch path, which already keeps raw and processed text separate.
    const rawStreamingText = finalText;

    let usedCloudReasoning = false;
    if (finalText) {
      const reasoningStart = performance.now();
      const agentName = localStorage.getItem("agentName") || null;
      const screenContext = this.voiceAgentRequested ? await this.consumeScreenContext() : null;
      if (wasCancelled()) return true;
      const route = resolveReasoningRoute(
        finalText,
        stSettings,
        agentName,
        this.voiceAgentRequested,
        this.translationRequested,
        screenContext
      );
      if (this.translationRequested && route.kind !== "translation") {
        this.notifyTranslationFallback("unreachable");
      }
      const cleanupCloudMode = stSettings.cleanupCloudMode || "openwhispr";

      try {
        if (route.kind === "agent") {
          const reasoned = await this.processAgentCommand(
            finalText,
            route.model,
            agentName,
            {
              ...route.config,
              requiresAgent: true,
            },
            wasCancelled
          );
          if (hasTextContent(reasoned)) finalText = reasoned;
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
              language: this.getCleanupLanguage(stSettings),
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

          if (reasonResult.success && hasTextContent(reasonResult.text)) {
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
            if (hasTextContent(reasoned)) finalText = reasoned;
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
          finalText = resolveTranslatedText(finalText, chainResult);
          usedCloudReasoning = chainResult.usedCloudReasoning || usedCloudReasoning;
        }
      } catch (reasonError) {
        if (wasCancelled()) return true;
        if (reasonError.selectionEditFatal) {
          this.pendingSelectionEdit = null;
          this.onError?.({
            title: "Selection Edit Failed",
            description: reasonError.message,
            code: reasonError.code,
            messageKey: reasonError.messageKey,
          });
          this.isProcessing = false;
          this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
          return false;
        }
        logger.error(
          "Streaming reasoning failed, using raw text",
          { error: reasonError.message },
          "streaming"
        );
        if (route.kind === "cleanup") {
          this.pendingCleanupFailure = cleanupFailureFromError(reasonError);
        }
        if (route.kind === "agent") this._notifyAgentReasoningFailed();
      }
      if (wasCancelled()) return true;
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
              ? await this.processWithOpenWhisprCloud(
                  fallbackBlob,
                  { durationSeconds },
                  wasCancelled
                )
              : await this.processWithOpenAIAPI(fallbackBlob, { durationSeconds }, wasCancelled);
          if (wasCancelled()) return true;
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
      // The batch fallback routes through processTranscription, which already
      // applied the script; only streamed text still needs it.
      if (!usedBatchFallback) {
        finalText = await this.finalizeChineseScript(finalText, stSettings);
        if (wasCancelled()) return true;
      }
      const tBeforePaste = performance.now();
      const clientTotalMs = Math.round(tBeforePaste - t0);
      this.lastAudioMetadata = {
        durationMs: durationSeconds
          ? Math.round(durationSeconds * 1000)
          : Math.round(tBeforePaste - t0),
        provider: `${this.getStreamingProviderName()}-streaming`,
        model: streamingSttModel || null,
      };
      if (wasCancelled()) return true;
      this.onTranscriptionComplete?.({
        success: true,
        text: finalText,
        rawText: rawStreamingText || finalText,
        source: `${this.getStreamingProviderName()}-streaming`,
        ...this._takePendingResultExtras(),
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
    }

    this.isProcessing = false;
    this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });

    if (wasCancelled()) return true;

    if (!finalText) {
      // Match the batch pipeline: settle processing first, then publish the
      // empty outcome so the warning cannot interrupt the thinking transition.
      this.onTranscriptionComplete?.({ success: true, text: "" });
    }

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
      !!settings.useCleanupModel ||
      !!settings.useDictationAgent ||
      (this.translationRequested && !!settings.useDictationTranslation)
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

    let flushed = true;
    if (processor) {
      // The worklet posts all PCM before "flushed", and the PCM sends share the
      // renderer->main pipe with the stop invoke (FIFO), so the final chunk precedes finish.
      let resolveFlush;
      const flushSentinel = new Promise((resolve) => {
        resolveFlush = () => resolve(true);
      });
      let watchdogTimer;
      const watchdogFired = new Promise((resolve) => {
        watchdogTimer = setTimeout(() => resolve(false), PREVIEW_FLUSH_WATCHDOG_MS);
      });
      this._previewFlushResolve = resolveFlush;
      processor.port.postMessage("stop");
      flushed = await Promise.race([flushSentinel, watchdogFired]);
      clearTimeout(watchdogTimer);
      if (this._previewFlushResolve === resolveFlush) this._previewFlushResolve = null;
      processor.disconnect();
    }
    source?.disconnect();
    audioContext?.close().catch(() => {});
    if (dismiss) {
      window.electronAPI?.dismissDictationPreview?.();
      return null;
    }
    return (await window.electronAPI?.stopDictationPreview?.({ showCleanup, flushed })) || null;
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

    this.streamingAnalyser = null;
    this.streamingAudioContext = null;

    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
      this._markCaptureStreamReleased();
    }

    this.isStreaming = false;
  }

  cleanupStreamingListeners(sessionId = null) {
    if (
      sessionId !== null &&
      sessionId !== undefined &&
      this._activeStreamingSessionId !== sessionId
    ) {
      return;
    }
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
    this.streamingTextBump = null;
    clearTimeout(this.streamingTextDebounce);
    this.streamingTextDebounce = null;
  }

  async cleanupStreaming() {
    const sessionId = this._activeStreamingSessionId;
    this.micRecovery.stop();
    this.cleanupStreamingAudio();
    this.cleanupStreamingListeners(sessionId);
    if (this._activeStreamingSessionId === sessionId) {
      this._activeStreamingSessionId = null;
    }
  }

  cleanup() {
    this.micRecovery.stop();
    this._unsubscribeSettings?.();
    this.preparedMicCapture.cancel();
    this.micStreamHold.drop();
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
