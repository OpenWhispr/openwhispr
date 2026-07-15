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
import { getBaseLanguageCode, getMultiLanguagePromptHint } from "../utils/languageSupport";
import {
  createLocalSpeechGateState,
  getLocalSpeechGateDecision,
  recordLocalSpeechWindow,
} from "./localSpeechGate";
import { reacquireIfDead } from "./micTrackHealth";
import { isStaleDeviceError } from "./staleMicDevice";
import { shouldSaveDiscardedRecording } from "./discardedRecording";
import {
  getSettings,
  getEffectiveCleanupModel,
  isCloudCleanupMode,
  isCloudDictationAgentMode,
} from "../stores/settingsStore";
import { getBatchTranscriptionModel, getTranscriptionProvider } from "../models/ModelRegistry";
import { shouldSkipTranscriptionApiKey } from "./transcriptionAuth";
import {
  isSelfHostedTranscription,
  resolveSelfHostedTranscriptionModel,
} from "./selfHostedTranscription";
import { resolveStreamingFallbackTarget } from "./transcriptionFallback";
import { detectAgentName } from "../config/agentDetection";
import { resolveDictationRouteKind, resolveDictationAgentReachability } from "./dictationRouting";
import { resolvePrompt } from "../config/prompts";
import { syncService } from "../services/SyncService.js";
import { evaluateFinishedRecording } from "./recordingValidation";
import { matchesDictionaryPrompt } from "../utils/dictionaryEchoFilter.js";
import { getDictionaryHintWords } from "../utils/snippets";

const REASONING_CACHE_TTL = 30000; // 30 seconds
const RECORDING_TIMESLICE_MS = 250; // flush chunks periodically so short recordings still carry audio frames. See #871.
const PCM_COLLECTOR_SAMPLE_RATE = 16000;

/**
 * Assembles an array of Int16Array chunks captured at 16 kHz mono into a
 * WAV ArrayBuffer that whisper.cpp / sherpa-onnx accept directly — no FFmpeg
 * decode step needed on the main process side.
 */
function buildWavFromPcmChunks(chunks) {
  const totalSamples = chunks.reduce((sum, c) => sum + c.length, 0);
  const dataBytes = totalSamples * 2;
  const wav = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(wav);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);                          // fmt chunk size
  v.setUint16(20, 1, true);                           // PCM
  v.setUint16(22, 1, true);                           // mono
  v.setUint32(24, PCM_COLLECTOR_SAMPLE_RATE, true);   // 16000 Hz
  v.setUint32(28, PCM_COLLECTOR_SAMPLE_RATE * 2, true); // byteRate
  v.setUint16(32, 2, true);                           // blockAlign
  v.setUint16(34, 16, true);                          // bitsPerSample
  w(36, "data");
  v.setUint32(40, dataBytes, true);
  let off = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) { v.setInt16(off, chunk[i], true); off += 2; }
  }
  return wav;
}
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

