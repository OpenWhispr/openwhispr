import React, { useState, useRef, useEffect, Suspense } from "react";
import { useTranslation } from "react-i18next";
import {
  Upload,
  FileAudio,
  X,
  AlertCircle,
  Cloud,
  ChevronRight,
  Key,
  FolderOpen,
  Plus,
  Settings,
  Link2,
} from "lucide-react";
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
import { findDefaultFolder, MEETINGS_FOLDER_NAME, VIDEOS_FOLDER_NAME } from "./shared";
import { useAuth } from "../../hooks/useAuth";
import { useUsage } from "../../hooks/useUsage";
import { useSettings } from "../../hooks/useSettings";
import { withSessionRefresh } from "../../lib/auth";
import { getAllReasoningModels } from "../../models/ModelRegistry";
import { useSettingsStore, selectIsCloudCleanupMode } from "../../stores/settingsStore";
import { useBatchQueue } from "../../hooks/useBatchQueue";
import type { TranscribeOptions, DiarizationOptions } from "../../hooks/useBatchQueue";
import BatchQueueView from "./BatchQueueView";
import { generateNoteTitle } from "../../utils/generateTitle";

const TranscriptionModelPicker = React.lazy(() => import("../TranscriptionModelPicker"));

type UploadState = "idle" | "selected" | "downloading" | "transcribing" | "complete" | "error";

const SUPPORTED_EXTENSIONS = ["mp3", "wav", "m4a", "webm", "ogg", "flac", "aac"];

