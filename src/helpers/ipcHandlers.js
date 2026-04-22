const { ipcMain, app, shell, BrowserWindow, systemPreferences } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const GnomeShortcutManager = require("./gnomeShortcut");
const HyprlandShortcutManager = require("./hyprlandShortcut");
const AssemblyAiStreaming = require("./assemblyAiStreaming");
const { i18nMain, changeLanguage } = require("./i18nMain");
const DeepgramStreaming = require("./deepgramStreaming");
const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");
const AudioStorageManager = require("./audioStorage");
const liveSpeakerIdentifier = require("./liveSpeakerIdentifier");
const MeetingEchoLeakDetector = require("./meetingEchoLeakDetector");
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
const { downsample24kTo16k, pcm16ToWav } = require("../utils/audioUtils");
const {
  DEFAULT_EXPECTED_SPEAKER_COUNT,
  MAX_SPEAKER_COUNT,
} = require("../constants/speakerDetection.json");

const STREAMING_CLIENT_BY_PROVIDER = {
  "openai-realtime": OpenAIRealtimeStreaming,
  "assemblyai-realtime": AssemblyAiStreaming,
  "deepgram-realtime": DeepgramStreaming,
};
const ALLOWED_MEETING_PROVIDERS = new Set([
  "local",
  "openai-realtime",
  "assemblyai-realtime",
  "deepgram-realtime",
]);

function parseAttendees(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const MISTRAL_TRANSCRIPTION_URL = "https://api.mistral.ai/v1/audio/transcriptions";

// Debounce delay: wait for user to stop typing before processing corrections
const AUTO_LEARN_DEBOUNCE_MS = 1500;

const AUDIO_MIME_TYPES = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
};

const CLOUD_INLINE_LIMIT = 4 * 1024 * 1024;
const CLOUD_CHUNK_CONCURRENCY = 5;
const CLOUD_CHUNK_SEGMENT_SECONDS = 240;

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

function postMultipart(url, body, boundary, headers = {}) {
  const httpModule = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = httpModule.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
          ...headers,
        },
      },
      (res) => {
        let responseData = "";
        res.on("data", (chunk) => (responseData += chunk));
        res.on("end", () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(responseData) });
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${responseData.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
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
    throw new Error(data.data?.error || `API error: ${data.statusCode}`);
  }
  return data.data;
}