function resolveReasoningRoute(text, settings, agentName, voiceAgentRequested) {
  const cleanupReachable =
    !!settings.useCleanupModel && (!!settings.cleanupModel?.trim() || isCloudCleanupMode());
  const isCloudAgent = isCloudDictationAgentMode();
  const isSelfHostedAgent =
    settings.dictationAgentMode === "self-hosted" && !!settings.dictationAgentRemoteUrl?.trim();

  let agentModel = settings.dictationAgentModel?.trim() || "";
  let agentProvider = settings.dictationAgentProvider?.trim() || undefined;

  // When voice agent fires but no dedicated agent model is configured, fall back through the
  // available model pool: cleanup model → chat agent model.
  if (voiceAgentRequested && !agentModel && settings.useDictationAgent) {
    if (cleanupReachable) {
      agentModel = settings.cleanupModel?.trim() || "";
      agentProvider = settings.cleanupProvider?.trim() || agentProvider;
    } else if (settings.chatAgentModel?.trim()) {
      agentModel = settings.chatAgentModel.trim();
      agentProvider = settings.chatAgentProvider?.trim() || agentProvider;
    }
  }

  const agentReachable = resolveDictationAgentReachability({
    useDictationAgent: settings.useDictationAgent,
    dictationAgentModel: agentModel,
    isCloudAgent,
    isSelfHostedAgent,
  });

  const kind = resolveDictationRouteKind({
    cleanupReachable,
    agentReachable,
    agentInvoked: !!agentName && detectAgentName(text, agentName),
    voiceAgentRequested,
  });
  if (kind === "agent") {
    const isCustomAgent = settings.dictationAgentMode === "providers" && agentProvider === "custom";
    return {
      kind: "agent",
      model: agentModel,
      config: {
        provider: agentProvider,
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
  "openai-realtime": {
    warmup: (opts) => window.electronAPI.dictationRealtimeWarmup({ ...opts, mode: "byok" }),
    start: (opts) => window.electronAPI.dictationRealtimeStart({ ...opts, mode: "byok" }),
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
      this.micDriverWarmedUp = false;
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
    this.persistentAudioContext = null;
    this.workletModuleLoaded = false;
    this.workletBlobUrl = null;
    this._gateCtx = null;
    this._gateWorkletLoaded = false;
    this._gateSource = null;
    this._gainNode = null;
    this._pcmCollector = null;
    this._pcmChunks = [];
    this._pcmFlushPromise = null;
    this._pcmCollectorBlobUrl = null;
    this._pcmCollectorLoaded = false;
    this.streamingStartInProgress = false;
    this.stopRequestedDuringStreamingStart = false;
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    this.skipReasoning = false;
    this.voiceAgentRequested = false;
    this.context = "dictation";
    this.sttConfig = null;
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    this._localSpeechGateState = null;
  }

  getWorkletBlobUrl() {
    if (this.workletBlobUrl) return this.workletBlobUrl;
    const code = `
const BUFFER_SIZE = 1600;
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

  getPcmCollectorBlobUrl() {
    if (this._pcmCollectorBlobUrl) return this._pcmCollectorBlobUrl;
    // Separate worklet registration name so it can coexist with the streaming processor.
    // Sends a null "done" marker after flushing the partial buffer on "stop",
    // allowing stopRecording() to know exactly when all samples have arrived.
    const code = `
const BUFFER_SIZE = 1600;
class PCMCollectorProcessor extends AudioWorkletProcessor {
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
        }
        this.port.postMessage(null); // "done" sentinel
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
registerProcessor("pcm-collector-processor", PCMCollectorProcessor);
`;
    this._pcmCollectorBlobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    return this._pcmCollectorBlobUrl;
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

  setVoiceAgentRequested(requested) {
    this.voiceAgentRequested = requested;
  }

  setContext(context) {
    this.context = context;
  }

  setSttConfig(config) {
    this.sttConfig = config;
  }

  getStreamingProvider() {
    return STREAMING_PROVIDERS[this.getStreamingProviderName()] || STREAMING_PROVIDERS["openai-realtime"];
  }

  getStreamingProviderName() {
    return "openai-realtime";
  }

  async getAudioConstraints(forceDefaultMic = false) {
    const { preferBuiltInMic: preferBuiltIn, selectedMicDeviceId: selectedDeviceId } =
      getSettings();

    // AGC always off: Chromium's AGC on Windows mutates the system mic volume via WASAPI (#476).
    // Echo cancellation off to avoid latency and distortion.
    // Noise suppression is user-configurable (WebRTC pipeline, similar to communication mode).
    // Stereo recording required — mono WebM breaks silence detection on Linux/PipeWire (#472).
    const { micNoiseSuppression } = getSettings();
    const noProcessing = {
      echoCancellation: false,
      noiseSuppression: micNoiseSuppression || false,
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

  async startRecording(forceDefaultMic = false) {
    try {
      if (this.isRecording || this.isProcessing || this.mediaRecorder?.state === "recording") {
        return false;
      }

      const constraints = await this.getAudioConstraints(forceDefaultMic);
      const micStream = await reacquireIfDead(
        await navigator.mediaDevices.getUserMedia(constraints),
        () => {
          this.cachedMicDeviceId = null;
          return this.getAudioConstraints();
        },
        logger
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
        const gateCtx = await this._getOrCreateGateContext();
        this._gateSource = gateCtx.createMediaStreamSource(micStream);

        // Insert gain node so downstream nodes receive boosted signal.
        // Value 1.0 = no change; user-configurable from 0.5x to 3.0x.
        const micGain = getSettings().micGain ?? 1.0;
        this._gainNode = gateCtx.createGain();
        this._gainNode.gain.value = micGain;
        this._gateSource.connect(this._gainNode);

        this._silenceAnalyser = gateCtx.createAnalyser();
        this._silenceAnalyser.fftSize = 2048;
        this._gainNode.connect(this._silenceAnalyser);
        this._localSpeechGateState = createLocalSpeechGateState();
        const dataArray = new Uint8Array(this._silenceAnalyser.fftSize);
        this._silenceInterval = setInterval(() => {
          // A stalled context reads flat silence; recording no windows fails the gate open.
          if (this._gateCtx?.state !== "running") return;
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
        }, 200);
      } catch (e) {
        logger.warn("Audio level gate setup failed, skipping", { error: e.message }, "audio");
        this._localSpeechGateState = null;
      }

      this.mediaRecorder = new MediaRecorder(micStream, { audioBitsPerSecond: 128000 });
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
        // Wait for PCM collector to flush its partial buffer before assembling the WAV.
        if (this._pcmFlushPromise) {
          await this._pcmFlushPromise;
          this._pcmFlushPromise = null;
        }

        this.teardownSpeechGate();
        this.cleanupPreview({ showCleanup: this.shouldShowPreviewCleanupState() });

        this.isRecording = false;
        this.isProcessing = true;
        this.onStateChange?.({ isRecording: false, isProcessing: true });

        // Build a 16 kHz mono WAV from the PCM chunks collected by the AudioWorklet.
        // This bypasses the FFmpeg decode step in the main process entirely.
        const pcmChunks = this._pcmChunks;
        this._pcmChunks = [];
        const hasPcm = pcmChunks.length > 0 && pcmChunks.some((c) => c.length > 0);

        let audioBlob;
        if (hasPcm) {
          const wavBuffer = buildWavFromPcmChunks(pcmChunks);
          audioBlob = new Blob([wavBuffer], { type: "audio/wav" });
        } else {
          // Fallback: PCM collector unavailable — use WebM from MediaRecorder.
          audioBlob = new Blob(this.audioChunks, { type: this.recordingMimeType });
        }
        this.lastAudioBlob = audioBlob;

        logger.info(
          "Recording stopped",
          {
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            source: hasPcm ? "pcm-direct" : "webm-fallback",
            pcmChunkCount: pcmChunks.length,
          },
          "audio"
        );

        const durationSeconds = this.recordingStartTime
          ? (Date.now() - this.recordingStartTime) / 1000
          : null;
        this.recordingStartTime = null;

        const receivedData = hasPcm ? hasPcm : this._receivedAudioData;
        const recordingCheck = evaluateFinishedRecording({
          blobSize: audioBlob.size,
          receivedAudioData: receivedData,
        });
        if (!recordingCheck.usable) {
          logger.info(
            "Dropping degenerate recording before transcription",
            {
              blobSize: audioBlob.size,
              reason: recordingCheck.reason,
              receivedAudioData: receivedData,
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

        await this.processAudio(audioBlob, { durationSeconds });

        micStream.getTracks().forEach((track) => track.stop());
      };

      const {
        showTranscriptionPreview,
        useLocalWhisper,
        localTranscriptionProvider,
        whisperModel,
        parakeetModel,
      } = getSettings();

      // Pre-load worklet modules BEFORE starting capture so no audio is missed.
      if (this._gateCtx && this._gateSource) {
        if (showTranscriptionPreview && useLocalWhisper && !this._gateWorkletLoaded) {
          try {
            await this._gateCtx.audioWorklet.addModule(this.getWorkletBlobUrl());
            this._gateWorkletLoaded = true;
          } catch (e) {
            logger.warn("Preview worklet load failed", { error: e.message }, "audio");
          }
        }
        if (!this._pcmCollectorLoaded) {
          try {
            await this._gateCtx.audioWorklet.addModule(this.getPcmCollectorBlobUrl());
            this._pcmCollectorLoaded = true;
          } catch (e) {
            logger.warn("PCM collector load failed", { error: e.message }, "audio");
          }
        }
      }

      // Connect PCM collector BEFORE starting MediaRecorder so the first frame
      // of audio is captured in PCM and nothing is lost to the async setup gap.
      if (this._gateCtx && this._gainNode && this._pcmCollectorLoaded) {
        try {
          this._pcmChunks = [];
          this._pcmCollector = new AudioWorkletNode(this._gateCtx, "pcm-collector-processor");
          this._pcmCollector.port.onmessage = (event) => {
            if (event.data !== null) {
              this._pcmChunks.push(new Int16Array(event.data));
            }
          };
          this._gainNode.connect(this._pcmCollector);
        } catch (e) {
          logger.warn("PCM collector setup failed, will fall back to WebM", { error: e.message }, "audio");
          this._pcmCollector = null;
        }
      }

      // Audio pipeline is ready — start capture now.
      this.mediaRecorder.start(RECORDING_TIMESLICE_MS);
      this.isRecording = true;
      this.onStateChange?.({ isRecording: true, isProcessing: false });

      // Connect preview worklet after start (non-critical; small delay acceptable).
      if (showTranscriptionPreview && useLocalWhisper && this._gateCtx && this._gainNode && this._gateWorkletLoaded) {
        try {
          this._previewProcessor = new AudioWorkletNode(this._gateCtx, "pcm-streaming-processor");
          this._previewProcessor.port.onmessage = (event) => {
            window.electronAPI?.sendDictationPreviewAudio?.(event.data);
          };
          this._gainNode.connect(this._previewProcessor);

          const provider = localTranscriptionProvider === "nvidia" ? "nvidia" : "whisper";
          const model = provider === "nvidia" ? parakeetModel : whisperModel;
          const language = getBaseLanguageCode(getSettings().preferredLanguage);
          window.electronAPI?.startDictationPreview?.({ provider, model, language });
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
      // Flush the PCM collector's partial buffer before stopping MediaRecorder.
      // The "done" (null) sentinel resolves the promise; onstop awaits it.
      if (this._pcmCollector) {
        this._pcmFlushPromise = new Promise((resolve) => {
          const orig = this._pcmCollector.port.onmessage;
          this._pcmCollector.port.onmessage = (event) => {
            if (event.data === null) {
              // "done" sentinel — restore normal handler and resolve.
              this._pcmCollector.port.onmessage = null;
              resolve();
            } else {
              // partial chunk arriving just before "stop" was acknowledged.
              this._pcmChunks.push(new Int16Array(event.data));
            }
          };
          this._pcmCollector.port.postMessage("stop");
        });
      }
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
    if (this._silenceAnalyser) {
      try { this._silenceAnalyser.disconnect(); } catch {}
      this._silenceAnalyser = null;
    }
    if (this._pcmCollector) {
      try { this._pcmCollector.disconnect(); } catch {}
      this._pcmCollector = null;
    }
    if (this._gainNode) {
      try { this._gainNode.disconnect(); } catch {}
      this._gainNode = null;
    }
    // If no preview worklet is active, cleanupPreview won't be called — disconnect source here.
    if (this._gateSource && !this._previewProcessor) {
      try { this._gateSource.disconnect(); } catch {}
      this._gateSource = null;
      this._gateCtx?.suspend().catch(() => {});
    }
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

      logger.debug(
        "Transcription routing",
        { useLocalWhisper, cloudTranscriptionMode },
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
      const preferredLanguage = getSettings().preferredLanguage;
      const language = getBaseLanguageCode(preferredLanguage);
      const options = { model };
      if (language) {
        options.language = language;
      }

      // Build initial prompt from custom dictionary + multi-language hint
      const dictionaryPrompt = this.getCustomDictionaryPrompt();
      const langHint = getMultiLanguagePromptHint(preferredLanguage);
      const combinedPrompt = [langHint, dictionaryPrompt].filter(Boolean).join(" ");
      if (combinedPrompt) {
        options.initialPrompt = combinedPrompt;
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
      const result = await window.electronAPI.transcribeLocalParakeet(arrayBuffer, { model });
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
    // Voice agent requests bypass the model-configured check — a user pressing the
    // voice agent hotkey intends to run an LLM even if no model is yet pinned.
    const voiceAgentBypass = this.voiceAgentRequested && !!s.useDictationAgent;
    const useReasoning = !!s.useCleanupModel || dictationAgentReachable(s) || voiceAgentBypass;
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
    const cleanupReachable = !!settings.useCleanupModel && (!!cleanupModel || isCloud);
    const agentReachable = dictationAgentReachable(settings);
    const agentName =
      typeof window !== "undefined" && window.localStorage
        ? localStorage.getItem("agentName") || null
        : null;
    const voiceAgentBypass = this.voiceAgentRequested && !!settings.useDictationAgent;
    if (!cleanupReachable && !agentReachable && !voiceAgentBypass) {
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
        const route = resolveReasoningRoute(
          normalizedText,
          getSettings(),
          agentName,
          this.voiceAgentRequested
        );
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

  async processWithEktosWhisprCloud(audioBlob, metadata = {}) {
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
    const dictionaryPrompt = this.getCustomDictionaryPrompt();
    const langHint = getMultiLanguagePromptHint(settings.preferredLanguage);
    const combinedPrompt = [langHint, dictionaryPrompt].filter(Boolean).join(" ");
    if (combinedPrompt) opts.prompt = combinedPrompt;

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
        this.voiceAgentRequested
      );
      try {
        if (route.kind === "agent") {
          const reasoned = await this.processWithReasoningModel(
            processedText,
            route.model,
            agentName,
            route.config
          );
          if (reasoned) processedText = reasoned;
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
        }
      } catch (reasonError) {
        logger.error(
          "Cloud reasoning failed, using raw transcription",
          { error: reasonError.message },
          "transcription"
        );
      }
      timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);
    }

    return {
      success: true,
      text: processedText,
      rawText,
      source: "cloud",
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
      const langHintForApi = getMultiLanguagePromptHint(apiSettings.preferredLanguage);
      let dictionaryPrompt = this.getCustomDictionaryPrompt();
      let combinedApiPrompt = [langHintForApi, dictionaryPrompt].filter(Boolean).join(" ");
      if (combinedApiPrompt) {
        if (combinedApiPrompt.length > MAX_PROMPT_CHARS) {
          const originalLength = combinedApiPrompt.length;
          const truncated = combinedApiPrompt.slice(0, MAX_PROMPT_CHARS);
          const lastComma = truncated.lastIndexOf(",");
          combinedApiPrompt = lastComma > 0 ? truncated.slice(0, lastComma) : truncated;
          logger.debug(
            "Transcription prompt truncated",
            {
              originalLength,
              truncatedLength: combinedApiPrompt.length,
              maxChars: MAX_PROMPT_CHARS,
            },
            "transcription"
          );
        }
        formData.append("prompt", combinedApiPrompt);
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
          // The user's own provider rate-limited the request — not an EktosWhispr plan limit
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

  async saveDiscardedTranscription(blob, durationSeconds) {
    let savedId = null;
    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        status: "discarded",
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

  shouldUseStreaming() {
    const s = getSettings();
    if (s.useLocalWhisper) return false;

    // Self-hosted transcription is batch HTTP to the user's server, never cloud realtime WS.
    if (isSelfHostedTranscription(s)) return false;

    // For dictation/agent: respect sttConfig mode from the API — this allows
    // batch mode even for realtime-capable models (e.g. gpt-4o-mini-transcribe).
    if (this.context !== "notes" && this.sttConfig?.dictation?.mode === "batch") {
      return false;
    }

    if (REALTIME_MODELS.has(s.cloudTranscriptionModel)) {
      // Realtime WS is OpenAI-only — other providers fall through to HTTP.
      if ((s.cloudTranscriptionProvider || "openai") !== "openai") return false;
      if (s.cloudTranscriptionMode === "byok") return !!s.openaiApiKey;
      return false;
    }

    return false;
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
        withSessionRefresh(async () => {
          const {
            preferredLanguage: warmupLang,
            cloudTranscriptionModel,
          } = getSettings();
          const warmupBaseLang = getBaseLanguageCode(warmupLang);
          const res = await provider.warmup({
            sampleRate: 16000,
            language: warmupBaseLang || undefined,
            keyterms: this.getKeyterms(),
            model: cloudTranscriptionModel,
            mode: "byok",
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

  async _getOrCreateGateContext() {
    if (this._gateCtx && this._gateCtx.state !== "closed") {
      if (this._gateCtx.state === "suspended") {
        await this._gateCtx.resume();
      }
      return this._gateCtx;
    }
    this._gateCtx = new AudioContext({ sampleRate: 16000 });
    this._gateWorkletLoaded = false;
    return this._gateCtx;
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

      const stream = await reacquireIfDead(
        rawStream,
        () => {
          this.cachedMicDeviceId = null;
          return this.getAudioConstraints();
        },
        logger
      );
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
        const {
          preferredLanguage: preferredLang,
          cloudTranscriptionModel,
          cloudTranscriptionMode,
          cortiEnvironment,
          cortiTenant,
          useLocalWhisper,
        } = getSettings();
        const res = await provider.start({
          sampleRate: 16000,
          language: getBaseLanguageCode(preferredLang),
          keyterms: this.getKeyterms(),
          model: cloudTranscriptionModel,
          mode: "byok",
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
          "Your EktosWhispr Cloud session is unavailable. Please sign in again from Settings.";
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

    if (finalText && !this.skipReasoning) {
      const reasoningStart = performance.now();
      const agentName = localStorage.getItem("agentName") || null;
      const route = resolveReasoningRoute(
        finalText,
        stSettings,
        agentName,
        this.voiceAgentRequested
      );
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

    // If streaming produced no text, fall back to batch — routed so BYOK audio
    // and cloud audio never cross over (see resolveStreamingFallbackTarget).
    let usedBatchFallback = false;
    let batchWarning = null;
    if (!finalText && durationSeconds > 2 && fallbackBlob?.size > 0) {
      const target = resolveStreamingFallbackTarget(getSettings());
      if (target === "skip") {
        logger.warn(
          "Skipping batch fallback: EktosWhispr Cloud session signed out",
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
          const batchResult = await this.processWithOpenAIAPI(fallbackBlob, { durationSeconds });
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

      window.dispatchEvent(new Event("usage-changed"));

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
    return (!!settings.useCleanupModel || !!settings.useDictationAgent) && !this.skipReasoning;
  }

  cleanupPreview(options = {}) {
    const { dismiss = false, showCleanup = false } = options;

    if (this._previewProcessor) {
      this._previewProcessor.port.postMessage("stop");
      this._previewProcessor.disconnect();
      this._previewProcessor = null;
    }
    // Disconnect the shared gate source and suspend the persistent context.
    if (this._gainNode) {
      try { this._gainNode.disconnect(); } catch {}
      this._gainNode = null;
    }
    if (this._gateSource) {
      try { this._gateSource.disconnect(); } catch {}
      this._gateSource = null;
    }
    this._gateCtx?.suspend().catch(() => {});

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
    if (this._gateCtx && this._gateCtx.state !== "closed") {
      this._gateCtx.close().catch(() => {});
      this._gateCtx = null;
      this._gateWorkletLoaded = false;
    }
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    if (this._pcmCollector) {
      try { this._pcmCollector.disconnect(); } catch {}
      this._pcmCollector = null;
    }
    if (this._pcmCollectorBlobUrl) {
      URL.revokeObjectURL(this._pcmCollectorBlobUrl);
      this._pcmCollectorBlobUrl = null;
    }
    this._pcmCollectorLoaded = false;
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

export default AudioManager;
