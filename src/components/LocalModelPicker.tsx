import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ProviderTabs } from "./ui/ProviderTabs";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import { ConfirmDialog } from "./ui/dialog";
import ModelCardList, { type ModelCardOption } from "./ui/ModelCardList";
import { useDialogs } from "../hooks/useDialogs";
import { useModelDownload, type ModelType } from "../hooks/useModelDownload";
import { MODEL_PICKER_COLORS, type ColorScheme } from "../utils/modelPickerStyles";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";

export interface LocalModel {
  id: string;
  name: string;
  size: string;
  sizeBytes?: number;
  description: string;
  descriptionKey?: string;
  isDownloaded?: boolean;
  downloaded?: boolean;
  recommended?: boolean;
}

export interface LocalProvider {
  id: string;
  name: string;
  models: LocalModel[];
}

interface LocalModelPickerProps {
  providers: LocalProvider[];
  selectedModel: string;
  selectedProvider: string;
  onModelSelect: (modelId: string) => void;
  onProviderSelect: (providerId: string) => void;
  modelType: ModelType;
  colorScheme?: Exclude<ColorScheme, "blue">;
  className?: string;
  onDownloadComplete?: () => void;
}

export default function LocalModelPicker({
  providers,
  selectedModel,
  selectedProvider,
  onModelSelect,
  onProviderSelect,
  modelType,
  colorScheme = "purple",
  className = "",
  onDownloadComplete,
}: LocalModelPickerProps) {
  const { t } = useTranslation();
  const [downloadedModels, setDownloadedModels] = useState<Set<string>>(new Set());

  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const styles = useMemo(() => MODEL_PICKER_COLORS[colorScheme], [colorScheme]);

  const loadDownloadedModels = useCallback(async () => {
    try {
      let downloaded = new Set<string>();
      if (modelType === "whisper") {
        const result = await window.electronAPI?.listWhisperModels();
        if (result?.success) {
          downloaded = new Set(
            result.models
              .filter((m: { downloaded?: boolean }) => m.downloaded)
              .map((m: { model: string }) => m.model)
          );
        }
      } else if (modelType === "parakeet") {
        const result = await window.electronAPI?.listParakeetModels();
        if (result?.success) {
          downloaded = new Set(
            result.models
              .filter((m: { downloaded?: boolean }) => m.downloaded)
              .map((m: { model: string }) => m.model)
          );
        }
      } else {
        const result = await window.electronAPI?.modelGetAll?.();
        if (result && Array.isArray(result)) {
          downloaded = new Set(
            result
              .filter((m: { isDownloaded?: boolean }) => m.isDownloaded)
              .map((m: { id: string }) => m.id)
          );
        }
      }
      setDownloadedModels(downloaded);
      return downloaded;
    } catch (error) {
      console.error("Failed to load downloaded models:", error);
      return new Set<string>();
    }
  }, [modelType]);

  useEffect(() => {
    const initAndValidate = async () => {
      const downloaded = await loadDownloadedModels();
      if (selectedModel && !downloaded.has(selectedModel)) {
        onModelSelect("");
      }
    };
    initAndValidate();
  }, [loadDownloadedModels, selectedModel, onModelSelect]);

  const handleDownloadComplete = useCallback(() => {
    loadDownloadedModels();
    onDownloadComplete?.();
  }, [loadDownloadedModels, onDownloadComplete]);

  const {
    downloadingModel,
    downloadProgress,
    downloadModel,
    deleteModel,
    isDownloadingModel,
    cancelDownload,
    isCancelling,
  } = useModelDownload({
    modelType,
    onDownloadComplete: handleDownloadComplete,
    onModelsCleared: loadDownloadedModels,
  });

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
        onConfirm: () => deleteModel(modelId, loadDownloadedModels),
        variant: "destructive",
      });
    },
    [showConfirmDialog, deleteModel, loadDownloadedModels, t]
  );

  const currentProvider = providers.find((p) => p.id === selectedProvider);
  const models = useMemo(() => currentProvider?.models || [], [currentProvider?.models]);

  const progressDisplay = useMemo(() => {
    if (!downloadingModel) return null;

    const modelName = models.find((m) => m.id === downloadingModel)?.name || downloadingModel;

    return <DownloadProgressBar modelName={modelName} progress={downloadProgress} />;
  }, [downloadingModel, downloadProgress, models]);

  return (
    <div className={className}>
      <ProviderTabs
        providers={providers}
        selectedId={selectedProvider}
        onSelect={onProviderSelect}
        colorScheme={colorScheme}
        scrollable
      />

      {progressDisplay}

      <div className="mt-2">
        <h5 className={`${styles.header} mb-2`}>{t("common.availableModels")}</h5>

        <ModelCardList
          models={models.map(
            (model): ModelCardOption => ({
              value: model.id,
              label: model.name,
              description: model.descriptionKey
                ? `${model.size} · ${t(model.descriptionKey, { defaultValue: model.description })}`
                : model.size,
              icon: getProviderIcon(selectedProvider),
              invertInDark: isMonochromeProvider(selectedProvider),
              recommended: model.recommended,
              isDownloaded:
                downloadedModels.has(model.id) || model.isDownloaded || model.downloaded,
              isDownloading: isDownloadingModel(model.id),
            })
          )}
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
