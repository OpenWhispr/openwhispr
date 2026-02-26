const { contextBridge, ipcRenderer, webUtils } = require("electron");

/**
 * Helper to register an IPC listener and return a cleanup function.
 * Ensures renderer code can easily remove listeners to avoid leaks.
 */
const registerListener = (channel, handlerFactory) => {
  return (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }

    const listener =
      typeof handlerFactory === "function"
        ? handlerFactory(callback)
        : (event, ...args) => callback(event, ...args);

    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
};

contextBridge.exposeInMainWorld("electronAPI", {
  pasteText: (text, options) => ipcRenderer.invoke("paste-text", text, options),
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  showDictationPanel: () => ipcRenderer.invoke("show-dictation-panel"),
  onToggleDictation: registerListener("toggle-dictation", (callback) => () => callback()),
  onStartDictation: registerListener("start-dictation", (callback) => () => callback()),
  onStopDictation: registerListener("stop-dictation", (callback) => () => callback()),

  // Database functions
  saveTranscription: (text) => ipcRenderer.invoke("db-save-transcription", text),
  getTranscriptions: (limit) => ipcRenderer.invoke("db-get-transcriptions", limit),
  clearTranscriptions: () => ipcRenderer.invoke("db-clear-transcriptions"),
  deleteTranscription: (id) => ipcRenderer.invoke("db-delete-transcription", id),
  // Dictionary functions
  getDictionary: () => ipcRenderer.invoke("db-get-dictionary"),
  setDictionary: (words) => ipcRenderer.invoke("db-set-dictionary", words),
  onDictionaryUpdated: (callback) => {
    const listener = (_event, words) => callback?.(words);
    ipcRenderer.on("dictionary-updated", listener);
    return () => ipcRenderer.removeListener("dictionary-updated", listener);
  },
  setAutoLearnEnabled: (enabled) => ipcRenderer.send("auto-learn-changed", enabled),
  onCorrectionsLearned: (callback) => {
    const listener = (_event, words) => callback?.(words);
    ipcRenderer.on("corrections-learned", listener);
    return () => ipcRenderer.removeListener("corrections-learned", listener);
  },
  undoLearnedCorrections: (words) => ipcRenderer.invoke("undo-learned-corrections", words),

  // Note functions
  saveNote: (title, content, noteType, sourceFile, audioDuration, folderId) =>
    ipcRenderer.invoke(
      "db-save-note",
      title,
      content,
      noteType,
      sourceFile,
      audioDuration,
      folderId
    ),
  getNote: (id) => ipcRenderer.invoke("db-get-note", id),
  getNotes: (noteType, limit, folderId) =>
    ipcRenderer.invoke("db-get-notes", noteType, limit, folderId),
  updateNote: (id, updates) => ipcRenderer.invoke("db-update-note", id, updates),
  deleteNote: (id) => ipcRenderer.invoke("db-delete-note", id),
  exportNote: (noteId, format) => ipcRenderer.invoke("export-note", noteId, format),

  // Folder functions
  getFolders: () => ipcRenderer.invoke("db-get-folders"),
  createFolder: (name) => ipcRenderer.invoke("db-create-folder", name),
  deleteFolder: (id) => ipcRenderer.invoke("db-delete-folder", id),
  renameFolder: (id, name) => ipcRenderer.invoke("db-rename-folder", id, name),
  getFolderNoteCounts: () => ipcRenderer.invoke("db-get-folder-note-counts"),

  // Action functions
  getActions: () => ipcRenderer.invoke("db-get-actions"),
  getAction: (id) => ipcRenderer.invoke("db-get-action", id),
  createAction: (name, description, prompt, icon) =>
    ipcRenderer.invoke("db-create-action", name, description, prompt, icon),
  updateAction: (id, updates) => ipcRenderer.invoke("db-update-action", id, updates),
  deleteAction: (id) => ipcRenderer.invoke("db-delete-action", id),

  // Audio file operations
  selectAudioFile: () => ipcRenderer.invoke("select-audio-file"),
  transcribeAudioFile: (filePath, options) =>
    ipcRenderer.invoke("transcribe-audio-file", filePath, options),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  onNoteAdded: (callback) => {
    const listener = (_event, note) => callback?.(note);
    ipcRenderer.on("note-added", listener);
    return () => ipcRenderer.removeListener("note-added", listener);
  },
  onNoteUpdated: (callback) => {
    const listener = (_event, note) => callback?.(note);
    ipcRenderer.on("note-updated", listener);
    return () => ipcRenderer.removeListener("note-updated", listener);
  },
  onNoteDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("note-deleted", listener);
    return () => ipcRenderer.removeListener("note-deleted", listener);
  },

  onActionCreated: (callback) => {
    const listener = (_event, action) => callback?.(action);
    ipcRenderer.on("action-created", listener);
    return () => ipcRenderer.removeListener("action-created", listener);
  },
  onActionUpdated: (callback) => {
    const listener = (_event, action) => callback?.(action);
    ipcRenderer.on("action-updated", listener);
    return () => ipcRenderer.removeListener("action-updated", listener);
  },
  onActionDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("action-deleted", listener);
    return () => ipcRenderer.removeListener("action-deleted", listener);
  },

  onTranscriptionAdded: (callback) => {
    const listener = (_event, transcription) => callback?.(transcription);
    ipcRenderer.on("transcription-added", listener);
    return () => ipcRenderer.removeListener("transcription-added", listener);
  },
  onTranscriptionDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("transcription-deleted", listener);
    return () => ipcRenderer.removeListener("transcription-deleted", listener);
  },
  onTranscriptionsCleared: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("transcriptions-cleared", listener);
    return () => ipcRenderer.removeListener("transcriptions-cleared", listener);
  },

  // Environment variables
  getOpenAIKey: () => ipcRenderer.invoke("get-openai-key"),
  saveOpenAIKey: (key) => ipcRenderer.invoke("save-openai-key", key),
  createProductionEnvFile: (key) => ipcRenderer.invoke("create-production-env-file", key),

  // Clipboard functions
  checkAccessibilityPermission: () => ipcRenderer.invoke("check-accessibility-permission"),
  readClipboard: () => ipcRenderer.invoke("read-clipboard"),
  writeClipboard: (text) => ipcRenderer.invoke("write-clipboard", text),
  checkPasteTools: () => ipcRenderer.invoke("check-paste-tools"),

  // Local Whisper functions (whisper.cpp)
  transcribeLocalWhisper: (audioBlob, options) =>
    ipcRenderer.invoke("transcribe-local-whisper", audioBlob, options),
  checkWhisperInstallation: () => ipcRenderer.invoke("check-whisper-installation"),
  downloadWhisperModel: (modelName) => ipcRenderer.invoke("download-whisper-model", modelName),
  onWhisperDownloadProgress: registerListener("whisper-download-progress"),
  checkModelStatus: (modelName) => ipcRenderer.invoke("check-model-status", modelName),
  listWhisperModels: () => ipcRenderer.invoke("list-whisper-models"),
  deleteWhisperModel: (modelName) => ipcRenderer.invoke("delete-whisper-model", modelName),
  deleteAllWhisperModels: () => ipcRenderer.invoke("delete-all-whisper-models"),
  cancelWhisperDownload: () => ipcRenderer.invoke("cancel-whisper-download"),
  checkFFmpegAvailability: () => ipcRenderer.invoke("check-ffmpeg-availability"),
  getAudioDiagnostics: () => ipcRenderer.invoke("get-audio-diagnostics"),

  // Whisper server functions (faster repeated transcriptions)
  whisperServerStart: (modelName) => ipcRenderer.invoke("whisper-server-start", modelName),
  whisperServerStop: () => ipcRenderer.invoke("whisper-server-stop"),
  whisperServerStatus: () => ipcRenderer.invoke("whisper-server-status"),

  // CUDA GPU acceleration
  detectGpu: () => ipcRenderer.invoke("detect-gpu"),
  getCudaWhisperStatus: () => ipcRenderer.invoke("get-cuda-whisper-status"),
  downloadCudaWhisperBinary: () => ipcRenderer.invoke("download-cuda-whisper-binary"),
  cancelCudaWhisperDownload: () => ipcRenderer.invoke("cancel-cuda-whisper-download"),
  deleteCudaWhisperBinary: () => ipcRenderer.invoke("delete-cuda-whisper-binary"),
  onCudaDownloadProgress: registerListener(
    "cuda-download-progress",
    (callback) => (_event, data) => callback(data)
  ),
  onCudaFallbackNotification: registerListener(
    "cuda-fallback-notification",
    (callback) => () => callback()
  ),

  // Local Parakeet (NVIDIA) functions
  transcribeLocalParakeet: (audioBlob, options) =>
    ipcRenderer.invoke("transcribe-local-parakeet", audioBlob, options),
  checkParakeetInstallation: () => ipcRenderer.invoke("check-parakeet-installation"),
  downloadParakeetModel: (modelName) => ipcRenderer.invoke("download-parakeet-model", modelName),
  onParakeetDownloadProgress: registerListener("parakeet-download-progress"),
  checkParakeetModelStatus: (modelName) =>
    ipcRenderer.invoke("check-parakeet-model-status", modelName),
  listParakeetModels: () => ipcRenderer.invoke("list-parakeet-models"),
  deleteParakeetModel: (modelName) => ipcRenderer.invoke("delete-parakeet-model", modelName),
  deleteAllParakeetModels: () => ipcRenderer.invoke("delete-all-parakeet-models"),
  cancelParakeetDownload: () => ipcRenderer.invoke("cancel-parakeet-download"),
  getParakeetDiagnostics: () => ipcRenderer.invoke("get-parakeet-diagnostics"),

  // Parakeet server functions (faster repeated transcriptions)
  parakeetServerStart: (modelName) => ipcRenderer.invoke("parakeet-server-start", modelName),
  parakeetServerStop: () => ipcRenderer.invoke("parakeet-server-stop"),
  parakeetServerStatus: () => ipcRenderer.invoke("parakeet-server-status"),

  // Window control functions
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  getPlatform: () => process.platform,
  appQuit: () => ipcRenderer.invoke("app-quit"),

  // Cleanup function
  cleanupApp: () => ipcRenderer.invoke("cleanup-app"),
  updateHotkey: (hotkey) => ipcRenderer.invoke("update-hotkey", hotkey),
  setHotkeyListeningMode: (enabled, newHotkey) =>
    ipcRenderer.invoke("set-hotkey-listening-mode", enabled, newHotkey),
  getHotkeyModeInfo: () => ipcRenderer.invoke("get-hotkey-mode-info"),
  startWindowDrag: () => ipcRenderer.invoke("start-window-drag"),
  stopWindowDrag: () => ipcRenderer.invoke("stop-window-drag"),
  setMainWindowInteractivity: (interactive) =>
    ipcRenderer.invoke("set-main-window-interactivity", interactive),
  resizeMainWindow: (sizeKey) => ipcRenderer.invoke("resize-main-window", sizeKey),

  // Update functions
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getUpdateStatus: () => ipcRenderer.invoke("get-update-status"),
  getUpdateInfo: () => ipcRenderer.invoke("get-update-info"),

  // Update event listeners
  onUpdateAvailable: registerListener("update-available"),
  onUpdateNotAvailable: registerListener("update-not-available"),
  onUpdateDownloaded: registerListener("update-downloaded"),
  onUpdateDownloadProgress: registerListener("update-download-progress"),
  onUpdateError: registerListener("update-error"),

  // Audio event listeners
  onNoAudioDetected: registerListener("no-audio-detected"),

  // External link opener
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  // Model management functions
  modelGetAll: () => ipcRenderer.invoke("model-get-all"),
  modelCheck: (modelId) => ipcRenderer.invoke("model-check", modelId),
  modelDownload: (modelId) => ipcRenderer.invoke("model-download", modelId),
  modelDelete: (modelId) => ipcRenderer.invoke("model-delete", modelId),
  modelDeleteAll: () => ipcRenderer.invoke("model-delete-all"),
  modelCheckRuntime: () => ipcRenderer.invoke("model-check-runtime"),
  modelCancelDownload: (modelId) => ipcRenderer.invoke("model-cancel-download", modelId),
  onModelDownloadProgress: registerListener("model-download-progress"),

  // Anthropic API
  getAnthropicKey: () => ipcRenderer.invoke("get-anthropic-key"),
  saveAnthropicKey: (key) => ipcRenderer.invoke("save-anthropic-key", key),
  getUiLanguage: () => ipcRenderer.invoke("get-ui-language"),
  saveUiLanguage: (language) => ipcRenderer.invoke("save-ui-language", language),
  setUiLanguage: (language) => ipcRenderer.invoke("set-ui-language", language),

  // Gemini API
  getGeminiKey: () => ipcRenderer.invoke("get-gemini-key"),
  saveGeminiKey: (key) => ipcRenderer.invoke("save-gemini-key", key),

  // Groq API
  getGroqKey: () => ipcRenderer.invoke("get-groq-key"),
  saveGroqKey: (key) => ipcRenderer.invoke("save-groq-key", key),

  // Mistral API
  getMistralKey: () => ipcRenderer.invoke("get-mistral-key"),
  saveMistralKey: (key) => ipcRenderer.invoke("save-mistral-key", key),
  proxyMistralTranscription: (data) => ipcRenderer.invoke("proxy-mistral-transcription", data),

  // Custom endpoint API keys
  getCustomTranscriptionKey: () => ipcRenderer.invoke("get-custom-transcription-key"),
  saveCustomTranscriptionKey: (key) => ipcRenderer.invoke("save-custom-transcription-key", key),
  getCustomReasoningKey: () => ipcRenderer.invoke("get-custom-reasoning-key"),
  saveCustomReasoningKey: (key) => ipcRenderer.invoke("save-custom-reasoning-key", key),

  // Dictation key persistence (file-based for reliable startup)
  getDictationKey: () => ipcRenderer.invoke("get-dictation-key"),
  saveDictationKey: (key) => ipcRenderer.invoke("save-dictation-key", key),

  // Activation mode persistence (file-based for reliable startup)
  getActivationMode: () => ipcRenderer.invoke("get-activation-mode"),
  saveActivationMode: (mode) => ipcRenderer.invoke("save-activation-mode", mode),

  saveAllKeysToEnv: () => ipcRenderer.invoke("save-all-keys-to-env"),
  syncStartupPreferences: (prefs) => ipcRenderer.invoke("sync-startup-preferences", prefs),

  // Local reasoning
  processLocalReasoning: (text, modelId, agentName, config) =>
    ipcRenderer.invoke("process-local-reasoning", text, modelId, agentName, config),
  checkLocalReasoningAvailable: () => ipcRenderer.invoke("check-local-reasoning-available"),

  // Anthropic reasoning
  processAnthropicReasoning: (text, modelId, agentName, config) =>
    ipcRenderer.invoke("process-anthropic-reasoning", text, modelId, agentName, config),

  // llama.cpp
  llamaCppCheck: () => ipcRenderer.invoke("llama-cpp-check"),
  llamaCppInstall: () => ipcRenderer.invoke("llama-cpp-install"),
  llamaCppUninstall: () => ipcRenderer.invoke("llama-cpp-uninstall"),

  // llama-server
  llamaServerStart: (modelId) => ipcRenderer.invoke("llama-server-start", modelId),
  llamaServerStop: () => ipcRenderer.invoke("llama-server-stop"),
  llamaServerStatus: () => ipcRenderer.invoke("llama-server-status"),
  llamaGpuReset: () => ipcRenderer.invoke("llama-gpu-reset"),

  // Vulkan GPU acceleration
  detectVulkanGpu: () => ipcRenderer.invoke("detect-vulkan-gpu"),
  getLlamaVulkanStatus: () => ipcRenderer.invoke("get-llama-vulkan-status"),
  downloadLlamaVulkanBinary: () => ipcRenderer.invoke("download-llama-vulkan-binary"),
  cancelLlamaVulkanDownload: () => ipcRenderer.invoke("cancel-llama-vulkan-download"),
  deleteLlamaVulkanBinary: () => ipcRenderer.invoke("delete-llama-vulkan-binary"),
  onLlamaVulkanDownloadProgress: registerListener(
    "llama-vulkan-download-progress",
    (callback) => (_event, data) => callback(data)
  ),

  getLogLevel: () => ipcRenderer.invoke("get-log-level"),
  log: (entry) => ipcRenderer.invoke("app-log", entry),

  // Debug logging management
  getDebugState: () => ipcRenderer.invoke("get-debug-state"),
  setDebugLogging: (enabled) => ipcRenderer.invoke("set-debug-logging", enabled),
  openLogsFolder: () => ipcRenderer.invoke("open-logs-folder"),

  // System settings helpers for microphone/audio permissions
  requestMicrophoneAccess: () => ipcRenderer.invoke("request-microphone-access"),
  openMicrophoneSettings: () => ipcRenderer.invoke("open-microphone-settings"),
  openSoundInputSettings: () => ipcRenderer.invoke("open-sound-input-settings"),
  openAccessibilitySettings: () => ipcRenderer.invoke("open-accessibility-settings"),
  openWhisperModelsFolder: () => ipcRenderer.invoke("open-whisper-models-folder"),
  authClearSession: () => ipcRenderer.invoke("auth-clear-session"),

  // OpenWhispr Cloud API
  cloudTranscribe: (audioBuffer, opts) => ipcRenderer.invoke("cloud-transcribe", audioBuffer, opts),
  cloudReason: (text, opts) => ipcRenderer.invoke("cloud-reason", text, opts),
  cloudStreamingUsage: (text, audioDurationSeconds, opts) =>
    ipcRenderer.invoke("cloud-streaming-usage", text, audioDurationSeconds, opts),
  cloudUsage: () => ipcRenderer.invoke("cloud-usage"),
  cloudCheckout: (plan) => ipcRenderer.invoke("cloud-checkout", plan),
  cloudBillingPortal: () => ipcRenderer.invoke("cloud-billing-portal"),
  getSttConfig: () => ipcRenderer.invoke("get-stt-config"),

  // Cloud audio file transcription
  transcribeAudioFileCloud: (filePath) =>
    ipcRenderer.invoke("transcribe-audio-file-cloud", filePath),
  transcribeAudioFileByok: (options) => ipcRenderer.invoke("transcribe-audio-file-byok", options),

  // Referral stats
  getReferralStats: () => ipcRenderer.invoke("get-referral-stats"),
  sendReferralInvite: (email) => ipcRenderer.invoke("send-referral-invite", email),
  getReferralInvites: () => ipcRenderer.invoke("get-referral-invites"),

  // Assembly AI Streaming
  assemblyAiStreamingWarmup: (options) =>
    ipcRenderer.invoke("assemblyai-streaming-warmup", options),
  assemblyAiStreamingStart: (options) => ipcRenderer.invoke("assemblyai-streaming-start", options),
  assemblyAiStreamingSend: (audioBuffer) =>
    ipcRenderer.send("assemblyai-streaming-send", audioBuffer),
  assemblyAiStreamingForceEndpoint: () => ipcRenderer.send("assemblyai-streaming-force-endpoint"),
  assemblyAiStreamingStop: () => ipcRenderer.invoke("assemblyai-streaming-stop"),
  assemblyAiStreamingStatus: () => ipcRenderer.invoke("assemblyai-streaming-status"),
  onAssemblyAiPartialTranscript: registerListener(
    "assemblyai-partial-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onAssemblyAiFinalTranscript: registerListener(
    "assemblyai-final-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onAssemblyAiError: registerListener(
    "assemblyai-error",
    (callback) => (_event, error) => callback(error)
  ),
  onAssemblyAiSessionEnd: registerListener(
    "assemblyai-session-end",
    (callback) => (_event, data) => callback(data)
  ),

  // Deepgram Streaming
  deepgramStreamingWarmup: (options) => ipcRenderer.invoke("deepgram-streaming-warmup", options),
  deepgramStreamingStart: (options) => ipcRenderer.invoke("deepgram-streaming-start", options),
  deepgramStreamingSend: (audioBuffer) => ipcRenderer.send("deepgram-streaming-send", audioBuffer),
  deepgramStreamingFinalize: () => ipcRenderer.send("deepgram-streaming-finalize"),
  deepgramStreamingStop: () => ipcRenderer.invoke("deepgram-streaming-stop"),
  deepgramStreamingStatus: () => ipcRenderer.invoke("deepgram-streaming-status"),
  onDeepgramPartialTranscript: registerListener(
    "deepgram-partial-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onDeepgramFinalTranscript: registerListener(
    "deepgram-final-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onDeepgramError: registerListener(
    "deepgram-error",
    (callback) => (_event, error) => callback(error)
  ),
  onDeepgramSessionEnd: registerListener(
    "deepgram-session-end",
    (callback) => (_event, data) => callback(data)
  ),

  // Usage limit events (for showing UpgradePrompt in ControlPanel)
  notifyLimitReached: (data) => ipcRenderer.send("limit-reached", data),
  onLimitReached: registerListener("limit-reached", (callback) => (_event, data) => callback(data)),

  // Globe key listener for hotkey capture (macOS only)
  onGlobeKeyPressed: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("globe-key-pressed", listener);
    return () => ipcRenderer.removeListener("globe-key-pressed", listener);
  },
  onGlobeKeyReleased: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("globe-key-released", listener);
    return () => ipcRenderer.removeListener("globe-key-released", listener);
  },

  // Hotkey registration events (for notifying user when hotkey fails)
  onHotkeyFallbackUsed: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("hotkey-fallback-used", listener);
    return () => ipcRenderer.removeListener("hotkey-fallback-used", listener);
  },
  onHotkeyRegistrationFailed: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("hotkey-registration-failed", listener);
    return () => ipcRenderer.removeListener("hotkey-registration-failed", listener);
  },
  onWindowsPushToTalkUnavailable: registerListener("windows-ptt-unavailable"),

  // Notify main process of activation mode changes (for Windows Push-to-Talk)
  notifyActivationModeChanged: (mode) => ipcRenderer.send("activation-mode-changed", mode),
  notifyHotkeyChanged: (hotkey) => ipcRenderer.send("hotkey-changed", hotkey),

  // Floating icon auto-hide
  notifyFloatingIconAutoHideChanged: (enabled) =>
    ipcRenderer.send("floating-icon-auto-hide-changed", enabled),
  onFloatingIconAutoHideChanged: registerListener(
    "floating-icon-auto-hide-changed",
    (callback) => (_event, enabled) => callback(enabled)
  ),

  // Auto-start management
  getAutoStartEnabled: () => ipcRenderer.invoke("get-auto-start-enabled"),
  setAutoStartEnabled: (enabled) => ipcRenderer.invoke("set-auto-start-enabled", enabled),
});
