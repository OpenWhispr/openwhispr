const { ipcMain, app, shell, BrowserWindow } = require("electron");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const AppUtils = require("../utils");
const debugLogger = require("./debugLogger");
const GnomeShortcutManager = require("./gnomeShortcut");
const AssemblyAiStreaming = require("./assemblyAiStreaming");
const { i18nMain, changeLanguage } = require("./i18nMain");
const DeepgramStreaming = require("./deepgramStreaming");
const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");
const SonioxStreaming = require("./sonioxStreaming");
const AudioStorageManager = require("./audioStorage");

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

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this.whisperManager = managers.whisperManager;
    this.parakeetManager = managers.parakeetManager;
    this.windowManager = managers.windowManager;
    this.updateManager = managers.updateManager;
    this.windowsKeyManager = managers.windowsKeyManager;
    this.textEditMonitor = managers.textEditMonitor;
    this.getTrayManager = managers.getTrayManager;
    this.whisperCudaManager = managers.whisperCudaManager;
    this.googleCalendarManager = managers.googleCalendarManager;
    this.meetingDetectionEngine = managers.meetingDetectionEngine;
    this.sessionId = crypto.randomUUID();
    this.assemblyAiStreaming = null;
    this.deepgramStreaming = null;
    this.openaiRealtimeStreaming = null;
    this._dictationStreaming = null;
    this._sonioxStreaming = null;
    this._autoLearnEnabled = true; // Default on, synced from renderer
    this._autoLearnDebounceTimer = null;
    this._autoLearnLatestData = null;
    this._textEditHandler = null;
    this._activeRecordingPipeline = null;
    this.audioStorageManager = new AudioStorageManager();
    this._audioCleanupInterval = null;
    this._setupTextEditMonitor();
    this._setupAudioCleanup();
    this.setupHandlers();

    if (this.whisperManager?.serverManager) {
      this.whisperManager.serverManager.on("cuda-fallback", () => {
        this.broadcastToWindows("cuda-fallback-notification", {});
      });
    }
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

  cleanupAllStreaming() {
    const backends = [
      { name: "deepgram", instance: this.deepgramStreaming },
      { name: "openai-realtime", instance: this.openaiRealtimeStreaming },
      { name: "soniox", instance: this._sonioxStreaming },
      { name: "dictation", instance: this._dictationStreaming },
      { name: "assemblyai", instance: this.assemblyAiStreaming },
    ];
    for (const { name, instance } of backends) {
      if (!instance) continue;
      try {
        if (typeof instance.cleanupAll === "function") {
          instance.cleanupAll();
        } else {
          instance.cleanup();
        }
        debugLogger.debug(`Cleaned up ${name} streaming`);
      } catch (err) {
        debugLogger.debug(`Error cleaning up ${name} streaming`, { error: err.message });
      }
    }
    this.deepgramStreaming = null;
    this.openaiRealtimeStreaming = null;
    this._sonioxStreaming = null;
    this._dictationStreaming = null;
    this.assemblyAiStreaming = null;
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
          setImmediate(() => {
            this.broadcastToWindows("note-added", result.note);
          });
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
        setImmediate(() => {
          this.broadcastToWindows("note-updated", result.note);
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-note", async (event, id) => {
      const result = this.databaseManager.deleteNote(id);
      if (result?.success) {
        setImmediate(() => {
          this.broadcastToWindows("note-deleted", { id });
        });
      }
      return result;
    });

    ipcMain.handle("db-search-notes", async (event, query, limit) => {
      return this.databaseManager.searchNotes(query, limit);
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
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-folder", async (event, id) => {
      const result = this.databaseManager.deleteFolder(id);
      if (result?.success) {
        setImmediate(() => {
          this.broadcastToWindows("folder-deleted", { id });
        });
      }
      return result;
    });

    ipcMain.handle("db-rename-folder", async (event, id, name) => {
      const result = this.databaseManager.renameFolder(id, name);
      if (result?.success && result?.folder) {
        setImmediate(() => {
          this.broadcastToWindows("folder-renamed", result.folder);
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
    ipcMain.handle("db-create-agent-conversation", async (event, title) => {
      return this.databaseManager.createAgentConversation(title);
    });

    ipcMain.handle("db-get-agent-conversations", async (event, limit) => {
      return this.databaseManager.getAgentConversations(limit);
    });

    ipcMain.handle("db-get-agent-conversation", async (event, id) => {
      return this.databaseManager.getAgentConversation(id);
    });

    ipcMain.handle("db-delete-agent-conversation", async (event, id) => {
      return this.databaseManager.deleteAgentConversation(id);
    });

    ipcMain.handle("db-update-agent-conversation-title", async (event, id, title) => {
      return this.databaseManager.updateAgentConversationTitle(id, title);
    });

    ipcMain.handle("db-add-agent-message", async (event, conversationId, role, content) => {
      return this.databaseManager.addAgentMessage(conversationId, role, content);
    });

    ipcMain.handle("db-get-agent-messages", async (event, conversationId) => {
      return this.databaseManager.getAgentMessages(conversationId);
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

    ipcMain.handle("cleanup-app", async (event) => {
      AppUtils.cleanup(this.windowManager.mainWindow);
      return { success: true, message: "Cleanup completed successfully" };
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
        // Entering capture mode - unregister globalShortcut so it doesn't consume key events
        const currentHotkey = hotkeyManager.getCurrentHotkey();
        if (currentHotkey && !usesNativeListener(currentHotkey)) {
          debugLogger.log(
            `[IPC] Unregistering globalShortcut "${currentHotkey}" for hotkey capture mode`
          );
          const { globalShortcut } = require("electron");
          globalShortcut.unregister(currentHotkey);
        }

        // On Windows, stop the Windows key listener
        if (process.platform === "win32" && this.windowsKeyManager) {
          debugLogger.log("[IPC] Stopping Windows key listener for hotkey capture mode");
          this.windowsKeyManager.stop();
        }

        // On GNOME Wayland, unregister the keybinding during capture
        if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager) {
          debugLogger.log("[IPC] Unregistering GNOME keybinding for hotkey capture mode");
          await hotkeyManager.gnomeManager.unregisterKeybinding().catch((err) => {
            debugLogger.warn("[IPC] Failed to unregister GNOME keybinding:", err.message);
          });
        }
      } else {
        // Exiting capture mode - re-register globalShortcut if not already registered
        if (effectiveHotkey && !usesNativeListener(effectiveHotkey)) {
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
            (activationMode === "push" || isModifierOnlyHotkey(effectiveHotkey));
          if (needsListener) {
            debugLogger.log(`[IPC] Restarting Windows key listener for hotkey: ${effectiveHotkey}`);
            this.windowsKeyManager.start(effectiveHotkey);
          }
        }

        // On GNOME Wayland, re-register the keybinding with the effective hotkey
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
      }

      return { success: true };
    });

    ipcMain.handle("get-hotkey-mode-info", async () => {
      return {
        isUsingGnome: this.windowManager.isUsingGnomeHotkeys(),
      };
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

    ipcMain.handle("get-soniox-key", async () => {
      return this.environmentManager.getSonioxKey();
    });

    ipcMain.handle("save-soniox-key", async (event, key) => {
      return this.environmentManager.saveSonioxKey(key);
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

    ipcMain.handle("get-dictation-key", async () => {
      return this.environmentManager.getDictationKey();
    });

    ipcMain.handle("save-dictation-key", async (event, key) => {
      return this.environmentManager.saveDictationKey(key);
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
        screenRecording:
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
    ipcMain.handle("open-screen-recording-settings", () => openSystemSettings("screenRecording"));

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
        return { granted: true };
      }
      const { systemPreferences } = require("electron");
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return { granted };
    });

    ipcMain.handle("check-screen-recording-access", () => {
      if (process.platform !== "darwin") {
        return { granted: true };
      }
      const { systemPreferences } = require("electron");
      const status = systemPreferences.getMediaAccessStatus("screen");
      return { granted: status === "granted" };
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
        const { body, boundary } = buildMultipartBody(audioData, "audio.webm", "audio/webm", {
          language: opts.language,
          prompt: opts.prompt,
          sendLogs: opts.sendLogs,
          clientType: "desktop",
          appVersion: app.getVersion(),
          clientVersion: app.getVersion(),
          sessionId: this.sessionId,
        });

        debugLogger.debug(
          "Cloud transcribe request",
          { audioSize: audioData.length, bodySize: body.length },
          "cloud-api"
        );

        const url = new URL(`${apiUrl}/api/transcribe`);
        const data = await postMultipart(url, body, boundary, { Cookie: cookieHeader });

        debugLogger.debug(
          "Cloud transcribe response",
          { statusCode: data.statusCode },
          "cloud-api"
        );

        if (data.statusCode === 401) {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        if (data.statusCode === 429) {
          return {
            success: false,
            error: "Daily word limit reached",
            code: "LIMIT_REACHED",
            limitReached: true,
            ...data.data,
          };
        }
        if (data.statusCode !== 200) {
          throw new Error(data.data?.error || `API error: ${data.statusCode}`);
        }

        return {
          success: true,
          text: data.data.text,
          wordsUsed: data.data.wordsUsed,
          wordsRemaining: data.data.wordsRemaining,
          plan: data.data.plan,
          limitReached: data.data.limitReached || false,
          sttProvider: data.data.sttProvider,
          sttModel: data.data.sttModel,
          sttProcessingMs: data.data.sttProcessingMs,
          sttWordCount: data.data.sttWordCount,
          sttLanguage: data.data.sttLanguage,
          audioDurationMs: data.data.audioDurationMs,
        };
      } catch (error) {
        debugLogger.error("Cloud transcription error", { error: error.message }, "cloud-api");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-transcribe-chain", async (event, blobUrl, opts = {}) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const response = await fetch(`${apiUrl}/api/transcribe-chain`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookieHeader,
          },
          body: JSON.stringify({
            mediaUrl: blobUrl,
            skipCleanup: opts.skipCleanup ?? false,
            agentName: opts.agentName,
            customDictionary: opts.customDictionary,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || `Chain failed: ${response.status}`);
        }

        fetch(`${apiUrl}/api/delete-audio`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieHeader },
          body: JSON.stringify({ url: blobUrl }),
        }).catch((err) => debugLogger.warn("Blob cleanup failed", { error: err.message }));

        return {
          success: true,
          text: data.text,
          rawText: data.rawText,
          cleanedText: data.cleanedText,
          processingDurationSec: data.processingDurationSec,
          speedupFactor: data.speedupFactor,
        };
      } catch (error) {
        debugLogger.error("Meeting chain transcription error", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("retry-transcription", async (event, id) => {
      const buffer = this.audioStorageManager.getAudioBuffer(id);
      if (!buffer) return { success: false, error: "Audio file not found" };
      try {
        let result;
        // Try local engines first
        if (this.parakeetManager?.serverManager?.isAvailable?.()) {
          result = await this.parakeetManager.transcribeLocalParakeet(buffer, {});
        } else if (this.whisperManager?.serverManager?.isAvailable?.()) {
          result = await this.whisperManager.transcribeLocalWhisper(buffer, {});
        }

        // Fall back to cloud transcription
        if (!result?.text) {
          const win = BrowserWindow.fromWebContents(event.sender);
          if (win) {
            const cookieHeader = await getSessionCookiesFromWindow(win);
            if (cookieHeader) {
              const apiUrl = getApiUrl();
              if (apiUrl) {
                const { body, boundary } = buildMultipartBody(buffer, "audio.webm", "audio/webm", {
                  clientType: "desktop",
                  appVersion: app.getVersion(),
                  sessionId: this.sessionId,
                });
                const url = new URL(`${apiUrl}/api/transcribe`);
                const data = await postMultipart(url, body, boundary, {
                  Cookie: cookieHeader,
                });
                if (data.statusCode === 200 && data.data?.text) {
                  result = { text: data.data.text, source: "openwhispr", model: "cloud" };
                }
              }
            }
          }
        }

        if (!result?.text) {
          return { success: false, error: "No transcription engine available" };
        }

        this.databaseManager.updateTranscriptionText(id, result.text, result.text);
        this.databaseManager.updateTranscriptionStatus(id, "completed");
        const provider = result.source || "local";
        const model = result.model || null;
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 1,
          audioDurationMs: null,
          provider,
          model,
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
          { id, error: error.message },
          "audio-storage"
        );
        return { success: false, error: error.message };
      }
    });

    let meetingTranscriptionStartInProgress = false;
    let meetingTranscriptionPrepareInProgress = false;
    let meetingTranscriptionPreparePromise = null;

    const attachMeetingStreamingHandlers = (streaming, win) => {
      streaming.onPartialTranscript = (text) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-transcription-partial", text);
        }
      };
      streaming.onFinalTranscript = (text) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-transcription-final", text);
        }
      };
      streaming.onError = (error) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-transcription-error", error.message);
        }
      };
    };

    const fetchRealtimeToken = async (event, options) => {
      if (options.mode === "byok") {
        const apiKey = this.environmentManager.getOpenAIKey();
        if (!apiKey) throw new Error("No OpenAI API key configured. Add your key in Settings.");
        return apiKey;
      }

      const apiUrl = getApiUrl();
      if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

      const cookieHeader = await getSessionCookies(event);
      if (!cookieHeader) throw new Error("No session cookies available");

      const tokenResponse = await fetch(`${apiUrl}/api/openai-realtime-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        body: JSON.stringify({ model: options.model, language: options.language }),
      });

      if (!tokenResponse.ok) {
        const err = await tokenResponse.json().catch(() => ({}));
        throw new Error(err.error || `Token request failed: ${tokenResponse.status}`);
      }

      const { clientSecret } = await tokenResponse.json();
      if (!clientSecret) throw new Error("No client secret received");
      return clientSecret;
    };

    const connectRealtimeStreaming = async (event, options) => {
      if (this.openaiRealtimeStreaming?.isConnected) {
        await this.openaiRealtimeStreaming.disconnect();
      }

      const clientSecret = await fetchRealtimeToken(event, options);
      this.openaiRealtimeStreaming = new OpenAIRealtimeStreaming();

      const win = BrowserWindow.fromWebContents(event.sender);
      attachMeetingStreamingHandlers(this.openaiRealtimeStreaming, win);

      await this.openaiRealtimeStreaming.connect({
        apiKey: clientSecret,
        model: options.model,
        language: options.language,
        preconfigured: options.mode !== "byok",
      });

      return win;
    };

    const setupDictationCallbacks = (streaming, event) => {
      streaming.onPartialTranscript = (text) => {
        if (!event.sender.isDestroyed()) event.sender.send("dictation-realtime-partial", text);
      };
      streaming.onFinalTranscript = (text) => {
        if (!event.sender.isDestroyed()) event.sender.send("dictation-realtime-final", text);
      };
      streaming.onError = (err) => {
        if (!event.sender.isDestroyed()) event.sender.send("dictation-realtime-error", err.message);
      };
      streaming.onSessionEnd = (data) => {
        if (!event.sender.isDestroyed()) event.sender.send("dictation-realtime-session-end", data || {});
      };
    };

    const connectDictationStreaming = async (event, options) => {
      if (this._dictationStreaming) {
        await this._dictationStreaming.disconnect().catch(() => {});
        this._dictationStreaming = null;
      }
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

    // Pre-warm: fetch token + connect WebSocket before user hits record
    ipcMain.handle("meeting-transcription-prepare", async (event, options = {}) => {
      if (meetingTranscriptionPrepareInProgress || meetingTranscriptionStartInProgress) {
        debugLogger.debug("Meeting transcription prepare already in progress, ignoring");
        return { success: false, error: "Operation in progress" };
      }

      if (this.openaiRealtimeStreaming?.isConnected) {
        debugLogger.debug("Meeting transcription already prepared (warm connection)");
        return { success: true, alreadyPrepared: true };
      }

      if (options.provider !== "openai-realtime") {
        return { success: false, error: `Unsupported provider: ${options.provider}` };
      }

      meetingTranscriptionPrepareInProgress = true;
      meetingTranscriptionPreparePromise = (async () => {
        try {
          await connectRealtimeStreaming(event, options);
          debugLogger.debug("Meeting transcription prepared (WebSocket warm)");
          return { success: true };
        } catch (error) {
          debugLogger.error("Meeting transcription prepare error", { error: error.message });
          return { success: false, error: error.message };
        } finally {
          meetingTranscriptionPrepareInProgress = false;
          meetingTranscriptionPreparePromise = null;
        }
      })();

      return meetingTranscriptionPreparePromise;
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
      try {
        // If already prepared (warm connection from prepare), just re-attach handlers
        if (this.openaiRealtimeStreaming?.isConnected) {
          debugLogger.debug("Meeting transcription start: reusing warm connection");
          const win = BrowserWindow.fromWebContents(event.sender);
          attachMeetingStreamingHandlers(this.openaiRealtimeStreaming, win);
          return { success: true };
        }

        if (options.provider !== "openai-realtime") {
          return { success: false, error: `Unsupported provider: ${options.provider}` };
        }

        await connectRealtimeStreaming(event, options);
        return { success: true };
      } catch (error) {
        debugLogger.error("Meeting transcription start error", { error: error.message });
        return { success: false, error: error.message };
      } finally {
        meetingTranscriptionStartInProgress = false;
      }
    });

    ipcMain.on("meeting-transcription-send", (_event, audioBuffer) => {
      if (!this.openaiRealtimeStreaming) return;
      this.openaiRealtimeStreaming.sendAudio(Buffer.from(audioBuffer));
    });

    ipcMain.handle("meeting-transcription-stop", async () => {
      try {
        let result = { text: "" };
        if (this.openaiRealtimeStreaming) {
          result = await this.openaiRealtimeStreaming.disconnect();
          this.openaiRealtimeStreaming = null;
        }
        return { success: true, transcript: result?.text || "" };
      } catch (error) {
        debugLogger.error("Meeting transcription stop error", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("dictation-realtime-warmup", async (event, options = {}) => {
      try {
        await connectDictationStreaming(event, options);
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("dictation-realtime-start", async (event, options = {}) => {
      try {
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
      if (!this._dictationStreaming) {
        return { success: true, text: "" };
      }
      const result = await this._dictationStreaming.disconnect().catch(() => ({ text: "" }));
      this._dictationStreaming = null;
      return { success: true, text: result.text || "" };
    });

    // --- Soniox streaming ---
    // Soniox cold-starts fast (~250ms), no warmup needed.
    ipcMain.handle("soniox-streaming-warmup", async () => {
      return { success: true };
    });

    ipcMain.handle("soniox-streaming-start", async (event, options = {}) => {
      try {
        if (!this._sonioxStreaming?.isConnected) {
          const apiKey = options.apiKey || this.environmentManager.getSonioxKey();
          if (!apiKey) {
            return { success: false, error: "Soniox API key not configured", code: "NO_API" };
          }

          // Cold start: create new connection
          this._sonioxStreaming = new SonioxStreaming();
          this._sonioxStreaming.onPartialTranscript = (text) => {
            if (!event.sender.isDestroyed()) event.sender.send("soniox-streaming-partial", text);
          };
          this._sonioxStreaming.onFinalTranscript = (text) => {
            if (!event.sender.isDestroyed()) event.sender.send("soniox-streaming-final", text);
          };
          this._sonioxStreaming.onError = (err) => {
            if (!event.sender.isDestroyed()) event.sender.send("soniox-streaming-error", err.message);
          };
          this._sonioxStreaming.onSessionEnd = (data) => {
            if (!event.sender.isDestroyed()) event.sender.send("soniox-streaming-session-end", data || {});
          };

          await this._sonioxStreaming.connect({
            apiKey,
            model: options.model || "stt-rt-v4",
            language: options.language,
            secondaryLanguage: options.secondaryLanguage,
          });
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.on("soniox-streaming-send", (_event, audioBuffer) => {
      this._sonioxStreaming?.sendAudio(Buffer.from(audioBuffer));
    });

    ipcMain.on("soniox-streaming-finalize", () => {
      this._sonioxStreaming?.finalize();
    });

    ipcMain.handle("soniox-streaming-stop", async () => {
      if (!this._sonioxStreaming) {
        return { success: true, text: "" };
      }
      const result = await this._sonioxStreaming.disconnect().catch(() => ({ text: "" }));
      this._sonioxStreaming = null;
      return { success: true, text: result.text || "" };
    });

    ipcMain.handle("soniox-streaming-status", async () => {
      return { connected: !!this._sonioxStreaming?.isConnected };
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

    ipcMain.handle("cloud-agent-stream", async (event, messages, opts = {}) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        debugLogger.debug(
          "Cloud agent stream request",
          { messageCount: messages?.length || 0 },
          "cloud-api"
        );

        const response = await fetch(`${apiUrl}/api/agent/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookieHeader,
          },
          body: JSON.stringify({
            messages,
            systemPrompt: opts.systemPrompt,
            sessionId: this.sessionId,
            clientType: "desktop",
            appVersion: app.getVersion(),
          }),
        });

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          const errorData = await response.json().catch(() => ({}));
          return {
            success: false,
            error: errorData.error || `API error: ${response.status}`,
          };
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            if (text) event.sender.send("agent-stream-chunk", text);
          }
        } finally {
          reader.releaseLock();
        }

        event.sender.send("agent-stream-done");
        return { success: true };
      } catch (error) {
        debugLogger.error("Cloud agent stream error:", error);
        event.sender.send("agent-stream-done");
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
          throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        return { success: true, ...data };
      } catch (error) {
        debugLogger.error("STT config fetch error:", error);
        return null;
      }
    });

    ipcMain.handle("transcribe-audio-file-cloud", async (event, filePath) => {
      const fs = require("fs");
      const os = require("os");
      const { splitAudioFile } = require("./ffmpegUtils");
      const FILE_SIZE_LIMIT = 25 * 1024 * 1024;
      const CONCURRENCY_LIMIT = 5;
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const fileSize = fs.statSync(filePath).size;

        if (fileSize > FILE_SIZE_LIMIT) {
          debugLogger.debug("Large file detected, using client-side chunking", {
            fileSize,
            filePath: path.basename(filePath),
          });

          const chunkDir = path.join(os.tmpdir(), `ow-chunks-${Date.now()}`);
          fs.mkdirSync(chunkDir, { recursive: true });

          try {
            event.sender.send("upload-transcription-progress", {
              stage: "splitting",
              chunksTotal: 0,
              chunksCompleted: 0,
            });

            const chunkPaths = await splitAudioFile(filePath, chunkDir, {
              segmentDuration: 240, // ~3.75 MB/chunk, under Vercel's 4.5 MB payload limit
            });
            const totalChunks = chunkPaths.length;

            debugLogger.debug("Audio split into chunks", { totalChunks });

            event.sender.send("upload-transcription-progress", {
              stage: "transcribing",
              chunksTotal: totalChunks,
              chunksCompleted: 0,
            });

            const results = new Array(totalChunks).fill(null);
            let completedCount = 0;

            const transcribeChunk = async (index) => {
              const chunkBuffer = fs.readFileSync(chunkPaths[index]);
              const chunkName = path.basename(chunkPaths[index]);

              const { body, boundary } = buildMultipartBody(chunkBuffer, chunkName, "audio/mpeg", {
                source: "file_upload",
                clientType: "desktop",
                appVersion: app.getVersion(),
                clientVersion: app.getVersion(),
                sessionId: this.sessionId,
              });

              const url = new URL(`${apiUrl}/api/transcribe`);
              const data = await postMultipart(url, body, boundary, { Cookie: cookieHeader });

              if (data.statusCode === 401) {
                throw Object.assign(new Error("Session expired"), { code: "AUTH_EXPIRED" });
              }
              if (data.statusCode === 429) {
                throw Object.assign(new Error("Daily word limit reached"), {
                  code: "LIMIT_REACHED",
                  ...data.data,
                });
              }
              if (data.statusCode !== 200) {
                throw new Error(data.data?.error || `API error: ${data.statusCode}`);
              }

              results[index] = data.data;
              completedCount++;

              event.sender.send("upload-transcription-progress", {
                stage: "transcribing",
                chunksTotal: totalChunks,
                chunksCompleted: completedCount,
              });
            };

            const indices = Array.from({ length: totalChunks }, (_, i) => i);
            const executing = new Set();

            for (const index of indices) {
              const p = transcribeChunk(index).then(
                () => executing.delete(p),
                (err) => {
                  executing.delete(p);
                  if (err.code === "AUTH_EXPIRED" || err.code === "LIMIT_REACHED") throw err;
                  debugLogger.warn(`Chunk ${index} failed`, { error: err.message });
                }
              );
              executing.add(p);
              if (executing.size >= CONCURRENCY_LIMIT) {
                await Promise.race(executing);
              }
            }
            await Promise.all(executing);

            const succeeded = results.filter((r) => r !== null);
            if (succeeded.length === 0) {
              throw new Error("All chunks failed to transcribe");
            }

            const fullText = results
              .filter((r) => r !== null)
              .map((r) => r.text)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();

            const failed = results.filter((r) => r === null).length;
            if (failed > 0) {
              debugLogger.warn("Some chunks failed", { failed, total: totalChunks });
            }

            return {
              success: true,
              text: fullText,
              ...(failed > 0 ? { warning: `${failed} of ${totalChunks} chunks failed` } : {}),
            };
          } finally {
            try {
              fs.rmSync(chunkDir, { recursive: true, force: true });
            } catch (cleanupErr) {
              debugLogger.warn("Failed to cleanup chunk dir", { error: cleanupErr.message });
            }
          }
        }

        const audioBuffer = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase().replace(".", "");
        const contentType = AUDIO_MIME_TYPES[ext] || "audio/mpeg";
        const fileName = path.basename(filePath);

        const { body, boundary } = buildMultipartBody(audioBuffer, fileName, contentType, {
          source: "file_upload",
          clientType: "desktop",
          appVersion: app.getVersion(),
          clientVersion: app.getVersion(),
          sessionId: this.sessionId,
        });

        const url = new URL(`${apiUrl}/api/transcribe`);
        const data = await postMultipart(url, body, boundary, { Cookie: cookieHeader });

        if (data.statusCode === 401) {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        if (data.statusCode === 429) {
          return {
            success: false,
            error: "Daily word limit reached",
            code: "LIMIT_REACHED",
            ...data.data,
          };
        }
        if (data.statusCode !== 200) {
          throw new Error(data.data?.error || `API error: ${data.statusCode}`);
        }

        return { success: true, text: data.data.text };
      } catch (error) {
        debugLogger.error("Cloud audio file transcription error", { error: error.message });
        if (error.code === "AUTH_EXPIRED" || error.code === "LIMIT_REACHED") {
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
        const modelsDir = this.whisperManager.getModelsDir();
        await shell.openPath(modelsDir);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open whisper models folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-ydotool-status", () => {
      const { getYdotoolStatus } = require("./ensureYdotool");
      return getYdotoolStatus();
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
      return hotkeyManager.registerSlot("agent", hotkey, agentCallback);
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

    ipcMain.handle("meeting-detection-respond", async (_event, detectionId, action) => {
      try {
        this.meetingDetectionEngine.handleUserResponse(detectionId, action);
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

    ipcMain.handle("get-meeting-notification-data", async () => {
      return this.windowManager?._pendingNotificationData ?? null;
    });

    ipcMain.handle("meeting-notification-ready", async () => {
      this.windowManager?.showNotificationWindow();
    });

    ipcMain.handle("get-desktop-sources", async (_event, types) => {
      try {
        const { desktopCapturer } = require("electron");
        const sources = await desktopCapturer.getSources({ types: types || ["screen"] });
        return sources.map((s) => ({ id: s.id, name: s.name }));
      } catch (error) {
        debugLogger.error("Failed to get desktop sources", { error: error.message }, "calendar");
        return [];
      }
    });
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