async function chunkedCloudTranscribe({
  buffer = null,
  filePath = null,
  apiUrl,
  cookieHeader,
  multipartFields = {},
  onProgress,
  concurrencyLimit = CLOUD_CHUNK_CONCURRENCY,
  segmentDuration = CLOUD_CHUNK_SEGMENT_SECONDS,
}) {
  const { splitAudioFile } = require("./ffmpegUtils");

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

    const chunkPaths = await splitAudioFile(inputPath, chunkDir, { segmentDuration });
    const totalChunks = chunkPaths.length;

    onProgress?.({ stage: "transcribing", chunksTotal: totalChunks, chunksCompleted: 0 });

    const results = new Array(totalChunks).fill(null);
    const failureCodes = new Set();
    let completedCount = 0;

    const transcribeChunk = async (index) => {
      const chunkBuffer = fs.readFileSync(chunkPaths[index]);
      const chunkName = path.basename(chunkPaths[index]);
      const { body, boundary } = buildMultipartBody(
        chunkBuffer,
        chunkName,
        "audio/mpeg",
        multipartFields
      );
      const url = new URL(`${apiUrl}/api/transcribe`);
      const data = await postMultipart(url, body, boundary, { Cookie: cookieHeader });

      results[index] = interpretTranscribeResponse(data);
      completedCount++;
      onProgress?.({
        stage: "transcribing",
        chunksTotal: totalChunks,
        chunksCompleted: completedCount,
      });
    };

    const executing = new Set();
    for (let index = 0; index < totalChunks; index++) {
      const p = transcribeChunk(index).then(
        () => executing.delete(p),
        (err) => {
          executing.delete(p);
          if (err.code === "AUTH_EXPIRED" || err.code === "LIMIT_REACHED") throw err;
          if (err.code) failureCodes.add(err.code);
          debugLogger.warn(`Chunk ${index} failed`, { error: err.message, code: err.code });
        }
      );
      executing.add(p);
      if (executing.size >= concurrencyLimit) {
        await Promise.race(executing);
      }
    }
    await Promise.all(executing);

    const succeeded = results.filter((r) => r !== null);
    if (succeeded.length === 0) {
      if (failureCodes.size === 1 && failureCodes.has("NO_SPEECH_DETECTED")) {
        throw Object.assign(new Error("No speech detected in audio"), {
          code: "NO_SPEECH_DETECTED",
        });
      }
      throw new Error("All chunks failed to transcribe");
    }

    const text = results
      .filter((r) => r !== null)
      .map((r) => r.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const failed = totalChunks - succeeded.length;
    return {
      text,
      responses: succeeded,
      lastResponse: succeeded[succeeded.length - 1],
      ...(failed > 0 ? { warning: `${failed} of ${totalChunks} chunks failed` } : {}),
    };
  } finally {
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
    this.getTrayManager = managers.getTrayManager;
    this.whisperCudaManager = managers.whisperCudaManager;
    this.googleCalendarManager = managers.googleCalendarManager;
    this.meetingDetectionEngine = managers.meetingDetectionEngine;
    this.audioTapManager = managers.audioTapManager;
    this.linuxPortalAudioManager = managers.linuxPortalAudioManager;
    this.meetingAecManager = managers.meetingAecManager;
    this.sessionId = crypto.randomUUID();
    this.assemblyAiStreaming = null;
    this.deepgramStreaming = null;
    this._dictationStreaming = null;
    this._dictationConnectPromise = null;
    this._dictationIdleTimer = null;
    this._meetingMicStreaming = null;
    this._meetingSystemStreaming = null;
    this._autoLearnEnabled = true; // Default on, synced from renderer
    this._autoLearnDebounceTimer = null;
    this._autoLearnLatestData = null;
    this._textEditHandler = null;
    this._activeRecordingPipeline = null;
    this.audioStorageManager = new AudioStorageManager();
    this._audioCleanupInterval = null;
    this._noteFilesEnabled = false;
    this.speakerDiarizationEnabled = true;
    this.activeMeetingSpeakerConfig = null;
    liveSpeakerIdentifier.setDiarizationManager(this.diarizationManager);
    this._setupTextEditMonitor();
    this._setupAudioCleanup();
    this._logDetectedGpus();
    this.setupHandlers();

    if (this.whisperManager?.serverManager) {
      this.whisperManager.serverManager.on("cuda-fallback", () => {
        this.broadcastToWindows("cuda-fallback-notification", {});
      });
    }
  }

  _asyncVectorUpsert(note) {
    setImmediate(() => {
      const vectorIndex = require("./vectorIndex");
      if (!vectorIndex.isReady()) return;
      const { LocalEmbeddings } = require("./localEmbeddings");
      const text = LocalEmbeddings.noteEmbedText(note.title, note.content, note.enhanced_content);
      vectorIndex.upsertNote(note.id, text).catch(() => {});
    });
  }

  _asyncVectorDelete(noteId) {
    setImmediate(() => {
      const vectorIndex = require("./vectorIndex");
      if (!vectorIndex.isReady()) return;
      vectorIndex.deleteNote(noteId).catch(() => {});
    });
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

  _resolveOneOnOneOtherParticipant(participantsJson) {
    if (!participantsJson) return null;
    let participants;
    try {
      participants = JSON.parse(participantsJson);
    } catch (_) {
      return null;
    }
    if (!Array.isArray(participants) || participants.length === 0) return null;
    const googleEmails = new Set(
      this.databaseManager.getGoogleAccounts().map((a) => a.email.toLowerCase())
    );
    const isSelf = (p) => p.self === true || googleEmails.has((p.email || "").toLowerCase());
    const others = participants.filter((p) => !isSelf(p));
    if (others.length !== 1) return null;
    const displayName = others[0].displayName || others[0].email;
    if (!displayName) return null;
    const email = (others[0].email || "").toLowerCase().trim() || null;
    return { displayName, email };
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

  _resolveByokModel(provider, configuredModel) {
    const trimmed = (configuredModel || "").trim();
    if (provider === "custom") return trimmed || "whisper-1";
    if (trimmed) {
      const isGroq = trimmed.startsWith("whisper-large-v3");
      const isOpenAI = trimmed.startsWith("gpt-4o") || trimmed === "whisper-1";
      const isMistral = trimmed.startsWith("voxtral-");
      if (provider === "groq" && isGroq) return trimmed;
      if (provider === "openai" && isOpenAI) return trimmed;
      if (provider === "mistral" && isMistral) return trimmed;
    }
    if (provider === "groq") return "whisper-large-v3-turbo";
    if (provider === "mistral") return "voxtral-mini-latest";
    return "gpt-4o-mini-transcribe";
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
        { count: gpus.length, devices: gpus.map((g) => `${g.name} (${g.vramMb}MB)`) },
        "gpu"
      );
    } else {
      debugLogger.debug("No NVIDIA GPUs detected", {}, "gpu");
    }
  }

  _setupAudioCleanup() {
    const DEFAULT_RETENTION_DAYS = 30;
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

    // Run initial cleanup with default retention
    try {
      this.audioStorageManager.cleanupExpiredAudio(DEFAULT_RETENTION_DAYS, this.databaseManager);
    } catch (error) {
      debugLogger.error("Initial audio cleanup failed", { error: error.message }, "audio-storage");
    }

    // Set up periodic cleanup every 6 hours
    this._audioCleanupInterval = setInterval(() => {
      try {
        this.audioStorageManager.cleanupExpiredAudio(DEFAULT_RETENTION_DAYS, this.databaseManager);
      } catch (error) {
        debugLogger.error(
          "Periodic audio cleanup failed",
          { error: error.message },
          "audio-storage"
        );
      }
    }, SIX_HOURS_MS);
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
        const updatedDict = [...currentDict, ...corrections];
        const saveResult = this.databaseManager.setDictionary(updatedDict);

        if (saveResult?.success === false) {
          debugLogger.debug("[AutoLearn] Failed to save dictionary", { error: saveResult.error });
          return;
        }

        this.broadcastToWindows("dictionary-updated", updatedDict);

        // Show the overlay so the toast is visible (it may have been hidden after dictation)
        this.windowManager.showDictationPanel();
        this.broadcastToWindows("corrections-learned", corrections);
        debugLogger.debug("[AutoLearn] Saved corrections", { corrections });
      }
    } catch (error) {
      debugLogger.debug("[AutoLearn] Error processing corrections", { error: error.message });
    }
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
      this.environmentManager.saveAllKeysToEnvFile().catch(() => {});
    }
  }

  setupHandlers() {
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

    ipcMain.handle("restore-from-meeting-mode", () => {
      this.windowManager.restoreControlPanelFromMeetingMode();
      this.meetingDetectionEngine?.setMeetingModeActive(false);
    });

    ipcMain.handle("app-quit", () => {
      app.quit();
    });

    ipcMain.handle("hide-window", () => {
      if (process.platform === "darwin") {
        this.windowManager.hideDictationPanel();
        if (app.dock) app.dock.show();
      } else {
        this.windowManager.hideDictationPanel();
      }
    });

    ipcMain.handle("show-dictation-panel", () => {
      this.windowManager.showDictationPanel();
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

    ipcMain.handle("set-notification-interactivity", (event, interactive) => {
      this.windowManager.setNotificationInteractivity(Boolean(interactive));
      return { success: true };
    });

    ipcMain.handle("resize-main-window", (event, sizeKey) => {
      return this.windowManager.resizeMainWindow(sizeKey);
    });

    ipcMain.handle("get-openai-key", async (event) => {
      return this.environmentManager.getOpenAIKey();
    });

    ipcMain.handle("save-openai-key", async (event, key) => {
      return this.environmentManager.saveOpenAIKey(key);
    });

    ipcMain.handle("create-production-env-file", async (event, apiKey) => {
      return this.environmentManager.createProductionEnvFile(apiKey);
    });

    ipcMain.handle("db-save-transcription", async (event, text, rawText, options) => {
      const result = this.databaseManager.saveTranscription(text, rawText, options);
      if (result?.success && result?.transcription) {
        setImmediate(() => {
          this.broadcastToWindows("transcription-added", result.transcription);
        });
      }
      return result;
    });

    ipcMain.handle("db-get-transcriptions", async (event, limit = 50) => {
      return this.databaseManager.getTranscriptions(limit);
    });

    ipcMain.handle("db-clear-transcriptions", async (event) => {
      this.audioStorageManager.deleteAllAudio();
      const result = this.databaseManager.clearTranscriptions();
      if (result?.success) {
        setImmediate(() => {
          this.broadcastToWindows("transcriptions-cleared", {
            cleared: result.cleared,
          });
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-transcription", async (event, id) => {
      this.audioStorageManager.deleteAudio(id);
      const result = this.databaseManager.deleteTranscription(id);
      if (result?.success) {
        setImmediate(() => {
          this.broadcastToWindows("transcription-deleted", { id });
        });
      }
      return result;
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
        if (updated) this.broadcastToWindows("transcription-updated", updated);
      }
      return result;
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

    // Dictionary handlers
    ipcMain.on("auto-learn-changed", (_event, enabled) => {
      this._autoLearnEnabled = !!enabled;
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

    ipcMain.handle("undo-learned-corrections", async (_event, words) => {
      try {
        if (!Array.isArray(words) || words.length === 0) {
          return { success: false };
        }
        const validWords = words.filter((w) => typeof w === "string" && w.trim().length > 0);
        if (validWords.length === 0) {
          return { success: false };
        }
        const currentDict = this._getDictionarySafe();
        const removeSet = new Set(validWords.map((w) => w.toLowerCase()));
        const updatedDict = currentDict.filter((w) => !removeSet.has(w.toLowerCase()));
        const saveResult = this.databaseManager.setDictionary(updatedDict);
        if (saveResult?.success === false) {
          debugLogger.debug("[AutoLearn] Undo failed to save dictionary", {
            error: saveResult.error,
          });
          return { success: false };
        }
        this.broadcastToWindows("dictionary-updated", updatedDict);
        debugLogger.debug("[AutoLearn] Undo: removed words", { words: validWords });
        return { success: true };
      } catch (err) {
        debugLogger.debug("[AutoLearn] Undo failed", { error: err.message });
        return { success: false };
      }
    });

    ipcMain.handle(
      "db-save-note",
      async (event, title, content, noteType, sourceFile, audioDuration, folderId) => {
        const result = this.databaseManager.saveNote(
          title,
          content,
          noteType,
          sourceFile,
          audioDuration,
          folderId
        );
        if (result?.success && result?.note) {
          setImmediate(() => this.broadcastToWindows("note-added", result.note));
          this._asyncVectorUpsert(result.note);
          this._asyncMirrorWrite(result.note);
        }
        return result;
      }
    );

    ipcMain.handle("db-get-note", async (event, id) => {
      return this.databaseManager.getNote(id);
    });

    ipcMain.handle("db-get-notes", async (event, noteType, limit, folderId) => {
      return this.databaseManager.getNotes(noteType, limit, folderId);
    });

    ipcMain.handle("db-update-note", async (event, id, updates) => {
      const result = this.databaseManager.updateNote(id, updates);
      if (result?.success && result?.note) {
        setImmediate(() => this.broadcastToWindows("note-updated", result.note));
        this._asyncVectorUpsert(result.note);
        this._asyncMirrorWrite(result.note);
        if (updates.participants) this._tryAutoLabelOneOnOne(id);
      }
      return result;
    });

    ipcMain.handle("db-delete-note", async (event, id) => {
      const result = this.databaseManager.deleteNote(id);
      if (result?.success) {
        setImmediate(() => this.broadcastToWindows("note-deleted", { id }));
        this._asyncVectorDelete(id);
        this._asyncMirrorDelete(id);
      }
      return result;
    });

    ipcMain.handle("db-search-notes", async (event, query, limit) => {
      return this.databaseManager.searchNotes(query, limit);
    });

    ipcMain.handle("db-semantic-search-notes", async (event, query, limit = 5) => {
      const vectorIndex = require("./vectorIndex");
      if (!vectorIndex.isReady()) {
        return this.databaseManager.searchNotes(query, limit);
      }

      try {
        const [ftsResults, vectorResults] = await Promise.all([
          this.databaseManager.searchNotes(query, limit * 2),
          vectorIndex.search(query, limit * 2),
        ]);

        // Filter low-confidence semantic matches before RRF
        const filteredVectorResults = vectorResults.filter(({ score }) => score > 0.3);

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
        debugLogger.error("Semantic search failed, falling back to FTS5", { error: error.message });
        return this.databaseManager.searchNotes(query, limit);
      }
    });

    ipcMain.handle("db-semantic-reindex-all", async () => {
      const vectorIndex = require("./vectorIndex");
      if (!vectorIndex.isReady()) return { success: false, error: "Vector index not ready" };

      const notes = this.databaseManager.getNotes(null, 100000);
      let done = 0;
      await vectorIndex.reindexAll(notes, (completed, total) => {
        done = completed;
        this.broadcastToWindows("semantic-reindex-progress", { done: completed, total });
      });
      return { success: true, indexed: done };
    });

    ipcMain.handle("db-update-note-cloud-id", async (event, id, cloudId) => {
      return this.databaseManager.updateNoteCloudId(id, cloudId);
    });

    ipcMain.handle("db-get-folders", async () => {
      return this.databaseManager.getFolders();
    });

    ipcMain.handle("db-create-folder", async (event, name) => {
      const result = this.databaseManager.createFolder(name);
      if (result?.success && result?.folder) {
        setImmediate(() => {
          this.broadcastToWindows("folder-created", result.folder);
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
        setImmediate(() => {
          this.broadcastToWindows("folder-deleted", { id });
          if (this._noteFilesEnabled && folderName) {
            const markdownMirror = require("./markdownMirror");
            markdownMirror.deleteFolder(folderName);
          }
        });
      }
      return result;
    });

    ipcMain.handle("db-rename-folder", async (event, id, name) => {
      const oldName = this._noteFilesEnabled ? this._getFolderName(id) : null;
      const result = this.databaseManager.renameFolder(id, name);
      if (result?.success && result?.folder) {
        setImmediate(() => {
          this.broadcastToWindows("folder-renamed", result.folder);
          if (this._noteFilesEnabled && oldName) {
            const markdownMirror = require("./markdownMirror");
            markdownMirror.renameFolder(oldName, name);
          }
        });
      }
      return result;
    });

    ipcMain.handle("db-get-folder-note-counts", async () => {
      return this.databaseManager.getFolderNoteCounts();
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
          this.broadcastToWindows("action-created", result.action);
        });
      }
      return result;
    });

    ipcMain.handle("db-update-action", async (event, id, updates) => {
      const result = this.databaseManager.updateAction(id, updates);
      if (result?.success && result?.action) {
        setImmediate(() => {
          this.broadcastToWindows("action-updated", result.action);
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-action", async (event, id) => {
      const result = this.databaseManager.deleteAction(id);
      if (result?.success) {
        setImmediate(() => {
          this.broadcastToWindows("action-deleted", { id });
        });
      }
      return result;
    });

    // Agent conversation handlers
    ipcMain.handle("db-create-agent-conversation", async (event, title, noteId) => {
      return this.databaseManager.createAgentConversation(title, noteId);
    });

    ipcMain.handle("db-get-conversations-for-note", async (event, noteId, limit) => {
      return this.databaseManager.getConversationsForNote(noteId, limit);
    });

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
        if (this.vectorIndex?.isReady?.()) {
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
    ipcMain.handle("db-get-pending-notes", () => this.databaseManager.getPendingNotes());
    ipcMain.handle("db-get-pending-note-deletes", () =>
      this.databaseManager.getPendingNoteDeletes()
    );
    ipcMain.handle("db-get-note-by-client-id", (_, clientNoteId) =>
      this.databaseManager.getNoteByClientId(clientNoteId)
    );
    ipcMain.handle("db-upsert-note-from-cloud", (_, cloudNote, localFolderId) =>
      this.databaseManager.upsertNoteFromCloud(cloudNote, localFolderId)
    );
    ipcMain.handle("db-mark-note-synced", (_, id, cloudId) =>
      this.databaseManager.markNoteSynced(id, cloudId)
    );
    ipcMain.handle("db-mark-note-sync-error", (_, id) =>
      this.databaseManager.markNoteSyncError(id)
    );
    ipcMain.handle("db-hard-delete-note", (_, id) => {
      const result = this.databaseManager.hardDeleteNote(id);
      if (result?.success) {
        this._asyncVectorDelete(id);
        this._asyncMirrorDelete(id);
        setImmediate(() => this.broadcastToWindows("note-deleted", { id }));
      }
      return result;
    });

    // Folders sync
    ipcMain.handle("db-get-pending-folders", () => this.databaseManager.getPendingFolders());
    ipcMain.handle("db-get-folder-by-client-id", (_, clientFolderId) =>
      this.databaseManager.getFolderByClientId(clientFolderId)
    );
    ipcMain.handle("db-upsert-folder-from-cloud", (_, cloudFolder) =>
      this.databaseManager.upsertFolderFromCloud(cloudFolder)
    );
    ipcMain.handle("db-mark-folder-synced", (_, id, cloudId) =>
      this.databaseManager.markFolderSynced(id, cloudId)
    );
    ipcMain.handle("db-get-folder-id-map", () => this.databaseManager.getFolderIdMap());
    ipcMain.handle("db-get-pending-folder-deletes", () =>
      this.databaseManager.getPendingFolderDeletes()
    );
    ipcMain.handle("db-hard-delete-folder", (_, id) => {
      const result = this.databaseManager.hardDeleteFolder(id);
      if (result?.success) {
        for (const noteId of result.noteIds ?? []) {
          this._asyncVectorDelete(noteId);
        }
        setImmediate(() => {
          this.broadcastToWindows("folder-deleted", { id });
          if (this._noteFilesEnabled && result.name) {
            const markdownMirror = require("./markdownMirror");
            markdownMirror.deleteFolder(result.name);
          }
        });
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
    ipcMain.handle("db-mark-conversation-synced", (_, id, cloudId) =>
      this.databaseManager.markConversationSynced(id, cloudId)
    );
    ipcMain.handle("db-hard-delete-conversation", (_, id) => {
      const result = this.databaseManager.hardDeleteConversation(id);
      if (result?.success) {
        setImmediate(() => this.broadcastToWindows("conversation-deleted", { id }));
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
        setImmediate(() => this.broadcastToWindows("transcription-deleted", { id }));
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
          exportContent = transcriptFormatter.formatSrt(segments, speakerMappings);
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

    ipcMain.handle("select-audio-file", async () => {
      const { dialog } = require("electron");
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [
          { name: "Audio Files", extensions: ["mp3", "wav", "m4a", "webm", "ogg", "flac", "aac"] },
        ],
      });
      if (result.canceled || !result.filePaths.length) {
        return { canceled: true };
      }
      return { canceled: false, filePath: result.filePaths[0] };
    });

    ipcMain.handle("get-file-size", async (_event, filePath) => {
      const fs = require("fs");
      try {
        const stats = fs.statSync(filePath);
        return stats.size;
      } catch {
        return 0;
      }
    });

    ipcMain.handle("transcribe-audio-file", async (event, filePath, options = {}) => {
      const fs = require("fs");
      try {
        const audioBuffer = fs.readFileSync(filePath);
        if (options.provider === "nvidia") {
          const result = await this.parakeetManager.transcribeLocalParakeet(audioBuffer, options);
          return result;
        }
        const result = await this.whisperManager.transcribeLocalWhisper(audioBuffer, options);
        return result;
      } catch (error) {
        debugLogger.error("Audio file transcription error", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("paste-text", async (event, text, options) => {
      // If the floating dictation panel currently has focus, dismiss it so the
      // paste keystroke lands in the user's target app instead of the overlay.
      const mainWindow = this.windowManager?.mainWindow;
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
        if (process.platform === "darwin") {
          // hide() forces macOS to activate the previous app; showInactive()
          // restores the overlay without stealing focus.
          mainWindow.hide();
          await new Promise((resolve) => setTimeout(resolve, 120));
          mainWindow.showInactive();
        } else {
          mainWindow.blur();
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      }
      const result = await this.clipboardManager.pasteText(text, {
        ...options,
        webContents: event.sender,
      });
      const targetPid = this.textEditMonitor?.lastTargetPid || null;
      debugLogger.debug("[AutoLearn] Paste completed", {
        autoLearnEnabled: this._autoLearnEnabled,
        hasMonitor: !!this.textEditMonitor,
        targetPid,
      });
      if (this.textEditMonitor && this._autoLearnEnabled) {
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
      return result;
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

    ipcMain.handle("transcribe-local-whisper", async (event, audioBlob, options = {}) => {
      debugLogger.log("transcribe-local-whisper called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      try {
        const result = await this.whisperManager.transcribeLocalWhisper(audioBlob, options);

        debugLogger.log("Whisper result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        // Check if no audio was detected and send appropriate event
        if (!result.success && result.message === "No audio detected") {
          debugLogger.log("Sending no-audio-detected event to renderer");
          event.sender.send("no-audio-detected");
        }

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
        if (!event.sender.isDestroyed()) {
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
      const useCuda =
        process.env.WHISPER_CUDA_ENABLED === "true" && this.whisperCudaManager?.isDownloaded();
      return this.whisperManager.startServer(modelName, { useCuda });
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

    ipcMain.handle("set-gpu-device-index", async (_event, purpose, index) => {
      if (purpose !== "transcription" && purpose !== "intelligence") {
        return { success: false };
      }
      const parsed = parseInt(index, 10);
      if (isNaN(parsed) || parsed < 0) {
        return { success: false };
      }
      const idx = String(parsed);
      const key = purpose === "intelligence" ? "INTELLIGENCE_GPU_INDEX" : "TRANSCRIPTION_GPU_INDEX";
      const oldIdx = process.env[key] || "0";
      process.env[key] = idx;
      this.environmentManager.saveAllKeysToEnvFile().catch((err) => {
        debugLogger.error("Failed to persist GPU index", { error: err.message }, "gpu");
      });

      if (oldIdx !== idx) {
        try {
          if (purpose === "transcription" && this.whisperManager?.serverManager?.process) {
            debugLogger.info(
              "Restarting whisper-server for GPU change",
              { from: oldIdx, to: idx },
              "gpu"
            );
            const modelName = this.whisperManager.currentServerModel;
            await this.whisperManager.stopServer();
            if (modelName) {
              await this.whisperManager.startServer(modelName, {
                useCuda: !!process.env.WHISPER_CUDA_ENABLED,
              });
            }
          }
          if (purpose === "intelligence") {
            const modelManager = require("./modelManagerBridge").default;
            if (modelManager.serverManager?.process) {
              debugLogger.info(
                "Restarting llama-server for GPU change",
                { from: oldIdx, to: idx },
                "gpu"
              );
              const modelPath = modelManager.serverManager.modelPath;
              await modelManager.serverManager.stop();
              if (modelPath) {
                await modelManager.serverManager.start(modelPath);
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
        return "0";
      }
      const key = purpose === "intelligence" ? "INTELLIGENCE_GPU_INDEX" : "TRANSCRIPTION_GPU_INDEX";
      return process.env[key] || "0";
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
      };
    });

    ipcMain.handle("download-cuda-whisper-binary", async (event) => {
      if (!this.whisperCudaManager) {
        return { success: false, error: "CUDA not supported on this platform" };
      }
      try {
        await this.whisperCudaManager.download((progress) => {
          if (progress.type === "progress" && !event.sender.isDestroyed()) {
            event.sender.send("cuda-download-progress", {
              downloadedBytes: progress.downloaded_bytes,
              totalBytes: progress.total_bytes,
              percentage: progress.percentage,
            });
          }
        });
        this._syncStartupEnv({ WHISPER_CUDA_ENABLED: "true" });
        // Restart whisper-server so it picks up the CUDA binary
        await this.whisperManager.stopServer().catch(() => {});
        return { success: true };
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
      const result = await this.whisperCudaManager.delete();
      if (result.success) {
        this._syncStartupEnv({}, ["WHISPER_CUDA_ENABLED"]);
        // Restart whisper-server so it falls back to CPU binary
        await this.whisperManager.stopServer().catch(() => {});
      }
      return result;
    });

    ipcMain.handle("check-ffmpeg-availability", async (event) => {
      return this.whisperManager.checkFFmpegAvailability();
    });

    ipcMain.handle("transcribe-local-parakeet", async (event, audioBlob, options = {}) => {
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

        if (!result.success && result.message === "No audio detected") {
          debugLogger.log("Sending no-audio-detected event to renderer");
          event.sender.send("no-audio-detected");
        }

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
        if (!event.sender.isDestroyed()) {
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
      process.env.LOCAL_TRANSCRIPTION_PROVIDER = "nvidia";
      process.env.PARAKEET_MODEL = modelName;
      await this.environmentManager.saveAllKeysToEnvFile();
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
        const whisperDir = path.join(os.homedir(), ".cache", "openwhispr", "whisper-models");
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
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteAllModels();
      } catch (e) {
        errors.push(`LLM models: ${e.message}`);
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

      // Delete .env file
      try {
        const envPath = path.join(app.getPath("userData"), ".env");
        if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
      } catch (e) {
        errors.push(`Env file: ${e.message}`);
      }

      // Clear session cookies
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) await win.webContents.session.clearStorageData({ storages: ["cookies"] });
      } catch (e) {
        errors.push(`Cookies: ${e.message}`);
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

    ipcMain.handle("set-hotkey-listening-mode", async (event, enabled, newHotkey = null) => {
      this.windowManager.setHotkeyListeningMode(enabled);
      const hotkeyManager = this.windowManager.hotkeyManager;

      // When exiting capture mode with a new hotkey, use that to avoid reading stale state
      const effectiveHotkey = !enabled && newHotkey ? newHotkey : hotkeyManager.getCurrentHotkey();

      const {
        isGlobeLikeHotkey,
        isModifierOnlyHotkey,
        isRightSideModifier,
      } = require("./hotkeyManager");
      const usesNativeListener = (hotkey) =>
        !hotkey ||
        isGlobeLikeHotkey(hotkey) ||
        isModifierOnlyHotkey(hotkey) ||
        isRightSideModifier(hotkey);

      if (enabled) {
        // Entering capture mode — unregister ALL slots so none intercept keypresses.
        // Dictation is always active; meeting and agent may or may not be set.
        const allSlots = hotkeyManager.slots;
        for (const [slot, info] of allSlots) {
          if (!info?.hotkey) continue;

          if (!usesNativeListener(info.hotkey)) {
            debugLogger.log(
              `[IPC] Unregistering globalShortcut "${info.hotkey}" (slot "${slot}") for capture mode`
            );
            const { globalShortcut } = require("electron");
            try {
              globalShortcut.unregister(info.hotkey);
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
        if (effectiveHotkey && !usesNativeListener(effectiveHotkey) && !usesNativePath) {
          const { globalShortcut } = require("electron");
          const accelerator = effectiveHotkey.startsWith("Fn+")
            ? effectiveHotkey.slice(3)
            : effectiveHotkey;
          if (!globalShortcut.isRegistered(accelerator)) {
            debugLogger.log(
              `[IPC] Re-registering globalShortcut "${accelerator}" after capture mode`
            );
            const callback = this.windowManager.createHotkeyCallback();
            const registered = globalShortcut.register(accelerator, callback);
            if (!registered) {
              debugLogger.warn(
                `[IPC] Failed to re-register globalShortcut "${accelerator}" after capture mode`
              );
            }
          }
        }

        if (process.platform === "win32" && this.windowsKeyManager) {
          const activationMode = this.windowManager.getActivationMode();
          debugLogger.log(
            `[IPC] Exiting hotkey capture mode, activationMode="${activationMode}", hotkey="${effectiveHotkey}"`
          );
          const needsListener =
            effectiveHotkey &&
            !isGlobeLikeHotkey(effectiveHotkey) &&
            (activationMode === "push" ||
              isModifierOnlyHotkey(effectiveHotkey) ||
              isRightSideModifier(effectiveHotkey));
          if (needsListener) {
            debugLogger.log(`[IPC] Restarting Windows key listener for hotkey: ${effectiveHotkey}`);
            this.windowsKeyManager.start(effectiveHotkey);
          } else {
            this.windowsKeyManager.stop();
          }
        }

        if (process.platform === "linux" && this.linuxKeyManager) {
          const activationMode = this.windowManager.getActivationMode();
          const needsListener =
            effectiveHotkey &&
            !isGlobeLikeHotkey(effectiveHotkey) &&
            (activationMode === "push" ||
              isModifierOnlyHotkey(effectiveHotkey) ||
              isRightSideModifier(effectiveHotkey));
          if (needsListener) {
            debugLogger.log(`[IPC] Restarting Linux key listener for hotkey: ${effectiveHotkey}`);
            this.linuxKeyManager.start(effectiveHotkey);
          } else {
            this.linuxKeyManager.stop();
          }
        }

        // On GNOME, re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager && effectiveHotkey) {
          const gnomeHotkey = GnomeShortcutManager.convertToGnomeFormat(effectiveHotkey);
          debugLogger.log(
            `[IPC] Re-registering GNOME keybinding "${gnomeHotkey}" after capture mode`
          );
          const success = await hotkeyManager.gnomeManager.registerKeybinding(gnomeHotkey);
          if (success) {
            hotkeyManager.currentHotkey = effectiveHotkey;
          }
        }

        // On Hyprland Wayland, re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingHyprland() && hotkeyManager.hyprlandManager && effectiveHotkey) {
          debugLogger.log(
            `[IPC] Re-registering Hyprland keybinding "${effectiveHotkey}" after capture mode`
          );
          const success = await hotkeyManager.hyprlandManager.registerKeybinding(effectiveHotkey);
          if (success) {
            hotkeyManager.currentHotkey = effectiveHotkey;
          }
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
            callback
          );
          if (result === true) {
            hotkeyManager.currentHotkey = effectiveHotkey;
          } else {
            debugLogger.warn(
              `[IPC] Failed to re-register KDE keybinding "${effectiveHotkey}" after capture mode`,
              { result }
            );
          }
        }

        // Re-register non-dictation slots (meeting, agent) that were unregistered on capture enter
        for (const [slot, info] of hotkeyManager.slots) {
          if (slot === "dictation" || slot === "cancel" || !info?.hotkey || !info?.callback)
            continue;
          debugLogger.log(
            `[IPC] Re-registering slot "${slot}" ("${info.hotkey}") after capture mode`
          );
          await hotkeyManager.registerSlot(slot, info.hotkey, info.callback).catch((err) => {
            debugLogger.warn(`[IPC] Failed to re-register slot "${slot}":`, err.message);
          });
        }
      }

      return { success: true };
    });

    ipcMain.handle("get-hotkey-mode-info", async () => {
      const isUsingNativeShortcut = this.windowManager.isUsingNativeShortcutHotkeys();
      const supportsPushToTalk =
        process.platform === "linux"
          ? this.linuxKeyManager?.isAvailable?.() === true
          : !isUsingNativeShortcut;

      return {
        isUsingGnome: this.windowManager.isUsingGnomeHotkeys(),
        isUsingHyprland: this.windowManager.isUsingHyprlandHotkeys(),
        isUsingKDE: this.windowManager.isUsingKDEHotkeys(),
        isUsingNativeShortcut,
        supportsPushToTalk,
      };
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
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-auto-start-enabled", async () => {
      try {
        const loginSettings = app.getLoginItemSettings();
        return loginSettings.openAtLogin;
      } catch (error) {
        debugLogger.error("Error getting auto-start status:", error);
        return false;
      }
    });

    ipcMain.handle("set-auto-start-enabled", async (event, enabled) => {
      try {
        app.setLoginItemSettings({
          openAtLogin: enabled,
          openAsHidden: true, // Start minimized to tray
        });
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
      try {
        const modelManager = require("./modelManagerBridge").default;
        const result = await modelManager.downloadModel(
          modelId,
          (progress, downloadedSize, totalSize) => {
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
        return { success: true, path: result };
      } catch (error) {
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

    ipcMain.handle("get-anthropic-key", async (event) => {
      return this.environmentManager.getAnthropicKey();
    });

    ipcMain.handle("get-gemini-key", async (event) => {
      return this.environmentManager.getGeminiKey();
    });

    ipcMain.handle("save-gemini-key", async (event, key) => {
      return this.environmentManager.saveGeminiKey(key);
    });

    ipcMain.handle("get-groq-key", async (event) => {
      return this.environmentManager.getGroqKey();
    });

    ipcMain.handle("save-groq-key", async (event, key) => {
      return this.environmentManager.saveGroqKey(key);
    });

    ipcMain.handle("get-mistral-key", async () => {
      return this.environmentManager.getMistralKey();
    });

    ipcMain.handle("save-mistral-key", async (event, key) => {
      return this.environmentManager.saveMistralKey(key);
    });

    ipcMain.handle(
      "proxy-mistral-transcription",
      async (event, { audioBuffer, model, language, contextBias }) => {
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

        const response = await fetch(MISTRAL_TRANSCRIPTION_URL, {
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
      }
    );

    ipcMain.handle("get-custom-transcription-key", async () => {
      return this.environmentManager.getCustomTranscriptionKey();
    });

    ipcMain.handle("save-custom-transcription-key", async (event, key) => {
      return this.environmentManager.saveCustomTranscriptionKey(key);
    });

    ipcMain.handle("get-custom-reasoning-key", async () => {
      return this.environmentManager.getCustomReasoningKey();
    });

    ipcMain.handle("save-custom-reasoning-key", async (event, key) => {
      return this.environmentManager.saveCustomReasoningKey(key);
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
        pickEnterpriseConfig,
        validateEnterpriseEndpoint,
      } = require("./enterpriseProviderErrors");
      try {
        validateEnterpriseEndpoint(config.azureEndpoint);

        const { generateText } = require("ai");
        const { getEnterpriseAIModel } = require("./enterpriseAiProviders");

        const model = getEnterpriseAIModel(
          provider,
          config.model || "test",
          config.apiKey || "",
          pickEnterpriseConfig(config)
        );

        await generateText({
          model,
          prompt: "Say hello in one word.",
          maxOutputTokens: 10,
        });

        return { success: true };
      } catch (err) {
        const mapped = mapEnterpriseError(provider, err, config);
        return {
          success: false,
          error: mapped.message,
          action: mapped.action,
          copyCommand: mapped.copyCommand,
          retryable: mapped.retryable,
        };
      }
    });

    ipcMain.handle(
      "process-enterprise-reasoning",
      async (event, text, modelId, _agentName, config) => {
        const {
          isEnterpriseProvider,
          mapEnterpriseError,
          pickEnterpriseConfig,
          validateEnterpriseEndpoint,
        } = require("./enterpriseProviderErrors");
        const provider = config?.provider;
        try {
          if (!isEnterpriseProvider(provider)) {
            throw new Error(`Unsupported enterprise provider: ${provider}`);
          }
          if (!modelId) {
            throw new Error("No model specified for enterprise reasoning");
          }

          validateEnterpriseEndpoint(config?.azureEndpoint);

          const { generateText } = require("ai");
          const { getEnterpriseAIModel } = require("./enterpriseAiProviders");

          const model = getEnterpriseAIModel(
            provider,
            modelId,
            config.apiKey || "",
            pickEnterpriseConfig(config)
          );

          const timeoutMs = config?.timeoutMs || 60000;
          // Opus 4.7 / GPT-5 / o-series dropped `temperature`; renderer
          // derives support from the model registry and we honor that here.
          const useTemperature = config?.supportsTemperature !== false;
          const { text: generated } = await generateText({
            model,
            system: config?.systemPrompt || "",
            prompt: text,
            maxOutputTokens: config?.maxTokens || 4096,
            ...(useTemperature ? { temperature: config?.temperature ?? 0.3 } : {}),
            abortSignal: AbortSignal.timeout(timeoutMs),
          });

          return { success: true, text: (generated || "").trim() };
        } catch (err) {
          debugLogger.error("Enterprise reasoning error:", err);
          const mapped = mapEnterpriseError(provider, err, config || {});
          return { success: false, error: mapped.message, retryable: mapped.retryable };
        }
      }
    );

    ipcMain.handle("get-dictation-key", async () => {
      return this.environmentManager.getDictationKey();
    });

    ipcMain.handle("save-dictation-key", async (event, key) => {
      return this.environmentManager.saveDictationKey(key);
    });

    ipcMain.handle("get-active-dictation-key", async () => {
      return this.windowManager?.hotkeyManager?.currentHotkey ?? null;
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

    ipcMain.handle("save-anthropic-key", async (event, key) => {
      return this.environmentManager.saveAnthropicKey(key);
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
        if (prefs.localTranscriptionProvider === "nvidia") {
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

      if (prefs.reasoningProvider === "local" && prefs.reasoningModel) {
        setVars.REASONING_PROVIDER = "local";
        setVars.LOCAL_REASONING_MODEL = prefs.reasoningModel;
      } else if (prefs.reasoningProvider && prefs.reasoningProvider !== "local") {
        clearVars.push("REASONING_PROVIDER", "LOCAL_REASONING_MODEL");
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

          const requestBody = {
            model: modelId,
            messages: [{ role: "user", content: userPrompt }],
            system: systemPrompt,
            max_tokens: config?.maxTokens || Math.max(100, Math.min(text.length * 2, 4096)),
            temperature: config?.temperature || 0.3,
          };

          const response = await fetch("https://api.anthropic.com/v1/messages", {
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
          return { success: true, text: data.content[0].text.trim() };
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

        await modelManager.serverManager.start(modelPath, { threads: 4 });
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
          const modelManager = require("./modelManagerBridge").default;
          modelManager.serverManager.cachedServerBinaryPaths = null;
          await this.environmentManager.saveAllKeysToEnvFile().catch(() => {});
          // Restart llama server so it picks up the Vulkan binary
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
      },
      win32: {
        microphone: "ms-settings:privacy-microphone",
        sound: "ms-settings:sound",
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
    ipcMain.handle("open-accessibility-settings", () => openSystemSettings("accessibility"));
    ipcMain.handle("open-system-audio-settings", () => openSystemSettings("systemAudio"));

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
        supportsNativeCapture: false,
        portalVersion: null,
        error: error.message,
      }));
      const supportsPersistentGrant = !!capability?.supportsPersistentGrant;
      const supportsPersistentPortalGrant = !!capability?.supportsPersistentPortalGrant;
      const supportsNativeCapture = !!capability?.supportsNativeCapture;
      const restoreTokenAvailable =
        supportsPersistentGrant && !!this.linuxPortalAudioManager?.hasStoredRestoreToken();
      const helperError =
        typeof capability?.error === "string" &&
        !capability.error.includes("helper binary not found")
          ? capability.error
          : undefined;

      return buildSystemAudioAccess({
        granted: restoreTokenAvailable,
        status: supportsPersistentGrant
          ? restoreTokenAvailable
            ? "granted"
            : "not-determined"
          : "unknown",
        mode: "portal",
        supportsPersistentGrant,
        supportsPersistentPortalGrant,
        supportsNativeCapture,
        supportsOnboardingGrant: supportsPersistentGrant,
        requiresRuntimeSharePrompt: !supportsPersistentGrant || !restoreTokenAvailable,
        strategy: supportsPersistentGrant ? "portal-helper" : "browser-portal",
        restoreTokenAvailable,
        portalVersion: capability?.portalVersion ?? null,
        error: helperError,
      });
    };

    const getSystemAudioAccess = async () => {
      if (process.platform === "win32") {
        return buildSystemAudioAccess({
          granted: true,
          status: "granted",
          mode: "loopback",
          strategy: "loopback",
        });
      }

      if (process.platform === "linux") {
        return getLinuxSystemAudioAccess();
      }

      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      const result = await this.audioTapManager.verifyAccess();
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
        return buildSystemAudioAccess({
          granted: true,
          status: "granted",
          mode: "loopback",
          strategy: "loopback",
        });
      }

      if (process.platform === "linux") {
        const currentAccess = await getLinuxSystemAudioAccess();
        if (!currentAccess.supportsOnboardingGrant) {
          return currentAccess;
        }

        try {
          await this.linuxPortalAudioManager?.requestAccess();
        } catch (error) {
          debugLogger.warn(
            "Linux system audio persistent grant failed",
            { error: error.message },
            "meeting"
          );
        }

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

    // Auth: clear all session cookies for sign-out.
    // This clears every cookie in the renderer session rather than targeting
    // individual auth cookies, which is acceptable because the app only sets
    // cookies for Neon Auth. Avoids CSRF/Origin header issues that occur when
    // the renderer tries to call the server-side sign-out endpoint directly.
    ipcMain.handle("auth-clear-session", async (event) => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
          await win.webContents.session.clearStorageData({ storages: ["cookies"] });
        }
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to clear auth session:", error);
        return { success: false, error: error.message };
      }
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
      process.env.NEON_AUTH_URL ||
      process.env.VITE_NEON_AUTH_URL ||
      runtimeEnv.VITE_NEON_AUTH_URL ||
      "";

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

    ipcMain.handle("cloud-transcribe", async (event, audioBuffer, opts = {}) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const audioData = Buffer.from(audioBuffer);
        const multipartFields = {
          language: opts.language,
          prompt: opts.prompt,
          sendLogs: opts.sendLogs,
          clientType: "desktop",
          appVersion: app.getVersion(),
          clientVersion: app.getVersion(),
          sessionId: this.sessionId,
        };

        debugLogger.debug("Cloud transcribe request", { audioSize: audioData.length }, "cloud-api");

        if (audioData.length > CLOUD_INLINE_LIMIT) {
          const { text, responses, lastResponse } = await chunkedCloudTranscribe({
            buffer: audioData,
            apiUrl,
            cookieHeader,
            multipartFields,
          });
          const sum = (field) => responses.reduce((s, r) => s + (r?.[field] || 0), 0);
          return {
            success: true,
            text,
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
        const data = await postMultipart(url, body, boundary, { Cookie: cookieHeader });

        debugLogger.debug(
          "Cloud transcribe response",
          { statusCode: data.statusCode },
          "cloud-api"
        );

        const result = interpretTranscribeResponse(data);
        return {
          success: true,
          text: result.text,
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
        debugLogger.error("Cloud transcription error", { error: error.message }, "cloud-api");
        if (error.code) {
          return { success: false, error: error.message, code: error.code, ...error };
        }
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("retry-transcription", async (event, id, settings) => {
      const buffer = this.audioStorageManager.getAudioBuffer(id);
      if (!buffer) return { success: false, error: "Audio file not found" };
      try {
        let result;

        if (settings?.useLocalWhisper) {
          if (settings.localTranscriptionProvider === "nvidia") {
            const model =
              settings.parakeetModel || process.env.PARAKEET_MODEL || "parakeet-tdt-0.6b-v3";
            result = await this.parakeetManager.transcribeLocalParakeet(buffer, { model });
          } else if (this.whisperManager?.serverManager?.isAvailable?.()) {
            result = await this.whisperManager.transcribeLocalWhisper(buffer, {
              model: settings.whisperModel,
            });
          }
        } else if (settings?.cloudTranscriptionMode === "openwhispr") {
          const win = BrowserWindow.fromWebContents(event.sender);
          if (win) {
            const cookieHeader = await getSessionCookiesFromWindow(win);
            if (cookieHeader) {
              const apiUrl = getApiUrl();
              if (apiUrl) {
                const multipartFields = {
                  clientType: "desktop",
                  appVersion: app.getVersion(),
                  sessionId: this.sessionId,
                };
                if (buffer.length > CLOUD_INLINE_LIMIT) {
                  const { text } = await chunkedCloudTranscribe({
                    buffer,
                    apiUrl,
                    cookieHeader,
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
                  const data = await postMultipart(url, body, boundary, {
                    Cookie: cookieHeader,
                  });
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
        } else {
          const provider = settings?.cloudTranscriptionProvider || "openai";
          const model = this._resolveByokModel(provider, settings?.cloudTranscriptionModel);

          let apiKey, endpoint;
          if (provider === "groq") {
            apiKey = this.environmentManager.getGroqKey();
            endpoint = "https://api.groq.com/openai/v1/audio/transcriptions";
          } else if (provider === "mistral") {
            apiKey = this.environmentManager.getMistralKey();
            endpoint = MISTRAL_TRANSCRIPTION_URL;
          } else if (provider === "custom") {
            apiKey = this.environmentManager.getCustomTranscriptionKey();
            const base = (settings?.cloudTranscriptionBaseUrl || "").trim();
            endpoint = base
              ? /\/audio\/(transcriptions|translations)$/i.test(base)
                ? base
                : `${base}/audio/transcriptions`
              : "https://api.openai.com/v1/audio/transcriptions";
          } else {
            apiKey = this.environmentManager.getOpenAIKey();
            endpoint = "https://api.openai.com/v1/audio/transcriptions";
          }
          if (!apiKey && provider !== "custom") {
            throw new Error(`${provider} API key not configured`);
          }

          const formData = new FormData();
          formData.append("file", new Blob([buffer], { type: "audio/webm" }), "audio.webm");
          formData.append("model", model);
          const headers = {};
          if (provider === "mistral") {
            headers["x-api-key"] = apiKey;
          } else if (apiKey) {
            headers.Authorization = `Bearer ${apiKey}`;
          }

          const response = await fetch(endpoint, { method: "POST", headers, body: formData });
          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${provider} API Error: ${response.status} ${errorText}`);
          }
          const data = await response.json();
          if (data?.text) {
            result = { text: data.text, source: provider, model };
          }
        }

        if (!result?.text) {
          return { success: false, error: "No transcription engine available" };
        }

        this.databaseManager.updateTranscriptionText(id, result.text, result.text);
        this.databaseManager.updateTranscriptionStatus(id, "completed");
        const providerName = result.source || "local";
        const modelName = result.model || null;
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 1,
          audioDurationMs: null,
          provider: providerName,
          model: modelName,
        });
        const updated = this.databaseManager.getTranscriptionById(id);
        if (updated) {
          setImmediate(() => {
            this.broadcastToWindows("transcription-updated", updated);
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
    const LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS = 4500;

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

    const shouldSkipDuplicateMicSegment = (text, timestamp, suppression = null) => {
      if (suppression?.likelyRenderBleed || suppression?.hasBleedEvidence) {
        if (hasNearbyTranscriptMatch("system", text, timestamp)) {
          return true;
        }
      }

      if (suppression?.reason === "double_talk") {
        return hasNearbyTranscriptMatch("system", text, timestamp, { relaxed: true });
      }

      return false;
    };

    const isWithinMeetingStartupWarmup = () =>
      meetingStartedAt != null && Date.now() - meetingStartedAt < MEETING_STARTUP_WARMUP_MS;

    const hasRiskyMicDuplicateProfile = (suppression = null) => {
      if (isWithinMeetingStartupWarmup()) {
        return true;
      }
      if (suppression?.systemSpeaking) {
        return true;
      }
      return (
        !!suppression &&
        (suppression.reason === "double_talk" ||
          suppression.hasBleedEvidence ||
          suppression.likelyRenderBleed)
      );
    };

    const removeRacingMicEntriesFor = (systemText, systemTimestamp) => {
      const removed = [];
      for (let i = meetingDiarizationSegments.length - 1; i >= 0; i -= 1) {
        const candidate = meetingDiarizationSegments[i];
        if (candidate.source !== "mic" || candidate.timestamp == null) continue;
        if (systemTimestamp != null && Math.abs(candidate.timestamp - systemTimestamp) > 4000) {
          if (candidate.timestamp < systemTimestamp) break;
          continue;
        }
        const hasMicDuplicateRisk =
          candidate.likelyRenderBleed ||
          candidate.hasBleedEvidence ||
          candidate.suppressionReason === "double_talk";
        const overlapsSystem = hasNearbyTranscriptMatch(
          "system",
          candidate.text,
          candidate.timestamp,
          {
            extraSegment: {
              text: systemText,
              timestamp: systemTimestamp,
            },
            relaxed: candidate.suppressionReason === "double_talk",
          }
        );
        if (hasMicDuplicateRisk && overlapsSystem) {
          meetingDiarizationSegments.splice(i, 1);
          removed.push(candidate);
        }
      }
      return removed;
    };

    const appendMeetingLocalTranscript = (text) => {
      if (!text) return;
      meetingLocalTranscript += `${meetingLocalTranscript ? " " : ""}${text}`;
    };

    const storeMeetingDiarizationSegment = (text, source, timestamp, micSuppression = null) => {
      meetingDiarizationSegments.push({
        text,
        source,
        timestamp,
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

      const ready = [];
      const deferred = [];
      const now = Date.now();

      for (const pending of meetingPendingMicFinals) {
        if (!force && pending.releaseAt > now) {
          deferred.push(pending);
          continue;
        }

        if (
          shouldSkipDuplicateMicSegment(pending.text, pending.timestamp, pending.micSuppression)
        ) {
          debugLogger.debug(
            "Dropping buffered mic segment after system context confirmed duplicate",
            {
              text: pending.text.slice(0, 80),
              averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
              averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
            }
          );
          continue;
        }

        ready.push(pending);
      }

      meetingPendingMicFinals = deferred;
      schedulePendingMicFinalFlush();

      for (const pending of ready) {
        debugLogger.debug("Releasing buffered mic segment after duplicate holdback", {
          text: pending.text.slice(0, 80),
          holdbackMs: pending.holdbackMs,
          averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
          averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
        });
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
      const removed = [];
      meetingPendingMicFinals = meetingPendingMicFinals.filter((candidate) => {
        const overlapsSystem = hasNearbyTranscriptMatch(
          "system",
          candidate.text,
          candidate.timestamp,
          {
            extraSegment: {
              text: systemText,
              timestamp: systemTimestamp,
            },
            relaxed: candidate.micSuppression?.reason === "double_talk",
          }
        );
        if (!overlapsSystem) {
          return true;
        }
        removed.push(candidate);
        return false;
      });
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
      const diarizationPcmPath = meetingDiarizationPath;
      const diarizationSegments = meetingDiarizationSegments;
      const diarizationStartedAt = meetingDiarizationStartedAt;
      if (meetingDiarizationStream) {
        await new Promise((resolve) => meetingDiarizationStream.end(resolve));
        meetingDiarizationStream = null;
      }
      meetingDiarizationPath = null;
      meetingDiarizationStartedAt = null;
      meetingDiarizationSegments = [];
      return { diarizationPcmPath, diarizationSegments, diarizationStartedAt };
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
    };

    const fetchRealtimeToken = async (event, options, { streams } = {}) => {
      const postServerToken = async (path, body = {}) => {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");
        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");
        const response = await fetch(`${apiUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieHeader },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error || `Token request failed: ${response.status}`);
        }
        return response.json();
      };

      const dual = (factory) => (streams === 2 ? Promise.all([factory(), factory()]) : factory());

      if (options.provider === "assemblyai-realtime") {
        if (options.mode === "byok") {
          const apiKey = this.environmentManager.getAssemblyAIKey();
          if (!apiKey) {
            throw new Error("No AssemblyAI API key configured. Add your key in Settings.");
          }
          return dual(async () => {
            const response = await fetch(
              "https://streaming.assemblyai.com/v3/token?expires_in_seconds=60",
              { headers: { Authorization: apiKey } }
            );
            if (!response.ok) {
              const err = await response.json().catch(() => ({}));
              throw new Error(err.error || `AssemblyAI token request failed: ${response.status}`);
            }
            const data = await response.json();
            if (!data.token) throw new Error("No AssemblyAI token received");
            return data.token;
          });
        }
        return dual(async () => {
          const data = await postServerToken("/api/streaming-token");
          if (!data.token) throw new Error("No AssemblyAI token received");
          return data.token;
        });
      }

      if (options.provider === "deepgram-realtime") {
        if (options.mode === "byok") {
          const apiKey = this.environmentManager.getDeepgramKey();
          if (!apiKey) {
            throw new Error("No Deepgram API key configured. Add your key in Settings.");
          }
          return streams === 2 ? [apiKey, apiKey] : apiKey;
        }
        return dual(async () => {
          const data = await postServerToken("/api/deepgram-streaming-token");
          if (!data.token) throw new Error("No Deepgram token received");
          return data.token;
        });
      }

      if (options.mode === "byok") {
        const apiKey = this.environmentManager.getOpenAIKey();
        if (!apiKey) throw new Error("No OpenAI API key configured. Add your key in Settings.");
        return streams === 2 ? [apiKey, apiKey] : apiKey;
      }

      const data = await postServerToken("/api/openai-realtime-token", {
        model: options.model,
        language: options.language,
        streams: streams || 1,
      });
      if (streams === 2) {
        if (!data.clientSecrets || data.clientSecrets.length < 2) {
          throw new Error("Expected two client secrets for dual-stream");
        }
        return data.clientSecrets;
      }
      if (!data.clientSecret) throw new Error("No client secret received");
      return data.clientSecret;
    };

    const getMeetingSystemAudioCapabilityMode = () => {
      if (this.audioTapManager?.isSupported()) return "native";
      if (process.platform === "win32") return "loopback";
      if (process.platform === "linux") return "portal";
      return "unsupported";
    };

    const getMeetingSystemAudioMode = () => getMeetingSystemAudioCapabilityMode();

    const getMeetingSystemAudioPlan = async () => {
      const mode = getMeetingSystemAudioMode();
      if (mode === "unsupported") {
        return { mode, strategy: "unsupported" };
      }

      if (mode === "native") {
        return { mode, strategy: "native" };
      }

      if (mode === "loopback") {
        return { mode, strategy: "loopback" };
      }

      const linuxAccess = await getLinuxSystemAudioAccess();
      return {
        mode,
        strategy: linuxAccess.strategy === "portal-helper" ? "portal-helper" : "browser-portal",
      };
    };

    const hasNativeMeetingSystemAudio = () => getMeetingSystemAudioMode() === "native";

    const isMeetingStreamingConnected = (systemAudioMode = getMeetingSystemAudioCapabilityMode()) =>
      !!this._meetingMicStreaming?.isConnected &&
      (systemAudioMode === "unsupported" || !!this._meetingSystemStreaming?.isConnected);

    const connectRealtimeStreaming = async (event, options) => {
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

      const StreamingClass =
        STREAMING_CLIENT_BY_PROVIDER[options.provider] ?? OpenAIRealtimeStreaming;
      for (const { ref, source } of pairs) {
        this[ref] = new StreamingClass();
        attachMeetingStreamingHandlers(this[ref], win, source);
      }

      await Promise.all(
        pairs.map(({ ref, secret }) =>
          this[ref].connect({ apiKey: secret, token: secret, ...connectOpts })
        )
      );

      return win;
    };

    const MEETING_MIC_REFERENCE_ALIGNMENT_MS = 320;
    const MEETING_STARTUP_WARMUP_MS = 1500;
    const MEETING_MIC_BLEED_RMS_CEILING = 0.01;
    const MEETING_MIC_BLEED_PEAK_CEILING_STREAMING = 0.06;
    const MEETING_MIC_BLEED_PEAK_CEILING_BATCH = 0.025;
    const MEETING_MIC_BLEED_LOOKBACK_MS = 500;
    let meetingStartedAt = null;
    let meetingSendCounts = { mic: 0, system: 0 };
    const meetingEchoLeakDetector = new MeetingEchoLeakDetector();

    const fs = require("fs");
    let meetingDiarizationStream = null;
    let meetingDiarizationPath = null;
    let meetingDiarizationStartedAt = null;
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
    let meetingLocalTranscribing = false;
    let meetingPendingMicChunks = [];
    let meetingPendingMicFinals = [];
    let meetingPendingMicFinalTimer = null;
    let meetingAecEnabled = false;
    let meetingOneOnOneAttendee = null;
    let meetingOneOnOneProfileBound = false;
    let meetingNoteId = null;

    const getLiveSpeakerProfiles = () => this.databaseManager.getSpeakerProfiles(true);
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
      return count ? Math.min(count, MAX_SPEAKER_COUNT) : DEFAULT_EXPECTED_SPEAKER_COUNT;
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
        const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length >> 1);
        let sumSq = 0;
        let peak = 0;
        for (let i = 0; i < samples.length; i++) {
          const n = samples[i] / 0x7fff;
          sumSq += n * n;
          const abs = n < 0 ? -n : n;
          if (abs > peak) peak = abs;
        }
        const rms = Math.sqrt(sumSq / samples.length);
        if (rms < 0.0015 && peak < 0.05) {
          outbound = Buffer.alloc(buffer.length);
        } else if (
          rms < MEETING_MIC_BLEED_RMS_CEILING &&
          peak < MEETING_MIC_BLEED_PEAK_CEILING_STREAMING &&
          meetingEchoLeakDetector.isSystemSpeaking(Date.now() - MEETING_MIC_BLEED_LOOKBACK_MS)
        ) {
          outbound = Buffer.alloc(buffer.length);
        }
      }

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

      if (systemAudioMode !== "native" || !liveSpeakerIdentifier.isAvailable()) {
        return false;
      }

      const diarizationEnabled = resolveDiarizationEnabled();
      if (!diarizationEnabled) {
        return false;
      }

      meetingLiveSpeakerState = null;
      meetingLiveSpeakerStartedAt = Date.now();
      const started = await liveSpeakerIdentifier.start(
        (identification) => {
          if (!win || win.isDestroyed()) {
            return;
          }

          bindOneOnOneAttendeeToSpeaker(identification.speakerId);

          const displayName = meetingOneOnOneAttendee
            ? meetingOneOnOneAttendee.displayName
            : identification.displayName;

          const startTime = Math.max(
            meetingLiveSpeakerStartedAt || 0,
            (meetingLiveSpeakerStartedAt || 0) + identification.startTime * 1000
          );
          const endTime = Math.max(
            startTime,
            (meetingLiveSpeakerStartedAt || 0) + identification.endTime * 1000
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
      );

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

      const samples = new Int16Array(pcm16k.buffer, pcm16k.byteOffset, pcm16k.length / 2);
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < samples.length; i++) {
        const n = samples[i] / 0x7fff;
        sumSq += n * n;
        const abs = n < 0 ? -n : n;
        if (abs > peak) peak = abs;
      }
      const rms = Math.sqrt(sumSq / samples.length);
      if (rms < 0.0015 && peak < 0.05) {
        debugLogger.debug("Skipping silent meeting chunk", {
          source,
          rms: rms.toFixed(4),
          peak: peak.toFixed(4),
        });
        return;
      }

      if (
        source === "mic" &&
        rms < MEETING_MIC_BLEED_RMS_CEILING &&
        peak < MEETING_MIC_BLEED_PEAK_CEILING_BATCH &&
        meetingEchoLeakDetector.isSystemSpeaking(Date.now() - 5000)
      ) {
        debugLogger.debug("Skipping system-dominant mic chunk", {
          source,
          rms: rms.toFixed(4),
          peak: peak.toFixed(4),
        });
        return;
      }

      const wav = pcm16ToWav(pcm16k);

      try {
        let result;
        if (meetingLocalProvider === "nvidia") {
          result = await this.parakeetManager.transcribeLocalParakeet(wav, {
            model: meetingLocalModel,
          });
        } else {
          result = await this.whisperManager.transcribeLocalWhisper(wav, {
            model: meetingLocalModel,
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
      meetingDiarizationSegments = [];
      meetingLocalWin = null;
      meetingLocalTranscript = "";
      meetingLocalProvider = null;
      meetingLocalModel = null;
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
    let dictationPreviewSessionActive = false;
    let dictationPreviewChunkCount = 0;

    const resetDictationPreviewState = ({ preserveSession = false } = {}) => {
      if (dictationPreviewTimer) {
        clearInterval(dictationPreviewTimer);
        dictationPreviewTimer = null;
      }
      dictationPreviewMode = false;
      if (!preserveSession) {
        dictationPreviewSessionActive = false;
      }
      dictationPreviewBuffer = [];
      dictationPreviewTranscribing = false;
      dictationPreviewProvider = null;
      dictationPreviewModel = null;
    };

    const transcribeDictationPreviewChunk = async () => {
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
        if (dictationPreviewProvider === "nvidia") {
          result = await this.parakeetManager.transcribeLocalParakeet(wav, {
            model: dictationPreviewModel,
          });
        } else {
          result = await this.whisperManager.transcribeLocalWhisper(wav, {
            model: dictationPreviewModel,
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

    const rollbackMeetingTranscriptionStart = async () => {
      if (this.audioTapManager) {
        await this.audioTapManager.stop().catch(() => {});
      }
      if (this.linuxPortalAudioManager) {
        await this.linuxPortalAudioManager.stop().catch(() => {});
      }
      await stopMeetingAec();
      await stopLiveSpeakerIdentification().catch(() => {});
      resetMeetingLocalState();
      await disconnectMeetingStreaming().catch(() => {});
    };

    const setupDictationCallbacks = (streaming, event) => {
      streaming.onPartialTranscript = (text) =>
        event.sender.send("dictation-realtime-partial", text);
      streaming.onFinalTranscript = (text) => event.sender.send("dictation-realtime-final", text);
      streaming.onError = (err) => event.sender.send("dictation-realtime-error", err.message);
      streaming.onSessionEnd = (data) =>
        event.sender.send("dictation-realtime-session-end", data || {});
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
      if (this._dictationConnectPromise) {
        await this._dictationConnectPromise.catch(() => {});
      }

      clearDictationIdleTimer();

      if (this._dictationStreaming) {
        await this._dictationStreaming.disconnect().catch(() => {});
        this._dictationStreaming = null;
      }

      const connectInner = async () => {
        const isCloud = options.mode !== "byok";
        const apiKey = await fetchRealtimeToken(event, { mode: options.mode });
        const streaming = new OpenAIRealtimeStreaming();
        setupDictationCallbacks(streaming, event);
        await streaming.connect({
          apiKey,
          model: options.model || "gpt-4o-mini-transcribe",
          preconfigured: isCloud,
        });
        this._dictationStreaming = streaming;
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

      if (isMeetingStreamingConnected(systemAudioMode)) {
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
          return { success: false, error: error.message };
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

    ipcMain.handle("meeting-transcription-start", async (event, options = {}) => {
      // Wait for any in-flight prepare to finish before starting
      if (meetingTranscriptionPreparePromise) {
        debugLogger.debug("Meeting transcription start: waiting for in-flight prepare");
        await meetingTranscriptionPreparePromise;
      }

      if (meetingTranscriptionStartInProgress) {
        debugLogger.debug("Meeting transcription start already in progress, ignoring");
        return { success: false, error: "Operation in progress" };
      }

      meetingTranscriptionStartInProgress = true;
      meetingStartedAt = Date.now();
      this.meetingDetectionEngine?.setUserRecording(true);
      try {
        const systemAudioPlan = await getMeetingSystemAudioPlan();
        let { mode: systemAudioMode, strategy: systemAudioStrategy } = systemAudioPlan;
        meetingEchoLeakDetector.reset();
        meetingOneOnOneAttendee = resolveOneOnOneAttendeeForNote(options.noteId);
        meetingOneOnOneProfileBound = false;
        meetingNoteId = options.noteId ?? null;

        if (systemAudioMode === "unsupported" && this._meetingSystemStreaming?.isConnected) {
          await this._meetingSystemStreaming.disconnect().catch(() => ({ text: "" }));
          this._meetingSystemStreaming = null;
        }

        // If already prepared (warm connections from prepare), just re-attach handlers
        if (!meetingLocalMode && isMeetingStreamingConnected(systemAudioMode)) {
          debugLogger.debug("Meeting transcription start: reusing warm connections");
          const win = BrowserWindow.fromWebContents(event.sender);
          attachMeetingStreamingHandlers(this._meetingMicStreaming, win, "mic");
          if (systemAudioMode !== "unsupported") {
            attachMeetingStreamingHandlers(this._meetingSystemStreaming, win, "system");
          }
          await startMeetingAec(systemAudioMode);
          await startLiveSpeakerIdentification(win, systemAudioMode);
          systemAudioStrategy = await startMeetingSystemAudio(
            event,
            systemAudioMode,
            systemAudioStrategy,
            "during warm-start reuse"
          );
          return {
            success: true,
            systemAudioMode,
            systemAudioStrategy,
            oneOnOneAttendee: meetingOneOnOneAttendee,
          };
        }

        if (options.provider === "local") {
          meetingLocalMode = true;
          meetingLocalProvider = options.localProvider || "whisper";
          meetingLocalModel = options.localModel || null;
          meetingLocalWin = BrowserWindow.fromWebContents(event.sender);
          meetingLocalBuffers = { mic: [], system: [] };
          meetingLocalTranscript = "";

          await startLiveSpeakerIdentification(meetingLocalWin, systemAudioMode);
          await startMeetingAec(systemAudioMode);

          meetingLocalTimer = setInterval(() => {
            transcribeAllLocalBuffers();
          }, 5000);

          systemAudioStrategy = await startMeetingSystemAudio(
            event,
            systemAudioMode,
            systemAudioStrategy,
            "in local meeting mode"
          );

          debugLogger.debug("Meeting transcription started in local mode", {
            provider: meetingLocalProvider,
            systemAudioMode,
            systemAudioStrategy,
          });

          return {
            success: true,
            systemAudioMode,
            systemAudioStrategy,
            oneOnOneAttendee: meetingOneOnOneAttendee,
          };
        }

        if (!ALLOWED_MEETING_PROVIDERS.has(options.provider)) {
          return { success: false, error: `Unsupported provider: ${options.provider}` };
        }

        await connectRealtimeStreaming(event, options);
        const realtimeWin = BrowserWindow.fromWebContents(event.sender);
        await startLiveSpeakerIdentification(realtimeWin, systemAudioMode);
        await startMeetingAec(systemAudioMode);
        systemAudioStrategy = await startMeetingSystemAudio(
          event,
          systemAudioMode,
          systemAudioStrategy,
          "in realtime mode"
        );
        return {
          success: true,
          systemAudioMode,
          systemAudioStrategy,
          oneOnOneAttendee: meetingOneOnOneAttendee,
        };
      } catch (error) {
        await rollbackMeetingTranscriptionStart();
        this.meetingDetectionEngine?.setUserRecording(false);
        debugLogger.error("Meeting transcription start error", { error: error.message });
        return { success: false, error: error.message };
      } finally {
        meetingTranscriptionStartInProgress = false;
      }
    });

    const sendMeetingAudio = (audioBuffer, source) => {
      const outboundBuffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);

      if (source === "system") {
        const receivedAt = Date.now();
        meetingEchoLeakDetector.recordSystemChunk(outboundBuffer, receivedAt);
        if (meetingAecEnabled && !this.meetingAecManager?.processSystemBuffer(outboundBuffer)) {
          meetingAecEnabled = false;
        }
        flushPendingMeetingMicChunks();

        if (meetingLiveSpeakerActive) {
          void liveSpeakerIdentifier.feedAudio(outboundBuffer);
        }

        if (!meetingDiarizationStream) {
          const os = require("os");
          meetingDiarizationPath = path.join(os.tmpdir(), `ow-diarize-raw-${Date.now()}.pcm`);
          meetingDiarizationStream = fs.createWriteStream(meetingDiarizationPath);
          meetingDiarizationStartedAt = receivedAt;
        }
        meetingDiarizationStream.write(outboundBuffer);
        dispatchMeetingAudioBuffer(outboundBuffer, "system");
        return;
      }

      if (source === "mic") {
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

    const startNativeMeetingSystemAudio = async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      await this.audioTapManager.start({
        onChunk: (chunk) => {
          sendMeetingAudio(chunk, "system");
        },
        onError: (error) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("meeting-transcription-error", error.message);
          }
        },
      });
    };

    const startLinuxMeetingSystemAudio = async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      await this.linuxPortalAudioManager.start({
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
            "Linux portal system audio warning",
            { code: warning.code, message: warning.message },
            "meeting"
          );
        },
      });
    };

    const startMeetingSystemAudio = async (
      event,
      systemAudioMode,
      systemAudioStrategy,
      context
    ) => {
      if (systemAudioMode === "native") {
        await startNativeMeetingSystemAudio(event);
        return systemAudioStrategy;
      }

      if (systemAudioStrategy !== "portal-helper") {
        return systemAudioStrategy;
      }

      try {
        await startLinuxMeetingSystemAudio(event);
        return systemAudioStrategy;
      } catch (error) {
        debugLogger.warn(
          `Linux portal helper failed ${context}, falling back to browser portal`,
          { error: error.message },
          "meeting"
        );
        return "browser-portal";
      }
    };

    ipcMain.on("meeting-transcription-send", (_event, audioBuffer, source) => {
      sendMeetingAudio(audioBuffer, source);
    });

    ipcMain.handle("meeting-transcription-stop", async () => {
      this.meetingDetectionEngine?.setUserRecording(false);
      try {
        if (this.audioTapManager) {
          await this.audioTapManager.stop();
        }
        if (this.linuxPortalAudioManager) {
          await this.linuxPortalAudioManager.stop().catch(() => {});
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
          const { diarizationPcmPath, diarizationSegments, diarizationStartedAt } =
            await captureMeetingDiarizationState();
          const transcript =
            diarizationSegments
              .map((segment) => segment.text)
              .join(" ")
              .trim() || meetingLocalTranscript;
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
            noteIdSnapshot
          );

          return { success: true, transcript, diarizationSessionId };
        }

        const results = await disconnectMeetingStreaming({ flushPending: true });
        const { diarizationPcmPath, diarizationSegments, diarizationStartedAt } =
          await captureMeetingDiarizationState();
        const transcript =
          diarizationSegments
            .map((segment) => segment.text)
            .join(" ")
            .trim() || [results[0]?.text, results[1]?.text].filter(Boolean).join(" ");

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
          noteIdSnapshot
        );

        return { success: true, transcript, diarizationSessionId };
      } catch (error) {
        debugLogger.error("Meeting transcription stop error", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("dictation-realtime-warmup", async (event, options = {}) => {
      try {
        await connectDictationStreaming(event, options);
        startDictationIdleTimer();
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("dictation-realtime-start", async (event, options = {}) => {
      try {
        clearDictationIdleTimer();
        if (!this._dictationStreaming?.isConnected) await connectDictationStreaming(event, options);
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
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
      return { success: true, text: result.text || "" };
    });

    ipcMain.handle("start-dictation-preview", async (_event, { provider, model }) => {
      resetDictationPreviewState();
      dictationPreviewMode = true;
      dictationPreviewSessionActive = true;
      dictationPreviewProvider = provider;
      dictationPreviewModel = model;
      dictationPreviewChunkCount = 0;
      this.windowManager.showTranscriptionPreview("");
      dictationPreviewTimer = setInterval(() => transcribeDictationPreviewChunk(), 1500);
      return { success: true };
    });

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
      dictationPreviewBuffer.push(
        Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer)
      );
    });

    ipcMain.handle("dismiss-dictation-preview", async () => {
      resetDictationPreviewState();
      this.windowManager.hideTranscriptionPreview();
      return { success: true };
    });

    ipcMain.handle("complete-dictation-preview", async (_event, { text } = {}) => {
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
    });

    ipcMain.handle("hide-dictation-preview", async () => {
      resetDictationPreviewState();
      this.windowManager.hideTranscriptionPreview();
      return { success: true };
    });

    ipcMain.handle("resize-transcription-preview-window", async (_event, width, height) => {
      if (!dictationPreviewSessionActive) {
        return { success: false, error: "Preview session not active" };
      }
      return this.windowManager.resizeTranscriptionPreview(width, height);
    });

    ipcMain.handle("stop-dictation-preview", async (_event, options = {}) => {
      if (!dictationPreviewMode && !dictationPreviewSessionActive) {
        return { success: true };
      }
      clearInterval(dictationPreviewTimer);
      dictationPreviewTimer = null;
      await transcribeDictationPreviewChunk();
      resetDictationPreviewState({ preserveSession: true });
      if (!dictationPreviewSessionActive) {
        return { success: true };
      }
      this.windowManager.holdTranscriptionPreview(options);
      return { success: true };
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
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        debugLogger.debug(
          "Cloud reason request",
          {
            model: opts.model || "(default)",
            agentName: opts.agentName || "(none)",
            textLength: text?.length || 0,
          },
          "cloud-api"
        );

        const response = await fetch(`${apiUrl}/api/reason`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookieHeader,
          },
          body: JSON.stringify({
            text,
            model: opts.model,
            agentName: opts.agentName,
            customDictionary: opts.customDictionary,
            customPrompt: opts.customPrompt,
            systemPrompt: opts.systemPrompt,
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
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `API error: ${response.status}`);
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
        };
      } catch (error) {
        debugLogger.error("Cloud reasoning error:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.on("cloud-agent-stream-start", async (event, messages, opts = {}) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const response = await fetch(`${apiUrl}/api/agent/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookieHeader,
          },
          body: JSON.stringify({
            messages,
            systemPrompt: opts.systemPrompt,
            tools: opts.tools,
            sessionId: this.sessionId,
            clientType: "desktop",
            appVersion: app.getVersion(),
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          event.sender.send("cloud-agent-stream-error", {
            error: errorData.error || `API error: ${response.status}`,
            code:
              response.status === 401
                ? "AUTH_EXPIRED"
                : response.status === 503
                  ? "SERVER_ERROR"
                  : undefined,
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
                event.sender.send("cloud-agent-stream-chunk", JSON.parse(line));
              } catch {
                // skip malformed NDJSON line
              }
            }
          }
          if (buffer.trim()) {
            try {
              event.sender.send("cloud-agent-stream-chunk", JSON.parse(buffer));
            } catch {
              // skip malformed remainder
            }
          }
        } finally {
          reader.releaseLock();
        }

        event.sender.send("cloud-agent-stream-end");
      } catch (error) {
        debugLogger.error("Cloud agent stream error:", error);
        event.sender.send("cloud-agent-stream-error", { error: error.message });
      }
    });

    ipcMain.handle("agent-open-note", async (_event, noteId) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        await this.windowManager.createControlPanelWindow();
        this.windowManager.sendToControlPanel("navigate-to-note", {
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

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        debugLogger.debug("Agent web search request", { query, numResults }, "cloud-api");

        const response = await fetch(`${apiUrl}/api/agent/web-search`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookieHeader,
          },
          body: JSON.stringify({ query, numResults }),
        });

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          if (response.status === 503) {
            return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
          }
          const errorData = await response.json().catch(() => ({}));
          return {
            success: false,
            error: errorData.error || `API error: ${response.status}`,
          };
        }

        const data = await response.json();
        return { success: true, ...data };
      } catch (error) {
        debugLogger.error("Agent web search error:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle(
      "cloud-streaming-usage",
      async (event, text, audioDurationSeconds, opts = {}) => {
        try {
          const apiUrl = getApiUrl();
          if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

          const cookieHeader = await getSessionCookies(event);
          if (!cookieHeader) throw new Error("No session cookies available");

          const response = await fetch(`${apiUrl}/api/streaming-usage`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: cookieHeader,
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

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const response = await fetch(`${apiUrl}/api/usage`, {
          headers: { Cookie: cookieHeader },
        });

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          if (response.status === 503) {
            return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
          }
          throw new Error(`API error: ${response.status}`);
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

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const headers = { Cookie: cookieHeader };
        const fetchOpts = { method: "POST", headers };
        if (body) {
          headers["Content-Type"] = "application/json";
          fetchOpts.body = JSON.stringify(body);
        }

        const response = await fetch(`${apiUrl}${endpoint}`, fetchOpts);

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          if (response.status === 503) {
            return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
          }
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `API error: ${response.status}`);
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

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const response = await fetch(`${apiUrl}/api/stripe/switch-plan`, {
          method: "POST",
          headers: { Cookie: cookieHeader, "Content-Type": "application/json" },
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

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const response = await fetch(`${apiUrl}/api/stripe/preview-switch`, {
          method: "POST",
          headers: { Cookie: cookieHeader, "Content-Type": "application/json" },
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

    ipcMain.handle("cloud-api-request", async (event, opts) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const method = (opts.method || "GET").toUpperCase();
        const headers = { Cookie: cookieHeader };
        const fetchOpts = { method, headers };

        if (opts.body !== undefined) {
          headers["Content-Type"] = "application/json";
          fetchOpts.body = JSON.stringify(opts.body);
        }

        const response = await fetch(`${apiUrl}${opts.path}`, fetchOpts);

        if (response.status === 401) {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        if (response.status === 503) {
          return { success: false, error: "Service temporarily unavailable", code: "SERVER_ERROR" };
        }

        const data = await response.json().catch(() => null);

        if (!response.ok) {
          const message = data?.error?.message || data?.error || `API error: ${response.status}`;
          return { success: false, error: message };
        }

        return { success: true, data };
      } catch (error) {
        debugLogger.error(
          `Cloud API request error (${opts?.path}): ${error?.message || error} ${error?.code || ""}`.trim(),
          error?.stack
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-stt-config", async (event) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const response = await fetch(`${apiUrl}/api/stt-config`, {
          headers: { Cookie: cookieHeader },
        });

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          if (response.status === 503) {
            return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
          }
          throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        return { success: true, ...data };
      } catch (error) {
        debugLogger.error("STT config fetch error:", error);
        return null;
      }
    });

    ipcMain.handle("get-note-recording-config", async (event) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const response = await fetch(`${apiUrl}/api/note-recording-config`, {
          headers: { Cookie: cookieHeader },
        });

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        return { success: true, ...data };
      } catch (error) {
        debugLogger.error("Note recording config fetch error:", error);
        return null;
      }
    });

    ipcMain.handle("transcribe-audio-file-cloud", async (event, filePath) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const multipartFields = {
          source: "file_upload",
          clientType: "desktop",
          appVersion: app.getVersion(),
          clientVersion: app.getVersion(),
          sessionId: this.sessionId,
        };

        const fileSize = fs.statSync(filePath).size;

        if (fileSize > CLOUD_INLINE_LIMIT) {
          debugLogger.debug("Large file detected, using client-side chunking", {
            fileSize,
            filePath: path.basename(filePath),
          });
          const { text, warning } = await chunkedCloudTranscribe({
            filePath,
            apiUrl,
            cookieHeader,
            multipartFields,
            onProgress: (payload) => event.sender.send("upload-transcription-progress", payload),
          });
          return { success: true, text, ...(warning ? { warning } : {}) };
        }

        const audioBuffer = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase().replace(".", "");
        const contentType = AUDIO_MIME_TYPES[ext] || "audio/mpeg";
        const fileName = path.basename(filePath);

        const { body, boundary } = buildMultipartBody(
          audioBuffer,
          fileName,
          contentType,
          multipartFields
        );
        const url = new URL(`${apiUrl}/api/transcribe`);
        const data = await postMultipart(url, body, boundary, { Cookie: cookieHeader });
        const result = interpretTranscribeResponse(data);

        return { success: true, text: result.text };
      } catch (error) {
        debugLogger.error("Cloud audio file transcription error", { error: error.message });
        if (error.code) {
          return { success: false, error: error.message, code: error.code, ...error };
        }
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle(
      "transcribe-audio-file-byok",
      async (event, { filePath, apiKey, baseUrl, model }) => {
        const fs = require("fs");
        const BYOK_FILE_SIZE_LIMIT = 25 * 1024 * 1024; // 25 MB
        try {
          if (!apiKey) throw new Error("No API key configured. Add your key in Settings.");
          if (!baseUrl) throw new Error("No transcription endpoint configured.");

          const fileSize = fs.statSync(filePath).size;
          if (fileSize > BYOK_FILE_SIZE_LIMIT) {
            return {
              success: false,
              error: "File too large. Maximum size for bring-your-own-key is 25 MB.",
            };
          }

          const audioBuffer = fs.readFileSync(filePath);
          const ext = path.extname(filePath).toLowerCase().replace(".", "");
          const contentType = AUDIO_MIME_TYPES[ext] || "audio/mpeg";
          const fileName = path.basename(filePath);

          let transcriptionUrl = baseUrl.replace(/\/+$/, "");
          if (!transcriptionUrl.endsWith("/audio/transcriptions")) {
            transcriptionUrl += "/audio/transcriptions";
          }

          const { body, boundary } = buildMultipartBody(audioBuffer, fileName, contentType, {
            model: model || "whisper-1",
          });

          const url = new URL(transcriptionUrl);
          const data = await postMultipart(url, body, boundary, {
            Authorization: `Bearer ${apiKey}`,
          });

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

          return { success: true, text: data.data.text };
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

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) {
          throw new Error("No session cookies available");
        }

        const response = await fetch(`${apiUrl}/api/referrals/stats`, {
          headers: {
            Cookie: cookieHeader,
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

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) {
          throw new Error("No session cookies available");
        }

        const response = await fetch(`${apiUrl}/api/referrals/invite`, {
          method: "POST",
          headers: {
            Cookie: cookieHeader,
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

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) {
          throw new Error("No session cookies available");
        }

        const response = await fetch(`${apiUrl}/api/referrals/invites`, {
          headers: {
            Cookie: cookieHeader,
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
      const { execFileSync } = require("child_process");
      const status = getYdotoolStatus();
      const isKde = (process.env.XDG_CURRENT_DESKTOP || "").toLowerCase().includes("kde");
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
      return { ...status, isKde, hasXclip, hasXsel };
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

      const cookieHeader = await getSessionCookies(event);
      if (!cookieHeader) {
        throw new Error("No session cookies available");
      }

      const tokenResponse = await fetch(`${apiUrl}/api/streaming-token`, {
        method: "POST",
        headers: {
          Cookie: cookieHeader,
        },
      });

      if (!tokenResponse.ok) {
        if (tokenResponse.status === 401) {
          const err = new Error("Session expired");
          err.code = "AUTH_EXPIRED";
          throw err;
        }
        const errorData = await tokenResponse.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Failed to get streaming token: ${tokenResponse.status}`
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
        if (error.code === "AUTH_EXPIRED") {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        return { success: false, error: error.message };
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
        return { success: false, error: error.message };
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

      const cookieHeader = await getSessionCookiesFromWindow(win);
      if (!cookieHeader) throw new Error("No session cookies available");

      const tokenResponse = await fetch(`${apiUrl}/api/deepgram-streaming-token`, {
        method: "POST",
        headers: { Cookie: cookieHeader },
      });

      if (!tokenResponse.ok) {
        if (tokenResponse.status === 401) {
          const err = new Error("Session expired");
          err.code = "AUTH_EXPIRED";
          throw err;
        }
        throw new Error(`Failed to get Deepgram streaming token: ${tokenResponse.status}`);
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

      const cookieHeader = await getSessionCookies(event);
      if (!cookieHeader) {
        throw new Error("No session cookies available");
      }

      const tokenResponse = await fetch(`${apiUrl}/api/deepgram-streaming-token`, {
        method: "POST",
        headers: {
          Cookie: cookieHeader,
        },
      });

      if (!tokenResponse.ok) {
        if (tokenResponse.status === 401) {
          const err = new Error("Session expired");
          err.code = "AUTH_EXPIRED";
          throw err;
        }
        const errorData = await tokenResponse.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Failed to get Deepgram streaming token: ${tokenResponse.status}`
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
        if (error.code === "AUTH_EXPIRED") {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        return { success: false, error: error.message };
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
        return { success: false, error: error.message };
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

    // Agent mode handlers
    ipcMain.handle("update-agent-hotkey", async (_event, hotkey) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const agentCallback = this.windowManager._agentHotkeyCallback;
      if (!agentCallback) {
        return { success: false, message: "Agent hotkey callback not initialized" };
      }

      if (!hotkey) {
        hotkeyManager.unregisterSlot("agent");
        this.environmentManager.saveAgentKey?.("");
        return { success: true, message: "Agent hotkey cleared" };
      }

      const result = await hotkeyManager.registerSlot("agent", hotkey, agentCallback);
      if (result.success) {
        this.environmentManager.saveAgentKey?.(hotkey);
        return { success: true, message: `Agent hotkey updated to: ${hotkey}` };
      }

      return {
        success: false,
        message: result.error || `Failed to update agent hotkey to: ${hotkey}`,
      };
    });

    ipcMain.handle("get-agent-key", async () => {
      return this.environmentManager.getAgentKey?.() || "";
    });

    ipcMain.handle("save-agent-key", async (_event, key) => {
      return this.environmentManager.saveAgentKey?.(key) || { success: true };
    });

    ipcMain.handle("toggle-agent-overlay", async () => {
      this.windowManager.toggleAgentOverlay();
      return { success: true };
    });

    ipcMain.handle("hide-agent-overlay", async () => {
      this.windowManager.hideAgentOverlay();
      return { success: true };
    });

    ipcMain.handle("resize-agent-window", async (_event, width, height) => {
      this.windowManager.resizeAgentWindow(width, height);
      return { success: true };
    });

    ipcMain.handle("get-agent-window-bounds", async () => {
      return this.windowManager.getAgentWindowBounds();
    });

    ipcMain.handle("set-agent-window-bounds", async (_event, x, y, width, height) => {
      this.windowManager.setAgentWindowBounds(x, y, width, height);
      return { success: true };
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

    // Google Calendar
    ipcMain.handle("gcal-start-oauth", async () => {
      try {
        return await this.googleCalendarManager.startOAuth();
      } catch (error) {
        debugLogger.error("Google Calendar OAuth failed", { error: error.message }, "calendar");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-disconnect", async () => {
      try {
        this.googleCalendarManager.disconnect();
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

    ipcMain.handle("meeting-set-speaker-diarization-enabled", async (_event, payload) => {
      try {
        this.speakerDiarizationEnabled = payload?.enabled !== false;
        return { success: true };
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
        this.activeMeetingSpeakerConfig = { enabled, expectedCount };
        liveSpeakerIdentifier.setEnabled(enabled);
        liveSpeakerIdentifier.setMaxSpeakers(expectedCount);
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

    ipcMain.handle("meeting-notification-ready", async () => {
      this.windowManager?.showNotificationWindow();
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
          if (updated) this.broadcastToWindows("note-updated", updated);
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
          this.databaseManager.removeSpeakerMapping(bestEntry.noteId, bestEntry.speakerId);
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

  _resolveSpeakerExpectation({ sessionConfig, noteId, observedSpeakerIds }) {
    if (sessionConfig?.expectedCount) {
      return {
        numSpeakers: Math.min(sessionConfig.expectedCount, MAX_SPEAKER_COUNT),
        cap: null,
      };
    }

    let attendees = [];
    if (noteId) {
      try {
        const note = this.databaseManager.getNote(noteId);
        attendees = parseAttendees(note?.participants);
      } catch (_) {
        attendees = [];
      }
    }
    if (attendees.length >= 2) {
      return {
        numSpeakers: Math.min(attendees.length, MAX_SPEAKER_COUNT),
        cap: null,
      };
    }

    if (observedSpeakerIds.size >= 2) {
      return {
        numSpeakers: Math.min(observedSpeakerIds.size, MAX_SPEAKER_COUNT),
        cap: null,
      };
    }

    return { numSpeakers: -1, cap: DEFAULT_EXPECTED_SPEAKER_COUNT };
  }

  _startOrSkipDiarization(
    sessionId,
    rawPcmPath,
    audioStartedAt,
    transcriptSegments,
    win,
    liveSpeakerState = null,
    sessionConfig = null,
    noteId = null
  ) {
    const send = (payload) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send("meeting-diarization-complete", { sessionId, ...payload });
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
          transcriptSegments.find((segment) => segment.source === "system")?.timestamp ||
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
          diarizationSegments
        );

        const speakerSet = new Set(diarizationSegments.map((d) => d.speaker));
        const speakerRenumber = new Map();
        let sIdx = 0;
        for (const sp of speakerSet) {
          speakerRenumber.set(sp, `speaker_${sIdx}`);
          sIdx++;
        }

        let speakerEmbeddingsMap = null;
        const speakerEmb = require("./speakerEmbeddings");
        try {
          if (speakerEmb.isAvailable() && tmpWav) {
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

  broadcastToWindows(channel, payload) {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    });
  }
}

module.exports = IPCHandlers;