const BYOK_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB — hard limit for bring-your-own-key
const CLOUD_FREE_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB — free plan cloud limit
const CLOUD_PRO_MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB — pro plan cloud limit

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  } | null>(null);
  const [result, setResult] = useState<string | null>(null);
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

  const [urlInput, setUrlInput] = useState("");
  const [downloadProgress, setDownloadProgress] = useState<{
    stage: string;
    percent: number;
    title?: string;
  } | null>(null);
  const [downloadedTempPath, setDownloadedTempPath] = useState<string | null>(null);
  const [urlExpanded, setUrlExpanded] = useState(false);

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

  useEffect(() => {
    window.electronAPI.getDiarizationModelStatus?.().then((status) => {
      setDiarizationModelsReady(status?.modelsDownloaded ?? false);
    });
  }, []);

  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("");
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const [setupDismissed, setSetupDismissed] = useState(
    () =>
      localStorage.getItem("uploadSetupComplete") === "true" ||
      localStorage.getItem("notesOnboardingComplete") === "true"
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [providerReady, setProviderReady] = useState<boolean | null>(null);

  const { isSignedIn } = useAuth();
  const usage = useUsage();
  const isProUser = usage?.isSubscribed || usage?.isTrial;

  const {
    useLocalWhisper,
    setUseLocalWhisper,
    whisperModel,
    setWhisperModel,
    localTranscriptionProvider,
    setLocalTranscriptionProvider,
    parakeetModel,
    setParakeetModel,
    cloudTranscriptionProvider,
    setCloudTranscriptionProvider,
    cloudTranscriptionModel,
    setCloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    setCloudTranscriptionBaseUrl,
    cloudTranscriptionMode,
    setCloudTranscriptionMode,
    openaiApiKey,
    groqApiKey,
    mistralApiKey,
    customTranscriptionApiKey,
    updateTranscriptionSettings,
  } = useSettings();

  const isCloudCleanup = useSettingsStore(selectIsCloudCleanupMode);
  const effectiveCleanupModel = useSettingsStore((s) =>
    selectIsCloudCleanupMode(s) ? "" : s.cleanupModel
  );
  const useCleanupModel = useSettingsStore((s) => s.useCleanupModel);

  const isOpenWhisprCloud =
    isSignedIn && cloudTranscriptionMode === "openwhispr" && !useLocalWhisper;
  const usageLoaded = usage?.hasLoaded ?? false;
  const showSetup = usageLoaded && !isProUser && !setupDismissed && state === "idle";
  const showModelPicker = !isSignedIn || cloudTranscriptionMode === "byok" || useLocalWhisper;
  const shouldCenter = !showSetup && !advancedOpen;

  // Mode detection
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
    } else if (cloudTranscriptionProvider === "custom") {
      // Custom endpoints (e.g. local whisper.cpp): no file size restrictions
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
    window.electronAPI.getFolders?.().then((f) => {
      setFolders(f);
      const personal = findDefaultFolder(f);
      if (personal) setSelectedFolderId(String(personal.id));
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
        if (cloudTranscriptionProvider === "custom") {
          // Custom providers only need a base URL; API key is truly optional
          if (!cancelled) setProviderReady(!!cloudTranscriptionBaseUrl?.trim());
        } else {
          const key =
            cloudTranscriptionProvider === "openai"
              ? openaiApiKey
              : cloudTranscriptionProvider === "groq"
                ? groqApiKey
                : cloudTranscriptionProvider === "mistral"
                  ? mistralApiKey
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
    useLocalWhisper,
    localTranscriptionProvider,
    cloudTranscriptionProvider,
    cloudTranscriptionBaseUrl,
    openaiApiKey,
    groqApiKey,
    mistralApiKey,
    customTranscriptionApiKey,
  ]);

  const getActiveModelLabel = (): string => {
    if (isOpenWhisprCloud) return t("notes.upload.openwhisprCloud");
    if (useLocalWhisper) {
      if (localTranscriptionProvider === "nvidia")
        return `Parakeet · ${parakeetModel || "default"}`;
      return `Whisper · ${whisperModel || "base"}`;
    }
    const name =
      cloudTranscriptionProvider === "custom"
        ? t("notes.upload.custom")
        : cloudTranscriptionProvider.charAt(0).toUpperCase() + cloudTranscriptionProvider.slice(1);
    return `${name} · ${cloudTranscriptionModel}`;
  };

  const getActiveApiKey = (): string => {
    switch (cloudTranscriptionProvider) {
      case "openai":
        return openaiApiKey;
      case "groq":
        return groqApiKey;
      case "mistral":
        return mistralApiKey;
      case "custom":
        return customTranscriptionApiKey || "";
      default:
        return "";
    }
  };

  const generateTitle = async (text: string): Promise<string> => {
    if (!useCleanupModel) return "";
    const model = isCloudCleanup ? "" : effectiveCleanupModel || getAllReasoningModels()[0]?.value;
    if (!model && !isCloudCleanup) return "";
    return generateNoteTitle(text, model);
  };

  const handleBrowse = async () => {
    const res = await window.electronAPI.selectAudioFile({ multiple: true });
    if (res.canceled) return;

    const filePaths: string[] = res.filePaths || (res.filePath ? [res.filePath] : []);
    if (filePaths.length === 0) return;

    if (filePaths.length === 1) {
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

    if (validFiles.length === 1) {
      const f = validFiles[0];
      setFile({ name: f.name, path: f.path, size: formatFileSize(f.sizeBytes), sizeBytes: f.sizeBytes });
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
    setNoteId(null);
    setError(null);
    setProgress(0);
    setChunkProgress(null);
    setUrlInput("");
    setDownloadProgress(null);
    const personal = findDefaultFolder(folders);
    if (personal) setSelectedFolderId(String(personal.id));
  };

  const handleTranscribe = async () => {
    if (!file) return;
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
      const byokUseDiarize = diarizationEnabled &&
        !useLocalWhisper && !isOpenWhisprCloud &&
        (cloudTranscriptionProvider === "openai" || cloudTranscriptionProvider === "mistral");

      const diarizePromise =
        diarizationEnabled && diarizationModelsReady && !byokUseDiarize
          ? window.electronAPI.diarizeAudioFile?.(file.path, {
              numSpeakers: diarizationNumSpeakers ? Number(diarizationNumSpeakers) : undefined,
            }).catch(() => null)
          : null;

      let res: { success: boolean; text?: string; error?: string; code?: string; diarized?: boolean };

      if (isOpenWhisprCloud) {
        res = await withSessionRefresh(async () => {
          const r = await window.electronAPI.transcribeAudioFileCloud!(file.path);
          if (!r.success && r.code) {
            throw Object.assign(new Error(r.error || "Cloud transcription failed"), {
              code: r.code,
            });
          }
          return r;
        });
      } else if (useLocalWhisper) {
        res = await window.electronAPI.transcribeAudioFile(file.path, {
          provider: localTranscriptionProvider as "whisper" | "nvidia",
          model: localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel,
        });
      } else {
        res = await window.electronAPI.transcribeAudioFileByok!({
          filePath: file.path,
          apiKey: getActiveApiKey(),
          baseUrl: cloudTranscriptionBaseUrl || "",
          model: cloudTranscriptionModel,
          diarize: byokUseDiarize || undefined,
        });
      }

      if (progressRef.current) clearInterval(progressRef.current);
      if (progressCleanupRef.current) progressCleanupRef.current();
      progressCleanupRef.current = null;

      if (res.success && res.text) {
        setProgress(100);
        setResult(res.text);

        let title: string;
        if (file.fromUrl) {
          title = file.name;
        } else {
          const textFallback = res.text.trim().split(/\s+/).slice(0, 6).join(" ");
          const fallbackTitle =
            textFallback.length > 0
              ? textFallback + (res.text.trim().split(/\s+/).length > 6 ? "..." : "")
              : file.name.replace(/\.[^.]+$/, "");
          const aiTitle = await generateTitle(res.text);
          title = aiTitle || fallbackTitle;
        }

        let finalText = res.text;
        if (res.diarized) {
          // Cloud diarization already applied
        } else if (diarizePromise) {
          try {
            const diarResult = await diarizePromise;
            if (diarResult?.success && diarResult.segments && diarResult.segments.length > 0) {
              const duration = diarResult.segments[diarResult.segments.length - 1]?.end || 0;
              const mergeResult = await window.electronAPI.mergeSpeakerText?.(
                diarResult.segments, finalText, duration
              );
              if (mergeResult?.success && mergeResult.text) {
                finalText = mergeResult.text;
              }
            }
          } catch {
            // Diarization failed, save without speaker labels
          }
        }

        const folderId = selectedFolderId ? Number(selectedFolderId) : null;
        const noteRes = await window.electronAPI.saveNote(
          title,
          finalText,
          "upload",
          file.name,
          null,
          folderId
        );
        if (noteRes.success && noteRes.note) setNoteId(noteRes.note.id);
        if (downloadedTempPath) {
          window.electronAPI.deleteTempFile(downloadedTempPath);
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
    if (!trimmed || batch.isProcessing) return;

    try {
      new URL(trimmed);
    } catch {
      setError(t("notes.upload.urlInvalid"));
      setState("error");
      return;
    }

    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      setError(t("notes.upload.urlInvalid"));
      setState("error");
      return;
    }

    setState("downloading");
    setError(null);
    setDownloadProgress({ stage: "resolving", percent: 0 });

    const cleanupProgress = !batch.isProcessing
      ? window.electronAPI.onUrlDownloadProgress?.((data) => {
          setDownloadProgress(data);
        })
      : undefined;

    try {
      const res = await window.electronAPI.downloadUrlAudio(trimmed);

      if (!res.success) {
        const fail = res as { success: false; error: string; code?: string };
        const errorMap: Record<string, string> = {
          INVALID_URL: t("notes.upload.urlInvalid"),
          VIDEO_UNAVAILABLE: t("notes.upload.urlVideoUnavailable"),
          PLAYLIST_URL: t("notes.upload.urlPlaylistNotSupported"),
          CONTENT_TYPE_INVALID: t("notes.upload.urlContentTypeInvalid"),
          DOWNLOAD_FAILED: t("notes.upload.urlDownloadFailed"),
          DOWNLOAD_CANCELLED: "",
        };

        if (fail.code === "DOWNLOAD_CANCELLED") {
          setState("idle");
          return;
        }

        setError(errorMap[fail.code || ""] || fail.error || t("notes.upload.urlDownloadFailed"));
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
      });
      const videosFolder = folders.find(
        (f) => f.name === VIDEOS_FOLDER_NAME && f.is_default
      );
      if (videosFolder) setSelectedFolderId(String(videosFolder.id));
      setState("selected");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("notes.upload.urlDownloadFailed"));
      setState("error");
    } finally {
      cleanupProgress?.();
      setDownloadProgress(null);
    }
  };

  const handleCancelDownload = () => {
    window.electronAPI.cancelUrlDownload();
  };

  const handleBatchUrlSubmit = () => {
    const lines = urlInput
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const seen = new Set<string>();
    const validUrls: string[] = [];
    for (const line of lines) {
      try {
        const parsed = new URL(line);
        if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !seen.has(line)) {
          seen.add(line);
          validUrls.push(line);
        }
      } catch {
        // skip invalid
      }
    }

    const MAX_BATCH_URLS = 50;
    if (validUrls.length > 0) {
      batch.addUrls(validUrls.slice(0, MAX_BATCH_URLS));
      setUrlInput("");
      setUrlExpanded(false);
    }
  };

  const startBatchProcessing = () => {
    const folderId = selectedFolderId ? Number(selectedFolderId) : null;

    const transcribeOpts: TranscribeOptions = {
      useLocalWhisper,
      localTranscriptionProvider: localTranscriptionProvider as string,
      whisperModel,
      parakeetModel,
      isOpenWhisprCloud,
      getActiveApiKey,
      cloudTranscriptionProvider: cloudTranscriptionProvider as string,
      cloudTranscriptionBaseUrl: cloudTranscriptionBaseUrl || "",
      cloudTranscriptionModel,
      folderId,
    };

    const diarizationOpts: DiarizationOptions = {
      enabled: diarizationEnabled && !!diarizationModelsReady,
      numSpeakers: diarizationNumSpeakers ? Number(diarizationNumSpeakers) : null,
    };

    batch.processQueue(transcribeOpts, diarizationOpts);
  };

  const dismissSetup = () => {
    localStorage.setItem("uploadSetupComplete", "true");
    setSetupDismissed(true);
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

  const handleCreateAccount = () => {
    localStorage.setItem("pendingCloudMigration", "true");
    localStorage.setItem("onboardingCurrentStep", "0");
    localStorage.removeItem("onboardingCompleted");
    window.location.reload();
  };

  const switchToCloud = () => {
    setCloudTranscriptionMode("openwhispr");
    setUseLocalWhisper(false);
    updateTranscriptionSettings({ useLocalWhisper: false });
  };

  const getTranscribingLabel = (): string => {
    if (isOpenWhisprCloud) return t("notes.upload.transcribingCloud");
    if (useLocalWhisper) return t("notes.upload.transcribingLocal");
    return t("notes.upload.transcribingProvider", { provider: cloudTranscriptionProvider });
  };

  const modeSelector = isSignedIn ? (
    <div className="flex items-center rounded-md border border-foreground/6 dark:border-white/6 bg-surface-1/30 dark:bg-white/[0.02] p-0.5 mb-3">
      <button
        onClick={() => {
          setCloudTranscriptionMode("openwhispr");
          setUseLocalWhisper(false);
          updateTranscriptionSettings({ useLocalWhisper: false });
        }}
        className={cn(
          "flex-1 flex items-center justify-center gap-1.5 h-7 rounded text-xs font-medium transition-colors duration-150",
          isOpenWhisprCloud
            ? "bg-foreground/[0.06] dark:bg-white/8 text-foreground/70"
            : "text-foreground/30 hover:text-foreground/50"
        )}
      >
        <Cloud size={11} />
        {t("notes.upload.openwhisprCloud")}
      </button>
      <button
        onClick={() => setCloudTranscriptionMode("byok")}
        className={cn(
          "flex-1 flex items-center justify-center gap-1.5 h-7 rounded text-xs font-medium transition-colors duration-150",
          !isOpenWhisprCloud
            ? "bg-foreground/[0.06] dark:bg-white/8 text-foreground/70"
            : "text-foreground/30 hover:text-foreground/50"
        )}
      >
        <Key size={11} />
        {t("notes.upload.custom")}
      </button>
    </div>
  ) : null;

  const modelPicker = showModelPicker ? (
    <Suspense fallback={null}>
      <TranscriptionModelPicker
        selectedCloudProvider={cloudTranscriptionProvider}
        onCloudProviderSelect={setCloudTranscriptionProvider}
        selectedCloudModel={cloudTranscriptionModel}
        onCloudModelSelect={setCloudTranscriptionModel}
        selectedLocalModel={localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel}
        onLocalModelSelect={(modelId) => {
          if (localTranscriptionProvider === "nvidia") {
            setParakeetModel(modelId);
          } else {
            setWhisperModel(modelId);
          }
        }}
        selectedLocalProvider={localTranscriptionProvider}
        onLocalProviderSelect={(id) => setLocalTranscriptionProvider(id as "whisper" | "nvidia")}
        useLocalWhisper={useLocalWhisper}
        onModeChange={(isLocal) => {
          setUseLocalWhisper(isLocal);
          updateTranscriptionSettings({ useLocalWhisper: isLocal });
          if (isLocal) setCloudTranscriptionMode("byok");
        }}
        cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
        setCloudTranscriptionBaseUrl={setCloudTranscriptionBaseUrl}
        variant="settings"
      />
    </Suspense>
  ) : null;

  return (
    <div className="flex flex-col items-center h-full overflow-y-auto px-6">
      <div
        className={cn("w-full max-w-md shrink-0", shouldCenter ? "my-auto" : "pt-4 pb-8")}
        style={{ animation: "float-up 0.4s ease-out" }}
      >
        {showSetup && (
          <div className="mb-6" style={{ animation: "float-up 0.3s ease-out" }}>
            <div className="flex flex-col items-center mb-5">
              <div className="w-10 h-10 rounded-[10px] bg-linear-to-b from-primary/10 to-primary/[0.03] dark:from-primary/15 dark:to-primary/5 border border-primary/15 dark:border-primary/20 flex items-center justify-center mb-3">
                <Upload size={17} strokeWidth={1.5} className="text-primary/50" />
              </div>
              <h2 className="text-xs font-semibold text-foreground mb-1">
                {t("notes.upload.setupTitle")}
              </h2>
              <p className="text-xs text-foreground/30 text-center leading-relaxed max-w-[280px]">
                {t("notes.upload.setupDescription")}
              </p>
            </div>

            {modeSelector}
            {modelPicker}

            <div className="flex justify-center mt-4">
              <Button
                variant="default"
                size="sm"
                onClick={dismissSetup}
                className="h-8 text-xs px-6"
              >
                {t("notes.upload.continue")}
              </Button>
            </div>

            <div className="h-px bg-foreground/5 dark:bg-white/5 my-5" />
          </div>
        )}

        <div className="max-w-[320px] mx-auto">
          {state === "idle" && providerReady === false && (
            <NoProviderView t={t} onOpenSettings={() => onOpenSettings?.("transcription")} />
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
                    className={cn(
                      "w-full px-3 py-2 rounded-lg text-xs resize-none",
                      "bg-surface-1/40 dark:bg-white/[0.03] backdrop-blur-sm",
                      "border border-foreground/6 dark:border-white/6",
                      "text-foreground/70 placeholder:text-foreground/20",
                      "focus:outline-none focus:border-foreground/12 dark:focus:border-white/10",
                      "transition-colors"
                    )}
                    autoFocus
                  />
                  <div className="flex items-center gap-2 mt-2 justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setUrlExpanded(false); setUrlInput(""); }}
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
                  {(() => { try { const h = new URL(urlInput).hostname; return h === "youtu.be" || h.endsWith(".youtube.com") || h === "youtube.com"; } catch { return false; } })() ? (
                    <svg viewBox="0 0 28 20" className="absolute left-2.5 top-1/2 -translate-y-1/2 w-[18px] h-[13px] z-10 pointer-events-none">
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
                    className={cn(
                      "w-full h-8 pl-8 pr-9 rounded-lg text-xs",
                      "bg-surface-1/40 dark:bg-white/[0.03] backdrop-blur-sm",
                      "border border-foreground/6 dark:border-white/6",
                      "text-foreground/70 placeholder:text-foreground/20",
                      "focus:outline-none focus:border-foreground/12 dark:focus:border-white/10",
                      "transition-colors"
                    )}
                  />
                  <button
                    onClick={handleUrlSubmit}
                    disabled={!urlInput.trim() || batch.isProcessing}
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

          {batch.hasQueue && (
            <div className="mt-3">
              <BatchQueueView
                queue={batch.queue}
                completedCount={batch.completedCount}
                totalCount={batch.totalCount}
                isProcessing={batch.isProcessing}
                onRemoveItem={batch.removeItem}
                onCancelAll={batch.cancelAll}
                onClearQueue={batch.clearQueue}
                onOpenNote={(noteId) => onNoteCreated?.(noteId, null)}
              />

              {!batch.isProcessing && batch.queue.some((i) => i.status === "queued") && (
                <div className="mt-3 space-y-2">
                  {folders.length > 0 && (
                    <div className="flex items-center justify-center gap-2">
                      <FolderOpen size={12} className="text-foreground/20 shrink-0" />
                      <Select value={selectedFolderId} onValueChange={handleFolderChange}>
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
                                {f.name}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="flex justify-center">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={startBatchProcessing}
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
                    downloadProgress.stage !== "downloading" && "animate-pulse"
                  )}
                  style={{
                    width:
                      downloadProgress.stage === "downloading"
                        ? `${Math.min(downloadProgress.percent, 100)}%`
                        : "100%",
                  }}
                />
              </div>

              <p className="text-xs text-foreground/50 font-medium">
                {downloadProgress.stage === "resolving" && t("notes.upload.urlResolving")}
                {downloadProgress.stage === "downloading" && t("notes.upload.urlDownloading")}
                {downloadProgress.stage === "converting" && t("notes.upload.urlConverting")}
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
            />
          )}

          {state === "complete" && result && (
            <CompleteView
              t={t}
              result={result}
              folders={folders}
              selectedFolderId={selectedFolderId}
              handleFolderChange={handleFolderChange}
              noteId={noteId}
              onNoteCreated={onNoteCreated}
              reset={reset}
            />
          )}

          {state === "error" && error && (
            <ErrorView t={t} error={error} reset={reset} handleTranscribe={handleTranscribe} />
          )}
        </div>

        {!showSetup && (state === "idle" || state === "selected") && (
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
                onClick={async () => {
                  if (diarizationDownloading) return;
                  if (diarizationEnabled) {
                    setDiarizationEnabled(false);
                    return;
                  }
                  if (!diarizationModelsReady) {
                    setDiarizationDownloading(true);
                    try {
                      await window.electronAPI.downloadDiarizationModels?.();
                      const status = await window.electronAPI.getDiarizationModelStatus?.();
                      setDiarizationModelsReady(status?.modelsDownloaded ?? false);
                      if (status?.modelsDownloaded) setDiarizationEnabled(true);
                    } finally {
                      setDiarizationDownloading(false);
                    }
                    return;
                  }
                  setDiarizationEnabled(true);
                }}
                className={cn(
                  "relative w-7 h-4 rounded-full transition-colors shrink-0",
                  diarizationEnabled && diarizationModelsReady
                    ? "bg-primary"
                    : diarizationDownloading
                      ? "bg-primary/50 animate-pulse"
                      : "bg-muted"
                )}
                disabled={diarizationDownloading}
              >
                <div
                  className={cn(
                    "absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform",
                    diarizationEnabled && diarizationModelsReady
                      ? "translate-x-3"
                      : ""
                  )}
                />
              </button>
            </div>

            {diarizationEnabled && !useLocalWhisper && !isOpenWhisprCloud &&
              cloudTranscriptionProvider === "openai" && (
              <p className="text-[10px] text-foreground/25 mt-1.5">
                {t("notes.upload.openaiDiarizeNote")}
              </p>
            )}
            {diarizationEnabled && !useLocalWhisper && !isOpenWhisprCloud &&
              cloudTranscriptionProvider === "mistral" && (
              <p className="text-[10px] text-foreground/25 mt-1.5">
                {t("notes.upload.mistralDiarizeNote")}
              </p>
            )}
            {diarizationEnabled && !useLocalWhisper && !isOpenWhisprCloud &&
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
                  max="20"
                  value={diarizationNumSpeakers}
                  onChange={(e) => setDiarizationNumSpeakers(e.target.value)}
                  placeholder={t("notes.upload.numSpeakersPlaceholder")}
                  className={cn(
                    "w-full h-8 px-2.5 rounded-lg text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
                    "bg-surface-1/40 dark:bg-white/[0.03]",
                    "border border-foreground/6 dark:border-white/6",
                    "text-foreground/70 placeholder:text-foreground/20",
                    "focus:outline-none focus:border-foreground/12",
                    "transition-colors"
                  )}
                />
              </div>
            )}
          </div>
        )}

        {!showSetup && (state === "idle" || state === "selected") && (
          <div className="mx-auto mt-3" style={{ maxWidth: advancedOpen ? "448px" : "320px" }}>
            <button
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="flex items-center gap-1.5 text-xs text-foreground/25 hover:text-foreground/40 transition-colors mx-auto"
            >
              <ChevronRight
                size={10}
                className={cn("transition-transform duration-200", advancedOpen && "rotate-90")}
              />
              {t("notes.upload.transcriptionSettings")}
            </button>

            {advancedOpen && (
              <div className="mt-3" style={{ animation: "float-up 0.2s ease-out" }}>
                {modeSelector}
                {modelPicker}
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
        accept=".mp3,.wav,.m4a,.webm,.ogg,.flac,.aac"
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
}

function TranscribingView({
  t,
  progress,
  getTranscribingLabel,
  file,
  chunkProgress,
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
    </div>
  );
}

interface CompleteViewProps {
  t: (key: string) => string;
  result: string;
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

      {folders.length > 0 && (
        <div className="flex items-center justify-center gap-2 mb-4">
          <FolderOpen size={12} className="text-foreground/20 shrink-0" />
          <Select value={selectedFolderId} onValueChange={handleFolderChange}>
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
              <SelectSeparator />
              <SelectItem value="__create_new__" className="text-xs py-1.5 pl-2.5 pr-7 rounded-md">
                <span className="flex items-center gap-1.5 text-primary/60">
                  <Plus size={11} />
                  {t("notes.upload.newFolder")}
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
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
  handleTranscribe: () => void;
}

function ErrorView({ t, error, reset, handleTranscribe }: ErrorViewProps) {
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
          onClick={handleTranscribe}
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
