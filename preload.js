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
  saveTranscription: (text, rawText, options) =>
    ipcRenderer.invoke("db-save-transcription", text, rawText, options),
  getTranscriptions: (limit) => ipcRenderer.invoke("db-get-transcriptions", limit),
  clearTranscriptions: () => ipcRenderer.invoke("db-clear-transcriptions"),
  deleteTranscription: (id) => ipcRenderer.invoke("db-delete-transcription", id),

  // Audio storage functions
  saveTranscriptionAudio: (id, audioBuffer, metadata) =>
    ipcRenderer.invoke("save-transcription-audio", id, audioBuffer, metadata),
  getAudioPath: (id) => ipcRenderer.invoke("get-audio-path", id),
  showAudioInFolder: (id) => ipcRenderer.invoke("show-audio-in-folder", id),
  getAudioBuffer: (id) => ipcRenderer.invoke("get-audio-buffer", id),
  deleteTranscriptionAudio: (id) => ipcRenderer.invoke("delete-transcription-audio", id),
  getAudioStorageUsage: () => ipcRenderer.invoke("get-audio-storage-usage"),
  deleteAllAudio: () => ipcRenderer.invoke("delete-all-audio"),
  retryTranscription: (id, settings) => ipcRenderer.invoke("retry-transcription", id, settings),
  updateTranscriptionText: (id, text, rawText) =>
    ipcRenderer.invoke("update-transcription-text", id, text, rawText),
  getTranscriptionById: (id) => ipcRenderer.invoke("get-transcription-by-id", id),

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
  exportTranscript: (noteId, format) => ipcRenderer.invoke("export-transcript", noteId, format),
  searchNotes: (query, limit) => ipcRenderer.invoke("db-search-notes", query, limit),
  semanticSearchNotes: (query, limit) =>
    ipcRenderer.invoke("db-semantic-search-notes", query, limit),
  semanticReindexAll: () => ipcRenderer.invoke("db-semantic-reindex-all"),
  onSemanticReindexProgress: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("semantic-reindex-progress", listener);
    return () => ipcRenderer.removeListener("semantic-reindex-progress", listener);
  },
  updateNoteCloudId: (id, cloudId) => ipcRenderer.invoke("db-update-note-cloud-id", id, cloudId),

  // Folder functions
  getFolders: () => ipcRenderer.invoke("db-get-folders"),
  createFolder: (name) => ipcRenderer.invoke("db-create-folder", name),
  deleteFolder: (id) => ipcRenderer.invoke("db-delete-folder", id),
  renameFolder: (id, name) => ipcRenderer.invoke("db-rename-folder", id, name),
  getFolderNoteCounts: () => ipcRenderer.invoke("db-get-folder-note-counts"),

  // Note files (markdown mirror) functions
  noteFilesSetEnabled: (enabled, customPath, options) =>
    ipcRenderer.invoke("note-files-set-enabled", enabled, customPath, options),
  noteFilesSetPath: (path) => ipcRenderer.invoke("note-files-set-path", path),
  noteFilesRebuild: () => ipcRenderer.invoke("note-files-rebuild"),
  noteFilesGetDefaultPath: () => ipcRenderer.invoke("note-files-get-default-path"),
  noteFilesPickFolder: () => ipcRenderer.invoke("note-files-pick-folder"),
  showNoteFile: (noteId) => ipcRenderer.invoke("show-note-file", noteId),
  showFolderInExplorer: (folderName) => ipcRenderer.invoke("show-folder-in-explorer", folderName),

  // Action functions
  getActions: () => ipcRenderer.invoke("db-get-actions"),
  getAction: (id) => ipcRenderer.invoke("db-get-action", id),
  createAction: (name, description, prompt, icon) =>
    ipcRenderer.invoke("db-create-action", name, description, prompt, icon),
  updateAction: (id, updates) => ipcRenderer.invoke("db-update-action", id, updates),
  deleteAction: (id) => ipcRenderer.invoke("db-delete-action", id),

  // Audio file operations
  selectAudioFile: () => ipcRenderer.invoke("select-audio-file"),
  getFileSize: (filePath) => ipcRenderer.invoke("get-file-size", filePath),
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
  onTranscriptionUpdated: (callback) => {
    const listener = (_event, transcription) => callback?.(transcription);
    ipcRenderer.on("transcription-updated", listener);
    return () => ipcRenderer.removeListener("transcription-updated", listener);
  },

  // Environment variables
  getOpenAIKey: () => ipcRenderer.invoke("get-openai-key"),
  saveOpenAIKey: (key) => ipcRenderer.invoke("save-openai-key", key),

  // Clipboard functions
  checkAccessibilityPermission: (silent) =>
    ipcRenderer.invoke("check-accessibility-permission", silent),
  promptAccessibilityPermission: () => ipcRenderer.invoke("prompt-accessibility-permission"),
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
  listGpus: () => ipcRenderer.invoke("list-gpus"),
  setGpuDeviceIndex: (purpose, index) => ipcRenderer.invoke("set-gpu-device-index", purpose, index),
  getGpuDeviceIndex: (purpose) => ipcRenderer.invoke("get-gpu-device-index", purpose),
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

  // Diarization (speaker identification) functions
  downloadDiarizationModels: () => ipcRenderer.invoke("download-diarization-models"),
  getDiarizationModelStatus: () => ipcRenderer.invoke("get-diarization-model-status"),
  deleteDiarizationModels: () => ipcRenderer.invoke("delete-diarization-models"),
  cancelDiarizationDownload: () => ipcRenderer.invoke("cancel-diarization-download"),
  onDiarizationDownloadProgress: registerListener(
    "diarization-download-progress",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingDiarizationComplete: registerListener(
    "meeting-diarization-complete",
    (callback) => (_event, data) => callback(data)
  ),

  // Speaker name mapping
  getSpeakerMappings: (noteId) => ipcRenderer.invoke("get-speaker-mappings", noteId),
  setSpeakerMapping: (noteId, speakerId, displayName, email, profileId) =>
    ipcRenderer.invoke("set-speaker-mapping", noteId, speakerId, displayName, email, profileId),
  removeSpeakerMapping: (noteId, speakerId) =>
    ipcRenderer.invoke("remove-speaker-mapping", noteId, speakerId),
  getSpeakerProfiles: () => ipcRenderer.invoke("get-speaker-profiles"),
  attachSpeakerEmail: (profileId, email) =>
    ipcRenderer.invoke("attach-speaker-email", profileId, email),
  saveNoteSpeakerEmbeddings: (noteId, embeddings) =>
    ipcRenderer.invoke("save-note-speaker-embeddings", noteId, embeddings),

  // Window control functions
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  restoreFromMeetingMode: () => ipcRenderer.invoke("restore-from-meeting-mode"),
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
  setNotificationInteractivity: (interactive) =>
    ipcRenderer.invoke("set-notification-interactivity", interactive),
  resizeMainWindow: (sizeKey) => ipcRenderer.invoke("resize-main-window", sizeKey),

  // Update functions
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getPostMigrationState: () => ipcRenderer.invoke("get-post-migration-state"),
  getOAuthProtocolRegistered: () => ipcRenderer.invoke("get-oauth-protocol-registered"),
  getOAuthProtocol: () => ipcRenderer.invoke("get-oauth-protocol"),
  markBundleMigrated: () => ipcRenderer.invoke("mark-bundle-migrated"),
  markBundleMigrationDismissed: () => ipcRenderer.invoke("mark-bundle-migration-dismissed"),
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
  onCancelHotkeyPressed: registerListener("cancel-hotkey-pressed", (cb) => () => cb()),
  registerCancelHotkey: (key) => ipcRenderer.invoke("register-cancel-hotkey", key),
  unregisterCancelHotkey: () => ipcRenderer.invoke("unregister-cancel-hotkey"),

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
  getCleanupCustomKey: () => ipcRenderer.invoke("get-cleanup-custom-key"),
  saveCleanupCustomKey: (key) => ipcRenderer.invoke("save-cleanup-custom-key", key),

  // Enterprise provider key management
  getBedrockRegion: () => ipcRenderer.invoke("get-bedrock-region"),
  saveBedrockRegion: (value) => ipcRenderer.invoke("save-bedrock-region", value),
  getBedrockProfile: () => ipcRenderer.invoke("get-bedrock-profile"),
  saveBedrockProfile: (value) => ipcRenderer.invoke("save-bedrock-profile", value),
  getBedrockAccessKeyId: () => ipcRenderer.invoke("get-bedrock-access-key-id"),
  saveBedrockAccessKeyId: (key) => ipcRenderer.invoke("save-bedrock-access-key-id", key),
  getBedrockSecretAccessKey: () => ipcRenderer.invoke("get-bedrock-secret-access-key"),
  saveBedrockSecretAccessKey: (key) => ipcRenderer.invoke("save-bedrock-secret-access-key", key),
  getBedrockSessionToken: () => ipcRenderer.invoke("get-bedrock-session-token"),
  saveBedrockSessionToken: (key) => ipcRenderer.invoke("save-bedrock-session-token", key),
  getAzureEndpoint: () => ipcRenderer.invoke("get-azure-endpoint"),
  saveAzureEndpoint: (value) => ipcRenderer.invoke("save-azure-endpoint", value),
  getAzureApiKey: () => ipcRenderer.invoke("get-azure-api-key"),
  saveAzureApiKey: (key) => ipcRenderer.invoke("save-azure-api-key", key),
  getAzureDeployment: () => ipcRenderer.invoke("get-azure-deployment"),
  saveAzureDeployment: (value) => ipcRenderer.invoke("save-azure-deployment", value),
  getAzureApiVersion: () => ipcRenderer.invoke("get-azure-api-version"),
  saveAzureApiVersion: (value) => ipcRenderer.invoke("save-azure-api-version", value),
  getVertexProject: () => ipcRenderer.invoke("get-vertex-project"),
  saveVertexProject: (value) => ipcRenderer.invoke("save-vertex-project", value),
  getVertexLocation: () => ipcRenderer.invoke("get-vertex-location"),
  saveVertexLocation: (value) => ipcRenderer.invoke("save-vertex-location", value),
  getVertexApiKey: () => ipcRenderer.invoke("get-vertex-api-key"),
  saveVertexApiKey: (key) => ipcRenderer.invoke("save-vertex-api-key", key),
  testEnterpriseConnection: (provider, config) =>
    ipcRenderer.invoke("test-enterprise-connection", provider, config),

  // Dictation key persistence (file-based for reliable startup)
  getDictationKey: () => ipcRenderer.invoke("get-dictation-key"),
  getActiveDictationKey: () => ipcRenderer.invoke("get-active-dictation-key"),
  getEffectiveDefaultHotkey: () => ipcRenderer.invoke("get-effective-default-hotkey"),
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

  // Enterprise reasoning (Bedrock, Azure, Vertex) — runs in main process so
  // Node-only SDKs (AWS/Azure/Google credential providers) can resolve.
  processEnterpriseReasoning: (text, modelId, agentName, config) =>
    ipcRenderer.invoke("process-enterprise-reasoning", text, modelId, agentName, config),

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

  // ydotool status check
  getYdotoolStatus: () => ipcRenderer.invoke("get-ydotool-status"),

  // Debug logging management
  getDebugState: () => ipcRenderer.invoke("get-debug-state"),
  setDebugLogging: (enabled) => ipcRenderer.invoke("set-debug-logging", enabled),
  openLogsFolder: () => ipcRenderer.invoke("open-logs-folder"),

  // System settings helpers for microphone/audio permissions
  requestMicrophoneAccess: () => ipcRenderer.invoke("request-microphone-access"),
  checkMicrophoneAccess: () => ipcRenderer.invoke("check-microphone-access"),
  checkSystemAudioAccess: () => ipcRenderer.invoke("check-system-audio-access"),
  requestSystemAudioAccess: () => ipcRenderer.invoke("request-system-audio-access"),
  openMicrophoneSettings: () => ipcRenderer.invoke("open-microphone-settings"),
  openSoundInputSettings: () => ipcRenderer.invoke("open-sound-input-settings"),
  openAccessibilitySettings: () => ipcRenderer.invoke("open-accessibility-settings"),
  openSystemAudioSettings: () => ipcRenderer.invoke("open-system-audio-settings"),
  toggleMediaPlayback: () => ipcRenderer.invoke("toggle-media-playback"),
  pauseMediaPlayback: () => ipcRenderer.invoke("pause-media-playback"),
  resumeMediaPlayback: () => ipcRenderer.invoke("resume-media-playback"),
  openWhisperModelsFolder: () => ipcRenderer.invoke("open-whisper-models-folder"),
  authClearSession: () => ipcRenderer.invoke("auth-clear-session"),
  authGetToken: () => ipcRenderer.invoke("auth-get-token"),
  authSetToken: (token) => ipcRenderer.invoke("auth-set-token", token),
  authClearToken: () => ipcRenderer.invoke("auth-clear-token"),

  // OpenWhispr Cloud API
  cloudHealthCheck: () => ipcRenderer.invoke("cloud-health-check"),
  cloudTranscribe: (audioBuffer, opts) => ipcRenderer.invoke("cloud-transcribe", audioBuffer, opts),
  cloudReason: (text, opts) => ipcRenderer.invoke("cloud-reason", text, opts),
  cloudStreamingUsage: (text, audioDurationSeconds, opts) =>
    ipcRenderer.invoke("cloud-streaming-usage", text, audioDurationSeconds, opts),
  cloudUsage: () => ipcRenderer.invoke("cloud-usage"),
  cloudCheckout: (opts) => ipcRenderer.invoke("cloud-checkout", opts),
  cloudBillingPortal: () => ipcRenderer.invoke("cloud-billing-portal"),
  cloudSwitchPlan: (opts) => ipcRenderer.invoke("cloud-switch-plan", opts),
  cloudPreviewSwitch: (opts) => ipcRenderer.invoke("cloud-preview-switch", opts),
  cloudApiRequest: (opts) => ipcRenderer.invoke("cloud-api-request", opts),
  getSttConfig: () => ipcRenderer.invoke("get-stt-config"),
  getNoteRecordingConfig: () => ipcRenderer.invoke("get-note-recording-config"),

  // Cloud audio file transcription
  transcribeAudioFileCloud: (filePath) =>
    ipcRenderer.invoke("transcribe-audio-file-cloud", filePath),
  transcribeAudioFileByok: (options) => ipcRenderer.invoke("transcribe-audio-file-byok", options),
  onUploadTranscriptionProgress: registerListener(
    "upload-transcription-progress",
    (callback) => (_event, data) => callback(data)
  ),

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

  // Meeting transcription (streaming, dual-channel)
  meetingTranscriptionPrepare: (options) =>
    ipcRenderer.invoke("meeting-transcription-prepare", options),
  meetingTranscriptionStart: (options) =>
    ipcRenderer.invoke("meeting-transcription-start", options),
  meetingTranscriptionSend: (buffer, source) =>
    ipcRenderer.send("meeting-transcription-send", buffer, source),
  meetingTranscriptionStop: () => ipcRenderer.invoke("meeting-transcription-stop"),
  meetingTranscriptionCancel: () => ipcRenderer.invoke("meeting-transcription-cancel"),
  onMeetingTranscriptionSegment: registerListener(
    "meeting-transcription-segment",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSpeakerIdentified: registerListener(
    "meeting-speaker-identified",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSpeakersMerged: registerListener(
    "meeting-speakers-merged",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingTranscriptionError: registerListener(
    "meeting-transcription-error",
    (callback) => (_event, data) => callback(data)
  ),

  // Dictation realtime streaming
  dictationRealtimeWarmup: (options) => ipcRenderer.invoke("dictation-realtime-warmup", options),
  dictationRealtimeStart: (options) => ipcRenderer.invoke("dictation-realtime-start", options),
  dictationRealtimeSend: (buffer) => ipcRenderer.send("dictation-realtime-send", buffer),
  dictationRealtimeStop: () => ipcRenderer.invoke("dictation-realtime-stop"),
  onDictationRealtimePartial: registerListener(
    "dictation-realtime-partial",
    (callback) => (_event, data) => callback(data)
  ),
  onDictationRealtimeFinal: registerListener(
    "dictation-realtime-final",
    (callback) => (_event, data) => callback(data)
  ),
  onDictationRealtimeError: registerListener(
    "dictation-realtime-error",
    (callback) => (_event, data) => callback(data)
  ),
  onDictationRealtimeSessionEnd: registerListener(
    "dictation-realtime-session-end",
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
  onSettingUpdated: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("setting-updated", listener);
    return () => ipcRenderer.removeListener("setting-updated", listener);
  },
  onDictationKeyActive: (callback) => {
    const listener = (_event, key) => callback?.(key);
    ipcRenderer.on("dictation-key-active", listener);
    return () => ipcRenderer.removeListener("dictation-key-active", listener);
  },
  onWindowsPushToTalkUnavailable: registerListener("windows-ptt-unavailable"),
  onLinuxPttPermissionDenied: registerListener(
    "linux-ptt-permission-denied",
    (callback) => () => callback()
  ),

  // Settings shortcut (Cmd+, / Ctrl+,)
  onShowSettings: registerListener("show-settings", (callback) => () => callback()),

  // Accessibility permission events (macOS)
  onAccessibilityMissing: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("accessibility-missing", listener);
    return () => ipcRenderer.removeListener("accessibility-missing", listener);
  },
  checkAccessibilityTrusted: () => ipcRenderer.invoke("check-accessibility-trusted"),

  // Notify main process of activation mode changes (for Windows Push-to-Talk)
  notifyActivationModeChanged: (mode) => ipcRenderer.send("activation-mode-changed", mode),
  notifyHotkeyChanged: (hotkey) => ipcRenderer.send("hotkey-changed", hotkey),
  registerMeetingHotkey: (hotkey) => ipcRenderer.invoke("register-meeting-hotkey", hotkey),

  // Floating icon auto-hide
  notifyFloatingIconAutoHideChanged: (enabled) =>
    ipcRenderer.send("floating-icon-auto-hide-changed", enabled),
  onFloatingIconAutoHideChanged: registerListener(
    "floating-icon-auto-hide-changed",
    (callback) => (_event, enabled) => callback(enabled)
  ),

  // Panel start position
  notifyPanelStartPositionChanged: (position) =>
    ipcRenderer.send("panel-start-position-changed", position),

  // Start minimized
  notifyStartMinimizedChanged: (enabled) => ipcRenderer.send("start-minimized-changed", enabled),

  // Auto-start management
  getAutoStartEnabled: () => ipcRenderer.invoke("get-auto-start-enabled"),
  setAutoStartEnabled: (enabled) => ipcRenderer.invoke("set-auto-start-enabled", enabled),

  // Agent mode
  updateAgentHotkey: (hotkey) => ipcRenderer.invoke("update-agent-hotkey", hotkey),
  getAgentKey: () => ipcRenderer.invoke("get-agent-key"),
  saveAgentKey: (key) => ipcRenderer.invoke("save-agent-key", key),
  onAgentStartRecording: registerListener("agent-start-recording", (callback) => () => callback()),
  onAgentStopRecording: registerListener("agent-stop-recording", (callback) => () => callback()),
  onAgentToggleRecording: registerListener(
    "agent-toggle-recording",
    (callback) => () => callback()
  ),
  toggleAgentOverlay: () => ipcRenderer.invoke("toggle-agent-overlay"),
  hideAgentOverlay: () => ipcRenderer.invoke("hide-agent-overlay"),
  resizeAgentWindow: (width, height) => ipcRenderer.invoke("resize-agent-window", width, height),
  getAgentWindowBounds: () => ipcRenderer.invoke("get-agent-window-bounds"),
  setAgentWindowBounds: (x, y, width, height) =>
    ipcRenderer.invoke("set-agent-window-bounds", x, y, width, height),
  onPreviewText: registerListener("preview-text", (callback) => (_event, text) => callback(text)),
  onPreviewAppend: registerListener(
    "preview-append",
    (callback) => (_event, text) => callback(text)
  ),
  onPreviewHold: registerListener(
    "preview-hold",
    (callback) => (_event, payload) => callback(payload)
  ),
  onPreviewResult: registerListener(
    "preview-result",
    (callback) => (_event, payload) => callback(payload)
  ),
  onPreviewHide: registerListener("preview-hide", (callback) => () => callback()),
  startDictationPreview: (opts) => ipcRenderer.invoke("start-dictation-preview", opts),
  stopDictationPreview: (opts) => ipcRenderer.invoke("stop-dictation-preview", opts),
  dismissDictationPreview: () => ipcRenderer.invoke("dismiss-dictation-preview"),
  completeDictationPreview: (payload) => ipcRenderer.invoke("complete-dictation-preview", payload),
  hideDictationPreview: () => ipcRenderer.invoke("hide-dictation-preview"),
  resizeTranscriptionPreviewWindow: (width, height) =>
    ipcRenderer.invoke("resize-transcription-preview-window", width, height),
  sendDictationPreviewAudio: (data) => ipcRenderer.send("dictation-preview-audio", data),
  acquireRecordingLock: (pipeline) => ipcRenderer.invoke("acquire-recording-lock", pipeline),
  releaseRecordingLock: (pipeline) => ipcRenderer.invoke("release-recording-lock", pipeline),

  // Agent cloud streaming (event-based for real-time chunks)
  startAgentStream: (messages, opts) =>
    ipcRenderer.send("cloud-agent-stream-start", messages, opts),
  onAgentStreamChunk: registerListener(
    "cloud-agent-stream-chunk",
    (callback) => (_event, chunk) => callback(chunk)
  ),
  onAgentStreamError: registerListener(
    "cloud-agent-stream-error",
    (callback) => (_event, error) => callback(error)
  ),
  onAgentStreamEnd: registerListener("cloud-agent-stream-end", (callback) => () => callback()),

  // Agent cloud tools
  agentWebSearch: (query, numResults) => ipcRenderer.invoke("agent-web-search", query, numResults),
  agentOpenNote: (noteId) => ipcRenderer.invoke("agent-open-note", noteId),

  // Agent conversation persistence
  createAgentConversation: (title, noteId) =>
    ipcRenderer.invoke("db-create-agent-conversation", title, noteId),
  getAgentConversations: (limit) => ipcRenderer.invoke("db-get-agent-conversations", limit),
  getAgentConversation: (id) => ipcRenderer.invoke("db-get-agent-conversation", id),
  deleteAgentConversation: (id) => ipcRenderer.invoke("db-delete-agent-conversation", id),
  updateAgentConversationTitle: (id, title) =>
    ipcRenderer.invoke("db-update-agent-conversation-title", id, title),
  addAgentMessage: (conversationId, role, content, metadata) =>
    ipcRenderer.invoke("db-add-agent-message", conversationId, role, content, metadata),
  getAgentMessages: (conversationId) => ipcRenderer.invoke("db-get-agent-messages", conversationId),
  getAgentConversationsWithPreview: (limit, offset, includeArchived) =>
    ipcRenderer.invoke("db-get-agent-conversations-with-preview", limit, offset, includeArchived),
  searchAgentConversations: (query, limit) =>
    ipcRenderer.invoke("db-search-agent-conversations", query, limit),
  getConversationsForNote: (noteId, limit) =>
    ipcRenderer.invoke("db-get-conversations-for-note", noteId, limit),
  archiveAgentConversation: (id) => ipcRenderer.invoke("db-archive-agent-conversation", id),
  unarchiveAgentConversation: (id) => ipcRenderer.invoke("db-unarchive-agent-conversation", id),
  updateAgentConversationCloudId: (id, cloudId) =>
    ipcRenderer.invoke("db-update-agent-conversation-cloud-id", id, cloudId),
  semanticSearchConversations: (query, limit) =>
    ipcRenderer.invoke("db-semantic-search-conversations", query, limit),

  // Sync operations
  getPendingNotes: () => ipcRenderer.invoke("db-get-pending-notes"),
  getPendingNoteDeletes: () => ipcRenderer.invoke("db-get-pending-note-deletes"),
  getNoteByClientId: (clientNoteId) => ipcRenderer.invoke("db-get-note-by-client-id", clientNoteId),
  upsertNoteFromCloud: (cloudNote, localFolderId) =>
    ipcRenderer.invoke("db-upsert-note-from-cloud", cloudNote, localFolderId),
  markNoteSynced: (id, cloudId) => ipcRenderer.invoke("db-mark-note-synced", id, cloudId),
  markNoteSyncError: (id) => ipcRenderer.invoke("db-mark-note-sync-error", id),
  hardDeleteNote: (id) => ipcRenderer.invoke("db-hard-delete-note", id),

  getPendingFolders: () => ipcRenderer.invoke("db-get-pending-folders"),
  getFolderByClientId: (clientFolderId) =>
    ipcRenderer.invoke("db-get-folder-by-client-id", clientFolderId),
  upsertFolderFromCloud: (cloudFolder) =>
    ipcRenderer.invoke("db-upsert-folder-from-cloud", cloudFolder),
  markFolderSynced: (id, cloudId) => ipcRenderer.invoke("db-mark-folder-synced", id, cloudId),
  getFolderIdMap: () => ipcRenderer.invoke("db-get-folder-id-map"),
  getPendingFolderDeletes: () => ipcRenderer.invoke("db-get-pending-folder-deletes"),
  hardDeleteFolder: (id) => ipcRenderer.invoke("db-hard-delete-folder", id),

  getPendingConversations: () => ipcRenderer.invoke("db-get-pending-conversations"),
  getPendingConversationDeletes: () => ipcRenderer.invoke("db-get-pending-conversation-deletes"),
  getConversationByClientId: (clientId) =>
    ipcRenderer.invoke("db-get-conversation-by-client-id", clientId),
  upsertConversationFromCloud: (cloudConv, messages) =>
    ipcRenderer.invoke("db-upsert-conversation-from-cloud", cloudConv, messages),
  markConversationSynced: (id, cloudId) =>
    ipcRenderer.invoke("db-mark-conversation-synced", id, cloudId),
  hardDeleteConversation: (id) => ipcRenderer.invoke("db-hard-delete-conversation", id),

  getPendingTranscriptions: () => ipcRenderer.invoke("db-get-pending-transcriptions"),
  getTranscriptionByClientId: (clientId) =>
    ipcRenderer.invoke("db-get-transcription-by-client-id", clientId),
  upsertTranscriptionFromCloud: (cloudTranscription) =>
    ipcRenderer.invoke("db-upsert-transcription-from-cloud", cloudTranscription),
  markTranscriptionSynced: (id, cloudId) =>
    ipcRenderer.invoke("db-mark-transcription-synced", id, cloudId),
  getPendingTranscriptionDeletes: () => ipcRenderer.invoke("db-get-pending-transcription-deletes"),
  hardDeleteTranscription: (id) => ipcRenderer.invoke("db-hard-delete-transcription", id),

  // Google Calendar
  gcalStartOAuth: () => ipcRenderer.invoke("gcal-start-oauth"),
  gcalDisconnect: () => ipcRenderer.invoke("gcal-disconnect"),
  gcalGetConnectionStatus: () => ipcRenderer.invoke("gcal-get-connection-status"),
  gcalGetCalendars: () => ipcRenderer.invoke("gcal-get-calendars"),
  gcalSetCalendarSelection: (calendarId, isSelected) =>
    ipcRenderer.invoke("gcal-set-calendar-selection", calendarId, isSelected),
  gcalSyncEvents: () => ipcRenderer.invoke("gcal-sync-events"),
  gcalGetUpcomingEvents: (windowMinutes) =>
    ipcRenderer.invoke("gcal-get-upcoming-events", windowMinutes),
  gcalGetEvent: (eventId) => ipcRenderer.invoke("gcal-get-event", eventId),

  // Contacts
  searchContacts: (query) => ipcRenderer.invoke("search-contacts", query),
  upsertContact: (contact) => ipcRenderer.invoke("upsert-contact", contact),
  getMD5Hash: (text) => ipcRenderer.invoke("get-md5-hash", text),

  // Google Calendar event listeners
  onGcalMeetingStarting: registerListener(
    "gcal-meeting-starting",
    (callback) => (_event, data) => callback(data)
  ),
  onGcalMeetingEnded: registerListener(
    "gcal-meeting-ended",
    (callback) => (_event, data) => callback(data)
  ),
  onGcalStartRecording: registerListener(
    "gcal-start-recording",
    (callback) => (_event, data) => callback(data)
  ),
  onGcalConnectionChanged: registerListener(
    "gcal-connection-changed",
    (callback) => (_event, data) => callback(data)
  ),
  onGcalEventsSynced: registerListener(
    "gcal-events-synced",
    (callback) => (_event, data) => callback(data)
  ),

  // Meeting detection
  meetingDetectionGetPreferences: () => ipcRenderer.invoke("meeting-detection-get-preferences"),
  meetingDetectionSetPreferences: (prefs) =>
    ipcRenderer.invoke("meeting-detection-set-preferences", prefs),
  setSpeakerDiarizationEnabled: (enabled) =>
    ipcRenderer.invoke("meeting-set-speaker-diarization-enabled", { enabled }),
  setMeetingSessionSpeakerConfig: (config) =>
    ipcRenderer.invoke("meeting-set-session-speaker-config", config),
  onMeetingDetected: registerListener(
    "meeting-detected",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingDetectedStartRecording: registerListener(
    "meeting-detected-start-recording",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingNotificationData: registerListener(
    "meeting-notification-data",
    (callback) => (_event, data) => callback(data)
  ),
  getMeetingNotificationData: () => ipcRenderer.invoke("get-meeting-notification-data"),
  meetingNotificationReady: () => ipcRenderer.invoke("meeting-notification-ready"),
  meetingNotificationRespond: (detectionId, action) =>
    ipcRenderer.invoke("meeting-notification-respond", detectionId, action),
  joinCalendarMeeting: (eventId) => ipcRenderer.invoke("join-calendar-meeting", eventId),
  onNavigateToMeetingNote: registerListener(
    "navigate-to-meeting-note",
    (callback) => (_event, data) => callback(data)
  ),
  onNavigateToNote: registerListener(
    "navigate-to-note",
    (callback) => (_event, data) => callback(data)
  ),

  onUpdateNotificationData: registerListener(
    "update-notification-data",
    (callback) => (_event, data) => callback(data)
  ),
  getUpdateNotificationData: () => ipcRenderer.invoke("get-update-notification-data"),
  updateNotificationReady: () => ipcRenderer.invoke("update-notification-ready"),
  updateNotificationRespond: (action) => ipcRenderer.invoke("update-notification-respond", action),
});
