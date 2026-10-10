import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ProviderTabs } from "./ui/ProviderTabs";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import { ConfirmDialog } from "./ui/dialog";
import ModelCardList, { type ModelCardOption } from "./ui/ModelCardList";
import { useDialogs } from "../hooks/useDialogs";
import { useModelDownload, type ModelType } from "../hooks/useModelDownload";
import { MODEL_PICKER_COLORS, type ColorScheme } from "../utils/modelPickerStyles";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";
import type { InferenceScope } from "../config/inferenceScopes";
import { useSettingsStore, selectResolvedLLMConfig } from "../stores/settingsStore";
import { usePolicyStore } from "../stores/policyStore";
import {
  getManagedScopeResolution,
  useEnterpriseIdentityStore,
} from "../stores/enterpriseIdentityStore";
import { isAgentAllowed, isModeAllowedByPolicy } from "../stores/policyRules";

function captureSelectionLease(scope: InferenceScope) {
  const snapshot = () => {
    const state = useSettingsStore.getState();
    const config = selectResolvedLLMConfig(state, scope);
    return JSON.stringify([
      config.mode,
      config.provider,
      config.model,
      state.enterpriseSetupMode,
      scope === "dictationCleanup" ? state.useCleanupModel : true,
      scope === "dictationAgent" ? state.useDictationAgent : true,
      scope === "dictationAgentVision" ? state.useDictationAgentVisionModel : true,
    ]);
  };
  const allowed = () =>
    getManagedScopeResolution(scope, useSettingsStore.getState().enterpriseSetupMode).kind ===
      "manual" &&
    isModeAllowedByPolicy(usePolicyStore.getState(), "llm", "local") &&
    (!["dictationAgent", "dictationAgentVision", "chatIntelligence"].includes(scope) ||
      isAgentAllowed(usePolicyStore.getState()));
  const initial = snapshot();
  const initialState = useSettingsStore.getState();
  let current =
    selectResolvedLLMConfig(initialState, scope).mode === "local" &&
    allowed() &&
    (scope !== "dictationCleanup" || initialState.useCleanupModel) &&
    (scope !== "dictationAgent" || initialState.useDictationAgent) &&
    (scope !== "dictationAgentVision" || initialState.useDictationAgentVisionModel);
  const unsubscribeSettings = useSettingsStore.subscribe(() => {
    if (snapshot() !== initial) current = false;
  });
  const unsubscribePolicy = usePolicyStore.subscribe(() => {
    if (!allowed()) current = false;
  });
  const unsubscribeIdentity = useEnterpriseIdentityStore.subscribe(() => {
    if (!allowed()) current = false;
  });
  return {
    isCurrent: () => current && snapshot() === initial && allowed(),
    release: () => {
      unsubscribeSettings();
      unsubscribePolicy();
      unsubscribeIdentity();
    },
  };
}

