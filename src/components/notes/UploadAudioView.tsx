import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Upload,
  FileAudio,
  X,
  AlertCircle,
  ChevronRight,
  FolderOpen,
  Plus,
  Settings,
  Link2,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { Input } from "../ui/input";
import type { FolderItem } from "../../types/electron";
import {
  findDefaultFolder,
  findVideosFolder,
  DOWNLOAD_ERROR_KEYS,
  MEETINGS_FOLDER_NAME,
} from "./shared";
import { useAuth } from "../../hooks/useAuth";
import { useUsage } from "../../hooks/useUsage";
import { useSettings } from "../../hooks/useSettings";
import { useStartOnboarding } from "../../hooks/useStartOnboarding";
import { getAllReasoningModels, getBatchTranscriptionModel } from "../../models/ModelRegistry";
import {
  useSettingsStore,
  selectIsCloudCleanupMode,
  selectResolvedUploadTranscription,
  getSettings,
} from "../../stores/settingsStore";
import { useBatchQueue } from "../../stores/batchQueueStore";
import type { TranscribeOptions } from "../../stores/batchQueueStore";
import { transcribeFileWithSpeakers, shouldUseByokDiarize } from "../../services/fileTranscription";
import type {
  FileTranscriptionConfig,
  FileTranscriptionResult,
  DiarizationSettings,
} from "../../services/fileTranscription";
import { MAX_SPEAKER_COUNT } from "../../constants/speakerDetection.json";
import BatchQueueView from "./BatchQueueView";
import { generateNoteTitle } from "../../utils/generateTitle";
import { getBaseLanguageCode } from "../../utils/languageSupport";

type UploadState = "idle" | "selected" | "downloading" | "transcribing" | "complete" | "error";

const SUPPORTED_EXTENSIONS = ["mp3", "wav", "m4a", "webm", "ogg", "oga", "flac", "aac", "opus"];

const BYOK_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB — hard limit for bring-your-own-key
const CLOUD_FREE_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB — free plan cloud limit
const CLOUD_PRO_MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB — pro plan cloud limit

const MAX_BATCH_URLS = 50;

const uploadFieldClass = cn(
  "rounded-lg text-xs",
  "bg-surface-1/40 dark:bg-white/[0.03] backdrop-blur-sm",
  "border border-foreground/6 dark:border-white/6",
  "text-foreground/70 placeholder:text-foreground/20",
  "focus:outline-none focus:border-foreground/12 dark:focus:border-white/10",
  "transition-colors"
);

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isYouTubeUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function parseBatchUrls(text: string): { valid: string[]; skipped: number } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const line of lines) {
    try {
      const parsed = new URL(line);
      const httpsOk = parsed.protocol === "https:";
      const httpYoutubeOk = parsed.protocol === "http:" && isYouTubeUrl(line);
      if ((httpsOk || httpYoutubeOk) && !seen.has(line)) {
        seen.add(line);
        valid.push(line);
      }
    } catch {
      // invalid line, counted as skipped
    }
  }
  const capped = valid.slice(0, MAX_BATCH_URLS);
  return { valid: capped, skipped: lines.length - capped.length };
}

interface UploadAudioViewProps {
  onNoteCreated?: (noteId: number, folderId: number | null) => void;
  onOpenSettings?: (section: string) => void;
}

