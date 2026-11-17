import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDialogs } from "../../hooks/useDialogs";
import { useModelDownload, type ModelType } from "../../hooks/useModelDownload";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { getParakeetModels, getWhisperModels } from "../../models/ModelRegistry";
import {
  isModeAllowedByPolicy,
  localModelRefusal,
  localModelRowRefusal,
} from "../../stores/policyRules";
import type { PolicyScope } from "../../types/policy";
import { ConfirmDialog } from "../ui/dialog";
import ModelCardList from "../ui/ModelCardList";

interface InstalledModel {
  value: string;
  label: string;
}

async function readInstalledModels(modelType: ModelType): Promise<InstalledModel[]> {
  if (modelType === "llm") {
    const models = (await window.electronAPI?.modelGetAll?.()) ?? [];
    return models
      .filter((model) => model.isDownloaded)
      .map((model) => ({ value: model.id, label: model.name }));
  }
  const result =
    modelType === "whisper"
      ? await window.electronAPI?.listWhisperModels?.()
      : await window.electronAPI?.listParakeetModels?.();
  const catalog: Record<string, { name?: string }> =
    modelType === "whisper" ? getWhisperModels() : getParakeetModels();
  return (result?.models ?? [])
    .filter((model) => model.downloaded)
    .map((model) => ({ value: model.model, label: catalog[model.model]?.name ?? model.model }));
}

function InstalledModelsOfType({
  modelType,
  scope,
  onLoaded,
}: {
  modelType: ModelType;
  scope: PolicyScope;
  onLoaded: (modelType: ModelType, count: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const policy = usePolicySnapshot();
  const [models, setModels] = useState<InstalledModel[]>([]);
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();

  const refresh = useCallback(async () => {
    const installed = await readInstalledModels(modelType).catch(() => []);
    setModels(installed);
    onLoaded(modelType, installed.length);
  }, [modelType, onLoaded]);

  const { deleteModel } = useModelDownload({ modelType, onModelsCleared: refresh });

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const policyRefusal = localModelRowRefusal(policy, scope);
  return (
    <>
      {models.length > 0 && (
        <ModelCardList
          models={models.map((model) => ({
            ...model,
            isDownloaded: true,
            policyBlocked: true,
            policyRefusal,
          }))}
          selectedModel=""
          onModelSelect={() => {}}
          onDownload={() => {}}
          onDelete={(modelId) =>
            showConfirmDialog({
              title: t("transcription.deleteModel.title"),
              description: t("transcription.deleteModel.description"),
              onConfirm: () => deleteModel(modelId, refresh),
              variant: "destructive",
            })
          }
        />
      )}
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
    </>
  );
}

function InstalledModels({ scope }: { scope: PolicyScope }): React.JSX.Element {
  const { t } = useTranslation();
  const refusal = localModelRefusal(usePolicySnapshot(), scope);
  const [counts, setCounts] = useState<Partial<Record<ModelType, number>>>({});
  const onLoaded = useCallback((modelType: ModelType, count: number) => {
    setCounts((current) => ({ ...current, [modelType]: count }));
  }, []);
  const modelTypes: ModelType[] = scope === "llm" ? ["llm"] : ["whisper", "parakeet"];
  const hasInstalled = Object.values(counts).some((count) => count > 0);
  return (
    <div className={hasInstalled ? "mt-4 space-y-2" : undefined}>
      {hasInstalled && (
        <>
          <h3 className="text-sm font-medium text-foreground">
            {t("models.policy.installedTitle")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(
              refusal.code === "POLICY_LOCAL_MODE_BLOCKED"
                ? "models.policy.installedHint"
                : refusal.messageKey
            )}
          </p>
        </>
      )}
      {modelTypes.map((modelType) => (
        <InstalledModelsOfType
          key={modelType}
          modelType={modelType}
          scope={scope}
          onLoaded={onLoaded}
        />
      ))}
    </div>
  );
}

/**
 * With Local off the pickers aren't shown at all, and they are where a member
 * deletes one model. Files stay until the member removes them, so they stay listed.
 */
export function LocalOffInstalledModels({
  scope,
}: {
  scope: PolicyScope;
}): React.JSX.Element | null {
  const policy = usePolicySnapshot();
  if (policy.status !== "managed" || isModeAllowedByPolicy(policy, scope, "local")) return null;
  return <InstalledModels scope={scope} />;
}
