import { useCallback, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import { useModelDownload } from "../hooks/useModelDownload";
import { useRequiredLocalModels } from "../hooks/useRequiredLocalModels";
import { getParakeetModels, getWhisperModels } from "../models/ModelRegistry";

/**
 * Non-dismissable amber banner for managed users missing org-required local
 * models after onboarding (the admin added a requirement later, or the user
 * deleted a required model). Mirrors the update-required banner; disk truth
 * makes it disappear as soon as every required model is installed and return
 * if one goes missing again. Deliberately a nag surface, not a hard block.
 */
export function RequiredModelsBanner() {
  const { t } = useTranslation();
  const { missing, loading, refresh } = useRequiredLocalModels();
  const whisperDownload = useModelDownload({ modelType: "whisper", onDownloadComplete: refresh });
  const parakeetDownload = useModelDownload({ modelType: "parakeet", onDownloadComplete: refresh });
  const [downloadingAll, setDownloadingAll] = useState(false);

  const parakeetCatalog = getParakeetModels();
  const whisperCatalog = getWhisperModels();
  const missingNames = useMemo(
    () =>
      missing
        .map((modelId) => (parakeetCatalog[modelId] ?? whisperCatalog[modelId])?.name ?? modelId)
        .join(", "),
    [missing, parakeetCatalog, whisperCatalog]
  );

  const downloadMissing = useCallback(async () => {
    setDownloadingAll(true);
    try {
      // Sequential on purpose: the per-family managers reject concurrent
      // downloads, and downloadModel resolves only once its download settles.
      // Failures surface through the hook's alert dialog and leave the model
      // missing, so the banner (and this button) stick around for a retry.
      for (const modelId of missing) {
        const download = modelId in parakeetCatalog ? parakeetDownload : whisperDownload;
        await download.downloadModel(modelId);
      }
    } finally {
      setDownloadingAll(false);
    }
  }, [missing, parakeetCatalog, parakeetDownload, whisperDownload]);

  if (loading || missing.length === 0) return null;

  const activeDownload = parakeetDownload.isDownloading ? parakeetDownload : whisperDownload;
  const activeModelName = activeDownload.downloadingModel
    ? ((
        parakeetCatalog[activeDownload.downloadingModel] ??
        whisperCatalog[activeDownload.downloadingModel]
      )?.name ?? activeDownload.downloadingModel)
    : null;

  return (
    <div className="max-w-3xl mx-auto w-full mb-3">
      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 p-3">
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-8 h-8 rounded-md bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center">
            <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-amber-900 dark:text-amber-200 mb-0.5">
              {t("controlPanel.requiredModelsByOrg.title")}
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-300/80 mb-2">
              {t("controlPanel.requiredModelsByOrg.description", { models: missingNames })}
            </p>
            {activeDownload.isDownloading && activeModelName ? (
              <DownloadProgressBar
                modelName={activeModelName}
                progress={activeDownload.downloadProgress}
                isInstalling={activeDownload.isInstalling}
              />
            ) : (
              <Button
                variant="default"
                size="sm"
                className="h-7 text-xs"
                disabled={downloadingAll}
                onClick={() => void downloadMissing()}
              >
                {t("controlPanel.requiredModelsByOrg.download")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
