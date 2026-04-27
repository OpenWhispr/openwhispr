export type LocalTranscriptionProvider = "whisper" | "nvidia";

export type InferenceMode = "openwhispr" | "providers" | "local" | "self-hosted" | "enterprise";

export type SelfHostedType = "openai-compatible" | "lan";

export type TranscriptionStatus = "completed" | "failed" | "pending";

export type TranscriptionErrorCode =
  | "TIMEOUT"
  | "NETWORK"
  | "SERVER_ERROR"
  | "OFFLINE"
  | "AUTH_EXPIRED"
  | "AUTH_REQUIRED"
  | "LIMIT_REACHED"
  | "API_KEY_MISSING"
  | "INVALID_KEY"
  | "MODEL_NOT_AVAILABLE"
  | null;

export interface TranscriptionItem {
  id: number;
  text: string;
  raw_text: string | null;
  timestamp: string;
  created_at: string;
  has_audio: number;
  audio_duration_ms: number | null;
  provider: string | null;
  model: string | null;
  status: TranscriptionStatus;
  error_message: string | null;
  error_code: TranscriptionErrorCode;
  client_transcription_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

export interface NoteItem {
  id: number;
  title: string;
  content: string;
  enhanced_content: string | null;
  enhancement_prompt: string | null;
  enhanced_at_content_hash: string | null;
  note_type: "personal" | "meeting" | "upload";
  source_file: string | null;
  audio_duration_seconds: number | null;
  folder_id: number | null;
  transcript: string | null;
  calendar_event_id: string | null;
  participants: string | null;
  cloud_id: string | null;
  created_at: string;
  updated_at: string;
  client_note_id: string;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

export interface FolderItem {
  id: number;
  name: string;
  is_default: number;
  sort_order: number;
  created_at: string;
  client_folder_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

export interface ActionItem {
  id: number;
  name: string;
  description: string;
  prompt: string;
  icon: string;
  is_builtin: number;
  sort_order: number;
  translation_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface GpuDevice {
  index: number;
  name: string;
  vramMb: number;
}

export interface GpuInfo {
  hasNvidiaGpu: boolean;
  gpuName?: string;
  driverVersion?: string;
  vramMb?: number;
}

export interface CudaWhisperStatus {
  downloaded: boolean;
  path: string | null;
  gpuInfo: GpuInfo;
}

export interface WhisperCheckResult {
  installed: boolean;
  working: boolean;
  error?: string;
}

export interface WhisperModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  size_mb?: number;
  error?: string;
  code?: string;
}

export interface WhisperModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_mb?: number;
  error?: string;
}

export interface WhisperModelsListResult {
  success: boolean;
  models: Array<{ model: string; downloaded: boolean; size_mb?: number }>;
  cache_dir: string;
}

export interface FFmpegAvailabilityResult {
  available: boolean;
  path?: string;
  error?: string;
}

export interface AudioDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  ffmpeg: { available: boolean; path: string | null; error: string | null };
  whisperBinary: { available: boolean; path: string | null; error: string | null };
  whisperServer: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export type SystemAudioMode = "native" | "loopback" | "portal" | "unsupported";
export type SystemAudioStrategy =
  | "native"
  | "loopback"
  | "browser-portal"
  | "portal-helper"
  | "unsupported";

export interface SystemAudioAccessResult {
  granted: boolean;
  status: "granted" | "denied" | "not-determined" | "restricted" | "unknown" | "unsupported";
  mode: SystemAudioMode;
  supportsPersistentGrant?: boolean;
  supportsPersistentPortalGrant?: boolean;
  supportsNativeCapture?: boolean;
  supportsOnboardingGrant?: boolean;
  requiresRuntimeSharePrompt?: boolean;
  strategy?: SystemAudioStrategy;
  restoreTokenAvailable?: boolean;
  portalVersion?: number | null;
  error?: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  version?: string;
  releaseDate?: string;
  files?: any[];
  releaseNotes?: string;
  message?: string;
}

export interface UpdateStatusResult {
  updateAvailable: boolean;
  updateDownloaded: boolean;
  isDevelopment: boolean;
}

export interface UpdateInfoResult {
  version?: string;
  releaseDate?: string;
  releaseNotes?: string | null;
  files?: any[];
}

export interface UpdateResult {
  success: boolean;
  message: string;
}

export interface AppVersionResult {
  version: string;
}

export interface WhisperDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
  result?: any;
}

export interface ParakeetCheckResult {
  installed: boolean;
  working: boolean;
  path?: string;
}

export interface ParakeetModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  path?: string;
  size_bytes?: number;
  size_mb?: number;
  error?: string;
  code?: string;
}

export interface ParakeetModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_bytes?: number;
  freed_mb?: number;
  error?: string;
}

export interface ParakeetModelsListResult {
  success: boolean;
  models: Array<{ model: string; downloaded: boolean; size_mb?: number }>;
  cache_dir: string;
}

export interface ParakeetDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
}

export interface ParakeetTranscriptionResult {
  success: boolean;
  text?: string;
  message?: string;
  error?: string;
}

export interface ParakeetDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  sherpaOnnx: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export interface PasteToolsResult {
  platform: "darwin" | "win32" | "linux";
  available: boolean;
  method: string | null;
  requiresPermission: boolean;
  isWayland?: boolean;
  xwaylandAvailable?: boolean;
  terminalAware?: boolean;
  hasNativeBinary?: boolean;
  hasUinput?: boolean;
  tools?: string[];
  recommendedInstall?: string;
}

export type GpuBackend = "vulkan" | "cpu" | "metal" | null;

export interface LlamaServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  modelPath: string | null;
  modelName: string | null;
  backend: GpuBackend;
  gpuAccelerated: boolean;
}

export interface VulkanGpuResult {
  available: boolean;
  deviceName?: string;
  reason?: string;
  error?: string;
}

export interface LlamaVulkanStatus {
  supported: boolean;
  downloaded: boolean;
  downloading?: boolean;
  error?: string;
}

export interface LlamaVulkanDownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
}

export interface ConversationPreview {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
  cloud_id?: string | null;
  client_conversation_id?: string;
  sync_status?: "synced" | "pending" | "error";
  deleted_at?: string | null;
  message_count: number;
  last_message?: string | null;
  last_message_role?: "user" | "assistant" | "system" | null;
}

export interface ReferralItem {
  id: string;
  email: string;
  name: string | null;
  status: "pending" | "completed" | "rewarded";
  created_at: string;
  first_payment_at: string | null;
}

