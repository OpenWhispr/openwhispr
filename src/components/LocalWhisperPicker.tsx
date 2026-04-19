import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import { ConfirmDialog } from "./ui/dialog";
import ModelCardList, { type ModelCardOption } from "./ui/ModelCardList";
import { useDialogs } from "../hooks/useDialogs";
import { useModelDownload } from "../hooks/useModelDownload";
import { WHISPER_MODEL_INFO } from "../models/ModelRegistry";
import { MODEL_PICKER_COLORS, type ColorScheme } from "../utils/modelPickerStyles";
import { getProviderIcon } from "../utils/providerIcons";

interface WhisperModel {
  model: string;
  size_mb?: number;
  downloaded?: boolean;
}

interface LocalWhisperPickerProps {
  selectedModel: string;
  onModelSelect: (modelId: string) => void;
  onModelDownloaded?: (modelId: string) => void;
  className?: string;
  variant?: "onboarding" | "settings";
}

export default function LocalWhisperPicker({
  selectedModel,
  onModelSelect,
  onModelDownloaded,
  className = "",
  variant = "settings",
}: LocalWhisperPickerProps) {
  const { t } = useTranslation();
  const [models, setModels] = useState<WhisperModel[]>([]);
  const hasLoadedRef = useRef(false);
  const downloadingModelRef = useRef<string | null>(null);
  const selectedModelRef = useRef(selectedModel);
  const onModelSelectRef = useRef(onModelSelect);

  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const colorScheme: ColorScheme = variant === "settings" ? "purple" : "blue";
  const styles = useMemo(() => MODEL_PICKER_COLORS[colorScheme], [colorScheme]);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);
  useEffect(() => {
    onModelSelectRef.current = onModelSelect;
  }, [onModelSelect]);

  const validateAndSelectModel = useCallback((loadedModels: WhisperModel[]) => {
    const current = selectedModelRef.current;
    if (!current) return;

    const downloaded = loadedModels.filter((m) => m.downloaded);
    const isCurrentDownloaded = loadedModels.find((m) => m.model === current)?.downloaded;

    if (!isCurrentDownloaded && downloaded.length > 0) {
      onModelSelectRef.current(downloaded[0].model);
    } else if (!isCurrentDownloaded && downloaded.length === 0) {
      onModelSelectRef.current("");
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const result = await window.electronAPI?.listWhisperModels();
      if (result?.success) {
        setModels(result.models);
        validateAndSelectModel(result.models);
      }
    } catch (error) {
      console.error("[LocalWhisperPicker] Failed to load models:", error);
      setModels([]);
    }
  }, [validateAndSelectModel]);

  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    window.electronAPI
      ?.listWhisperModels()
      .then((result) => {
        if (result?.success) {
          setModels(result.models);
          validateAndSelectModel(result.models);
        }
      })
      .catch((error) => {
        console.error("[LocalWhisperPicker] Failed to load models:", error);
        setModels([]);
      });
  }, [validateAndSelectModel]);

  const {
    downloadingModel,
    downloadProgress,
    downloadModel,
    deleteModel,
    isDownloadingModel,
    cancelDownload,
    isCancelling,
  } = useModelDownload({
    modelType: "whisper",
    onDownloadComplete: () => {
      loadModels();
      if (downloadingModelRef.current && onModelDownloaded) {
        onModelDownloaded(downloadingModelRef.current);
      }
    },
    onModelsCleared: loadModels,
  });

  useEffect(() => {
    downloadingModelRef.current = downloadingModel;
  }, [downloadingModel]);

  const handleDownload = useCallback(
    (modelId: string) => {
      downloadModel(modelId, onModelSelect);
    },
    [downloadModel, onModelSelect]
  );

  const handleDelete = useCallback(
    (modelId: string) => {
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteModel(modelId, async () => {
            const result = await window.electronAPI?.listWhisperModels();
            if (result?.success) {
              setModels(result.models);
              validateAndSelectModel(result.models);
            }
          });
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, deleteModel, validateAndSelectModel, t]
  );

  const progressDisplay = useMemo(() => {
    if (!downloadingModel) return null;
    const modelInfo = WHISPER_MODEL_INFO[downloadingModel];
    return (
      <DownloadProgressBar
        modelName={modelInfo?.name || downloadingModel}
        progress={downloadProgress}
      />
    );
  }, [downloadingModel, downloadProgress]);

  const whisperIcon = getProviderIcon("whisper");

  return (
    <div className={`${styles.container} ${className}`}>
      {progressDisplay}

      <div className="p-4">
        <h5 className={`${styles.header} mb-3`}>{t("transcription.whisperModels")}</h5>

        <ModelCardList
          models={models.map((model): ModelCardOption => {
            const modelId = model.model;
            const info = WHISPER_MODEL_INFO[modelId] ?? {
              name: modelId,
              description: t("transcription.fallback.whisperModelDescription"),
              size: t("common.unknown"),
              recommended: false,
            };
            return {
              value: modelId,
              label: info.name,
              description: model.size_mb ? `${model.size_mb}MB` : info.size,
              icon: whisperIcon,
              invertInDark: true,
              recommended: info.recommended,
              isDownloaded: model.downloaded,
              isDownloading: isDownloadingModel(modelId),
            };
          })}
          selectedModel={selectedModel}
          onModelSelect={onModelSelect}
          onDownload={handleDownload}
          onDelete={handleDelete}
          onCancelDownload={cancelDownload}
          isCancelling={isCancelling}
          colorScheme={colorScheme}
        />
      </div>

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </div>
  );
}
