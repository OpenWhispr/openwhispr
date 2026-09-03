const { ipcMain, app, shell, BrowserWindow, systemPreferences, net, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { PARAKEET_UNSUPPORTED_OS_CODE } = require("./parakeetCapability");
const { getModelType, isSherpaLocalProvider } = require("./parakeetModelInfo");
const { broadcastToWindows } = require("./windowBroadcast");
const { openExternalUrl } = require("./externalUrlOpener");
const { resolveFailedGpuBackends } = require("./whisper");
const { BYOK_API_KEYS } = require("../config/secretKeys");
const tokenStore = require("./tokenStore");
const accountScopeBinding = require("./accountScopeBinding");
const { createCloudApiRequestHandler } = require("./cloudApiRequest");
const { withPolicyRequestHeaders } = require("./policyRequestHeaders");
const {
  createWorkspacePolicyManager,
  isScreenContextBlocked,
} = require("./workspacePolicyManager");
const { createEnterpriseIdentityManager } = require("./enterpriseIdentityManager");
const { createCloudConfigRequestHandler } = require("./cloudConfigRequest");
const { extractAnthropicText, describeMissingAnthropicText } = require("./anthropicResponse");
const {
  createPolicyResponseError,
  readPolicyResponseError,
  toPolicyFailure,
} = require("./policyResponseError");
const { classifyAndLog } = require("./networkErrors");
const { resolveSystemDefaultMicrophone } = require("./systemDefaultMicrophone");
// The renderer's ModelRegistry is not main-loadable; the raw registry data is
// packaged, and the route resolver only needs {id, baseUrl} per provider.
const transcriptionProviderBaseUrls = () =>
  require("../models/modelRegistryData.json").transcriptionProviders;
// ipcMain.handle keeps only the message when a promise rejects, dropping custom
// props — proxy handlers return {error, code, messageKey} so the renderer can
// rebuild the error.
const serializeIpcError =
  (fn) =>
  async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return { error: error.message, code: error.code, messageKey: error.messageKey };
    }
  };
// Which diarization dialect a resolved endpoint speaks, for Custom endpoints
// that front a known provider. Null when the host offers no known dialect.
const diarizationHost = (endpoint) => {
  try {
    const host = new URL(endpoint).hostname;
    if (host === "mistral.ai" || host.endsWith(".mistral.ai")) return "mistral";
    if (host === "openai.com" || host.endsWith(".openai.com")) return "openai";
  } catch {}
  return null;
};
const { resolveLocalServerNeeds } = require("./localServerPolicy");
const autoStart = require("./autoStart");
const HyprlandShortcutManager = require("./hyprlandShortcut");
const AssemblyAiStreaming = require("./assemblyAiStreaming");
const { i18nMain, changeLanguage } = require("./i18nMain");
const DeepgramStreaming = require("./deepgramStreaming");
const CortiStreaming = require("./cortiStreaming");
const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");
const { getCortiToken } = require("./cortiAuth");
const { ONBOARDING_DEMO_KINDS } = require("./onboardingInputPolicy");
const { focusWindowsHotkeyCaptureWindow } = require("./hotkeyCaptureFocus");
const { createTinfoilRealtimeSocket } = require("./tinfoilSecureClient");
const { TINFOIL_REALTIME_MODEL } = require("./tinfoilRealtimeStreaming");
const { getTinfoilChatModels } = require("./tinfoilCatalog");
const { transcribeWithTinfoil } = require("./tinfoilTranscription");
const { transcribeWithGemini } = require("./geminiTranscription");
const AudioStorageManager = require("./audioStorage");
const AgentStreamRequestRegistry = require("./agentStreamRequestRegistry");
const createMeetingTranscriptionLifecycle = require("./meetingTranscriptionLifecycle");
const { registerMeetingAutoEndLifecycleHandlers } = require("./meetingAutoEndLifecycle");
const liveSpeakerIdentifier = require("./liveSpeakerIdentifier");
const { supportsLiveSpeakerIdentification } = require("./liveSpeakerIdPolicy");
const MeetingEchoLeakDetector = require("./meetingEchoLeakDetector");
const {
  partitionPendingMicFinals,
  isRiskyMicDuplicateProfile,
  isDuplicateMicSegment,
  selectRacingMicEntryIndices,
  partitionOverlappingPendingMicFinals,
} = require("./meetingMicHoldback");
const {
  computeChunkStats,
  resolveMicChunkAction,
  MEETING_MIC_SILENCE_RMS,
  MEETING_MIC_SILENCE_PEAK,
} = require("./meetingMicGate");
const { resolveDiarizationInput } = require("./meetingDiarizationInput");
const { applySmartSpacing } = require("./smartSpacing");
const { applyAutoLearnSetting } = require("./autoLearnSetting");
const {
  DEFAULT_RETENTION_SETTINGS,
  createRetentionSettingsHandler,
} = require("./retentionSettings");
const {
  transcriptsOverlap,
  transcriptsLooselyOverlap,
  buildMergedCandidates,
} = require("./transcriptText");
const {
  applyConfirmedSpeaker,
  applySuggestedSpeaker,
  canAutoRelabelSpeaker,
  isSpeakerLocked,
} = require("./speakerAssignmentPolicy");
const { normalizeStoredSpeakerCount } = require("./speakerCount");
const { downsample24kTo16k, pcm16ToWav } = require("../utils/audioUtils");
const postMigrationDetector = require("./postMigrationDetector");
const screenContextCapture = require("./screenContextCapture");
const {
  DEFAULT_EXPECTED_SPEAKER_COUNT,
  MAX_SPEAKER_COUNT,
} = require("../constants/speakerDetection.json");
const {
  DEFAULT_WHISPER_VAD_CONFIG,
  sanitizeWhisperVadConfig,
  resolveContextSileroEnabled,
} = require("./whisperVadConfig");

const {
  ALLOWED_MEETING_PROVIDERS,
  getMeetingStreamingClient,
  getMeetingConnectionKey,
} = require("./meetingStreamingProviders");
const { fetchRealtimeTokenForProvider } = require("./realtimeTokenProviders");
const { getCalendarAvailability } = require("./calendarAvailabilityService");

// Meeting capture runs at 24 kHz (see meetingRecordingStore AudioContext); cloud
// streaming providers must be told the true PCM rate or they misread the audio.
const MEETING_STREAM_SAMPLE_RATE = 24000;
const MEETING_RECONNECT_BUFFER_MAX_BYTES = MEETING_STREAM_SAMPLE_RATE * 2 * 30;
// The realtime clients default to a 0.6 server-VAD threshold, raised in #630 to
// keep mic ambient noise from opening turns. The system loopback channel's noise
// floor is digital silence, so it keeps the original, more sensitive threshold —
// at 0.6 quiet remote speech may never trip the VAD and the whole channel
// transcribes to nothing.
const MEETING_SYSTEM_VAD_THRESHOLD = 0.3;

const MISTRAL_TRANSCRIPTION_URL = "https://api.mistral.ai/v1/audio/transcriptions";

const XAI_STT_URL = "https://api.x.ai/v1/stt";

// Debounce delay: wait for user to stop typing before processing corrections
const AUTO_LEARN_DEBOUNCE_MS = 1500;

// Route caps vary by provider (Gemini's inline-base64 limit is the lowest), so
// the message reports the cap that actually applied.
const byokSizeCapError = (sizeCapBytes) =>
  `File too large. Maximum size for bring-your-own-key is ${Math.floor(sizeCapBytes / (1024 * 1024))} MB.`;

const AUDIO_MIME_TYPES = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/ogg",
};

const CLOUD_INLINE_LIMIT = 4 * 1024 * 1024;
const CLOUD_CHUNK_SEGMENT_SECONDS = 240;

const { createAbortError } = require("./abortError");
const { testProviderConnection } = require("./providerConnectionTest");
const { createUploadCancelRegistry } = require("./uploadCancelRegistry");
const { applyOpenWhisprOriginHeader } = require("./sessionHeaders");
const {
  CLOUD_UPLOAD_TIMEOUT_MS,
  CLOUD_CHUNK_MAX_ATTEMPTS,
  CLOUD_CHUNK_GLOBAL_CONCURRENCY,
  CLOUD_CHUNK_MAX_TEARDOWN_REFUNDS,
  CLOUD_CHUNK_MAX_LOSS_RATIO,
  SILENT_CHUNK,
  FATAL_CHUNK_CODES,
  isTransientChunkError,
  isNetworkLevelFailure,
  isConnectionPoisoningFailure,
  isTeardownCollateral,
  summarizeChunkResults,
  assembleChunkTranscript,
  chunkRetryDelayMs,
  abortableSleep,
  createTeardownGate,
  createUploadSlots,
} = require("./cloudChunkPolicy");

// Chunk retries need their own connection pool: recovering a wedged chunk pool
// must not abort an unrelated inline upload that has no collateral retry path.
const CLOUD_CHUNK_UPLOAD_SESSION_PARTITION = "ow-cloud-chunk-uploads";
const CLOUD_INLINE_UPLOAD_SESSION_PARTITION = "ow-cloud-uploads";
const cloudUploadSlots = createUploadSlots(CLOUD_CHUNK_GLOBAL_CONCURRENCY);
const shouldDropUploadPool = createTeardownGate();
const cloudUploadSessions = new Map();

function getCloudUploadSession(partition) {
  if (!cloudUploadSessions.has(partition)) {
    const uploadSession = session.fromPartition(partition);
    applyOpenWhisprOriginHeader(uploadSession);
    cloudUploadSessions.set(partition, uploadSession);
  }
  return cloudUploadSessions.get(partition);
}

function getChunkCloudUploadSession() {
  return getCloudUploadSession(CLOUD_CHUNK_UPLOAD_SESSION_PARTITION);
}

function getInlineCloudUploadSession() {
  return getCloudUploadSession(CLOUD_INLINE_UPLOAD_SESSION_PARTITION);
}

// Counts initiated pool drops so a chunk can tell whether its failure was
// collateral from a teardown that happened while its body was on the wire.
let uploadPoolTeardowns = 0;

async function dropUploadConnections(force = false) {
  if (!shouldDropUploadPool(force)) return;
  uploadPoolTeardowns++;
  try {
    await getChunkCloudUploadSession().closeAllConnections();
  } catch {
    // pool teardown is best-effort
  }
}

const {
  formatTimestamp: formatDiarTime,
  mergeSpeakersWithText,
  formatSpeakerTranscript,
} = require("./speakerMerge");
const { timestampRequestFields, mapVerboseSegments } = require("./uploadTimestamps");

// Canonicalize allowed dirs so realpath'd inputs match on macOS (/var -> /private/var).
// Deliberately narrow: user-picked paths anywhere else are approved individually via
// approvedAudioPaths, so a compromised renderer can't read arbitrary files.
function getCanonicalAllowedAudioDirs() {
  const os = require("os");
  const { getSafeTempDir } = require("./safeTempDir");
  const dirs = [os.tmpdir(), getSafeTempDir(), app.getPath("userData")];
  return dirs.map((d) => {
    try {
      return fs.realpathSync(d);
    } catch {
      return d;
    }
  });
}

// User-picked paths (OS file dialog, real drag-dropped files) may live outside the
// static dirs (external volumes, /mnt, D:\) and are approved individually.
const approvedAudioPaths = new Set();

function approveAudioPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return;
  try {
    approvedAudioPaths.add(fs.realpathSync(path.resolve(filePath)));
  } catch {
    // File vanished or unreadable; nothing to approve.
  }
}

// Returns the realpath'd file path if it lives under an allowed dir, else null.
function resolveAllowedAudioPath(filePath) {
  const real = fs.realpathSync(path.resolve(filePath));
  if (approvedAudioPaths.has(real)) {
    return real;
  }
  const allowed = getCanonicalAllowedAudioDirs();
  if (allowed.some((dir) => real === dir || real.startsWith(dir + path.sep))) {
    return real;
  }
  return null;
}

function buildMultipartBody(fileBuffer, fileName, contentType, fields = {}) {
  const boundary = `----OpenWhispr${Date.now()}`;
  const parts = [];

  parts.push(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  parts.push(fileBuffer);
  parts.push("\r\n");

  for (const [name, value] of Object.entries(fields)) {
    if (value != null) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`
      );
    }
  }

  parts.push(`--${boundary}--\r\n`);

  const bodyParts = parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p));
  return { body: Buffer.concat(bodyParts), boundary };
}

async function postMultipart(
  url,
  body,
  boundary,
  headers = {},
  { signal, session: fetchSession } = {}
) {
  const response = await (fetchSession ?? net).fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      ...headers,
    },
    body,
    useSessionCookies: false,
    signal,
  });
  const text = await response.text();
  try {
    return { statusCode: response.status, data: JSON.parse(text) };
  } catch {
    // Vercel platform errors (413 payload cap, 504 timeout) return non-JSON bodies.
    throw Object.assign(new Error(`Server error ${response.status}: ${text.slice(0, 120)}`), {
      code: "SERVER_ERROR",
      statusCode: response.status,
    });
  }
}

function interpretTranscribeResponse(data) {
  if (data.statusCode === 401) {
    throw Object.assign(new Error("Session expired"), { code: "AUTH_EXPIRED" });
  }
  if (data.statusCode === 503) {
    throw Object.assign(new Error("Request timed out"), { code: "SERVER_ERROR" });
  }
  if (data.statusCode === 429) {
    throw Object.assign(new Error("Daily word limit reached"), {
      code: "LIMIT_REACHED",
      ...data.data,
    });
  }
  if (data.statusCode === 422 && data.data?.code === "NO_SPEECH_DETECTED") {
    throw Object.assign(new Error(data.data.error || "No speech detected in audio"), {
      code: "NO_SPEECH_DETECTED",
    });
  }
  if (data.statusCode !== 200) {
    throw createPolicyResponseError(data.statusCode, data.data, `API error: ${data.statusCode}`);
  }
  return data.data;
}

async function chunkedCloudTranscribe({
  buffer = null,
  filePath = null,
  apiUrl,
  policyHeaders,
  multipartFields = {},
  onProgress,
  signal,
  segmentDuration = CLOUD_CHUNK_SEGMENT_SECONDS,
}) {
  const { splitAudioFile } = require("./ffmpegUtils");

  // Aborted by the caller cancelling or by the first fatal chunk error, so a
  // doomed job stops uploading its remaining chunks immediately.
  const jobController = new AbortController();
  const { signal: jobSignal } = jobController;
  const abortJob = () => jobController.abort();
  signal?.addEventListener("abort", abortJob, { once: true });
  if (signal?.aborted) abortJob();

  const jobId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const chunkDir = path.join(os.tmpdir(), `ow-chunks-${jobId}`);
  let tmpInputPath = null;

  let inputPath = filePath;
  if (!inputPath && buffer) {
    tmpInputPath = path.join(os.tmpdir(), `ow-audio-${jobId}.webm`);
    fs.writeFileSync(tmpInputPath, buffer);
    inputPath = tmpInputPath;
  }

  fs.mkdirSync(chunkDir, { recursive: true });

  try {
    onProgress?.({ stage: "splitting", chunksTotal: 0, chunksCompleted: 0 });

    const { chunkPaths, durationSeconds } = await splitAudioFile(inputPath, chunkDir, {
      segmentDuration,
      signal: jobSignal,
    });
    const totalChunks = chunkPaths.length;

    onProgress?.({ stage: "transcribing", chunksTotal: totalChunks, chunksCompleted: 0 });

    const url = new URL(`${apiUrl}/api/transcribe`);
    const results = new Array(totalChunks).fill(null);
    let fatalError = null;
    let completedCount = 0;

    const transcribeChunk = async (index) => {
      let attempt = 1;
      let teardownRefunds = CLOUD_CHUNK_MAX_TEARDOWN_REFUNDS;
      while (true) {
        if (jobSignal.aborted) throw createAbortError();

        // Held only while a body is on the wire, so the backoff below never
        // occupies a slot and queue time never eats the upload timeout.
        const releaseSlot = await cloudUploadSlots.acquire(jobSignal);
        const timeoutSignal = AbortSignal.timeout(CLOUD_UPLOAD_TIMEOUT_MS);
        const teardownsAtStart = uploadPoolTeardowns;
        let failure = null;
        let timedOut = false;
        let collateral = false;
        try {
          try {
            const { body, boundary } = buildMultipartBody(
              fs.readFileSync(chunkPaths[index]),
              path.basename(chunkPaths[index]),
              "audio/mpeg",
              multipartFields
            );
            const data = await postMultipart(url, body, boundary, policyHeaders, {
              signal: AbortSignal.any([jobSignal, timeoutSignal]),
              session: getChunkCloudUploadSession(),
            });
            results[index] = interpretTranscribeResponse(data);
          } catch (err) {
            failure = err;
            timedOut = timeoutSignal.aborted;
            collateral = isTeardownCollateral(err, {
              timedOut,
              teardownsDuringAttempt: uploadPoolTeardowns - teardownsAtStart,
            });
            // Drop the pool while still holding the slot — released first, a
            // queued sibling is admitted onto the pool microseconds before
            // closeAllConnections() kills it and burns an attempt it never
            // owned. A fatal TLS/protocol alert proves the pool is poisoned,
            // so that drop is forced through the cooldown gate.
            if (!jobSignal.aborted && !collateral) {
              const poisoned = isConnectionPoisoningFailure(err);
              if (poisoned || isNetworkLevelFailure(err, { timedOut })) {
                await dropUploadConnections(poisoned);
              }
            }
          }
        } finally {
          releaseSlot();
        }
        if (!failure) break;

        if (failure.code === "NO_SPEECH_DETECTED") {
          results[index] = SILENT_CHUNK;
          break;
        }

        if (jobSignal.aborted) throw createAbortError();
        if (collateral && teardownRefunds > 0) {
          teardownRefunds--;
          debugLogger.warn(`Chunk ${index} attempt ${attempt} killed by pool teardown, refunded`, {
            error: failure.message,
          });
          await abortableSleep(chunkRetryDelayMs(1), jobSignal);
          continue;
        }
        if (attempt >= CLOUD_CHUNK_MAX_ATTEMPTS || !(timedOut || isTransientChunkError(failure))) {
          throw failure;
        }
        debugLogger.warn(`Chunk ${index} attempt ${attempt} failed, retrying`, {
          error: failure.message,
          timedOut,
        });
        await abortableSleep(chunkRetryDelayMs(attempt), jobSignal);
        attempt++;
      }

      completedCount++;
      onProgress?.({
        stage: "transcribing",
        chunksTotal: totalChunks,
        chunksCompleted: completedCount,
      });
    };

    await Promise.all(
      chunkPaths.map((_, index) =>
        transcribeChunk(index).catch((err) => {
          // Only aborts the job itself caused, reported once below. A chunk's
          // own upload timeout also aborts, and that is a real failure.
          if (jobSignal.aborted && err.name === "AbortError") return;
          if (FATAL_CHUNK_CODES.has(err.code)) {
            fatalError ??= err;
            abortJob();
            return;
          }
          debugLogger.warn(`Chunk ${index} failed`, { error: err.message, code: err.code });
        })
      )
    );

    if (signal?.aborted) {
      throw Object.assign(createAbortError("Upload cancelled"), { code: "UPLOAD_CANCELLED" });
    }
    if (fatalError) throw fatalError;

    const { responses, failedChunks: failed, silentChunks } = summarizeChunkResults(results);
    if (responses.length === 0) {
      if (silentChunks === totalChunks) {
        throw Object.assign(new Error("No speech detected in audio"), {
          code: "NO_SPEECH_DETECTED",
        });
      }
      throw new Error("All chunks failed to transcribe");
    }

    if (failed / totalChunks > CLOUD_CHUNK_MAX_LOSS_RATIO) {
      throw Object.assign(new Error(`${failed} of ${totalChunks} audio segments were lost`), {
        code: "CHUNK_LOSS_EXCEEDED",
      });
    }

    const text = assembleChunkTranscript(results, segmentDuration, durationSeconds);
    return {
      text,
      responses,
      lastResponse: responses[responses.length - 1],
      ...(failed > 0
        ? {
            warning: `${failed} of ${totalChunks} chunks failed`,
            failedChunks: failed,
            totalChunks,
          }
        : {}),
    };
  } finally {
    signal?.removeEventListener("abort", abortJob);
    if (tmpInputPath) {
      try {
        fs.unlinkSync(tmpInputPath);
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(chunkDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      debugLogger.warn("Failed to cleanup chunk dir", { error: cleanupErr.message });
    }
  }
}

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this.whisperManager = managers.whisperManager;
    this.parakeetManager = managers.parakeetManager;
    this.diarizationManager = managers.diarizationManager;
    this.windowManager = managers.windowManager;
    this.updateManager = managers.updateManager;
    this.windowsKeyManager = managers.windowsKeyManager;
    this.linuxKeyManager = managers.linuxKeyManager;
    this.textEditMonitor = managers.textEditMonitor;
    this.selectionManager = managers.selectionManager;
    this.getTrayManager = managers.getTrayManager;
    this.whisperCudaManager = managers.whisperCudaManager;
    this.whisperVulkanManager = managers.whisperVulkanManager;
    this.googleCalendarManager = managers.googleCalendarManager;
    this.microsoftCalendarManager = managers.microsoftCalendarManager;
    this.appleCalendarManager = managers.appleCalendarManager;
    this.meetingDetectionEngine = managers.meetingDetectionEngine;
    this.audioTapManager = managers.audioTapManager;
    this.linuxPortalAudioManager = managers.linuxPortalAudioManager;
    this.windowsLoopbackAudioManager = managers.windowsLoopbackAudioManager;
    this.meetingAecManager = managers.meetingAecManager;
    this.getQdrantManager = managers.getQdrantManager;
    this.oauthProtocolRegistered = managers.oauthProtocolRegistered === true;
    this.oauthProtocol = managers.oauthProtocol || "openwhispr";
    this.sessionId = crypto.randomUUID();
    // requestId -> AbortControllers for in-flight audio-upload work (cloud
    // upload, or local transcription + diarization sharing one id), so a
    // cancel can abort the exact job.
    this._uploadCancelRegistry = createUploadCancelRegistry();
    this._agentStreamRequests = new AgentStreamRequestRegistry();
    this._cloudReasonRequests = new AgentStreamRequestRegistry();
    this._cloudTranscriptionRequests = new AgentStreamRequestRegistry();
    this._enterpriseReasoningRequests = new AgentStreamRequestRegistry();
    // webContents id -> its release listener, for renderers holding the mic open.
    this._micHoldSenders = new Map();
    this.assemblyAiStreaming = null;
    this.deepgramStreaming = null;
    this.cortiStreaming = null;
    this._dictationStreaming = null;
    this._dictationConnectPromise = null;
    this._dictationIdleTimer = null;
    this._dictationPreviewEnabled = false;
    this._meetingMicStreaming = null;
    this._meetingSystemStreaming = null;
    this._hotkeyCaptureMode = false;
    this._autoLearnEnabled = true; // Default on, synced from renderer
    this._autoLearnDebounceTimer = null;
    this._autoLearnLatestData = null;
    this._textEditHandler = null;
    this._activeRecordingPipeline = null;
    this._onboardingDemoSession = null;
    this.audioStorageManager = new AudioStorageManager();
    this._retentionCleanupInterval = null;
    this._retentionSettings = { ...DEFAULT_RETENTION_SETTINGS }; // Synced from renderer
    this._retentionSettingsSynced = false;
    this._noteFilesEnabled = false;
    this._granolaImportPending = null;
    this.speakerDiarizationEnabled = true;
    this.activeMeetingSpeakerConfig = null;
    this.whisperVadSettings = {
      dictationSileroEnabled: false,
      noteRecordingSileroEnabled: true,
      meetingSileroEnabled: true,
      ...DEFAULT_WHISPER_VAD_CONFIG,
    };
    liveSpeakerIdentifier.setDiarizationManager(this.diarizationManager);
    this._setupTextEditMonitor();
    this._setupRetentionCleanup();
    this._logDetectedGpus();
    this.setupHandlers();
    // Lives for the app's lifetime; IPCHandlers has no teardown path.
    tokenStore.subscribe(({ generation, token }) => {
      this.enterpriseIdentityManager?.clear();
      if (!token) {
        this.databaseManager.setActiveAccountId(null);
        accountScopeBinding.clear();
      }
      broadcastToWindows("auth-token-state-changed", {
        generation,
        hasToken: Boolean(token),
      });
    });

    if (this.whisperManager?.serverManager) {
      // Remember the failed backend so it isn't re-attempted (and its model
      // reload re-paid) on every launch; cleared by retry, re-download, delete.
      this.whisperManager.serverManager.on("cuda-fallback", () => {
        this._recordWhisperGpuFailure("cuda");
        broadcastToWindows("cuda-fallback-notification", {});
      });
      this.whisperManager.serverManager.on("gpu-fallback", () => {
        this._recordWhisperGpuFailure("vulkan");
        broadcastToWindows("gpu-fallback-notification", {});
      });
      // Persist the discrete-GPU pin so later launches spawn pinned directly
      // instead of paying a second Vulkan cold start. See #1606.
      this.whisperManager.serverManager.on("vulkan-device-pinned", ({ index }) => {
        this._syncStartupEnv({ WHISPER_VULKAN_DEVICE: String(index) });
      });
      this.whisperManager.serverManager.on("vulkan-device-pin-cleared", () => {
        this._syncStartupEnv({}, ["WHISPER_VULKAN_DEVICE"]);
      });
    }
  }

  // The dictation slot reports its own changes from the renderer. Slots
  // registered through IPC have to announce theirs here so macOS can re-derive
  // which keys the native Globe listener owns.
  _notifyHotkeyChanged(hotkey) {
    ipcMain.emit("hotkey-changed", null, hotkey);
  }

  _releaseMicHold(sender) {
    const release = this._micHoldSenders.get(sender.id);
    if (!release) return;
    this._micHoldSenders.delete(sender.id);
    sender.off("destroyed", release);
    sender.off("did-finish-load", release);
    this.meetingDetectionEngine?.setMicWarmHold(this._micHoldSenders.size > 0);
  }

  _getWhisperVadSettings() {
    const current = this.whisperVadSettings || {};
    return {
      dictationSileroEnabled: current.dictationSileroEnabled === true,
      noteRecordingSileroEnabled: current.noteRecordingSileroEnabled !== false,
      meetingSileroEnabled: current.meetingSileroEnabled !== false,
      ...sanitizeWhisperVadConfig(current),
    };
  }

  _setWhisperVadSettings(update = {}) {
    const ALLOWED_KEYS = new Set([
      "dictationSileroEnabled",
      "noteRecordingSileroEnabled",
      "meetingSileroEnabled",
      ...Object.keys(require("../constants/whisperVad.json").DEFAULTS),
    ]);
    const filtered = {};
    for (const [k, v] of Object.entries(update)) {
      if (ALLOWED_KEYS.has(k)) filtered[k] = v;
    }
    this.whisperVadSettings = { ...this._getWhisperVadSettings(), ...filtered };
    return this._getWhisperVadSettings();
  }

  _resolveWhisperVadOptions(context) {
    const settings = this._getWhisperVadSettings();
    const {
      dictationSileroEnabled,
      noteRecordingSileroEnabled,
      meetingSileroEnabled,
      ...vadConfig
    } = settings;
    return {
      vadEnabled: resolveContextSileroEnabled(settings, context),
      vadConfig,
    };
  }

  _asyncVectorUpsert(note) {
    setImmediate(() => {
      const vectorIndex = require("./vectorIndex");
      if (!vectorIndex.isReady()) return;
      const { LocalEmbeddings } = require("./localEmbeddings");
      const text = LocalEmbeddings.noteEmbedText(note.title, note.content, note.enhanced_content);
      vectorIndex
        .upsertNote(note.id, text, { space_id: note.space_id, folder_id: note.folder_id ?? null })
        .catch(() => {});
    });
  }

  _asyncVectorDelete(noteId) {
    setImmediate(() => {
      const vectorIndex = require("./vectorIndex");
      if (!vectorIndex.isReady()) return;
      vectorIndex.deleteNote(noteId).catch(() => {});
    });
  }

  // Space vector purges are persisted (pending_vector_purges) so a purge that
  // lands while Qdrant is booting or down is retried once the index is ready.
  drainPendingVectorPurges() {
    setImmediate(() => {
      void (async () => {
        const vectorIndex = require("./vectorIndex");
        if (!vectorIndex.isReady()) return;
        for (const { space_id } of this.databaseManager.getPendingVectorPurges()) {
          if (await vectorIndex.deleteBySpace(space_id)) {
            this.databaseManager.clearPendingVectorPurge(space_id);
          }
        }
      })().catch((error) => {
        debugLogger.error(
          "Pending vector purge drain failed",
          { error: error?.message || String(error) },
          "semantic-search"
        );
      });
    });
  }

  _mirrorDeleteFolderIfUnshared(folderName) {
    if (!this._noteFilesEnabled) return;
    // Folder names are only unique per space — a live same-named folder in
    // another space shares the mirror directory, so leave it on disk.
    const stillLive = this.databaseManager.db
      .prepare("SELECT 1 FROM folders WHERE name = ? AND deleted_at IS NULL")
      .get(folderName);
    if (stillLive) return;
    const markdownMirror = require("./markdownMirror");
    markdownMirror.deleteFolder(folderName);
  }

  _asyncMirrorWrite(note) {
    if (!this._noteFilesEnabled) {
      debugLogger.debug(
        "Mirror write skipped: note files disabled",
        { noteId: note.id },
        "note-files"
      );
      return;
    }
    setImmediate(() => {
      const markdownMirror = require("./markdownMirror");
      const folderName = this._getFolderName(note.folder_id);
      markdownMirror.writeNote(note, folderName);
      if (note.transcript) {
        markdownMirror.writeTranscript(note, folderName, this._buildSpeakerMappings(note.id));
      }
    });
  }

  _asyncMirrorDelete(noteId) {
    if (!this._noteFilesEnabled) {
      debugLogger.debug("Mirror delete skipped: note files disabled", { noteId }, "note-files");
      return;
    }
    setImmediate(() => {
      const markdownMirror = require("./markdownMirror");
      markdownMirror.deleteNote(noteId);
    });
  }

  _buildFolderMap() {
    const folders = this.databaseManager.getFolders();
    const map = {};
    for (const f of folders) {
      map[f.id] = f.name;
    }
    return map;
  }

  _buildSpeakerMappings(noteId) {
    const arr = this.databaseManager.getSpeakerMappings(noteId);
    const map = {};
    for (const m of arr) {
      map[m.speaker_id] = m.display_name;
    }
    return map;
  }

  _parseNonSelfParticipants(participantsJson) {
    if (!participantsJson) return [];
    let participants;
    try {
      participants = JSON.parse(participantsJson);
    } catch (_) {
      return [];
    }
    if (!Array.isArray(participants) || participants.length === 0) return [];
    const googleEmails = new Set(
      this.databaseManager.getGoogleAccounts().map((a) => a.email.toLowerCase())
    );
    return participants.filter(
      (p) => p && p.self !== true && !googleEmails.has((p.email || "").toLowerCase())
    );
  }

  _getNoteNonSelfParticipants(noteId) {
    if (!noteId) return [];
    try {
      const note = this.databaseManager.getNote(noteId);
      return this._parseNonSelfParticipants(note?.participants);
    } catch (_) {
      return [];
    }
  }

  _resolveOneOnOneOtherParticipant(participantsJson) {
    const others = this._parseNonSelfParticipants(participantsJson);
    if (others.length !== 1) return null;
    const displayName = others[0].displayName || others[0].email;
    if (!displayName) return null;
    const email = (others[0].email || "").toLowerCase().trim() || null;
    return { displayName, email };
  }

  _noteExpectedSpeakerCountOrNull(note) {
    const stored = normalizeStoredSpeakerCount(note?.expected_speaker_count);
    if (stored != null) {
      return stored;
    }
    const others = this._parseNonSelfParticipants(note?.participants).length;
    if (others > 0) {
      return Math.min(others + 1, MAX_SPEAKER_COUNT);
    }
    return null;
  }

  _resolveNoteExpectedSpeakerCount(note) {
    return this._noteExpectedSpeakerCountOrNull(note) ?? DEFAULT_EXPECTED_SPEAKER_COUNT;
  }

  _resolveInitialMeetingSpeakerConfig(noteId) {
    let note = null;
    if (noteId != null) {
      try {
        note = this.databaseManager.getNote(noteId);
      } catch (_) {
        note = null;
      }
    }
    const enabled =
      (note?.diarization_enabled == null
        ? this.speakerDiarizationEnabled
        : note.diarization_enabled !== 0) !== false;
    return { enabled, expectedCount: this._resolveNoteExpectedSpeakerCount(note) };
  }

  // Participants added mid-meeting must raise the speaker cap that was derived
  // from the note at recording start. A count the user set via the stepper
  // (explicit) is never overridden.
  //
  // Raise-only: lowering the cap below the clusters already discovered would make
  // _assignOrForceCluster fold every later voice onto an existing speaker — the
  // exact identity collapse this refresh exists to prevent. A roster that shrinks
  // (or empties) mid-meeting therefore leaves the cap where it is.
  _refreshMeetingSpeakerConfigFromNote(noteId, note) {
    const config = this.activeMeetingSpeakerConfig;
    if (!config || config.explicit) return;
    if (noteId == null || this._activeMeetingNoteId !== noteId) return;

    const expectedCount = this._noteExpectedSpeakerCountOrNull(note);
    if (expectedCount == null || expectedCount <= config.expectedCount) return;

    this.activeMeetingSpeakerConfig = { ...config, expectedCount };
    liveSpeakerIdentifier.setMaxSpeakers(Math.max(1, expectedCount - 1));
    broadcastToWindows("meeting-session-speaker-config-updated", {
      enabled: config.enabled,
      expectedCount,
    });
    debugLogger.info(
      "Meeting speaker config refreshed from participants",
      { noteId, expectedCount },
      "speaker"
    );
  }

  _rebuildMirror(basePath) {
    const markdownMirror = require("./markdownMirror");
    if (basePath) markdownMirror.init(basePath);
    const notes = this.databaseManager.getNotes(null, 99999);
    const speakerMappingsMap = {};
    for (const note of notes) {
      if (note.transcript) {
        speakerMappingsMap[note.id] = this._buildSpeakerMappings(note.id);
      }
    }
    markdownMirror.rebuildAll(notes, this._buildFolderMap(), speakerMappingsMap);
  }

  _getFolderName(folderId) {
    if (!folderId) return "Personal";
    const folder = this.databaseManager.db
      .prepare("SELECT name FROM folders WHERE id = ?")
      .get(folderId);
    return folder?.name || "Personal";
  }

  _getDictionarySafe() {
    try {
      return this.databaseManager.getDictionary();
    } catch {
      return [];
    }
  }

  _cleanupTextEditMonitor() {
    if (this._autoLearnDebounceTimer) {
      clearTimeout(this._autoLearnDebounceTimer);
      this._autoLearnDebounceTimer = null;
    }
    this._autoLearnLatestData = null;
    if (this.textEditMonitor && this._textEditHandler) {
      this.textEditMonitor.removeListener("text-edited", this._textEditHandler);
      this._textEditHandler = null;
    }
  }

  async _logDetectedGpus() {
    const { listNvidiaGpus } = require("../utils/gpuDetection");
    const gpus = await listNvidiaGpus();
    if (gpus.length > 0) {
      debugLogger.info(
        "NVIDIA GPUs detected",
        {
          count: gpus.length,
          devices: gpus.map((g) => `[${g.index}] ${g.name} (${g.vramMb}MB) ${g.uuid}`),
        },
        "gpu"
      );
    } else {
      debugLogger.debug("No NVIDIA GPUs detected", {}, "gpu");
    }
  }

  _setupRetentionCleanup() {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    // No sweep at startup: _retentionSettings still holds the 30-day default
    // until the renderer syncs, so sweeping here deletes audio a user set to
    // keep for 60/90 days or forever (#1370). The first sync runs the first
    // sweep instead.
    this._retentionCleanupInterval = setInterval(() => {
      if (this._retentionSettingsSynced) this._runRetentionCleanup();
    }, SIX_HOURS_MS);
  }

  _runRetentionCleanup() {
    const { audioRetentionDays, transcriptRetentionDays } = this._retentionSettings;
    try {
      if (transcriptRetentionDays > 0) {
        const { ids } =
          this.databaseManager.deleteTranscriptionsExpiredBefore(transcriptRetentionDays);
        for (const id of ids) {
          this.audioStorageManager.deleteAudio(id);
          broadcastToWindows("transcription-deleted", { id });
        }
      }
      if (audioRetentionDays > 0) {
        this.audioStorageManager.cleanupExpiredAudio(audioRetentionDays, this.databaseManager);
      }
    } catch (error) {
      debugLogger.error("Retention cleanup failed", { error: error.message }, "audio-storage");
    }
  }

  _setupTextEditMonitor() {
    if (!this.textEditMonitor) return;

    this._textEditHandler = (data) => {
      if (
        !data ||
        typeof data.originalText !== "string" ||
        typeof data.newFieldValue !== "string"
      ) {
        debugLogger.debug("[AutoLearn] Invalid event payload, skipping");
        return;
      }

      const { originalText, newFieldValue } = data;

      debugLogger.debug("[AutoLearn] text-edited event", {
        originalPreview: originalText.substring(0, 80),
        newValuePreview: newFieldValue.substring(0, 80),
      });

      this._autoLearnLatestData = { originalText, newFieldValue };

      if (this._autoLearnDebounceTimer) {
        clearTimeout(this._autoLearnDebounceTimer);
      }

      this._autoLearnDebounceTimer = setTimeout(() => {
        this._processCorrections();
      }, AUTO_LEARN_DEBOUNCE_MS);
    };

    this.textEditMonitor.on("text-edited", this._textEditHandler);
  }

  _processCorrections() {
    this._autoLearnDebounceTimer = null;
    if (!this._autoLearnLatestData) return;
    if (!this._autoLearnEnabled) {
      debugLogger.debug("[AutoLearn] Disabled, skipping correction processing");
      this._autoLearnLatestData = null;
      return;
    }

    const { originalText, newFieldValue } = this._autoLearnLatestData;
    this._autoLearnLatestData = null;

    try {
      const { extractCorrections } = require("../utils/correctionLearner");
      const currentDict = this._getDictionarySafe();
      const corrections = extractCorrections(originalText, newFieldValue, currentDict);
      debugLogger.debug("[AutoLearn] Corrections result", {
        corrections,
        dictSize: currentDict.length,
      });

      if (corrections.length > 0) {
        const saveResult = this.databaseManager.applyDictionaryChanges(
          { add: corrections },
          "learned"
        );

        if (saveResult?.success === false) {
          debugLogger.debug("[AutoLearn] Failed to save dictionary", { error: saveResult.error });
          return;
        }

        // Broadcast the post-save normalized list, not the raw input (which
        // still has case-variant dupes), so renderers don't flash ghost rows.
        broadcastToWindows("dictionary-updated", this.databaseManager.getDictionary());

        // Show the overlay so the toast is visible (it may have been hidden after dictation)
        this.windowManager.showDictationPanel();
        broadcastToWindows("corrections-learned", corrections);
        debugLogger.debug("[AutoLearn] Saved corrections", { corrections });
      }
    } catch (error) {
      debugLogger.debug("[AutoLearn] Error processing corrections", { error: error.message });
    }
  }

  _whisperGpuFailedBackends() {
    return resolveFailedGpuBackends(process.env.WHISPER_GPU_FAILED);
  }

  _recordWhisperGpuFailure(backend) {
    const failed = this._whisperGpuFailedBackends();
    if (!failed.includes(backend)) failed.push(backend);
    this._syncStartupEnv({ WHISPER_GPU_FAILED: failed.join(",") });
  }

  _clearWhisperGpuFailure(backend) {
    const failed = this._whisperGpuFailedBackends().filter((b) => b !== backend);
    if (failed.length > 0) {
      this._syncStartupEnv({ WHISPER_GPU_FAILED: failed.join(",") });
    } else {
      this._syncStartupEnv({}, ["WHISPER_GPU_FAILED"]);
    }
  }

  // Captured before a handler stops the server to touch pack files (stopServer
  // clears currentServerModel); tells _applyWhisperGpuPreference what to reload.
  _whisperReloadModel() {
    return this.whisperManager.serverManager.isRemote
      ? null
      : this.whisperManager.currentServerModel;
  }

  // Apply a GPU pack change to the loaded server without blocking the caller's
  // IPC reply (a Vulkan cold start can take minutes); the renderer follows
  // progress by polling whisper-server-status. Returns whether a reload was
  // kicked off so the UI shows "activating" only when one is coming.
  _applyWhisperGpuPreference(modelName) {
    this.whisperManager.restartServerWithGpuPreference(modelName).catch((err) => {
      debugLogger.error("whisper-server GPU preference restart failed", { error: err.message });
    });
    return !!modelName;
  }

  _syncStartupEnv(setVars, clearVars = []) {
    let changed = false;
    for (const [key, value] of Object.entries(setVars)) {
      if (process.env[key] !== value) {
        process.env[key] = value;
        changed = true;
      }
    }
    for (const key of clearVars) {
      if (process.env[key]) {
        delete process.env[key];
        changed = true;
      }
    }
    if (changed) {
      debugLogger.debug("Synced startup env vars", {
        set: Object.keys(setVars),
        cleared: clearVars.filter((k) => !process.env[k]),
      });
      // A swallowed .env write failure here left GPU enablement flags silently
      // out of sync with the packs on disk (#1340) — log which keys were lost.
      this.environmentManager.saveAllKeysToEnvFile().catch((err) => {
        debugLogger.error("Failed to persist startup env vars to .env", {
          set: Object.keys(setVars),
          clearRequested: clearVars,
          error: err.message,
        });
      });
    }
  }

  // Mints a Corti access token from stored BYOK credentials. Shared by the
  // dictation streaming handlers and the meeting realtime-token resolver.
  async _mintStoredCortiToken(options = {}) {
    const clientId = this.environmentManager.getCortiClientId();
    const clientSecret = this.environmentManager.getCortiClientSecret();
    if (!clientId || !clientSecret) {
      const err = new Error("No Corti credentials configured. Add them in Settings.");
      err.code = "NO_API";
      throw err;
    }
    const environment = options.environment || "us";
    const tenant = (options.tenant || "").trim() || "base";
    const token = await getCortiToken({ environment, tenant, clientId, clientSecret });
    return { token, environment, tenant };
  }

  setupHandlers() {
    ipcMain.handle("onboarding-set-window-mode", (_event, mode) =>
      this.windowManager.setOnboardingWindowMode(mode)
    );

    // WindowManager owns every teardown path for a demo (id-matched end,
    // onboarding-set-active(false), control panel closed); without this hook a
    // renderer crash mid-demo would leave the session set and broadcast every
    // later dictation's transcripts on onboarding-demo-event forever.
    this.windowManager.onOnboardingDemoTeardown = () => {
      this._onboardingDemoSession = null;
    };

    ipcMain.handle("onboarding-set-active", (_event, active) => {
      if (typeof active !== "boolean") return false;
      return this.windowManager.setOnboardingActive(active);
    });

    ipcMain.handle("onboarding-demo-begin", (_event, session) => {
      if (
        !session ||
        typeof session.id !== "string" ||
        session.id.length > 128 ||
        !ONBOARDING_DEMO_KINDS.has(session.kind)
      ) {
        return false;
      }
      this._onboardingDemoSession = {
        id: session.id,
        kind: session.kind,
        startedAt: Date.now(),
      };
      return this.windowManager.beginOnboardingDemo(session.kind);
    });

    ipcMain.handle("onboarding-demo-end", (_event, id) => {
      if (this._onboardingDemoSession?.id === id) {
        // Session cleanup rides on the teardown hook above.
        this.windowManager.endOnboardingDemo();
      }
      return true;
    });

    ipcMain.handle("onboarding-demo-stop", (_event, id) => {
      if (this._onboardingDemoSession?.id !== id) return false;
      return this.windowManager.stopOnboardingDemoRecording();
    });

    ipcMain.handle("onboarding-demo-publish", (_event, event) => {
      const session = this._onboardingDemoSession;
      if (!session || !event || event.kind !== session.kind) return false;
      if (!["listening", "processing", "partial", "success", "error"].includes(event.status)) {
        return false;
      }
      const text = typeof event.text === "string" ? event.text.slice(0, 20000) : undefined;
      const message = typeof event.message === "string" ? event.message.slice(0, 500) : undefined;
      broadcastToWindows("onboarding-demo-event", {
        demoId: session.id,
        kind: session.kind,
        status: event.status,
        text,
        message,
      });
      return true;
    });

    ipcMain.handle("test-provider-connection", async (_event, config) => {
      if (config?.provider === "corti" && config?.scope === "transcription") {
        try {
          const clientId = String(config.clientId || "").trim();
          const clientSecret = String(config.clientSecret || "").trim();
          if (clientId && clientSecret) {
            await getCortiToken({
              environment: config.environment || "us",
              tenant: String(config.tenant || "").trim() || "base",
              clientId,
              clientSecret,
            });
          } else {
            await this._mintStoredCortiToken({
              environment: config.environment,
              tenant: config.tenant,
            });
          }
          return { success: true };
        } catch (error) {
          // errorCode is the machine-readable field the renderer maps to i18n;
          // the English string stays for logs/back-compat. Only a response
          // Corti actually sent counts as a rejection (getCortiToken prefixes
          // those); a fetch that never reached it is a network problem, and
          // reporting it as "credentials rejected" sends the user to re-type a
          // key that was never the issue.
          if (error?.name === "AbortError") {
            return {
              success: false,
              errorCode: "timeout",
              error: "The connection test timed out.",
            };
          }
          if (!/^(Corti authentication failed|Invalid Corti)/.test(error?.message || "")) {
            return {
              success: false,
              errorCode: "network",
              error: "The provider could not be reached.",
            };
          }
          return {
            success: false,
            errorCode: "credentialsRejected",
            error: "Corti rejected these credentials.",
          };
        }
      }
      return testProviderConnection(config);
    });

    ipcMain.handle("window-minimize", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.minimize();
      }
    });

    ipcMain.handle("window-maximize", () => {
      if (this.windowManager.controlPanelWindow) {
        if (this.windowManager.controlPanelWindow.isMaximized()) {
          this.windowManager.controlPanelWindow.unmaximize();
        } else {
          this.windowManager.controlPanelWindow.maximize();
        }
      }
    });

    ipcMain.handle("window-close", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.close();
      }
    });

    ipcMain.handle("window-is-maximized", () => {
      if (this.windowManager.controlPanelWindow) {
        return this.windowManager.controlPanelWindow.isMaximized();
      }
      return false;
    });

    ipcMain.handle("snap-to-meeting-mode", () => {
      this.windowManager.snapControlPanelToMeetingMode();
    });

    ipcMain.handle("restore-from-meeting-mode", () => {
      this.windowManager.restoreControlPanelFromMeetingMode();
      this.meetingDetectionEngine?.setMeetingModeActive(false);
    });

    ipcMain.handle("hide-window", () => {
      this.windowManager.hideDictationPanel();
    });

    ipcMain.handle("show-dictation-panel", () => {
      this.windowManager.showDictationPanel({ reposition: true });
    });

    ipcMain.handle("capture-dictation-target", async () => {
      const pid = (await this.textEditMonitor?.captureTargetPid?.()) ?? null;
      await this.selectionManager?.captureTarget?.();
      return { success: true, pid };
    });

    ipcMain.handle("force-stop-dictation", () => {
      if (this.windowManager?.forceStopMacCompoundPush) {
        this.windowManager.forceStopMacCompoundPush("manual");
      }
      return { success: true };
    });

    ipcMain.handle("set-main-window-interactivity", (event, shouldCapture) => {
      this.windowManager.setMainWindowInteractivity(Boolean(shouldCapture));
      return { success: true };
    });

    ipcMain.handle("get-main-window-horizontal-direction", () => {
      return this.windowManager.getMainWindowHorizontalDirection();
    });

    ipcMain.handle("set-notification-interactivity", (event, interactive) => {
      this.windowManager.setNotificationInteractivity(event.sender, Boolean(interactive));
      return { success: true };
    });

    ipcMain.handle("resize-main-window", (event, sizeKey) => {
      return this.windowManager.resizeMainWindow(sizeKey);
    });

    ipcMain.handle("resize-assistant-window-to-content", (event, surfaceHeight) => {
      return this.windowManager.resizeAssistantWindowToContent(surfaceHeight);
    });

    ipcMain.handle("resize-dictation-error-window-to-content", (event, surfaceHeight) => {
      return this.windowManager.resizeDictationErrorWindowToContent(surfaceHeight);
    });

    for (const k of BYOK_API_KEYS) {
      ipcMain.handle(`get-${k.base}-key`, () => this.environmentManager[k.get]());
      ipcMain.handle(`save-${k.base}-key`, (event, key) => this.environmentManager[k.save](key));
    }

    ipcMain.handle("db-save-transcription", async (event, text, rawText, options) => {
      const result = this.databaseManager.saveTranscription(text, rawText, options);
      if (result?.success && result?.transcription) {
        setImmediate(() => {
          broadcastToWindows("transcription-added", result.transcription);
        });
      }
      return result;
    });

    ipcMain.handle("db-get-transcriptions", async (event, limit = 50, options = {}) => {
      return this.databaseManager.getTranscriptions(limit, options);
    });

    ipcMain.handle("db-clear-transcriptions", async (event) => {
      this.audioStorageManager.deleteAllAudio();
      const result = this.databaseManager.clearTranscriptions();
      if (result?.success) {
        setImmediate(() => {
          broadcastToWindows("transcriptions-cleared", {
            cleared: result.cleared,
          });
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-transcription", async (event, id) => {
      return this.deleteTranscriptionInternal(id);
    });

    // Audio storage handlers
    ipcMain.handle("save-transcription-audio", async (event, id, audioBuffer, metadata) => {
      const transcription = this.databaseManager.getTranscriptionById(id);
      const timestamp = transcription?.timestamp || null;
      const result = this.audioStorageManager.saveAudio(id, Buffer.from(audioBuffer), timestamp);
      if (result.success) {
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 1,
          audioDurationMs: metadata?.durationMs || null,
          provider: metadata?.provider || null,
          model: metadata?.model || null,
        });
        const updated = this.databaseManager.getTranscriptionById(id);
        if (updated) broadcastToWindows("transcription-updated", updated);
      }
      return result;
    });

    ipcMain.handle("merge-audio-segments", async (_event, segments) => {
      try {
        if (!Array.isArray(segments) || segments.length < 2 || segments.length > 100) {
          throw new Error("Invalid audio segment count");
        }
        const normalized = segments.map((segment) => {
          if (!segment?.buffer || typeof segment.mimeType !== "string") {
            throw new Error("Invalid audio segment");
          }
          return { buffer: Buffer.from(segment.buffer), mimeType: segment.mimeType };
        });
        const { mergeAudioSegments } = require("./ffmpegUtils");
        const buffer = await mergeAudioSegments(normalized);
        // Slice to a real ArrayBuffer: Buffers sent over IPC arrive as Uint8Array,
        // and pooled Buffers share a larger underlying allocation.
        return {
          success: true,
          buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          mimeType: "audio/webm",
        };
      } catch (error) {
        debugLogger.error("Failed to merge recovered audio segments", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-audio-path", async (event, id) => {
      return this.audioStorageManager.getAudioPath(id);
    });

    ipcMain.handle("show-audio-in-folder", async (event, id) => {
      const filePath = this.audioStorageManager.getAudioPath(id);
      if (!filePath) return { success: false };
      shell.showItemInFolder(filePath);
      return { success: true };
    });

    ipcMain.handle("get-audio-buffer", async (event, id) => {
      const buffer = this.audioStorageManager.getAudioBuffer(id);
      return buffer ? buffer.buffer : null;
    });

    ipcMain.handle("delete-transcription-audio", async (event, id) => {
      const result = this.audioStorageManager.deleteAudio(id);
      if (result.success) {
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 0,
          audioDurationMs: null,
          provider: null,
          model: null,
        });
      }
      return result;
    });

    ipcMain.handle("get-audio-storage-usage", async () => {
      return this.audioStorageManager.getStorageUsage();
    });

    ipcMain.on(
      "retention-settings-changed",
      createRetentionSettingsHandler({
        getCurrentSettings: () => this._retentionSettings,
        getOwner: () => this.windowManager.mainWindow?.webContents,
        hasSynced: () => this._retentionSettingsSynced,
        onSettingsChanged: (settings) => {
          this._retentionSettings = settings;
          this._retentionSettingsSynced = true;
          this._runRetentionCleanup();
        },
      })
    );

    ipcMain.handle("delete-all-audio", async () => {
      const result = this.audioStorageManager.deleteAllAudio();
      try {
        const rows = this.databaseManager.db
          .prepare("SELECT id FROM transcriptions WHERE has_audio = 1")
          .all();
        if (rows.length > 0) {
          this.databaseManager.clearAudioFlags(rows.map((r) => r.id));
        }
      } catch (error) {
        debugLogger.error(
          "Failed to clear audio flags after delete-all",
          { error: error.message },
          "audio-storage"
        );
      }
      return result;
    });

    ipcMain.handle("get-transcription-by-id", async (event, id) => {
      return this.databaseManager.getTranscriptionById(id);
    });

    // Every window's AudioManager can hold the mic open outside a recording, so
    // gate the audio-evidence meeting detector until they all release. A
    // renderer that reloads or goes away releases implicitly — otherwise a
    // crash mid-hold would gate detection for the rest of the session.
    ipcMain.on("mic-warm-hold-changed", (event, active) => {
      if (!active) {
        this._releaseMicHold(event.sender);
        return;
      }
      if (this._micHoldSenders.has(event.sender.id)) return;
      const release = () => this._releaseMicHold(event.sender);
      this._micHoldSenders.set(event.sender.id, release);
      event.sender.on("destroyed", release);
      event.sender.on("did-finish-load", release);
      this.meetingDetectionEngine?.setMicWarmHold(true);
    });

    // Hotkey handlers run in main, while AudioManager owns the real lifecycle
    // in the dictation renderer. Only confirmed renderer state may change the
    // main-process recording gate; raw key presses are merely requests and can
    // be declined while a transcript is still being finalized.
    ipcMain.on("dictation-lifecycle-state-changed", (event, state, inputKind) => {
      const dictationWindow = this.windowManager.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return;
      }
      this.windowManager.setDictationLifecycleState(state, inputKind);
    });

    ipcMain.on("show-agent-dictation-final-transcript", (event, text) => {
      const dictationWindow = this.windowManager.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return;
      }
      if (typeof text !== "string" || !text.trim()) return;
      this.windowManager.showAgentDictationFinalTranscript(text);
    });

    ipcMain.on("dictation-audio-level-changed", (event, level) => {
      const dictationWindow = this.windowManager.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return;
      }
      this.windowManager.setDictationAudioLevel(level);
    });

    // Dictionary handlers
    ipcMain.on("auto-learn-changed", (_event, enabled) => {
      // Both renderer windows re-sync this on mount — ignore same-value updates (#1080).
      const { changed, enabled: next } = applyAutoLearnSetting(this._autoLearnEnabled, enabled);
      if (!changed) return;
      this._autoLearnEnabled = next;
      if (!this._autoLearnEnabled) {
        if (this._autoLearnDebounceTimer) {
          clearTimeout(this._autoLearnDebounceTimer);
          this._autoLearnDebounceTimer = null;
        }
        this._autoLearnLatestData = null;
      }
      debugLogger.debug("[AutoLearn] Setting changed", { enabled: this._autoLearnEnabled });
    });

    ipcMain.handle("db-get-dictionary", async () => {
      return this.databaseManager.getDictionary();
    });

    ipcMain.handle("db-set-dictionary", async (event, words) => {
      if (!Array.isArray(words)) {
        throw new Error("words must be an array");
      }
      return this.databaseManager.setDictionary(words);
    });

    ipcMain.handle("db-apply-dictionary-changes", async (_event, changes) => {
      const { add, remove } = changes ?? {};
      if (add !== undefined && !Array.isArray(add)) {
        throw new Error("add must be an array");
      }
      if (remove !== undefined && !Array.isArray(remove)) {
        throw new Error("remove must be an array");
      }
      return this.databaseManager.applyDictionaryChanges({ add, remove });
    });

    ipcMain.handle("db-get-pending-dictionary", async () => {
      return this.databaseManager.getPendingDictionary();
    });

    ipcMain.handle("db-get-pending-dictionary-deletes", async () => {
      return this.databaseManager.getPendingDictionaryDeletes();
    });

    ipcMain.handle("db-get-dictionary-by-client-id", async (_event, clientDictId) => {
      return this.databaseManager.getDictionaryEntryByClientId(clientDictId);
    });

    ipcMain.handle("db-upsert-dictionary-from-cloud", async (_event, cloudEntry) => {
      return this.databaseManager.upsertDictionaryFromCloud(cloudEntry);
    });

    ipcMain.handle("db-mark-dictionary-synced", async (_event, id, cloudId) => {
      return this.databaseManager.markDictionaryEntrySynced(id, cloudId);
    });

    ipcMain.handle("db-hard-delete-dictionary", async (_event, id) => {
      return this.databaseManager.hardDeleteDictionaryEntry(id);
    });

    ipcMain.handle("db-clear-dictionary-cloud-id", async (_event, id) => {
      return this.databaseManager.clearDictionaryCloudId(id);
    });

    ipcMain.handle("db-broadcast-dictionary-updated", async () => {
      // Emit the normalized list straight from SQLite so renderers see the
      // post-dedupe truth, never a caller-supplied payload.
      const words = this.databaseManager.getDictionary();
      broadcastToWindows("dictionary-updated", words);
      return { success: true };
    });

    ipcMain.handle("db-get-snippets", async () => {
      return this.databaseManager.getSnippets();
    });

    ipcMain.handle("db-set-snippets", async (_event, snippets) => {
      if (!Array.isArray(snippets)) {
        throw new Error("snippets must be an array");
      }
      return this.databaseManager.setSnippets(snippets);
    });

    ipcMain.handle("db-get-pending-snippets", async () => {
      return this.databaseManager.getPendingSnippets();
    });

    ipcMain.handle("db-get-pending-snippet-deletes", async () => {
      return this.databaseManager.getPendingSnippetDeletes();
    });

    ipcMain.handle("db-get-snippet-for-cloud-merge", async (_event, cloudEntry) => {
      return this.databaseManager.getSnippetForCloudMerge(cloudEntry);
    });

    ipcMain.handle("db-upsert-snippet-from-cloud", async (_event, cloudEntry) => {
      return this.databaseManager.upsertSnippetFromCloud(cloudEntry);
    });

    ipcMain.handle(
      "db-mark-snippet-synced",
      async (_event, id, cloudId, serverUpdatedAt, expectedTrigger, expectedReplacement) => {
        return this.databaseManager.markSnippetSynced(
          id,
          cloudId,
          serverUpdatedAt,
          expectedTrigger,
          expectedReplacement
        );
      }
    );

    ipcMain.handle("db-hard-delete-snippet", async (_event, id) => {
      return this.databaseManager.hardDeleteSnippet(id);
    });

    ipcMain.handle("db-clear-snippet-cloud-id", async (_event, id) => {
      return this.databaseManager.clearSnippetCloudId(id);
    });

    ipcMain.handle("db-broadcast-snippets-updated", async () => {
      const snippets = this.databaseManager.getSnippets();
      broadcastToWindows("snippets-updated", snippets);
      return { success: true };
    });

    ipcMain.handle("undo-learned-corrections", async (_event, words) => {
      try {
        if (!Array.isArray(words) || words.length === 0) {
          return { success: false };
        }
        const validWords = words.filter((w) => typeof w === "string" && w.trim().length > 0);
        if (validWords.length === 0) {
          return { success: false };
        }
        const saveResult = this.databaseManager.applyDictionaryChanges({ remove: validWords });
        if (saveResult?.success === false) {
          debugLogger.debug("[AutoLearn] Undo failed to save dictionary", {
            error: saveResult.error,
          });
          return { success: false };
        }
        broadcastToWindows("dictionary-updated", this.databaseManager.getDictionary());
        debugLogger.debug("[AutoLearn] Undo: removed words", { words: validWords });
        return { success: true };
      } catch (err) {
        debugLogger.debug("[AutoLearn] Undo failed", { error: err.message });
        return { success: false };
      }
    });

    ipcMain.handle(
      "db-save-note",
      async (event, title, content, noteType, sourceFile, audioDuration, folderId, spaceId) => {
        const result = this.databaseManager.saveNote(
          title,
          content,
          noteType,
          sourceFile,
          audioDuration,
          folderId,
          spaceId
        );
        if (result?.success && result?.note) {
          setImmediate(() => broadcastToWindows("note-added", result.note));
          this._asyncVectorUpsert(result.note);
          this._asyncMirrorWrite(result.note);
        }
        return result;
      }
    );

    ipcMain.handle("db-get-note", async (event, id) => {
      return this.databaseManager.getNote(id);
    });

    ipcMain.handle("db-get-notes", async (event, noteType, limit, folderId, spaceId) => {
      return this.databaseManager.getNotes(noteType, limit, folderId, spaceId);
    });

    ipcMain.handle("db-get-space-notes", async (event, spaceId, limit) => {
      return this.databaseManager.getNotesForSpace(spaceId, limit);
    });

    ipcMain.handle("db-update-note", async (event, id, updates) => {
      const result = this.databaseManager.updateNote(id, updates);
      if (result?.success && result?.note) {
        setImmediate(() => broadcastToWindows("note-updated", result.note));
        this._asyncVectorUpsert(result.note);
        this._asyncMirrorWrite(result.note);
        if (updates.participants) {
          this._tryAutoLabelOneOnOne(id);
          this._refreshMeetingSpeakerConfigFromNote(id, result.note);
        }
      }
      return result;
    });

    ipcMain.handle("db-delete-note", async (event, id) => {
      return this.deleteNoteInternal(id);
    });

    ipcMain.handle("db-search-notes", async (event, query, limit, spaceId, folderId) => {
      return this.databaseManager.searchNotes(query, limit, spaceId, folderId);
    });

    ipcMain.handle(
      "db-semantic-search-notes",
      async (event, query, limit = 5, spaceId, folderId) => {
        const vectorIndex = require("./vectorIndex");
        if (!vectorIndex.isReady()) {
          return this.databaseManager.searchNotes(query, limit, spaceId, folderId);
        }

        try {
          // Qdrant payload updates are best-effort. Use its space filter to
          // reduce the candidate set, then validate every scoped vector hit
          // against SQLite before it can enter the fused ranking.
          const overFetch = folderId != null ? limit * 4 : limit * 2;
          const vectorFilter =
            spaceId != null
              ? { must: [{ key: "space_id", match: { value: spaceId } }] }
              : undefined;
          const [ftsResults, vectorResults] = await Promise.all([
            this.databaseManager.searchNotes(query, overFetch, spaceId, folderId),
            vectorIndex.search(query, overFetch, vectorFilter),
          ]);
          const scopedIds = new Set(
            this.databaseManager.getNoteIdsInScope(
              spaceId,
              folderId,
              vectorResults.map(({ noteId }) => noteId)
            )
          );

          // Filter low-confidence semantic matches before RRF
          const filteredVectorResults = vectorResults.filter(
            ({ noteId, score }) => score > 0.3 && scopedIds.has(noteId)
          );

          // Reciprocal Rank Fusion (K=60, matching cloud implementation)
          const scores = new Map();
          ftsResults.forEach((note, i) => {
            scores.set(note.id, (scores.get(note.id) || 0) + 1 / (60 + i));
          });
          filteredVectorResults.forEach(({ noteId }, i) => {
            scores.set(noteId, (scores.get(noteId) || 0) + 1 / (60 + i));
          });

          const rankedIds = [...scores.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([id]) => id);

          const noteMap = new Map();
          ftsResults.forEach((n) => noteMap.set(n.id, n));
          for (const id of rankedIds) {
            if (!noteMap.has(id)) {
              const note = this.databaseManager.getNote(id);
              if (note) noteMap.set(id, note);
            }
          }

          return rankedIds.map((id) => noteMap.get(id)).filter(Boolean);
        } catch (error) {
          debugLogger.error("Semantic search failed, falling back to FTS5", {
            error: error.message,
          });
          return this.databaseManager.searchNotes(query, limit, spaceId, folderId);
        }
      }
    );

    ipcMain.handle("db-semantic-reindex-all", async () => {
      const vectorIndex = require("./vectorIndex");
      if (!vectorIndex.isReady()) return { success: false, error: "Vector index not ready" };

      const notes = this.databaseManager.getNotes(null, 100000);
      let done = 0;
      const { failed } = await vectorIndex.reindexAll(notes, (completed, total) => {
        done = completed;
        broadcastToWindows("semantic-reindex-progress", { done: completed, total });
      });
      // Report failed batches so callers only latch their done-flag on a clean pass.
      return { success: failed === 0, indexed: done - failed };
    });

    ipcMain.handle("db-update-note-cloud-id", async (event, id, cloudId) => {
      return this.databaseManager.updateNoteCloudId(id, cloudId);
    });

    ipcMain.handle("db-update-note-share-state", async (event, id, state) => {
      const note = this.databaseManager.updateNoteShareState(id, state);
      if (note) {
        setImmediate(() => broadcastToWindows("note-updated", note));
      }
      return note;
    });

    ipcMain.handle("db-get-folders", async (event, spaceId) => {
      return this.databaseManager.getFolders(spaceId);
    });

    ipcMain.handle("db-create-folder", async (event, name, spaceId) => {
      const result = this.databaseManager.createFolder(name, spaceId);
      if (result?.success && result?.folder) {
        setImmediate(() => {
          broadcastToWindows("folder-created", result.folder);
          if (this._noteFilesEnabled) {
            const markdownMirror = require("./markdownMirror");
            markdownMirror.ensureFolder(result.folder.name);
          }
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-folder", async (event, id) => {
      const folderName = this._noteFilesEnabled ? this._getFolderName(id) : null;
      const result = this.databaseManager.deleteFolder(id);
      if (result?.success) {
        for (const noteId of result.noteIds ?? []) {
          this._asyncVectorDelete(noteId);
        }
        // Other accounts' notes were released to the space root; their mirror
        // files leave with the folder directory, so rewrite the live ones.
        for (const note of result.relocatedNotes ?? []) {
          if (!note.deleted_at) this._asyncMirrorWrite(note);
        }
        setImmediate(() => {
          broadcastToWindows("folder-deleted", { id });
          if (folderName) this._mirrorDeleteFolderIfUnshared(folderName);
        });
      }
      return result;
    });

    ipcMain.handle("db-rename-folder", async (event, id, name) => {
      const oldName = this._noteFilesEnabled ? this._getFolderName(id) : null;
      const result = this.databaseManager.renameFolder(id, name);
      if (result?.success && result?.folder) {
        setImmediate(() => {
          broadcastToWindows("folder-renamed", result.folder);
          if (this._noteFilesEnabled && oldName) {
            const markdownMirror = require("./markdownMirror");
            markdownMirror.renameFolder(oldName, name);
          }
        });
      }
      return result;
    });

    ipcMain.handle("db-move-folder-to-space", async (event, id, spaceId) => {
      const result = this.databaseManager.moveFolderToSpace(id, spaceId);
      if (result?.success) {
        // Qdrant payloads carry space_id — refresh the moved notes' vectors.
        for (const note of result.notes ?? []) {
          this._asyncVectorUpsert(note);
        }
        if (result.folder) {
          setImmediate(() => broadcastToWindows("folder-synced", result.folder));
        }
      }
      return result;
    });

    ipcMain.handle("db-get-folder-note-counts", async () => {
      return this.databaseManager.getFolderNoteCounts();
    });

    ipcMain.handle("db-get-spaces", async () => {
      return this.databaseManager.getSpaces();
    });

    ipcMain.handle("set-active-account-scope", async (_event, accountId, expectedGeneration) => {
      const state = tokenStore.getState();
      const verdict = accountScopeBinding.evaluateScopeRequest({
        accountId,
        expectedGeneration,
        token: state.token,
        generation: state.generation,
      });
      if (!verdict.ok) {
        return {
          success: false,
          code: verdict.code,
          error:
            verdict.code === "INVALID_ACCOUNT"
              ? "Invalid account scope"
              : "Authentication context changed before account scoping",
        };
      }
      this.databaseManager.setActiveAccountId(accountId);
      if (accountId !== null) accountScopeBinding.persist(accountId, state.token);
      else accountScopeBinding.clear();
      return { success: true };
    });

    ipcMain.handle("delete-account-data", async (_event, accountId, expectedGeneration) => {
      const state = tokenStore.getState();
      if (
        typeof accountId !== "string" ||
        accountId.trim().length === 0 ||
        !state.token ||
        state.generation !== expectedGeneration
      ) {
        return {
          success: false,
          code: "AUTH_CONTEXT_CHANGED",
          error: "Authentication context changed before local account cleanup",
        };
      }
      try {
        const result = this.databaseManager.deleteAccountData(accountId);
        for (const noteId of result.deletedNoteIds) {
          this._asyncVectorDelete(noteId);
          this._asyncMirrorDelete(noteId);
        }
        return { success: true, ...result };
      } catch (error) {
        return { success: false, code: "LOCAL_ACCOUNT_CLEANUP_FAILED", error: error.message };
      }
    });

    ipcMain.handle("db-update-space", async (event, id, updates) => {
      const result = this.databaseManager.updateSpace(id, updates);
      if (result?.success && result.space) {
        setImmediate(() => broadcastToWindows("space-synced", result.space));
      }
      return result;
    });

    ipcMain.handle("db-purge-space", async (event, id, options) => {
      if (options?.expectedAuthGeneration !== undefined) {
        const state = tokenStore.getState();
        if (!state.token || state.generation !== options.expectedAuthGeneration) {
          return {
            success: false,
            error: "Authentication context changed before account cleanup",
            code: "AUTH_CONTEXT_CHANGED",
          };
        }
      }
      const result = this.databaseManager.purgeSpace(id, options);
      if (result?.success) {
        if (!result.preservedForOtherAccounts) {
          this.databaseManager.addPendingVectorPurge(result.spaceId);
          this.drainPendingVectorPurges();
          for (const note of result.relocatedNotes ?? []) {
            this._asyncVectorUpsert(note);
            this._asyncMirrorWrite(note);
          }
          for (const noteId of result.noteIds ?? []) {
            this._asyncMirrorDelete(noteId);
          }
        }
        setImmediate(() => {
          broadcastToWindows("space-purged", { spaceId: result.spaceId });
          for (const folderName of result.folderNames ?? []) {
            this._mirrorDeleteFolderIfUnshared(folderName);
          }
        });
      }
      return result;
    });

    ipcMain.handle("db-get-actions", async () => {
      return this.databaseManager.getActions();
    });

    ipcMain.handle("db-get-action", async (event, id) => {
      return this.databaseManager.getAction(id);
    });

    ipcMain.handle("db-create-action", async (event, name, description, prompt, icon) => {
      const result = this.databaseManager.createAction(name, description, prompt, icon);
      if (result?.success && result?.action) {
        setImmediate(() => {
          broadcastToWindows("action-created", result.action);
        });
      }
      return result;
    });

    ipcMain.handle("db-update-action", async (event, id, updates) => {
      const result = this.databaseManager.updateAction(id, updates);
      if (result?.success && result?.action) {
        setImmediate(() => {
          broadcastToWindows("action-updated", result.action);
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-action", async (event, id) => {
      const result = this.databaseManager.deleteAction(id);
      if (result?.success) {
        setImmediate(() => {
          broadcastToWindows("action-deleted", { id });
        });
      }
      return result;
    });

    // Agent conversation handlers
    ipcMain.handle(
      "db-create-agent-conversation",
      async (event, title, noteId, spaceId, folderId) => {
        return this.databaseManager.createAgentConversation(title, noteId, spaceId, folderId);
      }
    );

    ipcMain.handle("db-get-conversations-for-note", async (event, noteId, limit) => {
      return this.databaseManager.getConversationsForNote(noteId, limit);
    });

    ipcMain.handle(
      "db-get-conversations-for-container",
      async (event, spaceId, folderId, limit) => {
        return this.databaseManager.getConversationsForContainer(spaceId, folderId, limit);
      }
    );

    ipcMain.handle("db-get-agent-conversations", async (event, limit) => {
      return this.databaseManager.getAgentConversations(limit);
    });

    ipcMain.handle("db-get-agent-conversation", async (event, id) => {
      return this.databaseManager.getAgentConversation(id);
    });

    ipcMain.handle("db-delete-agent-conversation", async (event, id) => {
      const result = this.databaseManager.deleteAgentConversation(id);
      if (this.vectorIndex?.isReady?.()) {
        this.vectorIndex.deleteConversationChunks(id).catch(() => {});
      }
      return result;
    });

    ipcMain.handle("db-update-agent-conversation-title", async (event, id, title) => {
      return this.databaseManager.updateAgentConversationTitle(id, title);
    });

    ipcMain.handle(
      "db-add-agent-message",
      async (event, conversationId, role, content, metadata) => {
        const result = this.databaseManager.addAgentMessage(
          conversationId,
          role,
          content,
          metadata
        );
        if (result && this.vectorIndex?.isReady?.()) {
          const conv = this.databaseManager.getAgentConversation(conversationId);
          if (conv && conv.messages?.length % 3 === 0) {
            this.vectorIndex
              .upsertConversationChunks(conversationId, conv.title, conv.messages)
              .catch(() => {});
          }
        }
        return result;
      }
    );

    ipcMain.handle("db-get-agent-messages", async (event, conversationId) => {
      return this.databaseManager.getAgentMessages(conversationId);
    });

    ipcMain.handle(
      "db-get-agent-conversations-with-preview",
      async (event, limit, offset, includeArchived) => {
        return this.databaseManager.getAgentConversationsWithPreview(
          limit,
          offset,
          includeArchived
        );
      }
    );

    ipcMain.handle("db-search-agent-conversations", async (event, query, limit) => {
      return this.databaseManager.searchAgentConversations(query, limit);
    });

    ipcMain.handle("db-archive-agent-conversation", async (event, id) => {
      return this.databaseManager.archiveAgentConversation(id);
    });

    ipcMain.handle("db-unarchive-agent-conversation", async (event, id) => {
      return this.databaseManager.unarchiveAgentConversation(id);
    });

    ipcMain.handle("db-update-agent-conversation-cloud-id", async (event, id, cloudId) => {
      return this.databaseManager.updateAgentConversationCloudId(id, cloudId);
    });

    ipcMain.handle("db-semantic-search-conversations", async (event, query, limit) => {
      if (this.vectorIndex?.isReady?.()) {
        try {
          const vectorResults = await this.vectorIndex.searchConversations(query, limit);
          if (vectorResults?.length > 0) {
            const ids = vectorResults.map((r) => r.conversationId);
            const previews = ids
              .map((id) => this.databaseManager.getAgentConversation(id))
              .filter(Boolean)
              .map((c) => ({
                ...c,
                message_count: c.messages?.length ?? 0,
                last_message: c.messages?.[c.messages.length - 1]?.content,
              }));
            if (previews.length > 0) return previews;
          }
        } catch {
          // fall through to keyword search
        }
      }
      return this.databaseManager.searchAgentConversations(query, limit);
    });

    // Notes sync
    ipcMain.handle("db-get-pending-notes", (_, spaceKind) =>
      this.databaseManager.getPendingNotes(spaceKind)
    );
    ipcMain.handle("db-get-pending-note-deletes", () =>
      this.databaseManager.getPendingNoteDeletes()
    );
    ipcMain.handle("db-get-note-by-client-id", (_, clientNoteId) =>
      this.databaseManager.getNoteByClientId(clientNoteId)
    );
    ipcMain.handle("db-upsert-note-from-cloud", (_, cloudNote, localFolderId, localSpaceId) => {
      const note = this.databaseManager.upsertNoteFromCloud(cloudNote, localFolderId, localSpaceId);
      if (note) {
        setImmediate(() => broadcastToWindows("note-synced", note));
        this._asyncVectorUpsert(note);
      }
      return note;
    });
    ipcMain.handle(
      "db-acknowledge-note-create",
      (_, id, snapshot, cloudId, cloudUpdatedAt, ownerUserId, settleIfUnchanged) =>
        this.databaseManager.acknowledgeNoteCreate(
          id,
          snapshot,
          cloudId,
          cloudUpdatedAt,
          ownerUserId,
          settleIfUnchanged
        )
    );
    ipcMain.handle(
      "db-mark-note-synced-if-unchanged",
      (_, id, snapshot, expectedCloudId, cloudUpdatedAt, ownerUserId) =>
        this.databaseManager.markNoteSyncedIfUnchanged(
          id,
          snapshot,
          expectedCloudId,
          cloudUpdatedAt,
          ownerUserId
        )
    );
    ipcMain.handle("db-set-note-cloud-base", (_, id, cloudUpdatedAt) =>
      this.databaseManager.setNoteCloudBase(id, cloudUpdatedAt)
    );
    ipcMain.handle("db-set-note-owner-from-cloud", (_, id, ownerUserId) =>
      this.databaseManager.setNoteOwnerFromCloud(id, ownerUserId)
    );
    ipcMain.handle("db-count-team-notes-missing-owner", () =>
      this.databaseManager.countTeamNotesMissingOwner()
    );
    ipcMain.handle("db-mark-note-sync-error", (_, id) =>
      this.databaseManager.markNoteSyncError(id)
    );
    ipcMain.handle("db-restore-note-after-denied-delete", (_, id) =>
      this.databaseManager.restoreNoteAfterDeniedDelete(id)
    );
    ipcMain.handle("db-hard-delete-note", (_, id) => {
      const result = this.databaseManager.hardDeleteNote(id);
      if (result?.success) {
        this._asyncVectorDelete(id);
        this._asyncMirrorDelete(id);
        setImmediate(() => broadcastToWindows("note-deleted", { id }));
      }
      return result;
    });

    // Folders sync
    ipcMain.handle("db-get-pending-folders", (_, spaceKind) =>
      this.databaseManager.getPendingFolders(spaceKind)
    );
    ipcMain.handle("db-get-folder-by-client-id", (_, clientFolderId) =>
      this.databaseManager.getFolderByClientId(clientFolderId)
    );
    ipcMain.handle("db-upsert-folder-from-cloud", (_, cloudFolder, localSpaceId) => {
      const folder = this.databaseManager.upsertFolderFromCloud(cloudFolder, localSpaceId);
      if (folder) setImmediate(() => broadcastToWindows("folder-synced", folder));
      return folder;
    });
    ipcMain.handle(
      "db-acknowledge-folder-create",
      (_, id, snapshot, expectedCloudId, responseClientFolderId, cloudId, cloudUpdatedAt) =>
        this.databaseManager.acknowledgeFolderCreate(
          id,
          snapshot,
          expectedCloudId,
          responseClientFolderId,
          cloudId,
          cloudUpdatedAt
        )
    );
    ipcMain.handle("db-mark-folder-synced-if-unchanged", (_, id, snapshot, expectedCloudId) =>
      this.databaseManager.markFolderSyncedIfUnchanged(id, snapshot, expectedCloudId)
    );
    ipcMain.handle("db-get-folder-id-map", () => this.databaseManager.getFolderIdMap());
    ipcMain.handle("db-get-pending-folder-deletes", () =>
      this.databaseManager.getPendingFolderDeletes()
    );
    ipcMain.handle("db-restore-folder-after-denied-delete", (_, id) => {
      const result = this.databaseManager.restoreFolderAfterDeniedDelete(id);
      if (result?.success) {
        for (const note of result.notes ?? []) {
          this._asyncVectorUpsert(note);
          this._asyncMirrorWrite(note);
        }
        setImmediate(() => {
          if (result.folder) broadcastToWindows("folder-synced", result.folder);
          for (const note of result.notes ?? []) {
            broadcastToWindows("note-synced", note);
          }
        });
      }
      return result;
    });
    ipcMain.handle("db-hard-delete-folder", (_, id) => {
      const result = this.databaseManager.hardDeleteFolder(id);
      if (result?.success) {
        for (const noteId of result.noteIds ?? []) {
          this._asyncVectorDelete(noteId);
        }
        // Other accounts' notes were released to the space root; their mirror
        // files leave with the folder directory, so rewrite the live ones.
        for (const note of result.relocatedNotes ?? []) {
          if (!note.deleted_at) this._asyncMirrorWrite(note);
        }
        setImmediate(() => {
          broadcastToWindows("folder-deleted", { id });
          if (result.name) this._mirrorDeleteFolderIfUnshared(result.name);
        });
      }
      return result;
    });
    ipcMain.handle("db-relocate-revoked-folder", (_, id, privateSpaceId, preserveFolder) => {
      const result = this.databaseManager.relocateRevokedFolder(id, privateSpaceId, preserveFolder);
      if (result?.success) {
        // Qdrant payloads carry space_id and the markdown mirror files by
        // folder — refresh relocated notes, drop the server-owned ones.
        for (const note of result.relocatedNotes ?? []) {
          this._asyncVectorUpsert(note);
          this._asyncMirrorWrite(note);
        }
        for (const noteId of result.deletedNoteIds ?? []) {
          this._asyncVectorDelete(noteId);
          this._asyncMirrorDelete(noteId);
        }
        setImmediate(() => {
          if (result.folder) broadcastToWindows("folder-synced", result.folder);
          else broadcastToWindows("folder-deleted", { id });
          for (const note of result.relocatedNotes ?? []) {
            broadcastToWindows("note-updated", note);
          }
          for (const noteId of result.deletedNoteIds ?? []) {
            broadcastToWindows("note-deleted", { id: noteId });
          }
          const folderGone = !result.folder || result.folder.name !== result.folderName;
          if (result.folderName && folderGone) {
            this._mirrorDeleteFolderIfUnshared(result.folderName);
          }
        });
      }
      return result;
    });

    // Renderer-side sync events (conflicts, revocation toasts, …) happen in
    // whichever window ran the pass — rebroadcast them to ALL windows.
    ipcMain.handle("broadcast-sync-event", (_, name, payload) => {
      broadcastToWindows("sync-event", { name, payload });
      return { success: true };
    });

    // Spaces sync
    ipcMain.handle("db-upsert-space-from-cloud", (_, cloudSpace) => {
      const space = this.databaseManager.upsertSpaceFromCloud(cloudSpace);
      if (space) setImmediate(() => broadcastToWindows("space-synced", space));
      return space;
    });
    ipcMain.handle("db-set-space-sync-status", (_, id, status) => {
      const result = this.databaseManager.setSpaceSyncStatus(id, status);
      if (result?.success && result.space) {
        // Live skeleton toggling: the tree keys pending/synced off this flag.
        setImmediate(() => broadcastToWindows("space-synced", result.space));
      }
      return result;
    });

    // Conversations sync
    ipcMain.handle("db-get-pending-conversations", () =>
      this.databaseManager.getPendingConversations()
    );
    ipcMain.handle("db-get-pending-conversation-deletes", () =>
      this.databaseManager.getPendingConversationDeletes()
    );
    ipcMain.handle("db-get-conversation-by-client-id", (_, clientId) =>
      this.databaseManager.getConversationByClientId(clientId)
    );
    ipcMain.handle("db-upsert-conversation-from-cloud", (_, cloudConv, messages) =>
      this.databaseManager.upsertConversationFromCloud(cloudConv, messages)
    );
    ipcMain.handle("db-acknowledge-conversation-create", (_, id, snapshot, cloudId) =>
      this.databaseManager.acknowledgeConversationCreate(id, snapshot, cloudId)
    );
    ipcMain.handle("db-mark-conversation-synced", (_, id, cloudId) =>
      this.databaseManager.markConversationSynced(id, cloudId)
    );
    ipcMain.handle("db-hard-delete-conversation", (_, id) => {
      const result = this.databaseManager.hardDeleteConversation(id);
      if (result?.success) {
        setImmediate(() => broadcastToWindows("conversation-deleted", { id }));
      }
      return result;
    });

    // Transcriptions sync
    ipcMain.handle("db-get-pending-transcriptions", () =>
      this.databaseManager.getPendingTranscriptions()
    );
    ipcMain.handle("db-get-transcription-by-client-id", (_, clientId) =>
      this.databaseManager.getTranscriptionByClientId(clientId)
    );
    ipcMain.handle("db-upsert-transcription-from-cloud", (_, cloudTranscription) =>
      this.databaseManager.upsertTranscriptionFromCloud(cloudTranscription)
    );
    ipcMain.handle("db-mark-transcription-synced", (_, id, cloudId) =>
      this.databaseManager.markTranscriptionSynced(id, cloudId)
    );
    ipcMain.handle("db-get-pending-transcription-deletes", () =>
      this.databaseManager.getPendingTranscriptionDeletes()
    );
    ipcMain.handle("db-hard-delete-transcription", (_, id) => {
      const result = this.databaseManager.hardDeleteTranscription(id);
      if (result?.success) {
        setImmediate(() => broadcastToWindows("transcription-deleted", { id }));
      }
      return result;
    });

    ipcMain.handle("export-note", async (event, noteId, format) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const { dialog } = require("electron");
        const fs = require("fs");
        const ext = format === "txt" ? "txt" : "md";
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${ext}`,
          filters: [
            { name: "Markdown", extensions: ["md"] },
            { name: "Text", extensions: ["txt"] },
          ],
        });

        if (result.canceled || !result.filePath) return { success: false };

        let exportContent;
        if (format === "txt") {
          exportContent = (note.content || "")
            .replace(/#{1,6}\s+/g, "")
            .replace(/[*_~`]+/g, "")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
            .replace(/^>\s+/gm, "")
            .trim();
        } else {
          exportContent = note.enhanced_content || note.content;
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting note", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("export-transcript", async (event, noteId, format) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const segments = JSON.parse(note.transcript || "[]");
        if (!segments.length) return { success: false, error: "No transcript available" };

        const speakerMappings = this._buildSpeakerMappings(noteId);

        const { dialog } = require("electron");
        const fs = require("fs");
        const extMap = { srt: "srt", json: "json", md: "md" };
        const ext = extMap[format] || "txt";
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${ext}`,
          filters: [
            { name: "Text", extensions: ["txt"] },
            { name: "SubRip Subtitles", extensions: ["srt"] },
            { name: "JSON", extensions: ["json"] },
            { name: "Markdown", extensions: ["md"] },
          ],
        });

        if (result.canceled || !result.filePath) return { success: false };

        const transcriptFormatter = require("./transcriptFormatter");
        let exportContent;
        if (format === "txt") {
          exportContent = transcriptFormatter.formatTxt(note, segments, speakerMappings);
        } else if (format === "srt") {
          exportContent = transcriptFormatter.formatSrt(segments, speakerMappings, note);
        } else if (format === "md") {
          exportContent = transcriptFormatter.formatMd(note, segments, speakerMappings);
        } else {
          exportContent = transcriptFormatter.formatJson(note, segments, speakerMappings);
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting transcript", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("export-dictionary", async (event, words) => {
      try {
        const { dialog } = require("electron");
        const fs = require("fs");

        const result = await dialog.showSaveDialog({
          defaultPath: "dictionary.txt",
          filters: [{ name: "Text", extensions: ["txt"] }],
        });

        if (result.canceled || !result.filePath) return { success: false };

        fs.writeFileSync(result.filePath, words.join("\n"), "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting dictionary", { error: error.message }, "dictionary");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("select-audio-file", async (event, options = {}) => {
      const { dialog } = require("electron");
      const properties = ["openFile"];
      if (options.multiple === true) properties.push("multiSelections");
      const result = await dialog.showOpenDialog({
        properties,
        filters: [
          {
            name: "Audio Files",
            extensions: ["mp3", "wav", "m4a", "webm", "ogg", "oga", "flac", "aac", "opus"],
          },
        ],
      });
      if (result.canceled || !result.filePaths.length) {
        return { canceled: true };
      }
      result.filePaths.forEach(approveAudioPath);
      if (options.multiple === true) {
        return { canceled: false, filePaths: result.filePaths };
      }
      return { canceled: false, filePath: result.filePaths[0] };
    });

    // Fired by the preload's getPathForFile for real drag-dropped files; a
    // renderer-constructed File yields "" there, so this can't be forged.
    ipcMain.on("approve-audio-path", (_event, filePath) => {
      approveAudioPath(filePath);
    });

    ipcMain.handle("get-file-size", async (_event, filePath) => {
      const fs = require("fs");
      try {
        if (typeof filePath !== "string") return 0;
        const real = resolveAllowedAudioPath(filePath);
        if (!real) return 0;
        const stats = fs.statSync(real);
        return stats.size;
      } catch {
        return 0;
      }
    });

    const activeUrlDownloads = new Map();
    let urlDownloadSeq = 0;

    // Sweep ow-url-*/ow-diarize-* orphans from crashes or windows closed mid-download.
    require("./urlAudioDownloader").sweepStaleTempArtifacts();

    ipcMain.handle("download-url-audio", async (event, url, downloadId) => {
      if (typeof url !== "string" || url.length > 2048) {
        return { success: false, error: "Invalid URL", code: "INVALID_URL" };
      }
      const { download } = require("./urlAudioDownloader");

      const id =
        typeof downloadId === "string" && downloadId ? downloadId : `dl-${++urlDownloadSeq}`;
      const abortController = new AbortController();
      activeUrlDownloads.set(id, abortController);

      try {
        const result = await download(
          url,
          (progress) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("url-download-progress", { ...progress, downloadId: id });
            }
          },
          abortController.signal
        );
        return { success: true, ...result };
      } catch (error) {
        debugLogger.error("URL audio download error", { error: error.message, code: error.code });
        return { success: false, error: error.message, code: error.code || "DOWNLOAD_FAILED" };
      } finally {
        if (activeUrlDownloads.get(id) === abortController) {
          activeUrlDownloads.delete(id);
        }
      }
    });

    // With an id, cancels that download; without, cancels all (unmount cleanup).
    ipcMain.handle("cancel-url-download", async (_event, downloadId) => {
      if (typeof downloadId === "string" && downloadId) {
        const controller = activeUrlDownloads.get(downloadId);
        if (!controller) return { success: false };
        controller.abort();
        activeUrlDownloads.delete(downloadId);
        return { success: true };
      }
      if (activeUrlDownloads.size === 0) return { success: false };
      for (const controller of activeUrlDownloads.values()) controller.abort();
      activeUrlDownloads.clear();
      return { success: true };
    });

    ipcMain.handle("delete-temp-file", async (event, filePath) => {
      try {
        if (typeof filePath !== "string") {
          return { success: false, error: "Invalid file path" };
        }
        const { getSafeTempDir } = require("./safeTempDir");
        const resolved = path.resolve(filePath);
        const basename = path.basename(resolved);
        if (!basename.startsWith("ow-url-") && !basename.startsWith("ow-diarize-")) {
          return { success: false, error: "Not an OpenWhispr temp file" };
        }
        const real = fs.realpathSync(resolved);
        let tempDir = getSafeTempDir();
        try {
          tempDir = fs.realpathSync(tempDir);
        } catch {}
        const rel = path.relative(tempDir, real);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return { success: false, error: "Not an OpenWhispr temp file" };
        }
        fs.unlinkSync(real);
        return { success: true };
      } catch (error) {
        debugLogger.warn("Failed to delete temp file", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("transcribe-audio-file", async (event, filePath, options = {}) => {
      const fs = require("fs");
      // Uploads pass a requestId so cancel-upload-transcription can abort the
      // local decode; flows without one (voice drafts) register nothing.
      const { signal, release } = this._uploadCancelRegistry.register(options.requestId);
      try {
        if (typeof filePath !== "string") {
          return { success: false, error: "Invalid file path" };
        }
        const real = resolveAllowedAudioPath(filePath);
        if (!real) return { success: false, error: "File path not allowed" };
        const audioBuffer = fs.readFileSync(real);
        if (isSherpaLocalProvider(options.provider)) {
          const result = await this.parakeetManager.transcribeLocalParakeet(audioBuffer, {
            ...options,
            signal,
          });
          return result;
        }
        const vadOptions = this._resolveWhisperVadOptions("noteRecording");
        const result = await this.whisperManager.transcribeLocalWhisper(audioBuffer, {
          ...options,
          ...vadOptions,
          signal,
        });
        return result;
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) {
          debugLogger.debug("Local audio file transcription cancelled", {
            requestId: options.requestId,
          });
          return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
        }
        debugLogger.error("Audio file transcription error", { error: error.message });
        return { success: false, error: error.message };
      } finally {
        release();
      }
    });

    ipcMain.handle("capture-selected-text", async (event, options = {}) => {
      if (!this.selectionManager) {
        return { status: "unavailable", code: "selection_manager_unavailable" };
      }
      return this.selectionManager.captureSelectedText({
        probeEditable: options.probeEditable === true,
      });
    });

    ipcMain.handle("replace-selected-text", async (event, sessionId, text, options = {}) => {
      if (!this.selectionManager) {
        return { success: false, code: "selection_manager_unavailable" };
      }
      return this.selectionManager.replaceSelectedText(sessionId, text, {
        restoreClipboard: options.restoreClipboard !== false,
        allowClipboardFallback: options.allowClipboardFallback === true,
        webContents: event.sender,
      });
    });

    ipcMain.handle("paste-at-captured-target", async (event, sessionId, text, options = {}) => {
      if (!this.selectionManager) {
        return { success: false, code: "selection_manager_unavailable" };
      }
      return this.selectionManager.pasteAtCapturedTarget(sessionId, text, {
        restoreClipboard: options.restoreClipboard !== false,
        allowClipboardFallback: options.allowClipboardFallback === true,
        webContents: event.sender,
      });
    });

    ipcMain.handle("paste-text", async (event, text, options) => {
      // An onboarding demo already puts the transcript in its own textarea from
      // the demo event, and that textarea is what has focus — pasting on top of
      // it appends the same sentence a second time. This is a successful no-op,
      // not a completed paste, so callers can avoid reporting paste-dependent
      // fallbacks as if text reached another application.
      if (this.windowManager?.isOnboardingDemoActive()) {
        return { success: true, pasted: false };
      }

      const mainWindow = this.windowManager?.mainWindow;
      const targetPid = this.textEditMonitor?.lastTargetPid || null;

      // Activating the target by PID is more reliable than hide()'s implicit
      // focus hand-off for Chromium apps like Claude desktop and Brave (#668).
      let activated = false;
      if (process.platform === "darwin" && this.textEditMonitor) {
        activated = await this.textEditMonitor.activateTargetPid();
      }

      if (!activated && mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
        if (process.platform === "darwin") {
          mainWindow.hide();
          await new Promise((resolve) => setTimeout(resolve, 120));
          mainWindow.showInactive();
        } else {
          mainWindow.blur();
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      }

      // Smart spacing (#856): append a trailing space so the next paste's leading
      // space self-corrects the gap. Reading the char before the cursor to space
      // the front instead would take a macOS Accessibility read costing hundreds
      // of ms — too slow for the paste hot path.
      const textToPaste = applySmartSpacing(text);

      // Windows: restore the foreground window captured at record start so the
      // paste lands in the field the user was dictating into, not wherever focus
      // drifted during transcription (#859). macOS handles this via
      // activateTargetPid above; Linux re-detects the target inside pasteLinux.
      const targetWindow =
        process.platform === "win32"
          ? ((await this.selectionManager?.getWinTargetHwnd?.()) ?? null)
          : null;

      const pasteResult = await this.clipboardManager.pasteText(textToPaste, {
        ...options,
        webContents: event.sender,
        targetWindow,
      });
      const pasted = pasteResult?.pasted !== false;
      debugLogger.debug("[AutoLearn] Paste completed", {
        autoLearnEnabled: this._autoLearnEnabled,
        hasMonitor: !!this.textEditMonitor,
        targetPid,
        pasted,
      });
      if (pasted && this.textEditMonitor && this._autoLearnEnabled) {
        setTimeout(() => {
          try {
            debugLogger.debug("[AutoLearn] Starting monitoring", {
              textPreview: text.substring(0, 80),
            });
            this.textEditMonitor.startMonitoring(text, 30000, { targetPid });
          } catch (err) {
            debugLogger.debug("[AutoLearn] Failed to start monitoring", { error: err.message });
          }
        }, 500);
      }
      // ClipboardManager returns `restoreComplete` so main-process callers can
      // serialize subsequent clipboard work behind its delayed restore. A
      // Promise cannot cross Electron's IPC boundary, though, and renderer
      // callers need to know whether text was pasted, but not the delayed
      // clipboard restoration promise. Successful platform paths predate the
      // explicit `pasted` outcome; only the clipboard-only fallback sets false.
      return { success: true, pasted };
    });

    ipcMain.handle("check-accessibility-permission", async (_event, silent = false) => {
      return this.clipboardManager.checkAccessibilityPermissions(silent);
    });

    // Passes `true` to isTrustedAccessibilityClient to trigger the macOS system prompt
    ipcMain.handle("prompt-accessibility-permission", async () => {
      if (process.platform !== "darwin") return true;
      return systemPreferences.isTrustedAccessibilityClient(true);
    });

    ipcMain.handle("read-clipboard", async (event) => {
      return this.clipboardManager.readClipboard();
    });

    ipcMain.handle("write-clipboard", async (event, text) => {
      return this.clipboardManager.writeClipboard(text, event.sender);
    });

    ipcMain.handle("check-paste-tools", async () => {
      return this.clipboardManager.checkPasteTools();
    });

    // Voice drafts (chat input): persist a recorded buffer so the file-based
    // transcription pipeline (all providers) can consume it, then delete it.
    ipcMain.handle("save-temp-audio", async (_event, buffer) => {
      const tempPath = path.join(
        os.tmpdir(),
        `ow-voice-draft-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.webm`
      );
      fs.writeFileSync(tempPath, Buffer.from(buffer));
      return { success: true, path: tempPath };
    });

    ipcMain.handle("delete-temp-audio", async (_event, tempPath) => {
      // Only files this handler family created are deletable.
      const resolved = path.resolve(tempPath);
      const validPrefix = path.join(os.tmpdir(), "ow-voice-draft-");
      if (!resolved.startsWith(validPrefix)) {
        return { success: false, error: "Invalid temp path" };
      }
      try {
        fs.unlinkSync(resolved);
      } catch {
        // Already gone — fine.
      }
      return { success: true };
    });

    ipcMain.handle("transcribe-local-whisper", async (_event, audioBlob, options = {}) => {
      debugLogger.log("transcribe-local-whisper called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      try {
        // skipVad: dictionary-echo rescue retries decode VAD-free, since VAD
        // stripping the speech is what turned the transcript into prompt echo.
        const { skipVad, ...requestOptions } = options;
        const vadOptions = skipVad
          ? { vadEnabled: false }
          : this._resolveWhisperVadOptions("dictation");
        const result = await this.whisperManager.transcribeLocalWhisper(audioBlob, {
          ...requestOptions,
          ...vadOptions,
        });

        debugLogger.log("Whisper result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        return result;
      } catch (error) {
        debugLogger.error("Local Whisper transcription error", error);
        const errorMessage = error.message || "Unknown error";

        // Return specific error types for better user feedback
        if (errorMessage.includes("FFmpeg not found")) {
          return {
            success: false,
            error: "ffmpeg_not_found",
            message: "FFmpeg is missing. Please reinstall the app or install FFmpeg manually.",
          };
        }
        if (
          errorMessage.includes("FFmpeg conversion failed") ||
          errorMessage.includes("FFmpeg process error")
        ) {
          return {
            success: false,
            error: "ffmpeg_error",
            message: "Audio conversion failed. The recording may be corrupted.",
          };
        }
        if (
          errorMessage.includes("whisper.cpp not found") ||
          errorMessage.includes("whisper-cpp")
        ) {
          return {
            success: false,
            error: "whisper_not_found",
            message: "Whisper binary is missing. Please reinstall the app.",
          };
        }
        if (
          errorMessage.includes("Audio buffer is empty") ||
          errorMessage.includes("Audio data too small")
        ) {
          return {
            success: false,
            error: "no_audio_data",
            message: "No audio detected",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        throw error;
      }
    });

    ipcMain.handle("check-whisper-installation", async (event) => {
      return this.whisperManager.checkWhisperInstallation();
    });

    ipcMain.handle("get-audio-diagnostics", async () => {
      return this.whisperManager.getDiagnostics();
    });

    ipcMain.handle("download-whisper-model", async (event, modelName) => {
      try {
        const result = await this.whisperManager.downloadWhisperModel(modelName, (progressData) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("whisper-download-progress", progressData);
          }
        });
        return result;
      } catch (error) {
        if (
          error.code !== "DOWNLOAD_IN_PROGRESS" &&
          error.code !== "DOWNLOAD_CANCELLED" &&
          !event.sender.isDestroyed()
        ) {
          event.sender.send("whisper-download-progress", {
            type: "error",
            model: modelName,
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("check-model-status", async (event, modelName) => {
      return this.whisperManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-whisper-models", async (event) => {
      return this.whisperManager.listWhisperModels();
    });

    ipcMain.handle("delete-whisper-model", async (event, modelName) => {
      return this.whisperManager.deleteWhisperModel(modelName);
    });

    ipcMain.handle("delete-all-whisper-models", async () => {
      return this.whisperManager.deleteAllWhisperModels();
    });

    ipcMain.handle("cancel-whisper-download", async (event) => {
      return this.whisperManager.cancelDownload();
    });

    ipcMain.handle("whisper-server-start", async (event, modelName) => {
      return this.whisperManager.startServer(
        modelName,
        this.whisperManager.resolveGpuStartOptions()
      );
    });

    ipcMain.handle("whisper-server-stop", async () => {
      return this.whisperManager.stopServer();
    });

    ipcMain.handle("whisper-server-status", async () => {
      return this.whisperManager.getServerStatus();
    });

    ipcMain.handle("detect-gpu", async () => {
      const { detectNvidiaGpu } = require("../utils/gpuDetection");
      return detectNvidiaGpu();
    });

    ipcMain.handle("list-gpus", async () => {
      const { listNvidiaGpus } = require("../utils/gpuDetection");
      return listNvidiaGpus();
    });

    ipcMain.handle("set-gpu-device-index", async (_event, purpose, uuid) => {
      if (purpose !== "transcription" && purpose !== "intelligence") {
        return { success: false };
      }
      // Empty string clears the pinned GPU; otherwise require an nvidia-smi UUID. See #531.
      if (typeof uuid !== "string" || (uuid !== "" && !uuid.startsWith("GPU-"))) {
        return { success: false };
      }
      const key = purpose === "intelligence" ? "INTELLIGENCE_GPU_UUID" : "TRANSCRIPTION_GPU_UUID";
      const oldUuid = process.env[key] || "";
      process.env[key] = uuid;
      this.environmentManager.saveAllKeysToEnvFile().catch((err) => {
        debugLogger.error("Failed to persist GPU UUID", { error: err.message }, "gpu");
      });

      if (oldUuid !== uuid) {
        try {
          if (purpose === "transcription" && this.whisperManager?.serverManager?.process) {
            debugLogger.info(
              "Restarting whisper-server for GPU change",
              { from: oldUuid, to: uuid },
              "gpu"
            );
            await this.whisperManager.restartServerWithGpuPreference();
          }
          if (purpose === "intelligence") {
            const modelManager = require("./modelManagerBridge").default;
            if (modelManager.serverManager?.process) {
              debugLogger.info(
                "Restarting llama-server for GPU change",
                { from: oldUuid, to: uuid },
                "gpu"
              );
              const modelId = modelManager.currentServerModelId;
              await modelManager.serverManager.stop();
              if (modelId) {
                await modelManager.prewarmServer(modelId);
              }
            }
          }
        } catch (err) {
          debugLogger.error(
            "Failed to restart server after GPU change",
            { error: err.message, purpose },
            "gpu"
          );
        }
      }

      return { success: true };
    });

    ipcMain.handle("get-gpu-device-index", async (_event, purpose) => {
      if (purpose !== "transcription" && purpose !== "intelligence") {
        return "";
      }
      const key = purpose === "intelligence" ? "INTELLIGENCE_GPU_UUID" : "TRANSCRIPTION_GPU_UUID";
      return process.env[key] || "";
    });

    ipcMain.handle("get-cuda-whisper-status", async () => {
      const { detectNvidiaGpu } = require("../utils/gpuDetection");
      const gpuInfo = await detectNvidiaGpu();
      if (!this.whisperCudaManager) {
        return { downloaded: false, downloading: false, path: null, gpuInfo };
      }
      return {
        downloaded: this.whisperCudaManager.isDownloaded(),
        downloading: this.whisperCudaManager.isDownloading(),
        path: this.whisperCudaManager.getCudaBinaryPath(),
        gpuInfo,
        gpuFailed: this._whisperGpuFailedBackends().includes("cuda"),
      };
    });

    ipcMain.handle("download-cuda-whisper-binary", async (event) => {
      if (!this.whisperCudaManager) {
        return { success: false, error: "CUDA not supported on this platform" };
      }
      try {
        const reloadModel = this._whisperReloadModel();
        // Stop the server first: swapping in a pack a running binary is loaded
        // from EBUSYs on Windows (same rule as the Vulkan handler below)
        await this.whisperManager.stopServer().catch(() => {});
        await this.whisperCudaManager.download((downloaded, total) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("cuda-download-progress", {
              downloadedBytes: downloaded,
              totalBytes: total,
              percentage: total > 0 ? Math.round((downloaded / total) * 100) : 0,
            });
          }
        });
        this._syncStartupEnv({ WHISPER_CUDA_ENABLED: "true" });
        this._clearWhisperGpuFailure("cuda");
        return { success: true, willRestart: this._applyWhisperGpuPreference(reloadModel) };
      } catch (error) {
        debugLogger.error("CUDA binary download failed", {
          error: error.message,
          stack: error.stack,
        });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cancel-cuda-whisper-download", async () => {
      if (!this.whisperCudaManager) return { success: false };
      return this.whisperCudaManager.cancelDownload();
    });

    ipcMain.handle("delete-cuda-whisper-binary", async () => {
      if (!this.whisperCudaManager) return { success: false };
      const reloadModel = this._whisperReloadModel();
      // Stop the server first so the running binary can be deleted on Windows
      await this.whisperManager.stopServer().catch(() => {});
      const result = await this.whisperCudaManager.delete();
      if (result.success) {
        this._syncStartupEnv({}, ["WHISPER_CUDA_ENABLED"]);
        this._clearWhisperGpuFailure("cuda");
        this._applyWhisperGpuPreference(reloadModel);
      }
      return result;
    });

    ipcMain.handle("get-vulkan-whisper-status", async () => {
      const { detectVulkanGpu } = require("../utils/vulkanDetection");
      const { detectNvidiaGpu } = require("../utils/gpuDetection");
      const [vulkan, gpuInfo] = await Promise.all([detectVulkanGpu(), detectNvidiaGpu()]);
      return {
        downloaded: this.whisperVulkanManager?.isDownloaded() ?? false,
        downloading: this.whisperVulkanManager?.isDownloading() ?? false,
        vulkan,
        hasNvidiaGpu: gpuInfo.hasNvidiaGpu,
        gpuFailed: this._whisperGpuFailedBackends().includes("vulkan"),
      };
    });

    ipcMain.handle("download-vulkan-whisper-binary", async (event) => {
      if (!this.whisperVulkanManager) {
        return { success: false, error: "Vulkan not supported on this platform" };
      }
      try {
        const reloadModel = this._whisperReloadModel();
        // Stop the server first: overwriting a running binary EBUSYs on Windows
        await this.whisperManager.stopServer().catch(() => {});
        await this.whisperVulkanManager.download((downloaded, total) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("vulkan-whisper-download-progress", {
              downloadedBytes: downloaded,
              totalBytes: total,
              percentage: total > 0 ? Math.round((downloaded / total) * 100) : 0,
            });
          }
        });
        this._syncStartupEnv({ WHISPER_VULKAN_ENABLED: "true" });
        this._clearWhisperGpuFailure("vulkan");
        return { success: true, willRestart: this._applyWhisperGpuPreference(reloadModel) };
      } catch (error) {
        debugLogger.error("Vulkan whisper binary download failed", {
          error: error.message,
          stack: error.stack,
        });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cancel-vulkan-whisper-download", async () => {
      if (!this.whisperVulkanManager) return { success: false };
      return { success: this.whisperVulkanManager.cancelDownload() };
    });

    ipcMain.handle("delete-vulkan-whisper-binary", async () => {
      if (!this.whisperVulkanManager) return { success: false };
      const reloadModel = this._whisperReloadModel();
      // Stop the server first so the running binary can be deleted on Windows
      await this.whisperManager.stopServer().catch(() => {});
      const { deletedCount } = await this.whisperVulkanManager.delete();
      this._syncStartupEnv({}, ["WHISPER_VULKAN_ENABLED", "WHISPER_VULKAN_DEVICE"]);
      this._clearWhisperGpuFailure("vulkan");
      this._applyWhisperGpuPreference(reloadModel);
      return { success: true, deletedCount };
    });

    // One-time "GPU pack needs re-downloading" notice recorded by the
    // legacy-layout migration before any window existed. See #1606.
    ipcMain.handle("get-gpu-pack-migration-notice", () => {
      return require("./gpuPackMigrationNotice").read();
    });

    ipcMain.handle("dismiss-gpu-pack-migration-notice", () => {
      require("./gpuPackMigrationNotice").clear();
      return { success: true };
    });

    // Clears the remembered GPU failure and reloads the server with the GPU
    // backend re-enabled (Retry on the "GPU could not be activated" state)
    ipcMain.handle("whisper-gpu-retry", async () => {
      this._syncStartupEnv({}, ["WHISPER_GPU_FAILED"]);
      return {
        success: true,
        willRestart: this._applyWhisperGpuPreference(this._whisperReloadModel()),
      };
    });

    ipcMain.handle("check-ffmpeg-availability", async (event) => {
      return this.whisperManager.checkFFmpegAvailability();
    });

    ipcMain.handle("transcribe-local-parakeet", async (_event, audioBlob, options = {}) => {
      debugLogger.log("transcribe-local-parakeet called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      try {
        const result = await this.parakeetManager.transcribeLocalParakeet(audioBlob, options);

        debugLogger.log("Parakeet result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        return result;
      } catch (error) {
        debugLogger.error("Local Parakeet transcription error", error);
        const errorMessage = error.message || "Unknown error";

        if (errorMessage.includes("sherpa-onnx") && errorMessage.includes("not found")) {
          return {
            success: false,
            error: "parakeet_not_found",
            message: "Parakeet binary is missing. Please reinstall the app.",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }
        if (error.code === PARAKEET_UNSUPPORTED_OS_CODE) {
          return {
            success: false,
            error: error.code,
            message: errorMessage,
          };
        }

        throw error;
      }
    });

    ipcMain.handle("check-parakeet-installation", async () => {
      return this.parakeetManager.checkInstallation();
    });

    ipcMain.handle("download-parakeet-model", async (event, modelName) => {
      try {
        const result = await this.parakeetManager.downloadParakeetModel(
          modelName,
          (progressData) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("parakeet-download-progress", progressData);
            }
          }
        );
        return result;
      } catch (error) {
        if (
          error.code !== "DOWNLOAD_IN_PROGRESS" &&
          error.code !== "DOWNLOAD_CANCELLED" &&
          !event.sender.isDestroyed()
        ) {
          event.sender.send("parakeet-download-progress", {
            type: "error",
            model: modelName,
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("check-parakeet-model-status", async (_event, modelName) => {
      return this.parakeetManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-parakeet-models", async () => {
      return this.parakeetManager.listParakeetModels();
    });

    ipcMain.handle("delete-parakeet-model", async (_event, modelName) => {
      return this.parakeetManager.deleteParakeetModel(modelName);
    });

    ipcMain.handle("delete-all-parakeet-models", async () => {
      return this.parakeetManager.deleteAllParakeetModels();
    });

    ipcMain.handle("cancel-parakeet-download", async () => {
      return this.parakeetManager.cancelDownload();
    });

    ipcMain.handle("get-parakeet-diagnostics", async () => {
      return this.parakeetManager.getDiagnostics();
    });

    ipcMain.handle("parakeet-server-start", async (event, modelName) => {
      const result = await this.parakeetManager.startServer(modelName);
      // Persisting a provider that failed to start would wedge every launch
      // into a failing pre-warm.
      if (result.success) {
        process.env.LOCAL_TRANSCRIPTION_PROVIDER =
          getModelType(modelName) === "cohere-transcribe" ? "cohere" : "nvidia";
        process.env.PARAKEET_MODEL = modelName;
        await this.environmentManager.saveAllKeysToEnvFile();
      }
      return result;
    });

    ipcMain.handle("parakeet-server-stop", async () => {
      const result = await this.parakeetManager.stopServer();
      delete process.env.LOCAL_TRANSCRIPTION_PROVIDER;
      delete process.env.PARAKEET_MODEL;
      await this.environmentManager.saveAllKeysToEnvFile();
      return result;
    });

    ipcMain.handle("parakeet-server-status", async () => {
      return this.parakeetManager.getServerStatus();
    });

    // Diarization model management
    ipcMain.handle("download-diarization-models", async (event) => {
      try {
        const result = await this.diarizationManager.downloadModels((progressData) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("diarization-download-progress", progressData);
          }
        });
        return result;
      } catch (error) {
        if (!event.sender.isDestroyed()) {
          event.sender.send("diarization-download-progress", {
            type: "error",
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("get-diarization-model-status", async () => {
      return {
        available: this.diarizationManager?.isAvailable() ?? false,
        modelsDownloaded:
          (this.diarizationManager?.isModelDownloaded() ?? false) &&
          (this.diarizationManager?.isVadModelDownloaded() ?? false),
      };
    });

    ipcMain.handle("delete-diarization-models", async () => {
      try {
        await this.diarizationManager.deleteModels();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to delete diarization models", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("diarize-audio-file", async (event, filePath, options = {}) => {
      // Registered under the same requestId as the upload's transcription, so
      // one cancel kills both the decode and the diarization child process.
      const { signal, release } = this._uploadCancelRegistry.register(options.requestId);
      try {
        if (!this.diarizationManager) {
          return { success: false, error: "Diarization not available" };
        }
        if (!this.diarizationManager.isModelDownloaded()) {
          return { success: false, error: "Diarization models not downloaded" };
        }

        if (typeof filePath !== "string") {
          return { success: false, error: "Invalid file path" };
        }
        const realPath = resolveAllowedAudioPath(filePath);
        if (!realPath) return { success: false, error: "File path not allowed" };
        filePath = realPath;

        const numSpeakers = Math.min(
          MAX_SPEAKER_COUNT,
          Math.max(-1, Math.round(Number(options.numSpeakers) || -1))
        );

        const { convertToWav } = require("./ffmpegUtils");
        const { getSafeTempDir } = require("./safeTempDir");
        const { resolveClusterThreshold, dropNegligibleClusters } = require("./diarizationPolicy");
        const { PCM16_MONO_16K_BYTES_PER_SECOND } = require("./transcriptionTimeout");
        const wavPath = path.join(getSafeTempDir(), `ow-diarize-${Date.now()}.wav`);

        try {
          await convertToWav(filePath, wavPath, { sampleRate: 16000, channels: 1 });
          if (signal?.aborted) {
            return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
          }
          // Auto-clustering over-splits long single-mic audio at the 0.55
          // default, so the threshold ramps with duration unless pinned.
          const durationSeconds = fs.statSync(wavPath).size / PCM16_MONO_16K_BYTES_PER_SECOND;
          const threshold = resolveClusterThreshold(durationSeconds, options.threshold);

          let segments = await this.diarizationManager.diarize(wavPath, {
            numSpeakers,
            threshold,
            signal,
          });
          if (signal?.aborted) {
            return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
          }
          // The meeting path caps clusters via its expectation resolver; this
          // path fed raw sherpa output to the merge, which is how a 2-person
          // voice memo surfaced 46 speakers.
          segments = dropNegligibleClusters(segments);
          segments = this.diarizationManager.capSpeakerClusters(
            segments,
            numSpeakers > 0 ? numSpeakers : MAX_SPEAKER_COUNT
          );
          // Callers persist this as audio_duration_seconds: for picked files
          // the renderer has no other duration source.
          return { success: true, segments, durationSeconds };
        } finally {
          try {
            fs.unlinkSync(wavPath);
          } catch {}
        }
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) {
          debugLogger.debug("Diarization cancelled", { requestId: options.requestId });
          return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
        }
        debugLogger.error("Diarization error", { error: error.message });
        return { success: false, error: error.message };
      } finally {
        release();
      }
    });

    ipcMain.handle("merge-speaker-text", async (event, { segments, text, duration }) => {
      try {
        if (
          !Array.isArray(segments) ||
          typeof text !== "string" ||
          typeof duration !== "number" ||
          !isFinite(duration)
        ) {
          return { success: false, error: "Invalid arguments" };
        }
        if (segments.length > 10000 || text.length > 1_000_000) {
          return { success: false, error: "Input too large" };
        }
        const sanitizedSegments = segments.map((s) => ({
          speaker: typeof s.speaker === "string" ? s.speaker.slice(0, 100) : "unknown",
          start: typeof s.start === "number" && isFinite(s.start) ? s.start : 0,
          end: typeof s.end === "number" && isFinite(s.end) ? s.end : 0,
        }));
        const merged = mergeSpeakersWithText(sanitizedSegments, text, duration);
        return { success: true, text: formatSpeakerTranscript(merged) };
      } catch (error) {
        debugLogger.error("Speaker merge error", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cancel-diarization-download", async () => {
      return this.diarizationManager.cancelDownload();
    });

    ipcMain.handle("cleanup-app", async (event) => {
      const fs = require("fs");
      const os = require("os");
      const errors = [];
      const mainWindow = this.windowManager.mainWindow;

      // Stop services before deleting files they hold open
      try {
        await this.parakeetManager?.stopServer();
      } catch (e) {
        errors.push(`Parakeet stop: ${e.message}`);
      }
      try {
        this.whisperManager?.stopServer();
      } catch (e) {
        errors.push(`Whisper stop: ${e.message}`);
      }
      try {
        this.googleCalendarManager?.stop();
      } catch (e) {
        errors.push(`GCal stop: ${e.message}`);
      }
      try {
        this.microsoftCalendarManager?.stop();
      } catch (e) {
        errors.push(`MCal stop: ${e.message}`);
      }
      try {
        this.appleCalendarManager?.stop();
      } catch (e) {
        errors.push(`ACal stop: ${e.message}`);
      }
      try {
        await this.diarizationManager?.shutdown();
      } catch (e) {
        errors.push(`Diarization stop: ${e.message}`);
      }
      try {
        await this.getQdrantManager?.()?.stop();
      } catch (e) {
        errors.push(`Vector index stop: ${e.message}`);
      }
      try {
        const onnxWorkerClient = require("./onnxWorkerClient");
        await onnxWorkerClient.stop();
      } catch (e) {
        errors.push(`Embedding worker stop: ${e.message}`);
      }

      // Revoke Google OAuth tokens before DB is closed
      try {
        await this.googleCalendarManager?.revokeAllTokens();
      } catch (e) {
        errors.push(`GCal revoke: ${e.message}`);
      }

      // Close DB connection before deleting the file
      try {
        this.databaseManager?.db?.close();
      } catch (e) {
        errors.push(`DB close: ${e.message}`);
      }

      // Delete audio files
      try {
        this.audioStorageManager.deleteAllAudio();
      } catch (e) {
        errors.push(`Audio delete: ${e.message}`);
      }

      // Delete downloaded models
      try {
        const { getModelsDirForService } = require("./modelDirUtils");
        const whisperDir = getModelsDirForService("whisper");
        if (fs.existsSync(whisperDir)) fs.rmSync(whisperDir, { recursive: true, force: true });
      } catch (e) {
        errors.push(`Whisper models: ${e.message}`);
      }
      try {
        await this.parakeetManager?.deleteAllParakeetModels();
      } catch (e) {
        errors.push(`Parakeet models: ${e.message}`);
      }
      try {
        await this.diarizationManager?.deleteModels();
      } catch (e) {
        errors.push(`Diarization models: ${e.message}`);
      }
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteAllModels();
      } catch (e) {
        errors.push(`LLM models: ${e.message}`);
      }

      // These caches are not owned by one account. Remove them only through
      // the explicit device-erasure path, never during normal account deletion.
      const homeCacheRoot = path.join(os.homedir(), ".cache", "openwhispr");
      for (const cacheName of ["embedding-models", "qdrant-data", "qdrant-data-dev", "yt-dlp"]) {
        try {
          fs.rmSync(path.join(homeCacheRoot, cacheName), { recursive: true, force: true });
        } catch (e) {
          errors.push(`${cacheName} cache: ${e.message}`);
        }
      }

      // Delete database file + WAL/SHM
      try {
        const dbPath = path.join(
          app.getPath("userData"),
          process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
        );
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
        if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");
      } catch (e) {
        errors.push(`DB file: ${e.message}`);
      }

      // Delete device-wide settings and encrypted credentials.
      try {
        await this.environmentManager?.clearAllPersistedData();
      } catch (e) {
        errors.push(`Environment settings: ${e.message}`);
      }
      try {
        const tokenCleanup = tokenStore.clear();
        if (!tokenCleanup.success) throw new Error("Could not clear the stored bearer token");
      } catch (e) {
        errors.push(`Authentication token: ${e.message}`);
      }
      try {
        this.enterpriseIdentityManager?.clear();
      } catch (e) {
        errors.push(`Enterprise settings: ${e.message}`);
      }
      try {
        for (const fileName of [
          "workspace-policy.json",
          "managed-enterprise-config.json",
          "globe-preference-state.json",
          ".system-audio-permission",
          "account-scope-binding.json",
        ]) {
          fs.rmSync(path.join(app.getPath("userData"), fileName), { force: true });
        }
      } catch (e) {
        errors.push(`Device setting files: ${e.message}`);
      }
      for (const directoryName of ["bin", "llama-cpp"]) {
        try {
          fs.rmSync(path.join(app.getPath("userData"), directoryName), {
            recursive: true,
            force: true,
          });
        } catch (e) {
          errors.push(`${directoryName} runtime: ${e.message}`);
        }
      }
      try {
        autoStart.setAutoStartEnabled(false);
      } catch (e) {
        errors.push(`Launch at login: ${e.message}`);
      }

      // Clear browser-held account/session state, including cookies, IndexedDB,
      // Cache Storage and localStorage persisted by any app window.
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
          await win.webContents.session.clearStorageData();
          await win.webContents.session.clearCache();
        }
      } catch (e) {
        errors.push(`Browser data: ${e.message}`);
      }

      // Clear localStorage
      if (mainWindow?.webContents) {
        try {
          await mainWindow.webContents.executeJavaScript("localStorage.clear()");
        } catch (e) {
          errors.push(`localStorage: ${e.message}`);
        }
      }

      if (errors.length > 0) {
        debugLogger.warn("Cleanup completed with errors", { errors }, "cleanup");
      }

      return { success: errors.length === 0, message: "Cleanup completed", errors };
    });

    ipcMain.handle("update-hotkey", async (event, hotkey) => {
      return await this.windowManager.updateHotkey(hotkey);
    });

    ipcMain.handle("set-hotkey-listening-mode", async (event, enabled) => {
      if (enabled) {
        const captureWindow = BrowserWindow.fromWebContents(event.sender);
        // Only the control panel owns editable hotkey fields. Refocusing the
        // sender before the idempotence check also repairs a stale capture-mode
        // flag after Windows has moved foreground focus to another window.
        if (captureWindow === this.windowManager.controlPanelWindow) {
          focusWindowsHotkeyCaptureWindow(captureWindow);
        }
      }
      if (this._hotkeyCaptureMode === enabled) return { success: true, skipped: true };
      this._hotkeyCaptureMode = enabled;
      this.windowManager.setHotkeyListeningMode(enabled);
      ipcMain.emit("hotkey-listening-mode-changed", null, enabled);
      const hotkeyManager = this.windowManager.hotkeyManager;

      // Restore from slot state only. A freshly captured hotkey is registered by
      // its own update IPC (invoked before this one); re-binding it here would
      // overwrite the primary on DE backends or leak untracked registrations.
      const effectiveHotkey = hotkeyManager.getCurrentHotkey();

      const {
        isGlobeLikeHotkey,
        isModifierOnlyHotkey,
        isRightSideModifier,
        isMouseButtonHotkey,
      } = require("./hotkeyManager");
      const usesNativeListener = (hotkey) =>
        !hotkey ||
        isGlobeLikeHotkey(hotkey) ||
        isMouseButtonHotkey(hotkey) ||
        isModifierOnlyHotkey(hotkey) ||
        isRightSideModifier(hotkey);

      if (enabled) {
        // Entering capture mode — unregister ALL slots so none intercept keypresses.
        // Dictation is always active; meeting and agent may or may not be set.
        const allSlots = hotkeyManager.slots;
        for (const [slot, info] of allSlots) {
          // Native-listener entries (null accelerator) are handled by stopping
          // the key listeners below.
          for (const accel of info?.accelerators || []) {
            if (!accel) continue;
            debugLogger.log(
              `[IPC] Unregistering globalShortcut "${accel}" (slot "${slot}") for capture mode`
            );
            const { globalShortcut } = require("electron");
            try {
              globalShortcut.unregister(accel);
            } catch {}
          }
        }

        // On Windows, stop the Windows key listener
        if (process.platform === "win32" && this.windowsKeyManager) {
          debugLogger.log("[IPC] Stopping Windows key listener for hotkey capture mode");
          this.windowsKeyManager.stop();
        }

        // On Linux, stop the Linux key listener
        if (process.platform === "linux" && this.linuxKeyManager) {
          debugLogger.log("[IPC] Stopping Linux key listener for hotkey capture mode");
          this.linuxKeyManager.stop();
        }

        // On GNOME, unregister all native keybindings during capture
        if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager) {
          await hotkeyManager.gnomeManager.unregisterPushToTalk();
          for (const slot of [...hotkeyManager.gnomeManager.registeredSlots]) {
            debugLogger.log(
              `[IPC] Unregistering GNOME keybinding (slot "${slot}") for capture mode`
            );
            await hotkeyManager.gnomeManager.unregisterKeybinding(slot).catch((err) => {
              debugLogger.warn(`[IPC] Failed to unregister GNOME slot "${slot}":`, err.message);
            });
          }
        }

        // On Hyprland Wayland, unregister the keybinding during capture
        if (hotkeyManager.isUsingHyprland() && hotkeyManager.hyprlandManager) {
          debugLogger.log("[IPC] Unregistering Hyprland keybinding for hotkey capture mode");
          await hotkeyManager.hyprlandManager.unregisterKeybinding().catch((err) => {
            debugLogger.warn("[IPC] Failed to unregister Hyprland keybinding:", err.message);
          });
        }
      } else {
        // Exiting capture mode - re-register globalShortcut if not already registered
        // Skip for KDE/GNOME/Hyprland — updateHotkey handles re-registration via native path
        const usesNativePath =
          hotkeyManager.isUsingKDE() ||
          hotkeyManager.isUsingGnome() ||
          hotkeyManager.isUsingHyprland();
        if (!usesNativePath) {
          const { globalShortcut } = require("electron");
          // Re-register every globalShortcut-backed dictation hotkey (the slot
          // may hold several).
          for (const hk of hotkeyManager.getSlotHotkeys("dictation")) {
            if (!hk || usesNativeListener(hk)) continue;
            const accelerator = hk;
            if (!globalShortcut.isRegistered(accelerator)) {
              debugLogger.log(
                `[IPC] Re-registering globalShortcut "${accelerator}" after capture mode`
              );
              const callback = this.windowManager.createHotkeyCallback();
              const registered = globalShortcut.register(accelerator, () => callback(hk));
              if (!registered) {
                debugLogger.warn(
                  `[IPC] Failed to re-register globalShortcut "${accelerator}" after capture mode`
                );
              }
            }
          }
        }

        // Re-sync native key listeners (Windows/Linux) across all hotkey slots now
        // that capture is done. Idempotent — reads the current slot hotkeys.
        this.windowManager.reconcileNativeKeyListeners();

        // On GNOME, re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager && effectiveHotkey) {
          debugLogger.log(
            `[IPC] Re-registering GNOME keybinding "${effectiveHotkey}" after capture mode`
          );
          await hotkeyManager.registerGnomeDictationHotkey(
            effectiveHotkey,
            this.windowManager.createHotkeyCallback()
          );
        }

        // On Hyprland Wayland, re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingHyprland() && hotkeyManager.hyprlandManager && effectiveHotkey) {
          debugLogger.log(
            `[IPC] Re-registering Hyprland keybinding "${effectiveHotkey}" after capture mode`
          );
          await hotkeyManager.hyprlandManager.registerKeybinding(
            effectiveHotkey,
            this.windowManager.getActivationMode() === "push"
          );
        }

        // On KDE (X11 or Wayland), re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingKDE() && hotkeyManager.kdeManager && effectiveHotkey) {
          debugLogger.log(
            `[IPC] Re-registering KDE keybinding "${effectiveHotkey}" after capture mode`
          );
          const callback = this.windowManager.createHotkeyCallback();
          const result = await hotkeyManager.kdeManager.registerKeybinding(
            effectiveHotkey,
            "dictation",
            callback,
            this.windowManager.getActivationMode() === "push"
          );
          if (result !== true) {
            debugLogger.warn(
              `[IPC] Failed to re-register KDE keybinding "${effectiveHotkey}" after capture mode`,
              { result }
            );
          }
        }

        // Re-register non-dictation slots (meeting, agent) that were unregistered on capture enter
        for (const [slot, info] of hotkeyManager.slots) {
          const hotkeys = info?.hotkeys || [];
          if (slot === "dictation" || slot === "cancel" || hotkeys.length === 0 || !info?.callback)
            continue;
          debugLogger.log(
            `[IPC] Re-registering slot "${slot}" ("${hotkeys.join(", ")}") after capture mode`
          );
          await hotkeyManager.registerSlot(slot, hotkeys, info.callback).catch((err) => {
            debugLogger.warn(`[IPC] Failed to re-register slot "${slot}":`, err.message);
          });
        }
      }

      return { success: true };
    });

    ipcMain.handle("get-hotkey-mode-info", async (_event, requestedHotkey) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const hotkey =
        typeof requestedHotkey === "string" && requestedHotkey.trim()
          ? requestedHotkey.split(",")[0].trim()
          : hotkeyManager.getCurrentHotkey();
      const isUsingNativeShortcut = this.windowManager.isUsingNativeShortcutHotkeys();
      const supportsPushToTalk =
        process.platform === "linux"
          ? isUsingNativeShortcut
            ? hotkeyManager.supportsPushToTalk(hotkey)
            : this.linuxKeyManager?.isAvailable?.() === true
          : !isUsingNativeShortcut;

      return {
        isUsingGnome: this.windowManager.isUsingGnomeHotkeys(),
        isUsingHyprland: this.windowManager.isUsingHyprlandHotkeys(),
        isUsingKDE: this.windowManager.isUsingKDEHotkeys(),
        isUsingNativeShortcut,
        supportsPushToTalk,
        pushToTalkUnavailableReason: supportsPushToTalk
          ? null
          : hotkeyManager.getPushToTalkUnavailableReason(hotkey),
      };
    });

    ipcMain.handle("get-hyprland-config-status", async () => {
      if (!this.windowManager.isUsingHyprlandHotkeys()) return null;
      return this.windowManager.getHyprlandConfigStatus();
    });

    ipcMain.handle("register-cancel-hotkey", async (event, key) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const mainWindow = this.windowManager.mainWindow;
      return hotkeyManager.registerSlot("cancel", key, () => {
        mainWindow?.webContents?.send("cancel-hotkey-pressed");
      });
    });

    ipcMain.handle("unregister-cancel-hotkey", async () => {
      this.windowManager.hotkeyManager.unregisterSlot("cancel");
      return { success: true };
    });

    ipcMain.handle("start-window-drag", async (event) => {
      return await this.windowManager.startWindowDrag();
    });

    ipcMain.handle("stop-window-drag", async (event) => {
      return await this.windowManager.stopWindowDrag();
    });

    ipcMain.handle("open-external", async (event, url) => {
      try {
        const { protocol } = new URL(url);
        if (!["http:", "https:", "mailto:"].includes(protocol)) {
          return { success: false, error: `Blocked URL scheme: ${protocol}` };
        }
        await openExternalUrl(url);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-auto-start-enabled", async () => {
      try {
        return autoStart.getAutoStartState();
      } catch (error) {
        debugLogger.error("Error getting auto-start status:", error);
        return { enabled: false, requiresApproval: false };
      }
    });

    ipcMain.handle("set-auto-start-enabled", async (event, enabled) => {
      try {
        autoStart.setAutoStartEnabled(enabled);
        debugLogger.debug("Auto-start setting updated", { enabled });
        return { success: true };
      } catch (error) {
        debugLogger.error("Error setting auto-start:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("model-get-all", async () => {
      try {
        debugLogger.debug("model-get-all called", undefined, "ipc");
        const modelManager = require("./modelManagerBridge").default;
        const models = await modelManager.getModelsWithStatus();
        debugLogger.debug("Returning models", { count: models.length }, "ipc");
        return models;
      } catch (error) {
        debugLogger.error("Error in model-get-all:", error);
        throw error;
      }
    });

    ipcMain.handle("model-check", async (_, modelId) => {
      const modelManager = require("./modelManagerBridge").default;
      return modelManager.isModelDownloaded(modelId);
    });

    ipcMain.handle("model-download", async (event, modelId) => {
      let lastProgress = {
        progress: 0,
        downloadedSize: 0,
        totalSize: 0,
      };

      try {
        const modelManager = require("./modelManagerBridge").default;
        const result = await modelManager.downloadModel(
          modelId,
          (progress, downloadedSize, totalSize) => {
            lastProgress = { progress, downloadedSize, totalSize };
            if (!event.sender.isDestroyed()) {
              event.sender.send("model-download-progress", {
                modelId,
                progress,
                downloadedSize,
                totalSize,
              });
            }
          }
        );
        if (!event.sender.isDestroyed()) {
          event.sender.send("model-download-progress", {
            type: "complete",
            modelId,
            progress: 100,
            downloadedSize: lastProgress.downloadedSize,
            totalSize: lastProgress.totalSize,
          });
        }
        return { success: true, path: result };
      } catch (error) {
        if (
          error.code !== "DOWNLOAD_IN_PROGRESS" &&
          error.code !== "DOWNLOAD_CANCELLED" &&
          !event.sender.isDestroyed()
        ) {
          event.sender.send("model-download-progress", {
            type: "error",
            modelId,
            error: error.message,
            code: error.code,
            details: error.details,
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-delete", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteModel(modelId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-delete-all", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteAllModels();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-cancel-download", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const cancelled = modelManager.cancelDownload(modelId);
        return { success: cancelled };
      } catch (error) {
        return {
          success: false,
          error: error.message,
        };
      }
    });

    ipcMain.handle("model-check-runtime", async (event) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.ensureLlamaCpp();
        return { available: true };
      } catch (error) {
        return {
          available: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle(
      "proxy-xai-transcription",
      serializeIpcError(async (event, { audioBuffer, language, keyterms }) => {
        const apiKey = this.environmentManager.getXaiKey();
        if (!apiKey) {
          throw new Error("xAI API key not configured");
        }

        const formData = new FormData();
        const audioBlob = new Blob([Buffer.from(audioBuffer)], { type: "audio/webm" });
        formData.append("file", audioBlob, "audio.webm");
        const { XAI_STT_LANGUAGES } = await import("./transcriptionRoute.ts");
        if (language && language !== "auto" && XAI_STT_LANGUAGES.has(language)) {
          formData.append("language", language);
          formData.append("format", "true");
        }
        if (keyterms && keyterms.length > 0) {
          for (const term of keyterms) {
            formData.append("keyterm", term);
          }
        }

        const response = await proxyFetch(XAI_STT_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`xAI API Error: ${response.status} ${errorText}`);
        }

        return await response.json();
      })
    );

    ipcMain.handle(
      "proxy-mistral-transcription",
      serializeIpcError(async (event, { audioBuffer, model, language, contextBias }) => {
        const apiKey = this.environmentManager.getMistralKey();
        if (!apiKey) {
          throw new Error("Mistral API key not configured");
        }

        const formData = new FormData();
        const audioBlob = new Blob([Buffer.from(audioBuffer)], { type: "audio/webm" });
        formData.append("file", audioBlob, "audio.webm");
        formData.append("model", model || "voxtral-mini-latest");
        if (language && language !== "auto") {
          formData.append("language", language);
        }
        if (contextBias && contextBias.length > 0) {
          for (const token of contextBias) {
            formData.append("context_bias", token);
          }
        }

        const response = await proxyFetch(MISTRAL_TRANSCRIPTION_URL, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
          },
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Mistral API Error: ${response.status} ${errorText}`);
        }

        return await response.json();
      })
    );

    ipcMain.handle("get-corti-client-id", async () => {
      return this.environmentManager.getCortiClientId();
    });

    ipcMain.handle("save-corti-client-id", async (event, key) => {
      return this.environmentManager.saveCortiClientId(key);
    });

    ipcMain.handle("get-corti-client-secret", async () => {
      return this.environmentManager.getCortiClientSecret();
    });

    ipcMain.handle("save-corti-client-secret", async (event, key) => {
      return this.environmentManager.saveCortiClientSecret(key);
    });

    ipcMain.handle(
      "proxy-corti-transcription",
      serializeIpcError(async (event, { audioBuffer, language, environment, tenant }) => {
        const clientId = this.environmentManager.getCortiClientId();
        const clientSecret = this.environmentManager.getCortiClientSecret();
        if (!clientId || !clientSecret) {
          throw new Error("Corti credentials not configured");
        }

        const { transcribeAudio } = require("./cortiTranscription");
        return await transcribeAudio({
          environment,
          tenant,
          clientId,
          clientSecret,
          audioBuffer,
          language,
        });
      })
    );

    ipcMain.handle("get-tinfoil-chat-models", async () => {
      return getTinfoilChatModels();
    });

    // Enclave attestation is Node-only, so batch transcription is proxied through main.
    ipcMain.handle(
      "proxy-tinfoil-transcription",
      serializeIpcError(async (event, { audioBuffer, language, prompt }) => {
        return await transcribeWithTinfoil({
          audioBuffer: Buffer.from(audioBuffer),
          fileName: "audio.webm",
          contentType: "audio/webm",
          language,
          prompt,
          apiKey: this.environmentManager.getTinfoilKey(),
        });
      })
    );

    // Gemini's Interactions API takes JSON with inline base64 audio, not
    // OpenAI-compatible multipart, so batch transcription is proxied through main.
    ipcMain.handle(
      "proxy-gemini-transcription",
      serializeIpcError(async (event, { audioBuffer, model, language, keyterms }) => {
        return await transcribeWithGemini({
          audioBuffer: Buffer.from(audioBuffer),
          model,
          contentType: "audio/webm",
          language,
          keyterms,
          apiKey: this.environmentManager.getGeminiKey(),
        });
      })
    );

    ipcMain.handle("get-custom-transcription-key", async () => {
      return this.environmentManager.getCustomTranscriptionKey();
    });

    ipcMain.handle("save-custom-transcription-key", async (event, key) => {
      return this.environmentManager.saveCustomTranscriptionKey(key);
    });

    ipcMain.handle("get-cleanup-custom-key", async () => {
      return this.environmentManager.getCleanupCustomKey();
    });

    ipcMain.handle("save-cleanup-custom-key", async (event, key) => {
      return this.environmentManager.saveCleanupCustomKey(key);
    });

    // Enterprise provider key handlers
    ipcMain.handle("get-bedrock-region", async () => {
      return this.environmentManager.getBedrockRegion();
    });
    ipcMain.handle("save-bedrock-region", async (event, value) => {
      return this.environmentManager.saveBedrockRegion(value);
    });
    ipcMain.handle("get-bedrock-profile", async () => {
      return this.environmentManager.getBedrockProfile();
    });
    ipcMain.handle("save-bedrock-profile", async (event, value) => {
      return this.environmentManager.saveBedrockProfile(value);
    });
    ipcMain.handle("get-bedrock-access-key-id", async () => {
      return this.environmentManager.getBedrockAccessKeyId();
    });
    ipcMain.handle("save-bedrock-access-key-id", async (event, key) => {
      return this.environmentManager.saveBedrockAccessKeyId(key);
    });
    ipcMain.handle("get-bedrock-secret-access-key", async () => {
      return this.environmentManager.getBedrockSecretAccessKey();
    });
    ipcMain.handle("save-bedrock-secret-access-key", async (event, key) => {
      return this.environmentManager.saveBedrockSecretAccessKey(key);
    });
    ipcMain.handle("get-bedrock-session-token", async () => {
      return this.environmentManager.getBedrockSessionToken();
    });
    ipcMain.handle("save-bedrock-session-token", async (event, key) => {
      return this.environmentManager.saveBedrockSessionToken(key);
    });
    ipcMain.handle("get-azure-endpoint", async () => {
      return this.environmentManager.getAzureEndpoint();
    });
    ipcMain.handle("save-azure-endpoint", async (event, value) => {
      return this.environmentManager.saveAzureEndpoint(value);
    });
    ipcMain.handle("get-azure-api-key", async () => {
      return this.environmentManager.getAzureApiKey();
    });
    ipcMain.handle("save-azure-api-key", async (event, key) => {
      return this.environmentManager.saveAzureApiKey(key);
    });
    ipcMain.handle("get-azure-deployment", async () => {
      return this.environmentManager.getAzureDeployment();
    });
    ipcMain.handle("save-azure-deployment", async (event, value) => {
      return this.environmentManager.saveAzureDeployment(value);
    });
    ipcMain.handle("get-azure-api-version", async () => {
      return this.environmentManager.getAzureApiVersion();
    });
    ipcMain.handle("save-azure-api-version", async (event, value) => {
      return this.environmentManager.saveAzureApiVersion(value);
    });
    ipcMain.handle("get-vertex-project", async () => {
      return this.environmentManager.getVertexProject();
    });
    ipcMain.handle("save-vertex-project", async (event, value) => {
      return this.environmentManager.saveVertexProject(value);
    });
    ipcMain.handle("get-vertex-location", async () => {
      return this.environmentManager.getVertexLocation();
    });
    ipcMain.handle("save-vertex-location", async (event, value) => {
      return this.environmentManager.saveVertexLocation(value);
    });
    ipcMain.handle("get-vertex-api-key", async () => {
      return this.environmentManager.getVertexApiKey();
    });
    ipcMain.handle("save-vertex-api-key", async (event, key) => {
      return this.environmentManager.saveVertexApiKey(key);
    });

    // Enterprise provider test connection
    ipcMain.handle("test-enterprise-connection", async (event, provider, config) => {
      const {
        mapEnterpriseError,
        runAbortableOperation,
        runBedrockRequest,
        validateEnterpriseEndpoint,
      } = require("./enterpriseProviderErrors");
      let runtime;
      try {
        const { generateText } = require("ai");
        const { getEnterpriseAIModel } = require("./enterpriseAiProviders");

        const resolveModel = (abortSignal) =>
          runAbortableOperation(async () => {
            runtime = await resolveEnterpriseRuntime(
              event,
              provider,
              config?.model || "test",
              config
            );
            abortSignal?.throwIfAborted();
            validateEnterpriseEndpoint(runtime.enterprise.azureEndpoint);
            return getEnterpriseAIModel(
              runtime.provider,
              runtime.model,
              runtime.apiKey,
              runtime.enterprise
            );
          }, abortSignal);

        if (provider === "bedrock") {
          await runBedrockRequest(async () => {
            const abortSignal = AbortSignal.timeout(config?.timeoutMs || 30_000);
            const model = await resolveModel(abortSignal);
            return generateText({
              model,
              prompt: "Say hello in one word.",
              maxOutputTokens: 10,
              abortSignal,
              maxRetries: 0,
            });
          });
        } else {
          const model = await resolveModel();
          await generateText({
            model,
            prompt: "Say hello in one word.",
            maxOutputTokens: 10,
          });
        }

        return { success: true };
      } catch (err) {
        const mappingConfig =
          runtime?.provider === "bedrock" && runtime.enterprise?.bedrockRegion
            ? { ...(config || {}), bedrockRegion: runtime.enterprise.bedrockRegion }
            : config;
        const mapped = mapEnterpriseError(provider, err, mappingConfig);
        return {
          success: false,
          error: mapped.message,
          messageKey: mapped.messageKey,
          messageParams: mapped.messageParams,
          action: mapped.action,
          actionKey: mapped.actionKey,
          copyCommand: mapped.copyCommand,
          retryable: mapped.retryable,
          technicalDetails: mapped.technicalDetails,
        };
      }
    });

    ipcMain.handle(
      "process-enterprise-reasoning",
      async (event, text, modelId, _agentName, config) => {
        const {
          isEnterpriseProvider,
          mapEnterpriseError,
          runAbortableOperation,
          runBedrockRequest,
          validateEnterpriseEndpoint,
        } = require("./enterpriseProviderErrors");
        const provider = config?.provider;
        let runtime;
        try {
          if (!isEnterpriseProvider(provider)) {
            throw new Error(`Unsupported enterprise provider: ${provider}`);
          }
          const isBedrockCleanup =
            provider === "bedrock" && config?.inferenceScope === "dictationCleanup";
          const sender = isBedrockCleanup ? event.sender : null;
          const senderId = sender?.id;
          const requestId = isBedrockCleanup ? crypto.randomUUID() : null;
          const controller = isBedrockCleanup
            ? this._enterpriseReasoningRequests.begin(senderId, requestId)
            : null;
          const cancelSenderRequests = () =>
            this._enterpriseReasoningRequests.cancelSender(senderId);
          try {
            if (controller) {
              sender.once("destroyed", cancelSenderRequests);
              if (sender.isDestroyed()) controller.abort();
            }
            controller?.signal.throwIfAborted();

            const { generateText } = require("ai");
            const { getEnterpriseAIModel } = require("./enterpriseAiProviders");
            const timeoutMs = config?.timeoutMs || 60000;
            // Opus 4.7 / GPT-5 / o-series dropped `temperature`; renderer
            // derives support from the model registry and we honor that here.
            const useTemperature = config?.supportsTemperature !== false;
            const resolveModel = (abortSignal) =>
              runAbortableOperation(async () => {
                runtime = await resolveEnterpriseRuntime(event, provider, modelId, config || {});
                abortSignal?.throwIfAborted();
                if (!runtime.model) throw new Error("No model specified for enterprise reasoning");
                validateEnterpriseEndpoint(runtime.enterprise.azureEndpoint);
                return getEnterpriseAIModel(
                  runtime.provider,
                  runtime.model,
                  runtime.apiKey,
                  runtime.enterprise
                );
              }, abortSignal);
            const generate = (model, abortSignal, disableNestedRetries = false) => {
              return generateText({
                model,
                system: config?.systemPrompt || "",
                prompt: text,
                maxOutputTokens: config?.maxTokens || 4096,
                ...(useTemperature ? { temperature: config?.temperature ?? 0.3 } : {}),
                abortSignal,
                ...(disableNestedRetries ? { maxRetries: 0 } : {}),
              });
            };
            let result;
            if (isBedrockCleanup) {
              result = await runBedrockRequest(
                async () => {
                  const abortSignal = AbortSignal.any([
                    controller.signal,
                    AbortSignal.timeout(timeoutMs),
                  ]);
                  const model = await resolveModel(abortSignal);
                  return generate(model, abortSignal, true);
                },
                { signal: controller.signal }
              );
            } else {
              const model = await resolveModel();
              result = await generate(model, AbortSignal.timeout(timeoutMs));
            }
            const { text: generated, finishReason } = result;

            if (
              config?.requireCompleteOutput &&
              ["length", "max-tokens", "max_tokens"].includes(finishReason)
            ) {
              throw new Error("Model output was truncated before the selection edit completed");
            }

            return { success: true, text: (generated || "").trim() };
          } finally {
            if (controller) {
              sender.removeListener("destroyed", cancelSenderRequests);
              this._enterpriseReasoningRequests.complete(senderId, requestId, controller);
            }
          }
        } catch (err) {
          debugLogger.error("Enterprise reasoning error:", err);
          const mappingConfig =
            runtime?.provider === "bedrock" && runtime.enterprise?.bedrockRegion
              ? { ...(config || {}), bedrockRegion: runtime.enterprise.bedrockRegion }
              : config || {};
          const mapped = mapEnterpriseError(provider, err, mappingConfig);
          return {
            success: false,
            error: mapped.message,
            messageKey: mapped.messageKey,
            messageParams: mapped.messageParams,
            action: mapped.action,
            actionKey: mapped.actionKey,
            copyCommand: mapped.copyCommand,
            retryable: mapped.retryable,
            technicalDetails: mapped.technicalDetails,
          };
        }
      }
    );

    ipcMain.on("enterprise-reasoning-cancel", (event) => {
      this._enterpriseReasoningRequests.cancelSender(event.sender.id);
    });

    // Runs doStream for the renderer's enterprise chat model shim; parts are
    // relayed verbatim over enterprise-stream-part, ending with {done}/{error}.
    this.enterpriseStreamAborts = new Map();
    ipcMain.handle("enterprise-stream-start", async (event, payload) => {
      const {
        isEnterpriseProvider,
        mapEnterpriseError,
        validateEnterpriseEndpoint,
      } = require("./enterpriseProviderErrors");
      const { streamId, provider, modelId, config, options } = payload || {};
      let runtime;
      const send = (message) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("enterprise-stream-part", { streamId, ...message });
        }
      };
      const abortController = new AbortController();
      this.enterpriseStreamAborts.set(streamId, abortController);
      // isDestroyed() stays false across reload/navigation, which wipes the
      // renderer listeners — abort so the provider request isn't billed for
      // a generation nobody receives.
      const abortOnGone = (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) abortController.abort();
      };
      const abortOnDestroyed = () => abortController.abort();
      event.sender.on("did-start-navigation", abortOnGone);
      event.sender.once("destroyed", abortOnDestroyed);
      try {
        if (!streamId || !isEnterpriseProvider(provider)) {
          throw new Error(`Unsupported enterprise provider: ${provider}`);
        }
        runtime = await resolveEnterpriseRuntime(event, provider, modelId, config || {});
        if (!runtime.model) throw new Error("No model specified for enterprise streaming");
        validateEnterpriseEndpoint(runtime.enterprise.azureEndpoint);

        const { getEnterpriseAIModel } = require("./enterpriseAiProviders");
        const model = await getEnterpriseAIModel(
          runtime.provider,
          runtime.model,
          runtime.apiKey,
          runtime.enterprise
        );

        const { stream } = await model.doStream({
          ...options,
          abortSignal: abortController.signal,
        });
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (event.sender.isDestroyed()) {
              abortController.abort();
              break;
            }
            send({ part: value });
          }
        } finally {
          reader.releaseLock();
        }
        send({ done: true });
        return { success: true };
      } catch (err) {
        debugLogger.error("Enterprise stream error:", err);
        const mappingConfig =
          runtime?.provider === "bedrock" && runtime.enterprise?.bedrockRegion
            ? { ...(config || {}), bedrockRegion: runtime.enterprise.bedrockRegion }
            : config || {};
        const mapped = mapEnterpriseError(provider, err, mappingConfig);
        send({ error: mapped.message });
        return { success: false, error: mapped.message };
      } finally {
        this.enterpriseStreamAborts.delete(streamId);
        if (!event.sender.isDestroyed()) {
          event.sender.removeListener("did-start-navigation", abortOnGone);
          event.sender.removeListener("destroyed", abortOnDestroyed);
        }
      }
    });

    ipcMain.handle("enterprise-stream-cancel", async (event, streamId) => {
      this.enterpriseStreamAborts.get(streamId)?.abort();
      this.enterpriseStreamAborts.delete(streamId);
    });

    // Lists the text models the account serves in the selected region,
    // resolved to invocable IDs (bare on-demand or geo-scoped profile IDs).
    ipcMain.handle("bedrock-list-models", async (event, config) => {
      const { mapEnterpriseError } = require("./enterpriseProviderErrors");
      try {
        const runtime = await resolveEnterpriseRuntime(
          event,
          "bedrock",
          config?.model || "test",
          config
        );
        const {
          BedrockClient,
          ListFoundationModelsCommand,
          paginateListInferenceProfiles,
        } = require("@aws-sdk/client-bedrock");
        const { normalizeBedrockCatalog } = require("./bedrockCatalog");

        const region = runtime.enterprise.bedrockRegion || "us-east-1";
        let credentials;
        if (runtime.enterprise.managedCredentialProvider) {
          credentials = runtime.enterprise.managedCredentialProvider;
        } else if (runtime.enterprise.bedrockProfile) {
          const { fromNodeProviderChain } = require("@aws-sdk/credential-providers");
          credentials = fromNodeProviderChain({ profile: runtime.enterprise.bedrockProfile });
        } else if (
          runtime.enterprise.bedrockAccessKeyId &&
          runtime.enterprise.bedrockSecretAccessKey
        ) {
          credentials = {
            accessKeyId: runtime.enterprise.bedrockAccessKeyId,
            secretAccessKey: runtime.enterprise.bedrockSecretAccessKey,
            sessionToken: runtime.enterprise.bedrockSessionToken || undefined,
          };
        }
        const client = new BedrockClient({ region, ...(credentials ? { credentials } : {}) });

        const [foundationModels, profileSummaries] = await Promise.all([
          client.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" })),
          (async () => {
            const summaries = [];
            const paginator = paginateListInferenceProfiles(
              { client },
              { typeEquals: "SYSTEM_DEFINED" }
            );
            for await (const page of paginator) {
              summaries.push(...(page.inferenceProfileSummaries || []));
            }
            return summaries;
          })(),
        ]);

        return {
          success: true,
          models: normalizeBedrockCatalog(foundationModels.modelSummaries, profileSummaries),
        };
      } catch (err) {
        debugLogger.error("Bedrock model listing error:", err);
        const mapped = mapEnterpriseError("bedrock", err, config || {});
        return { success: false, error: mapped.message };
      }
    });

    ipcMain.handle("get-dictation-key", async () => {
      return this.environmentManager.getDictationKey();
    });

    ipcMain.handle("save-dictation-key", async (event, key) => {
      return this.environmentManager.saveDictationKey(key);
    });

    ipcMain.handle("get-active-dictation-key", async () => {
      const hotkeys = this.windowManager?.hotkeyManager?.getSlotHotkeys?.("dictation") ?? [];
      return hotkeys.length > 0 ? hotkeys.join(",") : null;
    });

    ipcMain.handle("get-effective-default-hotkey", async () => {
      return this.windowManager?.hotkeyManager?.getEffectiveDefaultHotkey() ?? null;
    });

    ipcMain.handle("get-activation-mode", async () => {
      return this.environmentManager.getActivationMode();
    });

    ipcMain.handle("save-activation-mode", async (event, mode) => {
      return this.environmentManager.saveActivationMode(mode);
    });

    ipcMain.handle("get-ui-language", async () => {
      return this.environmentManager.getUiLanguage();
    });

    ipcMain.handle("save-ui-language", async (event, language) => {
      return this.environmentManager.saveUiLanguage(language);
    });

    ipcMain.handle("set-ui-language", async (event, language) => {
      const result = this.environmentManager.saveUiLanguage(language);
      process.env.UI_LANGUAGE = result.language;
      changeLanguage(result.language);
      this.windowManager?.refreshLocalizedUi?.();
      this.getTrayManager?.()?.updateTrayMenu?.();
      return { success: true, language: result.language };
    });

    ipcMain.handle("save-all-keys-to-env", async () => {
      return this.environmentManager.saveAllKeysToEnvFile();
    });

    ipcMain.handle("sync-startup-preferences", async (event, prefs) => {
      const setVars = {};
      const clearVars = [];

      if (prefs.useLocalWhisper && prefs.model) {
        // Local mode with model selected - set provider and model for pre-warming
        setVars.LOCAL_TRANSCRIPTION_PROVIDER = prefs.localTranscriptionProvider;
        if (prefs.language) setVars.DICTATION_LANGUAGE = prefs.language;
        if (isSherpaLocalProvider(prefs.localTranscriptionProvider)) {
          setVars.PARAKEET_MODEL = prefs.model;
          clearVars.push("LOCAL_WHISPER_MODEL");
          this.whisperManager.stopServer().catch((err) => {
            debugLogger.error("Failed to stop whisper-server on provider switch", {
              error: err.message,
            });
          });
        } else {
          setVars.LOCAL_WHISPER_MODEL = prefs.model;
          clearVars.push("PARAKEET_MODEL");
          this.parakeetManager.stopServer().catch((err) => {
            debugLogger.error("Failed to stop parakeet-server on provider switch", {
              error: err.message,
            });
          });
        }
      } else if (prefs.useLocalWhisper) {
        // Local mode enabled but no model selected - clear pre-warming vars
        clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");
      } else {
        // Cloud mode - stop local servers to free RAM
        clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");
        this.whisperManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop whisper-server on cloud switch", {
            error: err.message,
          });
        });
        this.parakeetManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop parakeet-server on cloud switch", {
            error: err.message,
          });
        });
      }

      const localServer = resolveLocalServerNeeds(prefs);

      if (localServer.cleanup) {
        setVars.CLEANUP_PROVIDER = "local";
        setVars.LOCAL_CLEANUP_MODEL = localServer.cleanup;
      } else {
        clearVars.push("CLEANUP_PROVIDER", "LOCAL_CLEANUP_MODEL");
      }
      // TODO: drop legacy REASONING_PROVIDER / LOCAL_REASONING_MODEL clears once
      // the read fallback is removed (~2 releases after this lands).
      clearVars.push("REASONING_PROVIDER", "LOCAL_REASONING_MODEL");

      if (localServer.dictationAgent) {
        setVars.DICTATION_AGENT_PROVIDER = "local";
        setVars.LOCAL_DICTATION_AGENT_MODEL = localServer.dictationAgent;
      } else {
        clearVars.push("DICTATION_AGENT_PROVIDER", "LOCAL_DICTATION_AGENT_MODEL");
      }

      // Stop the shared llama-server only when neither scope still needs it, so
      // the active scope keeps its server when the other one switches away.
      if (localServer.stopServer) {
        const modelManager = require("./modelManagerBridge").default;
        modelManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop llama-server on provider switch", {
            error: err.message,
          });
        });
      }

      this._syncStartupEnv(setVars, clearVars);
    });

    ipcMain.handle("process-local-reasoning", async (event, text, modelId, _agentName, config) => {
      try {
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        const result = await LocalReasoningService.processText(text, modelId, config);
        return { success: true, text: result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle(
      "process-anthropic-reasoning",
      async (event, text, modelId, _agentName, config) => {
        try {
          const apiKey = this.environmentManager.getAnthropicKey();

          if (!apiKey) {
            throw new Error("Anthropic API key not configured");
          }

          const systemPrompt = config?.systemPrompt || "";
          const userPrompt = text;

          if (!modelId) {
            throw new Error("No model specified for Anthropic API call");
          }

          const screenContext = config?.screenContext;
          const userContent = screenContext
            ? [
                { type: "text", text: userPrompt },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: screenContext.mediaType,
                    data: screenContext.data,
                  },
                },
              ]
            : userPrompt;

          // Claude models from Opus 4.7 onward reject `temperature` with a 400;
          // the renderer derives support from the model registry.
          const useTemperature = config?.supportsTemperature === true;
          const requestBody = {
            model: modelId,
            messages: [{ role: "user", content: userContent }],
            system: systemPrompt,
            max_tokens: config?.maxTokens || Math.max(100, Math.min(text.length * 2, 4096)),
            ...(useTemperature ? { temperature: config?.temperature ?? 0.3 } : {}),
          };

          const response = await proxyFetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(requestBody),
          });

          if (!response.ok) {
            const errorText = await response.text();
            let errorData = { error: response.statusText };
            try {
              errorData = JSON.parse(errorText);
            } catch {
              errorData = { error: errorText || response.statusText };
            }
            throw new Error(
              errorData.error?.message ||
                errorData.error ||
                `Anthropic API error: ${response.status}`
            );
          }

          const data = await response.json();
          if (config?.requireCompleteOutput && data.stop_reason === "max_tokens") {
            throw new Error("Model output was truncated before the selection edit completed");
          }
          const outputText = extractAnthropicText(data);
          if (outputText === null) {
            throw new Error(describeMissingAnthropicText(data));
          }
          return { success: true, text: outputText };
        } catch (error) {
          debugLogger.error("Anthropic reasoning error:", error);
          return { success: false, error: error.message };
        }
      }
    );

    ipcMain.handle("check-local-reasoning-available", async () => {
      try {
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        return await LocalReasoningService.isAvailable();
      } catch (error) {
        return false;
      }
    });

    ipcMain.handle("llama-cpp-check", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const isInstalled = await llamaCppInstaller.isInstalled();
        const version = isInstalled ? await llamaCppInstaller.getVersion() : null;
        return { isInstalled, version };
      } catch (error) {
        return { isInstalled: false, error: error.message };
      }
    });

    ipcMain.handle("llama-cpp-install", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const result = await llamaCppInstaller.install();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-cpp-uninstall", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const result = await llamaCppInstaller.uninstall();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-start", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        modelManager.ensureInitialized();
        const modelInfo = modelManager.findModelById(modelId);
        if (!modelInfo) {
          return { success: false, error: `Model "${modelId}" not found` };
        }

        const modelPath = require("path").join(modelManager.modelsDir, modelInfo.model.fileName);

        await modelManager.serverManager.start(
          modelPath,
          await modelManager.serverStartOptions(modelInfo)
        );
        modelManager.currentServerModelId = modelId;

        this.environmentManager.saveAllKeysToEnvFile().catch(() => {});
        return { success: true, port: modelManager.serverManager.port };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-stop", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.stopServer();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-status", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        return modelManager.getServerStatus();
      } catch (error) {
        return { available: false, running: false, error: error.message };
      }
    });

    ipcMain.handle("llama-gpu-reset", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const previousModelId = modelManager.currentServerModelId;
        modelManager.serverManager.resetGpuDetection();
        await modelManager.stopServer();

        // Restart server with previous model so Vulkan binary is picked up
        if (previousModelId) {
          modelManager.prewarmServer(previousModelId).catch(() => {});
        }

        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("detect-vulkan-gpu", async () => {
      try {
        const { detectVulkanGpu } = require("../utils/vulkanDetection");
        return await detectVulkanGpu();
      } catch (error) {
        return { available: false, error: error.message };
      }
    });

    ipcMain.handle("get-llama-vulkan-status", async () => {
      try {
        if (!this._llamaVulkanManager) {
          const LlamaVulkanManager = require("./llamaVulkanManager");
          this._llamaVulkanManager = new LlamaVulkanManager();
        }
        return this._llamaVulkanManager.getStatus();
      } catch (error) {
        return { supported: false, downloaded: false, error: error.message };
      }
    });

    ipcMain.handle("download-llama-vulkan-binary", async (event) => {
      try {
        if (!this._llamaVulkanManager) {
          const LlamaVulkanManager = require("./llamaVulkanManager");
          this._llamaVulkanManager = new LlamaVulkanManager();
        }

        // Stop Vulkan server before downloading to release file locks on DLLs (Windows EBUSY)
        const modelManager = require("./modelManagerBridge").default;
        if (modelManager.serverManager.activeBackend === "vulkan") {
          await modelManager.stopServer().catch((err) => {
            debugLogger.warn("Failed to stop Vulkan server before download", {
              error: err.message,
            });
          });
        }

        const result = await this._llamaVulkanManager.download((downloaded, total) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("llama-vulkan-download-progress", {
              downloaded,
              total,
              percentage: total > 0 ? Math.round((downloaded / total) * 100) : 0,
            });
          }
        });

        if (result.success) {
          process.env.LLAMA_VULKAN_ENABLED = "true";
          delete process.env.LLAMA_GPU_BACKEND;
          modelManager.serverManager.cachedServerBinaryPaths = null;
          await this.environmentManager.saveAllKeysToEnvFile().catch(() => {});
          // Stop server so next inference picks up the new Vulkan binary
          await modelManager.stopServer().catch(() => {});
        }

        return result;
      } catch (error) {
        debugLogger.error("Vulkan binary download failed", {
          error: error.message,
          stack: error.stack,
        });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cancel-llama-vulkan-download", async () => {
      if (this._llamaVulkanManager) {
        return { success: this._llamaVulkanManager.cancelDownload() };
      }
      return { success: false };
    });

    ipcMain.handle("delete-llama-vulkan-binary", async () => {
      try {
        if (!this._llamaVulkanManager) {
          const LlamaVulkanManager = require("./llamaVulkanManager");
          this._llamaVulkanManager = new LlamaVulkanManager();
        }

        const modelManager = require("./modelManagerBridge").default;
        if (modelManager.serverManager.activeBackend === "vulkan") {
          await modelManager.stopServer();
        }

        const result = await this._llamaVulkanManager.deleteBinary();

        delete process.env.LLAMA_VULKAN_ENABLED;
        delete process.env.LLAMA_GPU_BACKEND;
        modelManager.serverManager.cachedServerBinaryPaths = null;
        this.environmentManager.saveAllKeysToEnvFile().catch(() => {});

        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-log-level", async () => {
      return debugLogger.getLevel();
    });

    ipcMain.handle("app-log", async (event, entry) => {
      debugLogger.logEntry(entry);
      return { success: true };
    });

    const SYSTEM_SETTINGS_URLS = {
      darwin: {
        microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        sound: "x-apple.systempreferences:com.apple.preference.sound?input",
        accessibility:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        systemAudio:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        screenRecording:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        calendars: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
        loginItems: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
      },
      win32: {
        microphone: "ms-settings:privacy-microphone",
        sound: "ms-settings:sound",
        loginItems: "ms-settings:startupapps",
      },
    };

    const openSystemSettings = async (settingType) => {
      const platform = process.platform;
      const urls = SYSTEM_SETTINGS_URLS[platform];
      const url = urls?.[settingType];

      if (!url) {
        // Platform doesn't support this settings URL
        const messages = {
          microphone: i18nMain.t("systemSettings.microphone"),
          sound: i18nMain.t("systemSettings.sound"),
          accessibility: i18nMain.t("systemSettings.accessibility"),
          systemAudio: i18nMain.t("systemSettings.systemAudio"),
          screenRecording: i18nMain.t("systemSettings.screenRecording"),
          loginItems: i18nMain.t("systemSettings.loginItems"),
        };
        return {
          success: false,
          error:
            messages[settingType] || `${settingType} settings are not available on this platform.`,
        };
      }

      try {
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        debugLogger.error(`Failed to open ${settingType} settings:`, error);
        return { success: false, error: error.message };
      }
    };

    ipcMain.handle("open-microphone-settings", () => openSystemSettings("microphone"));
    ipcMain.handle("open-sound-input-settings", () => openSystemSettings("sound"));
    ipcMain.handle("get-system-default-microphone", (_event, options = {}) =>
      resolveSystemDefaultMicrophone({ refresh: options?.refresh === true })
    );
    ipcMain.handle("open-accessibility-settings", () => openSystemSettings("accessibility"));
    ipcMain.handle("open-system-audio-settings", () => openSystemSettings("systemAudio"));
    ipcMain.handle("open-screen-recording-settings", () => openSystemSettings("screenRecording"));
    ipcMain.handle("open-login-items-settings", () => openSystemSettings("loginItems"));

    ipcMain.handle("capture-screen-context", async (event) => {
      // Capture immediately so the screenshot reflects the invocation moment;
      // the policy verdict resolves concurrently and decides whether to
      // return it. A signed-out user has no workspace and no policy; managed
      // users are gated even if a stale renderer asks. null matches capture's
      // contract — a screenshot must never break the dictation it accompanies.
      // The target's window rect picks the display it is on rather than the one
      // under the cursor, and the panel reposition has normally cached it already.
      // A failed rect read falls back to the cursor rather than rejecting: the
      // policy branch below can abandon this promise, and capture's contract is
      // to yield null, never to throw.
      const targetPid = this.textEditMonitor?.lastTargetPid;
      const capturePromise = Promise.resolve(
        targetPid ? this.textEditMonitor.getTargetWindowBounds?.(targetPid) : null
      )
        .catch(() => null)
        .then((targetBounds) => screenContextCapture.captureActiveDisplay(targetBounds));
      const authHeaders = await getAuthHeader(event);
      if (authHeaders.Authorization || authHeaders.Cookie) {
        // Bound the verdict wait: a lapsed policy TTL on a degraded network
        // must not stall an allowed user's capture past the renderer's 3s
        // consume race. The renderer gate already fails closed while policy
        // is unresolved, so this defense-in-depth gate lets an unresolved
        // verdict through while the refresh completes in flight — a resolved
        // denial (cached or fresh) still blocks.
        const snapshot = await Promise.race([
          workspacePolicyManager.getPolicy({
            expectedAuthGeneration: tokenStore.getState().generation,
            authHeaders,
          }),
          new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        if (snapshot && isScreenContextBlocked(snapshot)) {
          debugLogger.warn(
            "Screen context capture blocked by org policy",
            { code: snapshot.code ?? null },
            "screenContext"
          );
          return null;
        }
      }
      return capturePromise;
    });

    // Snapshot the launch-time TCC status so a mid-session grant (which macOS
    // only honors after a relaunch) is detectable even if the renderer never
    // checked before the user granted.
    screenContextCapture.getAccessStatus();

    ipcMain.handle("check-screen-recording-access", () => screenContextCapture.getAccessResult());

    ipcMain.handle("request-screen-recording-access", async () => {
      const status = await screenContextCapture.requestAccess();
      if (process.platform === "darwin" && status !== "granted") {
        await openSystemSettings("screenRecording");
      }
      return screenContextCapture.getAccessResult();
    });

    // Preserve the renderer setting while app-wide content protection is
    // temporarily disabled for screen recording.
    ipcMain.handle("screen-context-set-enabled", (event, enabled) => {
      this.windowManager?.setScreenContextProtection(enabled);
      return { success: true };
    });

    // Panel open: window becomes focusable so follow-up keyboard input works.
    // Only the dictation renderer may flip main-window focusability.
    ipcMain.handle("set-assistant-panel-open", (event, open) => {
      const dictationWindow = this.windowManager?.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return { success: false, error: "Not the dictation window" };
      }
      this.windowManager.setAssistantPanelOpen(open);
      return { success: true };
    });

    // Busy state is enforced in the main process so a hotkey cannot trigger
    // native capture side effects before the renderer has a chance to reject it.
    ipcMain.handle("set-assistant-panel-busy", (event, busy) => {
      const dictationWindow = this.windowManager?.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return { success: false, error: "Not the dictation window" };
      }
      this.windowManager.setAssistantPanelBusy(busy);
      return { success: true };
    });

    const isAgentDictationPill = (event) => {
      const pillWindow = this.windowManager?.agentDictationPillWindow;
      return pillWindow && !pillWindow.isDestroyed() && event.sender === pillWindow.webContents;
    };

    // The pill disables its own controls when an assistant or translation
    // capture owns the lifecycle, but that state travels by IPC — a click can
    // race it. Re-check here so a stale pill can never toggle or cancel a
    // recording it does not own.
    const isAgentDictationPillInteractive = () =>
      this.windowManager.getAgentDictationPillState().interactive;

    ipcMain.handle("toggle-agent-panel-dictation", (event) => {
      if (!isAgentDictationPill(event) || !isAgentDictationPillInteractive()) {
        return { success: false };
      }
      this.windowManager.sendToggleDictation();
      return { success: true };
    });

    ipcMain.handle("cancel-agent-panel-dictation", (event) => {
      if (!isAgentDictationPill(event) || !isAgentDictationPillInteractive()) {
        return { success: false };
      }
      this.windowManager.sendCancelActiveDictation();
      return { success: true };
    });

    ipcMain.handle("get-agent-dictation-pill-state", (event) => {
      return isAgentDictationPill(event)
        ? this.windowManager.getAgentDictationPillState()
        : { lifecycle: "idle", interactive: false, horizontalDirection: "left" };
    });

    ipcMain.handle("resize-agent-dictation-pill-to-content", (event, surfaceHeight = null) => {
      if (!isAgentDictationPill(event)) return { success: false };
      return this.windowManager.resizeAgentDictationPillToContent(surfaceHeight);
    });

    ipcMain.handle("set-agent-dictation-pill-interactivity", (event, interactive) => {
      if (!isAgentDictationPill(event)) return { success: false };
      this.windowManager.setAgentDictationPillInteractivity(Boolean(interactive));
      return { success: true };
    });

    ipcMain.handle("open-calendar-privacy-settings", () => openSystemSettings("calendars"));

    ipcMain.handle("show-emoji-panel", () => {
      try {
        if (app.isEmojiPanelSupported()) {
          app.showEmojiPanel();
          return true;
        }
      } catch (error) {
        debugLogger.error("Failed to show native emoji panel:", error);
      }
      return false;
    });

    ipcMain.handle("toggle-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.toggleMedia();
    });

    ipcMain.handle("pause-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.pauseMedia();
    });

    ipcMain.handle("resume-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.resumeMedia();
    });

    ipcMain.handle("request-microphone-access", async () => {
      if (process.platform !== "darwin") {
        return { granted: true, status: "granted" };
      }
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return { granted };
    });

    ipcMain.handle("check-microphone-access", () => {
      if (process.platform !== "darwin") {
        return { granted: true, status: "granted" };
      }
      const status = systemPreferences.getMediaAccessStatus("microphone");
      return { granted: status === "granted", status };
    });

    const buildSystemAudioAccess = (partial = {}) => ({
      granted: false,
      status: "unsupported",
      mode: "unsupported",
      supportsPersistentGrant: false,
      supportsPersistentPortalGrant: false,
      supportsNativeCapture: false,
      supportsOnboardingGrant: false,
      requiresRuntimeSharePrompt: false,
      strategy: "unsupported",
      restoreTokenAvailable: false,
      portalVersion: null,
      ...partial,
    });

    const getLinuxSystemAudioAccess = async () => {
      const capability = await this.linuxPortalAudioManager?.getCapability().catch((error) => ({
        available: false,
        supportsPersistentGrant: false,
        supportsPersistentPortalGrant: false,
        supportsSystemAudio: false,
        supportsNativeCapture: false,
        portalVersion: null,
        error: error.message,
      }));
      const available = !!capability?.available;
      const supportsSystemAudio = !!capability?.supportsSystemAudio;
      const supportsNativeCapture = !!capability?.supportsNativeCapture;
      const granted = available && supportsSystemAudio && supportsNativeCapture;
      const helperError =
        typeof capability?.error === "string" &&
        !capability.error.includes("helper binary not found")
          ? capability.error
          : undefined;

      return buildSystemAudioAccess({
        granted,
        status: granted ? "granted" : "unknown",
        mode: granted ? "loopback" : "unsupported",
        supportsNativeCapture,
        strategy: granted ? "pipewire-loopback" : "unsupported",
        portalVersion: capability?.portalVersion ?? null,
        error: helperError,
      });
    };

    // System audio is always capturable on Windows: via the native WASAPI
    // process-loopback helper when available (hears every output device),
    // otherwise via Chromium's default-device loopback in the renderer.
    const getWindowsSystemAudioAccess = async ({ refreshCapability = false } = {}) => {
      const capability = await this.windowsLoopbackAudioManager
        ?.getCapability({ force: refreshCapability })
        .catch(() => ({
          available: false,
        }));
      const helperAvailable = !!capability?.available;

      return buildSystemAudioAccess({
        granted: true,
        status: "granted",
        mode: "loopback",
        supportsNativeCapture: helperAvailable,
        strategy: helperAvailable ? "wasapi-loopback" : "loopback",
      });
    };

    const getSystemAudioAccess = async () => {
      if (process.platform === "win32") {
        return getWindowsSystemAudioAccess();
      }

      if (process.platform === "linux") {
        return getLinuxSystemAudioAccess();
      }

      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      const result = this.audioTapManager.checkAccess();
      return buildSystemAudioAccess({
        granted: result.granted,
        status: result.status,
        mode: "native",
        strategy: "native",
      });
    };

    ipcMain.handle("check-system-audio-access", () => getSystemAudioAccess());

    ipcMain.handle("request-system-audio-access", async () => {
      if (process.platform === "win32") {
        return getWindowsSystemAudioAccess();
      }

      if (process.platform === "linux") {
        return getLinuxSystemAudioAccess();
      }

      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      try {
        const result = await this.audioTapManager.requestAccess();
        if (result.granted) {
          return buildSystemAudioAccess({
            granted: true,
            status: "granted",
            mode: "native",
            strategy: "native",
          });
        }
      } catch {
        // Falls through to opening System Settings
      }

      await openSystemSettings("systemAudio");
      const status = this.audioTapManager.getPermissionStatus();
      return buildSystemAudioAccess({
        granted: false,
        status,
        mode: "native",
        strategy: "native",
      });
    });

    ipcMain.handle("auth-clear-session", async (event) => {
      try {
        const tokenState = tokenStore.clear();
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
          await win.webContents.session.clearStorageData({ storages: ["cookies"] });
        }
        return {
          success: tokenState.success,
          tokenState,
          ...(tokenState.success ? {} : { error: "Could not clear persisted bearer token" }),
        };
      } catch (error) {
        debugLogger.error("Failed to clear auth session:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("auth-get-token", () => tokenStore.get());
    ipcMain.handle("auth-get-token-state", () => tokenStore.getState());
    ipcMain.handle("auth-set-token", (_event, token, expectedGeneration) => {
      if (typeof token !== "string" || !token) {
        // Surface silent rotation-to-empty so we can spot regressions where the
        // renderer thinks it's persisting a token but the value never lands.
        debugLogger.debug("auth-set-token ignored: empty or non-string token", {
          type: typeof token,
        });
        return {
          success: false,
          code: "AUTH_CONTEXT_UNVALIDATED",
          ...tokenStore.getState(),
        };
      }
      return tokenStore.setIfGeneration(token, expectedGeneration);
    });

    // In production, VITE_* env vars aren't available in the main process because
    // Vite only inlines them into the renderer bundle at build time. Load the
    // runtime-env.json that the Vite build writes to src/dist/ as a fallback.
    const runtimeEnv = (() => {
      const fs = require("fs");
      const envPath = path.join(__dirname, "..", "dist", "runtime-env.json");
      try {
        if (fs.existsSync(envPath)) return JSON.parse(fs.readFileSync(envPath, "utf8"));
      } catch {}
      return {};
    })();

    const getApiUrl = () =>
      process.env.OPENWHISPR_API_URL ||
      process.env.VITE_OPENWHISPR_API_URL ||
      runtimeEnv.VITE_OPENWHISPR_API_URL ||
      "";

    const getAuthUrl = () =>
      process.env.AUTH_URL ||
      process.env.VITE_AUTH_URL ||
      runtimeEnv.VITE_AUTH_URL ||
      "https://auth.openwhispr.com";

    const getSessionCookiesFromWindow = async (win) => {
      const scopedUrls = [getAuthUrl(), getApiUrl()].filter(Boolean);
      const cookiesByName = new Map();

      for (const url of scopedUrls) {
        try {
          const scopedCookies = await win.webContents.session.cookies.get({ url });
          for (const cookie of scopedCookies) {
            if (!cookiesByName.has(cookie.name)) {
              cookiesByName.set(cookie.name, cookie.value);
            }
          }
        } catch (error) {
          debugLogger.warn("Failed to read scoped auth cookies", {
            url,
            error: error.message,
          });
        }
      }

      // Fallback for older sessions where cookies are not URL-scoped as expected.
      if (cookiesByName.size === 0) {
        const allCookies = await win.webContents.session.cookies.get({});
        for (const cookie of allCookies) {
          if (!cookiesByName.has(cookie.name)) {
            cookiesByName.set(cookie.name, cookie.value);
          }
        }
      }

      const cookieHeader = [...cookiesByName.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");

      debugLogger.debug(
        "Resolved auth cookies for cloud request",
        {
          cookieCount: cookiesByName.size,
          scopedUrls,
        },
        "auth"
      );

      return cookieHeader;
    };

    const getSessionCookies = async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return "";
      return getSessionCookiesFromWindow(win);
    };

    // Bearer auth is preferred. Cookie fallback covers the brief window before
    // main.js's startup migration bridge runs (or if it failed for this user).
    const getAuthHeaderFromWindow = async (win) => {
      const token = tokenStore.get();
      if (token) return { Authorization: `Bearer ${token}` };
      const cookieHeader = win ? await getSessionCookiesFromWindow(win) : "";
      return cookieHeader ? { Cookie: cookieHeader } : {};
    };

    const getAuthHeader = async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      return getAuthHeaderFromWindow(win);
    };

    // Honors system proxy via Electron's net stack. useSessionCookies:false so
    // Electron doesn't auto-attach jar cookies on top of our explicit headers.
    const proxyFetch = (url, init = {}) => net.fetch(url, { ...init, useSessionCookies: false });
    const withPolicyHeaders = (headers) => withPolicyRequestHeaders(headers, app.getVersion());
    const handleCloudApiRequest = createCloudApiRequestHandler({
      getApiUrl,
      getAppVersion: () => app.getVersion(),
      proxyFetch,
      tokenStore,
      logger: debugLogger,
    });
    const workspacePolicyManager = createWorkspacePolicyManager({
      cachePath: path.join(app.getPath("userData"), "workspace-policy.json"),
      getApiUrl,
      getAppVersion: () => app.getVersion(),
      proxyFetch,
      tokenStore,
      broadcast: (snapshot) => broadcastToWindows("workspace-policy-changed", snapshot),
      logger: debugLogger,
    });
    this.enterpriseIdentityManager = createEnterpriseIdentityManager({
      cachePath: path.join(app.getPath("userData"), "managed-enterprise-config.json"),
      getApiUrl,
      getAppVersion: () => app.getVersion(),
      proxyFetch,
      tokenStore,
      broadcast: (snapshot) => broadcastToWindows("managed-enterprise-config-changed", snapshot),
      logger: debugLogger,
    });
    const resolveEnterpriseRuntime = async (event, provider, model, config = {}) => {
      const manual = {
        provider,
        model,
        apiKey: config.apiKey || "",
        enterprise: require("./enterpriseProviderErrors").pickEnterpriseConfig(config),
      };
      const context = config.managedContext;
      if (!context) return manual;
      const authHeaders = await getAuthHeader(event);
      const resolved = await this.enterpriseIdentityManager.resolveProvider({
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        expectedAuthGeneration: context.authGeneration,
        inferenceScope: context.inferenceScope,
        setupMode: context.setupMode,
        authHeaders,
      });
      if (!resolved.managed) {
        throw Object.assign(
          new Error("Managed enterprise configuration changed. Retry the request."),
          { code: "MANAGED_CONFIG_CHANGED" }
        );
      }
      if (
        resolved.provider !== context.provider ||
        resolved.generation !== context.generation ||
        resolved.version !== context.providerVersion
      ) {
        throw Object.assign(
          new Error("Managed enterprise configuration changed. Retry the request."),
          { code: "MANAGED_CONFIG_CHANGED" }
        );
      }
      if (resolved.provider === "bedrock") {
        return {
          provider: resolved.provider,
          model: resolved.model,
          apiKey: "",
          enterprise: {
            bedrockRegion: resolved.config.region,
            managedCredentialProvider: resolved.credentialProvider,
          },
        };
      }
      return {
        provider: resolved.provider,
        model: resolved.model,
        apiKey: "",
        enterprise: {
          azureEndpoint: resolved.config.endpoint,
          azureApiVersion: resolved.config.apiVersion,
          managedTokenProvider: resolved.tokenProvider,
        },
      };
    };
    const handleSttConfigRequest = createCloudConfigRequestHandler({
      getApiUrl,
      getAuthHeader,
      proxyFetch,
      withPolicyHeaders,
      logger: debugLogger,
      configPath: "stt-config",
    });
    const handleNoteRecordingConfigRequest = createCloudConfigRequestHandler({
      getApiUrl,
      getAuthHeader,
      proxyFetch,
      withPolicyHeaders,
      logger: debugLogger,
      configPath: "note-recording-config",
    });

    ipcMain.handle("cloud-transcribe", async (event, audioBuffer, opts = {}) => {
      const sender = event.sender;
      const senderId = sender.id;
      const requestId = crypto.randomUUID();
      const controller = this._cloudTranscriptionRequests.begin(senderId, requestId);
      const cancelSenderRequests = () => this._cloudTranscriptionRequests.cancelSender(senderId);
      sender.once("destroyed", cancelSenderRequests);
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        const audioData = Buffer.from(audioBuffer);
        // Reused for the local SQLite row so SyncService upserts the existing
        // cloud row (filling in text) instead of creating a duplicate.
        const clientTranscriptionId = crypto.randomUUID();
        const multipartFields = {
          language: opts.language,
          prompt: opts.prompt,
          sendLogs: opts.sendLogs,
          clientType: "desktop",
          appVersion: app.getVersion(),
          clientVersion: app.getVersion(),
          sessionId: this.sessionId,
          clientTranscriptionId,
        };

        debugLogger.debug("Cloud transcribe request", { audioSize: audioData.length }, "cloud-api");

        if (audioData.length > CLOUD_INLINE_LIMIT) {
          const { text, responses, lastResponse, warning } = await chunkedCloudTranscribe({
            buffer: audioData,
            apiUrl,
            policyHeaders: withPolicyHeaders(authHeader),
            multipartFields,
            signal: controller.signal,
          });
          const sum = (field) => responses.reduce((s, r) => s + (r?.[field] || 0), 0);
          return {
            success: true,
            text,
            ...(warning ? { warning } : {}),
            clientTranscriptionId,
            wordsUsed: lastResponse?.wordsUsed,
            wordsRemaining: lastResponse?.wordsRemaining,
            plan: lastResponse?.plan,
            limitReached: lastResponse?.limitReached || false,
            sttProvider: lastResponse?.sttProvider,
            sttModel: lastResponse?.sttModel,
            sttProcessingMs: sum("sttProcessingMs"),
            sttWordCount: sum("sttWordCount"),
            sttLanguage: lastResponse?.sttLanguage,
            audioDurationMs: sum("audioDurationMs"),
          };
        }

        const { body, boundary } = buildMultipartBody(
          audioData,
          "audio.webm",
          "audio/webm",
          multipartFields
        );
        const url = new URL(`${apiUrl}/api/transcribe`);
        const data = await postMultipart(url, body, boundary, withPolicyHeaders(authHeader), {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(CLOUD_UPLOAD_TIMEOUT_MS),
          ]),
          session: getInlineCloudUploadSession(),
        });

        debugLogger.debug(
          "Cloud transcribe response",
          { statusCode: data.statusCode },
          "cloud-api"
        );

        const result = interpretTranscribeResponse(data);
        return {
          success: true,
          text: result.text,
          clientTranscriptionId,
          wordsUsed: result.wordsUsed,
          wordsRemaining: result.wordsRemaining,
          plan: result.plan,
          limitReached: result.limitReached || false,
          sttProvider: result.sttProvider,
          sttModel: result.sttModel,
          sttProcessingMs: result.sttProcessingMs,
          sttWordCount: result.sttWordCount,
          sttLanguage: result.sttLanguage,
          audioDurationMs: result.audioDurationMs,
        };
      } catch (error) {
        if (controller.signal.aborted) {
          return { success: false, error: "Cancelled", code: "TRANSCRIPTION_CANCELLED" };
        }
        debugLogger.error("Cloud transcription error", { error: error.message }, "cloud-api");
        return toPolicyFailure(error);
      } finally {
        sender.removeListener("destroyed", cancelSenderRequests);
        this._cloudTranscriptionRequests.complete(senderId, requestId, controller);
      }
    });

    ipcMain.on("cloud-transcribe-cancel", (event) => {
      this._cloudTranscriptionRequests.cancelSender(event.sender.id);
    });

    ipcMain.handle("cloud-health-check", async () => {
      const apiUrl = getApiUrl();
      if (!apiUrl) {
        return {
          ok: false,
          code: "NO_API_URL",
          messageKey: "streaming.errors.cloudUnreachable.generic",
        };
      }
      const url = `${apiUrl}/api/health`;
      try {
        const res = await proxyFetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(3000),
        });
        return { ok: res.ok, status: res.status };
      } catch (err) {
        const classified = classifyAndLog(err, url);
        if (classified.isNetworkError) {
          return { ok: false, code: classified.code, messageKey: classified.messageKey };
        }
        return {
          ok: false,
          code: "UNKNOWN",
          messageKey: "streaming.errors.cloudUnreachable.generic",
        };
      }
    });

    ipcMain.handle("retry-transcription", async (event, id, settings) => {
      const buffer = this.audioStorageManager.getAudioBuffer(id);
      if (!buffer) return { success: false, error: "Audio file not found" };
      try {
        let result;
        const preferredLanguage = settings?.preferredLanguage;
        const language =
          preferredLanguage && preferredLanguage !== "auto"
            ? preferredLanguage.split("-")[0]
            : undefined;
        const { resolveTranscriptionRoute } = await import("./transcriptionRoute.ts");
        // Renderer pre-flight owns policy; retry re-routes stored audio through
        // whatever is selected NOW.
        const route = resolveTranscriptionRoute({
          settings: settings || {},
          providers: transcriptionProviderBaseUrls(),
          request: { effectiveLanguage: language },
        });

        // An error route is fatal unless OpenWhispr cloud is selected — a
        // leftover BYOK misconfiguration must not block the cloud pipeline.
        if (
          route.transport === "error" &&
          (settings?.transcriptionMode === "self-hosted" ||
            settings?.cloudTranscriptionMode !== "openwhispr")
        ) {
          const err = new Error(route.message);
          if (route.code) err.code = route.code;
          if (route.messageKey) err.messageKey = route.messageKey;
          throw err;
        }

        if (route.transport === "http-batch" && route.provider === "self-hosted") {
          const formData = new FormData();
          formData.append("file", new Blob([buffer], { type: "audio/webm" }), "audio.webm");
          if (route.model) {
            formData.append("model", route.model);
          }
          if (route.language) {
            formData.append("language", route.language);
          }

          const response = await proxyFetch(route.endpoint, {
            method: "POST",
            body: formData,
          });
          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Self-hosted API Error: ${response.status} ${errorText}`);
          }
          const data = await response.json();
          if (data?.text) {
            result = {
              text: data.text,
              source: "self-hosted",
              model: route.model,
            };
          }
        } else if (route.transport === "local") {
          if (isSherpaLocalProvider(settings.localTranscriptionProvider)) {
            const model =
              (settings.localTranscriptionProvider === "cohere"
                ? settings.cohereModel
                : settings.parakeetModel) ||
              process.env.PARAKEET_MODEL ||
              "parakeet-tdt-0.6b-v3";
            result = await this.parakeetManager.transcribeLocalParakeet(buffer, {
              model,
              language,
            });
          } else if (this.whisperManager?.serverManager?.isAvailable?.()) {
            const vadOptions = this._resolveWhisperVadOptions("noteRecording");
            result = await this.whisperManager.transcribeLocalWhisper(buffer, {
              model: settings.whisperModel,
              language,
              ...vadOptions,
            });
          }
        } else if (settings?.cloudTranscriptionMode === "openwhispr") {
          const win = BrowserWindow.fromWebContents(event.sender);
          if (win) {
            const authHeader = await getAuthHeaderFromWindow(win);
            if (Object.keys(authHeader).length) {
              const apiUrl = getApiUrl();
              if (apiUrl) {
                const multipartFields = {
                  language,
                  clientType: "desktop",
                  appVersion: app.getVersion(),
                  sessionId: this.sessionId,
                };
                if (buffer.length > CLOUD_INLINE_LIMIT) {
                  const { text } = await chunkedCloudTranscribe({
                    buffer,
                    apiUrl,
                    policyHeaders: withPolicyHeaders(authHeader),
                    multipartFields,
                  });
                  result = { text, source: "openwhispr", model: "cloud" };
                } else {
                  const { body, boundary } = buildMultipartBody(
                    buffer,
                    "audio.webm",
                    "audio/webm",
                    multipartFields
                  );
                  const url = new URL(`${apiUrl}/api/transcribe`);
                  const data = await postMultipart(
                    url,
                    body,
                    boundary,
                    withPolicyHeaders(authHeader),
                    {
                      signal: AbortSignal.timeout(CLOUD_UPLOAD_TIMEOUT_MS),
                      session: getInlineCloudUploadSession(),
                    }
                  );
                  const responseData = interpretTranscribeResponse(data);
                  result = {
                    text: responseData.text,
                    source: "openwhispr",
                    model: "cloud",
                  };
                }
              }
            }
          }
        } else if (route.transport === "proxied" && route.provider === "tinfoil") {
          // Attested transport, so this can't reuse the generic fetch below.
          const { text, model } = await transcribeWithTinfoil({
            audioBuffer: buffer,
            fileName: "audio.webm",
            contentType: "audio/webm",
            language: route.language,
            apiKey: this.environmentManager.getTinfoilKey(),
          });
          if (text) result = { text, source: "tinfoil", model };
        } else if (route.transport === "proxied" && route.provider === "corti") {
          // Corti uses OAuth + an interaction-based REST flow, so it can't use
          // the generic fetch below.
          const clientId = this.environmentManager.getCortiClientId();
          const clientSecret = this.environmentManager.getCortiClientSecret();
          if (!clientId || !clientSecret) {
            throw new Error("Corti credentials not configured. Add them in Settings.");
          }
          const { transcribeAudio } = require("./cortiTranscription");
          const { text } = await transcribeAudio({
            environment: route.cortiEnvironment,
            tenant: route.cortiTenant,
            clientId,
            clientSecret,
            audioBuffer: buffer,
            language: route.language,
          });
          if (text) result = { text, source: "corti", model: route.model };
        } else if (route.transport === "proxied" && route.provider === "gemini") {
          if (route.sizeCapBytes && buffer.byteLength > route.sizeCapBytes) {
            throw new Error(byokSizeCapError(route.sizeCapBytes));
          }
          const { text } = await transcribeWithGemini({
            audioBuffer: buffer,
            model: route.model,
            contentType: "audio/webm",
            language: route.language,
            apiKey: this.environmentManager.getGeminiKey(),
          });
          if (text) result = { text, source: "gemini", model: route.model };
        } else {
          // mistral/xai have no OpenAI-compatible endpoint — main talks to them
          // directly; everything else consumes the route endpoint as-is.
          const provider = route.provider;
          const endpoint =
            provider === "mistral"
              ? MISTRAL_TRANSCRIPTION_URL
              : provider === "xai"
                ? XAI_STT_URL
                : route.endpoint;
          const apiKey =
            provider === "mistral"
              ? this.environmentManager.getMistralKey()
              : provider === "xai"
                ? this.environmentManager.getXaiKey()
                : route.auth.keyRef === "custom"
                  ? this.environmentManager.getCustomTranscriptionKey()
                  : route.auth.keyRef === "groq"
                    ? this.environmentManager.getGroqKey()
                    : this.environmentManager.getOpenAIKey();
          if (!apiKey && provider !== "custom") {
            throw new Error(`${provider} API key not configured`);
          }

          const formData = new FormData();
          formData.append("file", new Blob([buffer], { type: "audio/webm" }), "audio.webm");
          if (provider === "xai") {
            // xAI STT does not accept a model field; the route pre-filters language
            if (route.language) {
              formData.append("language", route.language);
              formData.append("format", "true");
            }
          } else {
            formData.append("model", route.model);
            if (route.language) formData.append("language", route.language);
          }
          const headers = {};
          if (provider === "mistral") {
            headers["x-api-key"] = apiKey;
          } else if (apiKey) {
            if (route.transport === "http-batch" && route.auth.scheme === "azure-api-key") {
              headers["api-key"] = apiKey;
            } else {
              headers.Authorization = `Bearer ${apiKey}`;
            }
          }

          const response = await proxyFetch(endpoint, { method: "POST", headers, body: formData });
          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${provider} API Error: ${response.status} ${errorText}`);
          }
          const data = await response.json();
          if (data?.text) {
            result = { text: data.text, source: provider, model: route.model };
          }
        }

        if (!result?.text) {
          return { success: false, error: "No transcription engine available" };
        }

        this.databaseManager.updateTranscriptionText(id, result.text, result.text);
        this.databaseManager.updateTranscriptionStatus(id, "completed");
        const providerName = result.source || "local";
        const modelName = result.model || null;
        const existingRow = this.databaseManager.getTranscriptionById(id);
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 1,
          audioDurationMs: existingRow?.audio_duration_ms ?? null,
          provider: providerName,
          model: modelName,
        });
        const updated = this.databaseManager.getTranscriptionById(id);
        if (updated) {
          setImmediate(() => {
            broadcastToWindows("transcription-updated", updated);
          });
        }
        return { success: true, transcription: updated };
      } catch (error) {
        debugLogger.error(
          "Retry transcription failed",
          { id, error: error.message, code: error.code },
          "audio-storage"
        );
        if (error.code) {
          return { success: false, error: error.message, code: error.code, ...error };
        }
        return { success: false, error: error.message };
      }
    });

    let meetingTranscriptionStartInProgress = false;
    let meetingTranscriptionPrepareInProgress = false;
    let meetingTranscriptionPreparePromise = null;

    const DUPLICATE_TRANSCRIPT_WINDOW_MS = 6000;
    const DUPLICATE_TRANSCRIPT_MERGE_LIMIT = 3;
    const STREAMING_RISKY_MIC_SEGMENT_HOLDBACK_MS = 3000;
    const LOCAL_MEETING_CHUNK_INTERVAL_MS = 5000;
    // Must outlast one local transcription cycle so a straddling remote
    // utterance's next-cycle system transcript can confirm buffered echo.
    const LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS = LOCAL_MEETING_CHUNK_INTERVAL_MS + 1000;
    const RACING_MIC_RETRACT_WINDOW_MS = 4000;

    const buildNearbyTranscriptCandidates = (
      targetSource,
      timestamp,
      { extraSegment = null } = {}
    ) => {
      const relevant = meetingDiarizationSegments.filter(
        (candidate) =>
          candidate.source === targetSource && candidate.timestamp != null && candidate.text
      );

      return buildMergedCandidates({
        segments: relevant,
        timestamp,
        windowMs: DUPLICATE_TRANSCRIPT_WINDOW_MS,
        mergeLimit: DUPLICATE_TRANSCRIPT_MERGE_LIMIT,
        extraSegment,
      });
    };

    const hasNearbyTranscriptMatch = (targetSource, text, timestamp, options = {}) => {
      if (!text) return false;

      const matcher = options.relaxed ? transcriptsLooselyOverlap : transcriptsOverlap;
      const candidates = buildNearbyTranscriptCandidates(targetSource, timestamp, options);
      for (const candidateText of candidates) {
        if (matcher(text, candidateText)) {
          return true;
        }
      }

      return false;
    };

    const shouldSkipDuplicateMicSegment = (text, timestamp, suppression = null) =>
      isDuplicateMicSegment({ text, timestamp, suppression, hasNearbyTranscriptMatch });

    const isWithinMeetingStartupWarmup = () =>
      meetingStartedAt != null && Date.now() - meetingStartedAt < MEETING_STARTUP_WARMUP_MS;

    const hasRiskyMicDuplicateProfile = (suppression = null) =>
      isRiskyMicDuplicateProfile({
        suppression,
        inStartupWarmup: isWithinMeetingStartupWarmup(),
      });

    const removeRacingMicEntriesFor = (systemText, systemTimestamp) => {
      const indices = selectRacingMicEntryIndices({
        segments: meetingDiarizationSegments,
        systemText,
        systemTimestamp,
        hasNearbyTranscriptMatch,
        duplicateWindowMs: DUPLICATE_TRANSCRIPT_WINDOW_MS,
        retractWindowMs: RACING_MIC_RETRACT_WINDOW_MS,
      });
      const removed = [];
      // Indices are descending, so splicing in order never shifts a later index.
      for (const index of indices) {
        removed.push(meetingDiarizationSegments[index]);
        meetingDiarizationSegments.splice(index, 1);
      }
      return removed;
    };

    const appendMeetingLocalTranscript = (text) => {
      if (!text) return;
      meetingLocalTranscript += `${meetingLocalTranscript ? " " : ""}${text}`;
    };

    // Held-back mic segments are appended at release time, so insertion order
    // is not spoken order.
    const buildOrderedTranscriptText = (segments) =>
      segments
        .slice()
        .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
        .map((segment) => segment.text)
        .join(" ")
        .trim();

    const storeMeetingDiarizationSegment = (text, source, timestamp, micSuppression = null) => {
      meetingDiarizationSegments.push({
        text,
        source,
        timestamp,
        committedAt: Date.now(),
        suppressionReason: source === "mic" ? micSuppression?.reason || null : null,
        hasBleedEvidence: source === "mic" ? !!micSuppression?.hasBleedEvidence : false,
        likelyRenderBleed: source === "mic" ? !!micSuppression?.likelyRenderBleed : false,
      });
    };

    const sendMeetingFinalSegment = ({
      text,
      source,
      timestamp,
      micSuppression = null,
      send = null,
      includeInLocalTranscript = false,
    }) => {
      if (includeInLocalTranscript) {
        appendMeetingLocalTranscript(text);
      }

      storeMeetingDiarizationSegment(text, source, timestamp, micSuppression);

      if (send) {
        send("meeting-transcription-segment", {
          text,
          source,
          type: "final",
          timestamp,
        });
      }
    };

    function flushPendingMicFinals(force = false) {
      if (meetingPendingMicFinals.length === 0) {
        if (meetingPendingMicFinalTimer) {
          clearTimeout(meetingPendingMicFinalTimer);
          meetingPendingMicFinalTimer = null;
        }
        return;
      }

      const { deferred, duplicates, releases } = partitionPendingMicFinals({
        pending: meetingPendingMicFinals,
        now: Date.now(),
        force,
        isDuplicate: (entry) =>
          shouldSkipDuplicateMicSegment(entry.text, entry.timestamp, entry.micSuppression),
      });

      meetingPendingMicFinals = deferred;
      schedulePendingMicFinalFlush();

      for (const pending of duplicates) {
        debugLogger.debug(
          "Dropping buffered mic segment after system context confirmed duplicate",
          {
            text: pending.text.slice(0, 80),
            averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
            averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
          }
        );
      }

      for (const pending of releases) {
        debugLogger.debug(
          pending.micSuppression?.hasBleedEvidence
            ? "Releasing bleed-flagged mic segment after holdback (no transcript match)"
            : "Releasing buffered mic segment after duplicate holdback",
          {
            text: pending.text.slice(0, 80),
            holdbackMs: pending.holdbackMs,
            reason: pending.micSuppression?.reason,
            averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
            averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
          }
        );
        pending.emit();
      }
    }

    const schedulePendingMicFinalFlush = () => {
      if (meetingPendingMicFinalTimer) {
        clearTimeout(meetingPendingMicFinalTimer);
        meetingPendingMicFinalTimer = null;
      }

      if (meetingPendingMicFinals.length === 0) {
        return;
      }

      const nextDelay = Math.max(0, meetingPendingMicFinals[0].releaseAt - Date.now());
      meetingPendingMicFinalTimer = setTimeout(() => {
        meetingPendingMicFinalTimer = null;
        flushPendingMicFinals();
      }, nextDelay);
    };

    const resetPendingMicFinals = () => {
      meetingPendingMicFinals = [];
      if (meetingPendingMicFinalTimer) {
        clearTimeout(meetingPendingMicFinalTimer);
        meetingPendingMicFinalTimer = null;
      }
    };

    const removePendingMicFinalsFor = (systemText, systemTimestamp) => {
      const { kept, removed } = partitionOverlappingPendingMicFinals({
        pending: meetingPendingMicFinals,
        systemText,
        systemTimestamp,
        hasNearbyTranscriptMatch,
      });
      meetingPendingMicFinals = kept;
      schedulePendingMicFinalFlush();
      return removed;
    };

    const queuePendingMicFinal = ({ text, timestamp, micSuppression, holdbackMs, emit }) => {
      meetingPendingMicFinals.push({
        text,
        timestamp,
        micSuppression,
        holdbackMs,
        releaseAt: Date.now() + holdbackMs,
        emit,
      });
      meetingPendingMicFinals.sort((left, right) => left.releaseAt - right.releaseAt);
      schedulePendingMicFinalFlush();
    };

    const captureMeetingDiarizationState = async () => {
      const systemPcmPath = meetingDiarizationPath;
      const systemStartedAt = meetingDiarizationStartedAt;
      const micPcmPath = meetingMicDiarizationPath;
      const micStartedAt = meetingMicDiarizationStartedAt;
      const systemAudioHeard = meetingSystemAudioHeard;
      const diarizationSegments = meetingDiarizationSegments;
      if (meetingDiarizationStream) {
        await new Promise((resolve) => meetingDiarizationStream.end(resolve));
        meetingDiarizationStream = null;
      }
      if (meetingMicDiarizationStream) {
        await new Promise((resolve) => meetingMicDiarizationStream.end(resolve));
        meetingMicDiarizationStream = null;
      }
      meetingDiarizationPath = null;
      meetingDiarizationStartedAt = null;
      meetingMicDiarizationPath = null;
      meetingMicDiarizationStartedAt = null;
      meetingSystemAudioHeard = false;
      meetingSystemAudioDegraded = false;
      meetingDiarizationSegments = [];
      const { pcmPath, startedAt, diarizedSource, cleanupPcmPaths } = resolveDiarizationInput({
        systemPcmPath,
        micPcmPath,
        systemAudioHeard,
        systemStartedAt,
        micStartedAt,
      });
      for (const stalePath of cleanupPcmPaths) {
        fs.unlink(stalePath, () => {});
      }
      return {
        diarizationPcmPath: pcmPath,
        diarizationSegments,
        diarizationStartedAt: startedAt,
        diarizedSource,
      };
    };

    const attachMeetingStreamingHandlers = (streaming, win, source) => {
      const send = (channel, data) => {
        if (!win || win.isDestroyed()) {
          debugLogger.error("Meeting segment send failed: window unavailable", {
            channel,
            source,
            winExists: !!win,
          });
          return;
        }
        win.webContents.send(channel, data);
      };

      streaming.onPartialTranscript = (text) => {
        if (source === "mic" && meetingEchoLeakDetector.isMicProbablyRenderBleed()) {
          send("meeting-transcription-segment", { text: "", source, type: "partial" });
          return;
        }

        send("meeting-transcription-segment", { text, source, type: "partial" });
      };
      streaming.onFinalTranscript = (text, timestamp) => {
        const segments = streaming.completedSegments;
        const latestSegment = segments.length > 0 ? segments[segments.length - 1] : text;
        let micSuppression = null;
        if (source === "mic") {
          micSuppression = shouldSuppressMicTranscriptSegment(timestamp, Date.now());
          if (micSuppression.suppress) {
            debugLogger.debug("Suppressing contaminated mic segment", {
              reason: micSuppression.reason,
              averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
              averageResidual: micSuppression.averageResidual?.toFixed(3),
              text: latestSegment.slice(0, 80),
            });
            send("meeting-transcription-segment", { text: "", source, type: "partial" });
            return;
          }

          if (shouldSkipDuplicateMicSegment(latestSegment, timestamp, micSuppression)) {
            debugLogger.debug("Skipping duplicate mic segment that matches recent system audio", {
              text: latestSegment.slice(0, 80),
              averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
              averageResidual: micSuppression.averageResidual?.toFixed(3),
            });
            send("meeting-transcription-segment", { text: "", source, type: "partial" });
            return;
          }
        }

        if (source === "system") {
          const pending = removePendingMicFinalsFor(latestSegment, timestamp);
          if (pending.length > 0) {
            debugLogger.debug("Dropping buffered mic segments after system transcript arrived", {
              count: pending.length,
              text: latestSegment.slice(0, 80),
            });
          }

          const retracted = removeRacingMicEntriesFor(latestSegment, timestamp);
          for (const stale of retracted) {
            send("meeting-transcription-segment", {
              text: stale.text,
              source: "mic",
              type: "retract",
              timestamp: stale.timestamp,
            });
          }
        }

        debugLogger.debug("Meeting segment sending to renderer", {
          source,
          text: latestSegment.slice(0, 80),
          segmentCount: segments.length,
          micCorrelation: micSuppression?.averageCorrelation?.toFixed(3),
          micSuppressionReason: micSuppression?.reason,
          micHasBleedEvidence: micSuppression?.hasBleedEvidence,
          micLikelyRenderBleed: micSuppression?.likelyRenderBleed,
          systemSpeaking: micSuppression?.systemSpeaking,
        });
        if (source === "mic" && hasRiskyMicDuplicateProfile(micSuppression)) {
          debugLogger.debug("Buffering risky mic segment before renderer commit", {
            text: latestSegment.slice(0, 80),
            holdbackMs: STREAMING_RISKY_MIC_SEGMENT_HOLDBACK_MS,
            reason: micSuppression?.reason,
            hasBleedEvidence: micSuppression?.hasBleedEvidence,
          });
          send("meeting-transcription-segment", { text: "", source, type: "partial" });
          queuePendingMicFinal({
            text: latestSegment,
            timestamp,
            micSuppression,
            holdbackMs: STREAMING_RISKY_MIC_SEGMENT_HOLDBACK_MS,
            emit: () =>
              sendMeetingFinalSegment({
                text: latestSegment,
                source,
                timestamp,
                micSuppression,
                send,
              }),
          });
          return;
        }

        sendMeetingFinalSegment({
          text: latestSegment,
          source,
          timestamp,
          micSuppression,
          send,
        });
      };
      streaming.onError = (error) => {
        send("meeting-transcription-error", error.message);
      };
      const recoverConnection = async (error, restoreOldOnFailure) => {
        let recovered = false;
        try {
          recovered = await reconnectMeetingStreams({ restoreOldOnFailure });
        } catch (reconnectError) {
          debugLogger.error("Meeting stream recovery failed unexpectedly", {
            error: reconnectError.message,
          });
        }
        if (!recovered && !meetingFatalErrorSent) {
          meetingFatalErrorSent = true;
          send(
            "meeting-transcription-fatal-error",
            error?.message || "Meeting transcription connection could not be restored."
          );
        }
      };
      streaming.onConnectionLost = (error) => {
        void recoverConnection(error, false);
      };
      streaming.onSessionExpired = ({ proactive = false } = {}) => {
        void recoverConnection(
          new Error("Meeting transcription session could not be renewed."),
          proactive
        );
      };
    };

    const resetMeetingReconnectAudio = () => {
      meetingReconnectAudioBuffers = { mic: [], system: [] };
      meetingReconnectAudioBytes = { mic: 0, system: 0 };
      meetingReconnectReplaySources = new Set();
    };

    const queueMeetingReconnectAudio = (source, buffer) => {
      if (!meetingReconnectReplaySources.has(source)) return;
      const copy = Buffer.from(buffer);
      const queue = meetingReconnectAudioBuffers[source];
      queue.push(copy);
      meetingReconnectAudioBytes[source] += copy.length;
      while (
        meetingReconnectAudioBytes[source] > MEETING_RECONNECT_BUFFER_MAX_BYTES &&
        queue.length > 1
      ) {
        meetingReconnectAudioBytes[source] -= queue.shift().length;
      }
    };

    const replayMeetingReconnectAudio = (source, streaming) => {
      if (!meetingReconnectReplaySources.has(source)) return true;
      const queue = meetingReconnectAudioBuffers[source];
      const replayed = queue.every((buffer) => streaming.sendAudio(buffer));
      debugLogger.info("Replayed meeting audio after reconnect", {
        source,
        chunks: queue.length,
        bytes: meetingReconnectAudioBytes[source],
      });
      return replayed;
    };

    // Labels the socket for field logs and, for system, swaps in the more
    // sensitive threshold (see MEETING_SYSTEM_VAD_THRESHOLD).
    const withMeetingSourceConnectOpts = (connectOpts, source) => ({
      ...connectOpts,
      streamLabel: source,
      ...(source === "system" ? { vadThreshold: MEETING_SYSTEM_VAD_THRESHOLD } : {}),
    });

    const reconnectMeetingStreams = ({ restoreOldOnFailure = false } = {}) => {
      if (meetingReconnectPromise) return meetingReconnectPromise;

      const pending = (async () => {
        if (meetingLocalMode) return false;

        const options = meetingConnectionOptions;
        const win = meetingConnectionWin;
        if (!options || !win || win.isDestroyed()) {
          debugLogger.error("Cannot reconnect meeting streams: missing connection context");
          return false;
        }

        if (meetingReconnectCount >= MAX_MEETING_RECONNECTS) {
          debugLogger.error("Meeting reconnect limit reached", { count: meetingReconnectCount });
          return false;
        }

        meetingReconnectCount++;

        const oldMic = this._meetingMicStreaming;
        const oldSystem = this._meetingSystemStreaming;
        meetingReconnectReplaySources = new Set([
          ...(!oldMic?.isConnected ? ["mic"] : []),
          ...(oldSystem && !oldSystem.isConnected ? ["system"] : []),
        ]);
        let newMic = null;
        let newSystem = null;

        try {
          const StreamingClass = getMeetingStreamingClient(options.provider);
          newMic = new StreamingClass();
          attachMeetingStreamingHandlers(newMic, win, "mic");
          if (oldSystem) {
            newSystem = new StreamingClass();
            attachMeetingStreamingHandlers(newSystem, win, "system");
          }

          debugLogger.info("Reconnecting meeting streams", {
            attempt: meetingReconnectCount,
            maxAttempts: MAX_MEETING_RECONNECTS,
          });

          const tokenEvent = { sender: win.webContents };
          const connectOpts = {
            model: options.model,
            language: options.language,
            preconfigured: options.mode !== "byok",
            environment: options.environment,
            tenant: options.tenant,
            keyterms: options.keyterms,
            sampleRate: MEETING_STREAM_SAMPLE_RATE,
          };

          let pairs;
          if (newSystem) {
            const secrets = await fetchRealtimeToken(tokenEvent, options, { streams: 2 });
            pairs = [
              { streaming: newMic, secret: secrets[0], source: "mic" },
              { streaming: newSystem, secret: secrets[1], source: "system" },
            ];
          } else {
            pairs = [
              {
                streaming: newMic,
                secret: await fetchRealtimeToken(tokenEvent, options),
                source: "mic",
              },
            ];
          }

          await Promise.all(
            pairs.map(({ streaming, secret, source }) =>
              streaming.connect({
                apiKey: secret,
                token: secret,
                ...withMeetingSourceConnectOpts(connectOpts, source),
              })
            )
          );

          if (pairs.some(({ streaming }) => !streaming.isConnected)) {
            throw new Error("Meeting transcription connection closed during reconnect.");
          }

          if (meetingConnectionOptions !== options) {
            for (const { streaming } of pairs) streaming.disconnect().catch(() => {});
            oldMic?.disconnect().catch(() => {});
            oldSystem?.disconnect().catch(() => {});
            resetMeetingReconnectAudio();
            return true;
          }

          const replayedMic = replayMeetingReconnectAudio("mic", newMic);
          const replayedSystem = !newSystem || replayMeetingReconnectAudio("system", newSystem);
          if (!replayedMic || !replayedSystem) {
            throw new Error("Meeting audio could not be restored after reconnect.");
          }
          this._meetingMicStreaming = newMic;
          this._meetingSystemStreaming = newSystem;
          resetMeetingReconnectAudio();
          oldMic?.disconnect().catch(() => {});
          oldSystem?.disconnect().catch(() => {});
          meetingConnectionKey = getMeetingConnectionKey(options);

          debugLogger.info("Meeting streams reconnected", { attempt: meetingReconnectCount });
          meetingReconnectCount = 0;
          return true;
        } catch (error) {
          debugLogger.error("Meeting stream reconnect failed", {
            error: error.message,
            attempt: meetingReconnectCount,
          });
          newMic?.disconnect().catch(() => {});
          newSystem?.disconnect().catch(() => {});
          if (meetingConnectionOptions !== options) {
            oldMic?.disconnect().catch(() => {});
            oldSystem?.disconnect().catch(() => {});
            resetMeetingReconnectAudio();
            return true;
          }

          const canRestoreOld =
            restoreOldOnFailure && !!oldMic?.isConnected && (!oldSystem || oldSystem.isConnected);
          if (canRestoreOld) {
            this._meetingMicStreaming = oldMic;
            this._meetingSystemStreaming = oldSystem;
          } else {
            oldMic?.disconnect().catch(() => {});
            oldSystem?.disconnect().catch(() => {});
            this._meetingMicStreaming = null;
            this._meetingSystemStreaming = null;
            meetingConnectionKey = null;
          }
          resetMeetingReconnectAudio();
          if (!win.isDestroyed()) {
            win.webContents.send("meeting-transcription-error", error.message);
          }
          return canRestoreOld;
        }
      })();

      meetingReconnectPromise = pending;
      return pending.finally(() => {
        if (meetingReconnectPromise === pending) meetingReconnectPromise = null;
      });
    };

    const fetchRealtimeToken = async (event, options, { streams } = {}) => {
      const postServerToken = async (path, body = {}) => {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          const err = new Error("OpenWhispr API URL not configured");
          err.code = "NO_API";
          throw err;
        }
        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");
        const url = `${apiUrl}${path}`;
        let response;
        try {
          response = await proxyFetch(url, {
            method: "POST",
            headers: withPolicyHeaders({ "Content-Type": "application/json", ...authHeader }),
            body: JSON.stringify(body),
          });
        } catch (err) {
          const classified = classifyAndLog(err, url);
          if (classified.isNetworkError) {
            throw Object.assign(new Error(err.message || "Network request failed"), {
              code: "NETWORK_ERROR",
              networkCode: classified.code,
              messageKey: classified.messageKey,
            });
          }
          throw err;
        }
        if (!response.ok) {
          throw await readPolicyResponseError(response, `Token request failed: ${response.status}`);
        }
        return response.json();
      };

      return fetchRealtimeTokenForProvider(
        options.provider,
        {
          environmentManager: this.environmentManager,
          proxyFetch,
          postServerToken,
          mintCortiToken: (tokenOptions) => this._mintStoredCortiToken(tokenOptions),
        },
        options,
        { streams }
      );
    };

    const getMeetingSystemAudioCapabilityMode = () => {
      if (this.audioTapManager?.isSupported()) return "native";
      if (process.platform === "win32") return "loopback";
      if (process.platform === "linux") return "loopback";
      return "unsupported";
    };

    const getMeetingSystemAudioMode = () => getMeetingSystemAudioCapabilityMode();

    const getMeetingSystemAudioPlan = async ({ refreshWindowsCapability = false } = {}) => {
      const mode = getMeetingSystemAudioMode();
      if (mode === "unsupported") {
        return { mode, strategy: "unsupported" };
      }

      if (mode === "native") {
        return { mode, strategy: "native" };
      }

      if (process.platform === "linux") {
        const linuxAccess = await getLinuxSystemAudioAccess();
        return {
          mode: linuxAccess.mode,
          strategy: linuxAccess.strategy || "unsupported",
        };
      }

      if (process.platform === "win32") {
        const windowsAccess = await getWindowsSystemAudioAccess({
          refreshCapability: refreshWindowsCapability,
        });
        return { mode: windowsAccess.mode, strategy: windowsAccess.strategy };
      }

      // Unreachable today (loopback implies win32 or linux, both handled
      // above), but callers destructure the result, so never return undefined.
      return { mode, strategy: "unsupported" };
    };

    const hasNativeMeetingSystemAudio = () => getMeetingSystemAudioMode() === "native";

    const isMeetingStreamingConnected = (systemAudioMode = getMeetingSystemAudioCapabilityMode()) =>
      !!this._meetingMicStreaming?.isConnected &&
      (systemAudioMode === "unsupported" || !!this._meetingSystemStreaming?.isConnected);

    const connectRealtimeStreaming = async (event, options) => {
      const connectionKey = getMeetingConnectionKey(options);
      const StreamingClass = getMeetingStreamingClient(options.provider);
      if (this._meetingMicStreaming?.isConnected) {
        await this._meetingMicStreaming.disconnect();
      }
      if (this._meetingSystemStreaming?.isConnected) {
        await this._meetingSystemStreaming.disconnect();
      }
      this._meetingMicStreaming = null;
      this._meetingSystemStreaming = null;
      const win = BrowserWindow.fromWebContents(event.sender);

      const connectOpts = {
        model: options.model,
        language: options.language,
        preconfigured: options.mode !== "byok",
        environment: options.environment,
        tenant: options.tenant,
        keyterms: options.keyterms,
        sampleRate: MEETING_STREAM_SAMPLE_RATE,
      };
      const { mode: systemAudioMode } = await getMeetingSystemAudioPlan();
      let pairs;
      if (systemAudioMode !== "unsupported") {
        const secrets = await fetchRealtimeToken(event, options, { streams: 2 });
        pairs = [
          { ref: "_meetingMicStreaming", secret: secrets[0], source: "mic" },
          { ref: "_meetingSystemStreaming", secret: secrets[1], source: "system" },
        ];
      } else {
        pairs = [
          {
            ref: "_meetingMicStreaming",
            secret: await fetchRealtimeToken(event, options),
            source: "mic",
          },
        ];
      }

      for (const { ref, source } of pairs) {
        this[ref] = new StreamingClass();
        attachMeetingStreamingHandlers(this[ref], win, source);
      }

      try {
        await Promise.all(
          pairs.map(({ ref, secret, source }) =>
            this[ref].connect({
              apiKey: secret,
              token: secret,
              ...withMeetingSourceConnectOpts(connectOpts, source),
            })
          )
        );
        if (pairs.some(({ ref }) => !this[ref]?.isConnected)) {
          throw new Error("Meeting transcription connection closed during startup.");
        }
        meetingConnectionKey = connectionKey;
      } catch (error) {
        await Promise.all(
          pairs.map(({ ref }) => this[ref]?.disconnect().catch(() => ({ text: "" })))
        );
        this._meetingMicStreaming = null;
        this._meetingSystemStreaming = null;
        meetingConnectionKey = null;
        throw error;
      }

      return win;
    };

    const MEETING_MIC_REFERENCE_ALIGNMENT_MS = 320;
    const MEETING_STARTUP_WARMUP_MS = 1500;
    const MEETING_MIC_BLEED_LOOKBACK_MS = 500;
    const MEETING_MIC_STATS_LOG_LIMIT = 200;
    const MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS = 45000;
    let meetingMicStatsLogCount = 0;
    let meetingSystemAudioSilenceTimer = null;
    let meetingStartedAt = null;
    let meetingSendCounts = { mic: 0, system: 0 };
    const meetingEchoLeakDetector = new MeetingEchoLeakDetector();
    let meetingReconnectPromise = null;
    let meetingFatalErrorSent = false;
    let meetingReconnectCount = 0;
    const MAX_MEETING_RECONNECTS = 5;
    let meetingConnectionOptions = null;
    let meetingConnectionWin = null;
    let meetingConnectionKey = null;
    let meetingReconnectAudioBuffers = { mic: [], system: [] };
    let meetingReconnectAudioBytes = { mic: 0, system: 0 };
    let meetingReconnectReplaySources = new Set();

    const fs = require("fs");
    let meetingDiarizationStream = null;
    let meetingDiarizationPath = null;
    let meetingDiarizationStartedAt = null;
    // Parallel raw mic capture so an in-person session (no audible system
    // audio) can be diarized; dropped as soon as the session proves to be a call.
    let meetingMicDiarizationStream = null;
    let meetingMicDiarizationPath = null;
    let meetingMicDiarizationStartedAt = null;
    let meetingSystemAudioHeard = false;
    let meetingSystemAudioDegraded = false;
    let meetingDiarizationSegments = [];
    let meetingLiveSpeakerActive = false;
    let meetingLiveSpeakerState = null;
    let meetingLiveSpeakerStartedAt = null;
    let meetingReclusterTimer = null;

    let meetingLocalMode = false;
    let meetingLocalBuffers = { mic: [], system: [] };
    let meetingLocalTimer = null;
    let meetingLocalWin = null;
    let meetingLocalTranscript = "";
    let meetingLocalProvider = null;
    let meetingLocalModel = null;
    let meetingLocalLanguage = null;
    let meetingLocalTranscribing = false;
    let meetingPendingMicChunks = [];
    let meetingPendingMicFinals = [];
    let meetingPendingMicFinalTimer = null;
    let meetingAecEnabled = false;
    let meetingOneOnOneAttendee = null;
    let meetingOneOnOneProfileBound = false;
    let meetingNoteId = null;

    const getLiveSpeakerProfiles = () => {
      const attendees = this._getNoteNonSelfParticipants(meetingNoteId);
      const attendeeEmails = new Set();
      for (const p of attendees) {
        const email = (p.email || "").toLowerCase().trim();
        if (email) attendeeEmails.add(email);
      }
      if (attendeeEmails.size === 0) return [];
      return this.databaseManager
        .getSpeakerProfiles(true)
        .filter((p) => p.email && attendeeEmails.has(p.email.toLowerCase()));
    };
    const shouldSuppressMicTranscriptSegment = (startedAt, endedAt = Date.now()) =>
      meetingEchoLeakDetector.shouldSuppressMicSegment(startedAt, endedAt);

    const resolveOneOnOneAttendeeForNote = (noteId) => {
      if (!noteId) return null;
      try {
        const note = this.databaseManager.getNote(noteId);
        return this._resolveOneOnOneOtherParticipant(note?.participants);
      } catch (_) {
        return null;
      }
    };

    const resolveDiarizationEnabled = () =>
      (this.activeMeetingSpeakerConfig?.enabled ?? this.speakerDiarizationEnabled) !== false;

    const resolveSessionMaxSpeakers = () => {
      const count = this.activeMeetingSpeakerConfig?.expectedCount;
      const total = count ? Math.min(count, MAX_SPEAKER_COUNT) : DEFAULT_EXPECTED_SPEAKER_COUNT;
      return Math.max(1, total - 1);
    };

    const bindOneOnOneAttendeeToSpeaker = (speakerId) => {
      if (!meetingOneOnOneAttendee || meetingOneOnOneProfileBound || !speakerId) return;
      if (!resolveDiarizationEnabled()) return;
      const embedding = liveSpeakerIdentifier.getSpeakerEmbedding(speakerId);
      if (!embedding) return;
      try {
        const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
        const profile = this.databaseManager.upsertSpeakerProfile(
          meetingOneOnOneAttendee.displayName,
          meetingOneOnOneAttendee.email,
          buffer
        );
        liveSpeakerIdentifier.mapSpeaker(
          speakerId,
          profile.id,
          meetingOneOnOneAttendee.displayName,
          null
        );
        meetingOneOnOneProfileBound = true;
      } catch (error) {
        debugLogger.warn(
          "1-on-1 attendee profile binding failed",
          { error: error.message },
          "speaker"
        );
      }
    };

    const dispatchMeetingAudioBuffer = (buffer, source) => {
      if (meetingLocalMode) {
        meetingLocalBuffers[source].push(buffer);
        return;
      }

      const streaming = source === "mic" ? this._meetingMicStreaming : this._meetingSystemStreaming;
      if (!streaming) {
        if (meetingSendCounts[source] === 0) {
          debugLogger.error("Meeting audio send: no streaming instance", { source });
        }
        return;
      }

      let outbound = buffer;
      if (source === "mic" && buffer.length >= 2) {
        const { rms, peak, sampleCount } = computeChunkStats(buffer);
        // Evaluated eagerly (as before) because the stats log reports it.
        const systemSpeaking = meetingEchoLeakDetector.isSystemSpeaking(
          Date.now() - MEETING_MIC_BLEED_LOOKBACK_MS
        );
        const verdict = resolveMicChunkAction({
          mode: "streaming",
          source,
          rms,
          peak,
          sampleCount,
          isSystemSpeaking: () => systemSpeaking,
        });
        if (verdict.action === "zero") {
          outbound = Buffer.alloc(buffer.length);
        }
        if (
          meetingMicStatsLogCount < MEETING_MIC_STATS_LOG_LIMIT &&
          (systemSpeaking || rms > 0.02)
        ) {
          meetingMicStatsLogCount += 1;
          debugLogger.debug("Meeting mic audio stats", {
            rms: rms.toFixed(4),
            peak: peak.toFixed(4),
            systemSpeaking,
            zeroed: outbound !== buffer,
          });
        }
      } else if (source === "system" && buffer.length >= 2) {
        // System chunks stream verbatim (no gate), so a periodic level readout
        // is the only way field logs can tell real audio from capture silence.
        const chunkCount = meetingSendCounts.system + 1;
        if (chunkCount === 1 || chunkCount % 200 === 0) {
          const { rms, peak } = computeChunkStats(buffer);
          debugLogger.debug("Meeting system audio stats", {
            rms: rms.toFixed(4),
            peak: peak.toFixed(4),
            chunkCount,
          });
        }
      }

      queueMeetingReconnectAudio(source, outbound);
      const sent = streaming.sendAudio(outbound);
      meetingSendCounts[source]++;
      if (meetingSendCounts[source] <= 5 || meetingSendCounts[source] % 100 === 0) {
        debugLogger.debug("Meeting audio send", {
          source,
          bytes: buffer.length,
          sent,
          wsReady: streaming.ws?.readyState,
          totalSent: streaming.audioBytesSent,
          count: meetingSendCounts[source],
        });
      }
    };

    const stopMeetingAec = async () => {
      meetingAecEnabled = false;
      if (this.meetingAecManager) {
        await this.meetingAecManager.stop().catch(() => {});
      }
    };

    const startMeetingAec = async (systemAudioMode) => {
      meetingAecEnabled = false;
      if (systemAudioMode === "unsupported" || !this.meetingAecManager?.isAvailable()) {
        return false;
      }

      const started = await this.meetingAecManager
        .start({
          onMicChunk: (chunk) => {
            dispatchMeetingAudioBuffer(chunk, "mic");
          },
          onError: (error) => {
            debugLogger.warn("Meeting AEC helper disabled", { error: error.message }, "meeting");
            meetingAecEnabled = false;
            void this.meetingAecManager.stop().catch(() => {});
          },
          onWarning: (warning) => {
            debugLogger.debug("Meeting AEC helper warning", warning, "meeting");
          },
        })
        .catch((error) => {
          debugLogger.warn("Meeting AEC helper start failed", { error: error.message }, "meeting");
          return false;
        });

      meetingAecEnabled = !!started;
      if (meetingAecEnabled) {
        debugLogger.info("Meeting AEC helper started", { systemAudioMode }, "meeting");
      }
      return meetingAecEnabled;
    };

    const flushPendingMeetingMicChunks = (force = false) => {
      if (!meetingPendingMicChunks.length) {
        return;
      }

      const now = Date.now();
      while (meetingPendingMicChunks.length > 0) {
        const next = meetingPendingMicChunks[0];
        if (!force && now - next.queuedAt < MEETING_MIC_REFERENCE_ALIGNMENT_MS) {
          break;
        }

        meetingPendingMicChunks.shift();
        const analysis = meetingEchoLeakDetector.analyzeMicChunk(next.buffer);
        if (next.analysisOnly) {
          continue;
        }
        if (analysis?.shouldMute && !meetingAecEnabled) {
          if (!meetingLocalMode) {
            dispatchMeetingAudioBuffer(Buffer.alloc(next.buffer.length), "mic");
          }
          continue;
        }

        dispatchMeetingAudioBuffer(next.buffer, "mic");
      }
    };

    const processMeetingMicWithAec = (buffer) => {
      if (!meetingAecEnabled) {
        return false;
      }

      const sent = this.meetingAecManager?.processMicBuffer(buffer);
      if (sent) {
        meetingPendingMicChunks.push({
          buffer,
          queuedAt: Date.now(),
          analysisOnly: true,
        });
        flushPendingMeetingMicChunks();
        return true;
      }

      meetingAecEnabled = false;
      return false;
    };

    const stopLiveSpeakerIdentification = async () => {
      if (!meetingLiveSpeakerActive) {
        return null;
      }

      if (meetingReclusterTimer) {
        clearInterval(meetingReclusterTimer);
        meetingReclusterTimer = null;
      }

      meetingLiveSpeakerActive = false;
      meetingLiveSpeakerState = await liveSpeakerIdentifier.stop();
      return meetingLiveSpeakerState;
    };

    const startLiveSpeakerIdentification = async (win, systemAudioMode) => {
      await stopLiveSpeakerIdentification();

      if (
        !supportsLiveSpeakerIdentification(systemAudioMode) ||
        !liveSpeakerIdentifier.isAvailable()
      ) {
        return false;
      }

      const diarizationEnabled = resolveDiarizationEnabled();
      if (!diarizationEnabled) {
        return false;
      }

      meetingLiveSpeakerState = null;
      // Anchored on the first system chunk instead, in sendMeetingAudio.
      meetingLiveSpeakerStartedAt = null;
      const started = await liveSpeakerIdentifier
        .start(
          (identification) => {
            if (!win || win.isDestroyed() || meetingLiveSpeakerStartedAt == null) {
              return;
            }

            bindOneOnOneAttendeeToSpeaker(identification.speakerId);

            const displayName = meetingOneOnOneAttendee
              ? meetingOneOnOneAttendee.displayName
              : identification.displayName;

            const startTime = Math.max(
              meetingLiveSpeakerStartedAt,
              meetingLiveSpeakerStartedAt + identification.startTime * 1000
            );
            const endTime = Math.max(
              startTime,
              meetingLiveSpeakerStartedAt + identification.endTime * 1000
            );
            const enrichedIdentification = {
              ...identification,
              displayName,
              startTime,
              endTime,
            };

            win.webContents.send("meeting-speaker-identified", enrichedIdentification);

            for (const seg of meetingDiarizationSegments) {
              if (
                seg.source === "system" &&
                seg.timestamp != null &&
                seg.timestamp >= startTime &&
                seg.timestamp <= endTime &&
                (!seg.speaker || seg.speakerIsPlaceholder)
              ) {
                applyConfirmedSpeaker(seg, {
                  speaker: identification.speakerId,
                  speakerName: displayName || seg.speakerName,
                  speakerIsPlaceholder: false,
                });
              }
            }
          },
          {
            getSpeakerProfiles: getLiveSpeakerProfiles,
            maxSpeakers: resolveSessionMaxSpeakers(),
            enabled: true,
          }
        )
        .catch((error) => {
          // isAvailable() only stats the model file, so a corrupt model or an
          // onnxruntime binding that won't load still throws here. Speaker labels
          // are an enhancement — never let them take the recording down with them.
          debugLogger.warn(
            "Live speaker identification start failed",
            { error: error.message },
            "speaker"
          );
          return false;
        });

      if (started) {
        meetingLiveSpeakerActive = true;
        meetingReclusterTimer = setInterval(async () => {
          if (!meetingLiveSpeakerActive || !win || win.isDestroyed()) return;

          const merges = await liveSpeakerIdentifier.recluster();
          if (!merges.length) return;

          for (const { keep, remove, displayName } of merges) {
            for (const seg of meetingDiarizationSegments) {
              if (seg.speaker === remove) {
                seg.speaker = keep;
                if (displayName) seg.speakerName = displayName;
              }
            }
          }

          win.webContents.send("meeting-speakers-merged", merges);
        }, 30_000);
      } else {
        meetingLiveSpeakerStartedAt = null;
      }

      return started;
    };

    const transcribeLocalMeetingChunk = async (source) => {
      const chunks = meetingLocalBuffers[source];
      if (!chunks.length) return;

      const pcm24k = Buffer.concat(chunks);
      meetingLocalBuffers[source] = [];

      const pcm16k = downsample24kTo16k(pcm24k);

      const { rms, peak, sampleCount } = computeChunkStats(pcm16k);
      const verdict = resolveMicChunkAction({
        mode: "local",
        source,
        rms,
        peak,
        sampleCount,
        isSystemSpeaking: () =>
          meetingEchoLeakDetector.isSystemSpeaking(Date.now() - LOCAL_MEETING_CHUNK_INTERVAL_MS),
      });
      if (verdict.action === "skip") {
        debugLogger.debug(
          verdict.reason === "silence"
            ? "Skipping silent meeting chunk"
            : "Skipping system-dominant mic chunk",
          {
            source,
            rms: rms.toFixed(4),
            peak: peak.toFixed(4),
          }
        );
        return;
      }

      const wav = pcm16ToWav(pcm16k);

      try {
        let result;
        if (isSherpaLocalProvider(meetingLocalProvider)) {
          result = await this.parakeetManager.transcribeLocalParakeet(wav, {
            model: meetingLocalModel,
            language: meetingLocalLanguage,
          });
        } else {
          const vadOptions = this._resolveWhisperVadOptions("meeting");
          result = await this.whisperManager.transcribeLocalWhisper(wav, {
            model: meetingLocalModel,
            language: meetingLocalLanguage,
            // Keep whisper.cpp's default decoder thresholds on this continuous
            // load: the raised #1458 values multiply temperature-fallback
            // re-decodes, and meeting chunks already have RMS-gate, VAD, and
            // holdback/dedup hallucination protection.
            skipDecoderThresholds: true,
            ...vadOptions,
          });
        }

        if (result?.success && result.text?.trim()) {
          const text = result.text.trim();
          const segTimestamp = Date.now();
          let micSuppression = null;
          if (source === "mic") {
            const chunkDurationMs = (pcm24k.length / 2 / 24000) * 1000;
            micSuppression = shouldSuppressMicTranscriptSegment(
              segTimestamp - chunkDurationMs,
              segTimestamp
            );
            debugLogger.debug("Local meeting transcription candidate", {
              source,
              text: text.slice(0, 80),
              suppress: micSuppression.suppress,
              reason: micSuppression.reason,
              hasBleedEvidence: micSuppression.hasBleedEvidence,
              likelyRenderBleed: micSuppression.likelyRenderBleed,
              averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
              averageResidual: micSuppression.averageResidual?.toFixed(3),
            });
            if (micSuppression.suppress) {
              debugLogger.debug("Suppressing contaminated local mic segment", {
                reason: micSuppression.reason,
                averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
                averageResidual: micSuppression.averageResidual?.toFixed(3),
                text: text.slice(0, 80),
              });
              return;
            }

            if (shouldSkipDuplicateMicSegment(text, segTimestamp, micSuppression)) {
              debugLogger.debug("Skipping duplicate local mic segment that matches system audio", {
                text: text.slice(0, 80),
                averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
                averageResidual: micSuppression.averageResidual?.toFixed(3),
              });
              return;
            }
          } else {
            debugLogger.debug("Local meeting transcription candidate", {
              source,
              text: text.slice(0, 80),
            });
          }

          if (source === "system") {
            const pending = removePendingMicFinalsFor(text, segTimestamp);
            if (pending.length > 0) {
              debugLogger.debug(
                "Dropping buffered local mic segments after system transcript arrived",
                {
                  count: pending.length,
                  text: text.slice(0, 80),
                }
              );
            }

            const retracted = removeRacingMicEntriesFor(text, segTimestamp);
            for (const stale of retracted) {
              if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
                meetingLocalWin.webContents.send("meeting-transcription-segment", {
                  text: stale.text,
                  source: "mic",
                  type: "retract",
                  timestamp: stale.timestamp,
                });
              }
            }
          }

          const sendLocalSegment = (channel, payload) => {
            if (channel !== "meeting-transcription-segment") {
              return;
            }

            if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
              meetingLocalWin.webContents.send(channel, payload);
            }
          };

          if (source === "mic" && hasRiskyMicDuplicateProfile(micSuppression)) {
            debugLogger.debug("Buffering risky local mic segment before renderer commit", {
              text: text.slice(0, 80),
              holdbackMs: LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS,
              reason: micSuppression?.reason,
              hasBleedEvidence: micSuppression?.hasBleedEvidence,
            });
            queuePendingMicFinal({
              text,
              timestamp: segTimestamp,
              micSuppression,
              holdbackMs: LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS,
              emit: () =>
                sendMeetingFinalSegment({
                  text,
                  source,
                  timestamp: segTimestamp,
                  micSuppression,
                  send: sendLocalSegment,
                  includeInLocalTranscript: true,
                }),
            });
            return;
          }

          sendMeetingFinalSegment({
            text,
            source,
            timestamp: segTimestamp,
            micSuppression,
            send: sendLocalSegment,
            includeInLocalTranscript: true,
          });
        }
      } catch (error) {
        debugLogger.error("Local meeting transcription chunk failed", {
          source,
          error: error.message,
        });
        if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
          meetingLocalWin.webContents.send("meeting-transcription-error", error.message);
        }
      }
    };

    const transcribeAllLocalBuffers = async () => {
      if (meetingLocalTranscribing) return;
      meetingLocalTranscribing = true;
      try {
        await transcribeLocalMeetingChunk("system");
        await transcribeLocalMeetingChunk("mic");
      } finally {
        meetingLocalTranscribing = false;
      }
    };

    const dropMeetingMicDiarizationCapture = () => {
      if (meetingMicDiarizationStream) {
        meetingMicDiarizationStream.end();
        meetingMicDiarizationStream = null;
      }
      if (meetingMicDiarizationPath) {
        fs.unlink(meetingMicDiarizationPath, () => {});
        meetingMicDiarizationPath = null;
      }
      meetingMicDiarizationStartedAt = null;
    };

    const resetMeetingLocalState = () => {
      if (meetingLocalTimer) {
        clearInterval(meetingLocalTimer);
        meetingLocalTimer = null;
      }
      if (meetingReclusterTimer) {
        clearInterval(meetingReclusterTimer);
        meetingReclusterTimer = null;
      }
      void stopLiveSpeakerIdentification();
      meetingLiveSpeakerState = null;
      meetingLiveSpeakerStartedAt = null;
      meetingOneOnOneAttendee = null;
      meetingOneOnOneProfileBound = false;
      meetingNoteId = null;
      this._activeMeetingNoteId = null;
      meetingLocalMode = false;
      meetingLocalBuffers = { mic: [], system: [] };
      if (meetingDiarizationStream) {
        meetingDiarizationStream.end();
        meetingDiarizationStream = null;
      }
      if (meetingDiarizationPath) {
        fs.unlink(meetingDiarizationPath, () => {});
        meetingDiarizationPath = null;
      }
      meetingDiarizationStartedAt = null;
      dropMeetingMicDiarizationCapture();
      meetingSystemAudioHeard = false;
      meetingSystemAudioDegraded = false;
      meetingDiarizationSegments = [];
      meetingLocalWin = null;
      meetingLocalTranscript = "";
      meetingLocalProvider = null;
      meetingLocalModel = null;
      meetingLocalLanguage = null;
      meetingLocalTranscribing = false;
      meetingPendingMicChunks = [];
      resetPendingMicFinals();
      meetingAecEnabled = false;
      meetingStartedAt = null;
      meetingEchoLeakDetector.reset();
    };

    let dictationPreviewMode = false;
    let dictationPreviewBuffer = [];
    let dictationPreviewTimer = null;
    let dictationPreviewTranscribing = false;
    let dictationPreviewProvider = null;
    let dictationPreviewModel = null;
    let dictationPreviewLanguage = null;
    let dictationPreviewSessionActive = false;
    let dictationPreviewChunkCount = 0;
    // Online-runtime models stream here instead of the 1.5s chunked path.
    let dictationPreviewStream = null;
    // false = headless streaming session (commit-only, no preview window).
    let dictationPreviewDisplay = true;
    // Bumped on every reset so async preview work can detect a stale session.
    let dictationPreviewGen = 0;
    // Cloud partials can arrive faster than the preview window is created. Keep
    // preview updates, completion, and dismissal ordered so a late partial can
    // never overwrite the final result or reopen a dismissed window.
    let dictationPreviewOperation = Promise.resolve();

    const queueDictationPreviewOperation = (operation) => {
      const result = dictationPreviewOperation.catch(() => {}).then(operation);
      dictationPreviewOperation = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    };

    const resetDictationPreviewState = ({ preserveSession = false } = {}) => {
      dictationPreviewGen++;
      if (dictationPreviewTimer) {
        clearInterval(dictationPreviewTimer);
        dictationPreviewTimer = null;
      }
      if (dictationPreviewStream) {
        dictationPreviewStream.abort();
        dictationPreviewStream = null;
      }
      dictationPreviewMode = false;
      if (!preserveSession) {
        dictationPreviewSessionActive = false;
      }
      dictationPreviewBuffer = [];
      dictationPreviewTranscribing = false;
      dictationPreviewProvider = null;
      dictationPreviewModel = null;
      dictationPreviewLanguage = null;
      dictationPreviewDisplay = true;
    };

    const startDictationPreviewTimer = () => {
      if (!dictationPreviewTimer) {
        dictationPreviewTimer = setInterval(() => transcribeDictationPreviewChunk(), 1500);
      }
    };

    const transcribeDictationPreviewChunk = async () => {
      // The chunked path only feeds the preview window.
      if (!dictationPreviewDisplay) return;
      if (dictationPreviewTranscribing) return;
      if (!dictationPreviewBuffer.length) return;

      dictationPreviewTranscribing = true;
      try {
        const pcm = Buffer.concat(dictationPreviewBuffer);
        dictationPreviewBuffer = [];

        const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
        let sumSq = 0;
        for (let i = 0; i < samples.length; i++) {
          const n = samples[i] / 0x7fff;
          sumSq += n * n;
        }
        const rms = Math.sqrt(sumSq / samples.length);
        debugLogger.debug("Dictation preview chunk", {
          pcmBytes: pcm.length,
          rms: rms.toFixed(6),
          samples: samples.length,
        });
        if (rms < 0.002) return;

        const wav = pcm16ToWav(pcm);

        let result;
        if (isSherpaLocalProvider(dictationPreviewProvider)) {
          result = await this.parakeetManager.transcribeLocalParakeet(wav, {
            model: dictationPreviewModel,
            language: dictationPreviewLanguage,
          });
        } else {
          const vadOptions = this._resolveWhisperVadOptions("dictation");
          result = await this.whisperManager.transcribeLocalWhisper(wav, {
            model: dictationPreviewModel,
            language: dictationPreviewLanguage,
            ...vadOptions,
          });
        }

        if (result?.success && result.text?.trim()) {
          this.windowManager.appendTranscriptionPreview(result.text.trim());
        } else if (result && !result.success) {
          debugLogger.warn("Dictation preview chunk returned failure", {
            error: result.error || result.message,
            provider: dictationPreviewProvider,
          });
        }
      } catch (error) {
        debugLogger.error("Dictation preview transcription chunk failed", {
          error: error.message,
          provider: dictationPreviewProvider,
        });
      } finally {
        dictationPreviewTranscribing = false;
      }
    };

    const resetMeetingStreamingState = () => {
      this._meetingMicStreaming = null;
      this._meetingSystemStreaming = null;
      meetingSendCounts = { mic: 0, system: 0 };
      meetingLiveSpeakerStartedAt = null;
      meetingPendingMicChunks = [];
      resetPendingMicFinals();
      meetingAecEnabled = false;
      meetingEchoLeakDetector.reset();
      meetingReconnectPromise = null;
      meetingFatalErrorSent = false;
      meetingReconnectCount = 0;
      meetingConnectionOptions = null;
      meetingConnectionWin = null;
      meetingConnectionKey = null;
      resetMeetingReconnectAudio();
    };

    const disconnectMeetingStreaming = async ({ flushPending = false } = {}) => {
      const results = await Promise.all([
        this._meetingMicStreaming
          ? this._meetingMicStreaming.disconnect().catch(() => ({ text: "" }))
          : Promise.resolve({ text: "" }),
        this._meetingSystemStreaming
          ? this._meetingSystemStreaming.disconnect().catch(() => ({ text: "" }))
          : Promise.resolve({ text: "" }),
      ]);

      if (flushPending) {
        flushPendingMicFinals(true);
      }

      resetMeetingStreamingState();
      return results;
    };

    const clearMeetingSystemAudioSilenceTimer = () => {
      if (meetingSystemAudioSilenceTimer) {
        clearTimeout(meetingSystemAudioSilenceTimer);
        meetingSystemAudioSilenceTimer = null;
      }
    };

    // One-shot: system capture is active but nothing audible has arrived by the
    // deadline, so tell the meeting window the remote side may be missing from
    // the transcript. Audio arriving before the deadline cancels it outright;
    // the toast itself is time-boxed by the renderer, not by later audio.
    const armMeetingSystemAudioSilenceTimer = (win, systemAudioStrategy) => {
      clearMeetingSystemAudioSilenceTimer();
      meetingSystemAudioSilenceTimer = setTimeout(() => {
        meetingSystemAudioSilenceTimer = null;
        if (meetingSystemAudioHeard) return;
        debugLogger.debug(
          "Meeting system audio still silent past warning window",
          { systemAudioStrategy, timeoutMs: MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS },
          "meeting"
        );
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-system-audio-silent", { systemAudioStrategy });
        }
      }, MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS);
    };

    const rollbackMeetingTranscriptionStart = async () => {
      clearMeetingSystemAudioSilenceTimer();
      if (this.audioTapManager) {
        await this.audioTapManager.stop().catch(() => {});
      }
      if (this.linuxPortalAudioManager) {
        await this.linuxPortalAudioManager.stop().catch(() => {});
      }
      if (this.windowsLoopbackAudioManager) {
        await this.windowsLoopbackAudioManager.stop().catch(() => {});
      }
      await stopMeetingAec();
      await stopLiveSpeakerIdentification().catch(() => {});
      resetMeetingLocalState();
      await disconnectMeetingStreaming().catch(() => {});
      this.activeMeetingSpeakerConfig = null;
    };

    const setupDictationCallbacks = (streaming, event) => {
      streaming.onPartialTranscript = (text) => {
        event.sender.send("dictation-realtime-partial", text);
        if (this._dictationPreviewEnabled && text) {
          this.windowManager.showTranscriptionPreview(text);
        }
      };
      streaming.onFinalTranscript = (text) => event.sender.send("dictation-realtime-final", text);
      streaming.onError = (err) => {
        event.sender.send("dictation-realtime-error", err.message);
        if (this._dictationPreviewEnabled) this.windowManager.hideTranscriptionPreview();
      };
      streaming.onSessionEnd = (data) => {
        event.sender.send("dictation-realtime-session-end", data || {});
        if (this._dictationPreviewEnabled) this.windowManager.hideTranscriptionPreview();
      };
    };

    const DICTATION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

    const clearDictationIdleTimer = () => {
      if (this._dictationIdleTimer) {
        clearTimeout(this._dictationIdleTimer);
        this._dictationIdleTimer = null;
      }
    };

    const startDictationIdleTimer = () => {
      clearDictationIdleTimer();
      this._dictationIdleTimer = setTimeout(() => {
        if (this._dictationStreaming) {
          debugLogger.debug("Closing idle dictation warmup connection");
          this._dictationStreaming.disconnect().catch(() => {});
          this._dictationStreaming = null;
        }
      }, DICTATION_IDLE_TIMEOUT_MS);
    };

    const connectDictationStreaming = async (event, options) => {
      // Older renderers did not label the OpenAI dictation adapter. Dictation
      // realtime was OpenAI-only before Tinfoil support, so preserve that
      // established default while requiring new adapters to be explicit.
      options = {
        ...options,
        provider: options?.provider || "openai-realtime",
      };

      if (this._dictationConnectPromise) {
        await this._dictationConnectPromise.catch(() => {});
      }

      clearDictationIdleTimer();
      this._dictationPreviewEnabled = !!options.preview;

      if (this._dictationStreaming) {
        await this._dictationStreaming.disconnect().catch(() => {});
        this._dictationStreaming = null;
      }

      const connectInner = async () => {
        const isCloud = options.mode !== "byok";
        // Dictation renderers before 1.8.4 omit `provider` and mean OpenAI; the
        // default lives here, at the boundary, so the token allowlist stays
        // fail-closed for genuinely unknown providers (#1624).
        const provider = options.provider ?? "openai-realtime";
        const streaming = new OpenAIRealtimeStreaming();
        setupDictationCallbacks(streaming, event);
        // Assign before the token fetch (a real network round trip) so
        // dictation-realtime-send has a live instance to buffer into instead
        // of silently dropping the start of the recording.
        streaming.beginConnecting();
        this._dictationStreaming = streaming;
        try {
          const apiKey = await fetchRealtimeToken(event, {
            mode: options.mode,
            provider,
          });
          if (provider === "tinfoil-realtime") {
            const model = options.model || TINFOIL_REALTIME_MODEL;
            await streaming.connect({
              apiKey,
              model,
              // The capture worklet emits 16kHz PCM; declare the true rate.
              inputRate: 16000,
              createSocket: () => createTinfoilRealtimeSocket({ model, apiKey }),
            });
          } else {
            await streaming.connect({
              apiKey,
              model: options.model || "gpt-4o-mini-transcribe",
              // OpenAI rejects rates below 24kHz; the 16kHz capture is upsampled instead.
              captureRate: 16000,
              preconfigured: isCloud,
            });
          }
        } catch (err) {
          if (this._dictationStreaming === streaming) this._dictationStreaming = null;
          throw err;
        }
      };

      this._dictationConnectPromise = connectInner();
      try {
        await this._dictationConnectPromise;
      } finally {
        this._dictationConnectPromise = null;
      }
    };

    // Pre-warm: fetch tokens + connect WebSockets before user hits record
    ipcMain.handle("meeting-transcription-prepare", async (event, options = {}) => {
      if (meetingTranscriptionPrepareInProgress || meetingTranscriptionStartInProgress) {
        debugLogger.debug("Meeting transcription prepare already in progress, ignoring");
        return { success: false, error: "Operation in progress" };
      }

      if (!ALLOWED_MEETING_PROVIDERS.has(options.provider)) {
        return { success: false, error: `Unsupported provider: ${options.provider}` };
      }

      if (options.provider === "local") {
        return { success: true };
      }

      const { mode: systemAudioMode } = await getMeetingSystemAudioPlan();
      const requestedConnectionKey = getMeetingConnectionKey(options);

      if (
        isMeetingStreamingConnected(systemAudioMode) &&
        meetingConnectionKey === requestedConnectionKey
      ) {
        debugLogger.debug("Meeting transcription already prepared (warm connections)");
        return { success: true, alreadyPrepared: true };
      }

      meetingTranscriptionPrepareInProgress = true;
      meetingTranscriptionPreparePromise = (async () => {
        let timeoutHandle;
        try {
          await Promise.race([
            connectRealtimeStreaming(event, options),
            new Promise((_, reject) => {
              timeoutHandle = setTimeout(() => reject(new Error("Prepare timed out")), 15000);
            }),
          ]);
          debugLogger.debug("Meeting transcription prepared (meeting streams warm)");
          return { success: true };
        } catch (error) {
          debugLogger.error("Meeting transcription prepare error", { error: error.message });
          return toPolicyFailure(error);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          meetingTranscriptionPrepareInProgress = false;
          meetingTranscriptionPreparePromise = null;
        }
      })();

      return meetingTranscriptionPreparePromise;
    });

    ipcMain.handle("meeting-transcription-cancel", async () => {
      if (isMeetingStreamingConnected() || meetingLocalTimer) {
        return { success: false, reason: "recording-active" };
      }
      meetingTranscriptionPrepareInProgress = false;
      meetingTranscriptionStartInProgress = false;
      meetingTranscriptionPreparePromise = null;
      return { success: true };
    });

    const startMeetingTranscription = async (event, options = {}) => {
      // Wait for any in-flight prepare to finish before starting
      if (meetingTranscriptionPreparePromise) {
        debugLogger.debug("Meeting transcription start: waiting for in-flight prepare");
        await meetingTranscriptionPreparePromise;
      }

      if (meetingTranscriptionStartInProgress) {
        debugLogger.debug("Meeting transcription start already in progress, ignoring");
        return { success: false, error: "Operation in progress" };
      }

      if (!ALLOWED_MEETING_PROVIDERS.has(options.provider)) {
        return { success: false, error: `Unsupported provider: ${options.provider}` };
      }

      meetingTranscriptionStartInProgress = true;
      // The lifecycle wrapper is the only caller and always injects the same
      // sessionId it registered; re-deriving one here would silently break
      // scoped stop/auto-end matching.
      const recordingSessionId = options.sessionId;
      meetingStartedAt = Date.now();
      meetingConnectionOptions = options;
      meetingConnectionWin = BrowserWindow.fromWebContents(event.sender);
      meetingReconnectCount = 0;
      meetingFatalErrorSent = false;
      this.meetingDetectionEngine?.endRecordingSession();
      this.meetingDetectionEngine?.setUserRecording(true);

      const completeStart = async (result) => {
        await this.meetingDetectionEngine?.beginRecordingSession({
          sessionId: recordingSessionId,
          autoEndEligible: options.autoEndEligible === true,
          ownerWebContents: event.sender,
          // Renderer loopback may still fail after main chooses its strategy.
          // Auto-end stays fail-safe until the renderer confirms a real source.
          systemAudioAvailable: false,
        });
        // Arms on any active system-audio strategy — capture follows platform
        // capability, not call detection — so the warning copy also covers
        // in-person recordings where a silent system tap is expected.
        if (result.systemAudioStrategy && result.systemAudioStrategy !== "unsupported") {
          armMeetingSystemAudioSilenceTimer(meetingConnectionWin, result.systemAudioStrategy);
        }
        return { ...result, sessionId: recordingSessionId };
      };

      try {
        const systemAudioPlan = await getMeetingSystemAudioPlan({ refreshWindowsCapability: true });
        let { mode: systemAudioMode, strategy: systemAudioStrategy } = systemAudioPlan;
        const requestedConnectionKey = getMeetingConnectionKey(options);
        meetingEchoLeakDetector.reset();
        meetingOneOnOneAttendee = resolveOneOnOneAttendeeForNote(options.noteId);
        meetingOneOnOneProfileBound = false;
        meetingNoteId = options.noteId ?? null;
        this._activeMeetingNoteId = meetingNoteId;

        // Seed the speaker cap from the note/calendar participants up front so live
        // identification isn't stuck at the default if the renderer never pushes a config.
        if (!this.activeMeetingSpeakerConfig) {
          this.activeMeetingSpeakerConfig = this._resolveInitialMeetingSpeakerConfig(meetingNoteId);
        }

        if (systemAudioMode === "unsupported" && this._meetingSystemStreaming?.isConnected) {
          await this._meetingSystemStreaming.disconnect().catch(() => ({ text: "" }));
          this._meetingSystemStreaming = null;
        }

        // If already prepared (warm connections from prepare), just re-attach handlers
        if (
          !meetingLocalMode &&
          isMeetingStreamingConnected(systemAudioMode) &&
          meetingConnectionKey === requestedConnectionKey
        ) {
          debugLogger.debug("Meeting transcription start: reusing warm connections");
          const win = BrowserWindow.fromWebContents(event.sender);
          attachMeetingStreamingHandlers(this._meetingMicStreaming, win, "mic");
          if (systemAudioMode !== "unsupported") {
            attachMeetingStreamingHandlers(this._meetingSystemStreaming, win, "system");
          }
          await startMeetingAec(systemAudioMode);
          await startLiveSpeakerIdentification(win, systemAudioMode);
          ({ systemAudioMode, systemAudioStrategy } = await startMeetingSystemAudio(
            event,
            systemAudioMode,
            systemAudioStrategy,
            "during warm-start reuse"
          ));
          return await completeStart({
            success: true,
            systemAudioMode,
            systemAudioStrategy,
            oneOnOneAttendee: meetingOneOnOneAttendee,
          });
        }

        if (options.provider === "local") {
          meetingLocalMode = true;
          meetingLocalProvider = options.localProvider || "whisper";
          meetingLocalModel = options.localModel || null;
          meetingLocalLanguage = options.language || null;
          meetingLocalWin = BrowserWindow.fromWebContents(event.sender);
          meetingLocalBuffers = { mic: [], system: [] };
          meetingLocalTranscript = "";

          await startLiveSpeakerIdentification(meetingLocalWin, systemAudioMode);
          await startMeetingAec(systemAudioMode);

          meetingLocalTimer = setInterval(() => {
            transcribeAllLocalBuffers();
          }, LOCAL_MEETING_CHUNK_INTERVAL_MS);

          ({ systemAudioMode, systemAudioStrategy } = await startMeetingSystemAudio(
            event,
            systemAudioMode,
            systemAudioStrategy,
            "in local meeting mode"
          ));

          debugLogger.debug("Meeting transcription started in local mode", {
            provider: meetingLocalProvider,
            systemAudioMode,
            systemAudioStrategy,
          });

          return await completeStart({
            success: true,
            systemAudioMode,
            systemAudioStrategy,
            oneOnOneAttendee: meetingOneOnOneAttendee,
          });
        }

        await connectRealtimeStreaming(event, options);
        const realtimeWin = BrowserWindow.fromWebContents(event.sender);
        await startLiveSpeakerIdentification(realtimeWin, systemAudioMode);
        await startMeetingAec(systemAudioMode);
        ({ systemAudioMode, systemAudioStrategy } = await startMeetingSystemAudio(
          event,
          systemAudioMode,
          systemAudioStrategy,
          "in realtime mode"
        ));
        return await completeStart({
          success: true,
          systemAudioMode,
          systemAudioStrategy,
          oneOnOneAttendee: meetingOneOnOneAttendee,
        });
      } catch (error) {
        await rollbackMeetingTranscriptionStart();
        this.meetingDetectionEngine?.endRecordingSession(recordingSessionId);
        this.meetingDetectionEngine?.setUserRecording(false);
        debugLogger.error("Meeting transcription start error", { error: error.message });
        return toPolicyFailure(error);
      } finally {
        meetingTranscriptionStartInProgress = false;
      }
    };

    const sendMeetingAudio = (audioBuffer, source) => {
      const outboundBuffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
      // Auto-end judges "is anyone audible" from the raw chunk of either
      // channel, before AEC/holdback/muting can swallow it.
      this.meetingDetectionEngine?.recordMeetingAudioChunk(source, outboundBuffer);

      if (source === "system") {
        const receivedAt = Date.now();
        meetingEchoLeakDetector.recordSystemChunk(outboundBuffer, receivedAt);
        if (meetingAecEnabled && !this.meetingAecManager?.processSystemBuffer(outboundBuffer)) {
          meetingAecEnabled = false;
        }
        flushPendingMeetingMicChunks();

        if (meetingLiveSpeakerActive) {
          // identification.startTime counts samples from the first chunk the
          // identifier sees, so the wall-clock anchor has to be the arrival of
          // that chunk. Stamping it when identification starts is only correct
          // when capture is already running (the macOS tap); the Windows
          // loopback helper can take seconds to hand over its first buffer, and
          // a stale anchor shifts every label earlier by that gap.
          meetingLiveSpeakerStartedAt ??= receivedAt;
          void liveSpeakerIdentifier.feedAudio(outboundBuffer);
        }

        if (!meetingDiarizationStream) {
          const os = require("os");
          meetingDiarizationPath = path.join(os.tmpdir(), `ow-diarize-raw-${Date.now()}.pcm`);
          meetingDiarizationStream = fs.createWriteStream(meetingDiarizationPath);
          meetingDiarizationStartedAt = receivedAt;
        }
        meetingDiarizationStream.write(outboundBuffer);

        if (!meetingSystemAudioHeard) {
          const { rms, peak } = computeChunkStats(outboundBuffer);
          if (rms >= MEETING_MIC_SILENCE_RMS || peak >= MEETING_MIC_SILENCE_PEAK) {
            // A call is audibly underway: diarization stays on the system
            // channel, so stop paying the mic capture's disk cost.
            meetingSystemAudioHeard = true;
            dropMeetingMicDiarizationCapture();
          }
        }

        dispatchMeetingAudioBuffer(outboundBuffer, "system");
        return;
      }

      if (source === "mic") {
        // Until the session proves to be a call (audible system audio), keep a
        // raw mic capture so an in-person recording can be diarized. Written
        // pre-AEC/pre-gate so the timeline stays continuous, like the system
        // capture above.
        if (!meetingSystemAudioHeard) {
          if (!meetingMicDiarizationStream) {
            const receivedAt = Date.now();
            meetingMicDiarizationPath = path.join(
              os.tmpdir(),
              `ow-diarize-raw-mic-${receivedAt}.pcm`
            );
            meetingMicDiarizationStream = fs.createWriteStream(meetingMicDiarizationPath);
            meetingMicDiarizationStartedAt = receivedAt;
          }
          meetingMicDiarizationStream.write(outboundBuffer);
        }

        if (processMeetingMicWithAec(outboundBuffer)) {
          return;
        }

        if (!hasNativeMeetingSystemAudio()) {
          const analysis = meetingEchoLeakDetector.analyzeMicChunk(outboundBuffer);
          if (analysis?.shouldMute && !meetingAecEnabled) {
            if (!meetingLocalMode) {
              dispatchMeetingAudioBuffer(Buffer.alloc(outboundBuffer.length), "mic");
            }
            return;
          }

          dispatchMeetingAudioBuffer(outboundBuffer, "mic");
          return;
        }

        meetingPendingMicChunks.push({
          buffer: outboundBuffer,
          queuedAt: Date.now(),
        });
        flushPendingMeetingMicChunks();
        return;
      }
    };

    // The Windows helper reports capture_silent when its own stream is silent
    // while a render endpoint is playing: activation succeeded but no audio
    // will ever arrive, so hand the live session to Chromium's renderer
    // loopback. The silence watchdog stays armed in case that fails too.
    const degradeMeetingSystemAudioToLoopback = async (event) => {
      if (meetingSystemAudioDegraded || meetingSystemAudioHeard) return;
      meetingSystemAudioDegraded = true;
      debugLogger.warn(
        "Windows system audio helper captured only silence, switching to renderer loopback",
        {},
        "meeting"
      );
      await this.windowsLoopbackAudioManager?.stop().catch(() => {});
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) {
        win.webContents.send("meeting-system-audio-degraded");
      }
    };

    const startManagedMeetingSystemAudio = (event, manager, warningLabel, onWarningCode) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      return manager.start({
        onChunk: (chunk) => {
          sendMeetingAudio(chunk, "system");
        },
        onError: (error) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("meeting-transcription-error", error.message);
          }
        },
        onWarning: (warning) => {
          debugLogger.warn(
            warningLabel,
            { code: warning.code, message: warning.message },
            "meeting"
          );
          onWarningCode?.(warning.code);
        },
      });
    };

    const fallBackToMicOnly = async (context) => {
      if (this._meetingSystemStreaming?.isConnected) {
        await this._meetingSystemStreaming.disconnect().catch((disconnectError) => {
          debugLogger.debug(
            `System streaming disconnect during ${context} fallback failed`,
            { error: disconnectError.message },
            "meeting"
          );
        });
      }
      this._meetingSystemStreaming = null;
      await stopLiveSpeakerIdentification().catch(() => {});
    };

    const startMeetingSystemAudio = async (
      event,
      systemAudioMode,
      systemAudioStrategy,
      context
    ) => {
      if (systemAudioMode === "native") {
        try {
          await startManagedMeetingSystemAudio(
            event,
            this.audioTapManager,
            "macOS system audio tap warning"
          );
          return { systemAudioMode, systemAudioStrategy };
        } catch (error) {
          debugLogger.warn(
            `Native system audio tap failed ${context}, falling back to mic-only`,
            { error: error.message },
            "meeting"
          );
          await fallBackToMicOnly("native");
          return { systemAudioMode: "unsupported", systemAudioStrategy: "unsupported" };
        }
      }

      if (systemAudioStrategy === "wasapi-loopback") {
        try {
          await startManagedMeetingSystemAudio(
            event,
            this.windowsLoopbackAudioManager,
            "Windows system audio warning",
            (code) => {
              if (code === "capture_silent") {
                void degradeMeetingSystemAudioToLoopback(event);
              }
            }
          );
          return { systemAudioMode, systemAudioStrategy };
        } catch (error) {
          debugLogger.warn(
            `Windows system audio helper failed ${context}, falling back to renderer loopback`,
            { error: error.message },
            "meeting"
          );
          // The renderer captures via Chromium's display-media loopback when
          // it sees the downgraded strategy in the start result.
          return { systemAudioMode, systemAudioStrategy: "loopback" };
        }
      }

      if (systemAudioStrategy !== "pipewire-loopback") {
        return { systemAudioMode, systemAudioStrategy };
      }

      try {
        await startManagedMeetingSystemAudio(
          event,
          this.linuxPortalAudioManager,
          "Linux PipeWire system audio warning"
        );
        return { systemAudioMode, systemAudioStrategy };
      } catch (error) {
        debugLogger.warn(
          `Linux PipeWire helper failed ${context}, falling back to mic-only`,
          { error: error.message },
          "meeting"
        );
        await fallBackToMicOnly("PipeWire");
        return { systemAudioMode: "unsupported", systemAudioStrategy: "unsupported" };
      }
    };

    ipcMain.on("meeting-transcription-send", (_event, audioBuffer, source) => {
      sendMeetingAudio(audioBuffer, source);
    });

    const stopMeetingTranscription = async (expectedSessionId) => {
      // Only a *different* live session blocks teardown — it owns the shared
      // capture now. With no engine session (e.g. after quit-path engine stop)
      // the streams below must still be torn down.
      if (this.meetingDetectionEngine?.endRecordingSession(expectedSessionId) === false) {
        return { success: false, reason: "stale-session" };
      }
      this.meetingDetectionEngine?.setUserRecording(false);
      clearMeetingSystemAudioSilenceTimer();
      try {
        if (this.audioTapManager) {
          await this.audioTapManager.stop();
        }
        if (this.linuxPortalAudioManager) {
          await this.linuxPortalAudioManager.stop().catch(() => {});
        }
        if (this.windowsLoopbackAudioManager) {
          await this.windowsLoopbackAudioManager.stop().catch(() => {});
        }

        flushPendingMeetingMicChunks(true);
        await stopMeetingAec();

        const liveSpeakerState = await stopLiveSpeakerIdentification().catch(() => null);

        const diarizationSessionId = `diar-${Date.now()}`;
        const diarizationWin = meetingLocalWin || this.windowManager.controlPanelWindow;

        if (meetingLocalMode) {
          if (meetingLocalTimer) {
            clearInterval(meetingLocalTimer);
            meetingLocalTimer = null;
          }
          try {
            await transcribeAllLocalBuffers();
          } catch (err) {
            debugLogger.error("Local meeting final transcription failed", { error: err.message });
          }
          flushPendingMicFinals(true);
          const { diarizationPcmPath, diarizationSegments, diarizationStartedAt, diarizedSource } =
            await captureMeetingDiarizationState();
          const transcript =
            buildOrderedTranscriptText(diarizationSegments) || meetingLocalTranscript;
          const sessionSpeakerConfigSnapshot = this.activeMeetingSpeakerConfig;
          const noteIdSnapshot = meetingNoteId;
          this.activeMeetingSpeakerConfig = null;
          resetMeetingLocalState();

          // Fire-and-forget background diarization (or notify skip)
          this._startOrSkipDiarization(
            diarizationSessionId,
            diarizationPcmPath,
            diarizationStartedAt,
            diarizationSegments,
            diarizationWin,
            liveSpeakerState,
            sessionSpeakerConfigSnapshot,
            noteIdSnapshot,
            diarizedSource
          );

          return { success: true, transcript, diarizationSessionId };
        }

        const results = await disconnectMeetingStreaming({ flushPending: true });
        const { diarizationPcmPath, diarizationSegments, diarizationStartedAt, diarizedSource } =
          await captureMeetingDiarizationState();
        const transcript =
          buildOrderedTranscriptText(diarizationSegments) ||
          [results[0]?.text, results[1]?.text].filter(Boolean).join(" ");

        const sessionSpeakerConfigSnapshot = this.activeMeetingSpeakerConfig;
        const noteIdSnapshot = meetingNoteId;
        this.activeMeetingSpeakerConfig = null;

        // Fire-and-forget background diarization (or notify skip)
        this._startOrSkipDiarization(
          diarizationSessionId,
          diarizationPcmPath,
          diarizationStartedAt,
          diarizationSegments,
          diarizationWin,
          liveSpeakerState,
          sessionSpeakerConfigSnapshot,
          noteIdSnapshot,
          diarizedSource
        );

        return { success: true, transcript, diarizationSessionId };
      } catch (error) {
        debugLogger.error("Meeting transcription stop error", { error: error.message });
        return { success: false, error: error.message };
      }
    };

    const meetingTranscriptionLifecycle = createMeetingTranscriptionLifecycle({
      start: ({ sessionId, ownerWebContents, options }) =>
        startMeetingTranscription({ sender: ownerWebContents }, { ...options, sessionId }),
      stop: (sessionId) => stopMeetingTranscription(sessionId),
      onError: (error, sessionId) => {
        debugLogger.error(
          "Meeting transcription owner-loss teardown failed",
          { error: error?.message, sessionId },
          "meeting"
        );
      },
    });

    ipcMain.handle("meeting-transcription-start", (event, options = {}) => {
      const sessionId =
        typeof options.sessionId === "string" && options.sessionId.length > 0
          ? options.sessionId
          : crypto.randomUUID();
      return meetingTranscriptionLifecycle.startSession({
        sessionId,
        ownerWebContents: event.sender,
        options,
      });
    });

    ipcMain.handle("meeting-transcription-stop", (_event, expectedSessionId) =>
      meetingTranscriptionLifecycle.stopSession(expectedSessionId)
    );

    ipcMain.handle(
      "meeting-transcription-set-system-audio-available",
      async (event, sessionId, available) => {
        const updated = await this.meetingDetectionEngine?.setRecordingSystemAudioAvailable(
          sessionId,
          available === true,
          event.sender
        );
        return updated === true ? { success: true } : { success: false, reason: "stale-session" };
      }
    );

    const streamingStartFailure = (err) => {
      const result = toPolicyFailure(err);
      if (err.messageKey) result.messageKey = err.messageKey;
      if (err.networkCode) result.networkCode = err.networkCode;
      return result;
    };

    ipcMain.handle("dictation-realtime-warmup", async (event, options = {}) => {
      try {
        await connectDictationStreaming(event, options);
        startDictationIdleTimer();
        return { success: true };
      } catch (err) {
        return streamingStartFailure(err);
      }
    });

    ipcMain.handle("dictation-realtime-start", async (event, options = {}) => {
      try {
        clearDictationIdleTimer();
        this._dictationPreviewEnabled = !!options.preview;
        if (!this._dictationStreaming?.isConnected) await connectDictationStreaming(event, options);
        return { success: true };
      } catch (err) {
        return streamingStartFailure(err);
      }
    });

    ipcMain.on("dictation-realtime-send", (_event, buffer) => {
      this._dictationStreaming?.sendAudio(Buffer.from(buffer));
    });

    ipcMain.handle("dictation-realtime-stop", async () => {
      clearDictationIdleTimer();
      if (!this._dictationStreaming) {
        return { success: true, text: "" };
      }
      const result = await this._dictationStreaming.disconnect().catch(() => ({ text: "" }));
      this._dictationStreaming = null;
      if (this._dictationPreviewEnabled) {
        this.windowManager.hideTranscriptionPreview();
        this._dictationPreviewEnabled = false;
      }
      return { success: true, text: result.text || "" };
    });

    ipcMain.handle(
      "start-dictation-preview",
      async (_event, { provider, model, language, display = true }) => {
        resetDictationPreviewState();
        const gen = dictationPreviewGen;
        dictationPreviewMode = true;
        dictationPreviewSessionActive = true;
        dictationPreviewProvider = provider;
        dictationPreviewModel = model;
        dictationPreviewLanguage = language || null;
        dictationPreviewDisplay = display;
        dictationPreviewChunkCount = 0;
        if (display) this.windowManager.showTranscriptionPreview("");

        if (provider === "nvidia" && this.parakeetManager.supportsOnlineStreaming(model)) {
          try {
            const stream = await this.parakeetManager.createOnlineStream(model, {
              onUpdate: (text) => {
                if (gen === dictationPreviewGen && text && dictationPreviewDisplay) {
                  this.windowManager.showTranscriptionPreview(text);
                }
              },
              onError: (error) => {
                if (gen !== dictationPreviewGen || dictationPreviewStream !== stream) return;
                // Keep the preview alive on the chunked path; the final
                // transcript falls back to decoding the full recording.
                debugLogger.warn("Online preview stream failed mid-session, falling back", {
                  model,
                  error: error.message,
                });
                dictationPreviewStream = null;
                if (dictationPreviewDisplay) startDictationPreviewTimer();
              },
            });
            if (gen !== dictationPreviewGen) {
              stream.abort();
              return { success: true };
            }
            dictationPreviewStream = stream;
            for (const chunk of dictationPreviewBuffer) {
              stream.sendPcm16(chunk);
            }
            dictationPreviewBuffer = [];
            return { success: true };
          } catch (error) {
            debugLogger.warn("Online preview stream unavailable, falling back to chunked preview", {
              model,
              error: error.message,
            });
          }
        }

        if (gen !== dictationPreviewGen) return { success: true };
        if (!display) {
          // A headless session exists only to feed the online stream; without
          // one, buffered PCM would just accumulate with no consumer.
          resetDictationPreviewState();
          return { success: true };
        }
        startDictationPreviewTimer();
        return { success: true };
      }
    );

    ipcMain.on("dictation-preview-audio", (_event, audioBuffer) => {
      if (!dictationPreviewMode) return;
      dictationPreviewChunkCount++;
      if (dictationPreviewChunkCount <= 3 || dictationPreviewChunkCount % 50 === 0) {
        debugLogger.debug("Dictation preview audio received", {
          bytes: audioBuffer?.byteLength || audioBuffer?.length,
          count: dictationPreviewChunkCount,
          bufferSize: dictationPreviewBuffer.length,
        });
      }
      const pcm = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
      if (dictationPreviewStream) {
        dictationPreviewStream.sendPcm16(pcm);
        return;
      }
      dictationPreviewBuffer.push(pcm);
    });

    ipcMain.handle("dismiss-dictation-preview", () =>
      queueDictationPreviewOperation(async () => {
        resetDictationPreviewState();
        this.windowManager.hideTranscriptionPreview();
        return { success: true };
      })
    );

    ipcMain.handle("update-dictation-preview", (_event, text) =>
      queueDictationPreviewOperation(async () => {
        if (typeof text !== "string" || !text.trim()) {
          return { success: true };
        }
        if (!dictationPreviewSessionActive) {
          resetDictationPreviewState();
          dictationPreviewSessionActive = true;
          dictationPreviewDisplay = true;
        }
        await this.windowManager.showTranscriptionPreview(text);
        return { success: true };
      })
    );

    ipcMain.handle("complete-dictation-preview", (_event, { text } = {}) =>
      queueDictationPreviewOperation(async () => {
        if (!dictationPreviewSessionActive) {
          return { success: true };
        }
        if (typeof text === "string" && text.trim()) {
          this.windowManager.completeTranscriptionPreview(text);
        } else {
          resetDictationPreviewState();
          this.windowManager.hideTranscriptionPreview();
        }
        return { success: true };
      })
    );

    ipcMain.handle("hide-dictation-preview", () =>
      queueDictationPreviewOperation(async () => {
        resetDictationPreviewState();
        this.windowManager.hideTranscriptionPreview();
        return { success: true };
      })
    );

    ipcMain.handle("stop-dictation-preview", async (_event, options = {}) => {
      if (!dictationPreviewMode && !dictationPreviewSessionActive) {
        return { success: true, streamed: false, text: "" };
      }
      clearInterval(dictationPreviewTimer);
      dictationPreviewTimer = null;
      const display = dictationPreviewDisplay;
      // Missing flag defaults to trusted so non-streaming callers never regress.
      const rendererFlushOk = options.flushed !== false;
      let streamed = false;
      let streamedText = "";
      if (dictationPreviewStream) {
        const stream = dictationPreviewStream;
        dictationPreviewStream = null;
        const gen = dictationPreviewGen;
        const result = await stream.finish().catch(() => null);
        if (gen !== dictationPreviewGen) {
          return { success: true, streamed: false, text: "" };
        }
        if (result) {
          streamedText = result.text || "";
          // Trust the streamed transcript only on a clean server flush and a clean renderer flush.
          streamed = !result.truncated && rendererFlushOk;
        }
        if (streamedText && display && dictationPreviewSessionActive) {
          this.windowManager.showTranscriptionPreview(streamedText);
        }
      } else {
        await transcribeDictationPreviewChunk();
      }
      resetDictationPreviewState({ preserveSession: display });
      if (!display || !dictationPreviewSessionActive) {
        return { success: true, streamed, text: streamedText };
      }
      this.windowManager.holdTranscriptionPreview(options);
      return { success: true, streamed, text: streamedText };
    });

    ipcMain.handle("update-transcription-text", async (_event, id, text, rawText) => {
      try {
        this.databaseManager.updateTranscriptionText(id, text, rawText);
        const updated = this.databaseManager.getTranscriptionById(id);
        return { success: true, transcription: updated };
      } catch (error) {
        debugLogger.error(
          "Failed to update transcription text",
          { id, error: error.message },
          "audio-storage"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cloud-reason", async (event, text, opts = {}) => {
      const sender = event.sender;
      const senderId = sender.id;
      const requestId = crypto.randomUUID();
      const controller = this._cloudReasonRequests.begin(senderId, requestId);
      const cancelSenderRequests = () => this._cloudReasonRequests.cancelSender(senderId);
      sender.once("destroyed", cancelSenderRequests);
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        debugLogger.debug(
          "Cloud reason request",
          {
            model: opts.model || "(default)",
            agentName: opts.agentName || "(none)",
            textLength: text?.length || 0,
            hasScreenContext: !!opts.screenContext,
          },
          "cloud-api"
        );

        const response = await proxyFetch(`${apiUrl}/api/reason`, {
          method: "POST",
          signal: controller.signal,
          headers: withPolicyHeaders({
            "Content-Type": "application/json",
            ...authHeader,
          }),
          body: JSON.stringify({
            text,
            model: opts.model,
            agentName: opts.agentName,
            customDictionary: opts.customDictionary,
            customPrompt: opts.customPrompt,
            systemPrompt: opts.systemPrompt,
            requestPurpose: opts.requestPurpose,
            promptMode: opts.promptMode,
            screenContext: opts.screenContext,
            language: opts.language,
            locale: opts.locale,
            sessionId: this.sessionId,
            clientType: "desktop",
            appVersion: app.getVersion(),
            clientVersion: app.getVersion(),
            sttProvider: opts.sttProvider,
            sttModel: opts.sttModel,
            sttProcessingMs: opts.sttProcessingMs,
            sttWordCount: opts.sttWordCount,
            sttLanguage: opts.sttLanguage,
            audioDurationMs: opts.audioDurationMs,
            audioSizeBytes: opts.audioSizeBytes,
            audioFormat: opts.audioFormat,
            clientTotalMs: opts.clientTotalMs,
          }),
        });

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          if (response.status === 503) {
            return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
          }
          throw await readPolicyResponseError(response, `API error: ${response.status}`);
        }

        const data = await response.json();
        debugLogger.debug(
          "Cloud reason response",
          {
            model: data.model,
            provider: data.provider,
            resultLength: data.text?.length || 0,
            promptMode: data.promptMode,
            matchType: data.matchType,
            screenContextApplied: data.screenContextApplied,
          },
          "cloud-api"
        );
        return {
          success: true,
          text: data.text,
          model: data.model,
          provider: data.provider,
          promptMode: data.promptMode,
          matchType: data.matchType,
          screenContextApplied: data.screenContextApplied,
        };
      } catch (error) {
        if (controller.signal.aborted) {
          return { success: false, error: "Cancelled", code: "REASON_CANCELLED" };
        }
        debugLogger.error("Cloud reasoning error:", error);
        return toPolicyFailure(error);
      } finally {
        sender.removeListener("destroyed", cancelSenderRequests);
        this._cloudReasonRequests.complete(senderId, requestId, controller);
      }
    });

    ipcMain.on("cloud-reason-cancel", (event) => {
      this._cloudReasonRequests.cancelSender(event.sender.id);
    });

    ipcMain.on("cloud-agent-stream-start", async (event, requestId, messages, opts = {}) => {
      if (typeof requestId !== "string" || !requestId.trim()) return;

      const sender = event.sender;
      const senderId = sender.id;
      const controller = this._agentStreamRequests.begin(senderId, requestId);
      const cancelSenderRequests = () => this._agentStreamRequests.cancelSender(senderId);
      const sendToRenderer = (channel, payload) => {
        if (!sender.isDestroyed()) sender.send(channel, payload);
      };
      sender.once("destroyed", cancelSenderRequests);

      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        const response = await proxyFetch(`${apiUrl}/api/agent/stream`, {
          method: "POST",
          headers: withPolicyHeaders({
            "Content-Type": "application/json",
            ...authHeader,
          }),
          body: JSON.stringify({
            messages,
            systemPrompt: opts.systemPrompt,
            tools: opts.tools,
            ...(opts.screenContext ? { screenContext: opts.screenContext } : {}),
            sessionId: this.sessionId,
            clientType: "desktop",
            appVersion: app.getVersion(),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const error = await readPolicyResponseError(response, `API error: ${response.status}`);
          if (response.status === 401 && !error.code) error.code = "AUTH_EXPIRED";
          if (response.status === 503 && !error.code) error.code = "SERVER_ERROR";
          sendToRenderer("cloud-agent-stream-error", {
            requestId,
            ...toPolicyFailure(error),
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                sendToRenderer("cloud-agent-stream-chunk", {
                  requestId,
                  chunk: JSON.parse(line),
                });
              } catch {
                // skip malformed NDJSON line
              }
            }
          }
          if (buffer.trim()) {
            try {
              sendToRenderer("cloud-agent-stream-chunk", {
                requestId,
                chunk: JSON.parse(buffer),
              });
            } catch {
              // skip malformed remainder
            }
          }
        } finally {
          reader.releaseLock();
        }

        sendToRenderer("cloud-agent-stream-end", { requestId });
      } catch (error) {
        if (controller.signal.aborted) {
          sendToRenderer("cloud-agent-stream-end", { requestId });
          return;
        }
        debugLogger.error("Cloud agent stream error:", error);
        sendToRenderer("cloud-agent-stream-error", {
          requestId,
          ...toPolicyFailure(error),
        });
      } finally {
        sender.removeListener("destroyed", cancelSenderRequests);
        this._agentStreamRequests.complete(senderId, requestId, controller);
      }
    });

    ipcMain.on("cloud-agent-stream-cancel", (event, requestId) => {
      if (typeof requestId !== "string" || !requestId.trim()) return;
      this._agentStreamRequests.cancel(event.sender.id, requestId);
    });

    ipcMain.handle("agent-open-note", async (_event, noteId) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        await this.windowManager.queueNoteNavigation({
          noteId,
          folderId: note?.folder_id ?? null,
        });
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open note from agent:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("agent-web-search", async (event, query, numResults = 5) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        debugLogger.debug("Agent web search request", { query, numResults }, "cloud-api");

        const response = await proxyFetch(`${apiUrl}/api/agent/web-search`, {
          method: "POST",
          headers: withPolicyHeaders({
            "Content-Type": "application/json",
            ...authHeader,
          }),
          body: JSON.stringify({ query, numResults }),
        });

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          if (response.status === 503) {
            return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
          }
          const error = await readPolicyResponseError(response, `API error: ${response.status}`);
          return toPolicyFailure(error);
        }

        const data = await response.json();
        return { success: true, ...data };
      } catch (error) {
        debugLogger.error("Agent web search error:", error);
        return toPolicyFailure(error);
      }
    });

    ipcMain.handle(
      "cloud-streaming-usage",
      async (event, text, audioDurationSeconds, opts = {}) => {
        try {
          const apiUrl = getApiUrl();
          if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

          const authHeader = await getAuthHeader(event);
          if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

          const response = await proxyFetch(`${apiUrl}/api/streaming-usage`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...authHeader,
            },
            body: JSON.stringify({
              text,
              audioDurationSeconds,
              sessionId: this.sessionId,
              clientType: "desktop",
              appVersion: app.getVersion(),
              clientVersion: app.getVersion(),
              sttProvider: opts.sttProvider,
              sttModel: opts.sttModel,
              sttProcessingMs: opts.sttProcessingMs,
              sttLanguage: opts.sttLanguage,
              audioSizeBytes: opts.audioSizeBytes,
              audioFormat: opts.audioFormat,
              clientTotalMs: opts.clientTotalMs,
              sendLogs: opts.sendLogs,
            }),
          });

          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          if (response.status === 503) {
            return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
          }
          if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
          }

          const data = await response.json();
          return { success: true, ...data };
        } catch (error) {
          debugLogger.error("Cloud streaming usage error", { error: error.message }, "cloud-api");
          return { success: false, error: error.message };
        }
      }
    );

    ipcMain.handle("cloud-usage", async (event) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        // Never serve entitlement from Chromium's HTTP cache: a cached
        // response can outlive the account that produced it.
        const response = await proxyFetch(`${apiUrl}/api/usage`, {
          headers: authHeader,
          cache: "no-store",
        });

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          if (response.status === 503) {
            return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
          }
          const errorData = await response.json().catch(() => ({}));
          const message = errorData.error || `API error: ${response.status}`;
          debugLogger.error(`Cloud usage fetch error: ${message}`);
          return { success: false, error: message, code: errorData.code };
        }

        const data = await response.json();
        return { success: true, ...data };
      } catch (error) {
        debugLogger.error("Cloud usage fetch error:", error);
        return { success: false, error: error.message };
      }
    });

    const fetchStripeUrl = async (event, endpoint, errorPrefix, body) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        const headers = { ...authHeader };
        const fetchOpts = { method: "POST", headers };
        if (body) {
          headers["Content-Type"] = "application/json";
          fetchOpts.body = JSON.stringify(body);
        }

        const response = await proxyFetch(`${apiUrl}${endpoint}`, fetchOpts);

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          if (response.status === 503) {
            return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
          }
          const errorData = await response.json().catch(() => ({}));
          const message = errorData.error || `API error: ${response.status}`;
          debugLogger.error(`${errorPrefix}: ${message}`);
          return { success: false, error: message, code: errorData.code };
        }

        const data = await response.json();
        return { success: true, url: data.url };
      } catch (error) {
        debugLogger.error(`${errorPrefix}: ${error.message}`);
        return { success: false, error: error.message };
      }
    };

    ipcMain.handle("cloud-checkout", (event, opts) =>
      fetchStripeUrl(event, "/api/stripe/checkout", "Cloud checkout error", opts || undefined)
    );

    ipcMain.handle("cloud-billing-portal", (event) =>
      fetchStripeUrl(event, "/api/stripe/portal", "Cloud billing portal error")
    );

    ipcMain.handle("cloud-switch-plan", async (event, opts) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        const response = await proxyFetch(`${apiUrl}/api/stripe/switch-plan`, {
          method: "POST",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify(opts),
        });

        if (response.status === 401) {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        if (response.status === 503) {
          return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
        }

        const data = await response.json();
        if (!response.ok) {
          return { success: false, error: data.error || "Failed to switch plan" };
        }
        return data;
      } catch (error) {
        debugLogger.error(`Cloud switch plan error: ${error.message}`);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cloud-preview-switch", async (event, opts) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        const response = await proxyFetch(`${apiUrl}/api/stripe/preview-switch`, {
          method: "POST",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify(opts),
        });

        if (response.status === 401) {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        if (response.status === 503) {
          return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
        }

        const data = await response.json();
        if (!response.ok) {
          return { success: false, error: data.error || "Failed to preview plan change" };
        }
        return { success: true, ...data };
      } catch (error) {
        debugLogger.error(`Cloud preview switch error: ${error.message}`);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cloud-api-request", (_event, opts) => handleCloudApiRequest(opts));

    ipcMain.handle("get-stt-config", handleSttConfigRequest);

    ipcMain.handle("get-workspace-policy", async (event, accountId, expectedAuthGeneration) => {
      const authHeaders = await getAuthHeader(event);
      return workspacePolicyManager.getPolicy({ accountId, expectedAuthGeneration, authHeaders });
    });

    ipcMain.handle(
      "get-managed-enterprise-config",
      async (event, accountId, workspaceId, expectedAuthGeneration, forceRefresh = false) => {
        const authHeaders = await getAuthHeader(event);
        return this.enterpriseIdentityManager.getConfig({
          accountId,
          workspaceId,
          expectedAuthGeneration,
          authHeaders,
          forceRefresh,
        });
      }
    );
    ipcMain.handle("clear-managed-enterprise-identity", async () => {
      this.enterpriseIdentityManager.clear();
    });

    ipcMain.handle("get-note-recording-config", handleNoteRecordingConfigRequest);

    ipcMain.handle("transcribe-audio-file-cloud", async (event, filePath, opts = {}) => {
      const requestId = typeof opts?.requestId === "string" ? opts.requestId : null;
      const { signal, release } = this._uploadCancelRegistry.register(requestId);
      try {
        if (typeof filePath !== "string") {
          return { success: false, error: "Invalid file path" };
        }
        const realCloud = resolveAllowedAudioPath(filePath);
        if (!realCloud) return { success: false, error: "File path not allowed" };

        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        const multipartFields = {
          source: "file_upload",
          clientType: "desktop",
          appVersion: app.getVersion(),
          clientVersion: app.getVersion(),
          sessionId: this.sessionId,
        };

        const fileSize = fs.statSync(realCloud).size;

        if (fileSize > CLOUD_INLINE_LIMIT) {
          debugLogger.debug("Large file detected, using client-side chunking", {
            fileSize,
            filePath: path.basename(realCloud),
          });
          const { text, warning, failedChunks, totalChunks } = await chunkedCloudTranscribe({
            filePath: realCloud,
            apiUrl,
            policyHeaders: withPolicyHeaders(authHeader),
            multipartFields,
            onProgress: (payload) => event.sender.send("upload-transcription-progress", payload),
            signal,
          });
          return {
            success: true,
            text,
            ...(warning ? { warning, failedChunks, totalChunks } : {}),
          };
        }

        const audioBuffer = fs.readFileSync(realCloud);
        const ext = path.extname(realCloud).toLowerCase().replace(".", "");
        const contentType = AUDIO_MIME_TYPES[ext] || "audio/mpeg";
        const fileName = path.basename(realCloud);

        const { body, boundary } = buildMultipartBody(
          audioBuffer,
          fileName,
          contentType,
          multipartFields
        );
        const url = new URL(`${apiUrl}/api/transcribe`);
        const data = await postMultipart(url, body, boundary, withPolicyHeaders(authHeader), {
          signal: AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(CLOUD_UPLOAD_TIMEOUT_MS),
          ]),
          session: getInlineCloudUploadSession(),
        });
        const result = interpretTranscribeResponse(data);

        return { success: true, text: result.text };
      } catch (error) {
        if (signal?.aborted) {
          debugLogger.debug("Cloud audio file transcription cancelled", { requestId });
          return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
        }
        debugLogger.error("Cloud audio file transcription error", { error: error.message });
        return toPolicyFailure(error);
      } finally {
        release();
      }
    });

    // Unknown ids are a no-op: BYOK providers don't register a controller,
    // and the renderer fires this for every cancel.
    ipcMain.handle("cancel-upload-transcription", async (_event, requestId) => {
      return { success: this._uploadCancelRegistry.cancel(requestId) > 0 };
    });

    ipcMain.handle(
      "transcribe-audio-file-byok",
      async (
        event,
        {
          filePath,
          apiKey,
          baseUrl,
          model,
          diarize,
          timestamps,
          provider,
          language,
          environment,
          tenant,
          transcriptionMode,
          remoteTranscriptionUrl,
          remoteTranscriptionModel,
        }
      ) => {
        const fs = require("fs");
        try {
          if (typeof filePath !== "string") {
            return { success: false, error: "Invalid file path" };
          }
          const realByok = resolveAllowedAudioPath(filePath);
          if (!realByok) return { success: false, error: "File path not allowed" };

          const { resolveTranscriptionRoute } = await import("./transcriptionRoute.ts");
          const route = resolveTranscriptionRoute({
            settings: {
              transcriptionMode,
              remoteTranscriptionUrl,
              remoteTranscriptionModel,
              cloudTranscriptionProvider: provider,
              cloudTranscriptionModel: model,
              cloudTranscriptionBaseUrl: baseUrl,
              cortiEnvironment: environment,
              cortiTenant: tenant,
            },
            providers: transcriptionProviderBaseUrls(),
            request: { effectiveLanguage: language || undefined },
          });

          // Fail closed: a misconfigured route must never fall through to a default.
          if (route.transport === "error") {
            return { success: false, error: route.message, code: route.code };
          }

          if (route.transport === "http-batch" && route.provider === "self-hosted") {
            // User's own server, so the 25 MB third-party cap does not apply.
            const ext = path.extname(realByok).toLowerCase().replace(".", "");
            const { body, boundary } = buildMultipartBody(
              fs.readFileSync(realByok),
              path.basename(realByok),
              AUDIO_MIME_TYPES[ext] || "audio/mpeg",
              { model: route.model, language: route.language }
            );
            const data = await postMultipart(new URL(route.endpoint), body, boundary);
            if (data.statusCode !== 200) {
              throw new Error(
                data.data?.error?.message ||
                  data.data?.error ||
                  `Self-hosted API Error: ${data.statusCode}`
              );
            }
            return { success: true, text: data.data.text };
          }

          const fileSize = fs.statSync(realByok).size;
          if (route.sizeCapBytes && fileSize > route.sizeCapBytes) {
            return { success: false, error: byokSizeCapError(route.sizeCapBytes) };
          }

          if (route.transport === "proxied" && route.provider === "corti") {
            const clientId = this.environmentManager.getCortiClientId();
            const clientSecret = this.environmentManager.getCortiClientSecret();
            if (!clientId || !clientSecret) {
              throw new Error("Corti credentials not configured. Add them in Settings.");
            }
            const { transcribeAudio } = require("./cortiTranscription");
            const { text } = await transcribeAudio({
              environment: route.cortiEnvironment,
              tenant: route.cortiTenant,
              clientId,
              clientSecret,
              audioBuffer: fs.readFileSync(realByok),
              language: route.language,
            });
            return { success: true, text };
          }

          if (route.transport === "proxied" && route.provider === "tinfoil") {
            const ext = path.extname(realByok).toLowerCase().replace(".", "");
            const { text } = await transcribeWithTinfoil({
              audioBuffer: fs.readFileSync(realByok),
              fileName: path.basename(realByok),
              contentType: AUDIO_MIME_TYPES[ext] || "audio/mpeg",
              language: route.language,
              apiKey: this.environmentManager.getTinfoilKey(),
            });
            return { success: true, text };
          }

          if (route.transport === "proxied" && route.provider === "gemini") {
            const ext = path.extname(realByok).toLowerCase().replace(".", "");
            // Deliberately no language hint — same rationale as the multipart
            // branch below, and Gemini's language_codes is a hard constraint.
            const { text } = await transcribeWithGemini({
              audioBuffer: fs.readFileSync(realByok),
              model: route.model,
              contentType: AUDIO_MIME_TYPES[ext] || "audio/mpeg",
              apiKey: apiKey || this.environmentManager.getGeminiKey(),
            });
            return { success: true, text };
          }

          if (!apiKey && route.provider !== "custom") {
            throw new Error("No API key configured. Add your key in Settings.");
          }

          const audioBuffer = fs.readFileSync(realByok);
          const ext = path.extname(realByok).toLowerCase().replace(".", "");
          const contentType = AUDIO_MIME_TYPES[ext] || "audio/mpeg";
          const fileName = path.basename(realByok);

          // mistral/xai have no OpenAI-compatible endpoint — talk to them
          // directly; everything else consumes the route endpoint as-is.
          let transcriptionUrl;
          const multipartFields = {};
          if (route.provider === "xai") {
            transcriptionUrl = XAI_STT_URL;
            // xAI STT accepts no model field; the route pre-filters language
            if (route.language) {
              multipartFields.language = route.language;
              multipartFields.format = "true";
            }
          } else {
            transcriptionUrl =
              route.provider === "mistral" ? MISTRAL_TRANSCRIPTION_URL : route.endpoint;
            multipartFields.model = route.model;
            // No language field: an uploaded file is often not in the dictation
            // language, and a wrong hint silently mistranscribes it. Providers
            // that require one (Corti) are handled on their own branch above.
          }

          if (diarize) {
            // A Custom endpoint may front OpenAI or Mistral, so fall back to the
            // resolved host before giving up on speaker labels.
            const diarizeTarget =
              route.provider === "custom" ? diarizationHost(route.endpoint) : route.provider;
            if (diarizeTarget === "mistral") {
              multipartFields.diarize = "true";
              multipartFields.timestamp_granularities = "segment";
            } else if (diarizeTarget === "openai") {
              multipartFields.model = "gpt-4o-transcribe-diarize";
              // Speaker annotations require diarized_json; verbose_json is not supported by this model.
              multipartFields.response_format = "diarized_json";
              multipartFields.chunking_strategy = "auto";
            } else {
              // Degrade to a plain transcript, never fail the upload.
              debugLogger.warn(
                "BYOK diarization requested but provider is not OpenAI/Mistral; transcribing without speakers",
                { provider: route.provider, endpoint: route.endpoint }
              );
            }
          } else if (timestamps) {
            // Providers/models that don't support the request keep the
            // plain-text request untouched (helper returns null).
            const fields = timestampRequestFields(route.provider, route.model);
            if (fields) Object.assign(multipartFields, fields);
          }

          const { body, boundary } = buildMultipartBody(
            audioBuffer,
            fileName,
            contentType,
            multipartFields
          );

          const url = new URL(transcriptionUrl);
          // Mistral authenticates with x-api-key, not Bearer.
          const headers = apiKey
            ? route.provider === "mistral"
              ? { "x-api-key": apiKey }
              : route.transport === "http-batch" && route.auth.scheme === "azure-api-key"
                ? { "api-key": apiKey }
                : { Authorization: `Bearer ${apiKey}` }
            : undefined;
          const data = await postMultipart(url, body, boundary, headers);

          if (data.statusCode === 401) {
            return { success: false, error: "Invalid API key. Check your key in Settings." };
          }
          if (data.statusCode === 429) {
            return { success: false, error: "Rate limit exceeded. Please try again later." };
          }
          if (data.statusCode !== 200) {
            throw new Error(
              data.data?.error?.message || data.data?.error || `API error: ${data.statusCode}`
            );
          }

          if (diarize && data.data?.speakers) {
            const segments = (data.data.speakers || []).map((s) => ({
              speaker: s.id || `Speaker ${s.speaker || "?"}`,
              text: s.text || "",
              start: s.start || 0,
              end: s.end || 0,
            }));
            const formatted = segments
              .map(
                (s) =>
                  `[${s.speaker}] ${formatDiarTime(s.start)} - ${formatDiarTime(s.end)}\n${s.text}`
              )
              .join("\n\n");
            return { success: true, text: formatted, diarized: true, segments };
          }

          if (diarize && data.data?.segments) {
            const segments = (data.data.segments || []).map((s) => ({
              speaker: s.speaker || "Speaker ?",
              text: s.text || "",
              start: s.start || 0,
              end: s.end || 0,
            }));
            const formatted = segments
              .map(
                (s) =>
                  `[${s.speaker}] ${formatDiarTime(s.start)} - ${formatDiarTime(s.end)}\n${s.text}`
              )
              .join("\n\n");
            return { success: true, text: formatted, diarized: true, segments };
          }

          if (diarize) {
            debugLogger.warn("BYOK diarization requested but provider returned no speaker data");
          }
          const segments = timestamps ? mapVerboseSegments(data.data) : null;
          return { success: true, text: data.data.text, ...(segments ? { segments } : {}) };
        } catch (error) {
          debugLogger.error("BYOK audio file transcription error", { error: error.message });
          return { success: false, error: error.message };
        }
      }
    );

    ipcMain.handle("get-referral-stats", async (event) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          throw new Error("OpenWhispr API URL not configured");
        }

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) {
          throw new Error("Not authenticated");
        }

        const response = await proxyFetch(`${apiUrl}/api/referrals/stats`, {
          headers: {
            ...authHeader,
          },
        });

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error("Unauthorized - please sign in");
          }
          if (response.status === 503) {
            throw new Error("Service temporarily unavailable");
          }
          throw new Error(`Failed to fetch referral stats: ${response.status}`);
        }

        const data = await response.json();
        return data;
      } catch (error) {
        debugLogger.error("Error fetching referral stats:", error);
        throw error;
      }
    });

    ipcMain.handle("send-referral-invite", async (event, email) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          throw new Error("OpenWhispr API URL not configured");
        }

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) {
          throw new Error("Not authenticated");
        }

        const response = await proxyFetch(`${apiUrl}/api/referrals/invite`, {
          method: "POST",
          headers: {
            ...authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to send invite: ${response.status}`;
          try {
            const errorData = await response.json();
            if (errorData.error) errorMessage = errorData.error;
          } catch (_) {}
          throw new Error(errorMessage);
        }

        const data = await response.json();
        return data;
      } catch (error) {
        debugLogger.error("Error sending referral invite:", error);
        throw error;
      }
    });

    ipcMain.handle("get-referral-invites", async (event) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          throw new Error("OpenWhispr API URL not configured");
        }

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) {
          throw new Error("Not authenticated");
        }

        const response = await proxyFetch(`${apiUrl}/api/referrals/invites`, {
          headers: {
            ...authHeader,
          },
        });

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error("Unauthorized - please sign in");
          }
          if (response.status === 503) {
            throw new Error("Service temporarily unavailable");
          }
          throw new Error(`Failed to fetch referral invites: ${response.status}`);
        }

        const data = await response.json();
        return data;
      } catch (error) {
        debugLogger.error("Error fetching referral invites:", error);
        throw error;
      }
    });

    ipcMain.handle("get-model-cache-root", () => {
      const { getCacheRoot } = require("./modelDirUtils");
      return getCacheRoot();
    });

    ipcMain.handle("open-whisper-models-folder", async () => {
      try {
        const { getCacheRoot } = require("./modelDirUtils");
        const cacheRoot = getCacheRoot();
        await fs.promises.mkdir(cacheRoot, { recursive: true });
        const errMsg = await shell.openPath(cacheRoot);
        if (errMsg) return { success: false, error: errMsg };
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open model cache folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-ydotool-status", () => {
      const { getYdotoolStatus } = require("./ensureYdotool");
      const { getLinuxSessionInfo } = require("./linuxSession");
      const { execFileSync } = require("child_process");
      const status = getYdotoolStatus();
      const { isKde } = getLinuxSessionInfo();
      let hasXclip = false;
      let hasXsel = false;
      if (isKde) {
        try {
          execFileSync("which", ["xclip"], { timeout: 1000 });
          hasXclip = true;
        } catch {}
        try {
          execFileSync("which", ["xsel"], { timeout: 1000 });
          hasXsel = true;
        } catch {}
      }
      return { ...status, hasXclip, hasXsel };
    });

    ipcMain.handle("get-debug-state", async () => {
      try {
        return {
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
          logLevel: debugLogger.getLevel(),
        };
      } catch (error) {
        debugLogger.error("Failed to get debug state:", error);
        return { enabled: false, logPath: null, logLevel: "info" };
      }
    });

    ipcMain.handle("set-debug-logging", async (event, enabled) => {
      try {
        const path = require("path");
        const fs = require("fs");
        const envPath = path.join(app.getPath("userData"), ".env");

        // Read current .env content
        let envContent = "";
        if (fs.existsSync(envPath)) {
          envContent = fs.readFileSync(envPath, "utf8");
        }

        // Parse lines
        const lines = envContent.split("\n");
        const logLevelIndex = lines.findIndex((line) =>
          line.trim().startsWith("OPENWHISPR_LOG_LEVEL=")
        );

        if (enabled) {
          // Set to debug
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "OPENWHISPR_LOG_LEVEL=debug";
          } else {
            // Add new line
            if (lines.length > 0 && lines[lines.length - 1] !== "") {
              lines.push("");
            }
            lines.push("# Debug logging setting");
            lines.push("OPENWHISPR_LOG_LEVEL=debug");
          }
        } else {
          // Remove or set to info
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "OPENWHISPR_LOG_LEVEL=info";
          }
        }

        // Write back
        fs.writeFileSync(envPath, lines.join("\n"), "utf8");

        // Update environment variable
        process.env.OPENWHISPR_LOG_LEVEL = enabled ? "debug" : "info";

        // Refresh logger state
        debugLogger.refreshLogLevel();

        return {
          success: true,
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
        };
      } catch (error) {
        debugLogger.error("Failed to set debug logging:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("open-logs-folder", async () => {
      try {
        const logsDir = path.join(app.getPath("userData"), "logs");
        await shell.openPath(logsDir);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open logs folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("check-for-updates", async () => {
      return this.updateManager.checkForUpdates();
    });

    ipcMain.handle("download-update", async () => {
      return this.updateManager.downloadUpdate();
    });

    ipcMain.handle("install-update", async () => {
      return this.updateManager.installUpdate();
    });

    ipcMain.handle("get-app-version", async () => {
      return this.updateManager.getAppVersion();
    });

    ipcMain.handle("get-post-migration-state", () => ({
      justMigrated: postMigrationDetector.isReturningFromOldBundle(),
    }));

    ipcMain.handle("get-oauth-protocol-registered", () => this.oauthProtocolRegistered);

    ipcMain.handle("get-oauth-protocol", () => this.oauthProtocol);

    ipcMain.handle("mark-bundle-migrated", () => {
      postMigrationDetector.markBundleMigrated();
    });

    ipcMain.handle("mark-bundle-migration-dismissed", () => {
      postMigrationDetector.markBundleMigrationDismissed();
    });

    ipcMain.handle("get-update-status", async () => {
      return this.updateManager.getUpdateStatus();
    });

    ipcMain.handle("get-update-info", async () => {
      return this.updateManager.getUpdateInfo();
    });

    const fetchStreamingToken = async (event) => {
      const apiUrl = getApiUrl();
      if (!apiUrl) {
        throw new Error("OpenWhispr API URL not configured");
      }

      const authHeader = await getAuthHeader(event);
      if (!Object.keys(authHeader).length) {
        throw new Error("Not authenticated");
      }

      const tokenResponse = await proxyFetch(`${apiUrl}/api/streaming-token`, {
        method: "POST",
        headers: withPolicyHeaders({
          ...authHeader,
        }),
      });

      if (!tokenResponse.ok) {
        if (tokenResponse.status === 401) {
          const err = new Error("Session expired");
          err.code = "AUTH_EXPIRED";
          throw err;
        }
        throw await readPolicyResponseError(
          tokenResponse,
          `Failed to get streaming token: ${tokenResponse.status}`
        );
      }

      const { token } = await tokenResponse.json();
      if (!token) {
        throw new Error("No token received from API");
      }

      return token;
    };

    ipcMain.handle("assemblyai-streaming-warmup", async (event, options = {}) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          return { success: false, error: "API not configured", code: "NO_API" };
        }

        if (!this.assemblyAiStreaming) {
          this.assemblyAiStreaming = new AssemblyAiStreaming();
        }

        if (this.assemblyAiStreaming.hasWarmConnection()) {
          debugLogger.debug("AssemblyAI connection already warm", {}, "streaming");
          return { success: true, alreadyWarm: true };
        }

        let token = this.assemblyAiStreaming.getCachedToken();
        if (!token) {
          debugLogger.debug("Fetching new streaming token for warmup", {}, "streaming");
          token = await fetchStreamingToken(event);
        }

        await this.assemblyAiStreaming.warmup({ ...options, token });
        debugLogger.debug("AssemblyAI connection warmed up", {}, "streaming");

        return { success: true };
      } catch (error) {
        debugLogger.error("AssemblyAI warmup error", { error: error.message });
        return toPolicyFailure(error);
      }
    });

    let streamingStartInProgress = false;

    ipcMain.handle("assemblyai-streaming-start", async (event, options = {}) => {
      if (streamingStartInProgress) {
        debugLogger.debug("Streaming start already in progress, ignoring", {}, "streaming");
        return { success: false, error: "Operation in progress" };
      }

      streamingStartInProgress = true;
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          return { success: false, error: "API not configured", code: "NO_API" };
        }

        const win = BrowserWindow.fromWebContents(event.sender);

        if (!this.assemblyAiStreaming) {
          this.assemblyAiStreaming = new AssemblyAiStreaming();
        }

        // Clean up any stale active connection (shouldn't happen normally)
        if (this.assemblyAiStreaming.isConnected) {
          debugLogger.debug(
            "AssemblyAI cleaning up stale connection before start",
            {},
            "streaming"
          );
          await this.assemblyAiStreaming.disconnect(false);
        }

        const hasWarm = this.assemblyAiStreaming.hasWarmConnection();
        debugLogger.debug(
          "AssemblyAI streaming start",
          { hasWarmConnection: hasWarm },
          "streaming"
        );

        let token = this.assemblyAiStreaming.getCachedToken();
        if (!token) {
          debugLogger.debug("Fetching streaming token from API", {}, "streaming");
          token = await fetchStreamingToken(event);
          this.assemblyAiStreaming.cacheToken(token);
        } else {
          debugLogger.debug("Using cached streaming token", {}, "streaming");
        }

        // Set up callbacks to forward events to renderer
        this.assemblyAiStreaming.onPartialTranscript = (text) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("assemblyai-partial-transcript", text);
          }
        };

        this.assemblyAiStreaming.onFinalTranscript = (text) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("assemblyai-final-transcript", text);
          }
        };

        this.assemblyAiStreaming.onError = (error) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("assemblyai-error", error.message);
          }
        };

        this.assemblyAiStreaming.onSessionEnd = (data) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("assemblyai-session-end", data);
          }
        };

        await this.assemblyAiStreaming.connect({ ...options, token });
        debugLogger.debug("AssemblyAI streaming started", {}, "streaming");

        return {
          success: true,
          usedWarmConnection: this.assemblyAiStreaming.hasWarmConnection() === false,
        };
      } catch (error) {
        debugLogger.error("AssemblyAI streaming start error", { error: error.message });
        if (error.code === "AUTH_EXPIRED") {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        return streamingStartFailure(error);
      } finally {
        streamingStartInProgress = false;
      }
    });

    ipcMain.on("assemblyai-streaming-send", (event, audioBuffer) => {
      try {
        if (!this.assemblyAiStreaming) return;
        const buffer = Buffer.from(audioBuffer);
        this.assemblyAiStreaming.sendAudio(buffer);
      } catch (error) {
        debugLogger.error("AssemblyAI streaming send error", { error: error.message });
      }
    });

    ipcMain.on("assemblyai-streaming-force-endpoint", () => {
      this.assemblyAiStreaming?.forceEndpoint();
    });

    ipcMain.handle("assemblyai-streaming-stop", async () => {
      try {
        let result = { text: "" };
        if (this.assemblyAiStreaming) {
          result = await this.assemblyAiStreaming.disconnect(true);
          this.assemblyAiStreaming.cleanupAll();
          this.assemblyAiStreaming = null;
        }

        return { success: true, text: result?.text || "" };
      } catch (error) {
        debugLogger.error("AssemblyAI streaming stop error", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("assemblyai-streaming-status", async () => {
      if (!this.assemblyAiStreaming) {
        return { isConnected: false, sessionId: null };
      }
      return this.assemblyAiStreaming.getStatus();
    });

    let deepgramTokenWindowId = null;

    const fetchDeepgramStreamingTokenFromWindow = async (windowId) => {
      const apiUrl = getApiUrl();
      if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

      const win = BrowserWindow.fromId(windowId);
      if (!win || win.isDestroyed()) throw new Error("Window not available for token refresh");

      const authHeader = await getAuthHeaderFromWindow(win);
      if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

      const tokenResponse = await proxyFetch(`${apiUrl}/api/deepgram-streaming-token`, {
        method: "POST",
        headers: withPolicyHeaders(authHeader),
      });

      if (!tokenResponse.ok) {
        if (tokenResponse.status === 401) {
          const err = new Error("Session expired");
          err.code = "AUTH_EXPIRED";
          throw err;
        }
        throw await readPolicyResponseError(
          tokenResponse,
          `Failed to get Deepgram streaming token: ${tokenResponse.status}`
        );
      }

      const { token } = await tokenResponse.json();
      if (!token) throw new Error("No token received from API");
      return token;
    };

    const fetchDeepgramStreamingToken = async (event) => {
      const apiUrl = getApiUrl();
      if (!apiUrl) {
        throw new Error("OpenWhispr API URL not configured");
      }

      const authHeader = await getAuthHeader(event);
      if (!Object.keys(authHeader).length) {
        throw new Error("Not authenticated");
      }

      const tokenResponse = await proxyFetch(`${apiUrl}/api/deepgram-streaming-token`, {
        method: "POST",
        headers: withPolicyHeaders({
          ...authHeader,
        }),
      });

      if (!tokenResponse.ok) {
        if (tokenResponse.status === 401) {
          const err = new Error("Session expired");
          err.code = "AUTH_EXPIRED";
          throw err;
        }
        throw await readPolicyResponseError(
          tokenResponse,
          `Failed to get Deepgram streaming token: ${tokenResponse.status}`
        );
      }

      const { token } = await tokenResponse.json();
      if (!token) {
        throw new Error("No token received from API");
      }

      return token;
    };

    ipcMain.handle("deepgram-streaming-warmup", async (event, options = {}) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          return { success: false, error: "API not configured", code: "NO_API" };
        }

        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
          deepgramTokenWindowId = win.id;
        }

        if (!this.deepgramStreaming) {
          this.deepgramStreaming = new DeepgramStreaming();
        }

        this.deepgramStreaming.setTokenRefreshFn(async () => {
          if (!deepgramTokenWindowId) throw new Error("No window reference");
          return fetchDeepgramStreamingTokenFromWindow(deepgramTokenWindowId);
        });

        if (this.deepgramStreaming.hasWarmConnection()) {
          debugLogger.debug("Deepgram connection already warm", {}, "streaming");
          return { success: true, alreadyWarm: true };
        }

        let token = this.deepgramStreaming.getCachedToken();
        if (!token) {
          debugLogger.debug("Fetching new Deepgram streaming token for warmup", {}, "streaming");
          token = await fetchDeepgramStreamingToken(event);
        }

        await this.deepgramStreaming.warmup({ ...options, token });
        debugLogger.debug("Deepgram connection warmed up", {}, "streaming");

        return { success: true };
      } catch (error) {
        debugLogger.error("Deepgram warmup error", { error: error.message });
        return toPolicyFailure(error);
      }
    });

    let deepgramStreamingStartInProgress = false;
    let sendDropCount = 0;

    ipcMain.handle("deepgram-streaming-start", async (event, options = {}) => {
      if (deepgramStreamingStartInProgress) {
        debugLogger.debug(
          "Deepgram streaming start already in progress, ignoring",
          {},
          "streaming"
        );
        return { success: false, error: "Operation in progress" };
      }

      deepgramStreamingStartInProgress = true;
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          return { success: false, error: "API not configured", code: "NO_API" };
        }

        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
          deepgramTokenWindowId = win.id;
        }

        if (!this.deepgramStreaming) {
          this.deepgramStreaming = new DeepgramStreaming();
        }

        this.deepgramStreaming.setTokenRefreshFn(async () => {
          if (!deepgramTokenWindowId) throw new Error("No window reference");
          return fetchDeepgramStreamingTokenFromWindow(deepgramTokenWindowId);
        });

        if (this.deepgramStreaming.isConnected) {
          debugLogger.debug("Deepgram cleaning up stale connection before start", {}, "streaming");
          await this.deepgramStreaming.disconnect(false);
        }

        const hasWarm = this.deepgramStreaming.hasWarmConnection();
        debugLogger.debug("Deepgram streaming start", { hasWarmConnection: hasWarm }, "streaming");

        let token = this.deepgramStreaming.getCachedToken();
        if (!token) {
          debugLogger.debug("Fetching Deepgram streaming token from API", {}, "streaming");
          token = await fetchDeepgramStreamingToken(event);
          this.deepgramStreaming.cacheToken(token);
        } else {
          debugLogger.debug("Using cached Deepgram streaming token", {}, "streaming");
        }

        this.deepgramStreaming.onPartialTranscript = (text) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("deepgram-partial-transcript", text);
          }
        };

        this.deepgramStreaming.onFinalTranscript = (text) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("deepgram-final-transcript", text);
          }
        };

        this.deepgramStreaming.onError = (error) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("deepgram-error", error.message);
          }
        };

        this.deepgramStreaming.onSessionEnd = (data) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("deepgram-session-end", data);
          }
        };

        sendDropCount = 0;
        await this.deepgramStreaming.connect({ ...options, token });
        debugLogger.debug(
          "Deepgram streaming started",
          {
            isConnected: this.deepgramStreaming.isConnected,
            hasWs: !!this.deepgramStreaming.ws,
            wsReadyState: this.deepgramStreaming.ws?.readyState,
            forceNew: !!options.forceNew,
          },
          "streaming"
        );

        return {
          success: true,
          usedWarmConnection: hasWarm && !options.forceNew,
        };
      } catch (error) {
        debugLogger.error("Deepgram streaming start error", { error: error.message });
        if (error.code === "AUTH_EXPIRED") {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        return streamingStartFailure(error);
      } finally {
        deepgramStreamingStartInProgress = false;
      }
    });

    ipcMain.on("deepgram-streaming-send", (event, audioBuffer) => {
      try {
        if (!this.deepgramStreaming) return;
        const buffer = Buffer.from(audioBuffer);
        const sent = this.deepgramStreaming.sendAudio(buffer);
        if (!sent) {
          sendDropCount++;
          if (sendDropCount <= 3 || sendDropCount % 50 === 0) {
            debugLogger.warn(
              "Deepgram audio send dropped",
              {
                dropCount: sendDropCount,
                hasWs: !!this.deepgramStreaming.ws,
                isConnected: this.deepgramStreaming.isConnected,
                wsReadyState: this.deepgramStreaming.ws?.readyState,
              },
              "streaming"
            );
          }
        } else {
          if (sendDropCount > 0) {
            debugLogger.debug(
              "Deepgram audio send resumed after drops",
              {
                previousDrops: sendDropCount,
              },
              "streaming"
            );
            sendDropCount = 0;
          }
        }
      } catch (error) {
        debugLogger.error("Deepgram streaming send error", { error: error.message });
      }
    });

    ipcMain.on("deepgram-streaming-finalize", () => {
      this.deepgramStreaming?.finalize();
    });

    ipcMain.handle("deepgram-streaming-stop", async () => {
      try {
        const model = this.deepgramStreaming?.currentModel || "nova-3";
        const audioBytesSent = this.deepgramStreaming?.audioBytesSent || 0;
        let result = { text: "" };
        if (this.deepgramStreaming) {
          result = await this.deepgramStreaming.disconnect(true);
        }

        return { success: true, text: result?.text || "", model, audioBytesSent };
      } catch (error) {
        debugLogger.error("Deepgram streaming stop error", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("deepgram-streaming-status", async () => {
      if (!this.deepgramStreaming) {
        return { isConnected: false, sessionId: null };
      }
      return this.deepgramStreaming.getStatus();
    });

    ipcMain.handle("corti-streaming-warmup", async (_event, options = {}) => {
      try {
        if (!this.cortiStreaming) {
          this.cortiStreaming = new CortiStreaming();
        }
        if (this.cortiStreaming.hasWarmConnection() || this.cortiStreaming.isConnected) {
          return { success: true, alreadyWarm: true };
        }
        const { token, environment, tenant } = await this._mintStoredCortiToken(options);
        await this.cortiStreaming.warmup({
          token,
          environment,
          tenant,
          language: options.language,
          keyterms: options.keyterms,
        });
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message, code: error.code };
      }
    });

    ipcMain.handle("corti-streaming-start", async (event, options = {}) => {
      try {
        if (!this.cortiStreaming) {
          this.cortiStreaming = new CortiStreaming();
        }
        if (this.cortiStreaming.isConnected) {
          await this.cortiStreaming.disconnect(false);
        }

        const { token, environment, tenant } = await this._mintStoredCortiToken(options);
        const win = BrowserWindow.fromWebContents(event.sender);

        this.cortiStreaming.onPartialTranscript = (text) => {
          if (win && !win.isDestroyed()) win.webContents.send("corti-partial-transcript", text);
        };
        this.cortiStreaming.onFinalTranscript = (text) => {
          if (win && !win.isDestroyed()) win.webContents.send("corti-final-transcript", text);
        };
        this.cortiStreaming.onError = (error) => {
          if (win && !win.isDestroyed()) win.webContents.send("corti-error", error.message);
        };
        this.cortiStreaming.onSessionEnd = (data) => {
          if (win && !win.isDestroyed()) win.webContents.send("corti-session-end", data);
        };

        await this.cortiStreaming.connect({
          token,
          environment,
          tenant,
          language: options.language,
          keyterms: options.keyterms,
        });
        return { success: true };
      } catch (error) {
        debugLogger.error("Corti streaming start error", { error: error.message }, "streaming");
        return { success: false, error: error.message, code: error.code };
      }
    });

    ipcMain.on("corti-streaming-send", (_event, audioBuffer) => {
      this.cortiStreaming?.sendAudio(Buffer.from(audioBuffer));
    });

    ipcMain.on("corti-streaming-finalize", () => {
      this.cortiStreaming?.finalize();
    });

    ipcMain.handle("corti-streaming-stop", async () => {
      try {
        const model = this.cortiStreaming?.currentModel || "corti-transcribe";
        const audioBytesSent = this.cortiStreaming?.audioBytesSent || 0;
        let result = { text: "" };
        if (this.cortiStreaming) {
          result = await this.cortiStreaming.disconnect(true);
        }
        return { success: true, text: result?.text || "", model, audioBytesSent };
      } catch (error) {
        debugLogger.error("Corti streaming stop error", { error: error.message }, "streaming");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("corti-streaming-status", async () => {
      if (!this.cortiStreaming) {
        return { isConnected: false, sessionId: null };
      }
      return this.cortiStreaming.getStatus();
    });

    // Agent mode handlers
    ipcMain.handle("update-voice-agent-hotkey", async (_event, hotkey) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const voiceAgentCallback = this.windowManager._voiceAgentHotkeyCallback;
      if (!voiceAgentCallback) {
        return { success: false, message: "Voice agent hotkey callback not initialized" };
      }

      if (!hotkey) {
        hotkeyManager.unregisterSlot("voiceAgent");
        this.environmentManager.saveVoiceAgentKey?.("");
        this.windowManager.reconcileNativeKeyListeners();
        this._notifyHotkeyChanged("");
        return { success: true, message: "Voice agent hotkey cleared" };
      }

      const result = await hotkeyManager.registerSlot("voiceAgent", hotkey, voiceAgentCallback, {
        atomic: true,
      });
      this.windowManager.reconcileNativeKeyListeners();
      if (result.success) {
        this.environmentManager.saveVoiceAgentKey?.(hotkey);
        this._notifyHotkeyChanged(hotkey);
        return { success: true, message: `Voice agent hotkey updated to: ${hotkey}` };
      }

      return {
        success: false,
        message: result.error || `Failed to update voice agent hotkey to: ${hotkey}`,
      };
    });

    ipcMain.handle("get-voice-agent-key", async () => {
      return this.environmentManager.getVoiceAgentKey?.() || "";
    });

    ipcMain.handle("update-translation-hotkey", async (_event, hotkey) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const translationCallback = this.windowManager._translationHotkeyCallback;
      if (!translationCallback) {
        return { success: false, message: "Translation hotkey callback not initialized" };
      }

      if (!hotkey) {
        hotkeyManager.unregisterSlot("translation");
        this.environmentManager.saveTranslationKey?.("");
        this.windowManager.reconcileNativeKeyListeners();
        this._notifyHotkeyChanged("");
        return { success: true, message: "Translation hotkey cleared" };
      }

      const result = await hotkeyManager.registerSlot("translation", hotkey, translationCallback, {
        atomic: true,
      });
      this.windowManager.reconcileNativeKeyListeners();
      if (result.success) {
        this.environmentManager.saveTranslationKey?.(hotkey);
        this._notifyHotkeyChanged(hotkey);
        return { success: true, message: `Translation hotkey updated to: ${hotkey}` };
      }

      return {
        success: false,
        message: result.error || `Failed to update translation hotkey to: ${hotkey}`,
      };
    });

    ipcMain.handle("get-translation-key", async () => {
      return this.environmentManager.getTranslationKey?.() || "";
    });

    ipcMain.handle("acquire-recording-lock", async (_event, pipeline) => {
      if (this._activeRecordingPipeline && this._activeRecordingPipeline !== pipeline) {
        return { success: false, holder: this._activeRecordingPipeline };
      }
      this._activeRecordingPipeline = pipeline;
      return { success: true };
    });

    ipcMain.handle("release-recording-lock", async (_event, pipeline) => {
      if (this._activeRecordingPipeline === pipeline) {
        this._activeRecordingPipeline = null;
      }
      return { success: true };
    });

    // Provider-neutral availability over the shared calendar cache.
    ipcMain.handle("calendar-get-availability", async (_event, request) => {
      try {
        return {
          success: true,
          availability: getCalendarAvailability({
            request,
            databaseManager: this.databaseManager,
            calendarProviders: [
              { provider: "google", manager: this.googleCalendarManager },
              { provider: "microsoft", manager: this.microsoftCalendarManager },
              { provider: "apple", manager: this.appleCalendarManager },
            ],
          }),
        };
      } catch (error) {
        debugLogger.warn(
          "Calendar availability request failed",
          { error: error instanceof Error ? error.message : String(error) },
          "calendar"
        );
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to check calendar availability",
        };
      }
    });

    // Google Calendar
    ipcMain.handle("gcal-start-oauth", async () => {
      try {
        return await this.googleCalendarManager.startOAuth();
      } catch (error) {
        debugLogger.error("Google Calendar OAuth failed", { error: error.message }, "calendar");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-disconnect", async (_event, email) => {
      try {
        this.googleCalendarManager.disconnect(email);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Google Calendar disconnect failed",
          { error: error.message },
          "calendar"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-get-connection-status", async () => {
      try {
        return this.googleCalendarManager.getConnectionStatus();
      } catch (error) {
        return { connected: false, email: null };
      }
    });

    ipcMain.handle("gcal-get-calendars", async () => {
      try {
        return { success: true, calendars: this.googleCalendarManager.getCalendars() };
      } catch (error) {
        return { success: false, calendars: [] };
      }
    });

    ipcMain.handle("gcal-set-calendar-selection", async (_event, calendarId, isSelected) => {
      try {
        await this.googleCalendarManager.setCalendarSelection(calendarId, isSelected);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-set-primary-only", async (_event, value) => {
      try {
        await this.googleCalendarManager.setPrimaryOnly(value);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-sync-events", async () => {
      try {
        await this.googleCalendarManager.syncEvents();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-get-upcoming-events", async (_event, windowMinutes) => {
      try {
        return {
          success: true,
          events: await this.googleCalendarManager.getUpcomingEvents(windowMinutes),
        };
      } catch (error) {
        return { success: false, events: [] };
      }
    });

    ipcMain.handle("gcal-get-event", async (_event, eventId) => {
      try {
        const event = this.databaseManager.getCalendarEventById(eventId);
        return { success: true, event };
      } catch (error) {
        return { success: false, event: null };
      }
    });

    // Microsoft Calendar
    ipcMain.handle("mcal-start-oauth", async () => {
      try {
        return await this.microsoftCalendarManager.startOAuth();
      } catch (error) {
        debugLogger.error("Microsoft Calendar OAuth failed", { error: error.message }, "calendar");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("mcal-disconnect", async (_event, email) => {
      try {
        this.microsoftCalendarManager.disconnect(email);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Microsoft Calendar disconnect failed",
          { error: error.message },
          "calendar"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("mcal-get-connection-status", async () => {
      try {
        return this.microsoftCalendarManager.getConnectionStatus();
      } catch (error) {
        debugLogger.error(
          "Microsoft Calendar connection status failed",
          { error: error.message },
          "calendar"
        );
        return { connected: false, accounts: [] };
      }
    });

    ipcMain.handle("mcal-set-primary-only", async (_event, value) => {
      try {
        await this.microsoftCalendarManager.setPrimaryOnly(value);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Apple Calendar (macOS EventKit)
    ipcMain.handle("acal-connect", async () => {
      try {
        return await this.appleCalendarManager.connect();
      } catch (error) {
        debugLogger.error("Apple Calendar connect failed", { error: error.message }, "acal");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("acal-disconnect", async () => {
      try {
        return this.appleCalendarManager.disconnect();
      } catch (error) {
        debugLogger.error("Apple Calendar disconnect failed", { error: error.message }, "acal");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("acal-get-connection-status", async () => {
      try {
        return this.appleCalendarManager.getConnectionStatus();
      } catch (error) {
        debugLogger.error(
          "Apple Calendar connection status failed",
          { error: error.message },
          "acal"
        );
        return { connected: false, sourceNames: [] };
      }
    });

    ipcMain.handle("search-contacts", async (_event, query) => {
      try {
        const contacts = this.databaseManager.searchContacts(query);
        return { success: true, contacts };
      } catch (error) {
        return { success: false, contacts: [] };
      }
    });

    ipcMain.handle("upsert-contact", async (_event, contact) => {
      try {
        this.databaseManager.upsertContacts([contact]);
        return { success: true };
      } catch (error) {
        return { success: false };
      }
    });

    ipcMain.handle("get-md5-hash", (_event, text) => {
      return crypto.createHash("md5").update(text.toLowerCase().trim()).digest("hex");
    });

    ipcMain.handle("meeting-detection-get-preferences", async () => {
      try {
        return { success: true, preferences: this.meetingDetectionEngine.getPreferences() };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-detection-set-preferences", async (_event, prefs) => {
      try {
        this.meetingDetectionEngine.setPreferences(prefs);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    const NOTIFICATION_PREF_KEYS = new Set([
      "notificationsEnabled",
      "notifyMeetingDetection",
      "notifyCalendarReminders",
      "notifyUpdates",
    ]);

    ipcMain.handle("sync-notification-preferences", async (_event, prefs) => {
      try {
        if (!prefs || typeof prefs !== "object") {
          return { success: false, error: "Invalid preferences" };
        }
        for (const [k, v] of Object.entries(prefs)) {
          if (NOTIFICATION_PREF_KEYS.has(k)) {
            this.windowManager.notificationPrefs[k] = !!v;
          }
        }
        // Detection only serves the notification, so the toggle also gates the detector.
        const { notificationsEnabled, notifyMeetingDetection } =
          this.windowManager.notificationPrefs;
        this.meetingDetectionEngine?.setPreferences({
          audioDetection: notificationsEnabled && notifyMeetingDetection,
        });
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-set-speaker-diarization-enabled", async (_event, payload) => {
      try {
        this.speakerDiarizationEnabled = payload?.enabled !== false;
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("whisper-vad-get-config", async () => {
      try {
        return { success: true, config: this._getWhisperVadSettings() };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("whisper-vad-set-config", async (_event, payload) => {
      try {
        const config = this._setWhisperVadSettings(payload || {});
        return { success: true, config };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-set-session-speaker-config", async (_event, payload) => {
      try {
        const enabled = payload?.enabled !== false;
        const expectedCount = Math.max(
          1,
          Math.min(
            MAX_SPEAKER_COUNT,
            Number(payload?.expectedCount) || DEFAULT_EXPECTED_SPEAKER_COUNT
          )
        );
        // Only a stepper-set count is explicit; the diarization toggle reuses this
        // channel and must not freeze the count against roster-driven refreshes.
        this.activeMeetingSpeakerConfig = {
          enabled,
          expectedCount,
          explicit: payload?.countIsExplicit === true,
        };
        liveSpeakerIdentifier.setEnabled(enabled);
        // Live identification only labels other speakers (the mic track is "you"),
        // so cap at expectedCount - 1 to match resolveSessionMaxSpeakers().
        liveSpeakerIdentifier.setMaxSpeakers(Math.max(1, expectedCount - 1));
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-notification-respond", async (_event, detectionId, action) => {
      try {
        await this.meetingDetectionEngine.handleNotificationResponse(detectionId, action);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    registerMeetingAutoEndLifecycleHandlers(ipcMain, () => this.meetingDetectionEngine);

    ipcMain.handle("join-calendar-meeting", async (_event, eventId) => {
      try {
        await this.meetingDetectionEngine.joinCalendarMeeting(eventId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-meeting-notification-data", async () => {
      return this.windowManager?._pendingNotificationData ?? null;
    });

    ipcMain.handle("get-pending-meeting-note-navigation", async () => {
      return this.windowManager?.consumePendingMeetingNoteNavigation() ?? null;
    });

    ipcMain.handle("get-pending-note-navigation", async () => {
      return this.windowManager?.consumePendingNoteNavigation() ?? null;
    });

    ipcMain.handle("meeting-notification-ready", async (event) => {
      this.windowManager?.showNotificationWindow(event.sender);
    });

    ipcMain.handle("get-update-notification-data", async () => {
      return this.windowManager?._pendingUpdateNotificationData ?? null;
    });

    ipcMain.handle("update-notification-ready", async () => {
      this.windowManager?.showUpdateNotificationWindow();
    });

    ipcMain.handle("update-notification-respond", async (_event, action) => {
      this.windowManager?.dismissUpdateNotification();
      if (action === "update") {
        try {
          await this.updateManager?.downloadUpdate();
        } catch (error) {
          console.error("Failed to start update download from notification:", error);
        }
      }
      return { success: true };
    });

    // Note files (markdown mirror) handlers
    ipcMain.handle("note-files-set-enabled", async (_event, enabled, customPath, options) => {
      try {
        this._noteFilesEnabled = !!enabled;
        if (!enabled) return { success: true };
        const basePath = customPath || path.join(app.getPath("userData"), "notes");
        if (options?.skipRebuild) {
          require("./markdownMirror").init(basePath);
        } else {
          this._rebuildMirror(basePath);
        }
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to set note-files enabled",
          { error: error.message },
          "note-files"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-set-path", async (_event, newPath) => {
      try {
        if (!this._noteFilesEnabled) return { success: false, error: "Note files not enabled" };
        this._rebuildMirror(newPath);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to set note-files path", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-rebuild", async () => {
      try {
        if (!this._noteFilesEnabled) return { success: false, error: "Note files not enabled" };
        this._rebuildMirror();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to rebuild note files", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-get-default-path", async () => {
      return path.join(app.getPath("userData"), "notes");
    });

    ipcMain.handle("show-note-file", async (_event, noteId) => {
      try {
        const markdownMirror = require("./markdownMirror");
        const filePath = markdownMirror.getNotePath(noteId);
        if (!filePath) return { success: false };
        shell.showItemInFolder(filePath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show note file",
          { noteId, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    ipcMain.handle("show-folder-in-explorer", async (_event, folderName) => {
      try {
        const markdownMirror = require("./markdownMirror");
        const dirPath = markdownMirror.getFolderPath(folderName);
        if (!dirPath) return { success: false };
        await shell.openPath(dirPath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show folder",
          { folderName, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    ipcMain.handle("note-files-pick-folder", async () => {
      try {
        const { dialog } = require("electron");
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (result.canceled || !result.filePaths.length) {
          return { canceled: true };
        }
        return { canceled: false, path: result.filePaths[0] };
      } catch (error) {
        debugLogger.error("Failed to pick folder", { error: error.message }, "note-files");
        return { canceled: true };
      }
    });

    ipcMain.handle("granola-import-pick-and-preview", async (event) => {
      try {
        const { dialog } = require("electron");
        // Parent the dialog so it opens as a sheet on the settings window —
        // a parentless panel can land invisible on another display/Space.
        const parentWindow = BrowserWindow.fromWebContents(event.sender);
        // Granola chunks large exports into numbered files (…-000.csv, -001, …),
        // so let the user grab the whole set in one pick.
        const dialogOptions = {
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "CSV", extensions: ["csv"] }],
        };
        const result = parentWindow
          ? await dialog.showOpenDialog(parentWindow, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
        if (result.canceled || !result.filePaths.length) {
          return { canceled: true };
        }
        const filePaths = [...result.filePaths].sort();
        const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
        const { createGranolaNoteKeyAllocator, parseGranolaCsv } =
          await import("./granolaImport.js");
        const allocateNoteKey = createGranolaNoteKeyAllocator();
        const notes = [];
        const seenIds = new Set();
        let rowIssueCount = 0;
        for (const filePath of filePaths) {
          if (fs.statSync(filePath).size > MAX_IMPORT_BYTES) {
            return { canceled: false, success: false, error: "FILE_TOO_LARGE" };
          }
          const parsed = parseGranolaCsv(fs.readFileSync(filePath, "utf8"), {
            allocateNoteKey,
          });
          if (!parsed.ok) {
            return { canceled: false, success: false, error: parsed.error.code };
          }
          // File-level warnings (e.g. ignored columns) are expected on every
          // real export; only row-scoped problems belong in the issue count.
          rowIssueCount += parsed.warnings.filter((warning) => warning.row != null).length;
          for (const note of parsed.notes) {
            if (!seenIds.has(note.clientNoteId)) {
              seenIds.add(note.clientNoteId);
              notes.push(note);
            }
          }
        }
        const existing = new Set(
          this.databaseManager.getExistingClientNoteIds(notes.map((n) => n.clientNoteId))
        );
        const freshNotes = notes.filter((n) => !existing.has(n.clientNoteId));
        // The run handler only ever imports what this preview parsed — the
        // renderer never sends a file path across the bridge.
        this._granolaImportPending = { notes };
        return {
          canceled: false,
          success: true,
          fileName: filePaths.map((p) => path.basename(p)).join(", "),
          total: notes.length,
          newCount: freshNotes.length,
          duplicateCount: notes.length - freshNotes.length,
          sampleTitles: freshNotes.slice(0, 5).map((n) => n.title),
          rowIssueCount,
        };
      } catch (error) {
        debugLogger.error(
          "Granola import preview failed",
          { error: error.message },
          "granola-import"
        );
        return { canceled: false, success: false, error: "READ_FAILED" };
      }
    });

    ipcMain.handle("granola-import-run", async () => {
      const pending = this._granolaImportPending;
      this._granolaImportPending = null;
      if (!pending) return { success: false, error: "NO_PENDING_IMPORT" };
      try {
        const result = this.databaseManager.importNotes(pending.notes);
        if (result.imported > 0) {
          const importedIds = result.noteIds;
          // One-shot side effects: batched vector upsert of just the new notes
          // and a single mirror rebuild — never per-note work (sync storm /
          // O(notes × files) mirror scans).
          setImmediate(() => {
            try {
              const vectorIndex = require("./vectorIndex");
              if (vectorIndex.isReady()) {
                const importedNotes = importedIds
                  .map((id) => this.databaseManager.getNote(id))
                  .filter(Boolean);
                vectorIndex
                  .reindexAll(importedNotes, (done, total) => {
                    broadcastToWindows("semantic-reindex-progress", { done, total });
                  })
                  .catch(() => {});
              }
              if (this._noteFilesEnabled) this._rebuildMirror();
            } catch (sideEffectError) {
              debugLogger.error(
                "Granola import side effects failed",
                { error: sideEffectError.message },
                "granola-import"
              );
            }
          });
        }
        return {
          success: true,
          imported: result.imported,
          skipped: result.skipped,
          errors: result.errors,
        };
      } catch (error) {
        debugLogger.error("Granola import failed", { error: error.message }, "granola-import");
        return { success: false, error: "IMPORT_FAILED" };
      }
    });

    ipcMain.handle("get-speaker-mappings", async (_event, noteId) => {
      return this.databaseManager.getSpeakerMappings(noteId);
    });

    ipcMain.handle(
      "set-speaker-mapping",
      async (_event, noteId, speakerId, displayName, email, profileId) => {
        const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
        const noteSpeakerEmbedding = embeddings.find((e) => e.speaker_id === speakerId);
        const liveSpeakerEmbedding = liveSpeakerIdentifier.getSpeakerEmbedding(speakerId);
        const speakerEmbeddingBuffer =
          noteSpeakerEmbedding?.embedding ||
          (liveSpeakerEmbedding ? Buffer.from(liveSpeakerEmbedding.buffer) : null);

        let resolvedProfileId = profileId ?? null;
        if (speakerEmbeddingBuffer) {
          const profile = this.databaseManager.upsertSpeakerProfile(
            displayName,
            email || null,
            speakerEmbeddingBuffer,
            resolvedProfileId
          );
          resolvedProfileId = profile.id;
          this._retroactiveMapping(profile);
        }

        this.databaseManager.setSpeakerMapping(noteId, speakerId, resolvedProfileId, displayName);
        liveSpeakerIdentifier.mapSpeaker(speakerId, resolvedProfileId, displayName, noteId);
        return { success: true, profileId: resolvedProfileId };
      }
    );

    ipcMain.handle("remove-speaker-mapping", async (_event, noteId, speakerId) => {
      this.databaseManager.removeSpeakerMapping(noteId, speakerId);
      return { success: true };
    });

    ipcMain.handle("get-speaker-profiles", async () => {
      return this.databaseManager.getSpeakerProfiles();
    });

    ipcMain.handle("attach-speaker-email", async (_event, profileId, email) => {
      try {
        const profile = this.databaseManager.attachEmailToProfile(profileId, email);
        this._retroactiveMapping(profile);
        return {
          success: true,
          profile: {
            id: profile.id,
            display_name: profile.display_name,
            email: profile.email,
            sample_count: profile.sample_count,
          },
        };
      } catch (error) {
        debugLogger.error(
          "Failed to attach email to speaker profile",
          { error: error.message },
          "speaker"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("save-note-speaker-embeddings", async (_event, noteId, embeddingsObj) => {
      const buffers = {};
      for (const [speakerId, arr] of Object.entries(embeddingsObj)) {
        buffers[speakerId] = Buffer.from(new Float32Array(arr).buffer);
      }
      this.databaseManager.saveNoteSpeakerEmbeddings(noteId, buffers);
      this._tryAutoLabelOneOnOne(noteId);
      return { success: true };
    });
  }

  _retroactiveMapping(profile) {
    setImmediate(async () => {
      try {
        const speakerEmbeddings = require("./speakerEmbeddings");
        const noteIds = this.databaseManager.getNotesWithUnmappedSpeakers();

        const profileEmb = new Float32Array(
          profile.embedding.buffer,
          profile.embedding.byteOffset,
          profile.embedding.byteLength / 4
        );

        for (const noteId of noteIds) {
          const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
          const existing = this.databaseManager.getSpeakerMappings(noteId);
          const mappedSpeakers = new Set(existing.map((m) => m.speaker_id));
          for (const emb of embeddings) {
            if (mappedSpeakers.has(emb.speaker_id)) continue;

            const speakerEmb = new Float32Array(
              emb.embedding.buffer,
              emb.embedding.byteOffset,
              emb.embedding.byteLength / 4
            );
            const similarity = speakerEmbeddings.cosineSimilarity(profileEmb, speakerEmb);

            if (similarity > 0.6) {
              this.databaseManager.setSpeakerMapping(
                noteId,
                emb.speaker_id,
                profile.id,
                profile.display_name
              );

              const note = this.databaseManager.getNote(noteId);
              if (note?.transcript) {
                try {
                  const segments = JSON.parse(note.transcript);
                  let changed = false;
                  for (const seg of segments) {
                    if (seg.speaker === emb.speaker_id && !seg.speakerName) {
                      if (canAutoRelabelSpeaker(seg)) {
                        applyConfirmedSpeaker(seg, {
                          speakerName: profile.display_name,
                          speakerIsPlaceholder: false,
                        });
                      } else {
                        seg.speakerName = profile.display_name;
                        seg.speakerIsPlaceholder = false;
                      }
                      changed = true;
                    }
                  }
                  if (changed) {
                    this.databaseManager.updateNote(noteId, {
                      transcript: JSON.stringify(segments),
                    });
                  }
                } catch (_) {}
              }
            }
          }
        }
      } catch (err) {
        debugLogger.warn("Retroactive speaker mapping failed", { error: err.message });
      }
    });
  }

  _tryAutoLabelOneOnOne(noteId) {
    setImmediate(async () => {
      try {
        const note = this.databaseManager.getNote(noteId);
        const other = this._resolveOneOnOneOtherParticipant(note?.participants);
        if (!other) return;
        const { displayName, email } = other;

        const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
        if (!embeddings.length) return;

        const existingMappings = this.databaseManager.getSpeakerMappings(noteId);
        const mappedSpeakers = new Set(existingMappings.map((m) => m.speaker_id));

        const transcript = note.transcript ? JSON.parse(note.transcript) : [];
        const systemSpeakers = new Set(
          transcript.filter((s) => s.source !== "mic" && s.speaker).map((s) => s.speaker)
        );

        const unmapped = embeddings.filter(
          (e) => !mappedSpeakers.has(e.speaker_id) && systemSpeakers.has(e.speaker_id)
        );
        if (!unmapped.length) return;

        let profile = null;
        for (const emb of unmapped) {
          profile = this.databaseManager.upsertSpeakerProfile(
            displayName,
            email,
            emb.embedding,
            profile?.id ?? null
          );
          this.databaseManager.setSpeakerMapping(noteId, emb.speaker_id, profile.id, displayName);
          liveSpeakerIdentifier.mapSpeaker(emb.speaker_id, profile.id, displayName, noteId);
        }

        const unmappedSystemSpeakers = new Set(unmapped.map((e) => e.speaker_id));
        let changed = false;
        for (const seg of transcript) {
          if (!unmappedSystemSpeakers.has(seg.speaker)) continue;
          if (seg.speakerName && !seg.speakerIsPlaceholder) continue;
          if (canAutoRelabelSpeaker(seg)) {
            applyConfirmedSpeaker(seg, { speakerName: displayName, speakerIsPlaceholder: false });
          } else {
            seg.speakerName = displayName;
            seg.speakerIsPlaceholder = false;
          }
          changed = true;
        }

        if (changed) {
          this.databaseManager.updateNote(noteId, { transcript: JSON.stringify(transcript) });
          const updated = this.databaseManager.getNote(noteId);
          if (updated) broadcastToWindows("note-updated", updated);
        }

        if (profile) this._retroactiveMapping(profile);

        debugLogger.info(
          "Auto-labeled 1-on-1 meeting speakers",
          { noteId, displayName, speakerCount: unmapped.length },
          "speaker"
        );
      } catch (err) {
        debugLogger.warn("Auto-label 1-on-1 failed", { noteId, error: err.message }, "speaker");
      }
    });
  }

  _applySpeakerName(segments, speakerId, displayName) {
    if (!displayName) {
      return;
    }

    for (const segment of segments) {
      if (segment.speaker !== speakerId) {
        continue;
      }

      applyConfirmedSpeaker(segment, {
        speakerName: displayName,
        speakerIsPlaceholder: false,
        suggestedName: undefined,
        suggestedProfileId: undefined,
      });
    }
  }

  _reconcileLiveSpeakerState(liveSpeakerState, speakerEmbeddingsMap, enrichedSegments) {
    if (!liveSpeakerState || !speakerEmbeddingsMap) {
      return new Set();
    }

    const speakerEmbeddings = require("./speakerEmbeddings");
    const reconciledSpeakers = new Set();
    const usedLiveSpeakers = new Set();
    const noteMappings = new Map();

    const liveEntries = Object.entries(liveSpeakerState)
      .map(([speakerId, data]) => ({
        speakerId,
        displayName: data?.displayName || null,
        profileId: data?.profileId ?? null,
        noteId: data?.noteId ?? null,
        embedding: Array.isArray(data?.embedding) ? new Float32Array(data.embedding) : null,
      }))
      .filter((entry) => entry.embedding);

    const getMappingsForNote = (noteId) => {
      if (!noteMappings.has(noteId)) {
        noteMappings.set(noteId, this.databaseManager.getSpeakerMappings(noteId));
      }
      return noteMappings.get(noteId);
    };

    for (const [mappedId, embeddingArray] of Object.entries(speakerEmbeddingsMap)) {
      let bestEntry = null;
      let bestSimilarity = 0;

      for (const entry of liveEntries) {
        if (usedLiveSpeakers.has(entry.speakerId)) {
          continue;
        }

        const similarity = speakerEmbeddings.cosineSimilarity(
          new Float32Array(embeddingArray),
          entry.embedding
        );
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestEntry = entry;
        }
      }

      if (!bestEntry || bestSimilarity <= 0.6) {
        continue;
      }

      usedLiveSpeakers.add(bestEntry.speakerId);
      reconciledSpeakers.add(mappedId);

      let displayName = bestEntry.displayName;
      let profileId = bestEntry.profileId;

      if (bestEntry.noteId) {
        const liveMapping = getMappingsForNote(bestEntry.noteId).find(
          (mapping) => mapping.speaker_id === bestEntry.speakerId
        );
        if (liveMapping) {
          displayName = liveMapping.display_name || displayName;
          profileId = liveMapping.profile_id ?? profileId;
          this.databaseManager.setSpeakerMapping(
            bestEntry.noteId,
            mappedId,
            profileId,
            displayName
          );
          // Live and offline ids share one namespace now, so they often match —
          // removing the "old" row would delete the mapping just written.
          if (bestEntry.speakerId !== mappedId) {
            this.databaseManager.removeSpeakerMapping(bestEntry.noteId, bestEntry.speakerId);
          }
        } else if (displayName) {
          this.databaseManager.setSpeakerMapping(
            bestEntry.noteId,
            mappedId,
            profileId,
            displayName
          );
        }
      }

      this._applySpeakerName(enrichedSegments, mappedId, displayName);
    }

    return reconciledSpeakers;
  }

  _resolveSpeakerExpectation({ sessionConfig, noteId, observedSpeakerIds, diarizedSource }) {
    // Only a count the user set explicitly outranks the note: participants added
    // mid-meeting postdate the config snapshot taken at recording start.
    let expectedTotal = sessionConfig?.explicit ? sessionConfig.expectedCount : null;

    if (!expectedTotal && noteId != null) {
      try {
        expectedTotal = this._noteExpectedSpeakerCountOrNull(this.databaseManager.getNote(noteId));
      } catch (_) {
        expectedTotal = null;
      }
    }

    // Diarizing the mic track (in-person session) means the user is one of the
    // diarized voices, so the expected total applies without the -1 the
    // system-audio branches use.
    const micMode = diarizedSource === "mic";

    if (expectedTotal) {
      const total = Math.min(expectedTotal, MAX_SPEAKER_COUNT);
      const numSpeakers = micMode ? total : Math.max(1, total - 1);
      return { numSpeakers, cap: numSpeakers };
    }

    if (observedSpeakerIds.size >= 2) {
      const numSpeakers = Math.min(observedSpeakerIds.size, MAX_SPEAKER_COUNT);
      return { numSpeakers, cap: numSpeakers };
    }

    if (micMode) {
      return { numSpeakers: -1, cap: DEFAULT_EXPECTED_SPEAKER_COUNT };
    }

    // Only system audio reaches the diarizer (the mic track is "you"), so the cap
    // counts other speakers — same total - 1 basis as the branches above.
    return { numSpeakers: -1, cap: Math.max(1, DEFAULT_EXPECTED_SPEAKER_COUNT - 1) };
  }

  _startOrSkipDiarization(
    sessionId,
    rawPcmPath,
    audioStartedAt,
    transcriptSegments,
    win,
    liveSpeakerState = null,
    sessionConfig = null,
    noteId = null,
    diarizedSource = "system"
  ) {
    const send = (payload) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send("meeting-diarization-complete", { sessionId, noteId, ...payload });
      }
    };

    const diarizationEnabled = (sessionConfig?.enabled ?? this.speakerDiarizationEnabled) !== false;

    if (!diarizationEnabled || !this.diarizationManager?.isAvailable() || !rawPcmPath) {
      send({
        segments: transcriptSegments.map((segment, index) => ({
          ...segment,
          id: segment.id || `segment-${index}`,
        })),
      });
      return;
    }

    const fs = require("fs");

    (async () => {
      let tmpWav = null;
      try {
        tmpWav = await this.diarizationManager.convertRawPcmToWav(rawPcmPath, 24000);
        const observedSpeakerIds = new Set(
          transcriptSegments
            .filter((segment) => segment.source === "system" && segment.speaker)
            .map((segment) => segment.speaker)
        );
        for (const speakerId of Object.keys(liveSpeakerState || {})) {
          observedSpeakerIds.add(speakerId);
        }

        if (observedSpeakerIds.size > 10) {
          debugLogger.warn("Excessive speaker count from live identification", {
            observedSpeakers: observedSpeakerIds.size,
          });
        }

        const { numSpeakers, cap } = this._resolveSpeakerExpectation({
          sessionConfig,
          noteId,
          observedSpeakerIds,
          diarizedSource,
        });
        let diarizationSegments = await this.diarizationManager.diarize(
          tmpWav,
          numSpeakers > 0 ? { numSpeakers } : {}
        );
        if (cap != null) {
          diarizationSegments = this.diarizationManager.capSpeakerClusters(
            diarizationSegments,
            cap
          );
        }

        const startMs =
          (Number.isFinite(audioStartedAt) && audioStartedAt) ||
          transcriptSegments.find((segment) => segment.source === diarizedSource)?.timestamp ||
          transcriptSegments[0]?.timestamp ||
          0;
        const isEpochMs = startMs > 1e9;
        const normalized = transcriptSegments.map((seg) => ({
          ...seg,
          timestamp:
            seg.timestamp != null
              ? isEpochMs
                ? (seg.timestamp - startMs) / 1000
                : seg.timestamp
              : undefined,
        }));

        const enrichedSegments = this.diarizationManager.mergeWithTranscript(
          normalized,
          diarizationSegments,
          { diarizedSource }
        );

        const speakerSet = new Set(diarizationSegments.map((d) => d.speaker));
        const speakerRenumber = new Map();
        let sIdx = 0;
        for (const sp of speakerSet) {
          speakerRenumber.set(sp, `speaker_${sIdx}`);
          sIdx++;
        }

        // Mirrors the mic-mode single-cluster softening in mergeWithTranscript:
        // every segment stays "you", so persisting an embedding keyed to a
        // cluster id that owns no segments would leave the note inconsistent.
        const micSingleClusterSoftened = diarizedSource === "mic" && speakerSet.size === 1;

        let speakerEmbeddingsMap = null;
        const speakerEmb = require("./speakerEmbeddings");
        try {
          if (!micSingleClusterSoftened && speakerEmb.isAvailable() && tmpWav) {
            const speakerIds = [...new Set(diarizationSegments.map((s) => s.speaker))];
            speakerEmbeddingsMap = {};

            for (const spk of speakerIds) {
              const segs = diarizationSegments.filter((s) => s.speaker === spk);
              const sorted = segs.sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 3);
              const embeddings = [];
              for (const seg of sorted) {
                if (seg.end - seg.start < 1.5) continue;
                const emb = await speakerEmb.extractEmbedding(tmpWav, seg.start, seg.end);
                if (emb) embeddings.push(emb);
              }
              if (embeddings.length > 0) {
                const centroid = speakerEmb.computeCentroid(embeddings);
                const mappedId = speakerRenumber.get(spk) || spk;
                speakerEmbeddingsMap[mappedId] = Array.from(centroid);
              }
            }
          }
        } catch (err) {
          debugLogger.debug("Speaker embedding extraction skipped", { error: err.message });
        }

        const reconciledSpeakers = this._reconcileLiveSpeakerState(
          liveSpeakerState,
          speakerEmbeddingsMap,
          enrichedSegments
        );

        if (speakerEmbeddingsMap) {
          try {
            const profiles = this.databaseManager.getSpeakerProfiles(true);

            if (profiles.length > 0) {
              for (const [mappedId, embArr] of Object.entries(speakerEmbeddingsMap)) {
                const alreadyMapped = enrichedSegments.some(
                  (segment) => segment.speaker === mappedId && segment.speakerName
                );
                if (reconciledSpeakers.has(mappedId) || alreadyMapped) {
                  continue;
                }

                const emb = new Float32Array(embArr);
                let bestProfile = null;
                let bestSim = 0;

                for (const profile of profiles) {
                  const profileEmb = new Float32Array(
                    profile.embedding.buffer,
                    profile.embedding.byteOffset,
                    profile.embedding.byteLength / 4
                  );
                  const sim = speakerEmb.cosineSimilarity(emb, profileEmb);
                  if (sim > bestSim) {
                    bestSim = sim;
                    bestProfile = profile;
                  }
                }

                if (bestProfile && bestSim > 0.6) {
                  for (const seg of enrichedSegments) {
                    if (seg.speaker === mappedId) {
                      applyConfirmedSpeaker(seg, {
                        speakerName: bestProfile.display_name,
                        speakerIsPlaceholder: false,
                        suggestedName: undefined,
                        suggestedProfileId: undefined,
                      });
                    }
                  }
                } else if (bestProfile && bestSim > 0.5) {
                  for (const seg of enrichedSegments) {
                    if (seg.speaker === mappedId) {
                      if (isSpeakerLocked(seg)) {
                        continue;
                      }
                      applySuggestedSpeaker(seg, {
                        suggestedName: bestProfile.display_name,
                        suggestedProfileId: bestProfile.id,
                      });
                    }
                  }
                }
              }
            }
          } catch (err) {
            debugLogger.debug("Auto speaker recognition skipped", { error: err.message });
          }
        }

        send({ segments: enrichedSegments, speakerEmbeddings: speakerEmbeddingsMap });
      } catch (err) {
        debugLogger.warn("Background diarization failed", { error: err.message });
        send({ segments: [] });
      } finally {
        try {
          fs.unlinkSync(rawPcmPath);
        } catch (_) {}
        if (tmpWav) {
          try {
            fs.unlinkSync(tmpWav);
          } catch (_) {}
        }
      }
    })();
  }

  deleteTranscriptionInternal(id) {
    this.audioStorageManager.deleteAudio(id);
    const result = this.databaseManager.deleteTranscription(id);
    if (result?.success) {
      setImmediate(() => {
        broadcastToWindows("transcription-deleted", { id });
      });
    }
    return result;
  }

  deleteNoteInternal(id) {
    const result = this.databaseManager.deleteNote(id);
    if (result?.success) {
      setImmediate(() => broadcastToWindows("note-deleted", { id }));
      this._asyncVectorDelete(id);
      this._asyncMirrorDelete(id);
    }
    return result;
  }
}

module.exports = IPCHandlers;