declare global {
  interface Window {
    electronAPI: {
      // Basic window operations
      pasteText: (
        text: string,
        options?: {
          fromStreaming?: boolean;
          restoreClipboard?: boolean;
          allowClipboardFallback?: boolean;
        }
      ) => Promise<void>;
      hideWindow: () => Promise<void>;
      showDictationPanel: () => Promise<void>;
      onToggleDictation: (callback: () => void) => () => void;
      onStartDictation?: (callback: () => void) => () => void;
      onStopDictation?: (callback: () => void) => () => void;

      // STT config
      getSttConfig?: () => Promise<{
        success: boolean;
        dictation: { mode: string };
        notes: { mode: string };
        streamingProvider: string;
      } | null>;

      getNoteRecordingConfig?: () => Promise<{
        success: boolean;
        providers: Array<{
          id: string;
          name: string;
          models: Array<{ id: string; name: string; default?: boolean }>;
        }>;
      } | null>;

      // Database operations
      saveTranscription: (
        text: string,
        rawText?: string | null,
        options?: {
          status?: TranscriptionStatus;
          errorMessage?: string | null;
          errorCode?: TranscriptionErrorCode;
        }
      ) => Promise<{ id: number; success: boolean; transcription?: TranscriptionItem }>;
      getTranscriptions: (limit?: number) => Promise<TranscriptionItem[]>;
      clearTranscriptions: () => Promise<{ cleared: number; success: boolean }>;
      deleteTranscription: (id: number) => Promise<{ success: boolean }>;
      getTranscriptionById: (id: number) => Promise<TranscriptionItem | null>;

      // Audio retention operations
      saveTranscriptionAudio: (
        id: number,
        audioBuffer: ArrayBuffer,
        metadata?: { durationMs?: number; provider?: string; model?: string }
      ) => Promise<{ success: boolean; path?: string }>;
      getAudioPath: (id: number) => Promise<string | null>;
      showAudioInFolder: (id: number) => Promise<{ success: boolean }>;
      getAudioBuffer: (id: number) => Promise<ArrayBuffer | null>;
      deleteTranscriptionAudio: (id: number) => Promise<{ success: boolean }>;
      getAudioStorageUsage: () => Promise<{ fileCount: number; totalBytes: number }>;
      deleteAllAudio: () => Promise<{ deleted: number }>;
      retryTranscription: (
        id: number,
        settings?: {
          useLocalWhisper: boolean;
          localTranscriptionProvider: string;
          cloudTranscriptionMode: string;
          cloudTranscriptionProvider: string;
          cloudTranscriptionModel: string;
          cloudTranscriptionBaseUrl?: string;
          parakeetModel: string;
          whisperModel: string;
          transcriptionMode?: InferenceMode;
          remoteTranscriptionType?: SelfHostedType;
          remoteTranscriptionUrl?: string;
        }
      ) => Promise<{
        success: boolean;
        transcription?: TranscriptionItem;
        error?: string;
        code?: TranscriptionErrorCode;
      }>;
      updateTranscriptionText: (
        id: number,
        text: string,
        rawText: string
      ) => Promise<{ success: boolean; transcription?: TranscriptionItem; error?: string }>;

      // Dictionary operations
      getDictionary: () => Promise<string[]>;
      setDictionary: (words: string[]) => Promise<{ success: boolean }>;
      onDictionaryUpdated?: (callback: (words: string[]) => void) => () => void;
      setAutoLearnEnabled?: (enabled: boolean) => void;
      onCorrectionsLearned?: (callback: (words: string[]) => void) => () => void;
      undoLearnedCorrections?: (words: string[]) => Promise<{ success: boolean }>;

      // Note operations
      saveNote: (
        title: string,
        content: string,
        noteType?: string,
        sourceFile?: string | null,
        audioDuration?: number | null,
        folderId?: number | null
      ) => Promise<{ success: boolean; note?: NoteItem }>;
      getNote: (id: number) => Promise<NoteItem | null>;
      getNotes: (
        noteType?: string | null,
        limit?: number,
        folderId?: number | null
      ) => Promise<NoteItem[]>;
      updateNote: (
        id: number,
        updates: {
          title?: string;
          content?: string;
          enhanced_content?: string | null;
          enhancement_prompt?: string | null;
          enhanced_at_content_hash?: string | null;
          folder_id?: number | null;
          transcript?: string | null;
          calendar_event_id?: string | null;
          participants?: string | null;
        }
      ) => Promise<{ success: boolean; note?: NoteItem }>;
      deleteNote: (id: number) => Promise<{ success: boolean }>;
      exportNote: (
        noteId: number,
        format: "txt" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      exportTranscript: (
        noteId: number,
        format: "txt" | "srt" | "json" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      searchNotes: (query: string, limit?: number) => Promise<NoteItem[]>;
      semanticSearchNotes: (query: string, limit?: number) => Promise<NoteItem[]>;
      semanticReindexAll: () => Promise<{ success: boolean; indexed?: number; error?: string }>;
      onSemanticReindexProgress: (
        callback: (data: { done: number; total: number }) => void
      ) => () => void;
      updateNoteCloudId: (id: number, cloudId: string) => Promise<NoteItem>;

      // Folder operations
      getFolders: () => Promise<FolderItem[]>;
      createFolder: (
        name: string
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      deleteFolder: (id: number) => Promise<{ success: boolean; error?: string }>;
      renameFolder: (
        id: number,
        name: string
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      getFolderNoteCounts: () => Promise<Array<{ folder_id: number; count: number }>>;

      // Note files (markdown mirror)
      noteFilesSetEnabled?: (
        enabled: boolean,
        customPath?: string,
        options?: { skipRebuild?: boolean }
      ) => Promise<{ success: boolean; error?: string }>;
      noteFilesSetPath?: (path: string) => Promise<{ success: boolean; error?: string }>;
      noteFilesRebuild?: () => Promise<{ success: boolean; error?: string }>;
      noteFilesGetDefaultPath?: () => Promise<string>;
      noteFilesPickFolder?: () => Promise<{ canceled: boolean; path?: string }>;
      showNoteFile?: (noteId: number) => Promise<{ success: boolean }>;
      showFolderInExplorer?: (folderName: string) => Promise<{ success: boolean }>;

      // Action operations
      getActions: () => Promise<ActionItem[]>;
      getAction: (id: number) => Promise<ActionItem | null>;
      createAction: (
        name: string,
        description: string,
        prompt: string,
        icon?: string
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      updateAction: (
        id: number,
        updates: {
          name?: string;
          description?: string;
          prompt?: string;
          icon?: string;
          sort_order?: number;
        }
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      deleteAction: (id: number) => Promise<{ success: boolean; id?: number; error?: string }>;
      onActionCreated?: (callback: (action: ActionItem) => void) => () => void;
      onActionUpdated?: (callback: (action: ActionItem) => void) => () => void;
      onActionDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Audio file operations
      selectAudioFile: () => Promise<{ canceled: boolean; filePath?: string }>;
      getFileSize?: (filePath: string) => Promise<number>;
      transcribeAudioFile: (
        filePath: string,
        options?: {
          provider?: "whisper" | "nvidia";
          model?: string;
          language?: string;
          [key: string]: unknown;
        }
      ) => Promise<{ success: boolean; text?: string; error?: string }>;
      getPathForFile: (file: File) => string;

      // Note event listeners
      onNoteAdded?: (callback: (note: NoteItem) => void) => () => void;
      onNoteUpdated?: (callback: (note: NoteItem) => void) => () => void;
      onNoteDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Database event listeners
      onTranscriptionAdded?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionUpdated?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionDeleted?: (callback: (payload: { id: number }) => void) => () => void;
      onTranscriptionsCleared?: (callback: (payload: { cleared: number }) => void) => () => void;

      // API key management
      getOpenAIKey: () => Promise<string>;
      saveOpenAIKey: (key: string) => Promise<{ success: boolean }>;
      createProductionEnvFile: (key: string) => Promise<void>;
      getAnthropicKey: () => Promise<string | null>;
      saveAnthropicKey: (key: string) => Promise<void>;
      getUiLanguage: () => Promise<string>;
      saveUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      setUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      saveAllKeysToEnv: () => Promise<{ success: boolean; path: string }>;
      syncStartupPreferences: (prefs: {
        useLocalWhisper: boolean;
        localTranscriptionProvider: LocalTranscriptionProvider;
        model?: string;
        cleanupProvider: string;
        cleanupModel?: string;
        dictationAgentProvider: string;
        dictationAgentModel?: string;
      }) => Promise<void>;

      // Clipboard operations
      checkAccessibilityPermission: (silent?: boolean) => Promise<boolean>;
      promptAccessibilityPermission: () => Promise<boolean>;
      readClipboard: () => Promise<string>;
      writeClipboard: (text: string) => Promise<{ success: boolean }>;
      checkPasteTools: () => Promise<PasteToolsResult>;

      // Audio
      onNoAudioDetected: (callback: (event: any, data?: any) => void) => () => void;

      // Whisper operations (whisper.cpp)
      transcribeLocalWhisper: (audioBlob: Blob | ArrayBuffer, options?: any) => Promise<any>;
      checkWhisperInstallation: () => Promise<WhisperCheckResult>;
      downloadWhisperModel: (modelName: string) => Promise<WhisperModelResult>;
      onWhisperDownloadProgress: (
        callback: (event: any, data: WhisperDownloadProgressData) => void
      ) => () => void;
      checkModelStatus: (modelName: string) => Promise<WhisperModelResult>;
      listWhisperModels: () => Promise<WhisperModelsListResult>;
      deleteWhisperModel: (modelName: string) => Promise<WhisperModelDeleteResult>;
      deleteAllWhisperModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelWhisperDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;

      // CUDA GPU acceleration
      listGpus?: () => Promise<GpuDevice[]>;
      setGpuDeviceIndex?: (
        purpose: "transcription" | "intelligence",
        index: number
      ) => Promise<{ success: boolean }>;
      getGpuDeviceIndex?: (purpose: "transcription" | "intelligence") => Promise<string>;
      detectGpu: () => Promise<GpuInfo>;
      getCudaWhisperStatus: () => Promise<CudaWhisperStatus>;
      downloadCudaWhisperBinary: () => Promise<{ success: boolean; error?: string }>;
      cancelCudaWhisperDownload: () => Promise<{ success: boolean }>;
      deleteCudaWhisperBinary: () => Promise<{ success: boolean }>;
      onCudaDownloadProgress: (
        callback: (data: {
          downloadedBytes: number;
          totalBytes: number;
          percentage: number;
        }) => void
      ) => () => void;
      onCudaFallbackNotification: (callback: () => void) => () => void;

      // Parakeet operations (NVIDIA via sherpa-onnx)
      transcribeLocalParakeet: (
        audioBlob: ArrayBuffer,
        options?: { model?: string; language?: string }
      ) => Promise<ParakeetTranscriptionResult>;
      checkParakeetInstallation: () => Promise<ParakeetCheckResult>;
      downloadParakeetModel: (modelName: string) => Promise<ParakeetModelResult>;
      onParakeetDownloadProgress: (
        callback: (event: any, data: ParakeetDownloadProgressData) => void
      ) => () => void;
      checkParakeetModelStatus: (modelName: string) => Promise<ParakeetModelResult>;
      listParakeetModels: () => Promise<ParakeetModelsListResult>;
      deleteParakeetModel: (modelName: string) => Promise<ParakeetModelDeleteResult>;
      deleteAllParakeetModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelParakeetDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      getParakeetDiagnostics: () => Promise<ParakeetDiagnosticsResult>;

      // Local AI model management
      modelGetAll: () => Promise<any[]>;
      modelCheck: (modelId: string) => Promise<boolean>;
      modelDownload: (modelId: string) => Promise<{
        success: boolean;
        path?: string;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelDelete: (modelId: string) => Promise<{
        success: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelDeleteAll: () => Promise<{
        success: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelCheckRuntime: () => Promise<{
        available: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelCancelDownload: (modelId: string) => Promise<{ success: boolean; error?: string }>;
      onModelDownloadProgress: (callback: (event: any, data: any) => void) => () => void;

      // Local reasoning
      processLocalReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string }>;
      checkLocalReasoningAvailable: () => Promise<boolean>;

      // Anthropic reasoning
      processAnthropicReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string }>;

      // Enterprise reasoning (Bedrock, Azure, Vertex)
      processEnterpriseReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string; retryable?: boolean }>;

      // llama.cpp management
      llamaCppCheck: () => Promise<{ isInstalled: boolean; version?: string }>;
      llamaCppInstall: () => Promise<{ success: boolean; error?: string }>;
      llamaCppUninstall: () => Promise<{ success: boolean; error?: string }>;

      // llama-server
      llamaServerStart: (
        modelId: string
      ) => Promise<{ success: boolean; port?: number; error?: string }>;
      llamaServerStop: () => Promise<{ success: boolean; error?: string }>;
      llamaServerStatus: () => Promise<LlamaServerStatus>;
      llamaGpuReset: () => Promise<{ success: boolean; error?: string }>;
      detectVulkanGpu?: () => Promise<VulkanGpuResult>;
      getLlamaVulkanStatus?: () => Promise<LlamaVulkanStatus>;
      downloadLlamaVulkanBinary?: () => Promise<{
        success: boolean;
        cancelled?: boolean;
        error?: string;
      }>;
      cancelLlamaVulkanDownload?: () => Promise<{ success: boolean }>;
      deleteLlamaVulkanBinary?: () => Promise<{
        success: boolean;
        deletedCount?: number;
        error?: string;
      }>;
      onLlamaVulkanDownloadProgress?: (
        callback: (data: LlamaVulkanDownloadProgress) => void
      ) => () => void;

      // Window control operations
      windowMinimize: () => Promise<void>;
      windowMaximize: () => Promise<void>;
      windowClose: () => Promise<void>;
      windowIsMaximized: () => Promise<boolean>;
      restoreFromMeetingMode: () => Promise<void>;
      getPlatform: () => string;
      startWindowDrag: () => Promise<void>;
      stopWindowDrag: () => Promise<void>;
      setMainWindowInteractivity: (interactive: boolean) => Promise<void>;
      setNotificationInteractivity: (interactive: boolean) => Promise<void>;

      // App management
      appQuit: () => Promise<void>;
      cleanupApp: () => Promise<{ success: boolean; message: string; errors?: string[] }>;

      // Update operations
      checkForUpdates: () => Promise<UpdateCheckResult>;
      downloadUpdate: () => Promise<UpdateResult>;
      installUpdate: () => Promise<UpdateResult>;
      getAppVersion: () => Promise<AppVersionResult>;
      getPostMigrationState: () => Promise<{ justMigrated: boolean }>;
      markBundleMigrated: () => Promise<void>;
      getUpdateStatus: () => Promise<UpdateStatusResult>;
      getUpdateInfo: () => Promise<UpdateInfoResult | null>;

      // Update event listeners
      onUpdateAvailable: (callback: (event: any, info: any) => void) => () => void;
      onUpdateNotAvailable: (callback: (event: any, info: any) => void) => () => void;
      onUpdateDownloaded: (callback: (event: any, info: any) => void) => () => void;
      onUpdateDownloadProgress: (callback: (event: any, progressObj: any) => void) => () => void;
      onUpdateError: (callback: (event: any, error: any) => void) => () => void;

      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;

      // Hotkey management
      updateHotkey: (key: string) => Promise<{ success: boolean; message: string }>;
      setHotkeyListeningMode?: (
        enabled: boolean,
        newHotkey?: string | null
      ) => Promise<{ success: boolean }>;
      getHotkeyModeInfo?: () => Promise<{
        isUsingGnome: boolean;
        isUsingHyprland: boolean;
        isUsingNativeShortcut: boolean;
        supportsPushToTalk: boolean;
      }>;

      // Wayland paste diagnostics
      getYdotoolStatus?: () => Promise<{
        isLinux: boolean;
        isWayland: boolean;
        hasYdotool: boolean;
        hasYdotoold: boolean;
        daemonRunning: boolean;
        hasService: boolean;
        hasUinput: boolean;
        hasUdevRule: boolean;
        hasGroup: boolean;
        allGood: boolean;
      }>;

      // Globe key listener for hotkey capture (macOS only)
      onGlobeKeyPressed?: (callback: () => void) => () => void;
      onGlobeKeyReleased?: (callback: () => void) => () => void;

      // Hotkey registration events
      onHotkeyFallbackUsed?: (
        callback: (data: { original: string; fallback: string }) => void
      ) => () => void;
      onHotkeyRegistrationFailed?: (
        callback: (data: { hotkey: string; error: string; suggestions: string[] }) => void
      ) => () => void;
      onSettingUpdated?: (callback: (data: { key: string; value: unknown }) => void) => () => void;
      onDictationKeyActive?: (callback: (key: string) => void) => () => void;
      onLinuxPttPermissionDenied?: (callback: () => void) => () => void;

      // Settings shortcut (Cmd+, / Ctrl+,)
      onShowSettings?: (callback: () => void) => () => void;

      // Accessibility permission events (macOS)
      onAccessibilityMissing?: (callback: () => void) => () => void;
      checkAccessibilityTrusted?: () => Promise<boolean>;

      // Gemini API key management
      getGeminiKey: () => Promise<string | null>;
      saveGeminiKey: (key: string) => Promise<void>;

      // Groq API key management
      getGroqKey: () => Promise<string | null>;
      saveGroqKey: (key: string) => Promise<void>;

      // Mistral API key management
      getMistralKey: () => Promise<string | null>;
      saveMistralKey: (key: string) => Promise<void>;
      proxyMistralTranscription: (data: {
        audioBuffer: ArrayBuffer;
        model?: string;
        language?: string;
        contextBias?: string[];
      }) => Promise<{ text: string }>;

      // Custom endpoint API keys
      getCustomTranscriptionKey?: () => Promise<string | null>;
      saveCustomTranscriptionKey?: (key: string) => Promise<void>;
      getCustomReasoningKey?: () => Promise<string | null>;
      saveCustomReasoningKey?: (key: string) => Promise<void>;

      // Enterprise provider key persistence
      getBedrockRegion?: () => Promise<string | null>;
      saveBedrockRegion?: (value: string) => Promise<void>;
      getBedrockProfile?: () => Promise<string | null>;
      saveBedrockProfile?: (value: string) => Promise<void>;
      getBedrockAccessKeyId?: () => Promise<string | null>;
      saveBedrockAccessKeyId?: (key: string) => Promise<void>;
      getBedrockSecretAccessKey?: () => Promise<string | null>;
      saveBedrockSecretAccessKey?: (key: string) => Promise<void>;
      getBedrockSessionToken?: () => Promise<string | null>;
      saveBedrockSessionToken?: (key: string) => Promise<void>;
      getAzureEndpoint?: () => Promise<string | null>;
      saveAzureEndpoint?: (value: string) => Promise<void>;
      getAzureApiKey?: () => Promise<string | null>;
      saveAzureApiKey?: (key: string) => Promise<void>;
      getAzureDeployment?: () => Promise<string | null>;
      saveAzureDeployment?: (value: string) => Promise<void>;
      getAzureApiVersion?: () => Promise<string | null>;
      saveAzureApiVersion?: (value: string) => Promise<void>;
      getVertexProject?: () => Promise<string | null>;
      saveVertexProject?: (value: string) => Promise<void>;
      getVertexLocation?: () => Promise<string | null>;
      saveVertexLocation?: (value: string) => Promise<void>;
      getVertexApiKey?: () => Promise<string | null>;
      saveVertexApiKey?: (key: string) => Promise<void>;
      testEnterpriseConnection?: (
        provider: string,
        config: Record<string, string>
      ) => Promise<{ success: boolean; error?: string; action?: string; copyCommand?: string }>;

      // Dictation key persistence (file-based for reliable startup)
      getDictationKey?: () => Promise<string | null>;
      getActiveDictationKey?: () => Promise<string>;
      getEffectiveDefaultHotkey?: () => Promise<string>;
      saveDictationKey?: (key: string) => Promise<void>;

      // Activation mode persistence (file-based for reliable startup)
      getActivationMode?: () => Promise<"tap" | "push">;
      saveActivationMode?: (mode: "tap" | "push") => Promise<void>;

      // Debug logging
      getLogLevel?: () => Promise<string>;
      log?: (entry: {
        level: string;
        message: string;
        meta?: any;
        scope?: string;
        source?: string;
      }) => Promise<void>;
      getDebugState: () => Promise<{
        enabled: boolean;
        logPath: string | null;
        logLevel: string;
      }>;
      setDebugLogging: (enabled: boolean) => Promise<{
        success: boolean;
        enabled?: boolean;
        logPath?: string | null;
        error?: string;
      }>;
      openLogsFolder: () => Promise<{ success: boolean; error?: string }>;

      // FFmpeg availability
      checkFFmpegAvailability: () => Promise<FFmpegAvailabilityResult>;
      getAudioDiagnostics: () => Promise<AudioDiagnosticsResult>;

      // System settings helpers
      requestMicrophoneAccess?: () => Promise<{ granted: boolean }>;
      checkMicrophoneAccess?: () => Promise<{ granted: boolean; status: string }>;
      checkSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      requestSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      openMicrophoneSettings?: () => Promise<{ success: boolean; error?: string }>;
      openSoundInputSettings?: () => Promise<{ success: boolean; error?: string }>;
      openAccessibilitySettings?: () => Promise<{ success: boolean; error?: string }>;
      openSystemAudioSettings?: () => Promise<{ success: boolean; error?: string }>;
      toggleMediaPlayback?: () => Promise<boolean>;
      pauseMediaPlayback?: () => Promise<boolean>;
      resumeMediaPlayback?: () => Promise<boolean>;
      openWhisperModelsFolder?: () => Promise<{ success: boolean; error?: string }>;

      // Windows Push-to-Talk notifications
      notifyActivationModeChanged?: (mode: "tap" | "push") => void;
      notifyHotkeyChanged?: (hotkey: string) => void;
      registerMeetingHotkey?: (hotkey: string) => Promise<{ success: boolean; message?: string }>;
      notifyFloatingIconAutoHideChanged?: (enabled: boolean) => void;
      onFloatingIconAutoHideChanged?: (callback: (enabled: boolean) => void) => () => void;
      notifyStartMinimizedChanged?: (enabled: boolean) => void;
      notifyPanelStartPositionChanged?: (position: string) => void;

      // Auto-start at login
      getAutoStartEnabled?: () => Promise<boolean>;
      setAutoStartEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

      // Auth
      authClearSession?: () => Promise<void>;

      // OpenWhispr Cloud API
      cloudTranscribe?: (
        audioBuffer: ArrayBuffer,
        opts: { language?: string; prompt?: string; useCase?: string; diarization?: boolean }
      ) => Promise<{
        success: boolean;
        text?: string;
        wordsUsed?: number;
        wordsRemaining?: number;
        limitReached?: boolean;
        error?: string;
        code?: string;
      }>;
      cloudReason?: (
        text: string,
        opts: {
          model?: string;
          agentName?: string;
          customDictionary?: string[];
          customPrompt?: string;
          systemPrompt?: string;
          language?: string;
          locale?: string;
        }
      ) => Promise<{
        success: boolean;
        text?: string;
        model?: string;
        provider?: string;
        promptMode?: string;
        matchType?: string;
        error?: string;
        code?: string;
      }>;
      cloudStreamingUsage?: (
        text: string,
        audioDurationSeconds: number,
        opts?: {
          sendLogs?: boolean;
          sttProvider?: string;
          sttModel?: string;
          sttProcessingMs?: number;
          sttLanguage?: string;
          audioSizeBytes?: number;
          audioFormat?: string;
          clientTotalMs?: number;
        }
      ) => Promise<{
        success: boolean;
        wordsUsed?: number;
        wordsRemaining?: number;
        limitReached?: boolean;
        error?: string;
        code?: string;
      }>;
      cloudUsage?: () => Promise<{
        success: boolean;
        wordsUsed?: number;
        wordsRemaining?: number;
        limit?: number;
        plan?: string;
        status?: string;
        isSubscribed?: boolean;
        isTrial?: boolean;
        trialDaysLeft?: number | null;
        currentPeriodEnd?: string | null;
        billingInterval?: "monthly" | "annual" | null;
        resetAt?: string;
        error?: string;
        code?: string;
      }>;
      cloudCheckout?: (opts?: {
        plan?: "monthly" | "annual";
        tier?: "pro" | "business";
      }) => Promise<{
        success: boolean;
        url?: string;
        error?: string;
        code?: string;
      }>;
      cloudBillingPortal?: () => Promise<{
        success: boolean;
        url?: string;
        error?: string;
        code?: string;
      }>;
      cloudSwitchPlan?: (opts: {
        plan: "monthly" | "annual";
        tier: "pro" | "business";
      }) => Promise<{
        success: boolean;
        alreadyOnPlan?: boolean;
        error?: string;
      }>;
      cloudPreviewSwitch?: (opts: {
        plan: "monthly" | "annual";
        tier: "pro" | "business";
      }) => Promise<{
        success: boolean;
        immediateAmount?: number;
        currency?: string;
        currentPriceAmount?: number;
        currentInterval?: string;
        newPriceAmount?: number;
        newInterval?: string;
        nextBillingDate?: string;
        alreadyOnPlan?: boolean;
        error?: string;
      }>;

      // Authenticated cloud API proxy
      cloudApiRequest?: (opts: { method?: string; path: string; body?: unknown }) => Promise<{
        success: boolean;
        data?: unknown;
        error?: string;
        code?: string;
      }>;

      // Cloud audio file transcription
      transcribeAudioFileCloud?: (filePath: string) => Promise<{
        success: boolean;
        text?: string;
        error?: string;
        code?: string;
      }>;

      onUploadTranscriptionProgress?: (
        callback: (data: { stage: string; chunksTotal: number; chunksCompleted: number }) => void
      ) => () => void;

      // BYOK audio file transcription
      transcribeAudioFileByok?: (options: {
        filePath: string;
        apiKey: string;
        baseUrl: string;
        model: string;
      }) => Promise<{
        success: boolean;
        text?: string;
        error?: string;
      }>;

      // Usage limit events
      notifyLimitReached?: (data: { wordsUsed: number; limit: number }) => void;
      onLimitReached?: (
        callback: (data: { wordsUsed: number; limit: number }) => void
      ) => () => void;

      // AssemblyAI Streaming
      assemblyAiStreamingWarmup?: (options?: {
        sampleRate?: number;
        language?: string;
      }) => Promise<{
        success: boolean;
        alreadyWarm?: boolean;
        error?: string;
        code?: string;
      }>;
      assemblyAiStreamingStart?: (options?: { sampleRate?: number; language?: string }) => Promise<{
        success: boolean;
        usedWarmConnection?: boolean;
        error?: string;
        code?: string;
      }>;
      assemblyAiStreamingSend?: (audioBuffer: ArrayBuffer) => void;
      assemblyAiStreamingForceEndpoint?: () => void;
      assemblyAiStreamingStop?: () => Promise<{
        success: boolean;
        text?: string;
        error?: string;
      }>;
      assemblyAiStreamingStatus?: () => Promise<{
        isConnected: boolean;
        sessionId: string | null;
      }>;
      onAssemblyAiPartialTranscript?: (callback: (text: string) => void) => () => void;
      onAssemblyAiFinalTranscript?: (callback: (text: string) => void) => () => void;
      onAssemblyAiError?: (callback: (error: string) => void) => () => void;
      onAssemblyAiSessionEnd?: (
        callback: (data: { audioDuration?: number; text?: string }) => void
      ) => () => void;

      // Referral stats
      getReferralStats?: () => Promise<{
        referralCode: string;
        referralLink: string;
        totalReferrals: number;
        completedReferrals: number;
        pendingReferrals: number;
        totalMonthsEarned: number;
        referrals: Array<{
          id: string;
          email: string;
          name: string;
          status: "pending" | "completed" | "rewarded";
          created_at: string;
          first_payment_at: string | null;
          words_used: number;
        }>;
      }>;

      sendReferralInvite?: (email: string) => Promise<{
        success: boolean;
        invite: {
          id: string;
          recipientEmail: string;
          status: "sent" | "failed" | "opened" | "converted";
          sentAt: string;
        };
      }>;

      getReferralInvites?: () => Promise<{
        invites: Array<{
          id: string;
          recipientEmail: string;
          status: "sent" | "failed" | "opened" | "converted";
          sentAt: string;
          openedAt?: string;
          convertedAt?: string;
        }>;
      }>;

      // Agent Mode
      updateAgentHotkey?: (hotkey: string) => Promise<{ success: boolean; message: string }>;
      getAgentKey?: () => Promise<string>;
      saveAgentKey?: (key: string) => Promise<void>;
      createAgentConversation?: (
        title: string,
        noteId?: number
      ) => Promise<{
        id: number;
        title: string;
        note_id?: number | null;
        created_at: string;
        updated_at: string;
      }>;
      getConversationsForNote?: (
        noteId: number,
        limit?: number
      ) => Promise<
        Array<{
          id: number;
          title: string;
          created_at: string;
          updated_at: string;
          message_count: number;
        }>
      >;
      getAgentConversations?: (limit?: number) => Promise<
        Array<{
          id: number;
          title: string;
          archived_at?: string;
          cloud_id?: string;
          client_conversation_id?: string;
          created_at: string;
          updated_at: string;
        }>
      >;
      getAgentConversation?: (id: number) => Promise<{
        id: number;
        title: string;
        archived_at?: string;
        cloud_id?: string;
        created_at: string;
        updated_at: string;
        messages: Array<{
          id: number;
          conversation_id: number;
          role: "user" | "assistant" | "system";
          content: string;
          metadata?: string;
          created_at: string;
        }>;
      } | null>;
      deleteAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      updateAgentConversationTitle?: (id: number, title: string) => Promise<{ success: boolean }>;
      addAgentMessage?: (
        conversationId: number,
        role: "user" | "assistant" | "system",
        content: string,
        metadata?: Record<string, unknown>
      ) => Promise<{
        id: number;
        conversation_id: number;
        role: string;
        content: string;
        metadata?: string;
        created_at: string;
      }>;
      getAgentMessages?: (conversationId: number) => Promise<
        Array<{
          id: number;
          conversation_id: number;
          role: "user" | "assistant" | "system";
          content: string;
          metadata?: string;
          created_at: string;
        }>
      >;
      getAgentConversationsWithPreview?: (
        limit?: number,
        offset?: number,
        includeArchived?: boolean
      ) => Promise<ConversationPreview[]>;
      searchAgentConversations?: (query: string, limit?: number) => Promise<ConversationPreview[]>;
      archiveAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      unarchiveAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      updateAgentConversationCloudId?: (
        id: number,
        cloudId: string
      ) => Promise<{ success: boolean }>;
      semanticSearchConversations?: (
        query: string,
        limit?: number
      ) => Promise<ConversationPreview[]>;

      // Deepgram Streaming
      deepgramStreamingWarmup?: (options?: { sampleRate?: number; language?: string }) => Promise<{
        success: boolean;
        alreadyWarm?: boolean;
        error?: string;
        code?: string;
      }>;
      deepgramStreamingStart?: (options?: {
        sampleRate?: number;
        language?: string;
        forceNew?: boolean;
      }) => Promise<{
        success: boolean;
        usedWarmConnection?: boolean;
        error?: string;
        code?: string;
      }>;
      deepgramStreamingSend?: (audioBuffer: ArrayBuffer) => void;
      deepgramStreamingFinalize?: () => void;
      deepgramStreamingStop?: () => Promise<{
        success: boolean;
        text?: string;
        error?: string;
      }>;
      deepgramStreamingStatus?: () => Promise<{
        isConnected: boolean;
        sessionId: string | null;
      }>;
      onDeepgramPartialTranscript?: (callback: (text: string) => void) => () => void;
      onDeepgramFinalTranscript?: (callback: (text: string) => void) => () => void;
      onDeepgramError?: (callback: (error: string) => void) => () => void;
      onDeepgramSessionEnd?: (
        callback: (data: { audioDuration?: number; text?: string }) => void
      ) => () => void;

      // Agent overlay
      resizeAgentWindow?: (width: number, height: number) => Promise<void>;
      getAgentWindowBounds?: () => Promise<{
        x: number;
        y: number;
        width: number;
        height: number;
      } | null>;
      setAgentWindowBounds?: (x: number, y: number, width: number, height: number) => Promise<void>;
      hideAgentOverlay?: () => Promise<void>;
      onAgentStartRecording?: (callback: () => void) => () => void;
      onAgentStopRecording?: (callback: () => void) => () => void;
      onAgentToggleRecording?: (callback: () => void) => () => void;

      // Agent cloud streaming (event-based)
      startAgentStream?: (
        messages: Array<{ role: string; content: string | Array<unknown> }>,
        opts?: {
          systemPrompt?: string;
          tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
        }
      ) => void;
      onAgentStreamChunk?: (
        callback: (chunk: {
          type: "content" | "tool_call" | "done";
          text?: string;
          id?: string;
          name?: string;
          arguments?: string;
          finishReason?: string;
        }) => void
      ) => () => void;
      onAgentStreamError?: (
        callback: (error: { error: string; code?: string }) => void
      ) => () => void;
      onAgentStreamEnd?: (callback: () => void) => () => void;

      // Agent cloud tools
      agentOpenNote?: (noteId: number) => Promise<{ success: boolean; error?: string }>;
      agentWebSearch?: (
        query: string,
        numResults?: number
      ) => Promise<{
        success: boolean;
        results?: Array<{
          title: string;
          url: string;
          text: string;
          publishedDate?: string;
        }>;
        error?: string;
      }>;

      // Google Calendar
      gcalStartOAuth?: () => Promise<{ success: boolean; email?: string; error?: string }>;
      gcalDisconnect?: (email?: string) => Promise<{ success: boolean; error?: string }>;
      gcalGetConnectionStatus?: () => Promise<{
        connected: boolean;
        accounts: Array<{ email: string }>;
        email: string | null;
      }>;
      gcalGetCalendars?: () => Promise<{ success: boolean; calendars: any[] }>;
      gcalSetCalendarSelection?: (
        calendarId: string,
        isSelected: boolean
      ) => Promise<{ success: boolean; error?: string }>;
      gcalSyncEvents?: () => Promise<{ success: boolean; error?: string }>;
      gcalGetUpcomingEvents?: (
        windowMinutes?: number
      ) => Promise<{ success: boolean; events: any[] }>;
      gcalGetEvent?: (eventId: string) => Promise<{
        success: boolean;
        event: {
          id: string;
          summary: string | null;
          start_time: string;
          end_time: string;
          attendees_count: number;
          attendees: string | null;
        } | null;
      }>;

      // Contacts
      searchContacts: (query: string) => Promise<{
        success: boolean;
        contacts: Array<{ email: string; display_name: string | null }>;
      }>;
      upsertContact: (contact: {
        email: string;
        displayName?: string | null;
      }) => Promise<{ success: boolean }>;
      getMD5Hash: (text: string) => Promise<string>;

      // Meeting transcription (streaming, dual-channel)
      meetingTranscriptionPrepare?: (options: {
        provider?: string;
        model?: string;
        language?: string;
      }) => Promise<{ success: boolean; alreadyPrepared?: boolean; error?: string }>;
      meetingTranscriptionStart?: (options: {
        provider?: string;
        model?: string;
        language?: string;
        noteId?: number | null;
      }) => Promise<{
        success: boolean;
        error?: string;
        systemAudioMode?: SystemAudioMode;
        systemAudioStrategy?: SystemAudioStrategy;
        oneOnOneAttendee?: { displayName: string; email: string | null } | null;
      }>;
      meetingTranscriptionSend?: (buffer: ArrayBuffer, source: "mic" | "system") => void;
      meetingTranscriptionStop?: () => Promise<{
        success: boolean;
        transcript?: string;
        diarizationSessionId?: string;
        error?: string;
      }>;
      meetingTranscriptionCancel?: () => Promise<{
        success: boolean;
        reason?: "recording-active";
      }>;
      onMeetingTranscriptionSegment?: (
        callback: (data: {
          text: string;
          source: "mic" | "system";
          type: "partial" | "final" | "retract";
          timestamp?: number;
        }) => void
      ) => () => void;
      onMeetingSpeakerIdentified?: (
        callback: (data: {
          speakerId: string;
          displayName?: string | null;
          startTime: number;
          endTime: number;
        }) => void
      ) => () => void;
      onMeetingSpeakersMerged?: (
        callback: (
          merges: Array<{
            keep: string;
            remove: string;
            displayName?: string | null;
            similarity: number;
          }>
        ) => void
      ) => () => void;
      onMeetingTranscriptionError?: (callback: (error: string) => void) => () => void;

      // Speaker diarization
      downloadDiarizationModels?: () => Promise<{ success: boolean; error?: string }>;
      getDiarizationModelStatus?: () => Promise<{
        available: boolean;
        modelsDownloaded: boolean;
      }>;
      deleteDiarizationModels?: () => Promise<{ success: boolean }>;
      cancelDiarizationDownload?: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      onDiarizationDownloadProgress?: (callback: (data: any) => void) => () => void;
      onMeetingDiarizationComplete?: (
        callback: (data: {
          sessionId?: string;
          segments: Array<{
            id: string;
            text: string;
            source: "mic" | "system";
            timestamp?: number;
            speaker?: string;
            speakerName?: string;
            speakerIsPlaceholder?: boolean;
            suggestedName?: string;
            suggestedProfileId?: number;
            speakerStatus?: "provisional" | "confirmed" | "suggested" | "locked";
            speakerLocked?: boolean;
            speakerLockSource?: "user" | "diarization" | "suggestion";
          }>;
          speakerEmbeddings?: Record<string, number[]> | null;
        }) => void
      ) => () => void;

      // Speaker name mapping
      getSpeakerMappings?: (noteId: number) => Promise<
        Array<{
          note_id: number;
          speaker_id: string;
          profile_id: number | null;
          display_name: string;
        }>
      >;
      setSpeakerMapping?: (
        noteId: number,
        speakerId: string,
        displayName: string,
        email?: string | null,
        profileId?: number | null
      ) => Promise<{ success: boolean; profileId: number | null }>;
      removeSpeakerMapping?: (noteId: number, speakerId: string) => Promise<{ success: boolean }>;
      getSpeakerProfiles?: () => Promise<
        Array<{
          id: number;
          display_name: string;
          email: string | null;
          sample_count: number;
          created_at: string;
          updated_at: string;
        }>
      >;
      attachSpeakerEmail?: (
        profileId: number,
        email: string | null
      ) => Promise<{
        success: boolean;
        error?: string;
        profile?: {
          id: number;
          display_name: string;
          email: string | null;
          sample_count: number;
        };
      }>;
      saveNoteSpeakerEmbeddings?: (
        noteId: number,
        embeddings: Record<string, number[]>
      ) => Promise<{ success: boolean }>;

      // Dictation realtime streaming
      dictationRealtimeWarmup?: (options: {
        model?: string;
        mode?: "byok" | "openwhispr";
      }) => Promise<{ success: boolean; error?: string }>;
      dictationRealtimeStart?: (options: {
        model?: string;
        mode?: "byok" | "openwhispr";
      }) => Promise<{ success: boolean; error?: string }>;
      dictationRealtimeSend?: (buffer: ArrayBuffer) => void;
      dictationRealtimeStop?: () => Promise<{ success: boolean; text: string }>;
      onDictationRealtimePartial?: (callback: (text: string) => void) => () => void;
      onDictationRealtimeFinal?: (callback: (text: string) => void) => () => void;
      onDictationRealtimeError?: (callback: (error: string) => void) => () => void;
      onDictationRealtimeSessionEnd?: (callback: (data: { text: string }) => void) => () => void;

      // Google Calendar event listeners
      onGcalMeetingStarting?: (callback: (data: any) => void) => () => void;
      onGcalMeetingEnded?: (callback: (data: any) => void) => () => void;
      onGcalStartRecording?: (callback: (data: any) => void) => () => void;
      onGcalConnectionChanged?: (callback: (data: any) => void) => () => void;
      onGcalEventsSynced?: (callback: (data: any) => void) => () => void;

      meetingDetectionGetPreferences?: () => Promise<{ success: boolean; preferences?: any }>;
      meetingDetectionSetPreferences?: (
        prefs: Record<string, boolean>
      ) => Promise<{ success: boolean }>;
      setSpeakerDiarizationEnabled?: (
        enabled: boolean
      ) => Promise<{ success: boolean; error?: string }>;
      setMeetingSessionSpeakerConfig?: (config: {
        enabled: boolean;
        expectedCount: number;
      }) => Promise<{ success: boolean; error?: string }>;
      onMeetingDetected?: (callback: (data: any) => void) => () => void;
      onMeetingDetectedStartRecording?: (callback: (data: any) => void) => () => void;
      onMeetingNotificationData?: (callback: (data: any) => void) => () => void;
      getMeetingNotificationData?: () => Promise<any>;
      meetingNotificationReady?: () => Promise<void>;
      meetingNotificationRespond?: (
        detectionId: string,
        action: string
      ) => Promise<{ success: boolean }>;
      joinCalendarMeeting?: (eventId: string) => Promise<{ success: boolean }>;
      onNavigateToMeetingNote?: (
        callback: (data: { noteId: number; folderId: number; event: any }) => void
      ) => () => void;
      onNavigateToNote?: (
        callback: (data: { noteId: number; folderId: number | null }) => void
      ) => () => void;
      onUpdateNotificationData?: (
        callback: (data: { version: string; releaseDate?: string }) => void
      ) => () => void;
      getUpdateNotificationData?: () => Promise<{
        version: string;
        releaseDate?: string;
      } | null>;
      updateNotificationReady?: () => Promise<void>;
      updateNotificationRespond?: (action: string) => Promise<{ success: boolean }>;
      onPreviewText?: (callback: (text: string) => void) => () => void;
      onPreviewAppend?: (callback: (text: string) => void) => () => void;
      onPreviewHold?: (callback: (payload: { showCleanup: boolean }) => void) => () => void;
      onPreviewResult?: (callback: (payload: { text: string }) => void) => () => void;
      onPreviewHide?: (callback: () => void) => () => void;
      startDictationPreview?: (opts: {
        provider: string;
        model: string;
      }) => Promise<{ success: boolean }>;
      stopDictationPreview?: (opts?: { showCleanup?: boolean }) => Promise<{ success: boolean }>;
      dismissDictationPreview?: () => Promise<{ success: boolean }>;
      completeDictationPreview?: (payload: { text?: string }) => Promise<{ success: boolean }>;
      hideDictationPreview?: () => Promise<{ success: boolean }>;
      resizeTranscriptionPreviewWindow?: (
        width: number,
        height: number
      ) => Promise<{
        success: boolean;
        bounds?: { x: number; y: number; width: number; height: number };
      }>;
      sendDictationPreviewAudio?: (data: ArrayBuffer) => void;

      // Sync operations
      getPendingNotes?: () => Promise<NoteItem[]>;
      getPendingNoteDeletes?: () => Promise<NoteItem[]>;
      getNoteByClientId?: (clientNoteId: string) => Promise<NoteItem | null>;
      upsertNoteFromCloud?: (
        cloudNote: Record<string, unknown>,
        localFolderId: number | null
      ) => Promise<NoteItem>;
      markNoteSynced?: (id: number, cloudId: string) => Promise<void>;
      markNoteSyncError?: (id: number) => Promise<void>;
      hardDeleteNote?: (id: number) => Promise<void>;

      getPendingFolders?: () => Promise<FolderItem[]>;
      getFolderByClientId?: (clientFolderId: string) => Promise<FolderItem | null>;
      upsertFolderFromCloud?: (cloudFolder: Record<string, unknown>) => Promise<FolderItem>;
      markFolderSynced?: (id: number, cloudId: string) => Promise<void>;
      getFolderIdMap?: () => Promise<FolderItem[]>;
      getPendingFolderDeletes?: () => Promise<FolderItem[]>;
      hardDeleteFolder?: (id: number) => Promise<{ success: boolean; id: number }>;

      getPendingConversations?: () => Promise<ConversationPreview[]>;
      getPendingConversationDeletes?: () => Promise<ConversationPreview[]>;
      getConversationByClientId?: (clientId: string) => Promise<ConversationPreview | null>;
      upsertConversationFromCloud?: (
        cloudConv: Record<string, unknown>,
        messages: Array<Record<string, unknown>>
      ) => Promise<void>;
      markConversationSynced?: (id: number, cloudId: string) => Promise<void>;
      hardDeleteConversation?: (id: number) => Promise<void>;

      getPendingTranscriptions?: () => Promise<TranscriptionItem[]>;
      getTranscriptionByClientId?: (clientId: string) => Promise<TranscriptionItem | null>;
      upsertTranscriptionFromCloud?: (
        cloudTranscription: Record<string, unknown>
      ) => Promise<TranscriptionItem>;
      markTranscriptionSynced?: (id: number, cloudId: string) => Promise<void>;
      getPendingTranscriptionDeletes?: () => Promise<TranscriptionItem[]>;
      hardDeleteTranscription?: (id: number) => Promise<{ success: boolean; id: number }>;
    };

    api?: {
      sendDebugLog: (message: string) => void;
    };
  }
}