export default function UploadAudioView({ onNoteCreated, onOpenSettings }: UploadAudioViewProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<UploadState>("idle");
  const [file, setFile] = useState<{
    name: string;
    path: string;
    size: string;
    sizeBytes: number;
    fromUrl?: boolean;
    durationSeconds?: number | null;
  } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [partialWarning, setPartialWarning] = useState(false);
  const [noteId, setNoteId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [progress, setProgress] = useState(0);
  const progressRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [chunkProgress, setChunkProgress] = useState<{
    chunksTotal: number;
    chunksCompleted: number;
  } | null>(null);
  const progressCleanupRef = useRef<(() => void) | null>(null);
  const runIdRef = useRef(0);
  const mountedRef = useRef(true);
  const urlDownloadActiveRef = useRef(false);

  const [urlInput, setUrlInput] = useState("");
  const [downloadProgress, setDownloadProgress] = useState<{
    stage: string;
    percent: number;
    title?: string;
  } | null>(null);
  const [downloadedTempPath, setDownloadedTempPath] = useState<string | null>(null);
  const downloadedTempPathRef = useRef(downloadedTempPath);
  useEffect(() => {
    downloadedTempPathRef.current = downloadedTempPath;
  }, [downloadedTempPath]);
  const [urlExpanded, setUrlExpanded] = useState(false);
  const [batchUrlNotice, setBatchUrlNotice] = useState<string | null>(null);
  const singleDownloadIdRef = useRef<string | null>(null);

  const batch = useBatchQueue();

  const [diarizationEnabled, setDiarizationEnabled] = useState(
    () => localStorage.getItem("uploadDiarizationEnabled") === "true"
  );
  const [diarizationNumSpeakers, setDiarizationNumSpeakers] = useState<string>(
    () => localStorage.getItem("uploadDiarizationNumSpeakers") || ""
  );
  const [diarizationModelsReady, setDiarizationModelsReady] = useState<boolean | null>(null);
  const [diarizationDownloading, setDiarizationDownloading] = useState(false);

  useEffect(() => {
    localStorage.setItem("uploadDiarizationEnabled", String(diarizationEnabled));
  }, [diarizationEnabled]);

  useEffect(() => {
    localStorage.setItem("uploadDiarizationNumSpeakers", diarizationNumSpeakers);
  }, [diarizationNumSpeakers]);

  const diarizationDownloadRef = useRef(false);
  const ensureDiarizationModels = async (): Promise<boolean> => {
    if (diarizationDownloadRef.current) return false;
    diarizationDownloadRef.current = true;
    setDiarizationDownloading(true);
    try {
      await window.electronAPI.downloadDiarizationModels?.();
      const status = await window.electronAPI.getDiarizationModelStatus?.();
      const ready = status?.modelsDownloaded ?? false;
      setDiarizationModelsReady(ready);
      return ready;
    } finally {
      diarizationDownloadRef.current = false;
      setDiarizationDownloading(false);
    }
  };

  useEffect(() => {
    window.electronAPI.getDiarizationModelStatus?.().then((status) => {
      const ready = status?.modelsDownloaded ?? false;
      setDiarizationModelsReady(ready);
      // Heal a persisted-on toggle whose models were removed since; roll it back
      // if the download fails so it can't sit ON while doing nothing.
      if (!ready && localStorage.getItem("uploadDiarizationEnabled") === "true") {
        if (shouldUseByokDiarize(buildTranscriptionConfig(), true)) return;
        ensureDiarizationModels().then((ok) => {
          if (!ok) setDiarizationEnabled(false);
        });
      }
    });
    // Mount-only by design: heals persisted state against the models on disk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("");
  // Batch destination folder, deliberately separate from the single-flow one:
  // handleFolderChange moves the already-saved note when noteId is set.
  const [batchFolderId, setBatchFolderId] = useState<string>("");
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const [providerReady, setProviderReady] = useState<boolean | null>(null);

  const { isSignedIn } = useAuth();
  const usage = useUsage();
  const isProUser = usage?.isSubscribed || usage?.isTrial;

  const {
    openaiApiKey,
    groqApiKey,
    xaiApiKey,
    mistralApiKey,
    tinfoilApiKey,
    customTranscriptionApiKey,
  } = useSettings();

  const {
    useLocalWhisper,
    whisperModel,
    localTranscriptionProvider,
    parakeetModel,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    cloudTranscriptionMode,
    transcriptionMode,
  } = useSettingsStore(useShallow(selectResolvedUploadTranscription));

  const remoteTranscriptionUrl = useSettingsStore((s) => s.remoteTranscriptionUrl);
  const remoteTranscriptionModel = useSettingsStore((s) => s.remoteTranscriptionModel);

  const setUploadTranscriptionMode = useSettingsStore((s) => s.setUploadTranscriptionMode);
  const setUploadCloudTranscriptionMode = useSettingsStore(
    (s) => s.setUploadCloudTranscriptionMode
  );
  const setUploadUseLocalWhisper = useSettingsStore((s) => s.setUploadUseLocalWhisper);

  const cortiClientId = useSettingsStore((s) => s.cortiClientId);
  const cortiClientSecret = useSettingsStore((s) => s.cortiClientSecret);
  const cortiEnvironment = useSettingsStore((s) => s.cortiEnvironment);
  const cortiTenant = useSettingsStore((s) => s.cortiTenant);
  const preferredLanguage = useSettingsStore((s) => s.preferredLanguage);
  const isCloudCleanup = useSettingsStore(selectIsCloudCleanupMode);
  const effectiveCleanupModel = useSettingsStore((s) =>
    selectIsCloudCleanupMode(s) ? "" : s.cleanupModel
  );
  const useCleanupModel = useSettingsStore((s) => s.useCleanupModel);

  const isOpenWhisprCloud =
    isSignedIn && cloudTranscriptionMode === "openwhispr" && !useLocalWhisper;

  // Mode detection
  const isSelfHosted = transcriptionMode === "self-hosted" && !useLocalWhisper;
  const isByok = !useLocalWhisper && !isOpenWhisprCloud;

  // Mode-aware file size validation
  // Local: no limits at all
  // BYOK: 25 MB hard max regardless of plan
  // Cloud free: 25 MB max (upgrade to Pro for more)
  // Cloud pro: 500 MB max
  let fileTooLarge = false;
  let requiresUpgrade = false;
  let requiresAccount = false;
  let byokTooLarge = false;
  let isLargeFile = false;

  if (file) {
    if (useLocalWhisper) {
      // Local transcription: no file size restrictions
    } else if (isSelfHosted || cloudTranscriptionProvider === "custom") {
      // Self-hosted / custom endpoints (e.g. local whisper.cpp): no file size restrictions
    } else if (isByok) {
      byokTooLarge = file.sizeBytes > BYOK_MAX_FILE_SIZE;
      if (byokTooLarge && !isSignedIn) {
        requiresAccount = true;
      }
    } else {
      // Cloud (OpenWhispr) — user is always signed in here
      fileTooLarge = file.sizeBytes > CLOUD_PRO_MAX_FILE_SIZE;
      requiresUpgrade = !isProUser && file.sizeBytes > CLOUD_FREE_MAX_FILE_SIZE;
      isLargeFile = file.sizeBytes > CLOUD_FREE_MAX_FILE_SIZE;
    }
  }

  useEffect(() => {
    return () => {
      if (progressRef.current) clearInterval(progressRef.current);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (urlDownloadActiveRef.current) {
        window.electronAPI.cancelUrlDownload();
      }
      if (downloadedTempPathRef.current) {
        window.electronAPI.deleteTempFile(downloadedTempPathRef.current);
      }
    };
  }, []);

  useEffect(() => {
    window.electronAPI.getFolders?.().then((f) => {
      setFolders(f);
      const personal = findDefaultFolder(f);
      if (personal) {
        setSelectedFolderId(String(personal.id));
        setBatchFolderId(String(personal.id));
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const checkProviderReady = async () => {
      if (isOpenWhisprCloud) {
        setProviderReady(true);
        return;
      }
      if (!useLocalWhisper) {
        if (isSelfHosted) {
          if (!cancelled) setProviderReady(!!remoteTranscriptionUrl?.trim());
        } else if (cloudTranscriptionProvider === "custom") {
          // Custom providers only need a base URL; API key is truly optional
          if (!cancelled) setProviderReady(!!cloudTranscriptionBaseUrl?.trim());
        } else if (cloudTranscriptionProvider === "corti") {
          if (!cancelled) setProviderReady(!!(cortiClientId && cortiClientSecret));
        } else {
          const key =
            cloudTranscriptionProvider === "openai"
              ? openaiApiKey
              : cloudTranscriptionProvider === "groq"
                ? groqApiKey
                : cloudTranscriptionProvider === "xai"
                  ? xaiApiKey
                  : cloudTranscriptionProvider === "mistral"
                    ? mistralApiKey
                    : cloudTranscriptionProvider === "tinfoil"
                      ? tinfoilApiKey
                      : customTranscriptionApiKey;
          if (!cancelled) setProviderReady(!!key);
        }
        return;
      }
      if (localTranscriptionProvider === "nvidia") {
        const r = await window.electronAPI.listParakeetModels?.();
        if (!cancelled)
          setProviderReady(
            !!(r?.success && r.models.some((m: { downloaded?: boolean }) => m.downloaded))
          );
      } else {
        const r = await window.electronAPI.listWhisperModels?.();
        if (!cancelled)
          setProviderReady(
            !!(r?.success && r.models.some((m: { downloaded?: boolean }) => m.downloaded))
          );
      }
    };
    checkProviderReady();
    return () => {
      cancelled = true;
    };
  }, [
    isOpenWhisprCloud,
    isSelfHosted,
    remoteTranscriptionUrl,
    useLocalWhisper,
    localTranscriptionProvider,
    cloudTranscriptionProvider,
    cloudTranscriptionBaseUrl,
    openaiApiKey,
    groqApiKey,
    xaiApiKey,
    mistralApiKey,
    tinfoilApiKey,
    customTranscriptionApiKey,
    cortiClientId,
    cortiClientSecret,
  ]);

  const getActiveModelLabel = (): string => {
    if (isOpenWhisprCloud) return t("notes.upload.openwhisprCloud");
    if (useLocalWhisper) {
      if (localTranscriptionProvider === "nvidia")
        return `Parakeet · ${parakeetModel || "default"}`;
      return `Whisper · ${whisperModel || "base"}`;
    }
    if (isSelfHosted) {
      const name = t("settingsPage.transcription.modes.selfHosted");
      return remoteTranscriptionModel ? `${name} · ${remoteTranscriptionModel}` : name;
    }
    const name =
      cloudTranscriptionProvider === "custom"
        ? t("notes.upload.custom")
        : cloudTranscriptionProvider.charAt(0).toUpperCase() + cloudTranscriptionProvider.slice(1);
    const model = getBatchTranscriptionModel(cloudTranscriptionProvider) ?? cloudTranscriptionModel;
    return `${name} · ${model}`;
  };

  const getActiveApiKey = (): string => {
    switch (cloudTranscriptionProvider) {
      case "openai":
        return openaiApiKey;
      case "groq":
        return groqApiKey;
      case "xai":
        return xaiApiKey;
      case "mistral":
        return mistralApiKey;
      case "tinfoil":
        return tinfoilApiKey;
      case "custom":
        return customTranscriptionApiKey || "";
      default:
        return "";
    }
  };

  const buildTranscriptionConfig = (): FileTranscriptionConfig => ({
    useLocalWhisper,
    localTranscriptionProvider: localTranscriptionProvider as string,
    whisperModel,
    parakeetModel,
    isOpenWhisprCloud,
    getApiKey: getActiveApiKey,
    cloudTranscriptionProvider: cloudTranscriptionProvider as string,
    cloudTranscriptionBaseUrl: cloudTranscriptionBaseUrl || "",
    cloudTranscriptionModel,
    language: getBaseLanguageCode(preferredLanguage) || "en",
    cortiEnvironment,
    cortiTenant,
    transcriptionMode,
    remoteTranscriptionUrl,
    remoteTranscriptionModel,
  });

  // Batch counterpart of the single-file size gating above; returns keys under notes.upload.*.
  const getBatchSizeErrorKey = (sizeBytes: number): string | null => {
    if (useLocalWhisper || isSelfHosted || cloudTranscriptionProvider === "custom") return null;
    if (isByok) return sizeBytes > BYOK_MAX_FILE_SIZE ? "byokTooLarge" : null;
    if (sizeBytes > CLOUD_PRO_MAX_FILE_SIZE) return "fileTooLarge";
    if (!isProUser && sizeBytes > CLOUD_FREE_MAX_FILE_SIZE) return "paidPlanRequired";
    return null;
  };

  const generateTitle = async (text: string): Promise<string> => {
    if (!useCleanupModel) return "";
    if (!getSettings().autoGenerateNoteTitle) return "";
    const model = isCloudCleanup ? "" : effectiveCleanupModel || getAllReasoningModels()[0]?.value;
    if (!model && !isCloudCleanup) return "";
    return generateNoteTitle(text, model);
  };

  const handleBrowse = async () => {
    const res = await window.electronAPI.selectAudioFile({ multiple: true });
    if (res.canceled) return;

    const filePaths: string[] = res.filePaths || (res.filePath ? [res.filePath] : []);
    if (filePaths.length === 0) return;

    // While a batch runs (or a queue exists), new files join the queue.
    if (filePaths.length === 1 && !batch.isProcessing && !batch.hasQueue) {
      const fp = filePaths[0];
      const name = fp.split(/[/\\]/).pop() || "audio";
      const sizeBytes = (await window.electronAPI.getFileSize?.(fp)) ?? 0;
      setFile({ name, path: fp, size: sizeBytes ? formatFileSize(sizeBytes) : "", sizeBytes });
      setState("selected");
      setError(null);
      return;
    }

    const items: Array<{ name: string; path: string; sizeBytes: number }> = [];
    for (const fp of filePaths) {
      const name = fp.split(/[/\\]/).pop() || "audio";
      const sizeBytes = (await window.electronAPI.getFileSize?.(fp)) ?? 0;
      items.push({ name, path: fp, sizeBytes });
    }
    batch.addFiles(items);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const validFiles: Array<{ name: string; path: string; sizeBytes: number }> = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const ext = f.name.split(".").pop()?.toLowerCase() || "";
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        const filePath = window.electronAPI.getPathForFile(f);
        if (filePath) {
          validFiles.push({ name: f.name, path: filePath, sizeBytes: f.size });
        }
      }
    }

    if (validFiles.length === 0) return;

    if (validFiles.length === 1 && !batch.isProcessing && !batch.hasQueue) {
      const f = validFiles[0];
      setFile({
        name: f.name,
        path: f.path,
        size: formatFileSize(f.sizeBytes),
        sizeBytes: f.sizeBytes,
      });
      setState("selected");
      setError(null);
    } else {
      batch.addFiles(validFiles);
    }
  };

  const reset = () => {
    if (progressRef.current) clearInterval(progressRef.current);
    if (progressCleanupRef.current) progressCleanupRef.current();
    progressCleanupRef.current = null;
    if (downloadedTempPath) {
      window.electronAPI.deleteTempFile(downloadedTempPath);
      setDownloadedTempPath(null);
    }
    setState("idle");
    setFile(null);
    setResult(null);
    setPartialWarning(false);
    setNoteId(null);
    setError(null);
    setProgress(0);
    setChunkProgress(null);
    setUrlInput("");
    setDownloadProgress(null);
    setBatchUrlNotice(null);
    const personal = findDefaultFolder(folders);
    if (personal) setSelectedFolderId(String(personal.id));
  };

  const cancelTranscription = () => {
    runIdRef.current++;
    reset();
  };

  const handleTranscribe = async () => {
    if (!file || batch.isProcessing) return;
    const currentFile = file;
    const currentTempPath = downloadedTempPath;
    const runId = ++runIdRef.current;
    setState("transcribing");
    setError(null);
    setProgress(0);
    setChunkProgress(null);

    const useChunkProgress = isOpenWhisprCloud && isLargeFile;

    if (useChunkProgress) {
      progressCleanupRef.current =
        window.electronAPI.onUploadTranscriptionProgress?.((data) => {
          if (data.chunksTotal > 0) {
            setChunkProgress({
              chunksTotal: data.chunksTotal,
              chunksCompleted: data.chunksCompleted,
            });
            setProgress((data.chunksCompleted / data.chunksTotal) * 90);
          }
        }) ?? null;
    } else {
      progressRef.current = setInterval(() => {
        setProgress((prev) => {
          if (prev >= 90) {
            if (progressRef.current) clearInterval(progressRef.current);
            return prev;
          }
          return prev + Math.random() * 6;
        });
      }, 500);
    }

    try {
      const res: FileTranscriptionResult = await transcribeFileWithSpeakers(
        currentFile.path,
        buildTranscriptionConfig(),
        {
          enabled: diarizationEnabled,
          localModelsReady: !!diarizationModelsReady,
          numSpeakers: diarizationNumSpeakers ? Number(diarizationNumSpeakers) : null,
        },
        currentFile.durationSeconds
      );

      if (runId !== runIdRef.current) return;

      if (progressRef.current) clearInterval(progressRef.current);
      if (progressCleanupRef.current) progressCleanupRef.current();
      progressCleanupRef.current = null;

      if (res.success && res.text) {
        setProgress(100);
        setResult(res.text);
        setPartialWarning(!!res.warning);

        let title: string;
        if (currentFile.fromUrl) {
          title = currentFile.name;
        } else {
          const textFallback = res.text.trim().split(/\s+/).slice(0, 6).join(" ");
          const fallbackTitle =
            textFallback.length > 0
              ? textFallback + (res.text.trim().split(/\s+/).length > 6 ? "..." : "")
              : currentFile.name.replace(/\.[^.]+$/, "");
          const aiTitle = await generateTitle(res.text);
          if (runId !== runIdRef.current) return;
          title = aiTitle || fallbackTitle;
        }

        const folderId = selectedFolderId ? Number(selectedFolderId) : null;
        const noteRes = await window.electronAPI.saveNote(
          title,
          res.text,
          "upload",
          currentFile.name,
          null,
          folderId
        );
        if (runId !== runIdRef.current) return;
        if (noteRes.success && noteRes.note) setNoteId(noteRes.note.id);
        if (currentTempPath) {
          window.electronAPI.deleteTempFile(currentTempPath);
          setDownloadedTempPath(null);
        }
        setState("complete");
      } else {
        setProgress(0);
        setError(
          res.code === "NO_SPEECH_DETECTED"
            ? t("notes.upload.noSpeechDetected")
            : res.error || t("notes.upload.transcriptionFailed")
        );
        setState("error");
      }
    } catch (err) {
      if (runId !== runIdRef.current) return;
      if (progressRef.current) clearInterval(progressRef.current);
      if (progressCleanupRef.current) progressCleanupRef.current();
      progressCleanupRef.current = null;
      setProgress(0);
      setError(err instanceof Error ? err.message : t("notes.upload.errorOccurred"));
      setState("error");
    }
  };

  const handleUrlSubmit = async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;

    // While a batch runs (or a queue exists), submitted URLs join the queue.
    if (batch.isProcessing || batch.hasQueue) {
      handleBatchUrlSubmit();
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      setError(t("notes.upload.urlInvalid"));
      setState("error");
      return;
    }

    // Main enforces HTTPS for direct downloads (YouTube http URLs get coerced),
    // so reject here instead of surfacing a misleading late failure.
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isYouTubeUrl(trimmed))) {
      setError(t("notes.upload.urlInvalid"));
      setState("error");
      return;
    }

    setState("downloading");
    setError(null);
    setDownloadProgress({ stage: "resolving", percent: 0 });

    const downloadId = crypto.randomUUID();
    singleDownloadIdRef.current = downloadId;
    const cleanupProgress = window.electronAPI.onUrlDownloadProgress?.((data) => {
      if (data.downloadId && data.downloadId !== downloadId) return;
      setDownloadProgress(data);
    });

    urlDownloadActiveRef.current = true;
    try {
      const res = await window.electronAPI.downloadUrlAudio(trimmed, downloadId);

      if (!mountedRef.current) {
        // Unmounted mid-download: nothing owns the temp file anymore, delete it.
        if (res.success) window.electronAPI.deleteTempFile(res.tempPath);
        return;
      }

      if (!res.success) {
        const fail = res as { success: false; error: string; code?: string };
        if (fail.code === "DOWNLOAD_CANCELLED") {
          setState("idle");
          return;
        }
        const key = DOWNLOAD_ERROR_KEYS[fail.code || ""];
        setError(
          key ? t(`notes.upload.${key}`) : fail.error || t("notes.upload.urlDownloadFailed")
        );
        setState("error");
        return;
      }

      setDownloadedTempPath(res.tempPath);
      setFile({
        name: res.title,
        path: res.tempPath,
        size: formatFileSize(res.sizeBytes),
        sizeBytes: res.sizeBytes,
        fromUrl: true,
        durationSeconds: res.durationSeconds,
      });
      const videosFolder = findVideosFolder(folders);
      if (videosFolder) setSelectedFolderId(String(videosFolder.id));
      setState("selected");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("notes.upload.urlDownloadFailed"));
      setState("error");
    } finally {
      urlDownloadActiveRef.current = false;
      singleDownloadIdRef.current = null;
      cleanupProgress?.();
      setDownloadProgress(null);
    }
  };

  // Retry re-runs whatever failed: a selected file's transcription, or the URL download.
  const handleRetry = () => {
    if (file) {
      handleTranscribe();
    } else if (urlInput.trim()) {
      handleUrlSubmit();
    } else {
      reset();
    }
  };

  const handleCancelDownload = () => {
    window.electronAPI.cancelUrlDownload(singleDownloadIdRef.current ?? undefined);
  };

  const handleBatchUrlSubmit = () => {
    const { valid, skipped } = parseBatchUrls(urlInput);
    if (valid.length > 0) {
      batch.addUrls(valid);
      // Same default the single-URL flow applies; the selector stays editable.
      if (!batchFolderId) {
        const videosFolder = findVideosFolder(folders);
        if (videosFolder) setBatchFolderId(String(videosFolder.id));
      }
      setUrlInput("");
      setUrlExpanded(false);
    }
    setBatchUrlNotice(skipped > 0 ? t("notes.upload.urlsSkipped", { n: skipped }) : null);
  };

  const startBatchProcessing = () => {
    if (state === "downloading" || state === "transcribing") return;
    setBatchUrlNotice(null);

    const transcribeOpts: TranscribeOptions = {
      transcription: buildTranscriptionConfig(),
      folderId: batchFolderId ? Number(batchFolderId) : null,
      validateSize: getBatchSizeErrorKey,
      generateTitle: async (text) => (await generateTitle(text)) || null,
    };

    const diarization: DiarizationSettings = {
      enabled: diarizationEnabled,
      localModelsReady: !!diarizationModelsReady,
      numSpeakers: diarizationNumSpeakers ? Number(diarizationNumSpeakers) : null,
    };

    batch.processQueue(transcribeOpts, diarization);
  };

  const handleCreateFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    const res = await window.electronAPI.createFolder(trimmed);
    if (res.success && res.folder) {
      setFolders((prev) => [...prev, res.folder!]);
      const newId = String(res.folder.id);
      setSelectedFolderId(newId);
      if (noteId != null) {
        window.electronAPI.updateNote(noteId, { folder_id: res.folder.id });
      }
    }
    setNewFolderName("");
    setShowNewFolderDialog(false);
  };

  const handleFolderChange = (val: string) => {
    if (val === "__create_new__") {
      setShowNewFolderDialog(true);
      return;
    }
    setSelectedFolderId(val);
    if (noteId != null) {
      window.electronAPI.updateNote(noteId, { folder_id: Number(val) });
    }
  };

  const handleCreateAccount = useStartOnboarding();

  const switchToCloud = () => {
    setUploadTranscriptionMode("openwhispr");
    setUploadCloudTranscriptionMode("openwhispr");
    setUploadUseLocalWhisper(false);
  };

  const getTranscribingLabel = (): string => {
    if (isOpenWhisprCloud) return t("notes.upload.transcribingCloud");
    if (useLocalWhisper) return t("notes.upload.transcribingLocal");
    if (isSelfHosted) {
      return t("notes.upload.transcribingProvider", {
        provider: t("settingsPage.transcription.modes.selfHosted"),
      });
    }
    return t("notes.upload.transcribingProvider", { provider: cloudTranscriptionProvider });
  };

  return (
    <div className="flex flex-col items-center h-full overflow-y-auto px-6">
      <div
        className="w-full max-w-md shrink-0 my-auto"
        style={{ animation: "float-up 0.4s ease-out" }}
      >
        <div className="max-w-[320px] mx-auto">
          {state === "idle" && providerReady === false && (
            <NoProviderView t={t} onOpenSettings={() => onOpenSettings?.("uploadTranscription")} />
          )}

          {state === "idle" && providerReady !== false && (
            <>
              <IdleView
                t={t}
                getActiveModelLabel={getActiveModelLabel}
                handleDrop={handleDrop}
                handleBrowse={handleBrowse}
                isDragOver={isDragOver}
                setIsDragOver={setIsDragOver}
              />

              <div className="flex items-center gap-3 my-3">
                <div className="h-px flex-1 bg-foreground/5 dark:bg-white/5" />
                <span className="text-[10px] text-foreground/20 uppercase tracking-wider">
                  {t("notes.upload.orDivider")}
                </span>
                <div className="h-px flex-1 bg-foreground/5 dark:bg-white/5" />
              </div>

              {urlExpanded ? (
                <div>
                  <textarea
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder={t("notes.upload.pasteUrls")}
                    rows={4}
                    className={cn(uploadFieldClass, "w-full px-3 py-2 resize-none")}
                    autoFocus
                  />
                  <div className="flex items-center gap-2 mt-2 justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setUrlExpanded(false);
                        setUrlInput("");
                      }}
                      className="h-7 text-xs text-foreground/30"
                    >
                      {t("notes.upload.cancel")}
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={handleBatchUrlSubmit}
                      disabled={!urlInput.trim()}
                      className="h-7 text-xs"
                    >
                      {t("notes.upload.addToQueue")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="relative">
                  {isYouTubeUrl(urlInput) ? (
                    <svg
                      viewBox="0 0 28 20"
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 w-[18px] h-[13px] z-10 pointer-events-none"
                    >
                      <rect width="28" height="20" rx="4" fill="#FF0000" />
                      <polygon points="11,4 11,16 21,10" fill="white" />
                    </svg>
                  ) : /\.(mp3|wav|m4a|ogg|flac|aac|webm|opus)(\?|$)/i.test(urlInput) ? (
                    <FileAudio
                      size={13}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground/20 z-10 pointer-events-none"
                    />
                  ) : (
                    <Link2
                      size={13}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground/20 z-10 pointer-events-none"
                    />
                  )}
                  <input
                    type="url"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleUrlSubmit();
                      }
                    }}
                    onFocus={() => {
                      if (urlInput.includes("\n")) setUrlExpanded(true);
                    }}
                    onPaste={(e) => {
                      const pasted = e.clipboardData.getData("text");
                      if (pasted.includes("\n")) {
                        e.preventDefault();
                        setUrlInput(pasted);
                        setUrlExpanded(true);
                      }
                    }}
                    placeholder={t("notes.upload.urlPlaceholder")}
                    className={cn(uploadFieldClass, "w-full h-8 pl-8 pr-9")}
                  />
                  <button
                    onClick={handleUrlSubmit}
                    disabled={!urlInput.trim()}
                    aria-label={t("notes.upload.urlSubmit")}
                    className={cn(
                      "absolute right-px top-px bottom-px w-7 rounded-r-[7px] flex items-center justify-center transition-colors",
                      "border-l border-foreground/6 dark:border-white/6",
                      urlInput.trim()
                        ? "text-foreground/40 hover:text-foreground/60 hover:bg-foreground/[0.03] dark:hover:bg-white/[0.03]"
                        : "text-foreground/10"
                    )}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              )}
            </>
          )}

          {batchUrlNotice && (
            <p className="text-[10px] text-amber-500/60 mt-2 text-center">{batchUrlNotice}</p>
          )}

          {batch.hasQueue && (
            <div className="mt-3">
              <BatchQueueView
                queue={batch.queue}
                completedCount={batch.completedCount}
                failedCount={batch.failedCount}
                totalCount={batch.totalCount}
                isProcessing={batch.isProcessing}
                onRemoveItem={batch.removeItem}
                onCancelAll={batch.cancelAll}
                onClearQueue={() => {
                  setBatchUrlNotice(null);
                  batch.clearQueue();
                }}
                onOpenNote={(noteId) =>
                  onNoteCreated?.(noteId, batchFolderId ? Number(batchFolderId) : null)
                }
              />

              {!batch.isProcessing && batch.queue.some((i) => i.status === "queued") && (
                <div className="mt-3 space-y-2">
                  {folders.length > 0 && (
                    <FolderSelect
                      t={t}
                      folders={folders}
                      value={batchFolderId}
                      onChange={setBatchFolderId}
                    />
                  )}
                  <div className="flex justify-center">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={startBatchProcessing}
                      disabled={state === "downloading" || state === "transcribing"}
                      className="h-8 text-xs px-5"
                    >
                      {t("notes.upload.transcribe")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {state === "selected" && file && (
            <SelectedView
              t={t}
              file={file}
              getActiveModelLabel={getActiveModelLabel}
              reset={reset}
              handleTranscribe={handleTranscribe}
              transcribeDisabled={batch.isProcessing}
              requiresUpgrade={!!requiresUpgrade}
              fileTooLarge={fileTooLarge}
              isLargeFile={isLargeFile}
              isOpenWhisprCloud={isOpenWhisprCloud}
              byokTooLarge={byokTooLarge}
              requiresAccount={requiresAccount}
              isProUser={!!isProUser}
              onUpgrade={() => usage?.openCheckout()}
              onCreateAccount={handleCreateAccount}
              onSwitchToCloud={switchToCloud}
            />
          )}

          {state === "downloading" && downloadProgress && (
            <div
              className="flex flex-col items-center"
              style={{ animation: "float-up 0.3s ease-out" }}
            >
              <div className="flex items-end justify-center gap-[3px] h-10 mb-5">
                {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                  <div
                    key={i}
                    className="w-[3px] rounded-full bg-primary/40 dark:bg-primary/50 origin-bottom"
                    style={{
                      height: "100%",
                      animation: `waveform-bar ${0.8 + i * 0.12}s ease-in-out infinite`,
                      animationDelay: `${i * 0.08}s`,
                    }}
                  />
                ))}
              </div>

              <div className="w-full max-w-[200px] h-[3px] rounded-full bg-foreground/5 dark:bg-white/5 overflow-hidden mb-3">
                <div
                  className={cn(
                    "h-full rounded-full bg-primary/50 transition-[width] duration-500 ease-out",
                    // Percent 0 = size unknown (no content-length): pulse instead
                    // of sitting on an empty bar.
                    (downloadProgress.stage !== "downloading" || !downloadProgress.percent) &&
                      "animate-pulse"
                  )}
                  style={{
                    width:
                      downloadProgress.stage === "downloading" && downloadProgress.percent
                        ? `${Math.min(downloadProgress.percent, 100)}%`
                        : "100%",
                  }}
                />
              </div>

              <p className="text-xs text-foreground/50 font-medium">
                {downloadProgress.stage === "resolving"
                  ? t("notes.upload.urlResolving")
                  : t("notes.upload.urlDownloading")}
              </p>

              {downloadProgress.title && (
                <p className="text-xs text-foreground/20 mt-1 truncate max-w-50">
                  {downloadProgress.title}
                </p>
              )}

              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancelDownload}
                className="mt-3 h-7 text-xs text-foreground/30"
              >
                {t("notes.upload.urlCancelDownload")}
              </Button>
            </div>
          )}

          {state === "transcribing" && (
            <TranscribingView
              t={t}
              progress={progress}
              getTranscribingLabel={getTranscribingLabel}
              file={file}
              chunkProgress={chunkProgress}
              onCancel={cancelTranscription}
            />
          )}

          {state === "complete" && result && (
            <CompleteView
              t={t}
              result={result}
              partialWarning={partialWarning}
              folders={folders}
              selectedFolderId={selectedFolderId}
              handleFolderChange={handleFolderChange}
              noteId={noteId}
              onNoteCreated={onNoteCreated}
              reset={reset}
            />
          )}

          {state === "error" && error && (
            <ErrorView t={t} error={error} reset={reset} onRetry={handleRetry} />
          )}
        </div>

        {(state === "idle" || state === "selected") && (
          <div className="max-w-[320px] mx-auto mt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-foreground/40 font-medium">
                  {t("notes.upload.speakerDetection")}
                </p>
                <p className="text-[10px] text-foreground/20 mt-0.5">
                  {t("notes.upload.speakerDetectionDescription")}
                </p>
              </div>
              <button
                role="switch"
                aria-checked={diarizationEnabled}
                aria-label={t("notes.upload.speakerDetection")}
                onClick={async () => {
                  if (diarizationDownloading) return;
                  const next = !diarizationEnabled;
                  setDiarizationEnabled(next);
                  // BYOK-native diarization needs no local models — don't download them.
                  if (
                    next &&
                    !diarizationModelsReady &&
                    !shouldUseByokDiarize(buildTranscriptionConfig(), true)
                  ) {
                    const ready = await ensureDiarizationModels();
                    if (!ready) setDiarizationEnabled(false);
                  }
                }}
                className={cn(
                  "relative w-7 h-4 rounded-full transition-colors shrink-0",
                  diarizationDownloading
                    ? "bg-primary/50 animate-pulse"
                    : diarizationEnabled
                      ? "bg-primary"
                      : "bg-muted"
                )}
                disabled={diarizationDownloading}
              >
                <div
                  className={cn(
                    "absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform",
                    diarizationEnabled ? "translate-x-3" : ""
                  )}
                />
              </button>
            </div>

            {diarizationEnabled &&
              !useLocalWhisper &&
              !isOpenWhisprCloud &&
              !isSelfHosted &&
              cloudTranscriptionProvider === "openai" && (
                <p className="text-[10px] text-foreground/25 mt-1.5">
                  {t("notes.upload.openaiDiarizeNote")}
                </p>
              )}
            {diarizationEnabled &&
              !useLocalWhisper &&
              !isOpenWhisprCloud &&
              !isSelfHosted &&
              cloudTranscriptionProvider === "mistral" && (
                <p className="text-[10px] text-foreground/25 mt-1.5">
                  {t("notes.upload.mistralDiarizeNote")}
                </p>
              )}
            {diarizationEnabled &&
              !useLocalWhisper &&
              !isOpenWhisprCloud &&
              !isSelfHosted &&
              cloudTranscriptionProvider === "groq" && (
                <p className="text-[10px] text-amber-500/60 mt-1.5">
                  {t("notes.upload.groqDiarizeNote")}
                </p>
              )}

            {diarizationDownloading && (
              <p className="text-[10px] text-primary/50 mt-1.5">
                {t("notes.upload.downloadingModels")}
              </p>
            )}

            {diarizationEnabled && isOpenWhisprCloud && (
              <p className="text-[10px] text-foreground/25 mt-1.5">
                {t("notes.upload.diarizationRunsLocally")}
              </p>
            )}

            {diarizationEnabled && diarizationModelsReady && (
              <div className="mt-2">
                <input
                  type="number"
                  min="2"
                  max={MAX_SPEAKER_COUNT}
                  value={diarizationNumSpeakers}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      setDiarizationNumSpeakers("");
                      return;
                    }
                    const n = Math.max(2, Math.min(MAX_SPEAKER_COUNT, Number(raw)));
                    setDiarizationNumSpeakers(String(isNaN(n) ? "" : n));
                  }}
                  placeholder={t("notes.upload.numSpeakersPlaceholder")}
                  aria-label={t("notes.upload.numSpeakersPlaceholder")}
                  className={cn(
                    uploadFieldClass,
                    "w-full h-8 px-2.5 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  )}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={showNewFolderDialog} onOpenChange={setShowNewFolderDialog}>
        <DialogContent className="sm:max-w-95">
          <DialogHeader>
            <DialogTitle>{t("notes.upload.newFolder")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground/50">
              {t("notes.upload.folderName")}
            </label>
            <Input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder={t("notes.folders.folderName")}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFolder();
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setShowNewFolderDialog(false);
                setNewFolderName("");
              }}
            >
              {t("notes.upload.cancel")}
            </Button>
            <Button onClick={handleCreateFolder} disabled={!newFolderName.trim()}>
              {t("notes.upload.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface NoProviderViewProps {
  t: (key: string, options?: Record<string, unknown>) => string;
  onOpenSettings: () => void;
}

function NoProviderView({ t, onOpenSettings }: NoProviderViewProps) {
  return (
    <div
      className="flex flex-col items-center gap-4 py-2"
      style={{ animation: "float-up 0.4s ease-out" }}
    >
      <div className="w-10 h-10 rounded-[10px] bg-linear-to-b from-foreground/5 to-foreground/2 dark:from-white/8 dark:to-white/3 border border-foreground/8 dark:border-white/8 flex items-center justify-center">
        <Settings
          size={17}
          strokeWidth={1.5}
          className="text-foreground/25 dark:text-foreground/35"
        />
      </div>
      <div className="text-center">
        <h2 className="text-xs font-semibold text-foreground mb-1">
          {t("notes.upload.noProviderTitle")}
        </h2>
        <p className="text-xs text-foreground/30 leading-relaxed max-w-60">
          {t("notes.upload.noProviderDescription")}
        </p>
      </div>
      <Button variant="default" size="sm" className="h-7 text-xs px-4" onClick={onOpenSettings}>
        {t("notes.upload.noProviderAction")}
      </Button>
    </div>
  );
}

interface IdleViewProps {
  t: (key: string, options?: Record<string, unknown>) => string;
  getActiveModelLabel: () => string;
  handleDrop: (e: React.DragEvent) => void;
  handleBrowse: () => void;
  isDragOver: boolean;
  setIsDragOver: (v: boolean) => void;
}

function IdleView({
  t,
  getActiveModelLabel,
  handleDrop,
  handleBrowse,
  isDragOver,
  setIsDragOver,
}: IdleViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    // Delegate to handleBrowse which uses Electron's file dialog;
    // the hidden input is for keyboard-triggered file selection only.
    handleBrowse();
    // Reset input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleBrowse();
    }
  };

  return (
    <>
      <div className="flex flex-col items-center mb-5">
        <div className="w-10 h-10 rounded-[10px] bg-linear-to-b from-foreground/5 to-foreground/[0.02] dark:from-white/8 dark:to-white/3 border border-foreground/8 dark:border-white/8 flex items-center justify-center mb-4">
          <Upload
            size={17}
            strokeWidth={1.5}
            className="text-foreground/25 dark:text-foreground/35"
          />
        </div>
        <h2 className="text-xs font-semibold text-foreground mb-1">{t("notes.upload.title")}</h2>
        <p className="text-xs text-foreground/25">
          {t("notes.upload.using", { model: getActiveModelLabel() })}
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".mp3,.wav,.m4a,.webm,.ogg,.oga,.flac,.aac,.opus"
        onChange={handleFileInputChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />

      <div
        role="button"
        tabIndex={0}
        aria-label={t("notes.upload.dropOrBrowse")}
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setIsDragOver(false);
        }}
        onClick={handleBrowse}
        onKeyDown={handleKeyDown}
        className={cn(
          "relative rounded-lg p-8 text-center cursor-pointer transition-[background-color,border-color,transform] duration-300 group",
          "bg-surface-1/40 dark:bg-white/[0.03] backdrop-blur-sm",
          "border border-foreground/6 dark:border-white/6",
          "hover:bg-surface-1/60 dark:hover:bg-white/[0.05] hover:border-foreground/12 dark:hover:border-white/10",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30",
          isDragOver && "border-primary/30 bg-primary/[0.04] dark:bg-primary/[0.06] scale-[1.01]"
        )}
        style={isDragOver ? { animation: "drag-pulse 1.5s ease-in-out infinite" } : undefined}
      >
        <div className="absolute inset-0 rounded-lg overflow-hidden pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500">
          <div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/[0.02] dark:via-white/[0.03] to-transparent"
            style={{ animation: "shimmer-slide 3s ease-in-out infinite" }}
          />
        </div>

        {!isDragOver ? (
          <div className="flex flex-col items-center gap-2 relative">
            <div className="w-8 h-8 rounded-full bg-foreground/[0.03] dark:bg-white/[0.04] flex items-center justify-center mb-1">
              <Upload
                size={14}
                className="text-foreground/20 dark:text-foreground/30 group-hover:text-foreground/40 transition-colors"
              />
            </div>
            <p className="text-xs text-foreground/35 group-hover:text-foreground/50 transition-colors">
              {t("notes.upload.dropOrBrowse")}
            </p>
            <p className="text-xs text-foreground/15 tracking-wide">
              {t("notes.upload.supportedFormats")}
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 relative">
            <Upload size={18} className="text-primary/60" />
            <p className="text-xs text-primary/60 font-medium">{t("notes.upload.dropToUpload")}</p>
          </div>
        )}
      </div>
    </>
  );
}

interface SelectedViewProps {
  t: (key: string) => string;
  file: { name: string; path: string; size: string; sizeBytes: number };
  getActiveModelLabel: () => string;
  reset: () => void;
  handleTranscribe: () => void;
  transcribeDisabled: boolean;
  requiresUpgrade: boolean;
  fileTooLarge: boolean;
  isLargeFile: boolean;
  isOpenWhisprCloud: boolean;
  byokTooLarge: boolean;
  requiresAccount: boolean;
  isProUser: boolean;
  onUpgrade: () => void;
  onCreateAccount: () => void;
  onSwitchToCloud: () => void;
}

function SelectedView({
  t,
  file,
  getActiveModelLabel,
  reset,
  handleTranscribe,
  transcribeDisabled,
  requiresUpgrade,
  fileTooLarge,
  isLargeFile,
  isOpenWhisprCloud,
  byokTooLarge,
  requiresAccount,
  isProUser,
  onUpgrade,
  onCreateAccount,
  onSwitchToCloud,
}: SelectedViewProps) {
  const canTranscribe = !fileTooLarge && !requiresUpgrade && !byokTooLarge;

  return (
    <div style={{ animation: "float-up 0.3s ease-out" }}>
      <div className="rounded-lg border border-foreground/8 dark:border-white/6 bg-surface-1/40 dark:bg-white/[0.03] backdrop-blur-sm p-4 mb-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-[8px] bg-primary/8 dark:bg-primary/12 border border-primary/10 dark:border-primary/15 flex items-center justify-center shrink-0">
            <FileAudio size={15} className="text-primary/60" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-foreground/70 truncate font-medium">{file.name}</p>
            {file.size && <p className="text-xs text-foreground/25 mt-0.5">{file.size}</p>}
            <p className="text-xs text-foreground/20 mt-0.5">{getActiveModelLabel()}</p>
          </div>
          <button
            onClick={reset}
            className="text-foreground/15 hover:text-foreground/40 transition-colors p-1 rounded"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Cloud absolute limit (500 MB) */}
      {fileTooLarge && (
        <div className="rounded-lg border border-destructive/12 dark:border-destructive/15 bg-destructive/[0.03] px-3 py-2.5 mb-3">
          <p className="text-xs text-destructive/60 leading-relaxed">
            {t("notes.upload.fileTooLarge")}
          </p>
        </div>
      )}

      {/* BYOK file too large — shared explanation */}
      {byokTooLarge && (
        <div className="rounded-lg border border-primary/12 dark:border-primary/15 bg-primary/[0.03] px-3 py-2.5 mb-3">
          <p className="text-xs text-foreground/50 leading-relaxed">
            {t("notes.upload.byokTooLarge")}
          </p>
          <p className="text-xs text-foreground/35 leading-relaxed mt-1.5">
            {t("notes.upload.byokTooLargeDetail")}
          </p>
          <p className="text-xs text-foreground/50 leading-relaxed mt-1.5 font-medium">
            {requiresAccount
              ? t("notes.upload.byokTooLargeNeedsAccount")
              : isProUser
                ? t("notes.upload.switchToCloudForLargeFiles")
                : t("notes.upload.byokTooLargeNeedsUpgrade")}
          </p>
        </div>
      )}

      {/* Cloud free user, file > 25 MB → needs paid plan */}
      {requiresUpgrade && !fileTooLarge && (
        <div className="rounded-lg border border-primary/12 dark:border-primary/15 bg-primary/[0.03] px-3 py-2.5 mb-3">
          <p className="text-xs text-foreground/50 leading-relaxed">
            {t("notes.upload.paidPlanRequired")}
          </p>
        </div>
      )}

      {/* Cloud large file info (Pro user, will be chunked) */}
      {isLargeFile && !requiresUpgrade && !fileTooLarge && isOpenWhisprCloud && (
        <p className="text-xs text-foreground/20 text-center mb-3">
          {t("notes.upload.largeFileNote")}
        </p>
      )}

      <div className="flex items-center gap-2 justify-center flex-wrap">
        {/* BYOK too large — not signed in: Create Account */}
        {byokTooLarge && requiresAccount && (
          <Button
            variant="default"
            size="sm"
            onClick={onCreateAccount}
            className="h-8 text-xs px-5"
          >
            {t("notes.upload.createAccount")}
          </Button>
        )}

        {/* BYOK too large — signed in, Pro: Switch to Cloud */}
        {byokTooLarge && !requiresAccount && isProUser && (
          <Button
            variant="default"
            size="sm"
            onClick={onSwitchToCloud}
            className="h-8 text-xs px-5"
          >
            {t("notes.upload.switchToCloud")}
          </Button>
        )}

        {/* BYOK too large — signed in, Free: Upgrade */}
        {byokTooLarge && !requiresAccount && !isProUser && (
          <Button variant="default" size="sm" onClick={onUpgrade} className="h-8 text-xs px-5">
            {t("notes.upload.upgrade")}
          </Button>
        )}

        {/* Cloud requires upgrade */}
        {!byokTooLarge && requiresUpgrade && (
          <Button variant="default" size="sm" onClick={onUpgrade} className="h-8 text-xs px-5">
            {t("notes.upload.upgrade")}
          </Button>
        )}

        {/* Normal: can transcribe */}
        {canTranscribe && (
          <Button
            variant="default"
            size="sm"
            onClick={handleTranscribe}
            disabled={transcribeDisabled}
            className="h-8 text-xs px-5"
          >
            {t("notes.upload.transcribe")}
          </Button>
        )}

        {/* Cancel button — always shown */}
        <Button
          variant="ghost"
          size="sm"
          onClick={reset}
          className="h-8 text-xs text-foreground/35"
        >
          {t("notes.upload.cancel")}
        </Button>
      </div>
    </div>
  );
}

interface TranscribingViewProps {
  t: (key: string, options?: Record<string, unknown>) => string;
  progress: number;
  getTranscribingLabel: () => string;
  file: { name: string; path: string; size: string; sizeBytes: number } | null;
  chunkProgress: { chunksTotal: number; chunksCompleted: number } | null;
  onCancel: () => void;
}

function TranscribingView({
  t,
  progress,
  getTranscribingLabel,
  file,
  chunkProgress,
  onCancel,
}: TranscribingViewProps) {
  const hasChunkInfo = chunkProgress !== null && chunkProgress.chunksTotal > 0;

  return (
    <div className="flex flex-col items-center" style={{ animation: "float-up 0.3s ease-out" }}>
      <div className="flex items-end justify-center gap-[3px] h-10 mb-5">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            className="w-[3px] rounded-full bg-primary/40 dark:bg-primary/50 origin-bottom"
            style={{
              height: "100%",
              animation: `waveform-bar ${0.8 + i * 0.12}s ease-in-out infinite`,
              animationDelay: `${i * 0.08}s`,
            }}
          />
        ))}
      </div>

      <div className="w-full max-w-[200px] h-[3px] rounded-full bg-foreground/5 dark:bg-white/5 overflow-hidden mb-3">
        <div
          className="h-full rounded-full bg-primary/50 transition-[width] duration-500 ease-out"
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>

      <p className="text-xs text-foreground/50 font-medium">{getTranscribingLabel()}</p>
      {hasChunkInfo ? (
        <p className="text-xs text-foreground/20 mt-1">
          {t("notes.upload.chunkProgress", {
            completed: chunkProgress.chunksCompleted,
            total: chunkProgress.chunksTotal,
          })}
        </p>
      ) : null}
      {!hasChunkInfo && file ? (
        <p className="text-xs text-foreground/20 mt-1 truncate max-w-50">{file.name}</p>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        onClick={onCancel}
        className="h-7 text-xs text-foreground/30 mt-4"
      >
        {t("notes.upload.cancelTranscription")}
      </Button>
    </div>
  );
}