export interface LocalModel {
  id: string;
  name: string;
  size: string;
  sizeBytes?: number;
  description: string;
  descriptionKey?: string;
  specUrl?: string;
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
  selectionScope?: InferenceScope;
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
  selectionScope,
}: LocalModelPickerProps) {
  const { t } = useTranslation();
  const [downloadedModels, setDownloadedModels] = useState<Set<string> | null>(null);
  const loadDownloadedModelsRequestRef = useRef(0);
  const onModelSelectRef = useRef(onModelSelect);
  const liveOwner = useRef(false);
  useEffect(() => {
    liveOwner.current = true;
    return () => {
      liveOwner.current = false;
    };
  }, []);

  useEffect(() => {
    onModelSelectRef.current = onModelSelect;
  }, [onModelSelect]);

  const knownModelIds = useMemo(
    () => new Set(providers.flatMap((provider) => provider.models.map((model) => model.id))),
    [providers]
  );

  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const styles = MODEL_PICKER_COLORS[colorScheme];

  const loadDownloadedModels = useCallback(async () => {
    const requestId = ++loadDownloadedModelsRequestRef.current;

    try {
      let downloaded: Set<string>;
      if (modelType === "whisper") {
        const result = await window.electronAPI?.listWhisperModels();
        if (!result?.success || !Array.isArray(result.models)) return null;
        downloaded = new Set(
          result.models
            .filter((m: { downloaded?: boolean }) => m.downloaded)
            .map((m: { model: string }) => m.model)
        );
      } else if (modelType === "parakeet") {
        const result = await window.electronAPI?.listParakeetModels();
        if (!result?.success || !Array.isArray(result.models)) return null;
        downloaded = new Set(
          result.models
            .filter((m: { downloaded?: boolean }) => m.downloaded)
            .map((m: { model: string }) => m.model)
        );
      } else {
        const result = await window.electronAPI?.modelGetAll?.();
        downloaded = new Set(
          result
            .filter((m: { isDownloaded?: boolean }) => m.isDownloaded)
            .map((m: { id: string }) => m.id)
        );
      }
      if (requestId === loadDownloadedModelsRequestRef.current) {
        setDownloadedModels(downloaded);
        return downloaded;
      }
      return null;
    } catch (error) {
      console.error("Failed to load downloaded models:", error);
      return null;
    }
  }, [modelType]);

  useEffect(() => {
    const initAndValidate = async () => {
      const downloaded = await loadDownloadedModels();
      // Only clear ids this picker owns — a foreign id (e.g. a cloud model)
      // must survive untouched.
      if (
        downloaded &&
        selectedModel &&
        knownModelIds.has(selectedModel) &&
        !downloaded.has(selectedModel)
      ) {
        onModelSelectRef.current("");
      }
    };
    initAndValidate();
    const requests = loadDownloadedModelsRequestRef;
    return () => {
      // A late reply cannot validate an old selection or an unmounted picker.
      requests.current++;
    };
  }, [loadDownloadedModels, selectedModel, knownModelIds]);

  const handleDownloadComplete = useCallback(async () => {
    await loadDownloadedModels();
    await onDownloadComplete?.();
  }, [loadDownloadedModels, onDownloadComplete]);

  const {
    downloads,
    downloadModel,
    deleteModel,
    isDownloadingModel,
    cancelDownload,
    isCancellingModel,
  } = useModelDownload({
    modelType,
    onDownloadComplete: handleDownloadComplete,
    onModelsCleared: loadDownloadedModels,
  });

  const allModels = useMemo(() => providers.flatMap((provider) => provider.models), [providers]);
  const selectionStateRef = useRef({
    selectedModel,
    downloadedModels,
    knownModelIds,
    selectionScope,
  });

  useEffect(() => {
    selectionStateRef.current = { selectedModel, downloadedModels, knownModelIds, selectionScope };
  }, [selectedModel, downloadedModels, knownModelIds, selectionScope]);

  const handleDownload = (modelId: string) => {
    const selectedWhenStarted = selectionStateRef.current.selectedModel;
    const lease = selectionScope ? captureSelectionLease(selectionScope) : null;

    void downloadModel(modelId, (downloadedId) => {
      if (lease ? !lease.isCurrent() : !liveOwner.current) return;
      if (selectionStateRef.current.selectionScope !== selectionScope) return;
      const {
        selectedModel: current,
        downloadedModels: downloaded,
        knownModelIds: known,
      } = selectionStateRef.current;
      if (current !== selectedWhenStarted) return;

      const selectionGone = downloaded && known.has(current) && !downloaded.has(current);
      if (!current || selectionGone) {
        onModelSelectRef.current(downloadedId);
      }
    }).finally(() => lease?.release());
  };

  const handleDelete = (modelId: string) => {
    showConfirmDialog({
      title: t("transcription.deleteModel.title"),
      description: t("transcription.deleteModel.description"),
      onConfirm: () => deleteModel(modelId, loadDownloadedModels),
      variant: "destructive",
    });
  };

  const currentProvider = providers.find((p) => p.id === selectedProvider);
  const models = currentProvider?.models || [];
  const activeModels = allModels.filter((model) => downloads[model.id]);

  return (
    <div className={className}>
      <ProviderTabs
        providers={providers}
        selectedId={selectedProvider}
        onSelect={onProviderSelect}
        colorScheme={colorScheme}
        wrap
      />

      {activeModels.length > 0 && (
        <div className="space-y-2">
          {activeModels.map((model) => {
            const status = downloads[model.id];
            return (
              <DownloadProgressBar
                key={model.id}
                modelName={model.name}
                progress={{
                  percentage: status.progress,
                  downloadedBytes: status.downloadedBytes,
                  totalBytes: status.totalBytes,
                }}
                isInstalling={status.phase === "installing"}
              />
            );
          })}
        </div>
      )}

      <div className="mt-2">
        <h5 className={`${styles.header} mb-2`}>{t("common.availableModels")}</h5>

        <ModelCardList
          models={models.map((model): ModelCardOption => ({
            value: model.id,
            label: model.name,
            description: model.size,
            specUrl: model.specUrl,
            icon: getProviderIcon(selectedProvider),
            invertInDark: isMonochromeProvider(selectedProvider),
            recommended: model.recommended,
            isDownloaded: downloadedModels?.has(model.id) || model.isDownloaded || model.downloaded,
            isDownloading: isDownloadingModel(model.id),
            isCancelling: isCancellingModel(model.id),
          }))}
          selectedModel={selectedModel}
          onModelSelect={onModelSelect}
          onDownload={handleDownload}
          onDelete={handleDelete}
          onCancelDownload={cancelDownload}
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