interface FolderSelectProps {
  t: (key: string) => string;
  folders: FolderItem[];
  value: string;
  onChange: (val: string) => void;
  includeCreateNew?: boolean;
  className?: string;
}

function FolderSelect({
  t,
  folders,
  value,
  onChange,
  includeCreateNew,
  className,
}: FolderSelectProps) {
  return (
    <div className={cn("flex items-center justify-center gap-2", className)}>
      <FolderOpen size={12} className="text-foreground/20 shrink-0" />
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-7 w-44 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3">
          <SelectValue placeholder={t("notes.upload.selectFolder")} />
        </SelectTrigger>
        <SelectContent>
          {folders.map((f) => {
            const isMeetings = f.name === MEETINGS_FOLDER_NAME && !!f.is_default;
            return (
              <SelectItem
                key={f.id}
                value={String(f.id)}
                disabled={isMeetings}
                className="text-xs py-1.5 pl-2.5 pr-7 rounded-md"
              >
                <span className="flex items-center gap-1.5">
                  {f.name}
                  {isMeetings && (
                    <span className="text-[8px] uppercase tracking-wider text-foreground/25 font-medium">
                      {t("notes.folders.soon")}
                    </span>
                  )}
                </span>
              </SelectItem>
            );
          })}
          {includeCreateNew && (
            <>
              <SelectSeparator />
              <SelectItem value="__create_new__" className="text-xs py-1.5 pl-2.5 pr-7 rounded-md">
                <span className="flex items-center gap-1.5 text-primary/60">
                  <Plus size={11} />
                  {t("notes.upload.newFolder")}
                </span>
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

interface CompleteViewProps {
  t: (key: string) => string;
  result: string;
  partialWarning: boolean;
  folders: FolderItem[];
  selectedFolderId: string;
  handleFolderChange: (val: string) => void;
  noteId: number | null;
  onNoteCreated?: (noteId: number, folderId: number | null) => void;
  reset: () => void;
}

function CompleteView({
  t,
  result,
  partialWarning,
  folders,
  selectedFolderId,
  handleFolderChange,
  noteId,
  onNoteCreated,
  reset,
}: CompleteViewProps) {
  return (
    <div className="flex flex-col items-center" style={{ animation: "float-up 0.3s ease-out" }}>
      <div className="relative w-12 h-12 mb-4">
        <svg className="w-12 h-12 -rotate-90" viewBox="0 0 36 36">
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            strokeWidth="1.5"
            className="stroke-success/15"
          />
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            strokeWidth="1.5"
            className="stroke-success/60"
            strokeDasharray="94.25"
            strokeLinecap="round"
            style={{ animation: "ring-fill 0.8s ease-out forwards" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <svg className="w-5 h-5 text-success/70" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 13l4 4L19 7"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="24"
              strokeDashoffset="24"
              style={{ animation: "draw-check 0.4s ease-out 0.5s forwards" }}
            />
          </svg>
        </div>
      </div>

      <p className="text-xs text-foreground/60 font-medium mb-1">
        {t("notes.upload.transcriptionComplete")}
      </p>
      <p className="text-xs text-foreground/25 max-w-[240px] text-center line-clamp-2 mb-4">
        {result.slice(0, 150)}
      </p>

      {partialWarning && (
        <p className="text-xs text-destructive/50 max-w-[240px] text-center mb-4 -mt-2">
          {t("notes.upload.partialWarning")}
        </p>
      )}

      {folders.length > 0 && (
        <FolderSelect
          t={t}
          folders={folders}
          value={selectedFolderId}
          onChange={handleFolderChange}
          includeCreateNew
          className="mb-4"
        />
      )}

      <div className="flex items-center gap-2">
        {noteId != null && onNoteCreated && (
          <Button
            variant="default"
            size="sm"
            onClick={() =>
              onNoteCreated(noteId, selectedFolderId ? Number(selectedFolderId) : null)
            }
            className="h-8 text-xs"
          >
            {t("notes.upload.openNote")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={reset}
          className="h-8 text-xs text-foreground/35"
        >
          {t("notes.upload.uploadAnother")}
        </Button>
      </div>
    </div>
  );
}

interface ErrorViewProps {
  t: (key: string) => string;
  error: string;
  reset: () => void;
  onRetry: () => void;
}

function ErrorView({ t, error, reset, onRetry }: ErrorViewProps) {
  return (
    <div style={{ animation: "float-up 0.3s ease-out" }}>
      <div className="rounded-lg border border-destructive/15 dark:border-destructive/20 bg-destructive/[0.03] dark:bg-destructive/[0.05] backdrop-blur-sm p-4 mb-4">
        <div className="flex items-start gap-2.5">
          <AlertCircle size={14} className="text-destructive/50 shrink-0 mt-0.5" />
          <p className="flex-1 text-xs text-destructive/70 leading-relaxed">{error}</p>
          <button
            onClick={reset}
            className="text-foreground/15 hover:text-foreground/30 transition-colors shrink-0 p-0.5 rounded"
          >
            <X size={11} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 justify-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRetry}
          className="h-7 text-xs text-foreground/40"
        >
          {t("notes.upload.retry")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={reset}
          className="h-7 text-xs text-foreground/25"
        >
          {t("notes.upload.startOver")}
        </Button>
      </div>
    </div>
  );
}
